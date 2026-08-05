import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { getPrice, formatPrice, getScryfallKey } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { useSettings } from '../components/SettingsContext'
import { useAuth } from '../components/Auth'
import { useToast } from '../components/ToastContext'
import { CardDetail, FilterBar, BulkActionBar, EMPTY_FILTERS } from '../components/CardComponents'
import { EmptyState, LibraryEmptyState, Button, ConfirmModal, ResponsiveMenu } from '../components/UI'
import { ChevronLeftIcon, EditIcon, ImageIcon, ImportIcon, ExportIcon, AddIcon, BuilderIcon, DeckIcon, RemoveIcon, SettingsIcon, DeleteIcon } from '../icons'
import AddCardModal from '../components/AddCardModal'
import CardArtPicker from '../components/CardArtPicker'
import ExportModal from '../components/ExportModal'
import ImportModal from '../components/ImportModal'
import { CardBrowserViewControls, CardBrowserContent } from '../components/CardBrowserViews'
import CardImg from '../components/CardImg'
import styles from './DeckBrowser.module.css'
import uiStyles from '../components/UI.module.css'
import { parseDeckMeta, serializeDeckMeta } from '../lib/deckBuilderApi'
import { TYPE_GROUPS, classifyCardType } from '../lib/cardTypeGroup'
import { buildPairSnapshot, buildSyncDiff, getSyncState, isUniqueNameConflict, linkDeckPair, markLinkedPairUnsynced, reconcileCleanPair, renameFolder, resolveBuilderNameConflict, summarizeSyncDiff, withLinkedPair, writeSyncState } from '../lib/deckSync'
import { useFilterWorker } from '../hooks/useFilterWorker'
import { useVisibleOrder, useCardDetailNav, cardPeek } from '../hooks/useCardDetailNav'
import { parseFolderBgUrl } from '../lib/folderBackground'
import { getPlacedQtyByCardIds, pruneUnplacedCards } from '../lib/collectionOwnership'
import { fetchDeckAllocations, fetchDeckCards } from '../lib/deckData'
import { getDeckAllocations, getCardsByIds, replaceDeckAllocations, putCards, putDeckAllocations, putFolderCards } from '../lib/db'
import { queryClient } from '../lib/queryClient'
import { invalidateOwnedCollectionQueries } from '../lib/queryInvalidation'
import { toDeckCardRow } from '../lib/deckBuilderWrites'
import { CAT_ORDER, getCardCategoryFromCard } from '../lib/cardCategory'
import { boardForCard } from '../lib/attractions'
import { useLibraryBrowserPreferences } from '../hooks/useLibraryBrowserPreferences'
import { useAllFolders } from '../hooks/useAllFolders'

// Keep in sync with `.floatingImg` in DeckBrowser.module.css — CardImg picks the
// image tier from the width the preview actually paints at.
const FLOATING_PREVIEW_W = 220

function isGroupFolder(folder) {
  return parseDeckMeta(folder?.description || '{}').isGroup === true
}

// ── Constants (kept for grouping/categorization used in views below) ──────────

const TYPE_ORDER = TYPE_GROUPS

// ── Helpers (kept for view grouping logic) ────────────────────────────────────

const getCardType = classifyCardType

async function addPlacementRows(targetFolder, userId, rows) {
  if (!targetFolder?.id || !rows?.length) return []
  const cardIds = [...new Set(rows.map(row => row.card_id).filter(Boolean))]
  if (!cardIds.length) return []

  if (targetFolder.type === 'deck') {
    const { data: existingRows, error } = await sb.from('deck_allocations')
      .select('id, card_id, qty')
      .eq('deck_id', targetFolder.id)
      .in('card_id', cardIds)
    if (error) throw error

    const existingMap = new Map((existingRows || []).map(row => [row.card_id, row]))
    const inserts = []
    const saved = []
    for (const row of rows) {
      const existing = existingMap.get(row.card_id)
      if (existing) {
        const { data, error: updateErr } = await sb.from('deck_allocations')
          .update({ qty: (existing.qty || 0) + (row.qty || 0) })
          .eq('id', existing.id)
          .select('id,deck_id,user_id,card_id,qty')
          .single()
        if (updateErr) throw updateErr
        if (data) saved.push(data)
      } else {
        inserts.push({ id: crypto.randomUUID(), deck_id: targetFolder.id, user_id: userId, card_id: row.card_id, qty: row.qty || 0 })
      }
    }
    if (inserts.length) {
      const { data, error: insertErr } = await sb.from('deck_allocations').insert(inserts).select('id,deck_id,user_id,card_id,qty')
      if (insertErr) throw insertErr
      saved.push(...(data || []))
    }
    return saved
  }

  const { data: existingRows, error } = await sb.from('folder_cards')
    .select('id, card_id, qty')
    .eq('folder_id', targetFolder.id)
    .in('card_id', cardIds)
  if (error) throw error

  const existingMap = new Map((existingRows || []).map(row => [row.card_id, row]))
  const inserts = []
  const saved = []
  for (const row of rows) {
    const existing = existingMap.get(row.card_id)
      if (existing) {
        const { data, error: updateErr } = await sb.from('folder_cards')
          .update({ qty: (existing.qty || 0) + (row.qty || 0) })
          .eq('id', existing.id)
          .select('id,folder_id,card_id,qty,updated_at')
          .single()
      if (updateErr) throw updateErr
      if (data) saved.push(data)
    } else {
      inserts.push({ folder_id: targetFolder.id, card_id: row.card_id, qty: row.qty || 0 })
    }
  }
  if (inserts.length) {
    const { data, error: insertErr } = await sb.from('folder_cards').insert(inserts).select('id,folder_id,card_id,qty,updated_at')
    if (insertErr) throw insertErr
    saved.push(...(data || []))
  }
  return saved
}

// ── Main DeckBrowser ──────────────────────────────────────────────────────────

