import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { downloadBulkData, streamBulkCardsFromFile } from './lib/scryfall-bulk.mjs'

// Refreshes shared oracle-level recommendation metadata from Scryfall's bulk
// export. This is an administrative sync, not a runtime card-API dependency.

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const BULK_DATA_TYPE = 'oracle_cards'
const USER_AGENT = 'DeckLoomOracleSync/1.0'
// oracle_cards carries three GIN indexes — the name trigram, the face-name
// trigram and the face_names array — so every changed row writes four index
// entries on top of its heap tuple. Batches of 500 exceed the role's statement
// timeout while the instance is busy. sync-card-prints.mjs hit the identical
// wall on card_prints' trigram GIN and settled on 100; same table shape, same
// number.
const UPSERT_BATCH = 100
// A batch that still times out gets split rather than abandoned, down to this.
const MIN_UPSERT_BATCH = 25
const WRITE_ATTEMPTS = 4
const RETRY_BASE_MS = 1000
const DOWNLOAD_DIR = path.join(process.cwd(), '.tmp')
const SYNCED_AT = new Date().toISOString()
const ORACLE_TEXT_CAP = 600
const FETCH_PAGE = 1000
const LOG_EVERY = 5000

// `--force` rewrites every row. Needed whenever oracleCardRow() itself changes
// shape (new column, different slimming), because the skip below only knows
// whether SCRYFALL changed the card, not whether we changed how we store it.
const FORCE = process.argv.includes('--force')

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function cardImage(card, size) {
  return card?.image_uris?.[size] || card?.card_faces?.[0]?.image_uris?.[size] || null
}

function oracleTextOf(card) {
  if (card?.oracle_text) return card.oracle_text.slice(0, ORACLE_TEXT_CAP)
  const faces = Array.isArray(card?.card_faces)
    ? card.card_faces.map(face => face.oracle_text).filter(Boolean)
    : []
  return faces.length ? faces.join('\n//\n').slice(0, ORACLE_TEXT_CAP) : ''
}

function slimCardFaces(faces) {
  if (!Array.isArray(faces) || !faces.length) return null
  return faces.map(face => ({
    name: face.name || null,
    mana_cost: face.mana_cost || null,
    type_line: face.type_line || null,
    oracle_text: face.oracle_text || null,
    power: face.power ?? null,
    toughness: face.toughness ?? null,
    image_uris: face.image_uris ? {
      small: face.image_uris.small || null,
      normal: face.image_uris.normal || null,
      large: face.image_uris.large || null,
      art_crop: face.image_uris.art_crop || null,
    } : null,
  }))
}

export function oracleCardRow(card) {
  if (!card?.oracle_id || !card?.name) return null
  return {
    oracle_id: card.oracle_id,
    name: card.name,
    legalities: card.legalities && typeof card.legalities === 'object' ? card.legalities : {},
    scryfall_id: card.id || null,
    set_code: card.set || null,
    collector_number: card.collector_number || null,
    type_line: card.type_line || null,
    mana_cost: card.mana_cost || card.card_faces?.[0]?.mana_cost || null,
    cmc: card.cmc ?? null,
    color_identity: card.color_identity || [],
    image_uri: cardImage(card, 'normal'),
    art_crop_uri: cardImage(card, 'art_crop'),
    oracle_text: oracleTextOf(card),
    rarity: card.rarity || null,
    set_name: card.set_name || null,
    artist: card.artist || null,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    produced_mana: card.produced_mana || [],
    keywords: card.keywords || [],
    colors: card.colors || [],
    card_faces: slimCardFaces(card.card_faces),
    face_names: [...new Set((card.card_faces || []).map(face => face?.name).filter(Boolean))],
    source_updated_at: card.updated_at || null,
    synced_at: SYNCED_AT,
  }
}

/**
 * True when this row needs writing. Scryfall stamps every card with its own
 * `updated_at`, so an unchanged card can be skipped entirely.
 *
 * Why this matters: Postgres implements UPDATE as insert-new-tuple +
 * mark-old-dead, so blind-upserting all 38k rows every week produced 38k dead
 * tuples a run. Autovacuum reclaimed them but never returns pages to the OS, so
 * the table sat at its high-water mark: measured 2026-08-01 at 103MB allocated
 * for 48MB of live rows — **52.9% empty**, on a 500MB database. A VACUUM FULL
 * recovered 60MB. This keeps it from filling back up.
 *
 * @param {{oracle_id: string, source_updated_at: string|null}} row
 * @param {Map<string, string|null>} existing  oracle_id -> stored source_updated_at
 * @param {boolean} force
 */
export function needsWrite(row, existing, force = false) {
  if (force) return true
  if (!existing.has(row.oracle_id)) return true
  const stored = existing.get(row.oracle_id)
  // A null on either side means we cannot prove it is unchanged — write it.
  if (!stored || !row.source_updated_at) return true
  return stored !== row.source_updated_at
}

// Keyset pagination, not .range() — an OFFSET walk over tens of thousands of
// rows degrades into a statement timeout on this instance.
async function fetchExistingTimestamps() {
  const map = new Map()
  let cursor = null
  for (;;) {
    let q = sb.from('oracle_cards')
      .select('oracle_id,source_updated_at')
      .order('oracle_id', { ascending: true })
      .limit(FETCH_PAGE)
    if (cursor) q = q.gt('oracle_id', cursor)
    const { data, error } = await q
    if (error) throw error
    if (!data?.length) break
    for (const r of data) map.set(r.oracle_id, r.source_updated_at)
    cursor = data[data.length - 1].oracle_id
    if (data.length < FETCH_PAGE) break
  }
  return map
}

