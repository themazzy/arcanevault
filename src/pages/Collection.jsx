import { useState, useEffect, useCallback, useRef, useMemo, startTransition } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { sb } from '../lib/supabase'
import { getScryfallKey, getPrice, formatPrice, getInstantCache, SCRYFALL_CACHE_TTL_MS } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { getLocalCards, putCards, deleteCard, deleteAllCards, putFolderCards, getLocalFolders, putFolders, setMeta, getMeta, deleteFolder as deleteLocalFolder, replaceLocalFolderCards, putDeckAllocations, replaceDeckAllocations, deleteDeckAllocationsByCardIds, deleteFolderCardsByCardIds } from '../lib/db'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { useToast } from '../components/ToastContext'
import { CardDetail, FilterBar, BulkActionBar, EMPTY_FILTERS } from '../components/CardComponents'
import VirtualCardGrid from '../components/VirtualCardGrid'
import VirtualCardTable from '../components/VirtualCardTable'
import { ProgressBar, ErrorBox, EmptyState, LibraryEmptyState, SectionHeader, Button, ResponsiveMenu, Select } from '../components/UI'
import { BrowserSkeleton } from '../components/Skeletons'
import { AddIcon, CheckIcon, CollectionIcon, ExportIcon, FilterIcon, GridViewIcon, ImportIcon, ScannerIcon, SettingsIcon, SortIcon, TableViewIcon } from '../icons'
import AddCardModal from '../components/AddCardModal'
import ExportModal from '../components/ExportModal'
import ImportModal from '../components/ImportModal'
import styles from './Collection.module.css'
import uiStyles from '../components/UI.module.css'
import { useBottomBarClearance, MOBILE_TOOLBAR_HEIGHT, HEADER_TOOLBAR_QUERY } from '../components/bottomBarClearance'
import { pruneUnplacedCards, findUnplacedCardIds } from '../lib/collectionOwnership'
import { hydrateCollectionQueriesFromIdb } from '../lib/idbQueryBridge'
import { fetchCollectionCards, fetchFolders, fetchFolderPlacements, fetchSfMap, hasUnrequestedCards } from '../lib/collectionFetchers'
import { isNetworkLikeError } from '../lib/networkUtils'
import { fetchAllByKeyset } from '../lib/keysetPager'
import { perfSpan } from '../lib/perf'
import { invalidateOwnedCollectionQueries } from '../lib/queryInvalidation'
import { getSelectedDisplayQuantity } from '../lib/collectionDisplay'
import { shouldOfferCardScanner } from '../lib/scannerAvailability'
import { useLibraryBrowserPreferences } from '../hooks/useLibraryBrowserPreferences'
import { useCardDetailNav, cardPeek } from '../hooks/useCardDetailNav'

