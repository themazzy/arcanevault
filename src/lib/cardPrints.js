import { sb } from './supabase'

const CARD_PRINT_UPSERT_BATCH = 200
const CARD_PRINT_QUERY_BATCH = 200

function chunkRows(rows, size) {
  const chunks = []
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size))
  return chunks
}

function getCardImage(card, size = 'normal') {
  if (!card) return null
  if (card.image_uris?.[size]) return card.image_uris[size]
  if (card.card_faces?.[0]?.image_uris?.[size]) return card.card_faces[0].image_uris[size]
  return null
}

function slimCardFaces(faces) {
  if (!Array.isArray(faces) || !faces.length) return null
  return faces.map(f => ({
    name: f.name || null,
    mana_cost: f.mana_cost || null,
    type_line: f.type_line || null,
    oracle_text: f.oracle_text || null,
    power: f.power ?? null,
    toughness: f.toughness ?? null,
    image_uris: f.image_uris ? {
      small:  f.image_uris.small  || null,
      normal: f.image_uris.normal || null,
      large:  f.image_uris.large  || null,
    } : null,
  }))
}

// Columns we persist beyond the original card_prints schema. Used to detect
// which existing rows still have NULL/empty fields that we can backfill.
export const CARD_PRINT_EXTENDED_COLUMNS = [
  'rarity', 'set_name', 'legalities', 'artist', 'oracle_text',
  'power', 'toughness', 'produced_mana', 'keywords', 'colors',
  'image_uri_small', 'image_uri_large', 'card_faces',
]

const CARD_PRINT_SELECT_COLUMNS = [
  'id', 'scryfall_id', 'set_code', 'collector_number', 'name',
  'type_line', 'mana_cost', 'cmc', 'color_identity',
  'image_uri', 'art_crop_uri',
  ...CARD_PRINT_EXTENDED_COLUMNS,
].join(',')

export function buildCardPrintPayload(card) {
  if (!card) return null
  const scryfallId = card.id || card.scryfall_id || null
  const setCode = card.set || card.set_code || card.setCode || null
  const collectorNumber = card.collector_number || card.collNum || null
  return {
    scryfall_id: scryfallId,
    oracle_id: card.oracle_id || null,
    name: card.name,
    set_code: setCode,
    collector_number: collectorNumber,
    type_line: card.type_line || null,
    mana_cost: card.mana_cost || card.card_faces?.[0]?.mana_cost || null,
    cmc: card.cmc ?? null,
    color_identity: card.color_identity || [],
    image_uri: card.image_uri || getCardImage(card, 'normal'),
    art_crop_uri: card.art_crop_uri || getCardImage(card, 'art_crop'),
    // Extended filter/sort/detail fields (added 2026-05-15 migration).
    rarity:          card.rarity || null,
    set_name:        card.set_name || null,
    legalities:      card.legalities || {},
    artist:          card.artist || null,
    oracle_text:     card.oracle_text || card.card_faces?.[0]?.oracle_text || null,
    power:           card.power ?? null,
    toughness:       card.toughness ?? null,
    produced_mana:   card.produced_mana || [],
    keywords:        card.keywords || [],
    colors:          card.colors || [],
    image_uri_small: card.image_uri_small || getCardImage(card, 'small'),
    image_uri_large: card.image_uri_large || getCardImage(card, 'large'),
    card_faces:      slimCardFaces(card.card_faces),
  }
}

// Returns true if the existing row is missing any of the extended fields that
// the supplied payload can fill in. Used by ensureCardPrints to decide whether
// to PATCH an existing row.
function isExistingRowMissingFields(existing, payload) {
  if (!existing) return false
  for (const col of CARD_PRINT_EXTENDED_COLUMNS) {
    const cur = existing[col]
    const next = payload?.[col]
    if (next == null) continue
    if (Array.isArray(next) && next.length === 0) continue
    if (cur == null) return true
    if (Array.isArray(cur) && cur.length === 0 && Array.isArray(next) && next.length > 0) return true
    if (col === 'legalities' && cur && typeof cur === 'object' && Object.keys(cur).length === 0
        && next && typeof next === 'object' && Object.keys(next).length > 0) return true
  }
  return false
}

// Build a minimal patch object containing only the extended columns that are
// missing on the existing row. Keeps wire traffic small and avoids stomping on
// fields another user may have already populated.
function buildBackfillPatch(existing, payload) {
  const patch = {}
  for (const col of CARD_PRINT_EXTENDED_COLUMNS) {
    const cur = existing?.[col]
    const next = payload?.[col]
    if (next == null) continue
    if (Array.isArray(next) && next.length === 0) continue
    const curEmpty = cur == null
      || (Array.isArray(cur) && cur.length === 0)
      || (col === 'legalities' && cur && typeof cur === 'object' && Object.keys(cur).length === 0)
    if (curEmpty) patch[col] = next
  }
  return patch
}

