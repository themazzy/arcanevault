import { convertCurrency } from './fx'

const POKEMON_TCG_API_BASE = 'https://api.pokemontcg.io/v2'
const POKEMON_TCG_API_KEY = import.meta.env.VITE_POKEMON_TCG_API_KEY || ''
let _setsCache = null

// Some sites expose a public-facing set code that differs from the API set id.
// POR -> me3 is required for inputs like "POR 007".
const EXTERNAL_SET_CODE_ALIASES = {
  por: ['me3'],
}

const VARIANT_LABELS = {
  normal: 'Normal',
  holofoil: 'Holofoil',
  reverseHolofoil: 'Reverse Holofoil',
  '1stEditionNormal': '1st Edition Normal',
  '1stEditionHolofoil': '1st Edition Holofoil',
  unlimitedNormal: 'Unlimited Normal',
  unlimitedHolofoil: 'Unlimited Holofoil',
}

const CARDMARKET_LABELS = {
  averageSellPrice: 'Average Sell',
  lowPrice: 'Low Price',
  trendPrice: 'Trend Price',
  germanProLow: 'German Pro Low',
  suggestedPrice: 'Suggested Price',
  reverseHoloSell: 'Reverse Holo Sell',
  reverseHoloLow: 'Reverse Holo Low',
  reverseHoloTrend: 'Reverse Holo Trend',
  lowPriceExPlus: 'Low Price EX+',
  avg1: 'Average 1 Day',
  avg7: 'Average 7 Days',
  avg30: 'Average 30 Days',
  reverseHoloAvg1: 'Reverse Holo Avg 1 Day',
  reverseHoloAvg7: 'Reverse Holo Avg 7 Days',
  reverseHoloAvg30: 'Reverse Holo Avg 30 Days',
}

const TCGPLAYER_VALUE_PRIORITY = ['market', 'mid', 'low', 'directLow', 'high']
const CARDMARKET_VALUE_PRIORITY = [
  'trendPrice',
  'avg30',
  'averageSellPrice',
  'avg7',
  'avg1',
  'lowPrice',
  'suggestedPrice',
  'reverseHoloTrend',
  'reverseHoloSell',
  'reverseHoloAvg30',
  'reverseHoloAvg7',
  'reverseHoloAvg1',
  'reverseHoloLow',
  'lowPriceExPlus',
  'germanProLow',
]

function escapeQueryValue(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
}

async function pokemonFetch(path, { params, signal } = {}) {
  const url = new URL(`${POKEMON_TCG_API_BASE}${path}`)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value != null && value !== '') url.searchParams.set(key, value)
    })
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    signal,
    headers: {
      'X-Api-Key': POKEMON_TCG_API_KEY,
    },
  })

  if (!res.ok) {
    let message = `Pokemon TCG API request failed (${res.status})`
    try {
      const data = await res.json()
      if (data?.error?.message) message = data.error.message
    } catch {}
    throw new Error(message)
  }

  return res.json()
}

function normalizeToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSafeCardIdQuery(value) {
  return /^[a-z0-9]+-[a-z0-9]+$/i.test(String(value || '').trim())
}

function getAliasSetIds(token) {
  const normalized = normalizeToken(token)
  return EXTERNAL_SET_CODE_ALIASES[normalized] || []
}

async function getPokemonSets({ signal } = {}) {
  if (_setsCache) return _setsCache
  const data = await pokemonFetch('/sets', {
    signal,
    params: {
      pageSize: '250',
      orderBy: 'releaseDate',
    },
  })
  _setsCache = data?.data || []
  return _setsCache
}

function scoreSetMatch(set, token) {
  const query = normalizeToken(token)
  if (!query) return -1

  const candidates = [
    { value: set?.ptcgoCode, score: 120 },
    { value: set?.id, score: 105 },
    { value: set?.name, score: 80 },
    { value: set?.series, score: 55 },
  ]

  let best = -1
  candidates.forEach(({ value, score }) => {
    const normalized = normalizeToken(value)
    if (!normalized) return
    if (normalized === query) {
      best = Math.max(best, score)
      return
    }
    if (normalized.startsWith(query)) {
      best = Math.max(best, score - 8)
      return
    }
    if (normalized.includes(query)) {
      best = Math.max(best, score - 18)
      return
    }
  })

  return best
}