const DEBOUNCE_MS = 300
const FOLDER_CARDS_STALE_MS = 10 * 60 * 1000
const COLLECTION_VIEW_MODES = new Set(['grid', 'table'])
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
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--s-border)' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.72rem', letterSpacing: '0.12em', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 6 }}>Unassigned Cards</div>
          <div style={{ fontSize: '0.88rem', color: 'var(--text-dim)' }}>
            {cards.length} card{cards.length !== 1 ? 's' : ''} found without a binder, deck, or wishlist. Assign them or delete.
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '12px 20px' }}>
          {cards.map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--s-border)', fontSize: '0.84rem' }}>
              <span style={{ color: 'var(--text)' }}>{c.name}</span>
              <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-serif)', fontSize: '0.76rem' }}>{(c.set_code || '').toUpperCase()}</span>
            </div>
          ))}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--s-border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Select
            title="Destination"
            value={selectedFolderId}
            onChange={e => setSelectedFolderId(e.target.value)}
            disabled={busy}
            style={{ width: '100%' }}
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
          </Select>

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
  const { price_source, default_sort, grid_density, show_price, loaded: settingsLoaded } = useSettings()
  const queryClient = useQueryClient()

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
  const [selectMode, setSelectMode] = useState(false)
  const { viewMode, setViewMode } = useLibraryBrowserPreferences('collection', { allowedViews: COLLECTION_VIEW_MODES })
  const [selected, setSelected] = useState(new Set())
  const [splitState, setSplitState] = useState(new Map())
  const [folders, setFolders] = useState([])
  const [cardFolderMap, setCardFolderMap] = useState({})
  const [folderMembershipLoading, setFolderMembershipLoading] = useState(true)
  const [folderMembershipSynced, setFolderMembershipSynced] = useState(false)
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
    queryKey: ['cards', user?.id],
    queryFn: () => fetchCollectionCards(user.id),
    staleTime: LOCAL_COLLECTION_FRESH_MS,
    enabled: !!user?.id,
  })

  const foldersQuery = useQuery({
    queryKey: ['folders', user?.id],
    queryFn: () => fetchFolders(user.id),
    staleTime: LOCAL_COLLECTION_FRESH_MS,
    enabled: !!user?.id,
  })

  const placementsQuery = useQuery({
    queryKey: ['folderPlacements', user?.id],
    queryFn: fetchFolderPlacements,
    staleTime: FOLDER_CARDS_STALE_MS,
    enabled: !!user?.id,
  })

  // Which card keys the last metadata fetch was ASKED for — not which it
  // returned. That distinction is what keeps the refetch below from looping:
  // ~0.3% of owned prints have no metadata available at all, so "did we get an
  // entry?" would mark them permanently missing and retrigger forever, while
  // "did we ask?" settles after one pass.
  const fetchedSfKeys = useRef(new Set())

  const sfMapQuery = useQuery({
    queryKey: ['sfMap', user?.id],
    queryFn: () => {
      // Snapshotted so the record matches exactly what was sent.
      const requested = cards
      fetchedSfKeys.current = new Set(requested.map(getScryfallKey).filter(Boolean))
      return fetchSfMap(
        requested,
        (pct, lbl) => {
          setProgress(pct)
          setProgLabel(lbl)
        },
        // Paint card art as soon as metadata lands, without waiting for the
        // price stage that follows it. The query's own result still arrives
        // below with prices attached and replaces this.
        metadataMap => setSfMap(metadataMap),
      )
    },
    staleTime: SCRYFALL_CACHE_TTL_MS,
    enabled: !!user?.id && cards.length > 0,
    placeholderData: {},
  })

  // Cards added on ANOTHER device arrive through the cards sync, but nothing
  // re-runs this query: its key is ['sfMap', userId] with no card dependency
  // and a 24h staleTime, and invalidateOwnedCollectionQueries only fires for
  // mutations made on THIS device. So a binder filled on a phone showed up on
  // a laptop as rows with no art and no price, until the next full page load
  // reseeded `cards` from IDB.
  //
  // Guarded three ways against refetch storms: nothing while a fetch is in
  // flight, nothing before the first fetch has completed, and the comparison
  // is against what was requested rather than what came back.
  useEffect(() => {
    if (!user?.id || !cards.length) return
    if (sfMapQuery.isFetching || !sfMapQuery.isSuccess) return
    if (hasUnrequestedCards(cards, fetchedSfKeys.current)) {
      queryClient.invalidateQueries({ queryKey: ['sfMap', user.id] })
    }
  }, [cards, user?.id, queryClient, sfMapQuery.isFetching, sfMapQuery.isSuccess])

  const invalidateCollectionQueries = useCallback(() => {
    invalidateOwnedCollectionQueries(queryClient, user.id, {
      includeFolders: true,
      includeCards: true,
    })
  }, [queryClient, user.id])

  const _loadCards = useCallback(async () => {
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

  // Seeds the sort from settings once, when they finish loading. `default_sort`
  // is deliberately not a dependency: re-running on every change to it would
  // clobber the sort the user picked this session each time settings re-sync.
  useEffect(() => {
    if (settingsLoaded) setSort(default_sort || 'name')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed-once, see above
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

      // Paint from the rows we already have, before touching IDB. Everything
      // below is cache maintenance — a whole-collection read followed by a
      // whole-collection write — and nothing in the render depends on it having
      // finished. Painting after it kept the page on its loading state for the
      // length of two IDB passes over the entire collection even when the data
      // was already in hand, which is long enough to see on a large one.
      if (!cancelled && remoteCards.length) setCards(remoteCards)

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
    // Prefer the folders fetched WITH the placements (same snapshot) so a
    // just-created binder's rows aren't dropped by buildCardFolderMap while the
    // component's `folders` state is still catching up.
    const placementFolders = placementsQuery.data?.folders?.length
      ? placementsQuery.data.folders
      : (folders.length ? folders : (foldersQuery.data || []))
    const placementFolderIds = placementFolders.filter(f => f.type === 'binder').map(f => f.id)
    const deckIds = placementFolders.filter(f => f.type === 'deck').map(f => f.id)
    const folderCards = placementsQuery.data?.folderCards || []
    const deckAllocations = placementsQuery.data?.deckAllocations || []
    setCardFolderMap(buildCardFolderMap(placementFolders, [...folderCards, ...deckAllocations]))
    replaceLocalFolderCards(placementFolderIds, folderCards).catch(() => {})
    replaceDeckAllocations(deckIds, deckAllocations).catch(() => {})
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

  // ── Scryfall enrichment ──────────────────────────────────────────────────────
  const startEnrichment = useCallback(async (rawCards) => {
    if (enrichingRef.current) return

    enrichingRef.current = true
    setEnriching(true); setProgress(0)
    try {
      const map = await loadCardMapWithSharedPrices(rawCards, {
        onProgress: (pct, lbl) => { setProgress(pct); setProgLabel(lbl) },
        priceLookup: 'set',
      })
      setSfMap(map)
    } catch (err) {
      console.warn('[Collection] enrichment failed; cards will retry on next load', err?.message || err)
      try {
        const partial = await getInstantCache()
        if (partial) setSfMap(partial)
      } catch {}
    } finally {
      setEnriching(false); setProgLabel('')
      enrichingRef.current = false
    }
  }, [])

  // ── Load cards — IDB first, Supabase sync in background ──────────────────────
  const _loadCardsLegacy = useCallback(async () => {
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

    let allCards = []
    let fetchComplete = false
    try {
      // Keyset-paged and ordered by id: server-side ORDER BY name on the view
      // forces a top-N heapsort over the full join, and OFFSET paging re-pays
      // the card_prints join for every skipped row — both time out on big
      // collections. The filter worker re-sorts client-side.
      allCards = await fetchAllByKeyset(() => sb.from('owned_cards_view')
        .select('*')
        .eq('user_id', user.id))
      fetchComplete = true
    } catch (err) {
      if (isNetworkLikeError(err)) {
        if (isCurrentLoad()) setIsOnline(false)
      } else if (isCurrentLoad()) {
        setError(err.message)
      }
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
      // The sync lands while the user is already looking at (and scrolling) the
      // IDB-seeded list, so swapping the whole collection in is non-urgent —
      // let React interrupt it for input. The first paint above stays urgent.
      startTransition(() => {
        setCards(allCards)
        if (canSeedFilteredRef.current) setFiltered(allCards)
      })
      if (!hydratedFromIdb) {
        startEnrichment(allCards)
      } else {
        const localIds = new Set(localCards.map(c => c.id))
        const newCards = allCards.filter(c => !localIds.has(c.id))
        if (newCards.length) {
          console.log(`[Collection] ${newCards.length} new cards synced from Supabase`)
          loadCardMapWithSharedPrices(allCards, { priceLookup: 'set' }).then(map => {
            if (isCurrentLoad()) setSfMap(map)
          })
        }
      }
    }

    if (isCurrentLoad()) setLoading(false)
  }, [user.id])

  // ── Debounce search ──────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  // Build lean projections of the data the worker actually reads, scoped per card.
  // This shrinks the postMessage payload by ~5x and keeps the snapshot stable across
  // unrelated card-row changes (e.g., updated_at edits don't trigger a resend).
  const workerSnapshot = useMemo(() => {
    if (!cards.length) return { leanCards: [], leanSfMap: {} }
    const endSnapshot = perfSpan('collection-worker-snapshot')
    const leanCards = new Array(cards.length)
    const leanSfMap = {}
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i]
      leanCards[i] = {
        id: c.id,
        name: c.name,
        set_code: c.set_code,
        collector_number: c.collector_number,
        foil: c.foil,
        qty: c.qty,
        purchase_price: c.purchase_price,
        added_at: c.added_at,
        condition: c.condition,
        language: c.language,
        altered: c.altered,
        misprint: c.misprint,
      }
      const key = `${c.set_code}-${c.collector_number}`
      const sf = sfMap?.[key]
      if (sf && !leanSfMap[key]) {
        leanSfMap[key] = {
          rarity: sf.rarity,
          type_line: sf.type_line,
          oracle_text: sf.oracle_text,
          artist: sf.artist,
          color_identity: sf.color_identity,
          legalities: sf.legalities,
          cmc: sf.cmc,
          power: sf.power,
          toughness: sf.toughness,
          prices: sf.prices,
          set_name: sf.set_name,
        }
      }
    }
    endSnapshot()
    return { leanCards, leanSfMap }
  }, [cards, sfMap])

  // ── Web Worker filtering ─────────────────────────────────────────────────────
  // Keep a stable id→card map so the worker can return only IDs (cheap structured clone)
  // and we reconstruct the ordered list locally without copying card objects across threads.
  const cardsByIdRef = useRef(new Map())
  useEffect(() => {
    const m = new Map()
    for (const c of cards) m.set(c.id, c)
    cardsByIdRef.current = m
  }, [cards])

  // Send the heavy snapshot only when the underlying data changes (not on filter changes).
  useEffect(() => {
    worker.postMessage({
      type: 'snapshot',
      cards: workerSnapshot.leanCards,
      sfMap: workerSnapshot.leanSfMap,
      cardFolderMap,
    })
  }, [workerSnapshot, cardFolderMap])

  useEffect(() => {
    if (!cards.length) { setFiltered([]); return }
    const id = ++workerReqId.current
    // Filter-only message — tiny payload, reuses the worker's cached snapshot.
    worker.postMessage({ id, search, sort, filters, priceSource: price_source })
  }, [cards.length, workerSnapshot, search, sort, filters, price_source, cardFolderMap])

  useEffect(() => {
    const handler = (e) => {
      if (e.data.id !== workerReqId.current) return
      // Committing a filter result rebuilds every derived list over the whole
      // collection (displayCards spreads a row per card, totals re-price every
      // card). At ~12k cards that's one long task — a 'message' handler taking
      // 300ms+ — that blocks typing and scrolling while it runs. As a
      // transition React chunks it and keeps the previous list interactive
      // until the new one is ready.
      const apply = () => {
        // Backwards-compatible: if worker returns `result` use it, else reconstruct from `ids`.
        if (e.data.ids) {
          const m = cardsByIdRef.current
          const out = []
          for (const id of e.data.ids) {
            const c = m.get(id)
            if (c) out.push(c)
          }
          setFiltered(out)
        } else {
          setFiltered(e.data.result)
        }
      }
      startTransition(apply)
    }
    worker.addEventListener('message', handler)
    return () => worker.removeEventListener('message', handler)
  }, [])

  // ── Orphan detection — runs once per mount after both syncs complete ─────────
  const orphanCheckDone = useRef(false)
  useEffect(() => {
    if (loading || folderMembershipLoading || !isOnline || !folderMembershipSynced || !cards.length || orphanCheckDone.current) return
    orphanCheckDone.current = true
    // Judge "placed" from the raw placement rows, not the folder-resolved
    // cardFolderMap: buildCardFolderMap drops placements for folders that aren't
    // in `folders` yet (e.g. a just-created binder), which would otherwise flag
    // freshly-added cards as orphans and prune them.
    const orphanIds = findUnplacedCardIds(cards, placementsQuery.data, cardFolderMap)
    if (!orphanIds.length) return
    const orphanIdSet = new Set(orphanIds)
    const orphans = cards.filter(c => orphanIdSet.has(c.id))

    let cancelled = false
    ;(async () => {
      try {
        console.log(`[Collection] Pruning ${orphanIds.length} unplaced collection cards`)
        const prunedIds = await pruneUnplacedCards(orphanIds)
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
  }, [loading, folderMembershipLoading, folderMembershipSynced, cards, cardFolderMap, isOnline, placementsQuery.data])

  // ── Import ───────────────────────────────────────────────────────────────────
  const handleImport = useCallback(async (file) => {
    if (blockOfflineChange()) return
    setError('')
    if (file?.name.endsWith('.txt') || file?.name.endsWith('.csv')) {
      // Text and CSV imports go through ImportModal: additive, non-destructive,
      // and it rebuilds the binder/deck/list structure encoded in the CSV.
      const text = await file.text()
      setImportModalText(text)
      setShowImportModal(true)
      return
    }
    setError('Please upload a .csv or .txt file.')
  }, [blockOfflineChange])

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
    // Group placement deletes by (table, folder_id) so we can use .in('card_id', [...])
    const deleteGroups = new Map() // key: `${table}|${folderId}` → { table, key, folderId, cardIds[] }
    const updateOps = [] // each row needs its own qty, so run in parallel
    for (const row of placementRows) {
      if (!row.sourceFolder) continue
      const table = row.sourceFolder.type === 'deck' ? 'deck_allocations' : 'folder_cards'
      const keyCol = row.sourceFolder.type === 'deck' ? 'deck_id' : 'folder_id'
      if (row.remainingPlacementQty > 0) {
        updateOps.push({ table, keyCol, folderId: row.sourceFolder.id, cardId: row.id, qty: row.remainingPlacementQty })
      } else {
        const k = `${table}|${row.sourceFolder.id}`
        let g = deleteGroups.get(k)
        if (!g) { g = { table, keyCol, folderId: row.sourceFolder.id, cardIds: [] }; deleteGroups.set(k, g) }
        g.cardIds.push(row.id)
      }
    }
    const placementResults = await Promise.all([
      ...Array.from(deleteGroups.values()).flatMap(g => {
        const out = []
        for (let i = 0; i < g.cardIds.length; i += BATCH) {
          const slice = g.cardIds.slice(i, i + BATCH)
          out.push(sb.from(g.table).delete().eq(g.keyCol, g.folderId).in('card_id', slice))
        }
        return out
      }),
      ...updateOps.map(op => sb.from(op.table).update({ qty: op.qty }).eq(op.keyCol, op.folderId).eq('card_id', op.cardId)),
    ])
    for (const r of placementResults) {
      if (r.error) { setError(r.error.message); return }
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
    const updateResults = await Promise.all(
      toUpdate.map(({ id, remaining }) => sb.from('cards').update({ qty: remaining }).eq('id', id))
    )
    for (const r of updateResults) {
      if (r.error) { setError(r.error.message); return }
    }
    await Promise.all(toUpdate.map(({ id, remaining }) => {
      const card = cards.find(c => c.id === id)
      return card ? putCards([{ ...card, qty: remaining }]) : null
    }).filter(Boolean))
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

    invalidateOwnedCollectionQueries(queryClient, user.id)
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
      invalidateOwnedCollectionQueries(queryClient, user.id)
    }
    await putCards([updatedCard])
    invalidateOwnedCollectionQueries(queryClient, user.id, {
      includeCards: true,
      includePlacements: false,
    })
  }, [queryClient, user.id])

  const SORT_OPTIONS = [
    ['name', 'Name A→Z'], ['name_desc', 'Name Z→A'],
    ['price_desc', 'Price ↓'], ['price_asc', 'Price ↑'],
    ['pl_desc', 'P&L ↓'], ['pl_asc', 'P&L ↑'],
    ['cmc_asc', 'Mana Value ↑'], ['cmc_desc', 'Mana Value ↓'],
    ['rarity', 'Rarity'], ['set', 'Set'],
    ['qty', 'Quantity'], ['added', 'Recently Added'],
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

  const totalValue = useMemo(() => cards.reduce((s, c) => {
    const p = getPrice(sfMap[getScryfallKey(c)], c.foil, { price_source })
    return s + (p != null ? p * c.qty : 0)
  }, 0), [cards, sfMap, price_source])

  const totalQty = useMemo(() => cards.reduce((s, c) => s + (c.qty || 1), 0), [cards])

  const availableSets = useMemo(() => {
    const seen = {}
    for (const c of cards) {
      if (!c.set_code) continue  // skip rows missing set_code (e.g. mid-sync orphans)
      if (!seen[c.set_code]) {
        const sf = sfMap[`${c.set_code}-${c.collector_number}`]
        seen[c.set_code] = sf?.set_name || c.set_code.toUpperCase() || c.set_code
      }
    }
    return Object.entries(seen)
      .map(([code, name]) => ({ code, name: name || code }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [cards, sfMap])

  const availableLanguages = useMemo(() => {
    const seen = new Set(cards.map(c => c.language).filter(Boolean))
    return [...seen].sort()
  }, [cards])

  // Expand cards that are in multiple folders into separate display entries
  const displayCards = useMemo(() => {
    const endDisplay = perfSpan('collection-display-cards')
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
    endDisplay()
    return result
  }, [filtered, cardFolderMap, filters])

  const selectedQty = useMemo(
    () => getSelectedDisplayQuantity(displayCards, selected, splitState),
    [displayCards, selected, splitState],
  )

  const selectableDisplayQty = useMemo(() =>
    displayCards.reduce((sum, card) => sum + (card._folder_qty ?? card.qty ?? 1), 0)
  , [displayCards])

  const selectedCard = detailCardKey ? displayCards.find(c => (c._displayKey || c.id) === detailCardKey) : null
  const selectedSf   = selectedCard ? sfMap[getScryfallKey(selectedCard)] : null

  // Prev/Next in the detail modal. Both the grid and the table render
  // `displayCards` verbatim, so it already is the on-screen order.
  const browseOrder = useMemo(() => displayCards.map(c => c._displayKey || c.id), [displayCards])
  const getDetailPeek = useCallback(key => {
    if (key == null) return null
    const c = displayCards.find(x => (x._displayKey || x.id) === key)
    return cardPeek(c, c ? sfMap[getScryfallKey(c)] : null)
  }, [displayCards, sfMap])
  const detailNav = useCardDetailNav(browseOrder, detailCardKey, setDetailCardKey, getDetailPeek)

  const queryHasCardsPendingState = Array.isArray(cardsQuery.data) && cardsQuery.data.length > 0
  const collectionInitialLoading = !cards.length && (
    loading ||
    cardsQuery.isPending ||
    cardsQuery.isFetching ||
    queryHasCardsPendingState
  )
  const showScanner = shouldOfferCardScanner()

  // Collection renders headerFloatingToolbar directly rather than through
  // ResponsiveHeaderActions, so it registers its own bottom-bar clearance. Its
  // BulkActionBar is in-flow (no floatingMobile), so the toolbar is the only
  // claimant and it stands down while the bulk bar is up.
  const collectionToolbarMounted = !(selectMode && selected.size > 0)
  useBottomBarClearance({
    active: collectionToolbarMounted,
    height: MOBILE_TOOLBAR_HEIGHT,
    query: HEADER_TOOLBAR_QUERY,
  })

  if (collectionInitialLoading) {
    return <BrowserSkeleton viewMode={viewMode} label="Loading your collection" />
  }

  return (
    <div className={styles.collectionPage}>
      <div className={styles.collectionHeader}>
        <SectionHeader
          title={`Collection${cards.length ? ` · ${cards.length} cards` : ''}`}
          action={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {cards.length > 0 && (
                <Button
                  variant="purple"
                  onClick={() => { if (!blockOfflineChange()) setShowAdd(true) }}
                  disabled={!isOnline}
                  title={!isOnline ? 'Reconnect to add cards' : undefined}
                >
                  + Add Card
                </Button>
              )}
            </div>
          }
        />
      </div>

      {!collectionInitialLoading && cards.length === 0 ? (
        <LibraryEmptyState
          icon={<CollectionIcon size={34} />}
          title="Add your first cards"
          description="Import a collection file or start with one card. Every owned card stays organised in a binder or collection deck."
          importAction={{
            label: 'Import cards',
            description: 'Drop a .csv or .txt decklist here, or click to paste or upload.',
            onClick: () => {
              if (blockOfflineChange()) return
              setImportModalText('')
              setShowImportModal(true)
            },
            onFile: handleImport,
            disabled: !isOnline,
            disabledTitle: !isOnline ? 'Reconnect to import cards' : undefined,
          }}
          manualAction={{
            label: 'Add one card',
            icon: <AddIcon size={14} />,
            onClick: () => { if (!blockOfflineChange()) setShowAdd(true) },
            disabled: !isOnline,
            disabledTitle: !isOnline ? 'Reconnect to add cards' : undefined,
          }}
          footer={showScanner ? (
            <Link to="/scanner" className={styles.emptyScannerLink}>
              <ScannerIcon size={14} /> Scan physical cards with your camera
            </Link>
          ) : null}
        />
      ) : (
        <>
        <FilterBar
          search={searchInput} setSearch={setSearchInput}
          sort={sort} setSort={setSort}
          filters={filters} setFilters={setFilters}
          selectMode={selectMode} onToggleSelectMode={toggleSelectMode}
          sets={availableSets} languages={availableLanguages}
          filterOpen={filterOpen} onFilterOpenChange={setFilterOpen}
          hideActionsMobile
          hideSortFilterMobile
          extra={
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className={styles.refreshBtn}
                onClick={() => { if (blockOfflineChange()) return; setImportModalText(''); setShowImportModal(true) }}
                disabled={!isOnline}
                title={!isOnline ? 'Reconnect to import cards' : undefined}
              >↑ Import</button>
              <button className={styles.refreshBtn} onClick={() => setShowExport(true)}>↓ Export</button>
            </div>
          }
        />
        </>
      )}

      <ErrorBox>{error}</ErrorBox>
      {enriching && progLabel && <ProgressBar value={progress} label={progLabel} />}

      {cards.length > 0 && <>
        <div className={`${styles.gridHeader}${gridScrolled ? ' ' + styles.gridHeaderHidden : ''}`}>
          <span>Showing {filtered.length} of {cards.length} unique · {totalQty} total cards</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {!enriching && <span>Value: <strong style={{ color: 'var(--green)' }}>{formatPrice(totalValue, price_source)}</strong></span>}
            <span className={styles.collectionViewToggle} aria-label="Collection view">
              <button className={viewMode === 'grid' ? styles.collectionViewActive : ''} onClick={() => setViewMode('grid')} title="Grid view" aria-label="Grid view" aria-pressed={viewMode === 'grid'}>
                <GridViewIcon size={14} />
              </button>
              <button className={viewMode === 'table' ? styles.collectionViewActive : ''} onClick={() => setViewMode('table')} title="Table view" aria-label="Table view" aria-pressed={viewMode === 'table'}>
                <TableViewIcon size={14} />
              </button>
            </span>
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
          {viewMode === 'table' ? (
            <VirtualCardTable
              cards={displayCards} sfMap={sfMap} loading={enriching}
              onSelect={c => setDetailCardKey(c._displayKey || c.id)}
              selectMode={selectMode} selected={selected} onToggleSelect={toggleSelect}
              splitState={splitState} onAdjustQty={onAdjustQty}
              priceSource={price_source} showPrice={show_price}
              cardFolders={cardFolderMap}
              onScroll={e => setGridScrolled(e.currentTarget.scrollTop > 50)}
            />
          ) : (
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
          )}
        </div>

        {filtered.length === 0 && !enriching && <EmptyState>No cards match your filters.</EmptyState>}

        {!(selectMode && selected.size > 0) && (
          /* Bottom-pinned below 980px — clearance registered by
             collectionToolbarMounted above so the toast stack clears it. */
          <div className={`${uiStyles.headerFloatingToolbar} ${styles.collectionToolbar}`} aria-label="Collection actions">
            {selectMode ? (
              <Button variant="default" size="sm" onClick={toggleSelectMode} title="Exit select mode" aria-label="Exit select mode">
                <CheckIcon size={14} /> <span>Done</span>
              </Button>
            ) : (
              <Button
                variant="purple"
                size="sm"
                onClick={() => { if (!blockOfflineChange()) setShowAdd(true) }}
                disabled={!isOnline}
                title={!isOnline ? 'Reconnect to add cards' : 'Add card'}
              >
                <AddIcon size={14} /> <span>Add Card</span>
              </Button>
            )}
            <ResponsiveMenu
              title="Sort Cards"
              portal
              trigger={({ toggle }) => (
                <Button variant="ghost" size="sm" onClick={toggle} title={currentSortLabel} aria-label="Sort cards">
                  <SortIcon size={14} /> <span>Sort</span>
                </Button>
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
                      <span className={uiStyles.responsiveMenuCheck}>{sort === value ? <CheckIcon size={12} /> : null}</span>
                    </button>
                  ))}
                </div>
              )}
            </ResponsiveMenu>
            <Button
              variant={hasActiveCollectionFilters(filters) ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilterOpen(v => !v)}
              aria-pressed={filterOpen}
              title="Filters"
            >
              <FilterIcon size={14} /> <span>Filters</span>
            </Button>
            <ResponsiveMenu
              title="Collection Actions"
              portal
              trigger={({ toggle }) => (
                <Button variant="ghost" size="sm" onClick={toggle} title="More actions" aria-label="More collection actions">
                  <SettingsIcon size={14} /> <span>More</span>
                </Button>
              )}
            >
              {({ close }) => (
                <div className={uiStyles.responsiveMenuList}>
                  <button
                    className={uiStyles.responsiveMenuAction}
                    disabled={!isOnline}
                    onClick={() => { if (blockOfflineChange()) return; setImportModalText(''); setShowImportModal(true); close() }}
                  >
                    <span><ImportIcon size={14} /> Import</span>
                  </button>
                  <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowExport(true); close() }}>
                    <span><ExportIcon size={14} /> Export</span>
                  </button>
                  <button className={uiStyles.responsiveMenuAction} onClick={() => { toggleSelectMode(); close() }}>
                    <span><CheckIcon size={14} /> {selectMode ? 'Exit select mode' : 'Select cards'}</span>
                  </button>
                  <button
                    className={`${uiStyles.responsiveMenuAction}${viewMode === 'grid' ? ' ' + uiStyles.responsiveMenuActionActive : ''}`}
                    onClick={() => { setViewMode('grid'); close() }}
                  >
                    <span><GridViewIcon size={14} /> Grid view</span>
                    <span className={uiStyles.responsiveMenuCheck}>{viewMode === 'grid' ? <CheckIcon size={12} /> : null}</span>
                  </button>
                  <button
                    className={`${uiStyles.responsiveMenuAction}${viewMode === 'table' ? ' ' + uiStyles.responsiveMenuActionActive : ''}`}
                    onClick={() => { setViewMode('table'); close() }}
                  >
                    <span><TableViewIcon size={14} /> Table view</span>
                    <span className={uiStyles.responsiveMenuCheck}>{viewMode === 'table' ? <CheckIcon size={12} /> : null}</span>
                  </button>
                  {showScanner && (
                    <Link to="/scanner" className={uiStyles.responsiveMenuAction} style={{ textDecoration: 'none' }} onClick={() => close()}>
                      <span><ScannerIcon size={14} /> Scan cards</span>
                    </Link>
                  )}
                </div>
              )}
            </ResponsiveMenu>
          </div>
        )}
      </>}

      {selectedCard && (
        <CardDetail
          {...detailNav}
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
            invalidateOwnedCollectionQueries(queryClient, user.id)
          }}
          onDeleted={(deleted) => {
            const deletedSet = new Set(deleted.map(c => c.id))
            setCards(prev => prev.filter(c => !deletedSet.has(c.id)))
            setOrphanCards([])
            invalidateOwnedCollectionQueries(queryClient, user.id, {
              includeCards: true,
              includePlacements: false,
            })
          }}
        />
      )}
    </div>
  )
}
