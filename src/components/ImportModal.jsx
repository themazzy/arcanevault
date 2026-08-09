import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { Modal, ConfirmModal, ResponsiveMenu } from './UI'
import { getImportDiscardModel } from '../lib/importDiscard'
import { importDeckFromUrl } from '../lib/deckBuilderApi'
import {
  aggregateResolvedRows,
  normalizeImportedDeckCards,
  parseImportText,
  resolveImportEntries,
} from '../lib/importFlow'
import {
  REVIEW_ISSUE,
  clearResolution,
  describeReviewRows,
  reviewHeadline,
  reviewRowIssue,
  uniformValue,
} from '../lib/importReview'
import ImportReviewList from './import/ImportReviewList'
import ImportSourceStep from './import/ImportSourceStep'
import { ensureCardPrints, getCardPrint, withCardPrint } from '../lib/cardPrints'
import { toOwnedCardRow, toListItemRow, toDeckCardRow, mergeNonNull } from '../lib/deckBuilderWrites'
import { removeAcquiredFromWishlists, findOwnedCardNames } from '../lib/wishlistSync'
import { putCards, putDeckAllocations, putFolderCards, putFolders } from '../lib/db'
import { ChevronDownIcon, ChevronUpIcon } from '../icons'
import styles from './ImportModal.module.css'
import uiStyles from './UI.module.css'

// Buttons come from the shared primitive (DESIGN.md §3) — variants only remap
// --btn-*, so hover/focus-visible/disabled arrive for free.
const BTN = `${uiStyles.btn} ${uiStyles.sm}`
const BTN_PRIMARY = `${BTN} ${uiStyles.primary}`
const BTN_SECONDARY = `${BTN} ${uiStyles.secondary}`

const NOUN = { binder: 'Binder', deck: 'Deck', list: 'Wishlist' }
const TYPE_OPTIONS = [
  { id: 'binder', label: 'Binder' },
  { id: 'deck', label: 'Deck' },
  { id: 'list', label: 'Wishlist' },
]
const PAGE_SIZE = 100

const TEXT_PLACEHOLDER = `4 Forest
1 Sol Ring
4 Lightning Bolt (M10) 155
// comments are ignored`
const SUB_PHASE_LABELS = { lookup: 'checking what we already have', insert: 'adding new prints' }
const IMPORT_WRITE_BATCH = 500
const IMPORT_LOOKUP_BATCH = 75
const PLACEMENT_SELECTS = {
  deck_allocations: 'id,deck_id,user_id,card_id,qty',
  folder_cards: 'id,folder_id,card_id,qty,updated_at',
}

function chunkRows(rows, size = IMPORT_WRITE_BATCH) {
  const chunks = []
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size))
  return chunks
}

function queryBatchSizeForKeyFields(keyFields) {
  return keyFields.includes('card_print_id') ? IMPORT_LOOKUP_BATCH : IMPORT_WRITE_BATCH
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function formatLocationSummary(stats) {
  const parts = []
  if (stats.deck) parts.push(pluralize(stats.deck, 'deck'))
  if (stats.binder) parts.push(pluralize(stats.binder, 'binder'))
  if (stats.list) parts.push(pluralize(stats.list, 'wishlist', 'wishlists'))
  if (!parts.length) return ''
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function getFolderTypeLabel(type) {
  if (type === 'deck') return 'deck'
  if (type === 'list') return 'wishlist'
  return 'binder'
}

function isGroupFolder(folder) {
  try { return JSON.parse(folder?.description || '{}').isGroup === true } catch { return false }
}

// Tables that lost denormalized print metadata in phase 5d need their write
// payloads filtered to ownership-only cols. Reads from these tables (post-
// upsert .select() chains) also can't expect those fields anymore — callers
// re-attach metadata from the input rows where needed.
const TABLE_ROW_BUILDERS = {
  cards: toOwnedCardRow,
  list_items: toListItemRow,
  deck_cards: toDeckCardRow,
}

function buildPayload(table, row) {
  const fn = TABLE_ROW_BUILDERS[table]
  return fn ? fn(row) : row
}

async function upsertInBatches(table, rows, options, selectColumns = '*', onBatchDone) {
  const saved = []
  const batches = chunkRows(rows)
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i].map(row => {
      if (row?.id != null) return row
      const { id: _id, ...rest } = row
      return rest
    })
    const rowsWithId = batch.filter(row => row.id != null)
    const rowsWithoutId = batch.filter(row => row.id == null)
    for (const subBatch of [rowsWithId, rowsWithoutId]) {
      if (!subBatch.length) continue
      const { data, error } = await sb.from(table)
        .upsert(subBatch.map(row => buildPayload(table, row)), options)
        .select(selectColumns)
      if (error) throw error
      if (data?.length) {
        // Re-attach denorm metadata from the input rows so callers (IDB
        // hydration, key-building loops) keep the shape they had pre-5d.
        const inputByKey = new Map()
        for (const row of subBatch) {
          if (row.card_print_id != null) inputByKey.set(`${row.card_print_id}|${row.foil ? 1 : 0}`, row)
        }
        for (const row of data) {
          saved.push(mergeNonNull(inputByKey.get(`${row.card_print_id}|${row.foil ? 1 : 0}`), row))
        }
      }
    }
    onBatchDone?.({ batchIndex: i + 1, batchCount: batches.length })
  }
  return saved
}