export default function DeckBrowser({ folder, onBack, onDelete, onSetBackground }) {
  const navigate = useNavigate()
  const { price_source, grid_density } = useSettings()
  const { user } = useAuth()
  const toast = useToast()
  const [cards, setCards]           = useState([])
  const [sfMap, setSfMap]           = useState({})
  const [loading, setLoading]       = useState(true)
  const [detailCardId, setDetailCardId] = useState(null)
  // Destination folders for "Move to" / CardDetail. Group folders are containers,
  // never placement targets.
  const [ownedFolders, setOwnedFolders] = useAllFolders(user?.id)
  const allFolders = useMemo(() => ownedFolders.filter(f => !isGroupFolder(f)), [ownedFolders])
  const setAllFolders = setOwnedFolders
  const [linkedDirty, setLinkedDirty] = useState(false)
  const [folderDescription, setFolderDescription] = useState(folder?.description || '{}')
  const [showArtPicker, setShowArtPicker] = useState(false)
  const [creatingBuilderLink, setCreatingBuilderLink] = useState(false)
  // Existing same-name builder deck offered for pairing after a 409.
  const [adoptCandidate, setAdoptCandidate] = useState(null)
  const [syncCheck, setSyncCheck] = useState({ loading: false, dirty: false, count: 0, unavailable: false })
  const linkedBuilderIdRef = useRef(parseDeckMeta(folder?.description || '{}').linked_builder_id || null)
  const isUnsyncedRef = useRef(false)
  // Pair already reconciled this mount — a clean diff must not re-write on every pass.
  const reconciledPairRef = useRef(null)
  const deckMeta = useMemo(() => parseDeckMeta(folderDescription || '{}'), [folderDescription])
  const syncState = getSyncState(deckMeta)
  const isCheckingLinkedSync = !!deckMeta.linked_builder_id && syncCheck.loading
  const isUnsynced = linkedDirty || syncCheck.dirty || !!(syncState.unsynced_builder || syncState.unsynced_collection)
  useEffect(() => {
    isUnsyncedRef.current = isUnsynced
  }, [isUnsynced])
  const { viewMode, setViewMode, groupBy, setGroupBy } = useLibraryBrowserPreferences('collection-deck')
  const [search, setSearch]     = useState('')
  const [sort, setSort]         = useState('cmc_asc')
  const [filters, setFilters]   = useState({ ...EMPTY_FILTERS })
  const [filterOpen, setFilterOpen] = useState(false)
  // Select mode
  const [selectMode, setSelectMode]       = useState(false)
  const [selectedCards, setSelectedCards] = useState(new Set())
  const [splitState, setSplitState]       = useState(new Map()) // Map<cardId, selectedQty>
  // Inline deck rename (click the name, or More → Rename)
  const [deckName, setDeckName] = useState(folder.name)
  const [renamingDeck, setRenamingDeck] = useState(false)
  const [renameVal, setRenameVal] = useState(folder.name)
  const renameInputRef = useRef(null)
  useEffect(() => { setDeckName(folder.name); setRenameVal(folder.name) }, [folder.name])
  useEffect(() => { if (renamingDeck) renameInputRef.current?.select() }, [renamingDeck])
  const startRenameDeck = () => { setRenameVal(deckName); setRenamingDeck(true) }
  const commitRenameDeck = async () => {
    setRenamingDeck(false)
    const trimmed = renameVal.trim()
    if (!trimmed || trimmed === deckName) return
    const prev = deckName
    setDeckName(trimmed)
    try {
      // Renames both halves of a linked pair — see renameFolder.
      await renameFolder(folder.id, trimmed)
      folder.name = trimmed
      toast.success('Deck renamed.')
    } catch (err) {
      setDeckName(prev)
      toast.error(err?.message || 'Rename failed.')
    }
  }

  // Viewport scrollbar width exposed as --sbw so CSS can park the scrollbar
  // in the page gutter (0 on overlay-scrollbar platforms) — Collection pattern.
  const viewportRef = useRef(null)
  const [viewportSbw, setViewportSbw] = useState(0)
  const viewportRefCb = useCallback(el => {
    viewportRef.current = el
    if (!el) return
    const measure = () => setViewportSbw(el.offsetWidth - el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
  }, [])
  // Hover preview
  const [showAddCard, setShowAddCard] = useState(false)
  const [showExport, setShowExport]   = useState(false)
  const [showImport, setShowImport]   = useState(false)
  const [importText, setImportText]   = useState('')
  const openImport = () => { setImportText(''); setShowImport(true) }
  const [hoverImg, setHoverImg] = useState(null)
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 })
  const handleHover    = useCallback((img) => setHoverImg(img), [])
  const handleHoverEnd = useCallback(() => setHoverImg(null), [])
  const handleMouseMove = useCallback((e) => {
    if (!hoverImg) return
    const nextX = e.clientX
    const nextY = e.clientY
    setHoverPos(prev => (prev.x === nextX && prev.y === nextY ? prev : { x: nextX, y: nextY }))
  }, [hoverImg])
  const markCurrentLinkedDeckUnsynced = useCallback(async () => {
    const builderId = linkedBuilderIdRef.current
    if (!folder?.id || !builderId) return
    await markLinkedPairUnsynced({
      builderDeckId: builderId,
      collectionDeckId: folder.id,
    })
    setLinkedDirty(true)
  }, [folder])
  const invalidatePlacementCaches = useCallback((options = {}) => (
    invalidateOwnedCollectionQueries(queryClient, user?.id, options).catch(() => {})
  ), [user?.id])

  const openInBuilder = useCallback(async () => {
    const meta = parseDeckMeta(folderDescription || '{}')
    setCreatingBuilderLink(true)
    try {
      // If this deck was hidden from Builder overview (X button), restore it
      if (meta.hideFromBuilder) {
        delete meta.hideFromBuilder
        await sb.from('folders').update({ description: serializeDeckMeta(meta) }).eq('id', folder.id)
      }

      // If a link exists, verify the builder deck still exists before navigating
      if (meta.linked_builder_id) {
        const { data: existing } = await sb.from('folders').select('id').eq('id', meta.linked_builder_id).maybeSingle()
        if (existing?.id) {
          linkedBuilderIdRef.current = meta.linked_builder_id
          setCreatingBuilderLink(false)
          navigate(`/builder/${meta.linked_builder_id}`, { state: { openSync: isUnsyncedRef.current, source: 'collection-deck' } })
          return
        }
        // Builder deck was deleted — clear the stale link and fall through to re-create
        const cleared = { ...meta }
        delete cleared.linked_builder_id
        delete cleared.sync_state
        await sb.from('folders').update({ description: serializeDeckMeta(cleared) }).eq('id', folder.id)
        Object.assign(meta, cleared)
        delete meta.linked_builder_id
      }

      // Check for deck_cards already stored under the collection deck ID (from previous "Edit in Builder" sessions)
      const { data: existingCards } = await sb.from('deck_cards').select('id').eq('deck_id', folder.id)
      const hasExistingCards = (existingCards?.length ?? 0) > 0

      // Create the builder_deck folder WITHOUT the link. The pairing is established
      // below through link_deck_pair, so this path gets the same guards as every
      // other one — and, importantly, the same game_results repoint: this deck may
      // have been played for months while it had no builder counterpart.
      const builderInitMeta = {
        format: meta.format || null,
        ...(meta.bracket != null
          ? { bracket: meta.bracket, bracketManual: !!meta.bracketManual }
          : {}),
      }
      const { data: builderFolder, error: builderErr } = await sb
        .from('folders')
        .insert({ user_id: user.id, name: folder.name, type: 'builder_deck', description: serializeDeckMeta(builderInitMeta) })
        .select()
        .single()

      // A builder deck of this name already exists (folders is UNIQUE on
      // user_id+name+type). That is almost always the deck the user wants to pair
      // with, so offer to adopt it rather than dead-ending on a 409.
      if (isUniqueNameConflict(builderErr)) {
        const { data: existing } = await sb.from('folders')
          .select('id,name,description')
          .eq('user_id', user.id)
          .eq('type', 'builder_deck')
          .eq('name', folder.name)
          .maybeSingle()
        const resolution = resolveBuilderNameConflict(existing)
        if (resolution.action === 'adopt') {
          setAdoptCandidate({ id: resolution.builderDeckId, name: folder.name })
        } else {
          toast.error(resolution.reason, { duration: 6000 })
        }
        return
      }

      if (builderErr || !builderFolder) throw builderErr || new Error('Failed to create builder deck')

      const now = new Date().toISOString()
      if (hasExistingCards) {
        // Migrate deck_cards from the old collection-deck path to the new builder deck
        const { error: migErr } = await sb.from('deck_cards')
          .update({ deck_id: builderFolder.id, updated_at: now })
          .eq('deck_id', folder.id)
        if (migErr) throw new Error('[DeckBrowser] deck_cards migration failed: ' + migErr.message)
      } else {
        // Create deck_cards fresh from current allocations
        const allocations = await fetchDeckAllocations(folder.id)
        if (allocations.length) {
          const rows = allocations.map(row => ({
            id: crypto.randomUUID(),
            deck_id: builderFolder.id,
            user_id: user.id,
            card_print_id: row.card_print_id || null,
            scryfall_id: row.scryfall_id || null,
            name: row.name,
            set_code: row.set_code || null,
            collector_number: row.collector_number || null,
            type_line: row.type_line || null,
            mana_cost: row.mana_cost || null,
            cmc: row.cmc ?? null,
            color_identity: row.color_identity || [],
            image_uri: row.image_uri || null,
            qty: row.qty || 1,
            foil: row.foil ?? false,
            is_commander: false,
            board: boardForCard(row, null, row.board || 'main'),
            created_at: now,
            updated_at: now,
          }))
          const { error: insertErr } = await sb.from('deck_cards').insert(rows.map(toDeckCardRow))
          if (insertErr) throw new Error('[DeckBrowser] deck_cards insert failed: ' + insertErr.message)
        }
      }

      // Establish the pairing. link_deck_pair writes both sides' link fields, applies
      // the relink/type guards, and repoints any game_results recorded against this
      // collection deck onto the builder deck, which is the id win rates are read by.
      const linkResult = await linkDeckPair(builderFolder.id, folder.id)

      // Sync state on the collection side, layered onto the meta the RPC just wrote
      // so the link it established is not clobbered.
      const linkedCollectionMeta = linkResult?.collection_meta
        || withLinkedPair(meta, { linkedBuilderId: builderFolder.id })
      const updatedCollectionMeta = writeSyncState(
        linkedCollectionMeta,
        { unsynced_builder: hasExistingCards, unsynced_collection: false },
      )
      const { error: linkErr } = await sb.from('folders')
        .update({ description: serializeDeckMeta(updatedCollectionMeta) })
        .eq('id', folder.id)
      if (linkErr) throw new Error('Failed to save builder link')

      linkedBuilderIdRef.current = builderFolder.id
      navigate(`/builder/${builderFolder.id}`)
    } catch (e) {
      // Previously this only logged, so the button stopped spinning and nothing
      // else happened — the failure was invisible outside the console.
      console.error('[DeckBrowser] failed to open in builder:', e)
      const detail = [e?.message, e?.details, e?.hint].filter(Boolean).join(' ')
      toast.error(
        detail ? `Could not open in Builder. ${detail}` : 'Could not open in Builder. Please try again.',
        { duration: 6000 },
      )
    } finally {
      setCreatingBuilderLink(false)
    }
  }, [folder, folderDescription, user, navigate, toast])

  // Pair this collection deck with the existing same-name builder deck. Only the
  // two link fields are written — no cards are moved or overwritten. Both sides are
  // marked unsynced so the Builder's sync review shows the differences and the user
  // decides what to reconcile.
  const adoptExistingBuilderDeck = useCallback(async () => {
    if (!adoptCandidate || !user) return
    setCreatingBuilderLink(true)
    try {
      await linkDeckPair(adoptCandidate.id, folder.id)
      await markLinkedPairUnsynced({
        builderDeckId: adoptCandidate.id,
        collectionDeckId: folder.id,
      })
      linkedBuilderIdRef.current = adoptCandidate.id
      setAdoptCandidate(null)
      navigate(`/builder/${adoptCandidate.id}`, { state: { openSync: true, source: 'collection-deck' } })
    } catch (e) {
      console.error('[DeckBrowser] failed to pair with existing builder deck:', e)
      toast.error(e?.message || 'Could not pair the decks. Please try again.', { duration: 6000 })
      setAdoptCandidate(null)
    } finally {
      setCreatingBuilderLink(false)
    }
  }, [adoptCandidate, folder, user, navigate, toast])

  const loadCards = useCallback(async () => {
    setLoading(true)
    const allocs = await getDeckAllocations(folder.id)
    if (allocs?.length) {
      const cardIds = allocs.map(a => a.card_id).filter(Boolean)
      const localCards = await getCardsByIds(cardIds)
      const cardById = Object.fromEntries(localCards.map(c => [c.id, c]))
      const cardList = allocs
        .filter(a => cardById[a.card_id])
        .map(a => ({ ...cardById[a.card_id], _folder_qty: a.qty, _allocation_id: a.id }))
      setCards(cardList)
      // Drop the spinner as soon as cards are on screen — remote reconcile can run async.
      setLoading(false)
      const map = await loadCardMapWithSharedPrices(cardList)
      if (map) setSfMap(prev => ({ ...prev, ...map }))
    } else {
      setCards([])
    }

    if (navigator.onLine) {
      try {
        const remote = await fetchDeckAllocations(folder.id)
        await replaceDeckAllocations([folder.id], remote.map(row => ({
          id: row.id,
          deck_id: row.deck_id,
          user_id: row.user_id,
          card_id: row.card_id,
          qty: row.qty,
          updated_at: row.updated_at,
        })))
        const remoteCardList = remote.map(row => ({
          id: row.card_id,
          scryfall_id: row.scryfall_id,
          name: row.name,
          set_code: row.set_code,
          collector_number: row.collector_number,
          foil: row.foil,
          qty: row.qty,
          condition: row.condition,
          language: row.language,
          purchase_price: row.purchase_price,
          _folder_qty: row.qty,
          _allocation_id: row.id,
        }))
        // Only re-render if remote differs from what's already shown
        setCards(prev => {
          const sig = l => l.map(c => `${c.id}|${c._folder_qty ?? c.qty}|${c._allocation_id}`).sort().join(',')
          return sig(prev) === sig(remoteCardList) ? prev : remoteCardList
        })
        const map = await loadCardMapWithSharedPrices(remoteCardList)
        if (map) setSfMap(prev => {
          // Merge so that prices loaded in Phase A don't disappear when the
          // remote phase's map is a subset (e.g. transient Scryfall lookup
          // miss). Only bail out if nothing new arrived.
          let changed = false
          for (const k of Object.keys(map)) {
            if (prev[k] !== map[k]) { changed = true; break }
          }
          return changed ? { ...prev, ...map } : prev
        })
      } catch {}
    }

    setLoading(false)
  }, [folder.id])

  useEffect(() => { loadCards() }, [loadCards])

  useEffect(() => {
    let cancelled = false
    sb.from('folders').select('description').eq('id', folder.id).maybeSingle().then(({ data }) => {
      if (!cancelled && data?.description != null) setFolderDescription(data.description)
    })
    return () => { cancelled = true }
  }, [folder.id])

  useEffect(() => {
    const meta = parseDeckMeta(folderDescription || '{}')
    const builderId = meta.linked_builder_id
    linkedBuilderIdRef.current = builderId || null
    if (!builderId) {
      setSyncCheck({ loading: false, dirty: false, count: 0, unavailable: false })
      return
    }

    let cancelled = false
    async function checkLinkedSync() {
      setSyncCheck(prev => ({ ...prev, loading: true, unavailable: false }))
      try {
        const baseline = getSyncState(meta).last_sync_snapshot || { builder_cards: [], collection_cards: [] }
        const [builderCards, collectionCards] = await Promise.all([
          fetchDeckCards(builderId),
          fetchDeckAllocations(folder.id),
        ])
        if (cancelled) return
        const diff = buildSyncDiff({ baseline, builderCards, collectionCards })
        const summary = summarizeSyncDiff(diff)
        setSyncCheck({ loading: false, dirty: summary.dirty, count: summary.total, unavailable: false })

        // isUnsynced ORs this fresh result with the stored flag, so a clean diff
        // alone cannot get the button out of its "Unsynced changes" state — the
        // stored flag has to be corrected. This page already has both sides loaded,
        // so it reconciles here rather than making the user visit the Builder first.
        if (!summary.dirty && reconciledPairRef.current !== builderId) {
          reconciledPairRef.current = builderId
          const reconciled = await reconcileCleanPair({
            builderDeckId: builderId,
            collectionDeckId: folder.id,
            snapshot: buildPairSnapshot({ builderCards, collectionCards }),
          })
          if (reconciled && !cancelled) await invalidatePlacementCaches({ includeFolders: true })
        }
      } catch {
        if (!cancelled) setSyncCheck({ loading: false, dirty: false, count: 0, unavailable: true })
      }
    }
    checkLinkedSync()
    return () => { cancelled = true }
  }, [folder.id, folderDescription, invalidatePlacementCaches])

  const clearSelect = () => { setSelectedCards(new Set()); setSplitState(new Map()); setSelectMode(false) }
  const toggleSelectMode = () => { setSelectMode(v => { if (v) clearSelect(); return !v }) }

  const onToggleSelect = useCallback((id, totalQty) => {
    setSelectedCards(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        setSplitState(s => { const n = new Map(s); n.delete(id); return n })
      } else if (totalQty > 1) {
        next.add(id)
        setSplitState(s => new Map(s).set(id, 1))
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const onAdjustQty = useCallback((id, delta, totalQty) => {
    setSplitState(prev => {
      const current = prev.get(id) ?? 1
      const next = Math.min(totalQty, current + delta)
      if (next <= 0) {
        setSelectedCards(sel => {
          const updated = new Set(sel)
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

  const handleBulkDelete = async () => {
    const toDelete = [], toUpdate = []
    const selectedQtyByCardId = new Map()
    for (const id of selectedCards) {
      const card = cardById.get(id)
      if (!card) continue
      const totalQty = card?._folder_qty || card?.qty || 1
      const selQty = splitState.get(id) ?? 1
      const remaining = totalQty - selQty
      selectedQtyByCardId.set(card.id, (selectedQtyByCardId.get(card.id) || 0) + selQty)
      remaining > 0 ? toUpdate.push({ allocId: card?._allocation_id, remaining }) : toDelete.push(card?._allocation_id)
    }
    try {
      if (toDelete.length) await sb.from('deck_allocations').delete().eq('deck_id', folder.id).in('id', toDelete.filter(Boolean))
      for (const { allocId, remaining } of toUpdate) {
        await sb.from('deck_allocations').update({ qty: remaining }).eq('id', allocId)
      }
      const fullyRemovedCardIds = [...new Set(
        [...selectedCards]
          .map(id => cardById.get(id))
          .filter(card => card && ((card._folder_qty || card.qty || 1) - (splitState.get(card.id) ?? 1)) <= 0)
          .map(card => card.id)
      )]
      const affectedCardIds = [...selectedQtyByCardId.keys()]
      const prunedIds = fullyRemovedCardIds.length ? await pruneUnplacedCards(fullyRemovedCardIds) : []
      const prunedSet = new Set(prunedIds)
      const placedQtyByCardId = await getPlacedQtyByCardIds(affectedCardIds.filter(id => !prunedSet.has(id)))
      for (const cardId of affectedCardIds) {
        if (prunedSet.has(cardId)) continue
        const card = cardById.get(cardId)
        if (!card) continue
        const nextQty = placedQtyByCardId.get(cardId) || 0
        if (nextQty <= 0) continue
        const { error: cardErr } = await sb.from('cards').update({ qty: nextQty }).eq('id', cardId)
        if (cardErr) throw cardErr
        await putCards([{ ...card, qty: nextQty }]).catch(() => {})
      }
      const freshAllocs = await fetchDeckAllocations(folder.id)
      await replaceDeckAllocations([folder.id], (freshAllocs || []).map(r => ({
        id: r.id, deck_id: r.deck_id, user_id: r.user_id, card_id: r.card_id, qty: r.qty,
      }))).catch(() => {})
      await markCurrentLinkedDeckUnsynced()
      await invalidatePlacementCaches({ includeCards: true })
      setCards(prev => prev.map(c => {
        if (!selectedCards.has(c.id)) return c
        const totalQty = c._folder_qty || c.qty || 1
        const selQty = splitState.get(c.id) ?? 1
        const remaining = totalQty - selQty
        if (remaining <= 0) return null
        return { ...c, qty: placedQtyByCardId.get(c.id) || c.qty || 1, _folder_qty: remaining }
      }).filter(Boolean))
      clearSelect()
      toast.success(`Deleted ${selectedQty} ${selectedQty === 1 ? 'card' : 'cards'}.`)
    } catch (e) {
      console.error('[DeckBrowser] bulk delete failed:', e)
      loadCards()
    }
  }

  const handleMoveToFolder = async (targetFolder) => {
    const toDelete = [], toUpdate = []
    const insertRows = []
    for (const id of selectedCards) {
      const card = cardById.get(id)
      const totalQty = card?._folder_qty || card?.qty || 1
      const selQty = splitState.get(id) ?? 1
      const remaining = totalQty - selQty
      insertRows.push({ card_id: id, qty: selQty, user_id: user.id })
      remaining > 0 ? toUpdate.push({ allocId: card?._allocation_id, remaining }) : toDelete.push(card?._allocation_id)
    }
    try {
      if (targetFolder.type === 'deck') {
        await addPlacementRows(targetFolder, user.id, insertRows)
        const freshDestAllocs = await fetchDeckAllocations(targetFolder.id)
        await replaceDeckAllocations([targetFolder.id], (freshDestAllocs || []).map(r => ({
          id: r.id, deck_id: r.deck_id, user_id: r.user_id, card_id: r.card_id, qty: r.qty,
        }))).catch(() => {})
      } else {
        await addPlacementRows(targetFolder, user.id, insertRows)
        const { data: freshDestFc } = await sb.from('folder_cards')
          .select('id, folder_id, card_id, qty, updated_at')
          .eq('folder_id', targetFolder.id)
          .in('card_id', insertRows.map(r => r.card_id))
        if (freshDestFc?.length) await putFolderCards(freshDestFc).catch(() => {})
      }
      if (toDelete.length) await sb.from('deck_allocations').delete().eq('deck_id', folder.id).in('id', toDelete.filter(Boolean))
      for (const { allocId, remaining } of toUpdate) {
        await sb.from('deck_allocations').update({ qty: remaining }).eq('id', allocId)
      }
      const freshSourceAllocs = await fetchDeckAllocations(folder.id)
      await replaceDeckAllocations([folder.id], (freshSourceAllocs || []).map(r => ({
        id: r.id, deck_id: r.deck_id, user_id: r.user_id, card_id: r.card_id, qty: r.qty,
      }))).catch(() => {})
      await markCurrentLinkedDeckUnsynced()
      await invalidatePlacementCaches()
      setCards(prev => prev.map(c => {
        if (!selectedCards.has(c.id)) return c
        const totalQty = c._folder_qty || c.qty || 1
        const selQty = splitState.get(c.id) ?? 1
        const remaining = totalQty - selQty
        return remaining > 0 ? { ...c, _folder_qty: remaining } : null
      }).filter(Boolean))
      clearSelect()
      const movedQty = insertRows.reduce((sum, row) => sum + row.qty, 0)
      toast.success(`Moved ${movedQty} ${movedQty === 1 ? 'card' : 'cards'} to ${targetFolder.name}.`)
    } catch (e) {
      console.error('[DeckBrowser] move to folder failed:', e)
      loadCards()
    }
  }

  const selectedQty = useMemo(() =>
    [...selectedCards].reduce((sum, id) => sum + (splitState.get(id) ?? 1), 0)
  , [selectedCards, splitState])

  const { totalValue, totalQty } = useMemo(() => {
    let v=0, q=0
    for (const c of cards) {
      const sf = sfMap[getScryfallKey(c)]
      const p = getPrice(sf, c.foil, { price_source }) ?? (parseFloat(c.purchase_price) || null)
      const qty = c._folder_qty || c.qty || 1
      if (p!=null) v += p*qty
      q += qty
    }
    return { totalValue:v, totalQty:q }
  }, [cards, sfMap, price_source])

  const cardById = useMemo(() => {
    const m = new Map()
    for (const c of cards) {
      if (c?.id != null) m.set(c.id, c)
    }
    return m
  }, [cards])

  const filtered = useFilterWorker({ cards, sfMap, search, sort, filters, priceSource: price_source })

  const availableSets = useMemo(() => {
    const seen = {}
    for (const c of cards) {
      if (!c.set_code) continue
      if (!seen[c.set_code]) {
        const sf = sfMap[getScryfallKey(c)]
        seen[c.set_code] = sf?.set_name || c.set_code.toUpperCase()
      }
    }
    return Object.entries(seen)
      .map(([code, name]) => ({ code, name: name || code }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [cards, sfMap])

  // Build groups based on groupBy mode
  const { groups: _groups, groupOrder: _groupOrder } = useMemo(() => {
    if (groupBy === 'none') return { groups: { 'All': filtered }, groupOrder: ['All'] }
    const g = {}
    const order = groupBy === 'category' ? CAT_ORDER : TYPE_ORDER

    for (const c of filtered) {
      const sf = sfMap[getScryfallKey(c)]
      const key = groupBy === 'category'
        ? getCardCategoryFromCard(c, sf)
        : getCardType(sf?.type_line || sf?.card_faces?.[0]?.type_line || '')
      if (!g[key]) g[key] = []
      g[key].push(c)
    }
    return { groups: g, groupOrder: order }
  }, [filtered, sfMap, groupBy])

  const selectedCard = detailCardId ? (cardById.get(detailCardId) ?? null) : null
  const selectedSf   = selectedCard ? sfMap[getScryfallKey(selectedCard)] : null
  // Detail-modal Prev/Next steps through the deck browser's on-screen order.
  const [browseOrder, reportBrowseOrder] = useVisibleOrder()
  const getDetailPeek = useCallback(key => {
    const c = key == null ? null : cardById.get(key)
    return cardPeek(c, c ? sfMap[getScryfallKey(c)] : null)
  }, [cardById, sfMap])
  const detailNav = useCardDetailNav(browseOrder, detailCardId, setDetailCardId, getDetailPeek)
  const handleCardSave = useCallback((updatedCard) => {
    setCards(prev => prev.map(c => c.id === updatedCard.id ? { ...c, ...updatedCard } : c))
    void markCurrentLinkedDeckUnsynced()
    void invalidatePlacementCaches({ includeCards: true })
  }, [markCurrentLinkedDeckUnsynced, invalidatePlacementCaches])

  const handleDetailDelete = useCallback(async () => {
    if (!selectedCard) return
    try {
      const { error } = await sb
        .from('deck_allocations')
        .delete()
        .eq('deck_id', folder.id)
        .eq('card_id', selectedCard.id)
      if (error) throw error

      const prunedIds = await pruneUnplacedCards([selectedCard.id])
      const pruned = prunedIds.includes(selectedCard.id)
      let nextQty = selectedCard.qty || 1
      if (!pruned) {
        const placedQtyByCardId = await getPlacedQtyByCardIds([selectedCard.id])
        nextQty = placedQtyByCardId.get(selectedCard.id) || 0
        if (nextQty > 0) {
          const { error: cardErr } = await sb.from('cards').update({ qty: nextQty }).eq('id', selectedCard.id)
          if (cardErr) throw cardErr
          await putCards([{ ...selectedCard, qty: nextQty }]).catch(() => {})
        }
      }

      const freshAllocs = await fetchDeckAllocations(folder.id)
      await replaceDeckAllocations([folder.id], (freshAllocs || []).map(row => ({
        id: row.id, deck_id: row.deck_id, user_id: row.user_id, card_id: row.card_id, qty: row.qty,
      }))).catch(() => {})
      await markCurrentLinkedDeckUnsynced()
      await invalidatePlacementCaches({ includeCards: true })
      setCards(prev => prev.filter(c => c.id !== selectedCard.id).map(c => (
        c.id === selectedCard.id ? { ...c, qty: nextQty } : c
      )))
      setDetailCardId(null)
      toast.success(`Deleted ${selectedCard._folder_qty || selectedCard.qty || 1} ${(selectedCard._folder_qty || selectedCard.qty || 1) === 1 ? 'card' : 'cards'}.`)
    } catch (e) {
      console.error('[DeckBrowser] detail delete failed:', e)
      loadCards()
    }
  }, [selectedCard, folder.id, markCurrentLinkedDeckUnsynced, invalidatePlacementCaches, loadCards, toast])

  if (loading) return <EmptyState>Loading deck…</EmptyState>

  // The verb stays constant once a pair exists, and drift is shown beside it rather
  // than replacing it — a button should keep saying where it goes. The unpaired case
  // gets a different verb because it is a different action: it creates the paired
  // builder deck. "Edit" implied a deck list already existed to edit.
  const isPairedWithBuilder = !!deckMeta.linked_builder_id
  const builderActionLabel = creatingBuilderLink
    ? 'Opening…'
    : isCheckingLinkedSync
      ? 'Checking…'
      : isPairedWithBuilder
        ? 'Open in Deck Builder'
        : 'Set up deck list'
  const unsyncedChipLabel = (
    isPairedWithBuilder && isUnsynced && !isCheckingLinkedSync && !creatingBuilderLink
  )
    ? (syncCheck.count ? `Unsynced · ${syncCheck.count}` : 'Unsynced')
    : null
  // Use only the explicitly-set bg_url for the header background.
  // coverArtUri is the builder-deck commander art — it is not a user-chosen
  // background for the collection deck view and should not bleed through here.
  const folderBgUrl = parseFolderBgUrl(folder.description)

  // Writing the background rewrites the whole description blob, which is also
  // where this component's deck meta lives — take the result so a later link
  // write doesn't serialize a copy that predates the background.
  const applyBackground = async (url) => {
    const next = await onSetBackground?.(url)
    if (next !== undefined) setFolderDescription(next || '{}')
  }

  return (
    <div className={styles.deckBrowser} onMouseMove={handleMouseMove} onMouseLeave={handleHoverEnd}>
      {/* Header + search: one sticky dock on mobile */}
      <div className={styles.topDock}>
      <div className={styles.header}>
        {folderBgUrl && (
          <div className={styles.headerBg} style={{ backgroundImage: `url(${folderBgUrl})` }} />
        )}
        <div className={styles.titleRow}>
          <div className={styles.titleBlock}>
            {renamingDeck ? (
              <input
                ref={renameInputRef}
                className={styles.deckNameInput}
                value={renameVal}
                maxLength={100}
                onChange={e => setRenameVal(e.target.value)}
                onBlur={commitRenameDeck}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRenameDeck()
                  if (e.key === 'Escape') { setRenameVal(deckName); setRenamingDeck(false) }
                }}
                aria-label="Deck name"
              />
            ) : (
              <h1 className={styles.deckName}>
                <button className={styles.deckNameBtn} onClick={startRenameDeck} title="Rename deck">
                  {deckName}
                </button>
              </h1>
            )}
            <div className={styles.headerMeta}>
              <span>{totalQty} cards</span>
              <span className={styles.metaSep} aria-hidden="true">·</span>
              <span className={styles.deckValue}>{formatPrice(totalValue, price_source)}</span>
            </div>
          </div>
          <div className={styles.headerActionsDesktop}>
              <Button variant="secondary" size="sm" onClick={() => setShowAddCard(true)}>
                <AddIcon size={12} /> Add Cards
              </Button>
              <button className={styles.editInBuilderBtn} onClick={openInBuilder} disabled={creatingBuilderLink || isCheckingLinkedSync} aria-busy={isCheckingLinkedSync}>
                <BuilderIcon size={12} /> {builderActionLabel}
                {unsyncedChipLabel && <span className={styles.unsyncedChip}>{unsyncedChipLabel}</span>}
              </button>
              <ResponsiveMenu
                title="Deck Actions"
                portal
                trigger={({ toggle }) => (
                  <Button variant="secondary" size="sm" onClick={toggle} aria-label="More deck actions">
                    <SettingsIcon size={12} /> More
                  </Button>
                )}
              >
                {({ close }) => (
                  <div className={uiStyles.responsiveMenuList}>
                    <button className={uiStyles.responsiveMenuAction} onClick={() => { startRenameDeck(); close() }}><span><EditIcon size={13} /> Rename</span></button>
                    {onSetBackground && (
                      <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowArtPicker(true); close() }}><span><ImageIcon size={13} /> Set background art</span></button>
                    )}
                    {onSetBackground && folderBgUrl && (
                      <button className={uiStyles.responsiveMenuAction} onClick={() => { applyBackground(null); close() }}><span><RemoveIcon size={13} /> Clear background</span></button>
                    )}
                    <button className={uiStyles.responsiveMenuAction} onClick={() => { openImport(); close() }}><span><ImportIcon size={13} /> Import</span></button>
                    <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowExport(true); close() }}><span><ExportIcon size={13} /> Export</span></button>
                    {onDelete && (
                      <button className={`${uiStyles.responsiveMenuAction} ${uiStyles.responsiveMenuActionDanger}`} onClick={() => { onDelete(totalQty === 0); close() }}><span><DeleteIcon size={13} /> Delete deck</span></button>
                    )}
                  </div>
                )}
              </ResponsiveMenu>
            </div>
          </div>
        <div className={styles.headerBackRow}>
          <Button variant="secondary" size="sm" className={styles.headerBackBtn} onClick={onBack} aria-label="Back to Decks">
            <ChevronLeftIcon size={13} /> <span className={styles.headerBackLabel}>Back to Decks</span>
          </Button>
          <button
            className={`${styles.editInBuilderBtn} ${styles.editInBuilderBtnMobile}`}
            onClick={openInBuilder}
            disabled={creatingBuilderLink || isCheckingLinkedSync}
            aria-busy={isCheckingLinkedSync}
          >
            <BuilderIcon size={12} /> {builderActionLabel}
            {unsyncedChipLabel && <span className={styles.unsyncedChip}>{unsyncedChipLabel}</span>}
          </button>
        </div>
      </div>

      {/* Controls */}
      {cards.length > 0 && <FilterBar search={search} setSearch={setSearch} sort={sort} setSort={setSort}
        filters={filters} setFilters={setFilters}
        mode="folder" sets={availableSets}
        selectMode={selectMode} onToggleSelectMode={toggleSelectMode}
        filterOpen={filterOpen} onFilterOpenChange={setFilterOpen}
        hideActionsMobile
        hideSortFilterMobile />}
      </div>

      {cards.length > 0 && <div className={styles.controlBar}>
        <span className={styles.countInfo}>
          {filtered.length} of {cards.length} unique · {totalQty} total cards
        </span>
        <CardBrowserViewControls
          viewMode={viewMode}
          setViewMode={setViewMode}
          groupBy={groupBy}
          setGroupBy={setGroupBy}
          selectMode={selectMode}
          sort={sort}
          setSort={setSort}
          filters={filters}
          filterOpen={filterOpen}
          onToggleFilters={() => setFilterOpen(v => !v)}
          onAddCards={() => setShowAddCard(true)}
          onToggleSelectMode={toggleSelectMode}
          onImport={openImport}
          onExport={() => setShowExport(true)}
          onDelete={onDelete ? () => onDelete(totalQty === 0) : undefined}
          deleteLabel="Delete deck"
          bulkBarVisible={selectMode && selectedCards.size > 0}
        />
      </div>}

      {selectMode && selectedCards.size > 0 && (
        <BulkActionBar
          selected={selectedCards}
          selectedQty={selectedQty}
          total={filtered.reduce((s, c) => s + (c._folder_qty || c.qty || 1), 0)}
          onSelectAll={() => {
            setSelectedCards(new Set(filtered.map(c => c.id)))
            setSplitState(new Map(
              filtered
                .filter(c => (c._folder_qty || c.qty || 1) > 1)
                .map(c => [c.id, c._folder_qty || c.qty || 1])
            ))
          }}
          onDeselectAll={() => clearSelect()}
          onDelete={handleBulkDelete}
          onMoveToFolder={handleMoveToFolder}
          folders={allFolders.filter(f => f.id !== folder.id)}
          floatingMobile
          onCreateFolder={async (type, name) => {
            const { data: newFolder } = await sb
              .from('folders')
              .insert({ name, type, user_id: user.id })
              .select()
              .single()
            if (newFolder) {
              setAllFolders(prev => [...prev, newFolder])
              await invalidatePlacementCaches({ includeFolders: true, includePlacements: false })
              await handleMoveToFolder(newFolder)
            }
          }}
        />
      )}

      {cards.length === 0 && (
        <LibraryEmptyState
          compact
          icon={<DeckIcon size={32} />}
          title={`Add cards to ${folder.name}`}
          description="Import a decklist or add owned cards manually. Deck controls will appear once this collection deck contains cards."
          importAction={{
            label: 'Import a collection deck',
            description: 'Drop a .csv or .txt decklist here, or click to paste or upload.',
            onClick: openImport,
            onFile: async file => { setImportText(await file.text()); setShowImport(true) },
          }}
          manualAction={{
            label: 'Add owned cards',
            icon: <AddIcon size={14} />,
            onClick: () => setShowAddCard(true),
          }}
        />
      )}
      {cards.length > 0 && filtered.length === 0 && <EmptyState>No cards match your search or filters.</EmptyState>}

      {/* ── Views ── */}
      {filtered.length > 0 && (
        <div className={styles.browserViewport} ref={viewportRefCb} style={{ '--sbw': `${viewportSbw}px` }}>
          <CardBrowserContent
            cards={filtered}
            sfMap={sfMap}
            priceSource={price_source}
            viewMode={viewMode}
            groupBy={groupBy}
            density={grid_density}
            onSelect={c => { handleHoverEnd(); setDetailCardId(c.id) }}
            selectMode={selectMode}
            selectedCards={selectedCards}
            onToggleSelect={onToggleSelect}
            onAdjustQty={onAdjustQty}
            splitState={splitState}
            onEnterSelectMode={() => setSelectMode(true)}
            onHover={handleHover}
            onHoverEnd={handleHoverEnd}
            onVisibleOrder={reportBrowseOrder}
          />
        </div>
      )}

      {selectedCard && (
        <CardDetail {...detailNav} card={selectedCard} sfCard={selectedSf}
          priceSource={price_source}
          folders={[folder]}
          allFolders={allFolders}
          currentFolderId={folder.id}
          currentFolderType={folder.type}
          onSave={handleCardSave}
          onDelete={handleDetailDelete}
          onClose={() => setDetailCardId(null)} />
      )}

      {/* Floating hover preview */}
      {hoverImg && (
        <div className={styles.floatingPreview}
          style={{ left: hoverPos.x + 18, top: Math.max(8, hoverPos.y - 160), pointerEvents: 'none' }}>
          <CardImg className={styles.floatingImg} url={hoverImg} width={FLOATING_PREVIEW_W} />
        </div>
      )}

      {showAddCard && user && (
        <AddCardModal
          userId={user.id}
          folderMode
          defaultFolderType="deck"
          defaultFolderId={folder.id}
          onClose={() => setShowAddCard(false)}
          onSaved={async (result) => {
            if (result?.cards?.length) await putCards(result.cards)
            if (result?.placements?.length) await putDeckAllocations(result.placements)
            await markCurrentLinkedDeckUnsynced()
            await invalidatePlacementCaches({ includeCards: !!result?.cards?.length })
            setShowAddCard(false)
            await loadCards()
          }}
        />
      )}
      {showImport && user && (
        <ImportModal
          userId={user.id}
          folderType="deck"
          folders={[folder]}
          defaultFolderId={folder.id}
          initialText={importText || undefined}
          onClose={() => setShowImport(false)}
          onSaved={async () => { await markCurrentLinkedDeckUnsynced(); await invalidatePlacementCaches({ includeCards: true }); setShowImport(false); await loadCards() }}
        />
      )}
      {showExport && (
        <ExportModal
          cards={cards}
          sfMap={sfMap}
          title={folder.name}
          folderType="deck"
          onClose={() => setShowExport(false)}
        />
      )}

      {adoptCandidate && (
        <ConfirmModal
          title="Pair with the existing builder deck?"
          message={`You already have a builder deck called "${adoptCandidate.name}". This collection deck can be paired with it instead of creating a second one. No cards are moved — the Builder's sync review opens so you can see the differences and choose what to reconcile.`}
          confirmLabel="Pair them"
          cancelLabel="Cancel"
          variant="primary"
          busy={creatingBuilderLink}
          onConfirm={adoptExistingBuilderDeck}
          onClose={() => setAdoptCandidate(null)}
        />
      )}

      {showArtPicker && (
        <CardArtPicker
          onSelect={url => { applyBackground(url); setShowArtPicker(false) }}
          onClose={() => setShowArtPicker(false)}
        />
      )}
    </div>
  )
}
