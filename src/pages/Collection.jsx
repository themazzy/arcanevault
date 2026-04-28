import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { sb } from '../lib/supabase'
import { getScryfallKey, getPrice, formatPrice, getInstantCache } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { getLocalCards, putCards, deleteCard, deleteAllCards, getAllLocalFolderCards, putFolderCards, getLocalFolders, putFolders, setMeta, getMeta, deleteFolder as deleteLocalFolder, replaceLocalFolderCards, getAllDeckAllocationsForUser, putDeckAllocations, replaceDeckAllocations, deleteDeckAllocationsByCardIds, deleteFolderCardsByCardIds } from '../lib/db'
import { parseManaboxCSV } from '../lib/csvParser'
import { ensureCardPrints, getCardPrint, withCardPrint } from '../lib/cardPrints'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { useToast } from '../components/ToastContext'
import { CardDetail, FilterBar, BulkActionBar, EMPTY_FILTERS } from '../components/CardComponents'
import VirtualCardGrid from '../components/VirtualCardGrid'
import { DropZone, ProgressBar, ErrorBox, EmptyState, SectionHeader, Button, ResponsiveMenu } from '../components/UI'
import AddCardModal from '../components/AddCardModal'
import ExportModal from '../components/ExportModal'
import ImportModal from '../components/ImportModal'
import styles from './Collection.module.css'
import uiStyles from '../components/UI.module.css'
import { pruneUnplacedCards } from '../lib/collectionOwnership'
import { hydrateCollectionQueriesFromIdb } from '../lib/idbQueryBridge'
import { fetchCollectionCards, fetchFolders, fetchFolderPlacements, fetchSfMap } from '../lib/collectionFetchers'
import { isNetworkLikeError } from '../lib/networkUtils'

const DEBOUNCE_MS = 300
const FOLDER_CARDS_FULL_SYNC_MS = 10 * 60 * 1000
const FOLDER_CARDS_DELTA_OVERLAP_MS = 30 * 1000
const LOCAL_COLLECTION_FRESH_MS = 5 * 60 * 1000

const worker = new Worker(new URL('../lib/filterWorker.js', import.meta.url), { type: 'module' })

function hasActiveCollectionFilters(filters) {
  return Object.keys(EMPTY_FILTERS).some(key => {
    const current = filters?.[key]
    const empty = EMPTY_FILTERS[key]
    if (Array.isArray(empty)) return Array.isArray(current) && current.length > 0
    return current !== empty
  })
}

function isGroupFolder(folder) {
  try { return JSON.parse(folder?.description || '{}').isGroup === true } catch { return false }
}

function buildCardFolderMap(folderRows, linkRows) {
  const folderById = Object.fromEntries((folderRows || []).map(f => [f.id, f]))
  const map = {}
  for (const row of linkRows || []) {
    const folderId = row.folder_id || row.deck_id
    const folder = folderById[folderId]
    if (!folder) continue
    if (!map[row.card_id]) map[row.card_id] = []
    map[row.card_id].push({ id: folder.id, name: folder.name, type: folder.type, qty: row.qty || 1 })
  }
  return map
}

function ConnectionStatusBadge({ isOnline, loading, folderMembershipLoading, enriching, importing }) {
  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)
  let tone = 'online'
  let label = 'Online'
  const isBusy = loading || folderMembershipLoading || enriching || importing

  if (!isOnline) {
    tone = 'offline'
    label = 'Offline'
  } else if (isBusy) {
    tone = 'loading'
    label = 'Loading data'
  }

  useEffect(() => {
    if (!isOnline || isBusy) {
      setVisible(true)
      setExiting(false)
      return undefined
    }

    setVisible(true)
    setExiting(false)
    const exitTimer = setTimeout(() => setExiting(true), 2000)
    const hideTimer = setTimeout(() => setVisible(false), 2400)
    return () => {
      clearTimeout(exitTimer)
      clearTimeout(hideTimer)
    }
  }, [isOnline, isBusy])

  if (!visible) return null

  return (
    <div className={`${styles.connectionBadge} ${styles[`connectionBadge_${tone}`]}${exiting ? ' ' + styles.connectionBadge_exit : ''}`}>
      <span className={styles.connectionDot} />
      {label}
    </div>
  )
}