async function findMatchingSets(token, { signal } = {}) {
  const sets = await getPokemonSets({ signal })
  const aliasSetIds = getAliasSetIds(token)
  const scored = sets
    .map(set => {
      if (aliasSetIds.includes(set.id)) return { set, score: 140 }
      return { set, score: scoreSetMatch(set, token) }
    })
    .filter(entry => entry.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return new Date(b.set?.releaseDate || 0) - new Date(a.set?.releaseDate || 0)
    })

  if (!scored.length) return []

  const topScore = scored[0].score
  return scored
    .filter(entry => entry.score >= Math.max(40, topScore - 18))
    .slice(0, 6)
    .map(entry => entry.set)
}

function setTokenMatchesCardSet(set, token, matchedSets = []) {
  if (!token) return true
  if (matchedSets.length) return matchedSets.some(entry => entry.id === set?.id)

  const query = normalizeToken(token)
  if (!query) return true

  const candidates = [
    normalizeToken(set?.ptcgoCode),
    normalizeToken(set?.id),
    normalizeToken(set?.name),
    normalizeToken(set?.series),
  ].filter(Boolean)

  return candidates.some(value => value === query || value.startsWith(query) || value.includes(query))
}

function sortSearchResults(cards, term) {
  const query = term.trim().toLowerCase()
  const score = (card) => {
    const name = String(card?.name || '').toLowerCase()
    if (name === query) return 3
    if (name.startsWith(query)) return 2
    if (name.includes(query)) return 1
    return 0
  }

  return [...cards].sort((a, b) => {
    const scoreDelta = score(b) - score(a)
    if (scoreDelta !== 0) return scoreDelta

    const releaseDelta = new Date(b?.set?.releaseDate || 0) - new Date(a?.set?.releaseDate || 0)
    if (releaseDelta !== 0) return releaseDelta

    const numberA = parseInt(a?.number || '0', 10)
    const numberB = parseInt(b?.number || '0', 10)
    if (!Number.isNaN(numberA) && !Number.isNaN(numberB) && numberA !== numberB) return numberA - numberB

    return String(a?.set?.name || '').localeCompare(String(b?.set?.name || ''))
  })
}

function normalizePriceAmount(value) {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function pickFirstPriceField(entry, keys) {
  if (!entry) return null
  for (const key of keys) {
    const amount = normalizePriceAmount(entry[key])
    if (amount != null) return { key, amount }
  }
  return null
}

function pickTcgplayerValue(entry) {
  return pickFirstPriceField(entry, TCGPLAYER_VALUE_PRIORITY)?.amount ?? null
}

function getCardmarketUsdValue(card) {
  const prices = card?.cardmarket?.prices
  if (!prices) return null
  const eurValue = pickFirstPriceField(prices, CARDMARKET_VALUE_PRIORITY)?.amount ?? null

  if (eurValue == null) return null
  return convertCurrency(eurValue, 'EUR', 'USD')
}

function fallbackVariantLabel(key) {
  return key
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, ch => ch.toUpperCase())
}

function normalizeNumericString(value) {
  const raw = String(value || '').trim()
  if (!raw) return []
  if (/^\d+$/.test(raw)) {
    const normalized = String(parseInt(raw, 10))
    return [...new Set([raw, normalized].filter(Boolean))]
  }
  const match = raw.match(/^([A-Za-z]*)(\d+)([A-Za-z]*)$/)
  if (!match) return [raw]
  const [, prefix, digits, suffix] = match
  const normalized = `${prefix}${String(parseInt(digits, 10))}${suffix}`
  return [...new Set([raw, normalized].filter(Boolean))]
}

function tokenizeStructuredSearch(term) {
  const trimmed = String(term || '').trim()
  if (!trimmed) return null

  const slashMatch = trimmed.match(/^([A-Za-z0-9]+)\s+([A-Za-z0-9]+)\s*\/\s*([A-Za-z0-9]+)$/)
  if (slashMatch) {
    return {
      setToken: slashMatch[1],
      numberToken: slashMatch[2],
      totalToken: slashMatch[3],
    }
  }

  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length === 2 && /^[A-Za-z0-9]+$/.test(parts[0]) && /^[A-Za-z0-9]+$/.test(parts[1])) {
    return {
      setToken: parts[0],
      numberToken: parts[1],
      totalToken: null,
    }
  }

  const idMatch = trimmed.match(/^([A-Za-z0-9]+)[-: ]([A-Za-z0-9]+)$/)
  if (idMatch) {
    return {
      setToken: idMatch[1],
      numberToken: idMatch[2],
      totalToken: null,
    }
  }

  return null
}

function buildNameQueries(term) {
  const trimmed = String(term || '').trim()
  if (!trimmed) return []

  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  if (tokens.length === 1) return [`name:*${escapeQueryValue(tokens[0])}*`]

  return [
    `name:"${escapeQueryValue(trimmed)}"`,
    tokens.map(token => `name:${escapeQueryValue(token)}`).join(' '),
  ]
}

