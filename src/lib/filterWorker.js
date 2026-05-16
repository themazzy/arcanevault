// Runs in a Web Worker — no DOM, no imports

// Price source → Scryfall field mapping (mirrored from scryfall.js)
const PRICE_FIELDS = {
  'cardmarket_trend': { field: 'eur',        foilField: 'eur_foil' },
  'tcgplayer_market': { field: 'usd',        foilField: 'usd_foil' },
  'tcgplayer_etched': { field: 'usd_etched', foilField: 'usd_etched' },
  'mtgo_tix':         { field: 'tix',        foilField: 'tix' },
}

const FALLBACK_ORDER = [
  { field: 'eur', foilField: 'eur_foil' },
  { field: 'usd', foilField: 'usd_foil' },
  { field: 'tix', foilField: 'tix' },
]

function getPrice(sfCard, foil, priceSource = 'cardmarket_trend') {
  if (!sfCard?.prices) return null
  const p = sfCard.prices
  const src = PRICE_FIELDS[priceSource] || PRICE_FIELDS['cardmarket_trend']
  const field = foil ? src.foilField : src.field
  const preferred = parseFloat(p[field] || 0)
  if (preferred) return preferred
  // Fallback chain
  for (const fb of FALLBACK_ORDER) {
    if (fb.field === field || fb.foilField === field) continue
    const val = parseFloat(p[foil ? fb.foilField : fb.field] || 0)
    if (val) return val
  }
  return null
}

// No cross-source fallback — matches display logic so sort/filter align with shown prices
function getPriceStrict(sfCard, foil, priceSource = 'cardmarket_trend') {
  if (!sfCard?.prices) return null
  const src = PRICE_FIELDS[priceSource] || PRICE_FIELDS['cardmarket_trend']
  const field = foil ? src.foilField : src.field
  const val = parseFloat(sfCard.prices[field] || 0)
  return val || null
}

function matchNumeric(rawVal, op, minStr, maxStr) {
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

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4 }

// Cached snapshot — set by 'snapshot' messages, reused by 'filter' messages.
// Avoids re-cloning thousands of cards across the worker boundary on every keystroke.
let SNAPSHOT = { cards: [], sfMap: {}, cardFolderMap: {} }