function printLookupKey(card) {
  const setCode = card?.set || card?.set_code || card?.setCode || null
  const collectorNumber = card?.collector_number || card?.collNum || null
  if (setCode && collectorNumber) return `set:${setCode}|${collectorNumber}`
  return card?.name ? `name:${card.name}` : null
}

export async function ensureCardPrints(cards, onProgress) {
  const payloadByScryfallId = new Map()
  const fallbackPayloadByPrint = new Map()
  for (const card of cards || []) {
    const payload = buildCardPrintPayload(card)
    if (!payload) continue
    if (payload.scryfall_id) {
      payloadByScryfallId.set(payload.scryfall_id, payload)
    } else {
      const key = printLookupKey(payload)
      if (key) fallbackPayloadByPrint.set(key, payload)
    }
  }

  const result = new Map()
  const payloads = [...payloadByScryfallId.values()]
  if (payloads.length) {
    const scryfallIds = payloads.map(p => p.scryfall_id)
    const queryBatches = chunkRows(scryfallIds, CARD_PRINT_QUERY_BATCH)
    // Fetch existing rows first — include extended columns so we can detect
    // which rows still need a backfill patch.
    const existing = []
    for (let i = 0; i < queryBatches.length; i++) {
      const batch = queryBatches[i]
      const { data, error } = await sb
        .from('card_prints')
        .select(CARD_PRINT_SELECT_COLUMNS)
        .in('scryfall_id', batch)
      if (error) throw error
      if (data?.length) existing.push(...data)
      onProgress?.({ phase: 'lookup', batchIndex: i + 1, batchCount: queryBatches.length })
    }
    const existingById = new Map(existing.map(r => [r.scryfall_id, r]))
    const toInsert = payloads.filter(p => !existingById.has(p.scryfall_id))

    // Patch existing rows that are missing extended fields. Best-effort: any
    // error is logged and swallowed because identity columns are protected
    // server-side and the row remains readable either way.
    const toPatch = payloads
      .filter(p => existingById.has(p.scryfall_id) && isExistingRowMissingFields(existingById.get(p.scryfall_id), p))
      .map(p => ({ scryfall_id: p.scryfall_id, patch: buildBackfillPatch(existingById.get(p.scryfall_id), p) }))
      .filter(entry => Object.keys(entry.patch).length > 0)
    if (toPatch.length) {
      await Promise.all(toPatch.map(async ({ scryfall_id, patch }) => {
        const { error } = await sb.from('card_prints').update(patch).eq('scryfall_id', scryfall_id)
        if (error) {
          console.warn('[card_prints] backfill patch failed', scryfall_id, error.code, error.message, error.details, error.hint, 'patch keys:', Object.keys(patch))
        }
      }))
    }

    const inserted = []
    const insertBatches = chunkRows(toInsert, CARD_PRINT_UPSERT_BATCH)
    for (let i = 0; i < insertBatches.length; i++) {
      const batch = insertBatches[i]
      const { data, error } = await sb
        .from('card_prints')
        .insert(batch)
        .select(CARD_PRINT_SELECT_COLUMNS)
      if (error) {
        const { data: recovered, error: recoverError } = await sb
          .from('card_prints')
          .select(CARD_PRINT_SELECT_COLUMNS)
          .in('scryfall_id', batch.map(row => row.scryfall_id))
        if (recoverError || (recovered || []).length !== batch.length) throw error
        inserted.push(...(recovered || []))
        onProgress?.({ phase: 'insert', batchIndex: i + 1, batchCount: insertBatches.length })
        continue
      }
      if (data?.length) inserted.push(...data)
      onProgress?.({ phase: 'insert', batchIndex: i + 1, batchCount: insertBatches.length })
    }

    for (const row of [...existing, ...inserted]) {
      if (row.scryfall_id) result.set(row.scryfall_id, row)
      const key = printLookupKey(row)
      if (key) result.set(key, row)
    }
  }

  const fallbackPayloads = [...fallbackPayloadByPrint.values()]
  if (fallbackPayloads.length) {
    const setCodes = [...new Set(fallbackPayloads.map(row => row.set_code).filter(Boolean))]
    const names = [...new Set(fallbackPayloads.map(row => row.name).filter(Boolean))]
    let existing = []
    if (setCodes.length) {
      for (const batch of chunkRows(setCodes, CARD_PRINT_QUERY_BATCH)) {
        const { data, error } = await sb
          .from('card_prints')
          .select(CARD_PRINT_SELECT_COLUMNS)
          .in('set_code', batch)
        if (error) throw error
        if (data?.length) existing.push(...data)
      }
    }
    if (names.length) {
      for (const batch of chunkRows(names, CARD_PRINT_QUERY_BATCH)) {
        const { data, error } = await sb
          .from('card_prints')
          .select(CARD_PRINT_SELECT_COLUMNS)
          .in('name', batch)
        if (error) throw error
        if (data?.length) existing.push(...data)
      }
    }

    const existingByPrint = new Map(existing.map(row => [printLookupKey(row), row]).filter(([key]) => key))
    const missing = fallbackPayloads.filter(row => !existingByPrint.has(printLookupKey(row)))
    if (missing.length) {
      for (const batch of chunkRows(missing, CARD_PRINT_UPSERT_BATCH)) {
        const { data, error } = await sb
          .from('card_prints')
          .insert(batch)
          .select(CARD_PRINT_SELECT_COLUMNS)
        if (error) throw error
        for (const row of data || []) {
          const key = printLookupKey(row)
          if (key) existingByPrint.set(key, row)
        }
      }
    }

    for (const row of existingByPrint.values()) {
      const key = printLookupKey(row)
      if (key) result.set(key, row)
    }
  }

  return result
}

