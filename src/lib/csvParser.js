/**
 * Parse a Manabox collection CSV.
 * Returns { cards, folders }
 * cards: array of card objects ready to upsert
 * folders: map of folderName -> { name, type, cards[] }
 */
export function parseManaboxCSV(text) {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return { cards: [], folders: {} }

  const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase())

  const get = (row, ...keys) => {
    for (const k of keys) {
      const i = header.indexOf(k)
      if (i !== -1 && row[i] !== undefined) return row[i].trim().replace(/^"|"$/g, '')
    }
    return ''
  }

  const allCards = []
  const folders = {}

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // Parse CSV row respecting quoted fields
    const row = []
    let cur = '', inQ = false
    for (const ch of line + ',') {
      if (ch === '"') inQ = !inQ
      else if (ch === ',' && !inQ) { row.push(cur); cur = '' }
      else cur += ch
    }

    const name = get(row, 'name')
    if (!name) continue

    const setCode         = get(row, 'set code', 'edition', 'set').toLowerCase()
    const collectorNumber = get(row, 'collector number')
    const scryfallId      = get(row, 'scryfall id')
    const foilRaw         = get(row, 'foil').toLowerCase()
    const foil            = foilRaw === 'foil' || foilRaw === 'true' || foilRaw === 'etched'
    const qty             = Math.max(1, parseInt(get(row, 'quantity', 'count', 'qty') || '1', 10))
    const condition       = get(row, 'condition') || 'near_mint'
    const language        = get(row, 'language', 'lang') || 'en'
    const purchasePrice   = parseFloat(get(row, 'purchase price') || '0') || 0
    const currency        = get(row, 'purchase price currency') || 'EUR'
    const misprint        = get(row, 'misprint').toLowerCase() === 'true'
    const altered         = get(row, 'altered').toLowerCase() === 'true'
    const binderName      = get(row, 'binder name')
    const binderType      = get(row, 'binder type') || 'binder'

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
    }

    allCards.push(card)

    // Group into folders
    if (binderName) {
      if (!folders[binderName]) {
        // normalise type: only binder / deck / list
        const type = ['deck', 'list'].includes(binderType) ? binderType : 'binder'
        folders[binderName] = { name: binderName, type, cards: [] }
      }
      folders[binderName].cards.push(card)
    }
  }

  return { cards: allCards, folders }
}