function rowKey(row, keyFields) {
  return keyFields.map(field => String(row[field] ?? '')).join('|')
}

async function additiveUpsertInBatches(table, rows, keyFields, options, selectColumns = '*', onBatchDone) {
  const saved = []
  const batches = chunkRows(rows, queryBatchSizeForKeyFields(keyFields))

  for (let i = 0; i < batches.length; i++) {
    const mergedByKey = new Map()
    for (const row of batches[i]) {
      const key = rowKey(row, keyFields)
      const existing = mergedByKey.get(key)
      mergedByKey.set(key, existing ? { ...existing, qty: (existing.qty || 0) + (row.qty || 0) } : row)
    }
    const batch = [...mergedByKey.values()]

    let query = sb.from(table).select(`id,qty,${keyFields.join(',')}`)
    for (const field of keyFields) {
      const values = [...new Set(batch.map(row => row[field]).filter(value => value !== null && value !== undefined))]
      if (!values.length) continue
      query = query.in(field, values)
    }

    const { data: existingRows, error: existingError } = await query
    if (existingError) throw existingError

    const existingByKey = new Map((existingRows || []).map(row => [rowKey(row, keyFields), row]))
    const rowsToSave = batch.map(row => {
      const existing = existingByKey.get(rowKey(row, keyFields))
      return existing
        ? { ...row, id: existing.id, qty: (existing.qty || 0) + (row.qty || 0) }
        : (() => {
            const { id: _id, ...rest } = row
            return rest
          })()
    })

    const batchSaved = await upsertInBatches(table, rowsToSave, options, selectColumns)
    if (batchSaved?.length) saved.push(...batchSaved)
    onBatchDone?.({ batchIndex: i + 1, batchCount: batches.length })
  }

  return saved
}

function missingLabel(row) {
  return `${row.lineNumber ? `Line ${row.lineNumber}: ` : ''}${row.name}${row.setCode ? ` (${row.setCode.toUpperCase()}${row.collectorNumber ? ` ${row.collectorNumber}` : ''})` : ''} - ${row.reason || 'Not found'}`
}