/**
 * A cancelled statement says the instance was busy, not that the row was bad.
 * Retrying matters more here than it looks: the job runs weekly, so a single
 * cancelled batch used to abandon every remaining row for seven days.
 *
 * Postgres reports a statement timeout as SQLSTATE 57014. The transport errors
 * below are what fetch surfaces when the connection drops mid-write, and are
 * equally safe to repeat because the upsert is idempotent.
 */
export function isRetryableWriteError(error) {
  if (!error) return false
  if (error.code === '57014') return true
  const message = String(error?.message || '')
  return /canceling statement|statement timeout|deadlock detected|server closed the connection|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Writes one batch, halving it on a retryable failure before falling back to
 * plain backoff. Halving is the load-bearing half: a statement timeout means the
 * statement asked for too much work at once, so a smaller statement is an actual
 * fix, where repeating the same oversized one only waits for a quieter moment.
 * Below MIN_UPSERT_BATCH the batch size is no longer the problem, so it backs off
 * instead and eventually gives up.
 *
 * `upsert` is injected so this can be tested without a database.
 *
 * @param {object[]} rows
 * @param {(rows: object[]) => Promise<{error: any}>} upsert
 */
export async function upsertWithRetry(rows, upsert, opts = {}) {
  const {
    minBatch = MIN_UPSERT_BATCH,
    attempts = WRITE_ATTEMPTS,
    baseDelayMs = RETRY_BASE_MS,
    wait = sleep,
    onRetry,
  } = opts
  if (!rows.length) return

  for (let attempt = 1; ; attempt++) {
    const { error } = await upsert(rows)
    if (!error) return
    if (!isRetryableWriteError(error)) throw error

    if (rows.length > minBatch) {
      const half = Math.ceil(rows.length / 2)
      onRetry?.({ reason: 'split', size: rows.length, next: half, error })
      await upsertWithRetry(rows.slice(0, half), upsert, opts)
      await upsertWithRetry(rows.slice(half), upsert, opts)
      return
    }
    if (attempt >= attempts) throw error

    const delay = baseDelayMs * 2 ** (attempt - 1)
    onRetry?.({ reason: 'backoff', size: rows.length, attempt, delay, error })
    await wait(delay)
  }
}

async function flush(rows) {
  if (!rows.length) return
  await upsertWithRetry(
    rows,
    batch => sb.from('oracle_cards').upsert(batch, { onConflict: 'oracle_id', ignoreDuplicates: false }),
    {
      onRetry: ({ reason, size, next, attempt, delay, error }) => {
        const detail = reason === 'split'
          ? 'splitting into ' + next
          : 'retry ' + attempt + ' of ' + WRITE_ATTEMPTS + ' in ' + delay + 'ms'
        console.warn('[Oracle Sync] write of ' + size + ' rows failed (' + error?.message + ') — ' + detail + '.')
      },
    },
  )
}

async function processBulkFile(bulk) {
  let scanned = 0
  let upserted = 0
  let skipped = 0
  let pending = []
  let nextLogAt = LOG_EVERY
  const seen = new Set()

  // Batches vary in size once upsertWithRetry splits one, so progress is logged
  // on crossing a threshold rather than on an exact multiple.
  const noteProgress = () => {
    if (upserted < nextLogAt) return
    console.log(`[Oracle Sync] upserted ${upserted.toLocaleString()} oracle cards.`)
    nextLogAt = Math.ceil((upserted + 1) / LOG_EVERY) * LOG_EVERY
  }

  // Everything flushed so far is already committed, so a failure here is partial
  // progress, not a no-op. Say so — the bare message this used to die with gave
  // no way to tell a first-batch failure from a near-complete run.
  const flushPending = async batch => {
    try {
      await flush(batch)
    } catch (error) {
      error.message = `${error.message} (after ${upserted.toLocaleString()} rows upserted, ${scanned.toLocaleString()} scanned)`
      throw error
    }
  }

  const existing = FORCE ? new Map() : await fetchExistingTimestamps()
  if (!FORCE) {
    console.log(`[Oracle Sync] ${existing.size.toLocaleString()} rows already stored; skipping unchanged.`)
  }

  for await (const card of streamBulkCardsFromFile(bulk.path, bulk.format)) {
    scanned++
    const row = oracleCardRow(card)
    if (!row || seen.has(row.oracle_id)) continue
    seen.add(row.oracle_id)

    if (!needsWrite(row, existing, FORCE)) { skipped++; continue }
    pending.push(row)

    if (pending.length >= UPSERT_BATCH) {
      const batch = pending
      pending = []
      await flushPending(batch)
      upserted += batch.length
      noteProgress()
    }
  }

  if (pending.length) {
    await flushPending(pending)
    upserted += pending.length
  }
  return { scanned, upserted, skipped }
}

async function main() {
  let bulk = null
  try {
    console.log('[Oracle Sync] Fetching Scryfall bulk manifest…')
    console.log('[Oracle Sync] Downloading oracle_cards bulk file…')
    bulk = await downloadBulkData(BULK_DATA_TYPE, { dir: DOWNLOAD_DIR, userAgent: USER_AGENT })
    console.log('[Oracle Sync] Streaming rows into Supabase…')
    const { scanned, upserted, skipped } = await processBulkFile(bulk)
    console.log(`[Oracle Sync] Done. Scanned ${scanned.toLocaleString()}, upserted ${upserted.toLocaleString()}, skipped ${skipped.toLocaleString()} unchanged.`)
  } finally {
    try { if (bulk?.path) fs.rmSync(bulk.path, { force: true }) } catch {}
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error('[Oracle Sync] Failed:', err.message)
    process.exitCode = 1
  })
}
