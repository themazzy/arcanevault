import { sfGet } from './scryfall'
import { getMeta, setMeta } from './db'

const TOKEN_CARD_CACHE_KEY = 'deck_token_cards_v1'
const TOKEN_CARD_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const TOKEN_CARD_MISS_TTL_MS = 24 * 60 * 60 * 1000
const TOKEN_CARD_CACHE_MAX_ENTRIES = 120
const tokenCardCache = new Map()
const tokenCardRequests = new Map()
let tokenCardCacheLoaded = false
let tokenCardCacheLoadPromise = null
let tokenCardCacheWritePromise = Promise.resolve()

const EXTRA_QUERIES = {
  Monarch: 't:conspiracy !"Monarch" game:paper',
  'The Initiative': '!"The Initiative" game:paper',
  'The Ring': 't:emblem !"The Ring"',
  Dungeon: 't:dungeon game:paper',
  Emblem: 't:emblem game:paper',
}

export function extractTokenNames(oracle) {
  if (!oracle) return []
  const names = new Set()

  const namedRe = /\b(Treasure|Food|Clue|Blood|Powerstone|Junk|Map|Shard|Incubator|Gold)\s+tokens?/gi
  let match
  while ((match = namedRe.exec(oracle)) !== null) names.add(match[1])

  const creatureRe = /create\s+(?:a\s+|an\s+|one\s+|two\s+|three\s+|four\s+|five\s+|six\s+|x\s+|\d+\s+)*(?:tapped\s+|attacking\s+)?(?:[+-]?\d+\/[+-]?\d+\s+)?(?:(?:white|blue|black|red|green|colorless|silver|gold)\s+)*(?:legendary\s+|snow\s+)?([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*?)\s+(?:artifact\s+)?creature\s+tokens?/gi
  while ((match = creatureRe.exec(oracle)) !== null) {
    const raw = match[1]?.trim()
    if (!raw || /^(A|An|The|X|Your|Their|Each|All|Another|That|This|Copy|Token|Artifact)$/i.test(raw)) continue
    const words = raw.split(/\s+/)
    const name = words[words.length - 1]
    if (name && name.length > 1) names.add(name)
  }

  const roleRe = /\b(Blessed|Cursed|Wicked|Monster|Royal|Sorcerer|Young Hero)\s+Role\s+token/gi
  while ((match = roleRe.exec(oracle)) !== null) names.add(`${match[1]} Role`)

  return [...names]
}

export function extractTokenExtras(oracle) {
  if (!oracle) return []
  const extras = new Set()
  const text = oracle.toLowerCase()
  if (/\bmonarch\b/.test(text)) extras.add('Monarch')
  if (/\binitiative\b/.test(text)) extras.add('The Initiative')
  if (/the ring tempts you/.test(text)) extras.add('The Ring')
  if (/venture into the dungeon/.test(text)) extras.add('Dungeon')
  if (/you get an? emblem/.test(text)) extras.add('Emblem')
  return [...extras]
}

export function getDeckTokenItems(cards) {
  const oracle = (cards || []).map(card => card.oracle_text || '').join('\n')
  return [
    ...extractTokenNames(oracle).map(name => ({ name, kind: 'token' })),
    ...extractTokenExtras(oracle).map(name => ({ name, kind: 'extra' })),
  ]
}

function tokenCardKey(item) {
  const kind = item?.kind === 'extra' ? 'extra' : 'token'
  return `${kind}:${String(item?.name || '').trim().toLowerCase()}`
}

function tokenImageUri(card, imageSize) {
  if (!card) return null
  return card.image_uris?.[imageSize]
    ?? card.card_faces?.[0]?.image_uris?.[imageSize]
    ?? card.image_uris?.small
    ?? card.card_faces?.[0]?.image_uris?.small
    ?? null
}

function isFreshTokenCardEntry(entry, now = Date.now()) {
  const ttl = entry?.card ? TOKEN_CARD_CACHE_TTL_MS : TOKEN_CARD_MISS_TTL_MS
  return entry && Number.isFinite(entry.fetchedAt)
    && now - entry.fetchedAt < ttl
    && Object.hasOwn(entry, 'card')
}

async function loadTokenCardCache() {
  if (tokenCardCacheLoaded) return
  if (!tokenCardCacheLoadPromise) {
    tokenCardCacheLoadPromise = (async () => {
      try {
        const stored = await getMeta(TOKEN_CARD_CACHE_KEY)
        const now = Date.now()
        for (const [key, entry] of Object.entries(stored?.entries || {})) {
          if (isFreshTokenCardEntry(entry, now)) tokenCardCache.set(key, entry)
        }
      } catch {
        // IDB may be unavailable in private/restricted browsing. The in-memory
        // cache and request de-duplication still work for the current session.
      } finally {
        tokenCardCacheLoaded = true
      }
    })()
  }
  await tokenCardCacheLoadPromise
}

function persistTokenCardCache() {
  tokenCardCacheWritePromise = tokenCardCacheWritePromise
    .catch(() => {})
    .then(async () => {
      const now = Date.now()
      const entries = [...tokenCardCache.entries()]
        .filter(([, entry]) => isFreshTokenCardEntry(entry, now))
        .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
        .slice(0, TOKEN_CARD_CACHE_MAX_ENTRIES)
      await setMeta(TOKEN_CARD_CACHE_KEY, { entries: Object.fromEntries(entries) })
    })
    .catch(() => {})
}

export async function fetchDeckTokenCard(item, imageSize = 'normal') {
  const name = String(item?.name || '').trim()
  const normalizedItem = { ...item, name, kind: item?.kind === 'extra' ? 'extra' : 'token' }
  if (!name) return { ...normalizedItem, imageUri: null, card: null }

  await loadTokenCardCache()
  const key = tokenCardKey(normalizedItem)
  const cached = tokenCardCache.get(key)
  if (isFreshTokenCardEntry(cached)) {
    return { ...normalizedItem, imageUri: tokenImageUri(cached.card, imageSize), card: cached.card }
  }

  let request = tokenCardRequests.get(key)
  if (!request) {
    request = (async () => {
      const rawQuery = EXTRA_QUERIES[name] ?? `t:token !"${name}" game:paper`
      const query = encodeURIComponent(rawQuery)
      const data = await sfGet(`/cards/search?q=${query}&order=released&dir=desc&unique=cards`)
      const entry = { fetchedAt: Date.now(), card: data?.data?.[0] || null }
      // A null response means the request itself failed. Do not turn a
      // temporary outage into a persistent miss; a successful empty search is
      // cached briefly so genuinely unavailable game pieces do not refetch on
      // every visit.
      if (data) {
        tokenCardCache.set(key, entry)
        persistTokenCardCache()
      }
      return entry
    })()
    tokenCardRequests.set(key, request)
  }

  let entry
  try {
    entry = await request
  } finally {
    if (tokenCardRequests.get(key) === request) tokenCardRequests.delete(key)
  }

  return { ...normalizedItem, imageUri: tokenImageUri(entry.card, imageSize), card: entry.card }
}

export async function fetchDeckTokenCards(items, imageSize = 'normal', options = {}) {
  const source = Array.isArray(items) ? items : []
  if (!source.length) return []

  const concurrency = Math.max(1, Math.min(4, Number(options.concurrency) || 2))
  const results = new Array(source.length)
  let cursor = 0

  const worker = async () => {
    while (cursor < source.length) {
      const index = cursor
      cursor += 1
      const item = source[index]
      let result
      try {
        result = await fetchDeckTokenCard(item, imageSize)
      } catch {
        result = { ...item, imageUri: null, card: null }
      }
      results[index] = result
      options.onResult?.(result, index)
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, source.length) },
    () => worker(),
  ))
  return results
}