async function buildStructuredLookupPlan(term, { signal } = {}) {
  const parsed = tokenizeStructuredSearch(term)
  if (!parsed) return { queries: [], directIds: [], matchedSets: [] }

  const setRaw = String(parsed.setToken || '').trim()
  const numberCandidates = normalizeNumericString(parsed.numberToken)
  const matchedSets = await findMatchingSets(setRaw, { signal })
  const fallbackSetIds = [...new Set([
    ...getAliasSetIds(setRaw),
    /^[a-z]+\d+$/i.test(setRaw) ? setRaw.toLowerCase() : null,
  ].filter(Boolean))]

  const queries = new Set()
  const directIds = new Set()

  if (matchedSets.length) {
    matchedSets.forEach(set => {
      numberCandidates.forEach(number => {
        queries.add(`set.id:${set.id} number:"${number}"`)
        if (set.ptcgoCode) queries.add(`set.ptcgoCode:${set.ptcgoCode} number:"${number}"`)
        directIds.add(`${set.id}-${number.toLowerCase()}`)
      })
    })
  } else {
    numberCandidates.forEach(number => {
      queries.add(`set.ptcgoCode:${setRaw.toUpperCase()} number:"${number}"`)
      fallbackSetIds.forEach(setId => {
        queries.add(`set.id:${setId} number:"${number}"`)
        directIds.add(`${setId}-${number.toLowerCase()}`)
      })
    })
  }

  if (parsed.totalToken) {
    const totals = normalizeNumericString(parsed.totalToken)
    totals.forEach(total => {
      numberCandidates.forEach(number => {
        if (matchedSets.length) {
          matchedSets.forEach(set => {
            queries.add(`set.id:${set.id} number:"${number}" set.printedTotal:${total}`)
            if (set.ptcgoCode) queries.add(`set.ptcgoCode:${set.ptcgoCode} number:"${number}" set.printedTotal:${total}`)
          })
        } else {
          queries.add(`set.ptcgoCode:${setRaw.toUpperCase()} number:"${number}" set.printedTotal:${total}`)
          fallbackSetIds.forEach(setId => {
            queries.add(`set.id:${setId} number:"${number}" set.printedTotal:${total}`)
          })
        }
      })
    })
  }

  return { queries: [...queries], directIds: [...directIds], matchedSets }
}

export async function searchPokemonCards(term, { signal, pageSize = 40 } = {}) {
  const query = escapeQueryValue(term)
  if (!query) return []

  const parsed = tokenizeStructuredSearch(query)
  const structured = await buildStructuredLookupPlan(query, { signal })
  const directIds = [
    ...(isSafeCardIdQuery(query) ? [query.toLowerCase()] : []),
    ...structured.directIds,
  ]
  const queries = parsed
    ? [...structured.queries]
    : [...structured.queries, ...buildNameQueries(query)]

  const seen = new Map()

  for (const cardId of directIds) {
    try {
      const card = await getPokemonCard(cardId, { signal })
      if (card && !seen.has(card.id)) seen.set(card.id, card)
    } catch {
      continue
    }

    if (seen.size >= pageSize) break
  }

  for (const q of queries) {
    try {
      const data = await pokemonFetch('/cards', {
        signal,
        params: {
          q,
      pageSize: String(pageSize),
          orderBy: 'set.releaseDate,-number',
        },
      })

      for (const card of data?.data || []) {
        if (!seen.has(card.id)) seen.set(card.id, card)
      }
    } catch {
      continue
    }

    if (seen.size >= pageSize) break
  }

  if (!seen.size && parsed?.numberToken) {
    for (const number of normalizeNumericString(parsed.numberToken)) {
      try {
        const data = await pokemonFetch('/cards', {
          signal,
          params: {
            q: `number:"${number}"`,
            pageSize: '250',
            orderBy: 'set.releaseDate,-number',
          },
        })

        const filtered = (data?.data || []).filter(card =>
          setTokenMatchesCardSet(card?.set, parsed.setToken, structured.matchedSets)
        )

        filtered.forEach(card => {
          if (!seen.has(card.id)) seen.set(card.id, card)
        })
      } catch {
        continue
      }

      if (seen.size >= pageSize) break
    }
  }

  return sortSearchResults([...seen.values()], query)
}

export async function getPokemonCard(cardId, { signal } = {}) {
  if (!cardId) return null
  const data = await pokemonFetch(`/cards/${cardId}`, { signal })
  return data?.data || null
}