function OrphanModal({ cards, folders, userId, onAssigned, onDeleted }) {
  const [selectedFolderId, setSelectedFolderId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const folder = folders.find(f => f.id === selectedFolderId) || null

  const handleAssign = async () => {
    if (!folder) return
    setBusy(true); setError('')
    try {
      const isDeck = folder.type === 'deck'
      const table  = isDeck ? 'deck_allocations' : 'folder_cards'
      const fk = isDeck ? 'deck_id' : 'folder_id'
      const qtyByCardId = new Map()
      for (const card of cards) {
        qtyByCardId.set(card.id, (qtyByCardId.get(card.id) || 0) + (card.qty || 1))
      }

      const cardIds = [...qtyByCardId.keys()]
      const { data: existingRows, error: existingErr } = await sb.from(table)
        .select('card_id,qty')
        .eq(fk, folder.id)
        .in('card_id', cardIds)
      if (existingErr) throw existingErr

      const existingQtyByCardId = new Map((existingRows || []).map(row => [row.card_id, row.qty || 0]))
      const rows = cardIds.map(cardId => {
        const qty = Math.max(existingQtyByCardId.get(cardId) || 0, qtyByCardId.get(cardId) || 1)
        return isDeck
          ? { deck_id: folder.id, card_id: cardId, user_id: userId, qty }
          : { folder_id: folder.id, card_id: cardId, qty }
      })

      const { data: savedRows, error: err } = await sb.from(table)
        .upsert(rows, { onConflict: `${fk},card_id` })
        .select(isDeck ? 'id,deck_id,user_id,card_id,qty' : 'id,folder_id,card_id,qty,updated_at')
      if (err) throw err
      if (isDeck) await putDeckAllocations(savedRows || [])
      else await putFolderCards(savedRows || [])
      await setMeta(`folder_cards_full_sync_${userId}`, 0)
      onAssigned(cards, folder, savedRows || [])
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    setBusy(true); setError('')
    try {
      const ids = cards.map(c => c.id)
      const BATCH = 100
      for (let i = 0; i < ids.length; i += BATCH) {
        const { error: err } = await sb.from('cards').delete().in('id', ids.slice(i, i + BATCH))
        if (err) throw err
        for (const id of ids.slice(i, i + BATCH)) await deleteCard(id)
      }
      onDeleted(cards)
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border-hi)', borderRadius: 10, maxWidth: 480, width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.72rem', letterSpacing: '0.12em', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 6 }}>Unassigned Cards</div>
          <div style={{ fontSize: '0.88rem', color: 'var(--text-dim)' }}>
            {cards.length} card{cards.length !== 1 ? 's' : ''} found without a binder, deck, or wishlist. Assign them or delete.
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '12px 20px' }}>
          {cards.map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '0.84rem' }}>
              <span style={{ color: 'var(--text)' }}>{c.name}</span>
              <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-serif)', fontSize: '0.76rem' }}>{(c.set_code || '').toUpperCase()}</span>
            </div>
          ))}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <select
            name="unassigned-card-destination"
            value={selectedFolderId}
            onChange={e => setSelectedFolderId(e.target.value)}
            disabled={busy}
            style={{ width: '100%', padding: '8px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: '0.84rem' }}
          >
            <option value=''>— Pick a destination —</option>
            {['binder', 'deck', 'list'].map(type => {
              const group = folders.filter(f => f.type === type)
              if (!group.length) return null
              return (
                <optgroup key={type} label={type.charAt(0).toUpperCase() + type.slice(1) + 's'}>
                  {group.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </optgroup>
              )
            })}
          </select>

          {error && <div style={{ color: 'var(--red)', fontSize: '0.78rem' }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleAssign}
              disabled={busy || !folder}
              style={{ flex: 1, padding: '9px 0', background: folder ? 'rgba(201,168,76,0.15)' : 'var(--bg3)', border: '1px solid var(--s-border2)', borderRadius: 6, color: folder ? 'var(--gold)' : 'var(--text-faint)', fontFamily: 'var(--font-display)', fontSize: '0.72rem', letterSpacing: '0.08em', cursor: folder ? 'pointer' : 'default', transition: 'all 0.15s' }}
            >
              {busy ? '…' : 'Assign All'}
            </button>
            <button
              onClick={handleDelete}
              disabled={busy}
              style={{ padding: '9px 16px', background: 'rgba(220,60,60,0.08)', border: '1px solid rgba(220,60,60,0.25)', borderRadius: 6, color: 'var(--red, #e05555)', fontFamily: 'var(--font-display)', fontSize: '0.72rem', letterSpacing: '0.08em', cursor: 'pointer', transition: 'all 0.15s' }}
            >
              Delete All
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function CollectionPage() {
  const { user } = useAuth()
  const toast = useToast()
  const { price_source, default_sort, grid_density, show_price, cache_ttl_h, loaded: settingsLoaded } = useSettings()
  const queryClient = useQueryClient()

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
  const [gridScrolled, setGridScrolled] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [importModalText, setImportModalText] = useState('')
  const [importing, setImporting] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [splitState, setSplitState] = useState(new Map())
  const [folders, setFolders] = useState([])
  const [cardFolderMap, setCardFolderMap] = useState({})
  const [folderMembershipLoading, setFolderMembershipLoading] = useState(true)
  const [folderMembershipSynced, setFolderMembershipSynced] = useState(false)
  const [folderMembershipReloadKey, setFolderMembershipReloadKey] = useState(0)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [orphanCards, setOrphanCards] = useState([])
  const workerReqId  = useRef(0)
  const cardsLoadSeq = useRef(0)
  const enrichingRef = useRef(false)
  const canSeedFilteredRef = useRef(true)
  const hydratedQueriesRef = useRef(false)

  useEffect(() => {
    if (!user?.id || hydratedQueriesRef.current) return
    hydratedQueriesRef.current = true
    hydrateCollectionQueriesFromIdb(queryClient, user.id).catch(err => {
      console.warn('[Collection] Could not hydrate React Query cache from IDB:', err.message)
    })
  }, [queryClient, user?.id])

  const cardsQuery = useQuery({
    queryKey: ['cards', user.id],
    queryFn: () => fetchCollectionCards(user.id),
    staleTime: LOCAL_COLLECTION_FRESH_MS,
    enabled: !!user?.id,
  })

  const foldersQuery = useQuery({
    queryKey: ['folders', user.id],
    queryFn: () => fetchFolders(user.id),
    staleTime: LOCAL_COLLECTION_FRESH_MS,
    enabled: !!user?.id,
  })

  const placementsQuery = useQuery({
    queryKey: ['folderPlacements', user.id],
    queryFn: fetchFolderPlacements,
    staleTime: FOLDER_CARDS_FULL_SYNC_MS,
    enabled: !!user?.id,
  })

  const sfMapQuery = useQuery({
    queryKey: ['sfMap', user.id],
    queryFn: () => fetchSfMap(cards, ttlMsRef.current, (pct, lbl) => {
      setProgress(pct)
      setProgLabel(lbl)
    }),
    staleTime: ttlMsRef.current,
    enabled: !!user?.id && cards.length > 0,
    placeholderData: {},
  })

  const invalidateCollectionQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['cards', user.id] })
    queryClient.invalidateQueries({ queryKey: ['folders', user.id] })
    queryClient.invalidateQueries({ queryKey: ['folderPlacements', user.id] })
    queryClient.invalidateQueries({ queryKey: ['sfMap', user.id] })
  }, [queryClient, user.id])

  const loadCards = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['cards', user.id] })
    await cardsQuery.refetch()
  }, [cardsQuery, queryClient, user.id])

  const blockOfflineChange = useCallback(() => {
    if (isOnline && navigator.onLine) return false
    setIsOnline(false)
    setError('You are offline. Collection changes are disabled until you reconnect.')
    return true
  }, [isOnline])

  useEffect(() => {
    canSeedFilteredRef.current = !search && !hasActiveCollectionFilters(filters)
  }, [search, filters])

  useEffect(() => {
    if (settingsLoaded) setSort(default_sort || 'name')
  }, [settingsLoaded])

  // Track online status
  useEffect(() => {
    const on  = () => setIsOnline(true)
    const off = () => {
      setIsOnline(false)
      setFolderMembershipSynced(false)
      setOrphanCards([])
    }
    window.addEventListener('online',  on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // ── React Query data bridge ──────────────────────────────────────────────────
  useEffect(() => {
    if (!cardsQuery.isError) return
    if (isNetworkLikeError(cardsQuery.error)) setIsOnline(false)
    else setError(cardsQuery.error?.message || 'Could not load cards')
  }, [cardsQuery.error, cardsQuery.isError])

  useEffect(() => {
    setLoading(cardsQuery.isFetching)
  }, [cardsQuery.isFetching])

  useEffect(() => {
    if (!cardsQuery.isSuccess) return
    let cancelled = false
    ;(async () => {
      const remoteCards = cardsQuery.data || []
      const localCards = await getLocalCards(user.id)
      if (cancelled) return

      if (!remoteCards.length) {
        if (localCards.length) await deleteAllCards(user.id)
        await setMeta(`cards_synced_${user.id}`, Date.now())
        if (!cancelled) {
          setCards([])
          setFiltered([])
        }
        return
      }

      if (localCards.length) {
        const remoteIds = new Set(remoteCards.map(c => c.id))
        const staleLocal = localCards.filter(c => !remoteIds.has(c.id))
        if (staleLocal.length) await Promise.all(staleLocal.map(c => deleteCard(c.id)))
      }
      await putCards(remoteCards)
      await setMeta(`cards_synced_${user.id}`, Date.now())
      if (!cancelled) setCards(remoteCards)
    })()
    return () => { cancelled = true }
  }, [cardsQuery.data, cardsQuery.dataUpdatedAt, cardsQuery.isSuccess, user.id])

  useEffect(() => {
    if (!foldersQuery.isError) return
    if (isNetworkLikeError(foldersQuery.error)) setIsOnline(false)
    else setError(foldersQuery.error?.message || 'Could not load folders')
  }, [foldersQuery.error, foldersQuery.isError])

  useEffect(() => {
    if (!foldersQuery.isSuccess) return
    let cancelled = false
    ;(async () => {
      const remoteFolders = foldersQuery.data || []
      const localFolders = await getLocalFolders(user.id)
      const remoteIds = new Set(remoteFolders.map(folder => folder.id))
      const removed = localFolders.filter(folder => !remoteIds.has(folder.id))
      if (removed.length) await Promise.all(removed.map(folder => deleteLocalFolder(folder.id)))
      await putFolders(remoteFolders)
      if (!cancelled) setFolders(remoteFolders)
    })()
    return () => { cancelled = true }
  }, [foldersQuery.data, foldersQuery.dataUpdatedAt, foldersQuery.isSuccess, user.id])

  useEffect(() => {
    setFolderMembershipLoading(placementsQuery.isFetching)
    if (placementsQuery.isSuccess) setFolderMembershipSynced(true)
  }, [placementsQuery.isFetching, placementsQuery.isSuccess])

  useEffect(() => {
    if (!placementsQuery.isError) return
    if (isNetworkLikeError(placementsQuery.error)) setIsOnline(false)
    else setError(placementsQuery.error?.message || 'Could not load folder placements')
  }, [placementsQuery.error, placementsQuery.isError])

  useEffect(() => {
    if (!placementsQuery.isSuccess) return
    const placementFolders = folders.length ? folders : (foldersQuery.data || [])
    const placementFolderIds = placementFolders.filter(f => f.type === 'binder').map(f => f.id)
    const deckIds = placementFolders.filter(f => f.type === 'deck').map(f => f.id)
    const folderCards = placementsQuery.data?.folderCards || []
    const deckAllocations = placementsQuery.data?.deckAllocations || []
    setCardFolderMap(buildCardFolderMap(placementFolders, [...folderCards, ...deckAllocations]))
    replaceLocalFolderCards(placementFolderIds, folderCards).catch(() => {})
    replaceDeckAllocations(deckIds, deckAllocations).catch(() => {})
    setMeta(`folder_cards_full_sync_${user.id}`, new Date().toISOString()).catch(() => {})
  }, [folders, foldersQuery.data, placementsQuery.data, placementsQuery.dataUpdatedAt, placementsQuery.isSuccess, user.id])

  useEffect(() => {
    setEnriching(sfMapQuery.isFetching)
    if (sfMapQuery.isSuccess) {
      setSfMap(sfMapQuery.data || {})
      if (!sfMapQuery.isFetching) setProgLabel('')
    }
    if (sfMapQuery.isError && !isNetworkLikeError(sfMapQuery.error)) {
      setError(sfMapQuery.error?.message || 'Could not load card metadata')
    }
  }, [sfMapQuery.data, sfMapQuery.error, sfMapQuery.isError, sfMapQuery.isFetching, sfMapQuery.isSuccess])

  // ── Load cards — IDB first, Supabase sync in background ──────────────────────
  const loadCardsLegacy = useCallback(async () => {
    const loadSeq = ++cardsLoadSeq.current
    const isCurrentLoad = () => loadSeq === cardsLoadSeq.current
    setLoading(true)

    // 1. Read from IDB immediately — instant render even offline
    const [localCards, cardsSyncedAt] = await Promise.all([
      getLocalCards(user.id),
      getMeta(`cards_synced_${user.id}`),
    ])
    const localCardsFresh = !!cardsSyncedAt && (Date.now() - Number(cardsSyncedAt) <= LOCAL_COLLECTION_FRESH_MS)
    const hydratedFromIdb = localCards.length > 0
    if (hydratedFromIdb) {
      console.log(`[Collection] IDB: ${localCards.length} cards (${localCardsFresh ? 'fresh' : 'stale'}, rendering immediately)`)
      if (isCurrentLoad()) {
        setCards(localCards)
        if (canSeedFilteredRef.current) setFiltered(localCards)
        startEnrichment(localCards)
      }
    }

    // 2. Sync from Supabase (skip if offline)
    if (!navigator.onLine) {
      if (isCurrentLoad()) setLoading(false)
      return
    }

    const allCards = []
    let pageFrom = 0, fetchComplete = false
    const PAGE = 1000
    while (true) {
      const { data, error: err } = await sb.from('cards')
        .select('*')
        .eq('user_id', user.id)
        // Stable pagination: name is not unique, so page boundaries can duplicate
        // rows unless we add a unique tie-breaker.
        .order('name')
        .order('id')
        .range(pageFrom, pageFrom + PAGE - 1)
      if (err) {
        if (isNetworkLikeError(err)) {
          if (isCurrentLoad()) setIsOnline(false)
        } else if (isCurrentLoad()) {
          setError(err.message)
        }
        break
      }
      if (data?.length) allCards.push(...data)
      if (!data || data.length < PAGE) { fetchComplete = true; break }
      pageFrom += PAGE
    }

    if (!isCurrentLoad()) return

    if (fetchComplete && !allCards.length) {
      if (localCards.length) {
        console.log(`[Collection] Supabase returned no cards; clearing ${localCards.length} local cards`)
        await deleteAllCards(user.id)
      }
      await setMeta(`cards_synced_${user.id}`, Date.now())
      if (isCurrentLoad()) {
        setCards([])
        setFiltered([])
      }
    } else if (allCards.length && fetchComplete) {
      // Prune IDB entries that no longer exist in Supabase (deleted cards)
      if (localCards.length) {
        const sbIds = new Set(allCards.map(c => c.id))
        const orphans = localCards.filter(c => !sbIds.has(c.id))
        if (orphans.length) {
          console.log(`[Collection] Pruning ${orphans.length} orphaned IDB cards`)
          await Promise.all(orphans.map(c => deleteCard(c.id)))
        }
      }
      // Persist to IDB for next offline load
      await putCards(allCards)
      await setMeta(`cards_synced_${user.id}`, Date.now())
      if (!isCurrentLoad()) return
      setCards(allCards)
      if (canSeedFilteredRef.current) setFiltered(allCards)
      if (!hydratedFromIdb) {
        startEnrichment(allCards)
      } else {
        const localIds = new Set(localCards.map(c => c.id))
        const newCards = allCards.filter(c => !localIds.has(c.id))
        if (newCards.length) {
          console.log(`[Collection] ${newCards.length} new cards synced from Supabase`)
          loadCardMapWithSharedPrices(allCards, { cacheTtlMs: ttlMsRef.current }).then(map => {
            if (isCurrentLoad()) setSfMap(map)
          })
        }
      }
    }

    if (isCurrentLoad()) setLoading(false)
  }, [user.id])

  // React Query now owns card fetching; keep legacy loader parked for rollback only.

  // ── Load folder membership ───────────────────────────────────────────────────
  useEffect(() => {
    return
    const loadFolderMembership = async () => {
      setFolderMembershipLoading(true)
      setFolderMembershipSynced(false)
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
      const { data: foldersData, error: foldersError } = await sb.from('folders')
        .select('id,name,type,description,updated_at').eq('user_id', user.id).order('name')
      if (foldersError) {
        console.warn('[Collection] Folder sync unavailable, keeping local folder data:', foldersError.message)
        if (isNetworkLikeError(foldersError)) setIsOnline(false)
        setFolderMembershipLoading(false)
        return
      }
      if (!foldersData?.length) {
        if (localFolders.length) {
          await Promise.all(localFolders.map(folder => deleteLocalFolder(folder.id)))
        }
        setFolders([])
        setCardFolderMap({})
        setFolderMembershipSynced(true)
        setFolderMembershipLoading(false)
        return
      }

      const remoteFolderIds = new Set(foldersData.map(f => f.id))
      const removedFolderIds = localFolders.map(f => f.id).filter(id => !remoteFolderIds.has(id))
      if (removedFolderIds.length) {
        await Promise.all(removedFolderIds.map(id => deleteLocalFolder(id)))
      }

      const placementFolders = foldersData.filter(folder => !isGroupFolder(folder))
      setFolders(placementFolders)
      await putFolders(foldersData)

      const placementFolderIds = placementFolders.filter(f => f.type === 'binder').map(f => f.id)
      const deckIds = placementFolders.filter(f => f.type === 'deck').map(f => f.id)
      const fullSyncKey = `folder_cards_full_sync_${user.id}`
      const deltaSyncKey = `folder_cards_delta_sync_${user.id}`

      const lastFullSync = await getMeta(fullSyncKey)
      const needsFullSync = !lastFullSync || Date.now() - new Date(lastFullSync).getTime() > FOLDER_CARDS_FULL_SYNC_MS

      if (!needsFullSync) {
        // Within the 10-min window — use IDB data, skip Supabase round-trips
        const [allFc, allDa] = await Promise.all([
          getAllLocalFolderCards(placementFolderIds),
          getAllDeckAllocationsForUser(user.id),
        ])
        setCardFolderMap(buildCardFolderMap(foldersData, [...allFc, ...allDa]))
        setFolderMembershipSynced(true)
        setFolderMembershipLoading(false)
        return
      }

      // Full sync: fetch folder_cards + deck_allocations in parallel
      const fetchFolderCards = async (folderIds) => {
        const rows = []
        let from = 0
        while (true) {
          const { data: page, error: err } = await sb.from('folder_cards')
            .select('id,card_id,folder_id,qty,updated_at')
            .in('folder_id', folderIds)
            .order('id')
            .range(from, from + 999)
          if (err) throw err
          if (page?.length) rows.push(...page)
          if (!page || page.length < 1000) break
          from += 1000
        }
        return rows
      }

      const fetchDeckAllocations = async (dIds, uid) => {
        const rows = []
        let from = 0
        while (true) {
          const { data: page, error: err } = await sb.from('deck_allocations')
            .select('id,card_id,deck_id,qty,user_id,updated_at')
            .eq('user_id', uid)
            .in('deck_id', dIds)
            .order('id')
            .range(from, from + 999)
          if (err) throw err
          if (page?.length) rows.push(...page)
          if (!page || page.length < 1000) break
          from += 1000
        }
        return rows
      }

      let allFc = []
      let allDa = []
      try {
        ;[allFc, allDa] = await Promise.all([
          placementFolderIds.length ? fetchFolderCards(placementFolderIds) : Promise.resolve([]),
          deckIds.length ? fetchDeckAllocations(deckIds, user.id) : Promise.resolve([]),
        ])
      } catch (err) {
        console.warn('[Collection] Placement sync unavailable, keeping local placement data:', err.message)
        if (isNetworkLikeError(err)) setIsOnline(false)
        setFolderMembershipLoading(false)
        return
      }

      await replaceLocalFolderCards(placementFolderIds, allFc)
      await replaceDeckAllocations(deckIds, allDa)

      const syncedAt = new Date().toISOString()
      await setMeta(fullSyncKey, syncedAt)
      await setMeta(deltaSyncKey, new Date(Date.now() - FOLDER_CARDS_DELTA_OVERLAP_MS).toISOString())
      setCardFolderMap(buildCardFolderMap(foldersData, [...allFc, ...allDa]))
      setFolderMembershipSynced(true)
      setFolderMembershipLoading(false)
    }
    loadFolderMembership()
  }, [user.id, folderMembershipReloadKey])

  // ── Debounce search ──────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  const sfMapForWorker = useMemo(() => {
    if (!cards.length || !sfMap) return {}
    const result = {}
    for (const card of cards) {
      const key = `${card.set_code}-${card.collector_number}`
      if (sfMap[key]) result[key] = sfMap[key]
    }
    return result
  }, [cards, sfMap])

  // ── Web Worker filtering ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!cards.length) { setFiltered([]); return }
    const id = ++workerReqId.current
    worker.postMessage({ id, cards, sfMap: sfMapForWorker, search, sort, filters, priceSource: price_source, cardFolderMap })
  }, [cards, sfMapForWorker, search, sort, filters, price_source, cardFolderMap])

  useEffect(() => {
    const handler = (e) => {
      if (e.data.id !== workerReqId.current) return
      setFiltered(e.data.result)
    }
    worker.addEventListener('message', handler)
    return () => worker.removeEventListener('message', handler)
  }, [])

  // ── Orphan detection — runs once per mount after both syncs complete ─────────
  const orphanCheckDone = useRef(false)
  useEffect(() => {
    if (loading || folderMembershipLoading || !isOnline || !folderMembershipSynced || !cards.length || orphanCheckDone.current) return
    orphanCheckDone.current = true
    const orphans = cards.filter(c => !cardFolderMap[c.id]?.length)
    if (!orphans.length) return

    let cancelled = false
    ;(async () => {
      try {
        console.log(`[Collection] Pruning ${orphans.length} unplaced collection cards`)
        const prunedIds = await pruneUnplacedCards(orphans.map(c => c.id))
        if (!cancelled && prunedIds.length) {
          const pruned = new Set(prunedIds)
          setCards(prev => prev.filter(c => !pruned.has(c.id)))
          setFiltered(prev => prev.filter(c => !pruned.has(c.id)))
        }
      } catch (err) {
        console.warn('[Collection] Could not prune unplaced cards:', err.message)
        if (isNetworkLikeError(err) || !navigator.onLine) {
          if (!cancelled) setIsOnline(false)
          return
        }
        if (!cancelled) setOrphanCards(orphans)
      }
    })()

    return () => { cancelled = true }
  }, [loading, folderMembershipLoading, folderMembershipSynced, cards, cardFolderMap, isOnline])

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
    if (blockOfflineChange()) return
    setError('')
    if (file?.name.endsWith('.txt') || file?.name.endsWith('.csv')) {
      // Text and CSV imports use ImportModal so imports are additive and never clear locations.
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
    const printByScryfallId = await ensureCardPrints(dedupedCards)
    const dedupedCardsWithPrints = dedupedCards.map(card =>
      withCardPrint(card, getCardPrint(printByScryfallId, card))
    )

    const CARD_BATCH = 200
    for (let i = 0; i < dedupedCardsWithPrints.length; i += CARD_BATCH) {
      const batch = dedupedCardsWithPrints.slice(i, i + CARD_BATCH).map(c => {
        const c2 = { ...c, user_id: user.id }
        if (c2.id == null) delete c2.id
        delete c2._localId; delete c2._binderName; return c2
      })
      const { error: err } = await sb.from('cards')
        .upsert(batch, { onConflict: 'user_id,card_print_id,foil,language,condition', ignoreDuplicates: false })
      if (err) { setError(`Import error: ${err.message}`); setImporting(false); return }
      setProgLabel(`Saving cards… (${Math.min(i + CARD_BATCH, dedupedCardsWithPrints.length)} / ${dedupedCardsWithPrints.length})`)
    }

    // ── Step 2: Fetch all DB cards to build a lookup map (set-col-foil-lang-cond → id) ─
    setProgLabel('Building card index…')
    let allDbCards = [], dbFrom = 0
    while (true) {
      const { data: page } = await sb.from('cards')
        .select('id,set_code,collector_number,foil,language,condition,card_print_id')
        .eq('user_id', user.id)
        .order('id')
        .range(dbFrom, dbFrom + 999)
      if (page?.length) allDbCards = [...allDbCards, ...page]
      if (!page || page.length < 1000) break
      dbFrom += 1000
    }
    // Key: "set_code-collector_number-foil-language-condition" (foil is boolean → "true"/"false")
    const cardKeyMap = {}
    for (const c of allDbCards) {
      cardKeyMap[`${c.card_print_id || `${c.set_code}-${c.collector_number}`}-${c.foil}-${c.language}-${c.condition}`] = c.id
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
          card_print_id: getCardPrint(printByScryfallId, c)?.id || null,
          foil: c.foil, qty: c.qty,
        }))
        if (items.length) {
          const { error: lie } = await sb.from('list_items')
            .upsert(items, { onConflict: 'folder_id,card_print_id,foil', ignoreDuplicates: false })
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
        const cardPrintId = getCardPrint(printByScryfallId, c)?.id || null
        const key = `${cardPrintId || `${c.set_code}-${c.collector_number}`}-${c.foil}-${c.language}-${c.condition}`
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

    // ── Done ────────────────────────────────────────────────────────────────
    let msg = `Done — ${dedupedCardsWithPrints.length} cards, ${folderOk}/${folderList.length} folders linked`
    if (totalMissed > 0) msg += ` (${totalMissed} card rows not matched)`
    if (folderFail > 0) setError(`${folderFail} folder(s) failed to link — check the browser console for details.`)
    setProgLabel(msg)
    setTimeout(() => setProgLabel(''), 8000)
    setImporting(false)
    invalidateCollectionQueries()
  }, [user.id, invalidateCollectionQueries, blockOfflineChange])

  // ── Bulk delete ──────────────────────────────────────────────────────────────
  const handleBulkDelete = async () => {
    if (blockOfflineChange()) return
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
          const { error: err } = await sb.from(sourceTable).update({ qty: row.remainingPlacementQty }).eq(sourceKey, row.sourceFolder.id).eq('card_id', row.id)
          if (err) { setError(err.message); return }
        } else {
          const { error: err } = await sb.from(sourceTable).delete().eq(sourceKey, row.sourceFolder.id).eq('card_id', row.id)
          if (err) { setError(err.message); return }
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
      const { error: delErr } = await sb.from('cards').delete().in('id', cardIds)
      if (delErr) { setError(delErr.message); return }
      await Promise.all(cardIds.map(id => deleteCard(id)))
    }
    for (const { id, remaining } of toUpdate) {
      const { error: updErr } = await sb.from('cards').update({ qty: remaining }).eq('id', id)
      if (updErr) { setError(updErr.message); return }
      const card = cards.find(c => c.id === id)
      if (card) await putCards([{ ...card, qty: remaining }])
    }
    const toDeleteSet = new Set(toDelete.map(row => row.id))
    setCards(prev => prev.map(c => {
      if (toDeleteSet.has(c.id)) return null
      const upd = toUpdate.find(u => u.id === c.id)
      return upd ? { ...c, qty: upd.remaining } : c
    }).filter(Boolean))
    invalidateCollectionQueries()
    setSelected(new Set()); setSplitState(new Map()); setSelectMode(false)
    toast.success(`Deleted ${selectedQty} ${selectedQty === 1 ? 'card' : 'cards'}.`)
  }

  const handleMoveToFolder = async (folder) => {
    if (blockOfflineChange()) return
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
    const destinationAddByCardId = new Map()
    const sourceMoveByKey = new Map()

    for (const row of selectedRows) {
      const sourceFolder = row.sourceFolder
      if (sourceFolder?.id === folder.id) continue

      destinationAddByCardId.set(row.card_id, (destinationAddByCardId.get(row.card_id) || 0) + row.qty)

      if (!sourceFolder) continue
      const sourceKey = `${sourceFolder.type}:${sourceFolder.id}:${row.card_id}`
      const existing = sourceMoveByKey.get(sourceKey)
      if (existing) {
        existing.qty += row.qty
      } else {
        sourceMoveByKey.set(sourceKey, {
          card_id: row.card_id,
          sourceFolder,
          sourceQty: row.sourceQty,
          qty: row.qty,
        })
      }
    }

    const payload = [...destinationAddByCardId.entries()].map(([cardId, qty]) => (
      folder.type === 'deck'
        ? {
            deck_id: folder.id,
            user_id: user.id,
            card_id: cardId,
            qty: qty + (existingQtyByCardId[cardId] || 0),
          }
        : {
            folder_id: folder.id,
            card_id: cardId,
            qty: qty + (existingQtyByCardId[cardId] || 0),
          }
    ))

    if (payload.length) {
      const selectColumns = folder.type === 'deck'
        ? 'id, deck_id, card_id, user_id, qty'
        : 'id, folder_id, card_id, qty, updated_at'
      const { data: upsertedRows, error: moveErr } = await sb
        .from(placementTable)
        .upsert(payload, { onConflict: `${placementKey},card_id` })
        .select(selectColumns)

      if (moveErr) {
        setError(moveErr.message)
        return
      }
      if (upsertedRows?.length) {
        if (folder.type === 'deck') await putDeckAllocations(upsertedRows).catch(() => {})
        else await putFolderCards(upsertedRows).catch(() => {})
      }
    }

    const sourceMoves = [...sourceMoveByKey.values()]
    const sourceGroups = new Map()
    for (const row of sourceMoves) {
      const sourceFolder = row.sourceFolder
      const sourceTable = sourceFolder.type === 'deck' ? 'deck_allocations' : 'folder_cards'
      const sourceKey = sourceFolder.type === 'deck' ? 'deck_id' : 'folder_id'
      const groupKey = `${sourceTable}:${sourceFolder.id}`
      const group = sourceGroups.get(groupKey) || {
        sourceTable,
        sourceKey,
        sourceId: sourceFolder.id,
        deleteCardIds: [],
        updateCardIdsByQty: new Map(),
      }
      const remaining = row.sourceQty - row.qty

      if (remaining > 0) {
        const updateIds = group.updateCardIdsByQty.get(remaining) || []
        updateIds.push(row.card_id)
        group.updateCardIdsByQty.set(remaining, updateIds)
      } else {
        group.deleteCardIds.push(row.card_id)
      }

      sourceGroups.set(groupKey, group)
    }

    const SOURCE_BATCH = 250
    for (const group of sourceGroups.values()) {
      for (let i = 0; i < group.deleteCardIds.length; i += SOURCE_BATCH) {
        const cardIds = group.deleteCardIds.slice(i, i + SOURCE_BATCH)
        const { error: sourceDeleteErr } = await sb
          .from(group.sourceTable)
          .delete()
          .eq(group.sourceKey, group.sourceId)
          .in('card_id', cardIds)

        if (sourceDeleteErr) {
          setError(sourceDeleteErr.message)
          return
        }
      }

      for (const [remaining, cardIdsForQty] of group.updateCardIdsByQty.entries()) {
        for (let i = 0; i < cardIdsForQty.length; i += SOURCE_BATCH) {
          const cardIds = cardIdsForQty.slice(i, i + SOURCE_BATCH)
          const { error: sourceUpdateErr } = await sb
            .from(group.sourceTable)
            .update({ qty: remaining })
            .eq(group.sourceKey, group.sourceId)
            .in('card_id', cardIds)

          if (sourceUpdateErr) {
            setError(sourceUpdateErr.message)
            return
          }
        }
      }
    }

    await setMeta(`folder_cards_full_sync_${user.id}`, 0)

    const sourceBinderIds = [...new Set(sourceMoves.filter(r => r.sourceFolder.type !== 'deck').map(r => r.sourceFolder.id))]
    const sourceDeckIds = [...new Set(sourceMoves.filter(r => r.sourceFolder.type === 'deck').map(r => r.sourceFolder.id))]
    if (sourceBinderIds.length) {
      const { data: freshFc } = await sb.from('folder_cards').select('id, folder_id, card_id, qty, updated_at').in('folder_id', sourceBinderIds)
      await replaceLocalFolderCards(sourceBinderIds, freshFc || []).catch(() => {})
    }
    if (sourceDeckIds.length) {
      const { data: freshDa } = await sb.from('deck_allocations').select('id, deck_id, user_id, card_id, qty').in('deck_id', sourceDeckIds)
      await replaceDeckAllocations(sourceDeckIds, freshDa || []).catch(() => {})
    }

    setCardFolderMap(prev => {
      const next = { ...prev }
      for (const row of sourceMoves) {
        const current = [...(next[row.card_id] || [])]
        const sourceIdx = current.findIndex(entry => entry.id === row.sourceFolder.id)
        if (sourceIdx >= 0) {
          const remaining = row.sourceQty - row.qty
          if (remaining > 0) {
            current[sourceIdx] = { ...current[sourceIdx], qty: remaining }
          } else {
            current.splice(sourceIdx, 1)
          }
        }
        if (current.length) next[row.card_id] = current
        else delete next[row.card_id]
      }
      for (const [cardId, addedQty] of destinationAddByCardId.entries()) {
        const current = [...(next[cardId] || [])]
        const existingIdx = current.findIndex(entry => entry.id === folder.id)
        const nextQty = addedQty + (existingQtyByCardId[cardId] || 0)
        const folderEntry = { id: folder.id, name: folder.name, type: folder.type, qty: nextQty }
        if (existingIdx >= 0) current[existingIdx] = folderEntry
        else current.push(folderEntry)
        next[cardId] = current
      }
      return next
    })

    queryClient.invalidateQueries({ queryKey: ['folderPlacements', user.id] })
    queryClient.invalidateQueries({ queryKey: ['sfMap', user.id] })
    setSelected(new Set()); setSplitState(new Map()); setSelectMode(false)
    const movedQty = selectedRows.reduce((sum, row) => (
      row.sourceFolder?.id === folder.id ? sum : sum + row.qty
    ), 0)
    if (movedQty > 0) toast.success(`Moved ${movedQty} ${movedQty === 1 ? 'card' : 'cards'} to ${folder.name}.`)
  }

  const handleDelete = async (card) => {
    if (blockOfflineChange()) return
    setError('')
    const selectedQty = card._folder_qty || card.qty || 1
    const nextOwnedQty = (cards.find(c => c.id === card.id)?.qty || card.qty || 1) - selectedQty
    const remainingFolders = card._displayFolder
      ? (cardFolderMap[card.id] || []).filter(folder => folder.id !== card._displayFolder.id)
      : []
    if (card._displayFolder) {
      const sourceTable = card._displayFolder.type === 'deck' ? 'deck_allocations' : 'folder_cards'
      const sourceKey = card._displayFolder.type === 'deck' ? 'deck_id' : 'folder_id'
      const { error: placementErr } = await sb.from(sourceTable)
        .delete()
        .eq(sourceKey, card._displayFolder.id)
        .eq('card_id', card.id)
      if (placementErr) {
        setError(placementErr.message)
        return
      }
      if (card._displayFolder.type === 'deck') await deleteDeckAllocationsByCardIds([card.id])
      else await deleteFolderCardsByCardIds([card.id])
      setCardFolderMap(prev => {
        const next = { ...prev }
        next[card.id] = (next[card.id] || []).filter(folder => folder.id !== card._displayFolder.id)
        if (!next[card.id]?.length) delete next[card.id]
        return next
      })
    }
    if (nextOwnedQty > 0 && remainingFolders.length > 0) {
      const { error: cardErr } = await sb.from('cards').update({ qty: nextOwnedQty }).eq('id', card.id)
      if (cardErr) {
        setError(cardErr.message)
        return
      }
      const updatedCard = { ...(cards.find(c => c.id === card.id) || card), qty: nextOwnedQty }
      await putCards([updatedCard])
      setCards(prev => prev.map(c => c.id === card.id ? updatedCard : c))
    } else {
      const { error: cardErr } = await sb.from('cards').delete().eq('id', card.id)
      if (cardErr) {
        setError(cardErr.message)
        return
      }
      await deleteCard(card.id)
      await deleteDeckAllocationsByCardIds([card.id])
      await deleteFolderCardsByCardIds([card.id])
      setCards(prev => prev.filter(c => c.id !== card.id))
    }
    await setMeta(`folder_cards_full_sync_${user.id}`, 0)
    orphanCheckDone.current = false
    invalidateCollectionQueries()
    setDetailCardKey(null)
    toast.success(`Deleted ${selectedQty} ${selectedQty === 1 ? 'card' : 'cards'}.`)
  }

  const handleCardSave = useCallback(async (updatedCard) => {
    // Update in-memory state → triggers worker re-filter/re-sort
    setCards(prev => prev.map(c => c.id === updatedCard.id ? { ...c, ...updatedCard } : c))
    if (updatedCard._displayFolder?.id && updatedCard._folder_qty != null) {
      setCardFolderMap(prev => {
        const next = { ...prev }
        const folderEntry = {
          id: updatedCard._displayFolder.id,
          name: updatedCard._displayFolder.name,
          type: updatedCard._displayFolder.type,
          qty: updatedCard._folder_qty,
        }
        if (updatedCard._replaceFolders) {
          next[updatedCard.id] = [folderEntry]
        } else {
          const current = next[updatedCard.id] || []
          next[updatedCard.id] = current.some(folder => folder.id === folderEntry.id)
            ? current.map(folder => folder.id === folderEntry.id ? folderEntry : folder)
            : [...current, folderEntry]
        }
        return next
      })
      await setMeta(`folder_cards_full_sync_${user.id}`, 0)
      queryClient.invalidateQueries({ queryKey: ['folderPlacements', user.id] })
    }
    await putCards([updatedCard])
    queryClient.invalidateQueries({ queryKey: ['cards', user.id] })
    queryClient.invalidateQueries({ queryKey: ['sfMap', user.id] })
  }, [queryClient, user.id])

  const displayCardsRef = useRef([])

  const SORT_OPTIONS = [
    ['name', 'Name A→Z'], ['price_desc', 'Price ↓'], ['price_asc', 'Price ↑'],
    ['pl_desc', 'P&L ↓'], ['pl_asc', 'P&L ↑'], ['cmc_asc', 'Mana ↑'],
    ['cmc_desc', 'Mana ↓'], ['qty', 'Quantity'], ['set', 'Set'],
    ['rarity', 'Rarity'], ['added', 'Recently Added'],
  ]
  const currentSortLabel = SORT_OPTIONS.find(([v]) => v === sort)?.[1] ?? 'Sort'

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

  const totalQty = useMemo(() => cards.reduce((s, c) => s + (c.qty || 1), 0), [cards])

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
    const seenCardIds = new Set()
    for (const card of filtered) {
      // Collection cards should be unique by cards.id. If stale local state or sync
      // briefly duplicates a row, drop later duplicates so React keys stay stable.
      if (seenCardIds.has(card.id)) continue
      seenCardIds.add(card.id)

      const allFolders = (cardFolderMap[card.id] || []).filter((folder, index, arr) =>
        arr.findIndex(candidate => candidate.id === folder.id) === index
      )
      const folders = usingPlacementView
        ? allFolders.filter(matchesLocationFilter)
        : allFolders
      if (usingPlacementView && allFolders.length > 0 && folders.length === 0) {
        continue
      }
      if (folders && folders.length > 1) {
        // One tile per folder membership — badge hidden, each tile is independently selectable
        folders.forEach((f) => {
          result.push({
            ...card,
            _displayKey: `${card.id}:${f.type}:${f.id}`,
            _displayFolder: f,
            _folder_qty: f.qty || 1,
            _multiFolder: true,
          })
        })
      } else {
        const folderQty = folders?.[0]?.qty || card.qty
        result.push({
          ...card,
          _displayKey: card.id,
          _displayFolder: folders?.[0] || null,
          _folder_qty: folderQty,
        })
      }
    }
    return result
  }, [filtered, cardFolderMap, filters])

  useEffect(() => { displayCardsRef.current = displayCards }, [displayCards])

  const selectableDisplayQty = useMemo(() =>
    displayCards.reduce((sum, card) => sum + (card._folder_qty ?? card.qty ?? 1), 0)
  , [displayCards])

  const selectedCard = detailCardKey ? displayCards.find(c => (c._displayKey || c.id) === detailCardKey) : null
  const selectedSf   = selectedCard ? sfMap[getScryfallKey(selectedCard)] : null

  const floatingStatusBadge = (
    <ConnectionStatusBadge
      isOnline={isOnline}
      loading={loading}
      folderMembershipLoading={folderMembershipLoading}
      enriching={enriching}
      importing={importing}
    />
  )
  const queryHasCardsPendingState = Array.isArray(cardsQuery.data) && cardsQuery.data.length > 0
  const collectionInitialLoading = !cards.length && (
    loading ||
    cardsQuery.isPending ||
    cardsQuery.isFetching ||
    queryHasCardsPendingState
  )

  if (collectionInitialLoading) {
    return (
      <>
        <EmptyState>Loading your collection...</EmptyState>
        {floatingStatusBadge}
      </>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className={styles.collectionHeader}>
        <SectionHeader
          title={`Collection${cards.length ? ` · ${cards.length} cards` : ''}`}
          action={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {!isOnline && <span style={{ fontSize: '0.72rem', color: '#e0a852', border: '1px solid rgba(224,168,82,0.3)', borderRadius: 3, padding: '3px 8px' }}>Offline</span>}
              <Button
                variant="purple"
                onClick={() => { if (!blockOfflineChange()) setShowAdd(true) }}
                disabled={!isOnline}
                title={!isOnline ? 'Reconnect to add cards' : undefined}
              >
                + Add Card
              </Button>
            </div>
          }
        />
      </div>

      {!collectionInitialLoading && cards.length === 0 ? (
        <div className={styles.emptyCollectionActions}>
          <DropZone
            onFile={handleImport}
            onActivate={() => {
              if (blockOfflineChange()) return
              setImportModalText('')
              setShowImportModal(true)
            }}
            accept=".csv,.txt"
            title="Import Your Collection"
            subtitle="Open the import flow, or drop a CSV or decklist file here." />
          <Link to="/scanner" className={styles.scannerQuickBox}>
            <div>
              <div className={styles.scannerQuickText}>Or you can scan your cards.</div>
            </div>
            <span className={styles.scannerQuickLink}>
              Open Scanner
            </span>
          </Link>
        </div>
      ) : (
        <>
        <div className={`${styles.mobileTopActions}${gridScrolled ? ' ' + styles.mobileTopActionsHidden : ''}`}>
          <Button
            variant="purple"
            onClick={() => { if (!blockOfflineChange()) setShowAdd(true) }}
            disabled={!isOnline}
            title={!isOnline ? 'Reconnect to add cards' : undefined}
          >+ Add Card</Button>
          <button
            className={styles.importBtn}
            onClick={() => { if (blockOfflineChange()) return; setImportModalText(''); setShowImportModal(true) }}
            disabled={!isOnline}
            title={!isOnline ? 'Reconnect to import cards' : undefined}
          >↑ Import</button>
          <button className={styles.importBtn} onClick={() => setShowExport(true)}>↓ Export</button>
        </div>

        <FilterBar
          search={searchInput} setSearch={setSearchInput}
          sort={sort} setSort={setSort}
          filters={filters} setFilters={setFilters}
          selectMode={selectMode} onToggleSelectMode={toggleSelectMode}
          sets={availableSets} languages={availableLanguages}
          filterOpen={filterOpen} onFilterOpenChange={setFilterOpen}
          hideActionsMobile
          hideSortFilterMobile={gridScrolled}
          extra={
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className={styles.importBtn}
                onClick={() => { if (blockOfflineChange()) return; setImportModalText(''); setShowImportModal(true) }}
                disabled={!isOnline}
                title={!isOnline ? 'Reconnect to import cards' : undefined}
              >↑ Import</button>
              <button className={styles.importBtn} onClick={() => setShowExport(true)}>↓ Export</button>
            </div>
          }
        />
        </>
      )}

      <ErrorBox>{error}</ErrorBox>
      {(enriching || importing) && <ProgressBar value={progress} label={progLabel} />}

      {cards.length > 0 && <>
        <div className={styles.gridHeader}>
          <span>Showing {filtered.length} of {cards.length} unique · {totalQty} total cards</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {!enriching && <span>Value: <strong style={{ color: 'var(--green)' }}>{formatPrice(totalValue, price_source)}</strong></span>}
          </span>
        </div>

        {isOnline && selectMode && selected.size > 0 && (
          <BulkActionBar
            selected={selected} selectedQty={selectedQty}
            total={selectableDisplayQty}
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
            onScroll={e => setGridScrolled(e.currentTarget.scrollTop > 50)}
          />
        </div>

        {filtered.length === 0 && !enriching && <EmptyState>No cards match your filters.</EmptyState>}

        <div className={`${styles.mobileBar}${gridScrolled ? ' ' + styles.mobileBarVisible : ''}`}>
          <ResponsiveMenu
            title="Sort Cards"
            forceSheet
            portal
            trigger={({ open, toggle }) => (
              <button className={`${styles.mobileBarSort}${open ? ' ' + styles.mobileBarSortOpen : ''}`} onClick={toggle}>
                {currentSortLabel} ▾
              </button>
            )}
          >
            {({ close }) => (
              <div className={uiStyles.responsiveMenuList}>
                {SORT_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    className={`${uiStyles.responsiveMenuAction}${sort === value ? ' ' + uiStyles.responsiveMenuActionActive : ''}`}
                    onClick={() => { setSort(value); close() }}
                  >
                    <span>{label}</span>
                    <span className={uiStyles.responsiveMenuCheck}>{sort === value ? '✓' : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </ResponsiveMenu>
          <button
            className={`${styles.mobileBarFilters}${filterOpen ? ' ' + styles.mobileBarFiltersOpen : ''}${hasActiveCollectionFilters(filters) ? ' ' + styles.mobileBarFiltersActive : ''}`}
            onClick={() => setFilterOpen(v => !v)}
          >
            {hasActiveCollectionFilters(filters) ? 'Filters •' : 'Filters'}
          </button>
        </div>
      </>}

      {selectedCard && (
        <CardDetail
          card={selectedCard} sfCard={selectedSf}
          folders={selectedCard._displayFolder ? [selectedCard._displayFolder] : (cardFolderMap[selectedCard.id] || [])}
          priceSource={price_source}
          currentFolderId={selectedCard._displayFolder?.id ?? null}
          currentFolderType={selectedCard._displayFolder?.type ?? null}
          onClose={() => setDetailCardKey(null)}
          onDelete={isOnline ? () => handleDelete(selectedCard) : undefined}
          deleteQty={selectedCard._folder_qty || selectedCard.qty || 1}
          onSave={isOnline ? handleCardSave : undefined}
          readOnly={!isOnline}
        />
      )}

      {showAdd && isOnline && (
        <AddCardModal userId={user.id}
          onClose={() => setShowAdd(false)}
          onSaved={async (result) => {
            if (result?.folder && result?.placements?.length) {
              const placementByCardId = new Map(result.placements.map(row => [row.card_id, row]))
              setCardFolderMap(prev => {
                const next = { ...prev }
                for (const row of result.placements) {
                  next[row.card_id] = [
                    ...(next[row.card_id] || []).filter(f => f.id !== result.folder.id),
                    {
                      id: result.folder.id,
                      name: result.folder.name,
                      type: result.folder.type,
                      qty: placementByCardId.get(row.card_id)?.qty || row.qty || 1,
                    },
                  ]
                }
                return next
              })
              if (result.folder.type === 'deck') await putDeckAllocations(result.placements)
              else await putFolderCards(result.placements)
            }
            await setMeta(`folder_cards_full_sync_${user.id}`, 0)
            orphanCheckDone.current = false
            setShowAdd(false)
            invalidateCollectionQueries()
          }}
        />
      )}

      {showImportModal && user && isOnline && (
        <ImportModal
          userId={user.id}
          folderType="binder"
          folders={folders.filter(f => ['binder', 'deck', 'list'].includes(f.type))}
          initialText={importModalText || undefined}
          allowTypeSelection
          onClose={() => setShowImportModal(false)}
          onSaved={async () => {
            setShowImportModal(false)
            orphanCheckDone.current = false
            await setMeta(`cards_synced_${user.id}`, 0)
            await setMeta(`folder_cards_full_sync_${user.id}`, 0)
            invalidateCollectionQueries()
          }}
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

      {orphanCards.length > 0 && isOnline && folderMembershipSynced && (
        <OrphanModal
          cards={orphanCards}
          folders={folders}
          userId={user.id}
          onAssigned={(assigned, folder, savedRows = []) => {
            const savedByCardId = new Map(savedRows.map(row => [row.card_id, row]))
            setCardFolderMap(prev => {
              const next = { ...prev }
              for (const c of assigned) {
                const saved = savedByCardId.get(c.id)
                next[c.id] = [{ id: folder.id, name: folder.name, type: folder.type, qty: saved?.qty || c.qty || 1 }]
              }
              return next
            })
            setOrphanCards([])
            queryClient.invalidateQueries({ queryKey: ['folderPlacements', user.id] })
          }}
          onDeleted={(deleted) => {
            const deletedSet = new Set(deleted.map(c => c.id))
            setCards(prev => prev.filter(c => !deletedSet.has(c.id)))
            setOrphanCards([])
            queryClient.invalidateQueries({ queryKey: ['cards', user.id] })
            queryClient.invalidateQueries({ queryKey: ['sfMap', user.id] })
          }}
        />
      )}

      {floatingStatusBadge}
    </div>
  )
}
