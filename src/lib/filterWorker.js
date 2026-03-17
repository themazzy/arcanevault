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

function matchNumeric(rawVal, op, minStr, maxStr) {
  const val = parseFloat(rawVal)
  if (isNaN(val)) return op === 'any'
  if (op === 'any')     return true
  const min = parseFloat(minStr)
  const max = parseFloat(maxStr)
  if (op === '=')       return !isNaN(min) && val === min
  if (op === '<=')      return !isNaN(min) && val <= min
  if (op === '>=')      return !isNaN(min) && val >= min
  if (op === 'between') return !isNaN(min) && !isNaN(max) && val >= min && val <= max
  return true
}

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4 }

self.onmessage = (e) => {
  const { id, cards, sfMap, search, sort, filters = {}, priceSource = 'cardmarket_trend', cardFolderMap = {} } = e.data

  const {
    foil = 'all',
    colors = [], colorMode = 'identity',
    colorCountMin = 0, colorCountMax = 5,
    rarity = [],
    typeLine = '', oracleText = '', artist = '',
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
  if (location === 'none')   r = r.filter(c => !(cardFolderMap[c.id]?.length > 0))

  if (typeLine.trim()) {
    const words = typeLine.trim().toLowerCase().split(/\s+/)
    r = r.filter(c => {
      const tl = (sfMap[`${c.set_code}-${c.collector_number}`]?.type_line || '').toLowerCase()
      return words.every(w => tl.includes(w))
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
      const p = getPrice(sfMap[`${c.set_code}-${c.collector_number}`], c.foil, priceSource)
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

  r.sort((a, b) => {
    const sfA = sfMap[`${a.set_code}-${a.collector_number}`]
    const sfB = sfMap[`${b.set_code}-${b.collector_number}`]
    // P&L = (current EUR price - purchase_price) * qty
    const plA = (() => { const p = getPrice(sfA, a.foil, 'cardmarket_trend'); return p != null && a.purchase_price > 0 ? (p - a.purchase_price) * a.qty : null })()
    const plB = (() => { const p = getPrice(sfB, b.foil, 'cardmarket_trend'); return p != null && b.purchase_price > 0 ? (p - b.purchase_price) * b.qty : null })()
    switch (sort) {
      case 'name':       return a.name.localeCompare(b.name)
      case 'price_desc': return (getPrice(sfB, b.foil, priceSource) || 0) - (getPrice(sfA, a.foil, priceSource) || 0)
      case 'price_asc':  return (getPrice(sfA, a.foil, priceSource) || 0) - (getPrice(sfB, b.foil, priceSource) || 0)
      case 'pl_desc':    return (plB ?? -Infinity) - (plA ?? -Infinity)
      case 'pl_asc':     return (plA ?? Infinity) - (plB ?? Infinity)
      case 'qty':        return b.qty - a.qty
      case 'set':        return (a.set_code || '').localeCompare(b.set_code || '')
      case 'added':      return new Date(b.added_at || 0) - new Date(a.added_at || 0)
      case 'rarity':     return (RARITY_ORDER[sfB?.rarity] ?? 0) - (RARITY_ORDER[sfA?.rarity] ?? 0)
      case 'cmc_asc':    return (sfA?.cmc ?? 99) - (sfB?.cmc ?? 99)
      case 'cmc_desc':   return (sfB?.cmc ?? 0) - (sfA?.cmc ?? 0)
      default:           return 0
    }
  })

  self.postMessage({ id, result: r })
}
