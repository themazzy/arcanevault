// Shared filter + sort logic used by both:
//   - src/lib/filterWorker.js  (Web Worker — Collection page)
//   - src/components/CardComponents.jsx  (synchronous applyFilterSort)
//
// Keep this module pure and DOM-free so it stays importable from the worker.

import { colorIdentityMatches } from './colorFilter'

// Price source → Scryfall field mapping (mirrored from scryfall.js)
export const PRICE_FIELDS = {
  'cardmarket_trend': { field: 'eur',        foilField: 'eur_foil' },
  'tcgplayer_market': { field: 'usd',        foilField: 'usd_foil' },
  'tcgplayer_etched': { field: 'usd_etched', foilField: 'usd_etched' },
  'mtgo_tix':         { field: 'tix',        foilField: 'tix' },
}

export const FALLBACK_ORDER = [
  { field: 'eur', foilField: 'eur_foil' },
  { field: 'usd', foilField: 'usd_foil' },
  { field: 'tix', foilField: 'tix' },
]

export const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4 }

// Price with cross-source fallback (matches scryfall.js display behavior).
export function getPrice(sfCard, foil, priceSource = 'cardmarket_trend') {
  if (!sfCard?.prices) return null
  const p = sfCard.prices
  const src = PRICE_FIELDS[priceSource] || PRICE_FIELDS['cardmarket_trend']
  const field = foil ? src.foilField : src.field
  const preferred = parseFloat(p[field] || 0)
  if (preferred) return preferred
  for (const fb of FALLBACK_ORDER) {
    if (fb.field === field || fb.foilField === field) continue
    const val = parseFloat(p[foil ? fb.foilField : fb.field] || 0)
    if (val) return val
  }
  return null
}

// Price with no cross-source fallback — keeps sort/filter aligned with the
// exact currency the user has selected (no "secretly used USD" surprises).
export function getPriceStrict(sfCard, foil, priceSource = 'cardmarket_trend') {
  if (!sfCard?.prices) return null
  const src = PRICE_FIELDS[priceSource] || PRICE_FIELDS['cardmarket_trend']
  const field = foil ? src.foilField : src.field
  const val = parseFloat(sfCard.prices[field] || 0)
  return val || null
}

export function matchNumeric(rawVal, op, minStr, maxStr) {
  const val = parseFloat(rawVal)
  if (isNaN(val)) return op === 'any'
  if (op === 'any') return true
  if (op === 'in') {
    const nums = String(minStr).split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n))
    return nums.length > 0 && nums.some(n => n === val)
  }
  const min = parseFloat(minStr)
  const max = parseFloat(maxStr)
  if (op === '=')       return !isNaN(min) && val === min
  if (op === '<')       return !isNaN(min) && val < min
  if (op === '<=')      return !isNaN(min) && val <= min
  if (op === '>')       return !isNaN(min) && val > min
  if (op === '>=')      return !isNaN(min) && val >= min
  if (op === 'between') return !isNaN(min) && !isNaN(max) && val >= min && val <= max
  return true
}

