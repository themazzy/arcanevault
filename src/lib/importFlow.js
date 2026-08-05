import { parseTextDecklist } from './deckBuilderApi'
import { parseManaboxCSV } from './csvParser'
import { fetchScryfallBatch, fetchScryfallNamed } from './scryfall'

export { fetchPaperPrintings } from './deckBuilderApi'

export const IMPORT_SOURCE = {
  TEXT: 'text',
  CSV: 'csv',
  URL: 'url',
}

function normalizeSetCode(value) {
  return value ? String(value).trim().toLowerCase() : null
}

function normalizeCollectorNumber(value) {
  return value ? String(value).trim() : null
}

function normalizeName(value) {
  return String(value || '').trim()
}

function makeImportKey(entry) {
  return [
    normalizeName(entry.name).toLowerCase(),
    normalizeSetCode(entry.setCode) || '',
    normalizeCollectorNumber(entry.collectorNumber) || '',
    entry.foil ? 'foil' : 'normal',
    entry.language || 'en',
    entry.condition || 'near_mint',
    entry.sourceLocation || '',
    entry.board || 'main',
    entry.isCommander ? 'commander' : '',
  ].join('|')
}

function mergeEntries(entries) {
  const map = new Map()
  for (const entry of entries) {
    const name = normalizeName(entry.name)
    const qty = Math.max(1, Number.parseInt(entry.qty || 1, 10) || 1)
    if (!name) continue

    const normalized = {
      ...entry,
      name,
      qty,
      foil: !!entry.foil,
      setCode: normalizeSetCode(entry.setCode),
      collectorNumber: normalizeCollectorNumber(entry.collectorNumber),
      condition: entry.condition || 'near_mint',
      language: entry.language || 'en',
      sourceLocation: entry.sourceLocation || null,
      board: entry.board || 'main',
      isCommander: !!entry.isCommander,
      lineNumber: entry.lineNumber || null,
    }

    const key = makeImportKey(normalized)
    const existing = map.get(key)
    map.set(key, existing ? { ...existing, qty: existing.qty + normalized.qty } : normalized)
  }
  return [...map.values()]
}

export function parseImportText(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return { source: IMPORT_SOURCE.TEXT, entries: [] }

  const firstLine = trimmed.split('\n')[0] || ''
  // Decklists start with a quantity ("4 Lightning Bolt"); CSV headers never do.
  // Without this guard a comment line like "// 4 cards, including name X" or
  // a deck whose first line happens to contain a comma + "name" word would be
  // mis-routed through the Manabox CSV parser.
  const looksLikeDecklistLine = /^\d+x?\s/i.test(firstLine)
  if (!looksLikeDecklistLine && firstLine.includes(',') && /\bname\b/i.test(firstLine)) {
    const { cards, folders } = parseManaboxCSV(trimmed)
    const entries = mergeEntries(cards.map((card, index) => ({
      name: card.name,
      qty: card.qty,
      foil: card.foil,
      setCode: card.set_code || null,
      collectorNumber: card.collector_number || null,
      condition: card.condition || 'near_mint',
      language: card.language || 'en',
      purchasePrice: card.purchase_price || 0,
      currency: card.currency || null,
      sourceLocation: card._binderKey || card._binderName || null,
      lineNumber: index + 2,
    })))
    return { source: IMPORT_SOURCE.CSV, entries, folders }
  }

  const entries = mergeEntries(parseTextDecklist(trimmed).map((card, index) => ({
    name: card.name,
    qty: card.qty,
    foil: card.foil ?? false,
    setCode: card.setCode || null,
    collectorNumber: card.collectorNumber || null,
    board: card.board || 'main',
    isCommander: !!card.isCommander,
    lineNumber: index + 1,
  })))
  return { source: IMPORT_SOURCE.TEXT, entries }
}

export function normalizeImportedDeckCards(cards) {
  return mergeEntries((cards || []).map((card, index) => ({
    name: card.name,
    qty: card.qty,
    foil: card.foil ?? false,
    setCode: card.setCode || null,
    collectorNumber: card.collectorNumber || null,
    board: card.board || 'main',
    isCommander: !!card.isCommander,
    lineNumber: index + 1,
  })))
}

