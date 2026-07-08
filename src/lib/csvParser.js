/**
 * Parse a collection CSV exported by Manabox, Moxfield, or Archidekt.
 * Returns { cards, folders }
 * cards: array of card objects ready to upsert
 * folders: map of folderName -> { name, type, cards[] } (Manabox only — others have no binder column)
 */

const CONDITION_MAP = {
  m: 'near_mint', mint: 'near_mint',
  nm: 'near_mint', 'near mint': 'near_mint', near_mint: 'near_mint',
  ex: 'lightly_played', excellent: 'lightly_played',
  lp: 'lightly_played', 'lightly played': 'lightly_played', lightly_played: 'lightly_played',
  gd: 'moderately_played', good: 'moderately_played',
  pl: 'moderately_played', played: 'moderately_played',
  mp: 'moderately_played', 'moderately played': 'moderately_played', moderately_played: 'moderately_played',
  hp: 'heavily_played', 'heavily played': 'heavily_played', heavily_played: 'heavily_played',
  dmg: 'damaged', damaged: 'damaged', d: 'damaged',
  po: 'damaged', poor: 'damaged',
}

const LANGUAGE_MAP = {
  en: 'en', english: 'en',
  es: 'es', spanish: 'es',
  fr: 'fr', french: 'fr',
  de: 'de', german: 'de',
  it: 'it', italian: 'it',
  pt: 'pt', portuguese: 'pt',
  ja: 'ja', jp: 'ja', japanese: 'ja',
  ko: 'ko', korean: 'ko',
  ru: 'ru', russian: 'ru',
  zhs: 'zhs', 'chinese simplified': 'zhs', 'simplified chinese': 'zhs',
  zht: 'zht', 'chinese traditional': 'zht', 'traditional chinese': 'zht',
  ph: 'ph', phyrexian: 'ph',
}

function parseCSVRow(line) {
  const row = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      // Handle "" as escaped quote inside quoted field
      if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
      else inQ = !inQ
    } else if (ch === ',' && !inQ) {
      row.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  // Always flush the final field, even if the row ended mid-quote (unclosed
  // quote from a hand-edited CSV) — otherwise the last column silently vanishes.
  row.push(cur)
  // No surrounding-quote strip here: the quote-toggle above already consumes
  // wrapping quotes, and a blanket strip mangles escaped-quote content like
  // `"Say ""Hi"""` (would lose the trailing `"`).
  return row.map(v => v.trim())
}

function normalizeCondition(raw) {
  const k = String(raw || '').trim().toLowerCase()
  if (!k) return 'near_mint'
  return CONDITION_MAP[k] || k
}

function normalizeLanguage(raw) {
  const k = String(raw || '').trim().toLowerCase()
  if (!k) return 'en'
  return LANGUAGE_MAP[k] || k
}

function isFoilValue(foilRaw, finishRaw) {
  const foil = String(foilRaw || '').trim().toLowerCase()
  const finish = String(finishRaw || '').trim().toLowerCase()
  if (['foil', 'etched', 'true', '1', 'yes'].includes(foil)) return true
  if (['foil', 'etched'].includes(finish)) return true
  return false
}

export class CSVParseError extends Error {
  constructor(message) { super(message); this.name = 'CSVParseError' }
}

export function parseManaboxCSV(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n')
  if (lines.length < 2) return { cards: [], folders: {} }

  const header = parseCSVRow(lines[0]).map(h => h.toLowerCase())
  if (!header.includes('name')) {
    throw new CSVParseError(
      "CSV is missing a 'name' column. Expected a Manabox / Moxfield / Archidekt export."
    )
  }

  const get = (row, ...keys) => {
    for (const k of keys) {
      const i = header.indexOf(k)
      if (i !== -1 && row[i] !== undefined && row[i] !== '') return row[i]
    }
    return ''
  }

  const allCards = []
  const folders = {}

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    const row = parseCSVRow(line)
    const name = get(row, 'name')
    if (!name) continue

    const setCode         = get(row, 'set code', 'set_code', 'edition', 'edition code', 'set').toLowerCase()
    const collectorNumber = get(row, 'collector number', 'collector_number', 'card number', 'cn')
    const scryfallId      = get(row, 'scryfall id', 'scryfall_id')
    const foil            = isFoilValue(get(row, 'foil'), get(row, 'finish'))
    const qty             = Math.max(1, parseInt(get(row, 'quantity', 'count', 'qty') || '1', 10))
    const condition       = normalizeCondition(get(row, 'condition'))
    const language        = normalizeLanguage(get(row, 'language', 'lang'))
    const purchasePrice   = parseFloat(get(row, 'purchase price', 'price (usd)', 'price') || '0') || 0
    const currency        = get(row, 'purchase price currency', 'currency') || 'EUR'
    const misprint        = get(row, 'misprint').toLowerCase() === 'true'
    const altered         = (get(row, 'altered', 'alter', 'altered art')).toLowerCase() === 'true'
    const binderName      = get(row, 'binder name')
    const rawBinderType   = get(row, 'binder type') || 'binder'
    const binderType      = ['deck', 'list'].includes(rawBinderType) ? rawBinderType : 'binder'
    // ManaBox allows different location types to share a display name.
    const binderKey       = binderName ? `${binderType}|${binderName}` : null

    const card = {
      name,
      set_code: setCode,
      collector_number: collectorNumber,
      scryfall_id: scryfallId || null,
      foil,
      qty,
      condition,
      language,
      purchase_price: purchasePrice,
      currency,
      misprint,
      altered,
      _localId: `${setCode}-${collectorNumber}-${foil ? 'f' : 'n'}-${language}-${condition}`,
      _binderName: binderName || null,
      _binderKey: binderKey,
    }

    allCards.push(card)

    if (binderName) {
      if (!folders[binderKey]) {
        folders[binderKey] = { name: binderName, type: binderType, cards: [] }
      }
      folders[binderKey].cards.push(card)
    }
  }

  return { cards: allCards, folders }
}