// applyFilterSort
//
//   cards          — array of owned card rows
//   sfMap          — { "<set>-<num>": scryfall card }
//   search, sort   — current UI state
//   filters        — filter blob (see EMPTY_FILTERS in CardComponents)
//   cardFolderMap  — { cardId: [{ id, name, type, qty }] }
//   priceSource    — settings.price_source
//   strictPrice    — true: worker mode (no cross-source price fallback).
//                    false: legacy CardComponents mode (cross-source fallback +
//                    `purchase_price` fallback as a last resort).
//   useFolderQty   — true: prefer `c._folder_qty` for quantity filter/sort
//                    (CardComponents path, called from folder/deck browsers).
//                    false: use `c.qty` directly (worker / Collection page).
export function applyFilterSort(cards, sfMap, {
  search = '',
  sort = 'name',
  filters = {},
  cardFolderMap = {},
  priceSource = 'cardmarket_trend',
  strictPrice = false,
  useFolderQty = false,
} = {}) {
  const {
    foil = 'all',
    colors = [], colorMode = 'identity',
    colorCountMin = 0, colorCountMax = 5,
    rarity = [],
    typeLine = [], oracleText = '', artist = '', folderName = '',
    conditions = [], languages = [], sets = [],
    formats = [],
    cmcOp = 'any', cmcMin = '', cmcMax = '',
    powerOp = 'any', powerVal = '', powerVal2 = '',
    toughOp = 'any', toughVal = '', toughVal2 = '',
    priceMin = '', priceMax = '',
    quantity = 'any', specials = [], location = 'all',
  } = filters

  const sfOf = (c) => sfMap[`${c.set_code}-${c.collector_number}`]
  const qtyOf = useFolderQty
    ? (c) => c._folder_qty ?? c.qty ?? 1
    : (c) => c.qty
  const priceOf = strictPrice
    ? (sf, f) => getPriceStrict(sf, f, priceSource)
    : (sf, f) => getPrice(sf, f, priceSource)

  let r = [...cards]

  if (foil === 'foil')    r = r.filter(c => c.foil)
  if (foil === 'nonfoil') r = r.filter(c => !c.foil)
  if (foil === 'etched')  r = r.filter(c => c.foil)

  if (rarity.length)     r = r.filter(c => rarity.includes(sfOf(c)?.rarity))
  if (conditions.length) r = r.filter(c => conditions.includes(c.condition))
  if (languages.length)  r = r.filter(c => languages.includes(c.language))
  if (sets.length)       r = r.filter(c => sets.includes(c.set_code))

  if (quantity === 'dupes')  r = r.filter(c => qtyOf(c) > 1)
  if (quantity === 'single') r = r.filter(c => qtyOf(c) === 1)
  if (specials.includes('altered'))  r = r.filter(c => c.altered)
  if (specials.includes('misprint')) r = r.filter(c => c.misprint)

  if (location === 'binder') r = r.filter(c => (cardFolderMap[c.id] || []).some(f => f.type === 'binder'))
  if (location === 'deck')   r = r.filter(c => (cardFolderMap[c.id] || []).some(f => f.type === 'deck'))
  if (folderName.trim()) {
    const q = folderName.trim().toLowerCase()
    r = r.filter(c => (cardFolderMap[c.id] || []).some(f =>
      (f.type === 'binder' || f.type === 'deck') &&
      (f.name || '').toLowerCase().includes(q)
    ))
  }

  const typeLineArr = Array.isArray(typeLine) ? typeLine : (typeLine ? typeLine.split(/\s+/) : [])
  if (typeLineArr.length > 0) {
    r = r.filter(c => {
      const tl = (sfOf(c)?.type_line || '').toLowerCase()
      return typeLineArr.every(t => tl.includes(t.toLowerCase()))
    })
  }

  if (oracleText.trim()) {
    const q = oracleText.trim().toLowerCase()
    r = r.filter(c => (sfOf(c)?.oracle_text || '').toLowerCase().includes(q))
  }

  if (artist.trim()) {
    const q = artist.trim().toLowerCase()
    r = r.filter(c => (sfOf(c)?.artist || '').toLowerCase().includes(q))
  }

  if (colors.length) {
    r = r.filter(c => colorIdentityMatches(sfOf(c)?.color_identity || [], colors, colorMode))
  }

  if (colorCountMin > 0 || colorCountMax < 5) {
    r = r.filter(c => {
      const ci = sfOf(c)?.color_identity || []
      return ci.length >= colorCountMin && ci.length <= colorCountMax
    })
  }

  if (formats.length) {
    r = r.filter(c => {
      const leg = sfOf(c)?.legalities || {}
      return formats.some(f => leg[f] === 'legal')
    })
  }

  if (cmcOp !== 'any') {
    r = r.filter(c => matchNumeric(String(sfOf(c)?.cmc ?? ''), cmcOp, cmcMin, cmcMax))
  }
  if (powerOp !== 'any') {
    r = r.filter(c => matchNumeric(sfOf(c)?.power, powerOp, powerVal, powerVal2))
  }
  if (toughOp !== 'any') {
    r = r.filter(c => matchNumeric(sfOf(c)?.toughness, toughOp, toughVal, toughVal2))
  }

  if (priceMin !== '' || priceMax !== '') {
    const min = priceMin !== '' ? parseFloat(priceMin) : null
    const max = priceMax !== '' ? parseFloat(priceMax) : null
    r = r.filter(c => {
      let p = priceOf(sfOf(c), c.foil)
      if (p == null && c.purchase_price != null && c.purchase_price !== '') {
        const fallback = parseFloat(c.purchase_price)
        p = Number.isFinite(fallback) ? fallback : null
      }
      if (p == null) return false
      if (min != null && p < min) return false
      if (max != null && p > max) return false
      return true
    })
  }

  if (search) {
    const q = search.toLowerCase()
    r = r.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.set_code || '').toLowerCase().includes(q) ||
      (sfOf(c)?.set_name || '').toLowerCase().includes(q)
    )
  }

  // Precompute the sort key once per row so the comparator stays O(1).
  const needsKey = sort && sort !== 'qty' && sort !== 'set' && sort !== 'added'
  if (needsKey) {
    const keyOf = (c) => {
      const sf = sfOf(c)
      switch (sort) {
        case 'name':       return c.name || ''
        case 'price_desc':
        case 'price_asc': {
          const px = priceOf(sf, c.foil)
          if (px != null) return px
          if (c.purchase_price == null || c.purchase_price === '') return 0
          const fb = parseFloat(c.purchase_price)
          return Number.isFinite(fb) ? fb : 0
        }
        case 'pl_desc':
        case 'pl_asc': {
          // P/L uses fallback-price intentionally — purchase_price is set in EUR
          // historically, and the cross-source fallback better matches that.
          const p = getPrice(sf, c.foil, 'cardmarket_trend')
          return p != null && c.purchase_price > 0 ? (p - c.purchase_price) * c.qty : null
        }
        case 'rarity':     return RARITY_ORDER[sf?.rarity] ?? 0
        case 'cmc_asc':
        case 'cmc_desc':   return sf?.cmc ?? (sort === 'cmc_asc' ? 99 : 0)
        default:           return 0
      }
    }
    for (const c of r) c.__sk = keyOf(c)
  }

  r.sort((a, b) => {
    switch (sort) {
      case 'name':       return a.__sk.localeCompare(b.__sk)
      case 'price_desc': return b.__sk - a.__sk
      case 'price_asc':  return a.__sk - b.__sk
      case 'pl_desc':    return (b.__sk ?? -Infinity) - (a.__sk ?? -Infinity)
      case 'pl_asc':     return (a.__sk ?? Infinity)  - (b.__sk ?? Infinity)
      case 'qty':        return qtyOf(b) - qtyOf(a)
      case 'set':        return (a.set_code || '').localeCompare(b.set_code || '')
      case 'added':      return new Date(b.added_at || 0) - new Date(a.added_at || 0)
      case 'rarity':     return b.__sk - a.__sk
      case 'cmc_asc':    return a.__sk - b.__sk
      case 'cmc_desc':   return b.__sk - a.__sk
      default:           return 0
    }
  })

  if (needsKey) for (const c of r) delete c.__sk

  return r
}