function cardNameKeys(sfCard) {
  const keys = []
  const full = sfCard?.name?.toLowerCase()
  if (full) keys.push(full)
  const frontFace = full?.split(' // ')[0]
  if (frontFace && frontFace !== full) keys.push(frontFace)
  return keys
}

// Case/punctuation-insensitive comparison, so "Jace, Vryn's Prodigy" and
// "jace vryns prodigy" count as the same name. Punctuation is dropped rather
// than turned into a space — otherwise a stripped apostrophe would split
// "Vryn's" into two words and stop it matching "Vryns".
function loosenName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Flavor names live at the top level for single-faced cards and per-face for
// double-faced ones ("Prime Mirelurk Queen" / "Hullbreaker Horror").
function flavorNames(sfCard) {
  return [sfCard?.flavor_name, ...(sfCard?.card_faces || []).map(face => face?.flavor_name)]
    .filter(Boolean)
}

// A fuzzy hit resolved a name the collection endpoint could not. Report which
// kind it was so the preview can show it, rather than silently swapping the
// name the user typed for a different one.
export const MATCH_NOTE = { FLAVOR_NAME: 'flavor_name', APPROXIMATE: 'approximate' }

export const MATCH_NOTE_LABELS = {
  [MATCH_NOTE.FLAVOR_NAME]: 'matched via flavor name',
  [MATCH_NOTE.APPROXIMATE]: 'approximate name match',
}

export const MATCH_NOTE_SHORT_LABELS = {
  [MATCH_NOTE.FLAVOR_NAME]: 'Flavor name',
  [MATCH_NOTE.APPROXIMATE]: 'Approx. name',
}

function fuzzyMatchNote(typedName, sfCard) {
  const typed = loosenName(typedName)
  if (!typed || loosenName(sfCard?.name) === typed) return null
  if (flavorNames(sfCard).some(flavor => loosenName(flavor) === typed)) return MATCH_NOTE.FLAVOR_NAME
  return MATCH_NOTE.APPROXIMATE
}

// A pasted junk list must not turn into hundreds of serialized single-card
// requests, so only the first N unmatched names get the fuzzy retry.
const FUZZY_LOOKUP_LIMIT = 60