// Converts a card_prints row into the in-memory sfMap entry shape that the
// filter worker and CardDetail expect. Mirrors buildEntryFromScryfall in
// scryfall.js so downstream code does not need to special-case the source.
export function cardPrintRowToSfEntry(row) {
  if (!row) return null
  const setCode = row.set_code || ''
  const collectorNumber = row.collector_number || ''
  const key = `${setCode}-${collectorNumber}`
  const small  = row.image_uri_small || null
  const normal = row.image_uri       || null
  const large  = row.image_uri_large || null
  const artCrop = row.art_crop_uri   || null
  const hasImage = !!(small || normal || large || artCrop)
  return {
    key,
    set_code:         setCode,
    collector_number: collectorNumber,
    name:             row.name,
    set_name:         row.set_name || null,
    type_line:        row.type_line || null,
    rarity:           row.rarity || null,
    prices:           null,
    prices_prev:      null,
    color_identity:   row.color_identity || [],
    colors:           row.colors || [],
    cmc:              row.cmc ?? null,
    legalities:       row.legalities || {},
    artist:           row.artist || null,
    oracle_text:      row.oracle_text || null,
    power:            row.power ?? null,
    toughness:        row.toughness ?? null,
    produced_mana:    row.produced_mana || [],
    keywords:         row.keywords || [],
    image_uris: hasImage ? { small, normal, large, art_crop: artCrop } : null,
    mana_cost:  row.mana_cost || null,
    card_faces: Array.isArray(row.card_faces) ? row.card_faces : null,
    source: 'card_prints',
  }
}

// Fetch card_prints rows for the supplied scryfall_ids and return them keyed
// by scryfall_id. Batched to stay under PostgREST's row caps.
export async function fetchCardPrintsByScryfallIds(scryfallIds) {
  if (!scryfallIds?.length) return new Map()
  const unique = [...new Set(scryfallIds.filter(Boolean))]
  const out = new Map()
  for (const batch of chunkRows(unique, CARD_PRINT_QUERY_BATCH)) {
    const { data, error } = await sb
      .from('card_prints')
      .select(CARD_PRINT_SELECT_COLUMNS)
      .in('scryfall_id', batch)
    if (error) throw error
    for (const row of data || []) {
      if (row.scryfall_id) out.set(row.scryfall_id, row)
    }
  }
  return out
}

// Same, but keyed by `set_code|collector_number` for cards that have no
// scryfall_id locally (legacy data).
export async function fetchCardPrintsBySetCollector(pairs) {
  if (!pairs?.length) return new Map()
  const out = new Map()
  const setCodes = [...new Set(pairs.map(p => p.set_code).filter(Boolean))]
  for (const batch of chunkRows(setCodes, CARD_PRINT_QUERY_BATCH)) {
    const { data, error } = await sb
      .from('card_prints')
      .select(CARD_PRINT_SELECT_COLUMNS)
      .in('set_code', batch)
    if (error) throw error
    for (const row of data || []) {
      const key = `${row.set_code}|${row.collector_number}`
      out.set(key, row)
    }
  }
  return out
}

export function getCardPrint(printMap, card) {
  if (!printMap || !card) return null
  const scryfallId = card.id || card.scryfall_id || null
  return (scryfallId && printMap.get(scryfallId)) || printMap.get(printLookupKey(card)) || null
}

export function withCardPrint(row, print) {
  if (!print) return row
  return {
    ...row,
    card_print_id: print.id,
    name: print.name || row.name,
    set_code: print.set_code || row.set_code,
    collector_number: print.collector_number || row.collector_number,
  }
}
