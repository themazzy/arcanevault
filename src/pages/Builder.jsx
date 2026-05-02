import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link, useLocation } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { Button, Modal, EmptyState, SectionHeader, ResponsiveMenu } from '../components/UI'
import { parseDeckMeta, FORMATS } from '../lib/deckBuilderApi'
import { unlinkPairedDeck, getSyncState } from '../lib/deckSync'
import styles from './Builder.module.css'
import uiStyles from '../components/UI.module.css'
import { useLongPress } from '../hooks/useLongPress'
import { CheckIcon, DeleteIcon, EditIcon, ChevronDownIcon } from '../icons'

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

// Truncate a tag list to a rough character budget so it fits within
// the fixed-height tile. Appends a '…' chip if any tags were dropped.
const TAG_CHAR_BUDGET = 36
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

// Session-level image cache
const _artCache = {}

function DeckArtBackground({ meta, deckType }) {
  const [art, setArt] = useState(meta.coverArtUri || null)
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    if (art) return
    const sfId = meta.commanderScryfallId
    if (!sfId) return
    if (_artCache[sfId] !== undefined) { setArt(_artCache[sfId]); return }
    _artCache[sfId] = null
    fetch(`https://api.scryfall.com/cards/${sfId}?format=json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const url = d?.image_uris?.art_crop || d?.card_faces?.[0]?.image_uris?.art_crop || null
        _artCache[sfId] = url
        if (isMounted.current && url) setArt(url)
      })
      .catch(() => {})
    return () => { isMounted.current = false }
  }, [meta.commanderScryfallId, art])
  return (
    <div
      className={styles.deckArtPanel}
      style={art ? { backgroundImage: `url(${art})` } : undefined}
    />
  )
}

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
  const description = (meta.deckDescription || '').trim()
  const tags = clampTags(meta.tags)

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
        {selectMode && (
          <div className={`${styles.deckCheckbox}${isSelected ? ' ' + styles.deckCheckboxChecked : ''}`}>
            {isSelected && <CheckIcon size={11} />}
          </div>
        )}

        <div className={styles.cardTop}>
          <div className={styles.cardBadges}>
            {isCollection
              ? <span className={styles.collectionBadge}>Collection</span>
              : <span className={styles.formatBadge}>{fmt?.label || 'Builder'}</span>
            }
            {isCollection && fmt && (
              <span className={styles.formatBadge}>{fmt.label}</span>
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
          {meta.commanderName && (
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
  const commander   = meta.commanderName || null
  const tags        = clampTags(meta.tags)
  const art         = meta.coverArtUri || null
  const description = (meta.deckDescription || '').trim()

  return (
    <div className={styles.card} onClick={() => navigate(`/d/${deck.id}`)}>
      <div
        className={styles.deckArtPanel}
        style={art ? { backgroundImage: `url(${art})` } : undefined}
      />
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
          {commander && <div className={styles.commanderName}>{commander}</div>}
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
            <div className={styles.editedDate}>{fmtRelDate(deck.updated_at)}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

const SORT_LABELS = { updated: 'Recent', name: 'Name', format: 'Format' }
const TYPE_LABELS = [['all', 'All'], ['builder', 'Builder'], ['collection', 'Collection']]

export default function BuilderPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [decks, setDecks]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [showNew, setShowNew]     = useState(false)
  const [newName, setNewName]     = useState('')
  const [newFormat, setNewFormat] = useState('commander')
  const [creating, setCreating]   = useState(false)

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
  const [communityPage,    setCommunityPage]    = useState(1)
  const COMMUNITY_PAGE_SIZE = 36

  const [search, setSearch]         = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [visFilter, setVisFilter]   = useState('all')
  const [sortBy, setSortBy]         = useState('updated')

  const [selectMode, setSelectMode]   = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())

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
    setDecks(nonGroupDecks)
    setLoading(false)
  }

  async function loadCommunityDecks() {
    if (communityLoading) return
    setCommunityLoading(true)
    try {
      const { data } = await sb.rpc('get_community_decks')
      const decks = Array.isArray(data) ? data : []
      setCommunityDecks(decks)
      setCommunityLoaded(true)
      // Batch-fetch nicknames for all unique creators
      const uniqueIds = [...new Set(decks.map(d => d.user_id).filter(Boolean))]
      Promise.all(uniqueIds.map(id =>
        sb.rpc('get_user_nickname', { p_user_id: id }).then(({ data: nick }) => [id, nick])
      )).then(pairs => {
        setCommunityNicks(Object.fromEntries(pairs.filter(([, nick]) => nick)))
      }).catch(() => {})
    } catch {
      setCommunityDecks([])
    } finally {
      setCommunityLoading(false)
    }
  }

  useEffect(() => {
    if (pageTab === 'community' && !communityLoaded) loadCommunityDecks()
  }, [pageTab, communityLoaded])

  async function createDeck() {
    if (!newName.trim()) return
    setCreating(true)
    const description = JSON.stringify({ format: newFormat })
    const { data, error } = await sb.from('folders').insert({
      user_id:     user.id,
      type:        'builder_deck',
      name:        newName.trim(),
      description,
    }).select().single()
    setCreating(false)
    if (!error && data) {
      setShowNew(false)
      setNewName('')
      navigate(`/builder/${data.id}`)
    }
  }

  async function deleteDeck(id) {
    const deck = decks.find(d => d.id === id)
    const isCollection = deck?.type === 'deck'
    if (isCollection) {
      const ok = await confirmAsync('Hide this deck from the builder list?\n\nThis is a collection deck, so it cannot be deleted here — only hidden. Your deck and cards are kept safe and can be restored any time by clicking "Edit in Builder" from the Decks page.')
      if (!ok) return
      setDecks(d => d.filter(x => x.id !== id))
      let meta = {}
      try { meta = JSON.parse(deck.description || '{}') } catch {}
      meta.hideFromBuilder = true
      await sb.from('folders').update({ description: JSON.stringify(meta) }).eq('id', id).eq('user_id', user.id)
    } else {
      if (!await confirmAsync('Delete this builder deck? This cannot be undone.')) return
      setDecks(d => d.filter(x => x.id !== id))
      const meta = parseDeckMeta(deck?.description || '{}')
      if (meta.linked_deck_id) {
        const { data: counterpart } = await sb.from('folders').select('*').eq('id', meta.linked_deck_id).maybeSingle()
        if (counterpart) await unlinkPairedDeck({ counterpart })
      }
      await sb.from('deck_cards').delete().eq('deck_id', id)
      await sb.from('folders').delete().eq('id', id).eq('user_id', user.id)
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
    const collectionIds = ids.filter(id => decks.find(d => d.id === id)?.type === 'deck')
    const builderIds    = ids.filter(id => decks.find(d => d.id === id)?.type !== 'deck')
    const msg = collectionIds.length
      ? `Delete ${builderIds.length} builder deck(s) and hide ${collectionIds.length} collection deck(s) from the builder?`
      : `Delete ${ids.length} builder deck(s)?`
    if (!await confirmAsync(msg)) return
    setDecks(d => d.filter(x => !ids.includes(x.id)))
    for (const id of collectionIds) {
      const deck = decks.find(d => d.id === id)
      let meta = {}
      try { meta = JSON.parse(deck?.description || '{}') } catch {}
      meta.hideFromBuilder = true
      await sb.from('folders').update({ description: JSON.stringify(meta) }).eq('id', id).eq('user_id', user.id)
    }
    for (const id of builderIds) {
      const deck = decks.find(d => d.id === id)
      const meta = parseDeckMeta(deck?.description || '{}')
      if (meta.linked_deck_id) {
        const { data: counterpart } = await sb.from('folders').select('*').eq('id', meta.linked_deck_id).maybeSingle()
        if (counterpart) await unlinkPairedDeck({ counterpart })
      }
      await sb.from('deck_cards').delete().eq('deck_id', id)
      await sb.from('folders').delete().eq('id', id).eq('user_id', user.id)
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
        const isPublic = !!(parseDeckMeta(d.description).is_public)
        if (visFilter === 'public' && !isPublic) return false
        if (visFilter === 'private' && isPublic) return false
      }
      return true
    })
    .sort((a, b) => {
      if (sortBy === 'name')   return a.name.localeCompare(b.name)
      if (sortBy === 'format') {
        const ma = parseDeckMeta(a.description)
        const mb = parseDeckMeta(b.description)
        return (ma.format || '').localeCompare(mb.format || '')
      }
      return 0
    })

  const filteredCommunity = communityDecks.filter(d => {
    const meta = parseDeckMeta(d.description)
    if (communitySearch && !d.name.toLowerCase().includes(communitySearch.toLowerCase())) return false
    if (communityFormat !== 'all' && meta.format !== communityFormat) return false
    return true
  })
  const communityTotalPages = Math.max(1, Math.ceil(filteredCommunity.length / COMMUNITY_PAGE_SIZE))
  const communityPageDecks  = filteredCommunity.slice((communityPage - 1) * COMMUNITY_PAGE_SIZE, communityPage * COMMUNITY_PAGE_SIZE)

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
              const meta      = parseDeckMeta(deck.description)
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
            placeholder="Search community decks…"
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
        </div>

        {communityLoading && <EmptyState>Loading community decks…</EmptyState>}
        {!communityLoading && !communityLoaded && <EmptyState>Loading…</EmptyState>}

        {!communityLoading && communityLoaded && filteredCommunity.length === 0 && (
          <EmptyState>
            No public decks found{communitySearch || communityFormat !== 'all' ? ' matching your filter' : ''}.<br />
            Be the first — open a deck in the builder and enable &quot;Public&quot; in the Stats tab.
          </EmptyState>
        )}

        {!communityLoading && filteredCommunity.length > 0 && (
          <>
            <div className={styles.grid}>
              {communityPageDecks.map(deck => {
                const meta  = parseDeckMeta(deck.description)
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
        <Modal onClose={() => setShowNew(false)} allowOverflow>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 16, fontSize: '1rem' }}>
            New Builder Deck
          </h2>
          <div className={styles.newDeckForm}>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createDeck()}
              placeholder="Deck name…"
              className={styles.newDeckInput}
            />
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
            <div className={styles.newDeckActions}>
              <Button onClick={() => setShowNew(false)} style={{ background: 'transparent' }}>Cancel</Button>
              <Button onClick={createDeck} disabled={creating || !newName.trim()}>
                {creating ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