export default function ImportModal({
  userId, folderType, folders: initialFolders, defaultFolderId,
  onClose, onSaved,
  initialText,
  allowTypeSelection = false,
}) {
  const [activeFolderType, setActiveFolderType] = useState(folderType || 'binder')
  const noun = NOUN[activeFolderType] || activeFolderType
  const initialImport = useMemo(
    () => initialText ? parseImportText(initialText) : { entries: [], folders: {} },
    [initialText]
  )
  const initialEntries = initialImport.entries
  const [step, setStep] = useState(initialText ? 'preview' : 'input')
  const [text, setText] = useState(initialText || '')
  const [url, setUrl] = useState('')
  const [sourceTab, setSourceTab] = useState('text')
  const [fetchingUrl, setFetchingUrl] = useState(false)
  const [parsed, setParsed] = useState(initialEntries)
  const [sourceFolders, setSourceFolders] = useState(initialImport.folders || {})
  const [resolvedRows, setResolvedRows] = useState([])
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const [resolveProgress, setResolveProgress] = useState({ done: 0, total: 0 })
  const [folders, setFolders] = useState((initialFolders || []).filter(folder => !isGroupFolder(folder)))
  const [folderId, setFolderId] = useState(defaultFolderId || '')
  const [folderSearch, setFolderSearch] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [total, setTotal] = useState(0)
  const [progressPhase, setProgressPhase] = useState('')
  const [missed, setMissed] = useState([])
  const [imported, setImported] = useState(0)
  const [skippedOwnedCount, setSkippedOwnedCount] = useState(0)
  const [inputError, setInputError] = useState('')
  const [discardPrompt, setDiscardPrompt] = useState(null)
  // Invalidates in-flight resolves so a superseded run can't overwrite newer
  // rows (a re-parse, or a printing the user edited by hand).
  const resolveSeq = useRef(0)

  const previewRows = resolvedRows.length ? resolvedRows : parsed
  const reviewDesc = describeReviewRows(previewRows)
  const hasSourceFolders = Object.keys(sourceFolders || {}).length > 0
  const destinationFolders = hasSourceFolders
    ? folders.filter(folder => !isGroupFolder(folder))
    : folders.filter(f => f.type === activeFolderType && !isGroupFolder(f))
  const selectedFolderName = destinationFolders.find(f => f.id === folderId)?.name || ''
  const destinationLabel = noun.toLowerCase()
  const matchedPreviewRows = resolvedRows.filter(row => row.status === 'matched')
  const canImport = !resolving && matchedPreviewRows.length > 0 && (hasSourceFolders || !!folderId)
  const filteredFolders = destinationFolders.filter(f =>
    !folderSearch.trim() || f.name.toLowerCase().includes(folderSearch.toLowerCase())
  )
  const locationStats = previewRows.reduce((stats, row) => {
    const folder = sourceFolders[row.sourceLocation]
    if (!folder) return stats
    stats[folder.type || 'binder'].add(folder.name)
    return stats
  }, { binder: new Set(), deck: new Set(), list: new Set() })
  const locationSummary = hasSourceFolders
    ? formatLocationSummary({
        binder: locationStats.binder.size,
        deck: locationStats.deck.size,
        list: locationStats.list.size,
      })
    : (folderId ? pluralize(1, destinationLabel, `${destinationLabel}s`) : '')
  const selectedDestinationFolder = hasSourceFolders
    ? null
    : folders.find(folder => folder.id === folderId) || null
  const selectedDestinationType = selectedDestinationFolder?.type || activeFolderType
  const importCardCount = reviewDesc.matchedCopies || reviewDesc.copies
  // A column identical on every row carries no information — it belongs under
  // the list, not competing with the card name for width.
  const matchedForShape = previewRows.filter(row => reviewRowIssue(row) !== REVIEW_ISSUE.MISSING)
  const uniformLocation = uniformValue(previewRows, row => row.sourceLocation)
  const uniformLocationLabel = uniformLocation
    ? `${getFolderTypeLabel(sourceFolders[uniformLocation]?.type)}: ${sourceFolders[uniformLocation]?.name || uniformLocation}`
    : null
  const allExactPrints = matchedForShape.length > 0 && matchedForShape.every(row => row.exactPrinting && !row.matchNote)
  const importButtonLabel = locationSummary
    ? `Import ${importCardCount} cards into ${locationSummary}`
    : `Import ${importCardCount} cards`
  const parseStatus = resolving
    ? {
        tone: 'busy',
        text: `Matching cards${resolveProgress.total ? ` (${resolveProgress.done}/${resolveProgress.total})` : ''}…`,
      }
    : resolveError
      ? { tone: 'error', text: resolveError }
      : resolvedRows.length
        ? reviewHeadline(reviewDesc)
        : null

  const destinationFixed = !!defaultFolderId && destinationFolders.length <= 1
  const canParse = sourceTab === 'url' ? !!url.trim() : !!text.trim()

  const resolvePreview = useCallback(async (entries) => {
    const seq = ++resolveSeq.current
    const isCurrent = () => seq === resolveSeq.current
    setResolving(true)
    setResolveError('')
    setResolvedRows([])
    setResolveProgress({ done: 0, total: 0 })
    try {
      const rows = await resolveImportEntries(entries, (done, total) => {
        if (isCurrent()) setResolveProgress({ done, total })
      })
      if (!isCurrent()) return
      setResolvedRows(rows)
    } catch (e) {
      if (!isCurrent()) return
      setResolveError(e.message || 'Could not resolve cards.')
    }
    if (isCurrent()) setResolving(false)
  }, [])

  useEffect(() => {
    if (initialText && initialEntries.length) resolvePreview(initialEntries)
    // Initial text is parsed once when the modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleTextChange = (value) => {
    setText(value)
    setResolvedRows([])
    setSourceFolders({})
    setResolveError('')
    setInputError('')
  }

  const handleParse = async () => {
    let result
    if (sourceTab === 'url') {
      if (!url.trim()) return
      setFetchingUrl(true)
      setInputError('')
      try {
        const fetched = await importDeckFromUrl(url.trim())
        result = { entries: normalizeImportedDeckCards(fetched.cards), folders: {} }
      } catch (e) {
        setInputError(e.message || 'Could not fetch that deck.')
        setFetchingUrl(false)
        return
      }
      setFetchingUrl(false)
    } else {
      result = parseImportText(text)
    }

    if (!result.entries.length) {
      // Silently doing nothing here reads as a dead button — the input almost
      // always looks plausible to the person who pasted it.
      setInputError(sourceTab === 'url'
        ? 'That link resolved, but the deck came back empty.'
        : 'No cards found. Each line needs a quantity and a name, like "4 Lightning Bolt". A CSV needs a "Name" column in its header row.')
      return
    }
    setInputError('')
    setParsed(result.entries)
    setSourceFolders(result.folders || {})
    setFolderId(defaultFolderId || '')
    setStep('preview')
    resolvePreview(result.entries)
  }

  const handleCreateFolder = async () => {
    if (!newName.trim()) return
    const { data } = await sb.from('folders')
      .insert({ name: newName.trim(), type: activeFolderType, user_id: userId })
      .select().single()
    if (data) {
      await putFolders([data])
      setFolders(prev => [...prev, data])
      setFolderId(data.id)
      setCreating(false)
      setNewName('')
    }
  }

  // `parsed` keeps the hand-picked print coordinates so a later re-resolve
  // starts from the printing the user chose, not the one they typed.
  const handleRowChange = (index, nextRow) => {
    setResolveError('')
    setParsed(prev => prev.map((row, i) => (i === index ? clearResolution(nextRow) : row)))
    setResolvedRows(prev => {
      const base = prev.length ? prev : previewRows
      return base.map((row, i) => (i === index ? nextRow : row))
    })
  }

  const beginImportProgress = useCallback((phase) => {
    setProgressPhase(phase)
    setTotal(1)
    setProgress(0)
  }, [])

  // `ensureCardPrints` reports two sequential sub-phases (lookup, then insert),
  // each restarting its batch index at 1. Naming the sub-phase is what keeps a
  // restarting bar legible — without it the fill visibly rewinds under one
  // unchanging label.
  const trackImportBatch = useCallback((phase) => ({ batchIndex, batchCount, phase: subPhase }) => {
    setProgressPhase(subPhase ? `${phase} — ${SUB_PHASE_LABELS[subPhase] || subPhase}` : phase)
    setTotal(Math.max(1, batchCount || 1))
    setProgress(batchIndex || 0)
  }, [])

  const handleImport = useCallback(async () => {
    if ((!folderId && !hasSourceFolders) || !parsed.length) return
    setStep('importing')
    setProgressPhase('Preparing import')
    setTotal(1)
    setProgress(0)

    const errs = []
    let importedCopies = 0
    let importedRows = 0
    const acquiredForWishlist = [] // {card_print_id, foil} of owned cards imported
    let skippedOwned = 0           // wishlist rows skipped because already owned

    // "Add only if not owned": drop wishlist rows whose card (by name, any
    // printing) is already in the collection. Returns the rows to keep.
    const dropOwnedWishlistRows = async (rows) => {
      if (!rows.length) return rows
      try {
        const owned = await findOwnedCardNames(userId, rows.map(r => r.name))
        if (!owned.size) return rows
        const keep = rows.filter(r => !owned.has(String(r.name || '').toLowerCase()))
        skippedOwned += rows.length - keep.length
        return keep
      } catch {
        return rows // ownership lookup failed — don't block the import
      }
    }

    try {
      setProgressPhase(resolvedRows.length ? 'Preparing matched cards' : 'Parsing data')
      const rows = resolvedRows.length ? resolvedRows : await resolveImportEntries(parsed)
      const matchedRows = rows.filter(row => row.status === 'matched' && row.sfCard)
      for (const row of rows.filter(row => row.status !== 'matched')) errs.push(missingLabel(row))
      setProgress(1)
      if (!matchedRows.length) throw new Error('No cards could be matched in Scryfall.')

      if (hasSourceFolders) {
        const folderSpecsByKey = new Map()
        for (const row of matchedRows) {
          const sourceFolder = sourceFolders[row.sourceLocation]
          if (!sourceFolder) {
            errs.push(`${row.name} - Missing source location`)
            continue
          }
          const type = sourceFolder.type || 'binder'
          folderSpecsByKey.set(`${type}|${sourceFolder.name}`, {
            name: sourceFolder.name,
            type,
          })
        }

        const folderSpecs = [...folderSpecsByKey.values()]
        const folderRowsByKey = new Map()
        if (folderSpecs.length) {
          setProgressPhase('Saving destinations')
          setTotal(1)
          setProgress(0)
          const { data: savedFolders, error: folderError } = await sb.from('folders')
            .upsert(
              folderSpecs.map(folder => ({ user_id: userId, name: folder.name, type: folder.type })),
              { onConflict: 'user_id,name,type' }
            )
            .select('*')
          if (folderError) throw folderError
          if (savedFolders?.length) {
            await putFolders(savedFolders)
            for (const folder of savedFolders) {
              folderRowsByKey.set(`${folder.type}|${folder.name}`, folder)
            }
            setFolders(prev => {
              const byKey = new Map(prev.map(folder => [`${folder.type}|${folder.name}`, folder]))
              for (const folder of savedFolders) byKey.set(`${folder.type}|${folder.name}`, folder)
              return [...byKey.values()]
            })
          }
          setProgress(1)
        }

        const getTargetFolder = (row) => {
          const sourceFolder = sourceFolders[row.sourceLocation]
          if (!sourceFolder) return null
          return folderRowsByKey.get(`${sourceFolder.type || 'binder'}|${sourceFolder.name}`) || null
        }

        const listRows = matchedRows.filter(row => getTargetFolder(row)?.type === 'list')
        const ownedRows = matchedRows.filter(row => {
          const target = getTargetFolder(row)
          return target && target.type !== 'list'
        })
        beginImportProgress('Saving print data')
        const printByScryfallId = await ensureCardPrints(
          matchedRows.map(row => row.sfCard),
          trackImportBatch('Saving print data'),
        )

        if (listRows.length) {
          const items = aggregateResolvedRows(
            listRows,
            row => {
              const target = getTargetFolder(row)
              return `${target.id}-${row.sfCard.id}-${row.foil ? 'foil' : 'normal'}`
            },
            row => {
              const target = getTargetFolder(row)
              const sf = row.sfCard
              return {
                folder_id: target.id, user_id: userId, name: sf.name, set_code: sf.set,
                collector_number: sf.collector_number, scryfall_id: sf.id,
                card_print_id: getCardPrint(printByScryfallId, {
                  set_code: sf.set,
                  collector_number: sf.collector_number,
                  scryfall_id: sf.id,
                })?.id || null,
                foil: row.foil, qty: row.qty,
              }
            }
          )
          const keepItems = await dropOwnedWishlistRows(items)
          if (keepItems.length) {
            beginImportProgress('Saving wishlist items')
            await additiveUpsertInBatches(
              'list_items',
              keepItems,
              ['folder_id', 'card_print_id', 'foil'],
              { onConflict: 'folder_id,card_print_id,foil' },
              '*',
              trackImportBatch('Saving wishlist items')
            )
            importedRows += keepItems.length
            importedCopies += keepItems.reduce((sum, item) => sum + item.qty, 0)
          }
        }

        if (ownedRows.length) {
          const cardRows = aggregateResolvedRows(
            ownedRows,
            row => `${row.sfCard.id}-${row.foil ? 'foil' : 'normal'}-${row.language || 'en'}-${row.condition || 'near_mint'}`,
            row => {
              const sf = row.sfCard
              return {
                user_id: userId, name: sf.name, set_code: sf.set,
                collector_number: sf.collector_number, scryfall_id: sf.id,
                foil: row.foil, qty: row.qty, condition: row.condition || 'near_mint',
                language: row.language || 'en', purchase_price: row.purchasePrice || 0,
              }
            }
          )
          const hydratedRows = cardRows.map(row => withCardPrint(row, getCardPrint(printByScryfallId, row)))
          for (const r of hydratedRows) if (r.card_print_id) acquiredForWishlist.push({ card_print_id: r.card_print_id, foil: !!r.foil })
          beginImportProgress('Saving owned cards')
          const upserted = await additiveUpsertInBatches(
            'cards',
            hydratedRows,
            ['user_id', 'card_print_id', 'foil', 'language', 'condition'],
            { onConflict: 'user_id,card_print_id,foil,language,condition', ignoreDuplicates: false },
            '*',
            trackImportBatch('Saving owned cards')
          )
          if (upserted?.length) {
            setProgressPhase('Updating local cache')
            await putCards(upserted)
            const cardKeyToId = {}
            for (const row of upserted) {
              cardKeyToId[`${row.card_print_id || `${row.set_code}-${row.collector_number}`}-${row.foil}-${row.language}-${row.condition}`] = row.id
            }

            const placementMap = new Map()
            for (const row of ownedRows) {
              const target = getTargetFolder(row)
              if (!target) continue
              const sf = row.sfCard
              const cardPrintId = getCardPrint(printByScryfallId, {
                set_code: sf.set,
                collector_number: sf.collector_number,
                scryfall_id: sf.id,
              })?.id || null
              const cardKey = `${cardPrintId || `${sf.set}-${sf.collector_number}`}-${row.foil}-${row.language || 'en'}-${row.condition || 'near_mint'}`
              const cardId = cardKeyToId[cardKey]
              if (!cardId) continue
              const placementKey = `${target.type}|${target.id}|${cardId}`
              const existing = placementMap.get(placementKey)
              if (existing) existing.qty += row.qty
              else {
                placementMap.set(placementKey, target.type === 'deck'
                  ? { deck_id: target.id, user_id: userId, card_id: cardId, qty: row.qty }
                  : { folder_id: target.id, card_id: cardId, qty: row.qty }
                )
              }
            }

            const deckPlacements = []
            const binderPlacements = []
            for (const [key, placement] of placementMap.entries()) {
              if (key.startsWith('deck|')) deckPlacements.push(placement)
              else binderPlacements.push(placement)
            }

            if (deckPlacements.length) {
              beginImportProgress('Saving deck placements')
              const savedDeckPlacements = await additiveUpsertInBatches(
                'deck_allocations',
                deckPlacements,
                ['deck_id', 'card_id'],
                { onConflict: 'deck_id,card_id', ignoreDuplicates: false },
                PLACEMENT_SELECTS.deck_allocations,
                trackImportBatch('Saving deck placements')
              )
              if (savedDeckPlacements?.length) await putDeckAllocations(savedDeckPlacements)
            }
            if (binderPlacements.length) {
              beginImportProgress('Saving binder placements')
              const savedBinderPlacements = await additiveUpsertInBatches(
                'folder_cards',
                binderPlacements,
                ['folder_id', 'card_id'],
                { onConflict: 'folder_id,card_id', ignoreDuplicates: false },
                PLACEMENT_SELECTS.folder_cards,
                trackImportBatch('Saving binder placements')
              )
              if (savedBinderPlacements?.length) await putFolderCards(savedBinderPlacements)
            }
            importedRows += placementMap.size
            importedCopies += [...placementMap.values()].reduce((sum, placement) => sum + placement.qty, 0)
          }
        }
      } else if (selectedDestinationType === 'list') {
        const items = aggregateResolvedRows(
          matchedRows,
          row => `${row.sfCard.id}-${row.foil ? 'foil' : 'normal'}`,
          row => {
            const sf = row.sfCard
            return {
              folder_id: folderId, user_id: userId, name: sf.name, set_code: sf.set,
              collector_number: sf.collector_number, scryfall_id: sf.id,
              foil: row.foil, qty: row.qty,
            }
          }
        )
        if (items.length) {
          beginImportProgress('Saving print data')
          const printByScryfallId = await ensureCardPrints(
            matchedRows.map(row => row.sfCard),
            trackImportBatch('Saving print data'),
          )
          const keepItems = await dropOwnedWishlistRows(items)
          const hydratedItems = keepItems.map(item => ({
            ...item,
            card_print_id: getCardPrint(printByScryfallId, item)?.id || null,
          }))
          beginImportProgress('Saving wishlist items')
          if (hydratedItems.length) {
            await additiveUpsertInBatches(
              'list_items',
              hydratedItems,
              ['folder_id', 'card_print_id', 'foil'],
              { onConflict: 'folder_id,card_print_id,foil' },
              '*',
              trackImportBatch('Saving wishlist items')
            )
          }
          importedRows = keepItems.length
          importedCopies = keepItems.reduce((sum, item) => sum + item.qty, 0)
        }
      } else {
        const cardRows = aggregateResolvedRows(
          matchedRows,
          row => `${row.sfCard.id}-${row.foil ? 'foil' : 'normal'}-${row.language || 'en'}-${row.condition || 'near_mint'}`,
          row => {
            const sf = row.sfCard
            return {
              user_id: userId, name: sf.name, set_code: sf.set,
              collector_number: sf.collector_number, scryfall_id: sf.id,
              foil: row.foil, qty: row.qty, condition: row.condition || 'near_mint',
              language: row.language || 'en', purchase_price: row.purchasePrice || 0,
            }
          }
        )
        if (cardRows.length) {
          beginImportProgress('Saving print data')
          const printByScryfallId = await ensureCardPrints(
            matchedRows.map(row => row.sfCard),
            trackImportBatch('Saving print data'),
          )
          const hydratedRows = cardRows.map(row => withCardPrint(row, getCardPrint(printByScryfallId, row)))
          for (const r of hydratedRows) if (r.card_print_id) acquiredForWishlist.push({ card_print_id: r.card_print_id, foil: !!r.foil })
          beginImportProgress('Saving owned cards')
          const upserted = await additiveUpsertInBatches(
            'cards',
            hydratedRows,
            ['user_id', 'card_print_id', 'foil', 'language', 'condition'],
            { onConflict: 'user_id,card_print_id,foil,language,condition', ignoreDuplicates: false },
            '*',
            trackImportBatch('Saving owned cards')
          )
          if (upserted) {
            setProgressPhase('Updating local cache')
            await putCards(upserted)
            const cardKeyToId = {}
            for (const row of upserted) {
              cardKeyToId[`${row.card_print_id || `${row.set_code}-${row.collector_number}`}-${row.foil}-${row.language}-${row.condition}`] = row.id
            }
            const placementRows = []
            const savingDeckPlacements = selectedDestinationType === 'deck'
            for (const row of hydratedRows) {
              const cardKey = `${row.card_print_id || `${row.set_code}-${row.collector_number}`}-${row.foil}-${row.language}-${row.condition}`
              const cardId = cardKeyToId[cardKey]
              if (!cardId) continue
              placementRows.push(
                savingDeckPlacements
                  ? { deck_id: folderId, user_id: userId, card_id: cardId, qty: row.qty }
                  : { folder_id: folderId, card_id: cardId, qty: row.qty }
              )
              importedRows++
              importedCopies += row.qty
            }
            if (placementRows.length) {
              beginImportProgress(savingDeckPlacements ? 'Saving deck placements' : 'Saving binder placements')
              const savedPlacements = await additiveUpsertInBatches(
                savingDeckPlacements ? 'deck_allocations' : 'folder_cards',
                placementRows,
                savingDeckPlacements ? ['deck_id', 'card_id'] : ['folder_id', 'card_id'],
                { onConflict: `${savingDeckPlacements ? 'deck_id' : 'folder_id'},card_id`, ignoreDuplicates: false },
                savingDeckPlacements ? PLACEMENT_SELECTS.deck_allocations : PLACEMENT_SELECTS.folder_cards,
                trackImportBatch(savingDeckPlacements ? 'Saving deck placements' : 'Saving binder placements')
              )
              if (savedPlacements?.length) {
                if (savingDeckPlacements) await putDeckAllocations(savedPlacements)
                else await putFolderCards(savedPlacements)
              }
            }
          }
        }
      }
    } catch (e) {
      errs.push(`Import error: ${e.message}`)
    }

    // Auto-remove fulfilled wants from wishlists (exact print + foil).
    if (acquiredForWishlist.length) {
      removeAcquiredFromWishlists(userId, acquiredForWishlist)
        .then(({ removedIds }) => {
          if (removedIds.length) window.dispatchEvent(new CustomEvent('av:wishlist-updated'))
        })
        .catch(err => console.warn('[wishlist] auto-remove failed:', err?.message || err))
    }

    setMissed(errs)
    setImported(importedCopies || importedRows)
    setSkippedOwnedCount(skippedOwned)
    setStep('done')
  }, [folderId, parsed, resolvedRows, selectedDestinationType, userId, hasSourceFolders, sourceFolders, beginImportProgress, trackImportBatch])

  // On 'done' the parent still has to invalidate its caches — dismissing there
  // used to commit the import and skip `onSaved`, leaving the collection stale
  // until a reload.
  const finishClose = useCallback(() => {
    if (step === 'done') onSaved?.(folderId)
    onClose?.()
  }, [step, folderId, onSaved, onClose])

  // Overlay clicks and Escape land here. A pasted list is expensive input —
  // often thousands of lines, sometimes with printings corrected by hand — so
  // an accidental click outside must not silently bin it.
  const requestClose = useCallback(() => {
    if (step === 'importing') return
    if (step === 'done') { finishClose(); return }
    const model = getImportDiscardModel({
      reviewing: step === 'preview',
      rowCount: previewRows.length,
      hasText: !!text.trim(),
    })
    if (!model.needsConfirm) { finishClose(); return }
    setDiscardPrompt(model)
  }, [step, previewRows.length, text, finishClose])

  const importPct = total > 0 ? Math.min(100, Math.round((progress / total) * 100)) : 0

  return (
    <>
    <Modal
      onClose={requestClose}
      // Content-driven height means the dialog resizes on every step, status
      // line and expanded row. Fixed from CSS; the body scrolls instead.
      autoHeight={false}
      className={styles.modal}
      contentClassName={styles.modalBody}
      showClose={step !== 'importing'}
      closeOnEscape={step !== 'importing'}
      closeOnOverlay={step !== 'importing'}
    >
      <div className={styles.wrap}>
        <h2 className={styles.title}>{allowTypeSelection ? 'Import Cards' : `Import to ${noun}`}</h2>

        {step === 'input' && (
          <>
            <ImportSourceStep
              sources={['text', 'file', 'url']}
              tab={sourceTab}
              onTabChange={id => { setSourceTab(id); setInputError(''); setResolveError('') }}
              text={text}
              onTextChange={handleTextChange}
              url={url}
              onUrlChange={value => { setUrl(value); setInputError('') }}
              onUrlSubmit={handleParse}
              busy={fetchingUrl}
              textPlaceholder={TEXT_PLACEHOLDER}
              textHint={
                <p className={styles.hint}>
                  One card per line, or paste a collection CSV from Manabox, Moxfield or Archidekt.<br />
                  <span className={styles.hintFormats}>
                    <code>Sol Ring</code> / <code>4 Lightning Bolt</code> / <code>4 Lightning Bolt (M10) 155</code> / <code>4 *F* Sol Ring</code>
                  </span>
                </p>
              }
              urlPlaceholder="https://archidekt.com/decks/123456/my-deck"
              urlHint={
                <p className={styles.hint}>
                  Paste a public deck link from <code>Archidekt</code> or <code>Moxfield</code>.
                  MTGGoldfish blocks automated imports — paste its decklist text instead.
                </p>
              }
            />
            {inputError && (
              <p className={`${styles.parseStatus} ${styles.parseStatus_error}`} role="alert">{inputError}</p>
            )}
            <div className={styles.inputRow}>
              <button type="button" className={BTN_PRIMARY} onClick={handleParse} disabled={!canParse || fetchingUrl}>
                {fetchingUrl ? 'Fetching…' : 'Parse'}
              </button>
            </div>
          </>
        )}

        {step === 'preview' && (
          <>
            {allowTypeSelection && !hasSourceFolders && !destinationFixed && (
              <div
                className={styles.inputTabs}
                role="tablist"
                style={{
                  '--tab-count': TYPE_OPTIONS.length,
                  '--tab-index': Math.max(0, TYPE_OPTIONS.findIndex(o => o.id === activeFolderType)),
                }}
              >
                {TYPE_OPTIONS.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    role="tab"
                    aria-selected={activeFolderType === option.id}
                    className={`${styles.inputTab} ${activeFolderType === option.id ? styles.inputTabActive : ''}`}
                    onClick={() => {
                      setActiveFolderType(option.id)
                      setFolderId('')
                      setFolderSearch('')
                      setCreating(false)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}

            {!hasSourceFolders && !destinationFixed && (
              !creating ? (
                <div className={styles.pickerRow}>
                  <ResponsiveMenu
                    title={`Select ${noun}`}
                    align="left"
                    wrapClassName={styles.folderCombo}
                    portal
                    onOpenChange={(open) => { if (!open) setFolderSearch('') }}
                    trigger={({ open, toggle }) => (
                      <button type="button" className={styles.folderComboBtn} onClick={toggle}>
                        <span className={!folderId ? styles.folderComboBtnPlaceholder : ''}>
                          {selectedFolderName || `Choose ${noun.toLowerCase()}...`}
                        </span>
                        <span className={styles.folderComboArrow}>
                          {open ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
                        </span>
                      </button>
                    )}
                  >
                    {({ close }) => (
                      <>
                        <input
                          autoFocus
                          className={styles.folderDropSearch}
                          value={folderSearch}
                          onChange={e => setFolderSearch(e.target.value)}
                          placeholder={`Search ${noun.toLowerCase()}s...`}
                          onMouseDown={e => e.stopPropagation()}
                        />
                        <div className={uiStyles.responsiveMenuList}>
                          {filteredFolders.length > 0
                            ? filteredFolders.map(folder => (
                                <button
                                  key={folder.id}
                                  className={`${uiStyles.responsiveMenuAction} ${folderId === folder.id ? uiStyles.responsiveMenuActionActive : ''}`}
                                  onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
                                  onClick={e => { e.preventDefault(); e.stopPropagation(); setFolderId(folder.id); setFolderSearch(''); close() }}
                                >{folder.name}</button>
                              ))
                            : <div className={styles.folderDropEmpty}>
                                {folderSearch
                                  ? `No ${noun.toLowerCase()}s match "${folderSearch}"`
                                  : `No ${noun.toLowerCase()}s yet`}
                              </div>
                          }
                        </div>
                      </>
                    )}
                  </ResponsiveMenu>
                  <button type="button" className={BTN_PRIMARY} onClick={() => setCreating(true)}>
                    + New
                  </button>
                </div>
              ) : (
                <div className={styles.pickerRow}>
                  <input
                    autoFocus
                    className={styles.newInput}
                    placeholder={`${noun} name...`}
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setCreating(false) }}
                  />
                  <button type="button" className={BTN_PRIMARY} onClick={handleCreateFolder} disabled={!newName.trim()}>Create</button>
                  <button type="button" className={BTN_SECONDARY} onClick={() => setCreating(false)}>Cancel</button>
                </div>
              )
            )}

            <ImportReviewList
              rows={previewRows}
              status={parseStatus}
              pageSize={PAGE_SIZE}
              footnoteParts={[
                hasSourceFolders ? `from ${locationSummary || 'the file'}` : null,
                uniformLocationLabel,
                allExactPrints ? 'exact prints' : null,
              ]}
              renderRowTags={row => (row.sourceLocation && !uniformLocation) ? (
                <span className={styles.rowTagLocation}>
                  {sourceFolders[row.sourceLocation]?.type ? `${getFolderTypeLabel(sourceFolders[row.sourceLocation].type)}: ` : ''}
                  {sourceFolders[row.sourceLocation]?.name || row.sourceLocation}
                </span>
              ) : null}
              onRowChange={handleRowChange}
              editDisabled={resolving}
              editDisabledTitle="Available once matching finishes"
            />

            <div className={styles.actionRow}>
              <button type="button" className={BTN_SECONDARY} onClick={() => setStep('input')}>Back</button>
              <button type="button" className={BTN_PRIMARY} onClick={handleImport} disabled={!canImport || resolving}>
                {importButtonLabel}
              </button>
            </div>
          </>
        )}

        {step === 'importing' && (
          <div className={styles.progressWrap}>
            <div className={styles.progressLabel}>
              <strong>{progressPhase || 'Importing'}</strong>
              <span>{importPct}%</span>
            </div>
            <div
              className={styles.progressBar}
              role="progressbar"
              aria-valuenow={importPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={progressPhase || 'Importing'}
            >
              <div className={styles.progressFill} style={{ width: `${importPct}%` }} />
            </div>
            <p className={styles.progressNote}>Keep this open until the import finishes.</p>
          </div>
        )}

        {step === 'done' && (
          <>
            <p className={styles.doneMsg}>
              {imported > 0
                ? <span className={styles.success}>{imported} card{imported === 1 ? '' : 's'} imported successfully.</span>
                : <span className={styles.doneMuted}>No cards were imported.</span>
              }
            </p>
            {skippedOwnedCount > 0 && (
              <p className={styles.hint}>
                Skipped {skippedOwnedCount} card{skippedOwnedCount === 1 ? '' : 's'} already in your collection.
              </p>
            )}
            {missed.length > 0 && (
              <>
                <p className={styles.hint}>{missed.length} issue{missed.length > 1 ? 's' : ''} found during import:</p>
                <div className={styles.missedList}>
                  {missed.map((name, index) => <div key={index} className={styles.missedItem}>{name}</div>)}
                </div>
              </>
            )}
            <div className={styles.actionRow}>
              <button type="button" className={BTN_PRIMARY} onClick={finishClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </Modal>

    {/* Sits on top of this component's own <Modal>. Modal keeps a stack so
        Escape only reaches the topmost one — see UI.jsx. */}
    {discardPrompt && (
      <ConfirmModal
        title={null}
        message={discardPrompt.message}
        cancelLabel={discardPrompt.keepLabel}
        confirmLabel={discardPrompt.discardLabel}
        variant={discardPrompt.discardVariant}
        onConfirm={() => { setDiscardPrompt(null); finishClose() }}
        onClose={() => setDiscardPrompt(null)}
      />
    )}
    </>
  )
}
