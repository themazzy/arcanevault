import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { enrichCards, getScryfallKey, getPrice, formatPrice, clearScryfallCache, clearAllScryfallCache, getCacheAge, getMemoryMap, getInstantCache } from '../lib/scryfall'
import { getLocalCards, putCards, deleteCard, deleteAllCards, getAllLocalFolderCards, putFolderCards, getLocalFolders, putFolders, setMeta } from '../lib/db'
import { parseManaboxCSV } from '../lib/csvParser'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { CardDetail, FilterBar, BulkActionBar, EMPTY_FILTERS } from '../components/CardComponents'
import VirtualCardGrid from '../components/VirtualCardGrid'
import { DropZone, ProgressBar, ErrorBox, EmptyState, SectionHeader, Button } from '../components/UI'
import AddCardModal from '../components/AddCardModal'
import styles from './Collection.module.css'

const DEBOUNCE_MS = 300

const worker = new Worker(new URL('../lib/filterWorker.js', import.meta.url), { type: 'module' })

export default function CollectionPage() {
  const { user } = useAuth()
  const { price_source, default_sort, grid_density, show_price, cache_ttl_h, loaded: settingsLoaded } = useSettings()

  const ttlMsRef = useRef(cache_ttl_h * 3600000)
  useEffect(() => { ttlMsRef.current = cache_ttl_h * 3600000 }, [cache_ttl_h])

  const [sfMap, setSfMap]   = useState({})
  const [cacheAge, setCacheAge] = useState(null)
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
  const [detailCardId, setDetailCardId] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [importing, setImporting] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [folders, setFolders] = useState([])
  const [cardFolderMap, setCardFolderMap] = useState({})
  const [isOnline, setIsOnline] = useState(navigator.onLine)
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

  // ── Load cards — IDB first, Supabase sync in background ──────────────────────
  const loadCards = useCallback(async () => {
    setLoading(true)

    // 1. Read from IDB immediately — instant render even offline
    const localCards = await getLocalCards(user.id)
    if (localCards.length) {
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

    let allCards = [], from = 0
    const PAGE = 1000
    while (true) {
      const { data, error: err } = await sb.from('cards')
        .select('*').eq('user_id', user.id).order('name')
        .range(from, from + PAGE - 1)
      if (err) { setError(err.message); break }
      if (data?.length) allCards = [...allCards, ...data]
      if (!data || data.length < PAGE) break
      from += PAGE
    }

    if (allCards.length) {
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
      if (!localCards.length) {
        // First ever load — start enrichment now that we have cards
        startEnrichment(allCards)
      } else {
        // Check if any new cards appeared vs local
        const localIds = new Set(localCards.map(c => c.id))
        const newCards = allCards.filter(c => !localIds.has(c.id))
        if (newCards.length) {
          console.log(`[Collection] ${newCards.length} new cards synced from Supabase`)
          enrichCards(newCards, null, ttlMsRef.current).then(map => {
            setSfMap({ ...map })
            setCacheAge(getCacheAge())
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
      // IDB first
      const localFolders = await getLocalFolders(user.id)
      if (localFolders.length) {
        const ids = localFolders.map(f => f.id)
        const allFc = await getAllLocalFolderCards(ids)
        const folderById = Object.fromEntries(localFolders.map(f => [f.id, f]))
        const map = {}
        for (const row of allFc) {
          const folder = folderById[row.folder_id]
          if (!folder) continue
          if (!map[row.card_id]) map[row.card_id] = []
          map[row.card_id].push({ id: folder.id, name: folder.name, type: folder.type })
        }
        setFolders(localFolders)
        setCardFolderMap(map)
      }

      if (!navigator.onLine) return

      // Sync folders from Supabase
      const { data: foldersData } = await sb.from('folders')
        .select('id,name,type').eq('user_id', user.id).order('name')
      if (!foldersData?.length) return

      setFolders(foldersData)
      await putFolders(foldersData)

      const ids = foldersData.map(f => f.id)
      let allFc = [], fcFrom = 0
      while (true) {
        const { data: page } = await sb.from('folder_cards')
          .select('id,card_id,folder_id,qty')
          .in('folder_id', ids).range(fcFrom, fcFrom + 999)
        if (page?.length) allFc = [...allFc, ...page]
        if (!page || page.length < 1000) break
        fcFrom += 1000
      }
      await putFolderCards(allFc)

      const folderById = Object.fromEntries(foldersData.map(f => [f.id, f]))
      const map = {}
      for (const row of allFc) {
        const folder = folderById[row.folder_id]
        if (!folder) continue
        if (!map[row.card_id]) map[row.card_id] = []
        map[row.card_id].push({ id: folder.id, name: folder.name, type: folder.type })
      }
      setCardFolderMap(map)
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

  // ── Scryfall enrichment ──────────────────────────────────────────────────────
  const startEnrichment = useCallback(async (rawCards, forceRefresh = false) => {
    if (enrichingRef.current) return
    if (forceRefresh) await clearScryfallCache()

    // Check IDB first — may return instantly if all data cached
    const cached = await getInstantCache(ttlMsRef.current)
    if (cached && !forceRefresh) {
      setSfMap(cached)
      setCacheAge(await getCacheAge())
      const missing = rawCards.filter(c => !cached[`${c.set_code}-${c.collector_number}`])
      if (!missing.length) return
      // Silently fetch only missing cards
      enrichCards(missing, null, ttlMsRef.current).then(async map => {
        setSfMap({ ...map })
        setCacheAge(await getCacheAge())
      })
      return
    }

    enrichingRef.current = true
    setEnriching(true); setProgress(0)
    const map = await enrichCards(rawCards, (pct, lbl) => { setProgress(pct); setProgLabel(lbl) }, ttlMsRef.current)
    setSfMap(map)
    setEnriching(false); setProgLabel('')
    setCacheAge(await getCacheAge())
    enrichingRef.current = false
  }, [])

  const handleRefresh = useCallback(async () => {
    enrichingRef.current = false
    await startEnrichment(cards, true)
  }, [cards, startEnrichment])

  // ── Import ───────────────────────────────────────────────────────────────────
  const handleImport = useCallback(async (file) => {
    setError('')
    if (!file?.name.endsWith('.csv')) { setError('Please upload a .csv file.'); return }
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

      const newLinks = Object.entries(qtyByCardId).map(([cid, qty]) => ({
        id:        crypto.randomUUID(),
        folder_id: folderData.id,
        card_id:   cid,
        qty,
      }))

      if (!newLinks.length) {
        console.warn(`[Import] 0 cards could be mapped for "${folder.name}" (${missed} missed)`)
        folderFail++
        continue
      }

      // Delete old links then re-insert fresh — avoids any constraint ambiguity
      // and makes re-imports idempotent for this folder.
      const { error: delErr } = await sb.from('folder_cards').delete().eq('folder_id', folderData.id)
      if (delErr) console.warn(`[Import] Could not clear old cards for "${folder.name}":`, delErr.message)

      // Batch the inserts (Supabase/PostgREST limit ~1 MB per request)
      const FC_BATCH = 500
      let batchOk = true
      for (let bi = 0; bi < newLinks.length; bi += FC_BATCH) {
        const { error: fce } = await sb.from('folder_cards').insert(newLinks.slice(bi, bi + FC_BATCH))
        if (fce) {
          console.error(`[Import] folder_cards insert failed for "${folder.name}" batch ${bi}:`, fce.message)
          batchOk = false; break
        }
      }
      if (batchOk) folderOk++
      else folderFail++
    }

    // ── Done ────────────────────────────────────────────────────────────────
    let msg = `Done — ${dedupedCards.length} cards, ${folderOk}/${folderList.length} folders linked`
    if (totalMissed > 0) msg += ` (${totalMissed} card rows not matched)`
    if (folderFail > 0) setError(`${folderFail} folder(s) failed to link — check the browser console for details.`)
    setProgLabel(msg)
    setTimeout(() => setProgLabel(''), 8000)
    setImporting(false)
    await loadCards()
  }, [user.id, loadCards])

  // ── Bulk delete ──────────────────────────────────────────────────────────────
  const handleBulkDelete = async () => {
    const count = selected.size
    if (!window.confirm(`Delete ${count} card${count !== 1 ? 's' : ''}? This cannot be undone.`)) return
    const ids = [...selected]

    if (ids.length === cards.length) {
      await sb.from('cards').delete().eq('user_id', user.id)
      await deleteAllCards(user.id)
      setCards([]); setSelected(new Set()); setSelectMode(false); return
    }

    const BATCH = 100
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH)
      await sb.from('cards').delete().in('id', batch)
      for (const id of batch) await deleteCard(id)
    }
    setCards(prev => prev.filter(c => !selected.has(c.id)))
    setSelected(new Set()); setSelectMode(false)
  }

  const handleMoveToFolder = async (folder) => {
    const folderCards = [...selected].map(id => ({ folder_id: folder.id, card_id: id, qty: 1 }))
    await sb.from('folder_cards').upsert(folderCards, { onConflict: 'folder_id,card_id', ignoreDuplicates: true })
    setSelected(new Set()); setSelectMode(false)
  }

  const handleDelete = async (card) => {
    await sb.from('cards').delete().eq('id', card.id)
    await deleteCard(card.id)
    setCards(prev => prev.filter(c => c.id !== card.id))
    setDetailCardId(null)
  }

  const handleCardSave = useCallback(async (updatedCard) => {
    // Update in-memory state → triggers worker re-filter/re-sort
    setCards(prev => prev.map(c => c.id === updatedCard.id ? { ...c, ...updatedCard } : c))
    // Persist to IDB
    await putCards([updatedCard])
  }, [])

  const toggleSelectMode = () => { setSelectMode(v => !v); setSelected(new Set()) }
  const toggleSelect = (id) => setSelected(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
  })

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

  const selectedCard = detailCardId ? cards.find(c => c.id === detailCardId) : null
  const selectedSf   = selectedCard ? sfMap[getScryfallKey(selectedCard)] : null

  // Expand cards that are in multiple folders into separate display entries
  const displayCards = useMemo(() => {
    const result = []
    for (const card of filtered) {
      const folders = cardFolderMap[card.id]
      if (folders && folders.length > 1) {
        // One tile per folder membership
        folders.forEach((f, i) => {
          result.push({ ...card, _displayKey: `${card.id}_${i}`, _displayFolder: f })
        })
      } else {
        result.push({ ...card, _displayKey: card.id, _displayFolder: folders?.[0] || null })
      }
    }
    return result
  }, [filtered, cardFolderMap])

  if (loading && !cards.length) return <EmptyState>Loading your collection…</EmptyState>

  return (
    <div>
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
          subtitle='Drop your Manabox CSV here, or click to browse.' />
      ) : (
        <FilterBar
          search={searchInput} setSearch={setSearchInput}
          sort={sort} setSort={setSort}
          filters={filters} setFilters={setFilters}
          selectMode={selectMode} onToggleSelectMode={toggleSelectMode}
          sets={availableSets} languages={availableLanguages}
          extra={
            <label className={styles.importBtn}>
              Import CSV
              <input type="file" accept=".csv" style={{ display: 'none' }}
                onChange={e => e.target.files[0] && handleImport(e.target.files[0])} />
            </label>
          }
        />
      )}

      <ErrorBox>{error}</ErrorBox>
      {(enriching || importing) && <ProgressBar value={progress} label={progLabel} />}

      {cards.length > 0 && <>
        <div className={styles.gridHeader}>
          <span>Showing {filtered.length} of {cards.length} unique · {totalQty} total cards</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {cacheAge != null && !enriching && (
              <span style={{ color: 'var(--text-faint)', fontSize: '0.78rem' }}>
                Prices cached {Math.round(cacheAge / 3600000)}h ago
                <button onClick={handleRefresh}
                  style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--gold-dim)', cursor: 'pointer', fontSize: '0.78rem', textDecoration: 'underline' }}>
                  Refresh
                </button>
              </span>
            )}
            {!enriching && <span>Value: <strong style={{ color: 'var(--green)' }}>{formatPrice(totalValue, price_source)}</strong></span>}
          </span>
        </div>

        {selectMode && selected.size > 0 && (
          <BulkActionBar
            selected={selected} total={filtered.length}
            onSelectAll={() => setSelected(new Set(filtered.map(c => c.id)))}
            onDeselectAll={() => setSelected(new Set())}
            onDelete={handleBulkDelete}
            onMoveToFolder={handleMoveToFolder}
            folders={folders}
          />
        )}

        <VirtualCardGrid
          cards={displayCards} sfMap={sfMap} loading={enriching}
          onSelect={c => setDetailCardId(c.id)}
          selectMode={selectMode} selected={selected} onToggleSelect={toggleSelect}
          onEnterSelectMode={() => { setSelectMode(true) }}
          priceSource={price_source}
          showPrice={show_price} density={grid_density}
          cardFolders={cardFolderMap}
        />

        {displayCards.length === 0 && !enriching && <EmptyState>No cards match your filters.</EmptyState>}
      </>}

      {selectedCard && (
        <CardDetail
          card={selectedCard} sfCard={selectedSf}
          folders={cardFolderMap[selectedCard.id]}
          allFolders={folders}
          priceSource={price_source}
          onClose={() => setDetailCardId(null)}
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
    </div>
  )
}
