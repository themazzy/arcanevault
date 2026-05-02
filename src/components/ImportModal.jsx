import { Fragment, useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { Modal, ResponsiveMenu } from './UI'
import { importDeckFromUrl } from '../lib/deckBuilderApi'
import {
  aggregateResolvedRows,
  fetchPaperPrintings,
  normalizeImportedDeckCards,
  parseImportText,
  resolveImportEntries,
  summarizeImportRows,
} from '../lib/importFlow'
import { ensureCardPrints, getCardPrint, withCardPrint } from '../lib/cardPrints'
import { putCards, putDeckAllocations, putFolderCards, putFolders } from '../lib/db'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CloseIcon } from '../icons'
import styles from './ImportModal.module.css'
import uiStyles from './UI.module.css'

const NOUN = { binder: 'Binder', deck: 'Deck', list: 'Wishlist' }
const TYPE_OPTIONS = [
  { id: 'binder', label: 'Binder' },
  { id: 'deck', label: 'Deck' },
  { id: 'list', label: 'Wishlist' },
]
const PAGE_SIZE = 100
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

async function upsertInBatches(table, rows, options, selectColumns = '*', onBatchDone) {
  const saved = []
  const batches = chunkRows(rows)
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i].map(row => {
      if (row?.id != null) return row
      const { id, ...rest } = row
      return rest
    })
    const rowsWithId = batch.filter(row => row.id != null)
    const rowsWithoutId = batch.filter(row => row.id == null)
    for (const subBatch of [rowsWithId, rowsWithoutId]) {
      if (!subBatch.length) continue
      const { data, error } = await sb.from(table)
        .upsert(subBatch, options)
        .select(selectColumns)
      if (error) throw error
      if (data?.length) saved.push(...data)
    }
    onBatchDone?.({ batchIndex: i + 1, batchCount: batches.length, rowsDone: Math.min((i + 1) * IMPORT_WRITE_BATCH, rows.length), rowCount: rows.length })
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
            const { id, ...rest } = row
            return rest
          })()
    })

    const batchSaved = await upsertInBatches(table, rowsToSave, options, selectColumns)
    if (batchSaved?.length) saved.push(...batchSaved)
    onBatchDone?.({ batchIndex: i + 1, batchCount: batches.length, rowsDone: Math.min((i + 1) * IMPORT_WRITE_BATCH, rows.length), rowCount: rows.length })
  }

  return saved
}

