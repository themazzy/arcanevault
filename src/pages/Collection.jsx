import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { getScryfallKey, getPrice, formatPrice, getInstantCache } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { getLocalCards, putCards, deleteCard, deleteAllCards, getAllLocalFolderCards, putFolderCards, getLocalFolders, putFolders, setMeta, getMeta, deleteFolder as deleteLocalFolder, replaceLocalFolderCards, getAllDeckAllocationsForUser, putDeckAllocations, replaceDeckAllocations } from '../lib/db'
import { parseManaboxCSV } from '../lib/csvParser'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { CardDetail, FilterBar, BulkActionBar, EMPTY_FILTERS } from '../components/CardComponents'
import VirtualCardGrid from '../components/VirtualCardGrid'
import { CardBrowserViewControls, CardBrowserContent } from '../components/CardBrowserViews'
import { DropZone, ProgressBar, ErrorBox, EmptyState, SectionHeader, Button } from '../components/UI'
import AddCardModal from '../components/AddCardModal'
import ExportModal from '../components/ExportModal'
import ImportModal from '../components/ImportModal'
import styles from './Collection.module.css'
import { pruneUnplacedCards } from '../lib/collectionOwnership'

const DEBOUNCE_MS = 300
const FOLDER_CARDS_FULL_SYNC_MS = 10 * 60 * 1000
const FOLDER_CARDS_DELTA_OVERLAP_MS = 30 * 1000
const LOCAL_COLLECTION_FRESH_MS = 5 * 60 * 1000

const worker = new Worker(new URL('../lib/filterWorker.js', import.meta.url), { type: 'module' })

