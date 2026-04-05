import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { Button, Modal, EmptyState, SectionHeader, ResponsiveMenu } from '../components/UI'
import { parseDeckMeta, FORMATS } from '../lib/deckBuilderApi'
import styles from './Builder.module.css'
import uiStyles from '../components/UI.module.css'
import { useLongPress } from '../hooks/useLongPress'

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
  // If a collection deck has a linked builder deck, open the builder version instead
  const effectiveId = (deck.type === 'deck' && meta.linked_builder_id) ? meta.linked_builder_id : deck.id
  return (
    <div
      className={`${styles.card}${isSelected ? ' ' + styles.cardSelected : ''}`}
      onClick={() => {
        if (lpFired.current) {
          lpFired.current = false
          return
        }
        selectMode ? onToggleSelect(deck.id) : navigate(`/builder/${effectiveId}`)
      }}
      {...lpRest}>
      <DeckArtBackground meta={meta} deckType={deck.type} />
      <div className={styles.cardContent}>
        {selectMode && (
          <div className={`${styles.deckCheckbox}${isSelected ? ' ' + styles.deckCheckboxChecked : ''}`}>
            {isSelected && '✓'}
          </div>
        )}
        <div className={styles.cardTop}>
          <div className={styles.cardBadges}>
            {deck.type === 'deck'
              ? <span className={styles.collectionBadge}>Collection</span>
              : <span className={styles.formatBadge}>{fmt?.label || 'Builder'}</span>
            }
            {deck.type === 'deck' && fmt && (
              <span className={styles.formatBadge}>{fmt.label}</span>
            )}
            {(meta.linked_deck_id || meta.linked_builder_id) && (
              <span className={styles.formatBadge} style={{ opacity: 0.7 }}>↔</span>
            )}
          </div>
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
        </div>
        {!selectMode && (
          <div className={styles.cardActions}>
            <Link to={`/builder/${effectiveId}`} className={styles.editLink}>Edit Deck →</Link>
            <button className={styles.deleteBtn} onClick={e => { e.stopPropagation(); onDelete(deck.id) }}>✕</button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function BuilderPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [decks, setDecks]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [showNew, setShowNew]     = useState(false)
  const [newName, setNewName]     = useState('')
  const [newFormat, setNewFormat] = useState('commander')
  const [creating, setCreating]   = useState(false)

  // Styled confirm dialog
  const [confirmState, setConfirmState] = useState(null) // { message, resolve }
  const confirmAsync = (message) => new Promise(resolve => setConfirmState({ message, resolve }))
  const handleConfirm = (result) => { confirmState?.resolve(result); setConfirmState(null) }

  // Filter/sort state
  const [search, setSearch]       = useState('')
  const [typeFilter, setTypeFilter] = useState('all') // 'all' | 'builder' | 'collection'
  const [sortBy, setSortBy]       = useState('updated') // 'updated' | 'name' | 'format'

  // Selection state
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
    // Exclude group folders and collection decks hidden from builder
    const nonGroupDecks = (data || []).filter(f => {
      try {
        const m = JSON.parse(f.description || '{}')
        return !m.isGroup && !m.hideFromBuilder
      } catch { return true }
    })
    setDecks(nonGroupDecks)
    setLoading(false)
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
      if (sortBy === 'name')    return a.name.localeCompare(b.name)
      if (sortBy === 'format') {
        const ma = parseDeckMeta(a.description)
        const mb = parseDeckMeta(b.description)
        return (ma.format || '').localeCompare(mb.format || '')
      }
      return 0 // updated_at already sorted from DB
    })

  return (
    <div className={styles.page}>
      <SectionHeader
        title="My Decks"
        subtitle="Build and manage your MTG decks"
        action={<Button onClick={() => setShowNew(true)}>+ New Deck</Button>}
      />

      {/* Filter bar */}
      <div className={styles.filterBar}>
        <input
          className={styles.filterInput}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search decks…"
        />
        <div className={styles.filterGroup}>
          {[['all','All'],['builder','Builder'],['collection','Collection']].map(([v, label]) => (
            <button key={v}
              className={`${styles.filterPill}${typeFilter === v ? ' '+styles.filterPillActive : ''}`}
              onClick={() => setTypeFilter(v)}>
              {label}
            </button>
          ))}
        </div>
        <div className={styles.filterGroup}>
          <span className={styles.sortLabel}>Sort:</span>
          {[['updated','Recent'],['name','Name'],['format','Format']].map(([v, label]) => (
            <button key={v}
              className={`${styles.sortPill}${sortBy === v ? ' '+styles.sortPillActive : ''}`}
              onClick={() => setSortBy(v)}>
              {label}
            </button>
          ))}
        </div>
        <div className={styles.filterGroup}>
          <button
            className={`${styles.sortPill}${selectMode ? ' '+styles.sortPillActive : ''}`}
            onClick={toggleSelectMode}>
            {selectMode ? '✕ Cancel' : 'Select'}
          </button>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectMode && selectedIds.size > 0 && (
        <div className={styles.bulkBar}>
          <span>{selectedIds.size} selected</span>
          <button onClick={() => setSelectedIds(new Set(filtered.map(d => d.id)))}>Select all</button>
          <button onClick={() => setSelectedIds(new Set())}>Deselect</button>
          <button className={styles.bulkDelete} onClick={bulkDelete}>Delete {selectedIds.size}</button>
          <button onClick={toggleSelectMode}>✕ Cancel</button>
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
            const meta = parseDeckMeta(deck.description)
            const fmt  = FORMATS.find(f => f.id === (meta.format || 'commander'))
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
                      <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{f.id === newFormat ? '✓' : ''}</span>
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