export function getPokemonCardImage(card, size = 'small') {
  if (!card) return null
  if (size === 'large') return card.images?.large || card.images?.small || null
  return card.images?.small || card.images?.large || null
}

export function getPokemonPriceOptions(card) {
  const tcgplayerPrices = card?.tcgplayer?.prices || {}
  const tcgplayerKeys = Object.keys(tcgplayerPrices)
    .filter(key => pickTcgplayerValue(tcgplayerPrices[key]) != null)
    .sort((a, b) => {
      const order = ['normal', 'holofoil', 'reverseHolofoil', '1stEditionNormal', '1stEditionHolofoil', 'unlimitedNormal', 'unlimitedHolofoil']
      const indexA = order.indexOf(a)
      const indexB = order.indexOf(b)
      if (indexA === -1 && indexB === -1) return a.localeCompare(b)
      if (indexA === -1) return 1
      if (indexB === -1) return -1
      return indexA - indexB
    })

  const options = tcgplayerKeys
    .map(key => {
      const amount = pickTcgplayerValue(tcgplayerPrices[key])
      return amount == null ? null : {
        key,
        label: VARIANT_LABELS[key] || fallbackVariantLabel(key),
        amount,
        currency: 'USD',
        source: 'TCGplayer',
      }
    })
    .filter(Boolean)

  if (options.length) return options

  const cardmarketField = pickFirstPriceField(card?.cardmarket?.prices, CARDMARKET_VALUE_PRIORITY)
  const cardmarketUsd = getCardmarketUsdValue(card)
  if (cardmarketUsd != null) {
    return [{
      key: 'cardmarket',
      label: `Cardmarket ${CARDMARKET_LABELS[cardmarketField?.key] || 'Price'}`,
      amount: cardmarketUsd,
      currency: 'USD',
      source: 'Cardmarket',
    }]
  }

  return []
}

export function getPokemonTcgplayerBreakdown(card) {
  const tcgplayer = card?.tcgplayer
  const prices = tcgplayer?.prices || {}
  const variants = Object.keys(prices).map(key => {
    const entry = prices[key]
    const metrics = TCGPLAYER_VALUE_PRIORITY
      .map(field => {
        const label = field === 'directLow'
          ? 'Direct Low'
          : field.charAt(0).toUpperCase() + field.slice(1)
        return [label, normalizePriceAmount(entry?.[field])]
      })
      .filter(([, value]) => value != null)

    return {
      key,
      label: VARIANT_LABELS[key] || fallbackVariantLabel(key),
      metrics,
    }
  }).filter(variant => variant.metrics.length > 0)

  return {
    updatedAt: tcgplayer?.updatedAt || null,
    url: tcgplayer?.url || null,
    currency: 'USD',
    variants,
  }
}

export function getPokemonCardmarketBreakdown(card) {
  const cardmarket = card?.cardmarket
  const prices = cardmarket?.prices || {}
  const metrics = Object.entries(CARDMARKET_LABELS)
    .map(([key, label]) => [label, normalizePriceAmount(prices[key])])
    .filter(([, value]) => value != null)

  return {
    updatedAt: cardmarket?.updatedAt || null,
    url: cardmarket?.url || null,
    currency: 'EUR',
    metrics,
  }
}

export function getPokemonPrice(card, variantKey) {
  const options = getPokemonPriceOptions(card)
  if (!options.length) return null
  return options.find(option => option.key === variantKey) || options[0]
}

export function formatPokemonPrice(value, currency = 'USD') {
  const amount = normalizePriceAmount(value)
  if (amount == null) return '-'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function createPokemonCardSnapshot(card) {
  if (!card) return null
  return {
    id: card.id,
    name: card.name,
    supertype: card.supertype || '',
    subtypes: card.subtypes || [],
    types: card.types || [],
    hp: card.hp || '',
    number: card.number || '',
    artist: card.artist || '',
    rarity: card.rarity || '',
    images: {
      small: card.images?.small || null,
      large: card.images?.large || card.images?.small || null,
    },
    set: {
      id: card.set?.id || '',
      ptcgoCode: card.set?.ptcgoCode || '',
      name: card.set?.name || '',
      series: card.set?.series || '',
      printedTotal: card.set?.printedTotal || '',
      total: card.set?.total || '',
      releaseDate: card.set?.releaseDate || '',
      images: {
        symbol: card.set?.images?.symbol || null,
        logo: card.set?.images?.logo || null,
      },
    },
    tcgplayer: card.tcgplayer || null,
    cardmarket: card.cardmarket || null,
  }
}
