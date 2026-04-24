import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { Button, Modal, EmptyState, SectionHeader, ResponsiveMenu } from '../components/UI'
import { parseDeckMeta, FORMATS } from '../lib/deckBuilderApi'
import { unlinkPairedDeck, getSyncState } from '../lib/deckSync'
import styles from './Builder.module.css'
import uiStyles from '../components/UI.module.css'
import { useLongPress } from '../hooks/useLongPress'
import { CheckIcon, DeleteIcon, EditIcon, ChevronDownIcon } from '../icons'

const COLOR_LABEL = { W: '#f8f0d8', U: '#4488cc', B: '#8855aa', R: '#cc4444', G: '#44884a', C: '#aaaaaa' }

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
  if (!art) return null
  return <div className={styles.deckArt} style={{ backgroundImage: `url(${art})` }} />
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
                <span key={c} className={styles.colorPip} style={{ background: COLOR_LABEL[c] || '#666' }} title={c} />
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

function CommunityDeckTile({ deck, meta, fmt, isOwn, navigate }) {
  const colors    = meta.commanderColorIdentity || []
  const commander = meta.commanderName || null
  const tags      = meta.tags || []
  const art       = meta.coverArtUri || null

  return (
    <div className={styles.card} onClick={() => navigate(`/d/${deck.id}`)}>
      {art && <div className={styles.deckArt} style={{ backgroundImage: `url(${art})` }} />}
      <div className={styles.cardContent}>
        <div className={styles.cardTop}>
          <div className={styles.cardBadges}>
            <span className={styles.formatBadge}>{fmt?.label || 'Builder'}</span>
            {isOwn && <span className={styles.collectionBadge}>Yours</span>}
          </div>
        </div>
        <div className={styles.cardBottom}>
          <div className={styles.cardName}>{deck.name}</div>
          {commander && <div className={styles.commanderName}>{commander}</div>}
          {colors.length > 0 && (
            <div className={styles.colorPips}>
              {colors.map(c => (
                <span key={c} className={styles.colorPip} style={{ background: COLOR_LABEL[c] || '#888' }} />
              ))}
            </div>
          )}
          {tags.length > 0 && (
            <div className={styles.cardTags}>
              {tags.slice(0, 3).map(t => (
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
  const [decks, setDecks]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [showNew, setShowNew]     = useState(false)
  const [newName, setNewName]     = useState('')
  const [newFormat, setNewFormat] = useState('commander')
  const [creating, setCreating]   = useState(false)

  const [confirmState, setConfirmState] = useState(null)
  const confirmAsync = (message) => new Promise(resolve => setConfirmState({ message, resolve }))
  const handleConfirm = (result) => { confirmState?.resolve(result); setConfirmState(null) }

  const [pageTab, setPageTab]               = useState('my')
  const [communityDecks, setCommunityDecks] = useState([])
  const [communityLoading, setCommunityLoading] = useState(false)
  const [communityLoaded,  setCommunityLoaded]  = useState(false)
  const [communitySearch,  setCommunitySearch]  = useState('')
  const [communityFormat,  setCommunityFormat]  = useState('all')

  const [search, setSearch]         = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [sortBy, setSortBy]         = useState('updated')

  const [selectMode, setSelectMode]   = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())

  useEffect(() => { loadDecks() }, [])

  async function loadDecks() {
    setLoading(true)
    const { data } = await sb.from('folders')
      .select('*')
      .eq('user_id', user.id)
      .in('type', ['builder_deck', 'deck'])
      .order('updated_at', { ascending: false })
    const nonGroupDecks = (data || []).filter(f => {
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
    if (communityLoaded) return
    setCommunityLoading(true)
    try {
      const { data } = await sb.from('folders')
        .select('id,name,description,user_id,updated_at')
        .eq('type', 'builder_deck')
        .ilike('description', '%"is_public":true%')
        .order('updated_at', { ascending: false })
        .limit(100)
      setCommunityDecks(data || [])
      setCommunityLoaded(true)
    } catch {
      setCommunityDecks([])
    } finally {
      setCommunityLoading(false)
    }
  }

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

  return (
    <div className={styles.page}>
      <SectionHeader
        title={pageTab === 'my' ? 'My Decks' : 'Deck Browser'}
        subtitle={pageTab === 'my' ? 'Build and manage your MTG decks' : 'Browse and copy public decks from the community'}
        action={pageTab === 'my' ? <Button onClick={() => setShowNew(true)}>+ New Deck</Button> : null}
      />

      {/* Page-level tab bar */}
      <div className={styles.pageTabBar}>
        <button
          className={`${styles.pageTab}${pageTab === 'my' ? ' ' + styles.pageTabActive : ''}`}
          onClick={() => setPageTab('my')}
        >My Decks</button>
        <button
          className={`${styles.pageTab}${pageTab === 'community' ? ' ' + styles.pageTabActive : ''}`}
          onClick={() => { setPageTab('community'); loadCommunityDecks() }}
        >Deck Browser</button>
      </div>

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
              const meta   = parseDeckMeta(deck.description)
              const fmt    = FORMATS.find(f => f.id === (meta.format || 'commander'))
              const colors = meta.commanderColorIdentity || []
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

      {/* ── Community / Deck Browser tab ── */}
      {pageTab === 'community' && <>
        <div className={styles.filterBar}>
          <input
            className={styles.filterInput}
            value={communitySearch}
            onChange={e => setCommunitySearch(e.target.value)}
            placeholder="Search community decks…"
          />
          <div className={styles.filterGroup}>
            {[['all','All'],['commander','Commander'],['standard','Standard'],['modern','Modern'],['pioneer','Pioneer'],['legacy','Legacy']].map(([v, label]) => (
              <button key={v}
                className={`${styles.filterPill}${communityFormat === v ? ' ' + styles.filterPillActive : ''}`}
                onClick={() => setCommunityFormat(v)}>
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
          <div className={styles.grid}>
            {filteredCommunity.map(deck => {
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
                  navigate={navigate}
                />
              )
            })}
          </div>
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
