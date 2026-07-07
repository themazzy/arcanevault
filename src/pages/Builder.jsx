import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link, useLocation } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { Button, Modal, EmptyState, SectionHeader, ResponsiveMenu } from '../components/UI'
import { parseDeckMeta, serializeDeckMeta, FORMATS } from '../lib/deckBuilderApi'
import { unlinkPairedDeck, getSyncState, patchDeckMeta } from '../lib/deckSync'
import { hasDeckArtSource, mergeDeckCommanderArt, useDeckArts, enrichDecksWithCommanderArt } from '../lib/deckArt'
import styles from './Builder.module.css'
import uiStyles from '../components/UI.module.css'
import { useLongPress } from '../hooks/useLongPress'
import { useToast } from '../components/ToastContext'
import { CheckIcon, DeleteIcon, EditIcon, ChevronDownIcon } from '../icons'
import { GuidedCommanderPicker } from '../components/deckBuilder/GuidedCommanderPicker'
import { resolveBracketBadge, analyzeBracket, fetchGameChangerNames, computeBracketMetaPatch } from '../lib/commanderBracket'
import { fetchDeckCards, fetchDeckAllocations } from '../lib/deckData'
import { normalizeDeckBuilderCards } from '../components/DeckStats'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'

const MANA_SYMBOL_URL = c => `https://svgs.scryfall.io/card-symbols/${c}.svg`