self.onmessage = (e) => {
  const data = e.data
  if (data.type === 'snapshot') {
    SNAPSHOT = {
      cards: data.cards || [],
      sfMap: data.sfMap || {},
      cardFolderMap: data.cardFolderMap || {},
    }
    return
  }
  const { id, search, sort, filters = {}, priceSource = 'cardmarket_trend' } = data
  const { cards, sfMap, cardFolderMap } = SNAPSHOT

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

  let r = [...cards]

  if (foil === 'foil')    r = r.filter(c => c.foil)
  if (foil === 'nonfoil') r = r.filter(c => !c.foil)
  if (foil === 'etched')  r = r.filter(c => c.foil)

  if (rarity.length)     r = r.filter(c => rarity.includes(sfMap[`${c.set_code}-${c.collector_number}`]?.rarity))
  if (conditions.length) r = r.filter(c => conditions.includes(c.condition))
  if (languages.length)  r = r.filter(c => languages.includes(c.language))
  if (sets.length)       r = r.filter(c => sets.includes(c.set_code))

  if (quantity === 'dupes')  r = r.filter(c => c.qty > 1)
  if (quantity === 'single') r = r.filter(c => c.qty === 1)
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
      const tl = (sfMap[`${c.set_code}-${c.collector_number}`]?.type_line || '').toLowerCase()
      return typeLineArr.every(t => tl.includes(t.toLowerCase()))
    })
  }

  if (oracleText.trim()) {
    const q = oracleText.trim().toLowerCase()
    r = r.filter(c => (sfMap[`${c.set_code}-${c.collector_number}`]?.oracle_text || '').toLowerCase().includes(q))
  }

  if (artist.trim()) {
    const q = artist.trim().toLowerCase()
    r = r.filter(c => (sfMap[`${c.set_code}-${c.collector_number}`]?.artist || '').toLowerCase().includes(q))
  }

  if (colors.length) {
    r = r.filter(c => {
      const ci = sfMap[`${c.set_code}-${c.collector_number}`]?.color_identity || []
      const wantsMulti = colors.includes('M'), wantsColorless = colors.includes('C')
      const selected = colors.filter(x => ['W','U','B','R','G'].includes(x))
      if (!selected.length) return (wantsMulti && ci.length > 1) || (wantsColorless && ci.length === 0)
      if (wantsMulti && ci.length > 1)   return true
      if (wantsColorless && ci.length === 0) return true
      if (colorMode === 'exact')     return ci.length === selected.length && selected.every(x => ci.includes(x))
      if (colorMode === 'including') return selected.every(x => ci.includes(x))
      return selected.some(x => ci.includes(x))
    })
  }

  if (colorCountMin > 0 || colorCountMax < 5) {
    r = r.filter(c => {
      const ci = sfMap[`${c.set_code}-${c.collector_number}`]?.color_identity || []
      return ci.length >= colorCountMin && ci.length <= colorCountMax
    })
  }

  if (formats.length) {
    r = r.filter(c => {
      const leg = sfMap[`${c.set_code}-${c.collector_number}`]?.legalities || {}
      return formats.some(f => leg[f] === 'legal')
    })
  }

  if (cmcOp !== 'any') {
    r = r.filter(c => matchNumeric(String(sfMap[`${c.set_code}-${c.collector_number}`]?.cmc ?? ''), cmcOp, cmcMin, cmcMax))
  }
  if (powerOp !== 'any') {
    r = r.filter(c => matchNumeric(sfMap[`${c.set_code}-${c.collector_number}`]?.power, powerOp, powerVal, powerVal2))
  }
  if (toughOp !== 'any') {
    r = r.filter(c => matchNumeric(sfMap[`${c.set_code}-${c.collector_number}`]?.toughness, toughOp, toughVal, toughVal2))
  }

  if (priceMin !== '' || priceMax !== '') {
    const min = priceMin !== '' ? parseFloat(priceMin) : null
    const max = priceMax !== '' ? parseFloat(priceMax) : null
    r = r.filter(c => {
      const p = getPriceStrict(sfMap[`${c.set_code}-${c.collector_number}`], c.foil, priceSource) ?? parseFloat(c.purchase_price) ?? null
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
      (sfMap[`${c.set_code}-${c.collector_number}`]?.set_name || '').toLowerCase().includes(q)
    )
  }

  // Precompute the single sort key per card so the comparator stays O(1).
  // Doing this once is O(N); doing it inside the comparator is O(N log N · constants).
  const needsKey = sort && sort !== 'qty' && sort !== 'set' && sort !== 'added'
  if (needsKey) {
    const keyOf = (c) => {
      const sf = sfMap[`${c.set_code}-${c.collector_number}`]
      switch (sort) {
        case 'name':       return c.name || ''
        case 'price_desc':
        case 'price_asc':  return getPriceStrict(sf, c.foil, priceSource) ?? parseFloat(c.purchase_price) ?? 0
        case 'pl_desc':
        case 'pl_asc': {
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
      case 'pl_asc':     return (a.__sk ?? Infinity) - (b.__sk ?? Infinity)
      case 'qty':        return b.qty - a.qty
      case 'set':        return (a.set_code || '').localeCompare(b.set_code || '')
      case 'added':      return new Date(b.added_at || 0) - new Date(a.added_at || 0)
      case 'rarity':     return b.__sk - a.__sk
      case 'cmc_asc':    return a.__sk - b.__sk
      case 'cmc_desc':   return b.__sk - a.__sk
      default:           return 0
    }
  })

  // Return only IDs — main thread reconstructs from its cards Map.
  // Avoids structured-cloning thousands of card objects across the worker boundary.
  const ids = new Array(r.length)
  for (let i = 0; i < r.length; i++) ids[i] = r[i].id
  self.postMessage({ id, ids })
}
