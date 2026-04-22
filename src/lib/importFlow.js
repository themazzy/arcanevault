import { parseTextDecklist } from './deckBuilderApi'
import { parseManaboxCSV } from './csvParser'
import { fetchScryfallBatch, sfGet } from './scryfall'

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
  if (firstLine.includes(',') && /\bname\b/i.test(firstLine)) {
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
      sourceLocation: card._binderName || null,
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

function escapeScryfallExactName(name) {
  return String(name || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function fetchPaperPrintings(name) {
  const query = encodeURIComponent(`!"${escapeScryfallExactName(name)}" game:paper`)
  const data = await sfGet(`https://api.scryfall.com/cards/search?q=${query}&unique=prints&order=released&dir=desc`)
  return data?.data || []
}

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

  for (let i = 0; i < identifiers.length; i += 75) {
    const batch = identifiers.slice(i, i + 75)
    const cards = await fetchScryfallBatch(batch)
    for (const sfCard of cards) {
      if (sfCard.set && sfCard.collector_number) {
        byPrint.set(`${sfCard.set}-${sfCard.collector_number}`, sfCard)
      }
      for (const key of cardNameKeys(sfCard)) byName.set(key, sfCard)
    }
    onProgress?.(Math.min(totalBatches, Math.floor(i / 75) + 1), totalBatches)
    if (i + 75 < identifiers.length) await new Promise(resolve => setTimeout(resolve, 150))
  }

  return normalized.map(entry => {
    const printKey = entry.setCode && entry.collectorNumber
      ? `${entry.setCode}-${entry.collectorNumber}`
      : null
    const exactSfCard = printKey ? byPrint.get(printKey) : null
    const sfCard = exactSfCard || byName.get(entry.name.toLowerCase()) || null
    return {
      ...entry,
      sfCard,
      resolvedName: sfCard?.name || entry.name,
      resolvedSetCode: sfCard?.set || entry.setCode || null,
      resolvedCollectorNumber: sfCard?.collector_number || entry.collectorNumber || null,
      exactPrinting: !!exactSfCard,
      status: sfCard ? 'matched' : 'missing',
      reason: sfCard ? null : 'No Scryfall match',
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