export async function resolveImportEntries(entries, onProgress) {
  const normalized = mergeEntries(entries || [])
  const identifiers = normalized.map(entry =>
    entry.setCode && entry.collectorNumber
      ? { set: entry.setCode, collector_number: entry.collectorNumber }
      : { name: entry.name }
  )

  const byPrint = new Map()
  const byName = new Map()
  const totalBatches = Math.max(1, Math.ceil(identifiers.length / 75))

  const batchErrors = []
  for (let i = 0; i < identifiers.length; i += 75) {
    const batch = identifiers.slice(i, i + 75)
    try {
      const { data: cards } = await fetchScryfallBatch(batch)
      for (const sfCard of cards) {
        if (sfCard.set && sfCard.collector_number) {
          byPrint.set(`${sfCard.set}-${sfCard.collector_number}`, sfCard)
        }
        for (const key of cardNameKeys(sfCard)) byName.set(key, sfCard)
      }
    } catch (err) {
      // One bad batch should not nuke a 1500-card import — log and let the
      // surviving matches through. Unmatched rows get status: 'missing' below.
      batchErrors.push({ batchIndex: Math.floor(i / 75), error: err })
      console.error('[importFlow] Scryfall batch failed, continuing:', err)
    }
    onProgress?.(Math.min(totalBatches, Math.floor(i / 75) + 1), totalBatches)
    if (i + 75 < identifiers.length) await new Promise(resolve => setTimeout(resolve, 150))
  }

  const hadBatchError = batchErrors.length > 0

  const matchFromBatches = entry => {
    const printKey = entry.setCode && entry.collectorNumber
      ? `${entry.setCode}-${entry.collectorNumber}`
      : null
    const exactSfCard = printKey ? byPrint.get(printKey) : null
    return { exactSfCard, sfCard: exactSfCard || byName.get(entry.name.toLowerCase()) || null }
  }

  // Second pass: anything the collection endpoint couldn't place gets one
  // fuzzy `named` lookup, which is the only Scryfall route that knows flavor
  // names. Distinct names only — a playset of the same unmatched card is one
  // request.
  const unmatchedNames = []
  const seenUnmatched = new Set()
  for (const entry of normalized) {
    if (matchFromBatches(entry).sfCard) continue
    const key = entry.name.toLowerCase()
    if (!key || seenUnmatched.has(key)) continue
    seenUnmatched.add(key)
    unmatchedNames.push(entry.name)
  }

  const byFuzzyName = new Map()
  const fuzzyNames = unmatchedNames.slice(0, FUZZY_LOOKUP_LIMIT)
  const totalSteps = totalBatches + fuzzyNames.length
  for (let i = 0; i < fuzzyNames.length; i++) {
    const name = fuzzyNames[i]
    const sfCard = await fetchScryfallNamed(name)
    if (sfCard) byFuzzyName.set(name.toLowerCase(), sfCard)
    onProgress?.(totalBatches + i + 1, totalSteps)
  }

  return normalized.map(entry => {
    const { exactSfCard, sfCard: batchSfCard } = matchFromBatches(entry)
    const fuzzySfCard = batchSfCard ? null : byFuzzyName.get(entry.name.toLowerCase()) || null
    const sfCard = batchSfCard || fuzzySfCard
    return {
      ...entry,
      sfCard,
      resolvedName: sfCard?.name || entry.name,
      resolvedSetCode: sfCard?.set || entry.setCode || null,
      resolvedCollectorNumber: sfCard?.collector_number || entry.collectorNumber || null,
      exactPrinting: !!exactSfCard,
      status: sfCard ? 'matched' : 'missing',
      reason: sfCard ? null : (hadBatchError ? 'Scryfall lookup failed' : 'No Scryfall match'),
      matchNote: fuzzySfCard ? fuzzyMatchNote(entry.name, fuzzySfCard) : null,
    }
  })
}

export function summarizeImportRows(rows) {
  const totalCopies = rows.reduce((sum, row) => sum + (row.qty || 0), 0)
  const matchedRows = rows.filter(row => row.status === 'matched')
  const missingRows = rows.filter(row => row.status !== 'matched')
  const matchedCopies = matchedRows.reduce((sum, row) => sum + (row.qty || 0), 0)
  const uniqueNames = new Set(rows.map(row => row.resolvedName || row.name)).size
  const uniquePrintings = new Set(matchedRows.map(row => [
    row.sfCard?.id || row.resolvedName || row.name,
    row.foil ? 'foil' : 'normal',
    row.language || 'en',
    row.condition || 'near_mint',
  ].join('|'))).size
  const sourceLocations = new Set(rows.map(row => row.sourceLocation).filter(Boolean))
  const exactPrintingRows = matchedRows.filter(row => row.exactPrinting).length
  const foilCopies = rows.filter(row => row.foil).reduce((sum, row) => sum + (row.qty || 0), 0)

  return {
    totalRows: rows.length,
    totalCopies,
    matchedRows: matchedRows.length,
    matchedCopies,
    missingRows: missingRows.length,
    missingCopies: missingRows.reduce((sum, row) => sum + (row.qty || 0), 0),
    uniqueNames,
    uniquePrintings,
    sourceLocationCount: sourceLocations.size,
    sourceLocations: [...sourceLocations],
    exactPrintingRows,
    foilCopies,
  }
}

export function aggregateResolvedRows(rows, keyFn, buildFn) {
  const map = new Map()
  for (const row of rows) {
    if (row.status !== 'matched' || !row.sfCard) continue
    const key = keyFn(row)
    const existing = map.get(key)
    if (existing) existing.qty += row.qty
    else map.set(key, buildFn(row))
  }
  return [...map.values()]
}