function fmtRelDate(iso) {
  if (!iso) return null
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(diff / 3600000)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(diff / 86400000)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Deck descriptions can now hold a full Markdown primer. On a tile we only want
// a short, clean teaser — strip the Markdown syntax and collapse whitespace so
// it reads as plain text and the 2-line clamp stays tight.
function plainPreview(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+\.\s+/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

// Truncate a tag list to a rough character budget so it fits within
// the fixed-height tile. Appends a '…' chip if any tags were dropped.
const TAG_CHAR_BUDGET = 64
function clampTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return []
  const out = []
  let used = 0
  for (const t of tags) {
    const len = String(t).length + 2 // approximate chip padding cost
    if (out.length > 0 && used + len > TAG_CHAR_BUDGET) {
      return [...out, '…']
    }
    out.push(t)
    used += len
  }
  return out
}

function DeckArtBackground({ meta }) {
  const visibleArts = useDeckArts(meta)
  const sliceCount = visibleArts.length

  if (sliceCount <= 1) {
    return (
      <div
        className={styles.deckArtPanel}
        style={visibleArts[0] ? { backgroundImage: `url(${visibleArts[0]})` } : undefined}
      />
    )
  }

  // Vertical split: render one div per commander art slice
  const isPair = sliceCount === 2
  return (
    <div className={`${styles.deckArtPanel}${isPair ? ' ' + styles.deckArtPanelPair : ''}`}>
      {visibleArts.map((url, i) => (
        <div
          key={i}
          className={styles.deckArtSlice}
          style={{
            top: isPair ? (i === 0 ? '0%' : '42%') : `${(i / sliceCount) * 100}%`,
            height: isPair ? '58%' : `${100 / sliceCount}%`,
            backgroundImage: `url(${url})`,
          }}
        />
      ))}
    </div>
  )
}

// Decorate each deck with a cached parsed meta object so per-render filter/sort/
// render code paths don't re-JSON.parse the description on every pass.
function attachDeckMeta(decks) {
  return (decks || []).map(deck => ({ ...deck, __meta: parseDeckMeta(deck.description) }))
}

// enrichDecksWithCommanderArt now lives in src/lib/deckArt.js

function DeckTile({ deck, meta, fmt, colors, selectMode, isSelected, onToggleSelect, onEnterSelectMode, onDelete, navigate }) {
  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.(deck.id)
  }, { delay: 500 })
  const { fired: lpFired, ...lpRest } = longPress
  const effectiveId = (deck.type === 'deck' && meta.linked_builder_id) ? meta.linked_builder_id : deck.id
  const syncState = getSyncState(meta)
  const hasValidLink = !!(meta.linked_deck_id || meta.linked_builder_id)
  const isUnsynced = hasValidLink && !!(syncState.unsynced_builder || syncState.unsynced_collection)
  const isCollection = deck.type === 'deck'
  const description = plainPreview(meta.deckDescription)
  const tags = clampTags(meta.tags)
  const bracketMeta = fmt?.isEDH ? resolveBracketBadge(meta.bracket) : null

  return (
    <div
      className={`${styles.card}${isSelected ? ' ' + styles.cardSelected : ''}`}
      onClick={() => {
        if (lpFired.current) { lpFired.current = false; return }
        selectMode ? onToggleSelect(deck.id) : navigate(`/builder/${effectiveId}`)
      }}
      {...lpRest}
    >
      <DeckArtBackground meta={meta} deckType={deck.type} />
      <div className={styles.cardContent}>
        <div className={styles.cardTop}>
          <div className={styles.cardBadges}>
            {isCollection
              ? <span className={styles.collectionBadge}>Collection</span>
              : <span className={styles.formatBadge}>{fmt?.label || 'Builder'}</span>
            }
            {isCollection && fmt && (
              <span className={styles.formatBadge}>{fmt.label}</span>
            )}
            {bracketMeta && (
              <span
                className={styles.bracketBadge}
                style={{ borderColor: `${bracketMeta.color}55`, color: bracketMeta.color }}
                title={bracketMeta.desc}
              >
                B{meta.bracket} · {bracketMeta.label}
              </span>
            )}
            {isUnsynced && (
              <span className={styles.unsyncedBadge}>Unsynced</span>
            )}
            {meta.is_public && (
              <span className={styles.publicBadge}>Public</span>
            )}
          </div>
        </div>

        <div className={styles.cardBottom}>
          <div className={styles.cardName}>{deck.name}</div>
          {meta.commanders?.length > 0 ? (
            <div className={styles.commanderName}>
              {meta.commanders.map((c, i) => (
                <span key={i}>{i > 0 ? ' + ' : ''}{c.name}</span>
              ))}
            </div>
          ) : meta.commanderName && (
            <div className={styles.commanderName}>{meta.commanderName}</div>
          )}
          {colors.length > 0 && (
            <div className={styles.colorPips}>
              {colors.map(c => (
                <img key={c} className={styles.colorPip} src={MANA_SYMBOL_URL(c)} alt={c} title={c} />
              ))}
            </div>
          )}
          {description && (
            <div className={styles.deckDescription}>{description}</div>
          )}
          {tags.length > 0 && (
            <div className={styles.cardTags}>
              {tags.map(t => (
                <span key={t} className={styles.cardTag}>{t}</span>
              ))}
            </div>
          )}
          {!selectMode && (
            <div className={styles.cardActions}>
              <Link
                to={`/builder/${effectiveId}`}
                state={isUnsynced ? { openSync: true, source: 'builder' } : undefined}
                className={styles.editLink}
                onClick={e => e.stopPropagation()}
              >
                <EditIcon size={12} /> Edit
              </Link>
              <div className={styles.editedDate}>{fmtRelDate(deck.updated_at)}</div>
              <button
                className={styles.deleteBtn}
                onClick={e => { e.stopPropagation(); onDelete(deck.id) }}
                title="Delete deck"
              >
                <DeleteIcon size={13} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const COMMUNITY_COLOR_ORDER = ['W', 'U', 'B', 'R', 'G', 'C']

function CommunityDeckTile({ deck, meta, fmt, isOwn, creatorNick, navigate }) {
  // Prefer colors aggregated from actual deck cards; fall back to stored commander identity
  const rawColors = deck.deck_color_identity
  const colors = rawColors && rawColors.length > 0
    ? COMMUNITY_COLOR_ORDER.filter(c => rawColors.includes(c))
    : (meta.commanderColorIdentity || [])
  const commanderNames = meta.commanders?.length
    ? meta.commanders.map(c => c.name).join(' + ')
    : (meta.commanderName || null)
  const tags        = clampTags(meta.tags)
  const description = plainPreview(meta.deckDescription)

  return (
    <div className={styles.card} onClick={() => navigate(`/d/${deck.id}`)}>
      <DeckArtBackground meta={meta} />
      <div className={styles.cardContent}>
        <div className={styles.cardTop}>
          <div className={styles.cardBadges}>
            {deck.type === 'deck'
              ? <span className={styles.collectionBadge}>Collection</span>
              : <span className={styles.formatBadge}>{fmt?.label || 'Builder'}</span>
            }
            {deck.type === 'deck' && fmt && <span className={styles.formatBadge}>{fmt.label}</span>}
            {isOwn && <span className={styles.collectionBadge}>Yours</span>}
          </div>
          {creatorNick && !isOwn && <div className={styles.creatorNick}>by <Link to={`/profile/${encodeURIComponent(creatorNick)}`} className={styles.creatorNickLink} onClick={e => e.stopPropagation()}>{creatorNick}</Link></div>}
        </div>
        <div className={styles.cardBottom}>
          <div className={styles.cardName}>{deck.name}</div>
          {commanderNames && <div className={styles.commanderName}>{commanderNames}</div>}
          {colors.length > 0 && (
            <div className={styles.colorPips}>
              {colors.map(c => (
                <img key={c} className={styles.colorPip} src={MANA_SYMBOL_URL(c)} alt={c} title={c} />
              ))}
            </div>
          )}
          {description && (
            <div className={styles.deckDescription}>{description}</div>
          )}
          {tags.length > 0 && (
            <div className={styles.cardTags}>
              {tags.map(t => (
                <span key={t} className={styles.cardTag}>{t}</span>
              ))}
            </div>
          )}
          <div className={styles.cardActions}>
            <button
              className={styles.editLink}
              onClick={e => { e.stopPropagation(); navigate(`/d/${deck.id}`) }}
            >
              <EditIcon size={12} /> View
            </button>
            {(deck.like_count > 0 || deck.comment_count > 0) && (
              <span className={styles.communityStats}>♥ {deck.like_count || 0} · 💬 {deck.comment_count || 0}</span>
            )}
            <div className={styles.editedDate}>{fmtRelDate(deck.updated_at)}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Render order: Name pair first (alphabetical convention), Format, then the
// date-based default at the bottom. `useState('updated')` still defaults the
// page to Recently Updated regardless of menu order.
const SORT_LABELS = {
  name: 'Name A→Z',
  name_desc: 'Name Z→A',
  format: 'Format',
  updated: 'Recently Updated',
}
const TYPE_LABELS = [['all', 'All'], ['builder', 'Builder'], ['collection', 'Collection']]

export default function BuilderPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { showToast } = useToast()
  const [decks, setDecks]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [showNew, setShowNew]     = useState(false)
  const [newName, setNewName]     = useState('')
  const [newFormat, setNewFormat] = useState('commander')
  const [creating, setCreating]   = useState(false)
  const [newMode, setNewMode]     = useState('blank')   // 'blank' | 'guided' | 'import'
  const [guidedCmd, setGuidedCmd] = useState(null)      // selected commander sfCard

  const [confirmState, setConfirmState] = useState(null)
  const confirmAsync = (message) => new Promise(resolve => setConfirmState({ message, resolve }))
  const handleConfirm = (result) => { confirmState?.resolve(result); setConfirmState(null) }

  const [pageTab, setPageTab]               = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('tab') === 'browser' ? 'community' : 'my'
  })
  const [communityDecks, setCommunityDecks] = useState([])
  const [communityNicks, setCommunityNicks] = useState({})
  const [communityLoading, setCommunityLoading] = useState(false)
  const [communityLoaded,  setCommunityLoaded]  = useState(false)
  const [communitySearch,  setCommunitySearch]  = useState('')
  const [communityFormat,  setCommunityFormat]  = useState('all')
  const [communitySort,    setCommunitySort]    = useState('recent')   // trending | recent | commented | name
  const [communityColors,  setCommunityColors]  = useState(() => new Set())
  const [communityPage,    setCommunityPage]    = useState(1)
  const COMMUNITY_PAGE_SIZE = 36

  const [search, setSearch]         = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [visFilter, setVisFilter]   = useState('all')
  const [sortBy, setSortBy]         = useState('updated')

  const [selectMode, setSelectMode]   = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const backfillRunningRef = useRef(false)

  const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G', 'C']

  useEffect(() => { loadDecks() }, [])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    setPageTab(params.get('tab') === 'browser' ? 'community' : 'my')
  }, [location.search])

  async function loadDecks() {
    setLoading(true)
    const { data } = await sb.rpc('get_my_decks')
    // server already filters groups/hidden/paired — keep client guard for safety
    const nonGroupDecks = (Array.isArray(data) ? data : []).filter(f => {
      try {
        const m = JSON.parse(f.description || '{}')
        if (m.isGroup || m.hideFromBuilder) return false
        if (f.type === 'builder_deck' && m.linked_deck_id) return false
        return true
      } catch { return true }
    })
    const withArt = attachDeckMeta(await enrichDecksWithCommanderArt(nonGroupDecks, { persist: true }))
    setDecks(withArt)
    setLoading(false)
    backfillMissingBrackets(withArt)
  }

  // One-time-per-deck bracket estimate for decks that existed before bracket
  // persistence shipped (or were never opened in Builder since). Runs quietly
  // in the background so "My Decks" tiles show a pill without the user having
  // to open every deck once. Skips anything that already has a stored value.
  async function backfillMissingBrackets(deckList) {
    if (backfillRunningRef.current) return
    const targets = (deckList || []).filter(d => {
      const fmt = FORMATS.find(f => f.id === (d.__meta.format || 'commander'))
      return fmt?.isEDH && d.__meta.bracket == null
    })
    if (!targets.length) return
    backfillRunningRef.current = true
    try {
      const gameChangerNames = await fetchGameChangerNames()
      for (const deck of targets) {
        try {
          const cardList = deck.type === 'deck'
            ? await fetchDeckAllocations(deck.id)
            : await fetchDeckCards(deck.id)
          const sfMap = cardList.length ? await loadCardMapWithSharedPrices(cardList, { requireOracle: true }) : {}
          const normalized = normalizeDeckBuilderCards(cardList, sfMap)
          const { bracket } = analyzeBracket({ cards: normalized, gameChangerNames })
          const nextMeta = computeBracketMetaPatch(deck.__meta, bracket, false)
          if (!nextMeta) continue
          const persisted = await patchDeckMeta(deck.id, deck.__meta, nextMeta)
          setDecks(prev => prev.map(d => d.id === deck.id ? { ...d, description: serializeDeckMeta(persisted), __meta: persisted } : d))
        } catch (err) {
          console.warn('[Builder] bracket backfill failed for deck', deck.id, err)
        }
      }
    } finally {
      backfillRunningRef.current = false
    }
  }

  async function loadCommunityDecks() {
    if (communityLoading) return
    setCommunityLoading(true)
    try {
      const { data } = await sb.rpc('get_community_decks')
      const decks = Array.isArray(data) ? data : []
      setCommunityDecks(attachDeckMeta(await enrichDecksWithCommanderArt(decks)))
      setCommunityLoaded(true)
      // Batch-fetch nicknames for all unique creators in one RPC round trip.
      const uniqueIds = [...new Set(decks.map(d => d.user_id).filter(Boolean))]
      if (uniqueIds.length) {
        sb.rpc('get_user_nicknames', { p_user_ids: uniqueIds })
          .then(({ data, error }) => {
            if (error) { console.warn('[Builder] get_user_nicknames failed:', error); return }
            setCommunityNicks(Object.fromEntries((data || []).map(row => [row.user_id, row.nickname])))
          })
          .catch(() => {})
      }
    } catch {
      setCommunityDecks([])
    } finally {
      setCommunityLoading(false)
    }
  }

  useEffect(() => {
    if (pageTab === 'community' && !communityLoaded) loadCommunityDecks()
  }, [pageTab, communityLoaded])

  function resetNewDeckForm() {
    setShowNew(false)
    setNewName('')
    setNewMode('blank')
    setGuidedCmd(null)
  }

  async function createDeck() {
    const guided = newMode === 'guided'
    const doImport = newMode === 'import'
    if (guided && !guidedCmd) return
    // Guided decks are Commander and default their name to the commander.
    const format = guided ? 'commander' : newFormat
    const name = (newName.trim() || (guided ? guidedCmd.name : '')).trim()
    if (!name) return

    setCreating(true)
    const description = JSON.stringify({ format })
    const { data, error } = await sb.from('folders').insert({
      user_id:     user.id,
      type:        'builder_deck',
      name,
      description,
    }).select().single()
    setCreating(false)
    if (error || !data) {
      console.error('[Builder] createDeck failed:', error)
      showToast(`Failed to create deck: ${error?.message || 'unknown error'}`, { tone: 'error', duration: 4000 })
      return
    }
    const commander = guided ? guidedCmd : null
    resetNewDeckForm()
    // For guided decks, hand the chosen commander to DeckBuilder via router
    // state — it sets the commander (full print resolution) and auto-opens the
    // build-from-collection wizard. For import, just flag the import modal to
    // auto-open once the fresh deck lands there.
    const routerState = commander ? { guidedCommander: commander } : (doImport ? { autoOpenImport: true } : null)
    navigate(`/builder/${data.id}`, routerState ? { state: routerState } : undefined)
  }

  async function deleteDeck(id) {
    const deck = decks.find(d => d.id === id)
    const isCollection = deck?.type === 'deck'
    if (isCollection) {
      const ok = await confirmAsync('Hide this deck from the builder list?\n\nThis is a collection deck, so it cannot be deleted here — only hidden. Your deck and cards are kept safe and can be restored any time by clicking "Edit in Builder" from the Decks page.')
      if (!ok) return
      setDecks(d => d.filter(x => x.id !== id))
      const baseMeta = parseDeckMeta(deck.description || '{}')
      const meta = { ...baseMeta, hideFromBuilder: true }
      try {
        await patchDeckMeta(id, baseMeta, meta)
      } catch (error) {
        console.error('[Builder] hide deck failed:', error)
        showToast(`Failed to hide deck: ${error.message}`, { tone: 'error', duration: 4000 })
        await loadDecks()
      }
    } else {
      if (!await confirmAsync('Delete this builder deck? This cannot be undone.')) return
      setDecks(d => d.filter(x => x.id !== id))
      try {
        const meta = parseDeckMeta(deck?.description || '{}')
        if (meta.linked_deck_id) {
          const { data: counterpart, error: cpErr } = await sb.from('folders').select('*').eq('id', meta.linked_deck_id).maybeSingle()
          if (cpErr) throw cpErr
          if (counterpart) await unlinkPairedDeck({ counterpart })
        }
        const { error: cardsErr } = await sb.from('deck_cards').delete().eq('deck_id', id)
        if (cardsErr) throw cardsErr
        const { error: folderErr } = await sb.from('folders').delete().eq('id', id).eq('user_id', user.id)
        if (folderErr) throw folderErr
      } catch (err) {
        console.error('[Builder] deleteDeck failed:', err)
        showToast(`Failed to delete deck: ${err?.message || 'unknown error'}`, { tone: 'error', duration: 4000 })
        // Refetch to resync the UI with whatever actually persisted.
        await loadDecks()
      }
    }
  }

  function toggleSelectMode() {
    setSelectMode(v => !v)
    setSelectedIds(new Set())
  }

  function toggleSelected(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function bulkDelete() {
    if (!selectedIds.size) return
    const ids = [...selectedIds]
    // Capture deck metadata BEFORE the optimistic state filter, otherwise the
    // per-id loop below would lose access to descriptions/types after setDecks.
    const decksById = new Map(decks.map(d => [d.id, d]))
    const collectionIds = ids.filter(id => decksById.get(id)?.type === 'deck')
    const builderIds    = ids.filter(id => decksById.get(id)?.type === 'builder_deck')
    const msg = collectionIds.length
      ? `Delete ${builderIds.length} builder deck(s) and hide ${collectionIds.length} collection deck(s) from the builder?`
      : `Delete ${ids.length} builder deck(s)?`
    if (!await confirmAsync(msg)) return
    setDecks(d => d.filter(x => !ids.includes(x.id)))

    try {
      // Hide collection decks: one upsert per deck since description differs per row.
      await Promise.all(collectionIds.map(async id => {
        const deck = decksById.get(id)
        const baseMeta = parseDeckMeta(deck?.description || '{}')
        return patchDeckMeta(id, baseMeta, { ...baseMeta, hideFromBuilder: true })
      }))

      // Unlink any paired collection counterparts before deleting builder decks.
      const counterpartIds = builderIds
        .map(id => parseDeckMeta(decksById.get(id)?.description || '{}').linked_deck_id)
        .filter(Boolean)
      if (counterpartIds.length) {
        const { data: counterparts, error: cpErr } = await sb.from('folders').select('*').in('id', counterpartIds)
        if (cpErr) throw cpErr
        await Promise.all((counterparts || []).map(counterpart => unlinkPairedDeck({ counterpart })))
      }

      if (builderIds.length) {
        // Batch deletes via .in() — single round-trip each instead of N.
        const { error: cardsErr } = await sb.from('deck_cards').delete().in('deck_id', builderIds)
        if (cardsErr) throw cardsErr
        const { error: folderErr } = await sb.from('folders').delete().in('id', builderIds).eq('user_id', user.id)
        if (folderErr) throw folderErr
      }
    } catch (err) {
      console.error('[Builder] bulkDelete failed:', err)
      showToast(`Bulk delete failed: ${err?.message || 'unknown error'}`, { tone: 'error', duration: 4000 })
      await loadDecks()
    }
    toggleSelectMode()
  }

  const currentFormat = FORMATS.find(f => f.id === newFormat) || FORMATS[0]

  const filtered = decks
    .filter(d => {
      if (search && !d.name.toLowerCase().includes(search.toLowerCase())) return false
      if (typeFilter === 'builder' && d.type !== 'builder_deck') return false
      if (typeFilter === 'collection' && d.type !== 'deck') return false
      if (visFilter !== 'all') {
        const isPublic = !!(d.__meta?.is_public)
        if (visFilter === 'public' && !isPublic) return false
        if (visFilter === 'private' && isPublic) return false
      }
      return true
    })
    .sort((a, b) => {
      if (sortBy === 'name')      return a.name.localeCompare(b.name)
      if (sortBy === 'name_desc') return b.name.localeCompare(a.name)
      if (sortBy === 'format') {
        return (a.__meta?.format || '').localeCompare(b.__meta?.format || '')
      }
      // 'updated' (default) — explicitly sort by updated_at desc instead of relying
      // on RPC ordering. Falls back to created_at / id for stability.
      const ta = Date.parse(a.updated_at || a.created_at || 0) || 0
      const tb = Date.parse(b.updated_at || b.created_at || 0) || 0
      return tb - ta
    })

  const communityColorActive  = communityColors.size > 0
  const communityFiltersActive = !!communitySearch.trim() || communityFormat !== 'all' || communityColorActive

  const filteredCommunity = communityDecks
    .filter(d => {
      const meta = d.__meta || parseDeckMeta(d.description)
      const q = communitySearch.trim().toLowerCase()
      if (q) {
        const cmd = (meta.commanders?.map(c => c.name).join(' ') || meta.commanderName || '').toLowerCase()
        if (!d.name.toLowerCase().includes(q) && !cmd.includes(q)) return false
      }
      if (communityFormat !== 'all' && meta.format !== communityFormat) return false
      if (communityColorActive) {
        const ci = d.deck_color_identity || meta.commanderColorIdentity || []
        for (const c of communityColors) if (!ci.includes(c)) return false
      }
      return true
    })
    .sort((a, b) => {
      if (communitySort === 'name')      return (a.name || '').localeCompare(b.name || '')
      if (communitySort === 'commented') return (b.comment_count || 0) - (a.comment_count || 0)
      if (communitySort === 'trending')  return (b.like_count || 0) - (a.like_count || 0)
      return (Date.parse(b.updated_at || b.created_at || 0) || 0) - (Date.parse(a.updated_at || a.created_at || 0) || 0)
    })

  // "Trending recently": most-liked decks touched in the last 30 days. Only on
  // the unfiltered landing view; excluded from the grid below to avoid repeats.
  const TRENDING_WINDOW_MS = 30 * 24 * 3600 * 1000
  const trendingDecks = communityFiltersActive ? [] : [...communityDecks]
    .filter(d => (d.like_count || 0) > 0 && (Date.now() - (Date.parse(d.updated_at || d.created_at || 0) || 0)) < TRENDING_WINDOW_MS)
    .sort((a, b) => (b.like_count || 0) - (a.like_count || 0))
    .slice(0, 3)
  const trendingIds = new Set(trendingDecks.map(d => d.id))
  const communityGrid = trendingDecks.length ? filteredCommunity.filter(d => !trendingIds.has(d.id)) : filteredCommunity

  const communityTotalPages = Math.max(1, Math.ceil(communityGrid.length / COMMUNITY_PAGE_SIZE))
  const communityPageDecks  = communityGrid.slice((communityPage - 1) * COMMUNITY_PAGE_SIZE, communityPage * COMMUNITY_PAGE_SIZE)

  return (
    <div className={styles.page}>
      <SectionHeader
        title={pageTab === 'my' ? 'My Decks' : 'Deck Browser'}
        subtitle={pageTab === 'my' ? 'Build and manage your MTG decks' : 'Browse and copy public decks from the community'}
        action={pageTab === 'my' ? <Button onClick={() => setShowNew(true)}>+ New Deck</Button> : null}
      />

      {/* ── My Decks tab ── */}
      {pageTab === 'my' && <>
        <div className={styles.filterBar}>
          <input
            className={styles.filterInput}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search decks…"
          />
          <div className={styles.filterGroup}>
            {TYPE_LABELS.map(([v, label]) => (
              <button key={v}
                className={`${styles.filterPill}${typeFilter === v ? ' ' + styles.filterPillActive : ''}`}
                onClick={() => setTypeFilter(v)}>
                {label}
              </button>
            ))}
          </div>
          <div className={styles.filterGroup}>
            {[['all','All'],['public','Public'],['private','Private']].map(([v, label]) => (
              <button key={v}
                className={`${styles.filterPill}${visFilter === v ? ' ' + styles.filterPillActive : ''}`}
                onClick={() => setVisFilter(v)}>
                {label}
              </button>
            ))}
          </div>
          <ResponsiveMenu
            title="Sort By"
            wrapClassName={styles.sortMenuWrap}
            trigger={({ toggle }) => (
              <button className={`${styles.filterPill} ${styles.filterPillActive}`} onClick={toggle}>
                {SORT_LABELS[sortBy]} <ChevronDownIcon size={10} />
              </button>
            )}
          >
            {({ close }) => (
              <div className={uiStyles.responsiveMenuList}>
                {Object.entries(SORT_LABELS).map(([v, label]) => (
                  <button key={v}
                    className={`${uiStyles.responsiveMenuAction} ${sortBy === v ? uiStyles.responsiveMenuActionActive : ''}`}
                    onClick={() => { setSortBy(v); close() }}>
                    <span>{label}</span>
                    <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">
                      {sortBy === v ? <CheckIcon size={11} /> : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </ResponsiveMenu>
          <button
            className={`${styles.filterPill}${selectMode ? ' ' + styles.filterPillActive : ''}`}
            onClick={toggleSelectMode}>
            {selectMode ? 'Cancel' : 'Select'}
          </button>
        </div>

        {selectMode && selectedIds.size > 0 && (
          <div className={styles.bulkBar}>
            <span>{selectedIds.size} selected</span>
            <button onClick={() => setSelectedIds(new Set(filtered.map(d => d.id)))}>Select all</button>
            <button onClick={() => setSelectedIds(new Set())}>Deselect</button>
            <button className={styles.bulkDelete} onClick={bulkDelete}>Delete {selectedIds.size}</button>
            <button onClick={toggleSelectMode}>Cancel</button>
          </div>
        )}

        {loading && <EmptyState>Loading…</EmptyState>}

        {!loading && filtered.length === 0 && decks.length === 0 && (
          <EmptyState>
            No decks yet.<br />
            Create one to start planning your perfect deck.
          </EmptyState>
        )}

        {!loading && filtered.length === 0 && decks.length > 0 && (
          <EmptyState>No decks match your filter.</EmptyState>
        )}

        {!loading && filtered.length > 0 && (
          <div className={styles.grid}>
            {filtered.map(deck => {
              const meta      = deck.__meta || parseDeckMeta(deck.description)
              const fmt       = FORMATS.find(f => f.id === (meta.format || 'commander'))
              const rawColors = deck.deck_color_identity
              const colors    = rawColors && rawColors.length > 0
                ? COLOR_ORDER.filter(c => rawColors.includes(c))
                : (meta.commanderColorIdentity || [])
              return (
                <DeckTile
                  key={deck.id}
                  deck={deck}
                  meta={meta}
                  fmt={fmt}
                  colors={colors}
                  selectMode={selectMode}
                  isSelected={selectedIds.has(deck.id)}
                  onToggleSelect={toggleSelected}
                  onEnterSelectMode={() => setSelectMode(true)}
                  onDelete={deleteDeck}
                  navigate={navigate}
                />
              )
            })}
          </div>
        )}
      </>}

      {/* ── Community / Deck Browser ── */}
      {pageTab === 'community' && <>
        <div className={styles.filterBar}>
          <input
            className={styles.filterInput}
            value={communitySearch}
            onChange={e => { setCommunitySearch(e.target.value); setCommunityPage(1) }}
            placeholder="Search by deck or commander…"
          />
          <div className={styles.filterGroup}>
            {[['all','All'],['commander','Commander'],['standard','Standard'],['modern','Modern'],['pioneer','Pioneer'],['legacy','Legacy']].map(([v, label]) => (
              <button key={v}
                className={`${styles.filterPill}${communityFormat === v ? ' ' + styles.filterPillActive : ''}`}
                onClick={() => { setCommunityFormat(v); setCommunityPage(1) }}>
                {label}
              </button>
            ))}
          </div>
          <div className={styles.filterGroup}>
            {COLOR_ORDER.map(c => (
              <button key={c}
                className={`${styles.colorFilterPip}${communityColors.has(c) ? ' ' + styles.colorFilterPipActive : ''}`}
                title={`Filter ${c}`}
                onClick={() => {
                  setCommunityColors(prev => { const n = new Set(prev); n.has(c) ? n.delete(c) : n.add(c); return n })
                  setCommunityPage(1)
                }}>
                <img src={MANA_SYMBOL_URL(c)} alt={c} />
              </button>
            ))}
          </div>
          <div className={styles.filterGroup}>
            {[['trending','Trending'],['recent','Recent'],['commented','Comments'],['name','A→Z']].map(([v, label]) => (
              <button key={v}
                className={`${styles.filterPill}${communitySort === v ? ' ' + styles.filterPillActive : ''}`}
                onClick={() => { setCommunitySort(v); setCommunityPage(1) }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {!communityLoading && trendingDecks.length > 0 && (
          <div className={styles.trendingSection}>
            <div className={styles.trendingLabel}>Trending now</div>
            <div className={styles.trendingGrid}>
              {trendingDecks.map(deck => {
                const meta  = deck.__meta || parseDeckMeta(deck.description)
                const fmt   = FORMATS.find(f => f.id === (meta.format || 'commander'))
                const isOwn = deck.user_id === user?.id
                return (
                  <CommunityDeckTile
                    key={deck.id}
                    deck={deck}
                    meta={meta}
                    fmt={fmt}
                    isOwn={isOwn}
                    creatorNick={communityNicks[deck.user_id] || null}
                    navigate={navigate}
                  />
                )
              })}
            </div>
          </div>
        )}

        {communityLoading && <EmptyState>Loading community decks…</EmptyState>}
        {!communityLoading && !communityLoaded && <EmptyState>Loading…</EmptyState>}

        {!communityLoading && communityLoaded && filteredCommunity.length === 0 && (
          <EmptyState>
            No public decks found{communitySearch || communityFormat !== 'all' ? ' matching your filter' : ''}.<br />
            Be the first — open a deck in the builder and enable &quot;Public&quot; in the Stats tab.
          </EmptyState>
        )}

        {!communityLoading && communityGrid.length > 0 && (
          <>
            {trendingDecks.length > 0 && <div className={styles.communityAllLabel}>All Decks</div>}
            <div className={styles.grid}>
              {communityPageDecks.map(deck => {
                const meta  = deck.__meta || parseDeckMeta(deck.description)
                const fmt   = FORMATS.find(f => f.id === (meta.format || 'commander'))
                const isOwn = deck.user_id === user?.id
                return (
                  <CommunityDeckTile
                    key={deck.id}
                    deck={deck}
                    meta={meta}
                    fmt={fmt}
                    isOwn={isOwn}
                    creatorNick={communityNicks[deck.user_id] || null}
                    navigate={navigate}
                  />
                )
              })}
            </div>
            {communityTotalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '16px 0' }}>
                <button
                  onClick={() => setCommunityPage(p => Math.max(1, p - 1))}
                  disabled={communityPage === 1}
                  style={{ padding: '5px 14px', background: 'var(--s3)', border: '1px solid var(--s-border2)', borderRadius: 6, color: 'var(--text)', cursor: communityPage === 1 ? 'default' : 'pointer', opacity: communityPage === 1 ? 0.4 : 1 }}
                >←</button>
                <span style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>
                  Page {communityPage} of {communityTotalPages}
                </span>
                <button
                  onClick={() => setCommunityPage(p => Math.min(communityTotalPages, p + 1))}
                  disabled={communityPage === communityTotalPages}
                  style={{ padding: '5px 14px', background: 'var(--s3)', border: '1px solid var(--s-border2)', borderRadius: 6, color: 'var(--text)', cursor: communityPage === communityTotalPages ? 'default' : 'pointer', opacity: communityPage === communityTotalPages ? 0.4 : 1 }}
                >→</button>
              </div>
            )}
          </>
        )}
      </>}

      {confirmState && (
        <div className={styles.confirmOverlay} onClick={() => handleConfirm(false)}>
          <div className={styles.confirmDialog} onClick={e => e.stopPropagation()}>
            <div className={styles.confirmMsg}>
              {confirmState.message.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}
            </div>
            <div className={styles.confirmActions}>
              <button className={styles.confirmCancel} onClick={() => handleConfirm(false)}>Cancel</button>
              <button className={styles.confirmOk} onClick={() => handleConfirm(true)}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {showNew && (
        <Modal onClose={resetNewDeckForm} allowOverflow>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 16, fontSize: '1rem' }}>
            New Builder Deck
          </h2>

          {/* Mode toggle: blank deck vs guided build-from-collection vs import */}
          <div className={styles.newModeToggle}>
            <button
              type="button"
              className={`${styles.newModeBtn} ${newMode === 'blank' ? styles.newModeActive : ''}`}
              onClick={() => setNewMode('blank')}
            >
              <span className={styles.newModeTitle}>Blank deck</span>
              <span className={styles.newModeDesc}>Start empty in any format</span>
            </button>
            <button
              type="button"
              className={`${styles.newModeBtn} ${newMode === 'guided' ? styles.newModeActive : ''}`}
              onClick={() => setNewMode('guided')}
            >
              <span className={styles.newModeTitle}>Guided build</span>
              <span className={styles.newModeDesc}>Commander, built from your collection</span>
            </button>
            <button
              type="button"
              className={`${styles.newModeBtn} ${newMode === 'import' ? styles.newModeActive : ''}`}
              onClick={() => setNewMode('import')}
            >
              <span className={styles.newModeTitle}>Import deck</span>
              <span className={styles.newModeDesc}>Paste a list, upload a file, or import a URL</span>
            </button>
          </div>

          <div className={styles.newDeckForm}>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createDeck()}
              placeholder={newMode === 'guided' ? 'Deck name (optional — defaults to commander)…' : 'Deck name…'}
              className={styles.newDeckInput}
            />

            {newMode !== 'guided' ? (
              <ResponsiveMenu
                title="Select Format"
                align="left"
                wrapClassName={styles.newDeckSelectWrap}
                panelClassName={styles.newDeckMenuPanel}
                trigger={({ open, toggle }) => (
                  <button
                    type="button"
                    className={`${styles.newDeckSelect} ${open ? styles.newDeckSelectOpen : ''}`}
                    onClick={toggle}
                    aria-haspopup="menu"
                    aria-expanded={open}
                  >
                    <span>{currentFormat?.label || 'Select format'}</span>
                    <span className={styles.newDeckSelectChevron} aria-hidden="true">{open ? '▲' : '▼'}</span>
                  </button>
                )}
              >
                {({ close }) => (
                  <div className={uiStyles.responsiveMenuList}>
                    {FORMATS.map(f => (
                      <button
                        key={f.id}
                        type="button"
                        className={`${uiStyles.responsiveMenuAction} ${f.id === newFormat ? uiStyles.responsiveMenuActionActive : ''}`}
                        onClick={() => { setNewFormat(f.id); close() }}
                      >
                        <span>{f.label}</span>
                        <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">
                          {f.id === newFormat ? <CheckIcon size={11} /> : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </ResponsiveMenu>
            ) : (
              <GuidedCommanderPicker
                userId={user.id}
                value={guidedCmd}
                onSelect={sf => {
                  setGuidedCmd(sf)
                  if (!newName.trim()) setNewName(sf.name)
                }}
              />
            )}

            <div className={styles.newDeckActions}>
              <Button onClick={resetNewDeckForm} style={{ background: 'transparent' }}>Cancel</Button>
              <Button
                onClick={createDeck}
                disabled={creating || (newMode === 'guided' ? !guidedCmd : !newName.trim())}
              >
                {creating ? 'Creating…' : (newMode === 'guided' ? 'Start Building' : newMode === 'import' ? 'Create & Import' : 'Create')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