export default function CollectionPage() {
  const { user } = useAuth()
  const { price_source, default_sort, grid_density, show_price, cache_ttl_h, loaded: settingsLoaded } = useSettings()

  const ttlMsRef = useRef(cache_ttl_h * 3600000)
  useEffect(() => { ttlMsRef.current = cache_ttl_h * 3600000 }, [cache_ttl_h])

  const [sfMap, setSfMap]   = useState({})
  const [cards, setCards]   = useState([])
  const [filtered, setFiltered] = useState([])
  const [loading, setLoading]   = useState(true)
  const [enriching, setEnriching] = useState(false)
  const [progress, setProgress]   = useState(0)
  const [progLabel, setProgLabel] = useState('')
  const [error, setError]         = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch]           = useState('')
  const [sort, setSort]     = useState(default_sort || 'name')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [detailCardKey, setDetailCardKey] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [importModalText, setImportModalText] = useState('')
  const [importing, setImporting] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [splitState, setSplitState] = useState(new Map())
  const [folders, setFolders] = useState([])
  const [cardFolderMap, setCardFolderMap] = useState({})
  const [folderMembershipLoading, setFolderMembershipLoading] = useState(true)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [viewMode, setViewMode] = useState('grid')
  const [groupBy, setGroupBy]   = useState('none')
  useEffect(() => { setSelected(new Set()); setSplitState(new Map()); setSelectMode(false) }, [viewMode])
  const workerReqId  = useRef(0)
  const enrichingRef = useRef(false)

  useEffect(() => {
    if (settingsLoaded) setSort(default_sort || 'name')
  }, [settingsLoaded])

  // Track online status
  useEffect(() => {
    const on  = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online',  on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // ── Pre-fill sfMap from IDB/memory cache — avoids blank images on navigation ──
  useEffect(() => {
    getInstantCache(cache_ttl_h * 3600000).then(map => { if (map) setSfMap(map) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load cards — IDB first, Supabase sync in background ──────────────────────
  const loadCards = useCallback(async () => {
    setLoading(true)

    // 1. Read from IDB immediately — instant render even offline
    const [localCards, cardsSyncedAt] = await Promise.all([
      getLocalCards(user.id),
      getMeta(`cards_synced_${user.id}`),
    ])
    const localCardsFresh = !!cardsSyncedAt && (Date.now() - Number(cardsSyncedAt) <= LOCAL_COLLECTION_FRESH_MS)
    const canHydrateFromIdb = localCards.length && (!navigator.onLine || localCardsFresh)
    if (canHydrateFromIdb) {
      console.log(`[Collection] IDB: ${localCards.length} cards (offline-ready)`)
      setCards(localCards)
      setLoading(false)
      startEnrichment(localCards)
    }

    // 2. Sync from Supabase (skip if offline)
    if (!navigator.onLine) {
      if (!localCards.length) setLoading(false)
      return
    }

    let allCards = [], from = 0, fetchComplete = false
    const PAGE = 1000
    while (true) {
      const { data, error: err } = await sb.from('cards')
        .select('*').eq('user_id', user.id).order('name')
        .range(from, from + PAGE - 1)
      if (err) { setError(err.message); break }
      if (data?.length) allCards = [...allCards, ...data]
      if (!data || data.length < PAGE) { fetchComplete = true; break }
      from += PAGE
    }

    if (allCards.length && fetchComplete) {
      // Prune IDB entries that no longer exist in Supabase (deleted cards)
      // This prevents the brief "doubling" on refresh when IDB is stale
      if (localCards.length) {
        const sbIds = new Set(allCards.map(c => c.id))
        const orphans = localCards.filter(c => !sbIds.has(c.id))
        if (orphans.length) {
          console.log(`[Collection] Pruning ${orphans.length} orphaned IDB cards`)
          for (const c of orphans) await deleteCard(c.id)
        }
      }
      // Persist to IDB for next offline load
      await putCards(allCards)
      await setMeta(`cards_synced_${user.id}`, Date.now())
      setCards(allCards)
      if (!canHydrateFromIdb) {
        // First ever load — start enrichment now that we have cards
        startEnrichment(allCards)
      } else {
        // Check if any new cards appeared vs local
        const localIds = new Set(localCards.map(c => c.id))
        const newCards = allCards.filter(c => !localIds.has(c.id))
        if (newCards.length) {
          console.log(`[Collection] ${newCards.length} new cards synced from Supabase`)
          loadCardMapWithSharedPrices(allCards, { cacheTtlMs: ttlMsRef.current }).then(map => {
            setSfMap({ ...map })
          })
        }
      }
    }

    setLoading(false)
  }, [user.id])

  useEffect(() => { loadCards() }, [loadCards])

  // ── Load folder membership ───────────────────────────────────────────────────
  useEffect(() => {
    const loadFolderMembership = async () => {
      setFolderMembershipLoading(true)
      const buildCardFolderMap = (folderRows, linkRows) => {
        const folderById = Object.fromEntries(folderRows.map(f => [f.id, f]))
        const map = {}
        for (const row of linkRows) {
          const folderId = row.folder_id || row.deck_id
          const folder = folderById[folderId]
          if (!folder) continue
          if (!map[row.card_id]) map[row.card_id] = []
          map[row.card_id].push({ id: folder.id, name: folder.name, type: folder.type, qty: row.qty || 1 })
        }
        return map
      }

      // IDB first
      const localFolders = await getLocalFolders(user.id)
      if (localFolders.length) {
        const ids = localFolders.map(f => f.id)
        const [allFc, allDa] = await Promise.all([
          getAllLocalFolderCards(ids.filter(id => localFolders.find(f => f.id === id)?.type !== 'deck')),
          getAllDeckAllocationsForUser(user.id),
        ])
        setFolders(localFolders)
        setCardFolderMap(buildCardFolderMap(localFolders, [...allFc, ...allDa]))
      }

      if (!navigator.onLine) {
        setFolderMembershipLoading(false)
        return
      }

      // Sync folders from Supabase
      const { data: foldersData } = await sb.from('folders')
        .select('id,name,type,updated_at').eq('user_id', user.id).order('name')
      if (!foldersData?.length) {
        if (localFolders.length) {
          await Promise.all(localFolders.map(folder => deleteLocalFolder(folder.id)))
        }
        setFolders([])
        setCardFolderMap({})
        setFolderMembershipLoading(false)
        return
      }

      const remoteFolderIds = new Set(foldersData.map(f => f.id))
      const removedFolderIds = localFolders.map(f => f.id).filter(id => !remoteFolderIds.has(id))
      if (removedFolderIds.length) {
        await Promise.all(removedFolderIds.map(id => deleteLocalFolder(id)))
      }

      setFolders(foldersData)
      await putFolders(foldersData)

      const folderIds = foldersData.map(f => f.id)
      const placementFolderIds = foldersData.filter(f => f.type !== 'deck').map(f => f.id)
      const deckIds = foldersData.filter(f => f.type === 'deck').map(f => f.id)
      const fullSyncKey = `folder_cards_full_sync_${user.id}`
      const deltaSyncKey = `folder_cards_delta_sync_${user.id}`

      let allFc = [], fcFrom = 0
        while (true) {
          const { data: page } = await sb.from('folder_cards')
            .select('id,card_id,folder_id,qty,updated_at')
            .in('folder_id', placementFolderIds).range(fcFrom, fcFrom + 999)
          if (page?.length) allFc = [...allFc, ...page]
          if (!page || page.length < 1000) break
          fcFrom += 1000
        }
      let allDa = []
      if (deckIds.length) {
        let daFrom = 0
        while (true) {
          const { data: page } = await sb.from('deck_allocations')
            .select('id,card_id,deck_id,qty,user_id,updated_at')
            .eq('user_id', user.id)
            .in('deck_id', deckIds)
            .range(daFrom, daFrom + 999)
          if (page?.length) allDa = [...allDa, ...page]
          if (!page || page.length < 1000) break
          daFrom += 1000
        }
      }

      await replaceLocalFolderCards(placementFolderIds, allFc)
      await replaceDeckAllocations(deckIds, allDa)

      const syncedAt = new Date().toISOString()
      await setMeta(fullSyncKey, syncedAt)
      await setMeta(deltaSyncKey, new Date(Date.now() - FOLDER_CARDS_DELTA_OVERLAP_MS).toISOString())
      setCardFolderMap(buildCardFolderMap(foldersData, [...allFc, ...allDa]))
      setFolderMembershipLoading(false)
    }
    loadFolderMembership()
  }, [user.id])

  // ── Debounce search ──────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  // ── Web Worker filtering ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!cards.length) { setFiltered([]); return }
    const id = ++workerReqId.current
    worker.postMessage({ id, cards, sfMap, search, sort, filters, priceSource: price_source, cardFolderMap })
  }, [cards, sfMap, search, sort, filters, price_source, cardFolderMap])

  useEffect(() => {
    const handler = (e) => {
      if (e.data.id !== workerReqId.current) return
      setFiltered(e.data.result)
    }
    worker.addEventListener('message', handler)
    return () => worker.removeEventListener('message', handler)
  }, [])

  // ── Orphan cleanup — runs once per mount after both syncs complete ───────────
  const orphanCheckDone = useRef(false)
  useEffect(() => {
    if (loading || folderMembershipLoading || !isOnline || !cards.length || orphanCheckDone.current) return
    orphanCheckDone.current = true
    const orphanIds = cards.filter(c => !cardFolderMap[c.id]?.length).map(c => c.id)
    if (!orphanIds.length) return
    console.log(`[Collection] Cleaning up ${orphanIds.length} orphaned cards`)
    const orphanSet = new Set(orphanIds)
    const BATCH = 100;
    (async () => {
      try {
        for (let i = 0; i < orphanIds.length; i += BATCH) {
          const batch = orphanIds.slice(i, i + BATCH)
          await sb.from('cards').delete().in('id', batch)
          for (const id of batch) await deleteCard(id)
        }
        setCards(prev => prev.filter(c => !orphanSet.has(c.id)))
      } catch (err) {
        console.error('[Collection] Orphan cleanup failed:', err.message)
      }
    })()
  }, [loading, folderMembershipLoading, cards, cardFolderMap, isOnline])

  // ── Scryfall enrichment ──────────────────────────────────────────────────────
  const startEnrichment = useCallback(async (rawCards) => {
    if (enrichingRef.current) return

    // Check IDB first — may return instantly if all data cached
    enrichingRef.current = true
    setEnriching(true); setProgress(0)
    const map = await loadCardMapWithSharedPrices(rawCards, {
      onProgress: (pct, lbl) => { setProgress(pct); setProgLabel(lbl) },
      cacheTtlMs: ttlMsRef.current,
    })
    setSfMap(map)
    setEnriching(false); setProgLabel('')
    enrichingRef.current = false
  }, [])

  // ── Import ───────────────────────────────────────────────────────────────────
  const handleImport = useCallback(async (file) => {
    setError('')
    if (file?.name.endsWith('.txt')) {
      // .txt files → open ImportModal (decklist → choose binder destination)
      const text = await file.text()
      setImportModalText(text)
      setShowImportModal(true)
      return
    }
    if (!file?.name.endsWith('.csv')) { setError('Please upload a .csv or .txt file.'); return }
    const text = await file.text()
    const { cards: parsed, folders } = parseManaboxCSV(text)
    if (!parsed.length) { setError('No cards found.'); return }
    setImporting(true)

    const listFolderNames  = new Set(Object.values(folders).filter(f => f.type === 'list').map(f => f.name))
    const ownedCards       = parsed.filter(c => !listFolderNames.has(c._binderName))
    const listCards        = parsed.filter(c =>  listFolderNames.has(c._binderName))
    const folderList       = Object.values(folders)

    setProgLabel(`Parsed ${ownedCards.length} owned + ${listCards.length} wishlist cards across ${folderList.length} folders`)
    await new Promise(r => setTimeout(r, 300))

    // ── Step 1: Upsert all owned cards to Supabase ──────────────────────────
    // Deduplicate by natural key so each physical card is one DB row
    const deduped = {}
    for (const c of ownedCards) {
      if (deduped[c._localId]) deduped[c._localId].qty += c.qty
      else deduped[c._localId] = { ...c }
    }
    const dedupedCards = Object.values(deduped)

    const CARD_BATCH = 200
    for (let i = 0; i < dedupedCards.length; i += CARD_BATCH) {
      const batch = dedupedCards.slice(i, i + CARD_BATCH).map(c => {
        const c2 = { ...c, user_id: user.id }
        delete c2._localId; delete c2._binderName; return c2
      })
      const { error: err } = await sb.from('cards')
        .upsert(batch, { onConflict: 'user_id,set_code,collector_number,foil,language,condition', ignoreDuplicates: false })
      if (err) { setError(`Import error: ${err.message}`); setImporting(false); return }
      setProgLabel(`Saving cards… (${Math.min(i + CARD_BATCH, dedupedCards.length)} / ${dedupedCards.length})`)
    }

    // ── Step 2: Fetch all DB cards to build a lookup map (set-col-foil-lang-cond → id) ─
    setProgLabel('Building card index…')
    let allDbCards = [], dbFrom = 0
    while (true) {
      const { data: page } = await sb.from('cards')
        .select('id,set_code,collector_number,foil,language,condition')
        .eq('user_id', user.id).range(dbFrom, dbFrom + 999)
      if (page?.length) allDbCards = [...allDbCards, ...page]
      if (!page || page.length < 1000) break
      dbFrom += 1000
    }
    // Key: "set_code-collector_number-foil-language-condition" (foil is boolean → "true"/"false")
    const cardKeyMap = {}
    for (const c of allDbCards) {
      cardKeyMap[`${c.set_code}-${c.collector_number}-${c.foil}-${c.language}-${c.condition}`] = c.id
    }

    // ── Step 3: Create folders and link their cards ──────────────────────────
    let folderOk = 0, folderFail = 0, totalMissed = 0

    for (let fi = 0; fi < folderList.length; fi++) {
      const folder = folderList[fi]
      setProgLabel(`Linking ${folder.type}s… (${fi + 1}/${folderList.length}) — ${folder.name}`)

      // Upsert folder row (create if missing, return id either way)
      const { data: folderData, error: fe } = await sb.from('folders')
        .upsert({ user_id: user.id, name: folder.name, type: folder.type }, { onConflict: 'user_id,name,type' })
        .select('id').single()
      if (fe || !folderData) {
        console.error(`[Import] Folder upsert failed for "${folder.name}":`, fe?.message)
        folderFail++
        continue
      }

      // ── Wishlist ────────────────────────────────────────────────────────────
      if (folder.type === 'list') {
        const items = folder.cards.map(c => ({
          folder_id: folderData.id, user_id: user.id,
          name: c.name, set_code: c.set_code,
          collector_number: c.collector_number,
          scryfall_id: c.scryfall_id || null,
          foil: c.foil, qty: c.qty,
        }))
        if (items.length) {
          const { error: lie } = await sb.from('list_items')
            .upsert(items, { onConflict: 'folder_id,set_code,collector_number,foil', ignoreDuplicates: false })
          if (lie) { console.error(`[Import] list_items failed for "${folder.name}":`, lie.message); folderFail++ }
          else folderOk++
        }
        continue
      }

      // ── Binder / Deck ───────────────────────────────────────────────────────
      // Map each CSV card to its DB id; deduplicate within this folder by card_id
      const qtyByCardId = {}
      let missed = 0
      for (const c of folder.cards) {
        const key = `${c.set_code}-${c.collector_number}-${c.foil}-${c.language}-${c.condition}`
        const cid = cardKeyMap[key]
        if (!cid) {
          console.warn(`[Import] No DB row for "${c.name}" (${key}) in "${folder.name}"`)
          missed++
          continue
        }
        qtyByCardId[cid] = (qtyByCardId[cid] ?? 0) + c.qty
      }
      totalMissed += missed

      const newLinks = Object.entries(qtyByCardId).map(([cid, qty]) => (
        folder.type === 'deck'
          ? {
              id:      crypto.randomUUID(),
              deck_id: folderData.id,
              user_id: user.id,
              card_id: cid,
              qty,
            }
          : {
              id:        crypto.randomUUID(),
              folder_id: folderData.id,
              card_id:   cid,
              qty,
            }
      ))

      if (!newLinks.length) {
        console.warn(`[Import] 0 cards could be mapped for "${folder.name}" (${missed} missed)`)
        folderFail++
        continue
      }

      // Delete old links then re-insert fresh — avoids any constraint ambiguity
      // and makes re-imports idempotent for this folder.
      const placementTable = folder.type === 'deck' ? 'deck_allocations' : 'folder_cards'
      const placementKey = folder.type === 'deck' ? 'deck_id' : 'folder_id'
      const { data: oldLinks } = await sb.from(placementTable).select('card_id').eq(placementKey, folderData.id)
      const { error: delErr } = await sb.from(placementTable).delete().eq(placementKey, folderData.id)
      if (delErr) console.warn(`[Import] Could not clear old cards for "${folder.name}":`, delErr.message)

      // Batch the inserts (Supabase/PostgREST limit ~1 MB per request)
      const FC_BATCH = 500
      let batchOk = true
      for (let bi = 0; bi < newLinks.length; bi += FC_BATCH) {
        const { error: fce } = await sb.from(placementTable).insert(newLinks.slice(bi, bi + FC_BATCH))
        if (fce) {
          console.error(`[Import] ${placementTable} insert failed for "${folder.name}" batch ${bi}:`, fce.message)
          batchOk = false; break
        }
      }
      try {
        await pruneUnplacedCards((oldLinks || []).map(row => row.card_id))
      } catch (err) {
        console.warn(`[Import] Could not prune orphaned cards for "${folder.name}":`, err.message)
      }
      if (batchOk) folderOk++
      else folderFail++
    }

    // ── Prune any imported cards that ended up with no folder placement ────────
    const importedIds = dedupedCards
      .map(c => cardKeyMap[`${c.set_code}-${c.collector_number}-${c.foil}-${c.language}-${c.condition}`])
      .filter(Boolean)
    const prunedOrphans = await pruneUnplacedCards(importedIds).catch(err => {
      console.warn('[Import] Orphan prune failed:', err.message)
      return []
    })
    if (prunedOrphans.length) console.log(`[Import] Pruned ${prunedOrphans.length} cards with no folder placement`)

    // ── Done ────────────────────────────────────────────────────────────────
    let msg = `Done — ${dedupedCards.length - prunedOrphans.length} cards, ${folderOk}/${folderList.length} folders linked`
    if (totalMissed > 0) msg += ` (${totalMissed} card rows not matched)`
    if (folderFail > 0) setError(`${folderFail} folder(s) failed to link — check the browser console for details.`)
    setProgLabel(msg)
    setTimeout(() => setProgLabel(''), 8000)
    setImporting(false)
    await loadCards()
  }, [user.id, loadCards])

  // ── Bulk delete ──────────────────────────────────────────────────────────────
  const handleBulkDelete = async () => {
    const placementRows = []
    const selectedQtyByCardId = new Map()
    for (const key of selected) {
      const card = displayCards.find(c => (c._displayKey || c.id) === key)
      if (!card) continue
      const totalQty = card._folder_qty || card.qty || 1
      const selQty = splitState.get(key) ?? 1
      placementRows.push({
        id: card.id,
        sourceFolder: card._displayFolder || null,
        remainingPlacementQty: totalQty - selQty,
      })
      selectedQtyByCardId.set(card.id, (selectedQtyByCardId.get(card.id) || 0) + selQty)
    }

    const cardUpdates = cards.map(card => ({
      id: card.id,
      remaining: (card.qty || 1) - (selectedQtyByCardId.get(card.id) || 0),
    })).filter(row => selectedQtyByCardId.has(row.id))

    const toDelete = cardUpdates.filter(row => row.remaining <= 0)
    const toUpdate = cardUpdates.filter(row => row.remaining > 0)

    const BATCH = 100
    for (let i = 0; i < placementRows.length; i += BATCH) {
      const batch = placementRows.slice(i, i + BATCH)
      for (const row of batch) {
        if (!row.sourceFolder) continue
        const sourceTable = row.sourceFolder.type === 'deck' ? 'deck_allocations' : 'folder_cards'
        const sourceKey = row.sourceFolder.type === 'deck' ? 'deck_id' : 'folder_id'
        if (row.remainingPlacementQty > 0) {
          await sb.from(sourceTable).update({ qty: row.remainingPlacementQty }).eq(sourceKey, row.sourceFolder.id).eq('card_id', row.id)
        } else {
          await sb.from(sourceTable).delete().eq(sourceKey, row.sourceFolder.id).eq('card_id', row.id)
        }
      }
    }
    setCardFolderMap(prev => {
      const next = { ...prev }
      for (const row of placementRows) {
        if (!row.sourceFolder) continue
        const current = [...(next[row.id] || [])]
        const idx = current.findIndex(folder => folder.id === row.sourceFolder.id)
        if (idx < 0) continue
        if (row.remainingPlacementQty > 0) current[idx] = { ...current[idx], qty: row.remainingPlacementQty }
        else current.splice(idx, 1)
        next[row.id] = current
      }
      return next
    })
    for (let i = 0; i < toDelete.length; i += BATCH) {
      const batch = toDelete.slice(i, i + BATCH)
      const cardIds = batch.map(row => row.id)
      await sb.from('cards').delete().in('id', cardIds)
      for (const id of cardIds) await deleteCard(id)
    }
    for (const { id, remaining } of toUpdate) {
      await sb.from('cards').update({ qty: remaining }).eq('id', id)
      const card = cards.find(c => c.id === id)
      if (card) await putCards([{ ...card, qty: remaining }])
    }
    const toDeleteSet = new Set(toDelete.map(row => row.id))
    setCards(prev => prev.map(c => {
      if (toDeleteSet.has(c.id)) return null
      const upd = toUpdate.find(u => u.id === c.id)
      return upd ? { ...c, qty: upd.remaining } : c
    }).filter(Boolean))
    setSelected(new Set()); setSplitState(new Map()); setSelectMode(false)
  }

  const handleMoveToFolder = async (folder) => {
    const selectedRows = []
    for (const key of selected) {
      const card = displayCards.find(c => (c._displayKey || c.id) === key)
      if (!card) continue
      const selQty = splitState.get(key) ?? 1
      selectedRows.push({
        displayKey: key,
        card_id: card.id,
        qty: selQty,
        sourceFolder: card._displayFolder || null,
        sourceQty: card._folder_qty || card.qty || 1,
      })
    }

    if (!selectedRows.length) return

    const placementTable = folder.type === 'deck' ? 'deck_allocations' : 'folder_cards'
    const placementKey = folder.type === 'deck' ? 'deck_id' : 'folder_id'
    const existingRows = await sb.from(placementTable)
      .select('id,card_id,qty')
      .eq(placementKey, folder.id)
      .in('card_id', selectedRows.map(row => row.card_id))

    if (existingRows.error) {
      setError(existingRows.error.message)
      return
    }

    const existingQtyByCardId = Object.fromEntries((existingRows.data || []).map(row => [row.card_id, row.qty || 0]))
    const payload = selectedRows.map(row => (
      folder.type === 'deck'
        ? {
            deck_id: folder.id,
            user_id: user.id,
            card_id: row.card_id,
            qty: row.qty + (existingQtyByCardId[row.card_id] || 0),
          }
        : {
            folder_id: folder.id,
            card_id: row.card_id,
            qty: row.qty + (existingQtyByCardId[row.card_id] || 0),
          }
    ))

    const { error: moveErr } = await sb
      .from(placementTable)
      .upsert(payload, { onConflict: `${placementKey},card_id` })

    if (moveErr) {
      setError(moveErr.message)
      return
    }

    for (const row of selectedRows) {
      const sourceFolder = row.sourceFolder
      if (!sourceFolder || sourceFolder.id === folder.id) continue

      const sourceTable = sourceFolder.type === 'deck' ? 'deck_allocations' : 'folder_cards'
      const sourceKey = sourceFolder.type === 'deck' ? 'deck_id' : 'folder_id'
      const remaining = row.sourceQty - row.qty

      if (remaining > 0) {
        const { error: sourceUpdateErr } = await sb
          .from(sourceTable)
          .update({ qty: remaining })
          .eq(sourceKey, sourceFolder.id)
          .eq('card_id', row.card_id)

        if (sourceUpdateErr) {
          setError(sourceUpdateErr.message)
          return
        }
      } else {
        const { error: sourceDeleteErr } = await sb
          .from(sourceTable)
          .delete()
          .eq(sourceKey, sourceFolder.id)
          .eq('card_id', row.card_id)

        if (sourceDeleteErr) {
          setError(sourceDeleteErr.message)
          return
        }
      }
    }

    setCardFolderMap(prev => {
      const next = { ...prev }
      for (const row of selectedRows) {
        const current = [...(next[row.card_id] || [])]
        if (row.sourceFolder && row.sourceFolder.id !== folder.id) {
          const sourceIdx = current.findIndex(entry => entry.id === row.sourceFolder.id)
          if (sourceIdx >= 0) {
            const remaining = row.sourceQty - row.qty
            if (remaining > 0) {
              current[sourceIdx] = { ...current[sourceIdx], qty: remaining }
            } else {
              current.splice(sourceIdx, 1)
            }
          }
        }
        const existingIdx = current.findIndex(entry => entry.id === folder.id)
        const nextQty = row.qty + (existingQtyByCardId[row.card_id] || 0)
        const folderEntry = { id: folder.id, name: folder.name, type: folder.type, qty: nextQty }
        if (existingIdx >= 0) current[existingIdx] = folderEntry
        else current.push(folderEntry)
        next[row.card_id] = current
      }
      return next
    })

    setSelected(new Set()); setSplitState(new Map()); setSelectMode(false)
  }

  const handleDelete = async (card) => {
    const selectedQty = card._folder_qty || card.qty || 1
    const nextOwnedQty = (cards.find(c => c.id === card.id)?.qty || card.qty || 1) - selectedQty
    if (card._displayFolder) {
      const sourceTable = card._displayFolder.type === 'deck' ? 'deck_allocations' : 'folder_cards'
      const sourceKey = card._displayFolder.type === 'deck' ? 'deck_id' : 'folder_id'
      await sb.from(sourceTable).delete().eq(sourceKey, card._displayFolder.id).eq('card_id', card.id)
      setCardFolderMap(prev => {
        const next = { ...prev }
        next[card.id] = (next[card.id] || []).filter(folder => folder.id !== card._displayFolder.id)
        return next
      })
    }
    if (nextOwnedQty > 0) {
      await sb.from('cards').update({ qty: nextOwnedQty }).eq('id', card.id)
      const updatedCard = { ...(cards.find(c => c.id === card.id) || card), qty: nextOwnedQty }
      await putCards([updatedCard])
      setCards(prev => prev.map(c => c.id === card.id ? updatedCard : c))
    } else {
      await sb.from('cards').delete().eq('id', card.id)
      await deleteCard(card.id)
      setCards(prev => prev.filter(c => c.id !== card.id))
    }
    setDetailCardKey(null)
  }

  const handleCardSave = useCallback(async (updatedCard) => {
    // Update in-memory state → triggers worker re-filter/re-sort
    setCards(prev => prev.map(c => c.id === updatedCard.id ? { ...c, ...updatedCard } : c))
    if (updatedCard._displayFolder?.id && updatedCard._folder_qty != null) {
      setCardFolderMap(prev => {
        const next = { ...prev }
        next[updatedCard.id] = (next[updatedCard.id] || []).map(folder =>
          folder.id === updatedCard._displayFolder.id
            ? { ...folder, qty: updatedCard._folder_qty }
            : folder
        )
        return next
      })
    }
    await putCards([updatedCard])
  }, [])

  const displayCardsRef = useRef([])

  const toggleSelectMode = () => { setSelectMode(v => !v); setSelected(new Set()); setSplitState(new Map()) }
  const clearSelect = () => { setSelected(new Set()); setSplitState(new Map()); setSelectMode(false) }
  const toggleSelect = useCallback((id, totalQty) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        setSplitState(s => { const n = new Map(s); n.delete(id); return n })
      } else {
        next.add(id)
        if (totalQty > 1) {
          setSplitState(s => new Map(s).set(id, 1))
        }
      }
      return next
    })
  }, [])

  const onAdjustQty = useCallback((id, delta, totalQty) => {
    setSplitState(prev => {
      const current = prev.get(id) ?? 1
      const next = Math.min(totalQty, current + delta)
      if (next <= 0) {
        setSelected(prevSelected => {
          const updated = new Set(prevSelected)
          updated.delete(id)
          return updated
        })
        const updated = new Map(prev)
        updated.delete(id)
        return updated
      }
      return new Map(prev).set(id, next)
    })
  }, [])

  const selectedQty = useMemo(() =>
    [...selected].reduce((sum, key) => {
      const card = displayCardsRef.current.find(c => (c._displayKey || c.id) === key)
      if (!card) return sum
      return sum + (splitState.get(key) ?? 1)
    }, 0)
  , [selected, splitState])

  const totalValue = useMemo(() => cards.reduce((s, c) => {
    const p = getPrice(sfMap[getScryfallKey(c)], c.foil, { price_source })
    return s + (p != null ? p * c.qty : 0)
  }, 0), [cards, sfMap, price_source])

  const totalQty = useMemo(() => cards.reduce((s, c) => s + c.qty, 0), [cards])

  const availableSets = useMemo(() => {
    const seen = {}
    for (const c of cards) {
      if (!seen[c.set_code]) {
        const sf = sfMap[`${c.set_code}-${c.collector_number}`]
        seen[c.set_code] = sf?.set_name || c.set_code?.toUpperCase() || c.set_code
      }
    }
    return Object.entries(seen).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [cards, sfMap])

  const availableLanguages = useMemo(() => {
    const seen = new Set(cards.map(c => c.language).filter(Boolean))
    return [...seen].sort()
  }, [cards])

  // Expand cards that are in multiple folders into separate display entries
  const displayCards = useMemo(() => {
    const usingPlacementView = filters.location !== 'all' || filters.folderName?.trim()
    const matchesLocationFilter = (folder) => {
      if (!folder) return filters.location === 'all' && !filters.folderName?.trim()
      if (filters.location === 'binder' && folder.type !== 'binder') return false
      if (filters.location === 'deck' && folder.type !== 'deck') return false
      if (filters.folderName?.trim()) {
        const q = filters.folderName.trim().toLowerCase()
        if (!(folder.name || '').toLowerCase().includes(q)) return false
      }
      return true
    }
    const result = []
    for (const card of filtered) {
      const allFolders = cardFolderMap[card.id] || []
      const folders = usingPlacementView
        ? allFolders.filter(matchesLocationFilter)
        : allFolders
      if (folders && folders.length > 1) {
        // One tile per folder membership — badge hidden, each tile is independently selectable
        folders.forEach((f, i) => {
          result.push({ ...card, _displayKey: `${card.id}_${i}`, _displayFolder: f, _folder_qty: f.qty || 1, _multiFolder: true })
        })
      } else {
        result.push({
          ...card,
          _displayKey: card.id,
          _displayFolder: folders?.[0] || null,
          _folder_qty: usingPlacementView ? (folders?.[0]?.qty || card.qty) : card.qty,
        })
      }
    }
    displayCardsRef.current = result
    return result
  }, [filtered, cardFolderMap, filters])

  const selectedCard = detailCardKey ? displayCards.find(c => (c._displayKey || c.id) === detailCardKey) : null
  const selectedSf   = selectedCard ? sfMap[getScryfallKey(selectedCard)] : null

  if (loading && !cards.length) return <EmptyState>Loading your collection…</EmptyState>

  const statusItems = [
    loading ? 'Loading collection…' : null,
    folderMembershipLoading ? 'Loading locations and badges…' : null,
    enriching ? (progLabel || 'Refreshing card data…') : null,
    importing ? (progLabel || 'Importing collection…') : null,
  ].filter(Boolean)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <SectionHeader
        title={`Collection${cards.length ? ` · ${cards.length} cards` : ''}`}
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {!isOnline && <span style={{ fontSize: '0.72rem', color: '#e0a852', border: '1px solid rgba(224,168,82,0.3)', borderRadius: 3, padding: '3px 8px' }}>Offline</span>}
            <Button variant="purple" onClick={() => setShowAdd(true)}>+ Add Card</Button>
          </div>
        }
      />

      {cards.length === 0 ? (
        <DropZone onFile={handleImport}
          title="Import Your Collection"
          subtitle='Drop a Manabox CSV here, or click to browse. Use ↑ Import above to add a decklist.' />
      ) : (
        <FilterBar
          search={searchInput} setSearch={setSearchInput}
          sort={sort} setSort={setSort}
          filters={filters} setFilters={setFilters}
          selectMode={selectMode} onToggleSelectMode={toggleSelectMode}
          sets={availableSets} languages={availableLanguages}
          extra={
            <div style={{ display: 'flex', gap: 6 }}>
              <button className={styles.importBtn} onClick={() => { setImportModalText(''); setShowImportModal(true) }}>↑ Import</button>
              <button className={styles.importBtn} onClick={() => setShowExport(true)}>↓ Export</button>
            </div>
          }
        />
      )}

      <ErrorBox>{error}</ErrorBox>
      {statusItems.length > 0 && (
        <div className={styles.statusBar}>
          {statusItems.map((item, index) => (
            <span key={`${item}:${index}`} className={styles.statusChip}>{item}</span>
          ))}
        </div>
      )}
      {(enriching || importing) && <ProgressBar value={progress} label={progLabel} />}

      {cards.length > 0 && <>
        <div className={styles.gridHeader}>
          <span>Showing {filtered.length} of {cards.length} unique · {totalQty} total cards</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {!enriching && <span>Value: <strong style={{ color: 'var(--green)' }}>{formatPrice(totalValue, price_source)}</strong></span>}
          </span>
        </div>

        <CardBrowserViewControls
          viewMode={viewMode} setViewMode={setViewMode}
          groupBy={groupBy} setGroupBy={setGroupBy}
        />

        {selectMode && selected.size > 0 && (
          <BulkActionBar
            selected={selected} selectedQty={selectedQty}
            total={displayCards.reduce((s, c) => s + (c.qty || 1), 0)}
            onSelectAll={() => {
              setSelected(new Set(displayCards.map(c => c._displayKey || c.id)))
              setSplitState(new Map(
                displayCards
                  .filter(c => (c._folder_qty || c.qty || 1) > 1)
                  .map(c => [c._displayKey || c.id, c._folder_qty || c.qty || 1])
              ))
            }}
            onDeselectAll={clearSelect}
            onDelete={handleBulkDelete}
            onMoveToFolder={handleMoveToFolder}
            folders={folders}
            onCreateFolder={async (type, name) => {
              const { data: newFolder } = await sb.from('folders')
                .insert({ name, type, user_id: user.id }).select().single()
              if (newFolder) {
                setFolders(prev => [...prev, newFolder])
                await handleMoveToFolder(newFolder)
              }
            }}
          />
        )}

        {viewMode === 'grid' ? (
          <div className={styles.gridViewport}>
            <VirtualCardGrid
              cards={displayCards} sfMap={sfMap} loading={enriching}
              onSelect={c => setDetailCardKey(c._displayKey || c.id)}
              selectMode={selectMode} selected={selected} onToggleSelect={toggleSelect}
              onEnterSelectMode={() => { setSelectMode(true) }}
              splitState={splitState} onAdjustQty={onAdjustQty}
              priceSource={price_source}
              showPrice={show_price} density={grid_density}
              cardFolders={cardFolderMap}
            />
          </div>
        ) : (
          <CardBrowserContent
            cards={filtered}
            sfMap={sfMap}
            priceSource={price_source}
            viewMode={viewMode}
            groupBy={groupBy}
            density={grid_density}
            onSelect={c => setDetailCardKey(c._displayKey || c.id)}
            selectMode={selectMode}
            selectedCards={selected}
            onToggleSelect={toggleSelect}
            onAdjustQty={onAdjustQty}
            splitState={splitState}
            onEnterSelectMode={() => setSelectMode(true)}
          />
        )}

        {filtered.length === 0 && !enriching && <EmptyState>No cards match your filters.</EmptyState>}
      </>}

      {selectedCard && (
        <CardDetail
          card={selectedCard} sfCard={selectedSf}
          folders={selectedCard._displayFolder ? [selectedCard._displayFolder] : (cardFolderMap[selectedCard.id] || [])}
          allFolders={folders}
          priceSource={price_source}
          currentFolderId={selectedCard._displayFolder?.id ?? null}
          currentFolderType={selectedCard._displayFolder?.type ?? null}
          onClose={() => setDetailCardKey(null)}
          onDelete={() => handleDelete(selectedCard)}
          onSave={handleCardSave}
        />
      )}

      {showAdd && (
        <AddCardModal userId={user.id}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); loadCards() }}
        />
      )}

      {showImportModal && user && (
        <ImportModal
          userId={user.id}
          folderType="binder"
          folders={folders.filter(f => f.type === 'binder')}
          initialText={importModalText || undefined}
          onClose={() => setShowImportModal(false)}
          onSaved={() => { setShowImportModal(false); loadCards() }}
        />
      )}

      {showExport && (
        <ExportModal
          cards={cards}
          sfMap={sfMap}
          title="Collection"
          folderType="collection"
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  )
}