function formatSet(row) {
  const setCode = row.resolvedSetCode || row.setCode
  const collectorNumber = row.resolvedCollectorNumber || row.collectorNumber
  if (!setCode) return ''
  return `${setCode.toUpperCase()}${collectorNumber ? ` ${collectorNumber}` : ''}`
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
  const [importUrl, setImportUrl] = useState('')
  const [urlLoading, setUrlLoading] = useState(false)
  const [urlError, setUrlError] = useState('')
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
  const [editingIndex, setEditingIndex] = useState(null)
  const [editPrintings, setEditPrintings] = useState([])
  const [editPrintingsLoading, setEditPrintingsLoading] = useState(false)
  const [editSelectedPrinting, setEditSelectedPrinting] = useState(null)
  const [editFoil, setEditFoil] = useState(false)
  const [previewPage, setPreviewPage] = useState(0)
  const [previewPageEditing, setPreviewPageEditing] = useState(false)
  const [previewPageInput, setPreviewPageInput] = useState('')
  const fileRef = useRef(null)

  const previewRows = resolvedRows.length ? resolvedRows : parsed
  const previewSummary = summarizeImportRows(previewRows)
  const hasSourceFolders = Object.keys(sourceFolders || {}).length > 0
  const destinationFolders = hasSourceFolders
    ? folders.filter(folder => !isGroupFolder(folder))
    : folders.filter(f => f.type === activeFolderType && !isGroupFolder(f))
  const selectedFolderName = destinationFolders.find(f => f.id === folderId)?.name || ''
  const destinationCount = hasSourceFolders
    ? new Set(previewRows.map(row => row.sourceLocation).filter(location => sourceFolders[location])).size
    : (folderId ? 1 : 0)
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
  const importCardCount = previewSummary.matchedCopies || previewSummary.totalCopies
  const importButtonLabel = locationSummary
    ? `Import ${importCardCount} cards into ${locationSummary}`
    : `Import ${importCardCount} cards`
  const parseStatus = resolving
    ? {
        tone: 'busy',
        text: `Parsing data${resolveProgress.total ? ` (${resolveProgress.done}/${resolveProgress.total})` : ''}...`,
      }
    : resolveError
      ? { tone: 'error', text: resolveError }
      : resolvedRows.length
        ? {
            tone: previewSummary.missingRows ? 'error' : 'success',
            text: previewSummary.missingRows
              ? `Parsing finished with ${previewSummary.missingRows} unresolved row${previewSummary.missingRows === 1 ? '' : 's'}.`
              : `Parsing complete: ${previewSummary.matchedCopies} card${previewSummary.matchedCopies === 1 ? '' : 's'} matched.`,
          }
        : null
  const previewPageCount = Math.max(1, Math.ceil(previewRows.length / PAGE_SIZE))
  const safePreviewPage = Math.min(previewPage, previewPageCount - 1)
  const previewStart = safePreviewPage * PAGE_SIZE
  const previewSlice = previewRows.slice(previewStart, previewStart + PAGE_SIZE)

  const destinationFixed = !!defaultFolderId && destinationFolders.length <= 1

  const startPreviewPageEdit = () => {
    setPreviewPageInput(String(safePreviewPage + 1))
    setPreviewPageEditing(true)
  }

  const applyPreviewPageInput = () => {
    const nextPage = Number.parseInt(previewPageInput, 10)
    if (Number.isFinite(nextPage)) {
      setPreviewPage(Math.max(0, Math.min(previewPageCount - 1, nextPage - 1)))
    }
    setPreviewPageEditing(false)
  }

  const resolvePreview = useCallback(async (entries) => {
    setResolving(true)
    setResolveError('')
    setResolvedRows([])
    setResolveProgress({ done: 0, total: 0 })
    try {
      const rows = await resolveImportEntries(entries, (done, total) => setResolveProgress({ done, total }))
      setResolvedRows(rows)
    } catch (e) {
      setResolveError(e.message || 'Could not resolve cards.')
    }
    setResolving(false)
  }, [])

  useEffect(() => {
    if (initialText && initialEntries.length) resolvePreview(initialEntries)
    // Initial text is parsed once when the modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      setText(ev.target.result)
      setResolvedRows([])
      setSourceFolders({})
      setResolveError('')
      setPreviewPage(0)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleParse = () => {
    const result = parseImportText(text)
    if (!result.entries.length) return
    setParsed(result.entries)
    setSourceFolders(result.folders || {})
    setFolderId(defaultFolderId || '')
    setPreviewPage(0)
    setStep('preview')
    resolvePreview(result.entries)
  }

  const handleUrlFetch = async () => {
    if (!importUrl.trim()) return
    setUrlLoading(true)
    setUrlError('')
    try {
      const result = await importDeckFromUrl(importUrl.trim())
      const converted = normalizeImportedDeckCards(result.cards)
      if (!converted.length) throw new Error('No cards found in the deck.')
      setParsed(converted)
      setSourceFolders({})
      setPreviewPage(0)
      setStep('preview')
      resolvePreview(converted)
    } catch (e) {
      setUrlError(e.message)
    }
    setUrlLoading(false)
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

  const editHasFoil = !!(
    editSelectedPrinting?.finishes?.includes('foil') ||
    editSelectedPrinting?.finishes?.includes('etched') ||
    editSelectedPrinting?.prices?.eur_foil ||
    editSelectedPrinting?.prices?.usd_foil
  )

  const getPrintingImage = (printing) =>
    printing?.image_uris?.small || printing?.card_faces?.[0]?.image_uris?.small || null

  const handleStartEdit = async (row, index) => {
    setEditingIndex(index)
    setEditPrintings([])
    setEditSelectedPrinting(row.sfCard || null)
    setEditFoil(!!row.foil)
    setEditPrintingsLoading(true)
    setResolveError('')
    try {
      const printings = await fetchPaperPrintings(row.resolvedName || row.name)
      const selected = printings.find(printing => printing.id === row.sfCard?.id)
        || printings.find(printing => printing.set === (row.resolvedSetCode || row.setCode) && printing.collector_number === (row.resolvedCollectorNumber || row.collectorNumber))
        || row.sfCard
        || printings[0]
        || null
      setEditPrintings(printings)
      setEditSelectedPrinting(selected)
      const selectedHasFoil = !!(
        selected?.finishes?.includes('foil') ||
        selected?.finishes?.includes('etched') ||
        selected?.prices?.eur_foil ||
        selected?.prices?.usd_foil
      )
      setEditFoil(!!row.foil && selectedHasFoil)
    } catch (e) {
      setResolveError(e.message || 'Could not load printings.')
    }
    setEditPrintingsLoading(false)
  }

  const handleCancelEdit = () => {
    setEditingIndex(null)
    setEditPrintings([])
    setEditSelectedPrinting(null)
    setEditFoil(false)
  }

  const handleApplyEdit = async (index) => {
    const current = previewRows[index]
    if (!current || !editSelectedPrinting) return
    const selectedHasFoil = !!(
      editSelectedPrinting.finishes?.includes('foil') ||
      editSelectedPrinting.finishes?.includes('etched') ||
      editSelectedPrinting.prices?.eur_foil ||
      editSelectedPrinting.prices?.usd_foil
    )

    const nextEntry = {
      ...current,
      setCode: editSelectedPrinting.set || null,
      collectorNumber: editSelectedPrinting.collector_number || null,
      foil: !!editFoil && selectedHasFoil,
      sfCard: undefined,
      status: undefined,
      reason: undefined,
      resolvedName: undefined,
      resolvedSetCode: undefined,
      resolvedCollectorNumber: undefined,
      exactPrinting: undefined,
    }

    setResolving(true)
    setResolveError('')
    try {
      const resolved = {
        ...nextEntry,
        sfCard: editSelectedPrinting,
        resolvedName: editSelectedPrinting.name || nextEntry.name,
        resolvedSetCode: editSelectedPrinting.set || nextEntry.setCode || null,
        resolvedCollectorNumber: editSelectedPrinting.collector_number || nextEntry.collectorNumber || null,
        exactPrinting: true,
        status: 'matched',
        reason: null,
      }
      setParsed(prev => prev.map((row, rowIndex) => rowIndex === index ? nextEntry : row))
      setResolvedRows(prev => {
        const base = prev.length ? prev : previewRows
        return base.map((row, rowIndex) => rowIndex === index ? resolved : row)
      })
      handleCancelEdit()
    } catch (e) {
      setResolveError(e.message || 'Could not apply edited printing.')
    }
    setResolving(false)
  }

  const beginImportProgress = useCallback((phase, rowCount) => {
    setProgressPhase(phase)
    setTotal(Math.max(1, Math.ceil((rowCount || 0) / IMPORT_WRITE_BATCH)))
    setProgress(0)
  }, [])

  const trackImportBatch = useCallback((phase) => ({ batchIndex, batchCount }) => {
    setProgressPhase(phase)
    setTotal(batchCount)
    setProgress(batchIndex)
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
        beginImportProgress('Saving print data', matchedRows.length)
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
          if (items.length) {
            beginImportProgress('Saving wishlist items', items.length)
            await additiveUpsertInBatches(
              'list_items',
              items,
              ['folder_id', 'card_print_id', 'foil'],
              { onConflict: 'folder_id,card_print_id,foil' },
              '*',
              trackImportBatch('Saving wishlist items')
            )
            importedRows += items.length
            importedCopies += items.reduce((sum, item) => sum + item.qty, 0)
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
          beginImportProgress('Saving owned cards', hydratedRows.length)
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
              beginImportProgress('Saving deck placements', deckPlacements.length)
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
              beginImportProgress('Saving binder placements', binderPlacements.length)
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
          beginImportProgress('Saving print data', matchedRows.length)
          const printByScryfallId = await ensureCardPrints(
            matchedRows.map(row => row.sfCard),
            trackImportBatch('Saving print data'),
          )
          const hydratedItems = items.map(item => ({
            ...item,
            card_print_id: getCardPrint(printByScryfallId, item)?.id || null,
          }))
          beginImportProgress('Saving wishlist items', hydratedItems.length)
          await additiveUpsertInBatches(
            'list_items',
            hydratedItems,
            ['folder_id', 'card_print_id', 'foil'],
            { onConflict: 'folder_id,card_print_id,foil' },
            '*',
            trackImportBatch('Saving wishlist items')
          )
          importedRows = items.length
          importedCopies = items.reduce((sum, item) => sum + item.qty, 0)
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
          beginImportProgress('Saving print data', matchedRows.length)
          const printByScryfallId = await ensureCardPrints(
            matchedRows.map(row => row.sfCard),
            trackImportBatch('Saving print data'),
          )
          const hydratedRows = cardRows.map(row => withCardPrint(row, getCardPrint(printByScryfallId, row)))
          beginImportProgress('Saving owned cards', hydratedRows.length)
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
              beginImportProgress(savingDeckPlacements ? 'Saving deck placements' : 'Saving binder placements', placementRows.length)
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

    setMissed(errs)
    setImported(importedCopies || importedRows)
    setStep('done')
  }, [folderId, parsed, resolvedRows, activeFolderType, selectedDestinationType, userId, hasSourceFolders, sourceFolders, beginImportProgress, trackImportBatch])

  return (
    <Modal onClose={onClose}>
      <div className={styles.wrap}>
        <h2 className={styles.title}>{allowTypeSelection ? 'Import Cards' : `Import to ${noun}`}</h2>

        {step === 'input' && (
          <>
            {/*
              URL import is disabled until production has a server-side proxy.
              Keep handleUrlFetch and URL state here so the shared flow can be reused
              once Archidekt, Moxfield, and MTGGoldfish are supported outside dev.
            */}

            <p className={styles.hint}>
              Paste a decklist or collection CSV (Manabox, Moxfield, Archidekt), or upload a <em>.csv</em> / <em>.txt</em> file.<br />
              <span className={styles.hintFormats}>
                Supported: <code>4 Lightning Bolt</code> / <code>4 Lightning Bolt (M10) 155</code> / <code>4 *F* Sol Ring</code>
              </span>
            </p>
            <textarea
              className={styles.textarea}
              placeholder={'4 Forest\n1 Sol Ring\n4 Lightning Bolt (M10) 155\n// comments are ignored'}
              value={text}
              onChange={e => {
                setText(e.target.value)
                setResolvedRows([])
                setSourceFolders({})
                setResolveError('')
                setPreviewPage(0)
              }}
              rows={10}
              autoFocus
            />
            <div className={styles.inputRow}>
              <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={handleFile} />
              <button className={styles.fileBtn} onClick={() => fileRef.current?.click()}>
                Upload file
              </button>
              <button className={styles.parseBtn} onClick={handleParse} disabled={!text.trim()}>
                Parse
              </button>
            </div>
          </>
        )}

        {step === 'preview' && (
          <>
            {allowTypeSelection && !hasSourceFolders && !destinationFixed && (
              <div className={styles.inputTabs}>
                {TYPE_OPTIONS.map(option => (
                  <button
                    key={option.id}
                    type="button"
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
                  <button className={styles.createBtn} onClick={() => setCreating(true)}>
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
                  <button className={styles.parseBtn} onClick={handleCreateFolder} disabled={!newName.trim()}>Create</button>
                  <button className={styles.fileBtn} onClick={() => setCreating(false)}>Cancel</button>
                </div>
              )
            )}

            <div className={styles.summaryGrid}>
              <div className={styles.summaryItem}><strong>{previewSummary.totalCopies}</strong><span>Total copies</span></div>
              <div className={styles.summaryItem}><strong>{previewSummary.uniqueNames}</strong><span>Unique cards</span></div>
              <div className={styles.summaryItem}>
                <strong>{destinationCount}</strong>
                <span>{hasSourceFolders ? 'Source destinations' : `Importing to ${destinationCount} ${destinationCount === 1 ? destinationLabel : `${destinationLabel}s`}`}</span>
              </div>
              <div className={previewSummary.missingRows ? styles.summaryWarn : styles.summaryItem}>
                <strong>{previewSummary.missingRows}</strong><span>Unresolved rows</span>
              </div>
            </div>

            {previewSummary.sourceLocations.length > 0 && (
              <p className={styles.hint}>
                Source locations: {previewSummary.sourceLocations.length} location{previewSummary.sourceLocations.length === 1 ? '' : 's'} from CSV
              </p>
            )}
            {parseStatus && (
              <p className={`${styles.parseStatus} ${styles[`parseStatus_${parseStatus.tone}`]}`}>
                {parseStatus.text}
              </p>
            )}

            {previewRows.length > PAGE_SIZE && (
              <div className={styles.previewPager}>
                <button
                  type="button"
                  className={styles.fileBtn}
                  onClick={() => setPreviewPage(page => Math.max(0, page - 1))}
                  disabled={safePreviewPage === 0}
                >
                  Previous
                </button>
                <div className={styles.previewPageStatus}>
                  <span>Page</span>
                  {previewPageEditing ? (
                    <input
                      className={styles.previewPageInput}
                      value={previewPageInput}
                      onChange={e => setPreviewPageInput(e.target.value.replace(/\D/g, ''))}
                      onBlur={applyPreviewPageInput}
                      onKeyDown={e => {
                        if (e.key === 'Enter') applyPreviewPageInput()
                        if (e.key === 'Escape') setPreviewPageEditing(false)
                      }}
                      inputMode="numeric"
                      autoFocus
                    />
                  ) : (
                    <button type="button" className={styles.previewPageNumber} onClick={startPreviewPageEdit}>
                      {safePreviewPage + 1}
                    </button>
                  )}
                  <span>of {previewPageCount}</span>
                  <span className={styles.previewPageRange}>
                    {previewStart + 1}-{Math.min(previewStart + PAGE_SIZE, previewRows.length)} of {previewRows.length}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.fileBtn}
                  onClick={() => setPreviewPage(page => Math.min(previewPageCount - 1, page + 1))}
                  disabled={safePreviewPage >= previewPageCount - 1}
                >
                  Next
                </button>
              </div>
            )}

            <div className={styles.previewList}>
              {previewSlice.map((row, pageIndex) => {
                const index = previewStart + pageIndex
                return (
                <Fragment key={`${row.name}-${index}`}>
                  <div className={`${styles.previewRow} ${row.status === 'missing' ? styles.previewRowMissing : ''}`}>
                    <span className={styles.previewQty}>
                      {row.status === 'missing'
                        ? <CloseIcon size={12} className={`${styles.previewStatusIcon} ${styles.previewStatusIconMissing}`} />
                        : row.status === 'matched'
                          ? <CheckIcon size={12} className={`${styles.previewStatusIcon} ${styles.previewStatusIconMatched}`} />
                          : null
                      }
                      <span>x{row.qty}</span>
                    </span>
                    <span className={styles.previewName}>
                      <span className={styles.previewNameText}>{row.resolvedName || row.name}</span>
                      {row.foil && <span className={styles.previewFoil}>Foil</span>}
                    </span>
                    {formatSet(row) && <span className={styles.previewSet}>{formatSet(row)}</span>}
                    {row.sourceLocation && (
                      <span className={styles.previewLocation}>
                        {sourceFolders[row.sourceLocation]?.type ? `${getFolderTypeLabel(sourceFolders[row.sourceLocation].type)}: ` : ''}{row.sourceLocation}
                      </span>
                    )}
                    {row.status === 'missing' && <span className={styles.previewMissing}>missing</span>}
                    <button type="button" className={styles.previewEditBtn} onClick={() => handleStartEdit(row, index)}>
                      Edit
                    </button>
                  </div>
                  {editingIndex === index && (
                    <div className={styles.editPanel}>
                      <div className={styles.editHeader}>
                        <span>Choose printing</span>
                        <div className={styles.editActions}>
                          <button type="button" className={styles.fileBtn} onClick={handleCancelEdit}>Cancel</button>
                          <button type="button" className={styles.parseBtn} onClick={() => handleApplyEdit(index)} disabled={resolving || !editSelectedPrinting}>
                            Apply
                          </button>
                        </div>
                      </div>
                      {editPrintingsLoading ? (
                        <div className={styles.editLoading}>Loading printings...</div>
                      ) : (
                        <div className={styles.printingGrid}>
                          {editPrintings.map(printing => {
                            const image = getPrintingImage(printing)
                            return (
                              <button
                                key={printing.id}
                                type="button"
                                className={`${styles.printingCard} ${editSelectedPrinting?.id === printing.id ? styles.printingCardActive : ''}`}
                                onClick={() => {
                                  setEditSelectedPrinting(printing)
                                  const hasFoil = !!(
                                    printing.finishes?.includes('foil') ||
                                    printing.finishes?.includes('etched') ||
                                    printing.prices?.eur_foil ||
                                    printing.prices?.usd_foil
                                  )
                                  if (!hasFoil) setEditFoil(false)
                                }}
                                title={`${printing.set_name || printing.set} ${printing.collector_number}`}
                              >
                                {image
                                  ? <img src={image} alt={printing.name} className={styles.printingImage} loading="lazy" />
                                  : <div className={styles.printingImageEmpty} />
                                }
                                <span className={styles.printingSet}>{printing.set?.toUpperCase()}</span>
                                <span className={styles.printingMeta}>#{printing.collector_number}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                      <div className={styles.editBottom}>
                        <button
                          type="button"
                          className={`${styles.foilSwitch} ${editFoil ? styles.foilSwitchOn : ''}`}
                          onClick={() => editHasFoil && setEditFoil(value => !value)}
                          disabled={!editHasFoil}
                          aria-pressed={editFoil}
                        >
                          <span className={styles.foilSwitchText}>Foil</span>
                          <span className={styles.foilSwitchTrack}>
                            <span className={styles.foilSwitchKnob} />
                          </span>
                        </button>
                        {!editHasFoil && <span className={styles.noFoilText}>No foil version for this printing</span>}
                      </div>
                    </div>
                  )}
                </Fragment>
              )})}
            </div>

            <div className={styles.actionRow}>
              <button className={styles.fileBtn} onClick={() => setStep('input')}>Back</button>
              <button className={styles.parseBtn} onClick={handleImport} disabled={!canImport || resolving}>
                {importButtonLabel}
              </button>
            </div>
          </>
        )}

        {step === 'importing' && (
          <div className={styles.progressWrap}>
            <div className={styles.progressLabel}>
              <strong>{progressPhase || 'Importing'}</strong>
              <span>{progress} / {total}</span>
            </div>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{ width: total ? `${(progress / total) * 100}%` : '0%' }} />
            </div>
          </div>
        )}

        {step === 'done' && (
          <>
            <p className={styles.doneMsg}>
              {imported > 0
                ? <span className={styles.success}>{imported} card{imported === 1 ? '' : 's'} imported successfully.</span>
                : <span style={{ color: 'var(--text-dim)' }}>No cards were imported.</span>
              }
            </p>
            {missed.length > 0 && (
              <>
                <p className={styles.hint}>{missed.length} issue{missed.length > 1 ? 's' : ''} found during import:</p>
                <div className={styles.missedList}>
                  {missed.map((name, index) => <div key={index} className={styles.missedItem}>{name}</div>)}
                </div>
              </>
            )}
            <div className={styles.actionRow}>
              <button className={styles.parseBtn} onClick={() => { onSaved?.(folderId); onClose() }}>Done</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
