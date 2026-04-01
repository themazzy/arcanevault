import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { enrichCards, getInstantCache, getScryfallKey, getPrice, getPriceSource, formatPrice, sfGet } from '../lib/scryfall'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { CardGrid, CardDetail, FilterBar, BulkActionBar, applyFilterSort, EMPTY_FILTERS } from '../components/CardComponents'
import { EmptyState, SectionHeader, Button, Modal, ResponsiveHeaderActions } from '../components/UI'
import AddCardModal from '../components/AddCardModal'
import ImportModal from '../components/ImportModal'
import ExportModal from '../components/ExportModal'
import DeckBrowser from './DeckBrowser'
import styles from './Folders.module.css'
import { useLongPress } from '../hooks/useLongPress'
import { pruneUnplacedCards } from '../lib/collectionOwnership'

// ── SVG Icons ─────────────────────────────────────────────────────────────────
function TrashIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2,4 14,4" />
      <path d="M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4" />
      <rect x="3" y="4" width="10" height="9" rx="1" />
      <line x1="6" y1="7" x2="6" y2="11" />
      <line x1="10" y1="7" x2="10" y2="11" />
    </svg>
  )
}


function PencilIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z" />
    </svg>
  )
}

// ── Sort dropdown (custom, dark-themed — native <option> can't be styled) ─────
function SortDropdown({ value, onChange, options }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const current = options.find(([v]) => v === value)

  return (
    <div ref={ref} className={styles.sortDropdown}>
      <button className={styles.sortDropdownBtn} onClick={() => setOpen(o => !o)}>
        <span>{current?.[1] || value}</span>
        <svg className={`${styles.sortArrow} ${open ? styles.sortArrowOpen : ''}`}
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="2,3 5,7 8,3" />
        </svg>
      </button>
      {open && (
        <div className={styles.sortDropdownMenu}>
          {options.map(([v, l]) => (
            <button key={v}
              className={`${styles.sortDropdownItem} ${v === value ? styles.sortDropdownItemActive : ''}`}
              onClick={() => { onChange(v); setOpen(false) }}>
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Art picker: search Scryfall for art_crop ──────────────────────────────────
function CardArtPicker({ onSelect, onClose }) {
  const [query, setQuery]   = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const search = async () => {
    if (!query.trim()) return
    setLoading(true)
    try {
      const data = await sfGet(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=art&order=name`)
      setResults((data?.data || []).filter(c => c.image_uris?.art_crop).slice(0, 20))
    } catch { setResults([]) }
    setLoading(false)
  }

  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 14, fontSize: '1rem' }}>
        Choose Card Art Background
      </h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input ref={inputRef}
          value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="Search card name…"
          style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', color: 'var(--text)', fontSize: '0.88rem', outline: 'none' }}
        />
        <Button onClick={search} disabled={loading}>{loading ? '…' : 'Search'}</Button>
      </div>
      {results.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: 8, maxHeight: 400, overflowY: 'auto' }}>
          {results.map(card => (
            <button key={card.id}
              onClick={() => onSelect(card.image_uris.art_crop)}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, padding: 0, cursor: 'pointer', overflow: 'hidden', transition: 'border-color 0.15s' }}
              title={card.name}>
              <img src={card.image_uris.art_crop} alt={card.name}
                style={{ width: '100%', display: 'block', aspectRatio: '4/3', objectFit: 'cover' }} />
              <div style={{ padding: '4px 6px', fontSize: '0.68rem', color: 'var(--text-dim)', background: 'rgba(0,0,0,0.6)', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {card.name}
              </div>
            </button>
          ))}
        </div>
      )}
      {!loading && results.length === 0 && query && (
        <p style={{ color: 'var(--text-faint)', fontSize: '0.85rem' }}>No results. Try a different name.</p>
      )}
    </Modal>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const SORT_OPTIONS = [
  ['name',       'Name'],
  ['value_desc', 'Value (high → low)'],
  ['value_asc',  'Value (low → high)'],
  ['count_desc', 'Most cards'],
  ['count_asc',  'Fewest cards'],
]

function sortFolders(folders, meta, sort) {
  return [...folders].sort((a, b) => {
    const ma = meta[a.id] || {}, mb = meta[b.id] || {}
    if (sort === 'value_desc') return (mb.value || 0) - (ma.value || 0)
    if (sort === 'value_asc')  return (ma.value || 0) - (mb.value || 0)
    if (sort === 'count_desc') return (mb.totalQty || 0) - (ma.totalQty || 0)
    if (sort === 'count_asc')  return (ma.totalQty || 0) - (mb.totalQty || 0)
    return a.name.localeCompare(b.name)
  })
}

function parseBgUrl(description) {
  try { return JSON.parse(description || '{}').bg_url || null } catch { return null }
}

function parseFolderDesc(description) {
  try { return JSON.parse(description || '{}') } catch { return {} }
}

function setFolderDescKey(description, key, value) {
  let desc = {}
  try { desc = JSON.parse(description || '{}') } catch {}
  if (value == null) delete desc[key]
  else desc[key] = value
  return Object.keys(desc).length > 0 ? JSON.stringify(desc) : null
}

function isGroupFolder(f) {
  return parseFolderDesc(f.description).isGroup === true
}

// ── GroupSection ──────────────────────────────────────────────────────────────
function GroupSection({ group, folders, folderMeta, priceSource, selectMode, selectedIds,
  onToggleSelect, onEnterSelectMode, onOpenFolder, onDeleteGroup, onRenameGroup,
  onDeleteFolder, onEditBg, onClearBg, onMoveToGroup, onMoveUp, onMoveDown, isFirst, isLast }) {
  const [collapsed, setCollapsed] = useState(false)
  const [cogOpen, setCogOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const cogRef = useRef(null)
  const renameRef = useRef(null)

  useEffect(() => {
    if (!cogOpen) return
    const close = (e) => { if (cogRef.current && !cogRef.current.contains(e.target)) setCogOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [cogOpen])

  useEffect(() => { if (renaming) renameRef.current?.focus() }, [renaming])

  return (
    <div className={styles.groupSection}>
      <div className={styles.groupHeader}>
        <button className={styles.groupCollapseBtn} onClick={() => setCollapsed(v => !v)}>
          {collapsed ? '▸' : '▾'}
        </button>
        {renaming ? (
          <input
            ref={renameRef}
            className={styles.groupRenameInput}
            value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { onRenameGroup(group, renameVal.trim()); setRenaming(false) }
              if (e.key === 'Escape') setRenaming(false)
            }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className={styles.groupName}>{group.name}</span>
        )}
        <span className={styles.groupCount}>{folders.length}</span>
        <div ref={cogRef} className={styles.groupCogWrap}>
          <button className={styles.groupCogBtn} onClick={e => { e.stopPropagation(); setCogOpen(v => !v) }}>⚙</button>
          {cogOpen && (
            <div className={styles.groupCogMenu}>
              {!isFirst && (
                <button className={styles.groupCogItem} onClick={() => { onMoveUp(); setCogOpen(false) }}>
                  ↑ Move Up
                </button>
              )}
              {!isLast && (
                <button className={styles.groupCogItem} onClick={() => { onMoveDown(); setCogOpen(false) }}>
                  ↓ Move Down
                </button>
              )}
              <button className={styles.groupCogItem} onClick={() => { setRenameVal(group.name); setRenaming(true); setCogOpen(false) }}>
                Rename
              </button>
              <button className={`${styles.groupCogItem} ${styles.groupCogItemDanger}`} onClick={() => { onDeleteGroup(group); setCogOpen(false) }}>
                Delete Group
              </button>
            </div>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className={styles.groupGrid}>
          {folders.map(folder => (
            <FolderCard
              key={folder.id}
              folder={folder}
              meta={folderMeta[folder.id]}
              priceSource={priceSource}
              onClick={() => onOpenFolder(folder)}
              onDelete={() => onDeleteFolder(folder)}
              onEditBg={() => onEditBg(folder)}
              onClearBg={() => onClearBg(folder)}
              onRename={(name) => onRenameGroup(folder, name)}
              selectMode={selectMode}
              selected={selectedIds.has(folder.id)}
              onToggleSelect={() => onToggleSelect(folder.id)}
              onEnterSelectMode={onEnterSelectMode}
              onMoveToGroup={() => onMoveToGroup(folder)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── FolderCard ────────────────────────────────────────────────────────────────
function FolderCard({ folder, meta, priceSource, onClick, onDelete, onEditBg, onClearBg,
  onRename, selectMode, selected, onToggleSelect, onEnterSelectMode, onMoveToGroup }) {
  const value  = meta?.value
  const qty    = meta?.totalQty ?? meta?.count ?? 0
  const bgUrl  = useMemo(() => parseBgUrl(folder.description), [folder.description])
  const [cogOpen, setCogOpen]   = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const cogRef    = useRef(null)
  const renameRef = useRef(null)

  const longPress = useLongPress(() => { if (!selectMode) onEnterSelectMode?.() }, { delay: 500 })

  useEffect(() => {
    if (!cogOpen) return
    const close = (e) => { if (cogRef.current && !cogRef.current.contains(e.target)) setCogOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [cogOpen])

  useEffect(() => { if (renaming) renameRef.current?.focus() }, [renaming])

  const startRename = () => { setRenameVal(folder.name); setRenaming(true); setCogOpen(false) }

  const confirmRename = () => {
    const trimmed = renameVal.trim()
    if (trimmed && trimmed !== folder.name) onRename?.(trimmed)
    setRenaming(false)
  }

  const handleRenameKey = (e) => {
    if (e.key === 'Enter') confirmRename()
    if (e.key === 'Escape') setRenaming(false)
  }

  const handleCardClick = () => {
    if (renaming) return
    if (selectMode) { onToggleSelect(); return }
    onClick()
  }

  const longPressProps = renaming ? {} : longPress

  return (
    <div
      className={`${styles.folderCard}${selectMode ? ` ${styles.folderCardSelectMode}` : ''}${selectMode && selected ? ` ${styles.folderCardSelected}` : ''}`}
      style={{
        ...(bgUrl ? {
          backgroundImage: `linear-gradient(rgba(10,10,18,0.55) 0%, rgba(10,10,18,0.80) 100%), url(${bgUrl})`,
          backgroundSize: 'cover', backgroundPosition: 'center top',
        } : {}),
        ...(cogOpen ? { zIndex: 200, position: 'relative' } : {}),
      }}
      onClick={handleCardClick}
      {...longPressProps}>

      {selectMode ? (
        <div
          className={`${styles.selectCheckbox}${selected ? ` ${styles.selectCheckboxChecked}` : ''}`}
          onClick={e => { e.stopPropagation(); onToggleSelect() }}
        />
      ) : (
        <div ref={cogRef} className={styles.cogMenuWrap}>
          <button className={styles.cogBtn} onClick={e => { e.stopPropagation(); setCogOpen(o => !o) }} title="Options">
            ⚙
          </button>
          {cogOpen && (
            <div className={styles.cogMenu}>
              <button className={styles.cogMenuItem}
                onClick={e => { e.stopPropagation(); startRename() }}>
                <span className={styles.cogMenuItemIcon}><PencilIcon size={12} /> Rename</span>
              </button>
              <button className={styles.cogMenuItem}
                onClick={e => { e.stopPropagation(); setCogOpen(false); onEditBg() }}>
                Set background art
              </button>
              {bgUrl && (
                <button className={styles.cogMenuItem}
                  onClick={e => { e.stopPropagation(); setCogOpen(false); onClearBg() }}>
                  Clear background
                </button>
              )}
              <button className={styles.cogMenuItem}
                onClick={e => { e.stopPropagation(); setCogOpen(false); onMoveToGroup?.() }}>
                📁 Move to Group
              </button>
              <button className={`${styles.cogMenuItem} ${styles.cogMenuItemDanger}`}
                onClick={e => { e.stopPropagation(); setCogOpen(false); onDelete() }}>
                <span className={styles.cogMenuItemIcon}><TrashIcon size={12} /> Delete</span>
              </button>
            </div>
          )}
        </div>
      )}

      {renaming ? (
        <div className={styles.renameWrap} onClick={e => e.stopPropagation()}>
          <input
            ref={renameRef}
            className={styles.renameInput}
            value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={handleRenameKey}
          />
          <div className={styles.renameBtns}>
            <button className={styles.renameConfirm} onClick={e => { e.stopPropagation(); confirmRename() }}>✓</button>
            <button className={styles.renameCancel} onClick={e => { e.stopPropagation(); setRenaming(false) }}>✕</button>
          </div>
        </div>
      ) : (
        <div className={styles.folderName}>{folder.name}</div>
      )}
      <div className={styles.folderMeta}>
        <span>{qty} card{qty !== 1 ? 's' : ''}</span>
        <span style={{ color: value != null ? 'var(--green)' : 'var(--text-faint)' }}>
          {value != null ? formatPrice(value, priceSource) : '—'}
        </span>
      </div>
    </div>
  )
}

// ── Binder list view ─────────────────────────────────────────────────────────
function BinderListView({ cards, sfMap, priceSource }) {
  return (
    <div className={styles.listTable}>
      <div className={styles.listHeader}>
        <span>Card</span>
        <span>Set</span>
        <span className={styles.lhCenter}>Qty</span>
        <span className={styles.lhRight}>Price</span>
        <span className={styles.lhRight}>Total</span>
      </div>
      {cards.map(card => {
        const sf    = sfMap[getScryfallKey(card)]
        const qty   = card._folder_qty || card.qty || 1
        const price = getPrice(sf, card.foil, { price_source: priceSource })
        const img   = sf?.image_uris?.small || sf?.card_faces?.[0]?.image_uris?.small
        return (
          <div key={card.id} className={styles.listRow}>
            <div className={styles.lrCard}>
              {img
                ? <img src={img} className={styles.lrThumb} alt="" loading="lazy" />
                : <div className={styles.lrThumbEmpty} />
              }
              <div className={styles.lrNameWrap}>
                <span className={styles.lrName}>
                  {sf?.name || `${card.set_code?.toUpperCase()}-${card.collector_number}`}
                </span>
                {card.foil && <span className={styles.lrFoil}>FOIL</span>}
              </div>
            </div>
            <span className={styles.lrSet}>{sf?.set_name || (card.set_code || '').toUpperCase()}</span>
            <span className={styles.lrQty}>×{qty}</span>
            <span className={styles.lrPrice} style={{ color: price != null ? 'var(--green, #5dba70)' : 'var(--text-faint)' }}>
              {price != null ? formatPrice(price, priceSource) : '—'}
            </span>
            <span className={styles.lrTotal}>
              {price != null ? formatPrice(price * qty, priceSource) : '—'}
            </span>
            {card._folderName && <span className={styles.lrFolder}>{card._folderName}</span>}
          </div>
        )
      })}
    </div>
  )
}

// ── FolderBrowser ─────────────────────────────────────────────────────────────
function FolderBrowser({ folder = null, folders = [], title = '', noun = 'Binder', onBack }) {
  const { price_source, default_sort } = useSettings()
  const { user } = useAuth()
  const [cards, setCards]             = useState([])
  const [sfMap, setSfMap]             = useState({})
  const [loading, setLoading]         = useState(true)
  const [selected, setSelected]       = useState(null)
  const [search, setSearch]           = useState('')
  const [sort, setSort]               = useState(default_sort || 'name')
  const [filters, setFilters]         = useState({ ...EMPTY_FILTERS })
  const [selectMode, setSelectMode]   = useState(false)
  const [selectedCards, setSelectedCards] = useState(new Set())
  const [splitState, setSplitState]   = useState(new Map())
  const [showAddCard, setShowAddCard] = useState(false)
  const [showExport, setShowExport]   = useState(false)
  const [view, setView]               = useState('grid')   // 'grid' | 'list'
  const isAllView = !folder
  const browserTitle = title || folder?.name || `All ${noun} Cards`
  const folderIds = useMemo(() => folders.map(f => f.id), [folders])
  const moveFolders = useMemo(() => isAllView ? folders : folders.filter(f => f.id !== folder.id && !isGroupFolder(f)), [folders, isAllView, folder?.id])
  const getCardKey = useCallback((card) => card?._displayKey || card?.id, [])

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      let cardList = []
      if (isAllView) {
        const folderNameById = Object.fromEntries(folders.map(f => [f.id, f.name]))
        let allRows = [], from = 0
        while (folderIds.length) {
          const { data } = await sb
            .from('folder_cards')
            .select('folder_id, qty, cards(*)')
            .in('folder_id', folderIds)
            .range(from, from + 999)
          if (data?.length) allRows = [...allRows, ...data]
          if (!data || data.length < 1000) break
          from += 1000
        }
        cardList = allRows
          .filter(row => row.cards)
          .map(row => ({
            ...row.cards,
            _folder_qty: row.qty,
            _folderName: folderNameById[row.folder_id] || '',
            _sourceFolderId: row.folder_id,
            _displayKey: `${row.folder_id}:${row.cards.id}`,
          }))
      } else {
        const { data } = await sb
          .from('folder_cards')
          .select('qty, cards(*)')
          .eq('folder_id', folder.id)
        if (data) cardList = data.filter(row => row.cards).map(row => ({ ...row.cards, _folder_qty: row.qty }))
      }
      setCards(cardList)
      if (cardList.length) {
        const map = await enrichCards(cardList, null)
        if (map) setSfMap({ ...map })
      } else {
        setSfMap({})
      }
      setLoading(false)
    }
    load()
  }, [folder?.id, folderIds, folders, isAllView])

  const filtered = useMemo(
    () => applyFilterSort(cards, sfMap, search, sort, filters),
    [cards, sfMap, search, sort, filters]
  )

  const { totalValue, totalQty } = useMemo(() => {
    let v = 0, q = 0
    for (const c of cards) {
      const sf  = sfMap[getScryfallKey(c)]
      const p   = getPrice(sf, c.foil, { price_source }) ?? (parseFloat(c.purchase_price) || null)
      const qty = c._folder_qty || c.qty
      if (p != null) v += p * qty
      q += qty
    }
    return { totalValue: v, totalQty: q }
  }, [cards, sfMap, price_source])

  const selectedCard = !isAllView && selected ? cards.find(c => c.id === selected) : null
  const selectedSf   = selectedCard ? sfMap[getScryfallKey(selectedCard)] : null
  const handleCardSave = useCallback((updatedCard) => {
    setCards(prev => prev.map(c => c.id === updatedCard.id ? { ...c, ...updatedCard } : c))
  }, [])

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

  const selectedQty = useMemo(() =>
    [...selectedCards].reduce((sum, id) => {
      const c = cards.find(c => getCardKey(c) === id)
      const totalQty = c?._folder_qty || c?.qty || 1
      return sum + (splitState.get(id) ?? 1)
    }, 0)
  , [selectedCards, cards, splitState, getCardKey])

  const handleBulkDelete = async () => {
    const toDelete = [], toUpdate = []
    for (const id of selectedCards) {
      const card = cards.find(c => getCardKey(c) === id)
      if (!card) continue
      const totalQty = card?._folder_qty || card?.qty || 1
      const selQty = splitState.get(id) ?? 1
      const remaining = totalQty - selQty
      remaining > 0
        ? toUpdate.push({ id: card.id, folderId: card._sourceFolderId || folder.id, remaining })
        : toDelete.push({ id: card.id, folderId: card._sourceFolderId || folder.id })
    }
    for (const row of toDelete) {
      await sb.from('folder_cards').delete().eq('folder_id', row.folderId).eq('card_id', row.id)
    }
    for (const { id, folderId, remaining } of toUpdate) {
      await sb.from('folder_cards').update({ qty: remaining }).eq('folder_id', folderId).eq('card_id', id)
    }
    if (toDelete.length) await pruneUnplacedCards([...new Set(toDelete.map(row => row.id))])
    setCards(prev => prev.map(c => {
      if (!selectedCards.has(getCardKey(c))) return c
      const totalQty = c._folder_qty || c.qty || 1
      const selQty = splitState.get(getCardKey(c)) ?? 1
      const remaining = totalQty - selQty
      return remaining > 0 ? { ...c, _folder_qty: remaining } : null
    }).filter(Boolean))
    clearSelect()
  }

  const handleMoveToFolder = async (targetFolder) => {
    const toDelete = [], toUpdate = []
    const insertRows = []
    for (const id of selectedCards) {
      const card = cards.find(c => getCardKey(c) === id)
      if (!card) continue
      const sourceFolderId = card._sourceFolderId || folder.id
      if (sourceFolderId === targetFolder.id) continue
      const totalQty = card?._folder_qty || card?.qty || 1
      const selQty = splitState.get(id) ?? 1
      const remaining = totalQty - selQty
      insertRows.push({ folder_id: targetFolder.id, card_id: card.id, qty: selQty })
      remaining > 0
        ? toUpdate.push({ id: card.id, folderId: sourceFolderId, remaining })
        : toDelete.push({ id: card.id, folderId: sourceFolderId })
    }
    if (insertRows.length) await sb.from('folder_cards').upsert(insertRows, { onConflict: 'folder_id,card_id', ignoreDuplicates: true })
    for (const row of toDelete) {
      await sb.from('folder_cards').delete().eq('folder_id', row.folderId).eq('card_id', row.id)
    }
    for (const { id, folderId, remaining } of toUpdate) {
      await sb.from('folder_cards').update({ qty: remaining }).eq('folder_id', folderId).eq('card_id', id)
    }
    setCards(prev => prev.map(c => {
      if (!selectedCards.has(getCardKey(c))) return c
      const totalQty = c._folder_qty || c.qty || 1
      const selQty = splitState.get(getCardKey(c)) ?? 1
      const remaining = totalQty - selQty
      return remaining > 0 ? { ...c, _folder_qty: remaining } : null
    }).filter(Boolean))
    clearSelect()
  }

  if (loading) return <EmptyState>Loading…</EmptyState>

  return (
    <div>
      {/* ── Binder header ── */}
      <div className={styles.binderHeader}>
        <button className={styles.backBtn} onClick={onBack}>← Back to {noun}s</button>
        <div className={styles.binderTitleRow}>
          <h2 className={styles.binderTitle}>{browserTitle}</h2>
          <div className={styles.binderMeta}>
            <span>{totalQty} cards</span>
            <span className={styles.binderValue}>{formatPrice(totalValue, price_source)}</span>
            <button className={styles.addCardsBtn} onClick={() => setShowExport(true)}>↓ Export</button>
            <button className={styles.addCardsBtn} onClick={() => setShowAddCard(true)}>+ Add Cards</button>
          </div>
        </div>
      </div>

      <FilterBar
        search={search} setSearch={setSearch}
        sort={sort} setSort={setSort}
        filters={filters} setFilters={setFilters}
        selectMode={selectMode}
        onToggleSelectMode={toggleSelectMode}
      />

      {/* ── Control bar ── */}
      <div className={styles.binderControlBar}>
        <span className={styles.binderCount}>
          {filtered.length < cards.length
            ? `${filtered.length} of ${cards.length} unique`
            : `${cards.length} unique`} · {totalQty} total
        </span>
        <div className={styles.viewToggle}>
          <button className={`${styles.viewBtn} ${view === 'grid' ? styles.viewActive : ''}`}
            onClick={() => setView('grid')}>⊞ Grid</button>
          <button className={`${styles.viewBtn} ${view === 'list' ? styles.viewActive : ''}`}
            onClick={() => setView('list')}>≡ List</button>
        </div>
      </div>

      {selectMode && selectedCards.size > 0 && (
        <BulkActionBar
          selected={selectedCards}
          selectedQty={selectedQty}
          total={filtered.length}
          onSelectAll={() => setSelectedCards(new Set(filtered.map(c => getCardKey(c))))}
          onDeselectAll={() => { setSelectedCards(new Set()); setSplitState(new Map()) }}
          onDelete={handleBulkDelete}
          onMoveToFolder={handleMoveToFolder}
          folders={moveFolders}
          onCreateFolder={async (type, name) => {
            const { data: newFolder } = await sb.from('folders')
              .insert({ name, type, user_id: user.id }).select().single()
            if (newFolder) await handleMoveToFolder(newFolder)
          }}
        />
      )}

      {filtered.length === 0 && <EmptyState>No cards match your search.</EmptyState>}

      {view === 'grid' && filtered.length > 0 && (
        <CardGrid
          cards={filtered} sfMap={sfMap}
          onSelect={isAllView ? () => {} : c => setSelected(c.id)}
          selectMode={selectMode}
          selected={selectedCards}
          onToggleSelect={onToggleSelect}
          onEnterSelectMode={() => setSelectMode(true)}
          splitState={splitState}
          onAdjustQty={onAdjustQty}
        />
      )}

      {view === 'list' && filtered.length > 0 && (
        <BinderListView cards={filtered} sfMap={sfMap} priceSource={price_source} />
      )}

      {selectedCard && (
        <CardDetail
          card={selectedCard}
          sfCard={selectedSf}
          priceSource={price_source}
          currentFolderId={folder.id}
          onSave={handleCardSave}
          onClose={() => setSelected(null)}
        />
      )}
      {showAddCard && user && (
        <AddCardModal
          userId={user.id}
          folderMode
          defaultFolderType={folder?.type || folders[0]?.type || 'binder'}
          defaultFolderId={folder?.id || null}
          onClose={() => setShowAddCard(false)}
          onSaved={async () => {
            setShowAddCard(false)
            window.location.reload()
          }}
        />
      )}
      {showExport && (
        <ExportModal
          cards={cards}
          sfMap={sfMap}
          title={browserTitle}
          folderType={folder?.type || folders[0]?.type || 'binder'}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  )
}

// ── ShareModal ────────────────────────────────────────────────────────────────
function ShareModal({ folder, onClose }) {
  const [token, setToken]     = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      const { data } = await sb.from('shared_folders').select('public_token').eq('folder_id', folder.id).maybeSingle()
      if (data) { setToken(data.public_token); setLoading(false); return }
      const { data: created } = await sb.from('shared_folders').insert({ folder_id: folder.id }).select().single()
      setToken(created?.public_token)
      setLoading(false)
    }
    load()
  }, [folder.id])

  const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
  const url = token ? `${window.location.origin}${base}/share/${token}` : ''

  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 16 }}>
        Share "{folder.name}"
      </h2>
      {loading ? <p style={{ color: 'var(--text-dim)' }}>Generating link…</p> : (
        <>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.88rem', marginBottom: 12 }}>
            Anyone with this link can view this {folder.type} (read-only):
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input readOnly value={url} style={{
              flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
              borderRadius: 3, padding: '9px 12px', color: 'var(--text)', fontSize: '0.85rem', outline: 'none'
            }} />
            <Button onClick={() => navigator.clipboard.writeText(url)}>Copy</Button>
          </div>
        </>
      )}
    </Modal>
  )
}

// ── DeleteFolderModal — single folder (with cards) ────────────────────────────
function DeleteFolderModal({ folder, onDone, onCancel }) {
  const [mode, setMode]         = useState(null)   // 'binder' | 'deck' | 'delete'
  const [targetId, setTargetId] = useState('')
  const [allFolders, setAllFolders] = useState([])
  const [createName, setCreateName] = useState('')
  const [busy, setBusy]         = useState(false)
  const [loaded, setLoaded]     = useState(false)

  useEffect(() => {
    sb.from('folders').select('id, name, type').in('type', ['binder', 'deck']).order('name')
      .then(({ data }) => {
        setAllFolders((data || []).filter(f => f.id !== folder.id))
        setLoaded(true)
      })
  }, [folder.id])

  const targets = mode === 'binder'
    ? allFolders.filter(f => f.type === 'binder')
    : mode === 'deck'
      ? allFolders.filter(f => f.type === 'deck')
      : []

  const canConfirm = mode === 'delete' || ((mode === 'binder' || mode === 'deck') && targetId)

  const handleCreateTarget = async () => {
    if (!(mode === 'binder' || mode === 'deck')) return
    const name = createName.trim()
    if (!name || busy) return
    setBusy(true)
    const { data, error } = await sb.from('folders')
      .insert({ user_id: folder.user_id, name, type: mode })
      .select('id, name, type')
      .single()
    setBusy(false)
    if (error || !data) return
    setAllFolders(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
    setTargetId(data.id)
    setCreateName('')
  }

  const handleConfirm = async () => {
    setBusy(true)
    if (mode === 'binder' || mode === 'deck') {
      const { data: fc } = await sb.from('folder_cards').select('card_id, qty').eq('folder_id', folder.id)
      for (const { card_id, qty } of fc || []) {
        const { data: existing } = await sb.from('folder_cards')
          .select('id, qty').eq('folder_id', targetId).eq('card_id', card_id).maybeSingle()
        if (existing) {
          await sb.from('folder_cards').update({ qty: existing.qty + qty }).eq('id', existing.id)
        } else {
          await sb.from('folder_cards').insert({ folder_id: targetId, card_id, qty })
        }
      }
    } else if (mode === 'delete') {
      const { data: fc } = await sb.from('folder_cards').select('card_id').eq('folder_id', folder.id)
      const ids = (fc || []).map(r => r.card_id)
      await sb.from('folders').delete().eq('id', folder.id)
      if (ids.length) await pruneUnplacedCards(ids)
      onDone()
      return
    }
    await sb.from('folders').delete().eq('id', folder.id)
    onDone()
  }

  const opts = [
    { key: 'binder', icon: '📁', label: 'Transfer to a binder',      desc: 'Move all cards into an existing binder' },
    { key: 'deck',   icon: '🃏', label: 'Transfer to another deck',   desc: 'Move all cards into another deck' },
    { key: 'delete', icon: null, label: 'Delete the cards',           desc: 'Remove these cards from your collection permanently' },
  ]

  return (
    <Modal onClose={onCancel}>
      <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 4 }}>
        Delete "{folder.name}"
      </h2>
      <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', marginBottom: 16 }}>
        Cards must stay in a binder or deck. Choose what to do with them:
      </p>
      {!loaded ? (
        <p style={{ color: 'var(--text-faint)', fontSize: '0.85rem' }}>Loading…</p>
      ) : (
        <>
          <div className={styles.deleteModeOpts}>
            {opts.map(o => (
              <button key={o.key}
                className={`${styles.deleteModeBtn} ${mode === o.key ? styles.deleteModeBtnActive : ''}`}
                onClick={() => { setMode(o.key); setTargetId(''); setCreateName('') }}>
                <span className={styles.deleteModeIcon}>
                  {o.key === 'delete' ? <TrashIcon size={16} /> : o.icon}
                </span>
                <span>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{o.label}</div>
                  <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>{o.desc}</div>
                </span>
              </button>
            ))}
          </div>

          {(mode === 'binder' || mode === 'deck') && (
            <>
              <select className={styles.deleteTargetSelect}
                value={targetId} onChange={e => setTargetId(e.target.value)}>
                <option value="">— Select {mode} —</option>
                {targets.length === 0
                  ? <option disabled>No {mode}s available</option>
                  : targets.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input
                  className={styles.newGroupInput}
                  value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleCreateTarget()
                  }}
                  placeholder={`Create new ${mode}…`}
                />
                <button
                  className={styles.newGroupSaveBtn}
                  disabled={busy || !createName.trim()}
                  onClick={handleCreateTarget}>
                  Create
                </button>
              </div>
            </>
          )}

          <button className={styles.deleteConfirmBtn}
            disabled={!canConfirm || busy}
            onClick={handleConfirm}>
            {busy ? 'Working…' : 'Confirm Delete'}
          </button>
        </>
      )}
    </Modal>
  )
}

// ── BulkDeleteModal — multiple folders ────────────────────────────────────────
function BulkDeleteModal({ nonEmpty, empty, onDone, onCancel }) {
  const [mode, setMode]         = useState(null)
  const [targetId, setTargetId] = useState('')
  const [allFolders, setAllFolders] = useState([])
  const [createName, setCreateName] = useState('')
  const [busy, setBusy]         = useState(false)
  const [loaded, setLoaded]     = useState(false)

  const allSelectedIds = useMemo(() => new Set([...nonEmpty, ...empty].map(f => f.id)), [nonEmpty, empty])

  useEffect(() => {
    sb.from('folders').select('id, name, type').in('type', ['binder', 'deck']).order('name')
      .then(({ data }) => {
        setAllFolders((data || []).filter(f => !allSelectedIds.has(f.id)))
        setLoaded(true)
      })
  }, [])

  const targets = mode === 'binder'
    ? allFolders.filter(f => f.type === 'binder')
    : mode === 'deck'
      ? allFolders.filter(f => f.type === 'deck')
      : []

  const canConfirm = mode === 'delete' || ((mode === 'binder' || mode === 'deck') && targetId)

  const handleCreateTarget = async () => {
    if (!(mode === 'binder' || mode === 'deck')) return
    const ownerId = nonEmpty[0]?.user_id || empty[0]?.user_id
    const name = createName.trim()
    if (!ownerId || !name || busy) return
    setBusy(true)
    const { data, error } = await sb.from('folders')
      .insert({ user_id: ownerId, name, type: mode })
      .select('id, name, type')
      .single()
    setBusy(false)
    if (error || !data) return
    setAllFolders(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
    setTargetId(data.id)
    setCreateName('')
  }

  const handleConfirm = async () => {
    setBusy(true)
    for (const folder of nonEmpty) {
      if (mode === 'binder' || mode === 'deck') {
        const { data: fc } = await sb.from('folder_cards').select('card_id, qty').eq('folder_id', folder.id)
        for (const { card_id, qty } of fc || []) {
          const { data: existing } = await sb.from('folder_cards')
            .select('id, qty').eq('folder_id', targetId).eq('card_id', card_id).maybeSingle()
          if (existing) {
            await sb.from('folder_cards').update({ qty: existing.qty + qty }).eq('id', existing.id)
          } else {
            await sb.from('folder_cards').insert({ folder_id: targetId, card_id, qty })
          }
        }
      } else if (mode === 'delete') {
        const { data: fc } = await sb.from('folder_cards').select('card_id').eq('folder_id', folder.id)
        folder._deleteCardIds = (fc || []).map(r => r.card_id)
      }
    }
    for (const folder of [...nonEmpty, ...empty]) {
      await sb.from('folders').delete().eq('id', folder.id)
    }
    if (mode === 'delete') {
      const ids = nonEmpty.flatMap(folder => folder._deleteCardIds || [])
      if (ids.length) await pruneUnplacedCards(ids)
    }
    onDone([...allSelectedIds])
  }

  const opts = [
    { key: 'binder', icon: '📁', label: 'Transfer to a binder',    desc: 'Move all cards into an existing binder' },
    { key: 'deck',   icon: '🃏', label: 'Transfer to another deck', desc: 'Move all cards into another deck' },
    { key: 'delete', icon: null, label: 'Delete the cards',         desc: 'Remove these cards from your collection permanently' },
  ]

  return (
    <Modal onClose={onCancel}>
      <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 4 }}>
        Delete {nonEmpty.length + empty.length} folders
      </h2>
      {empty.length > 0 && (
        <p style={{ color: 'var(--text-dim)', fontSize: '0.82rem', marginBottom: 6 }}>
          {empty.length} empty folder{empty.length !== 1 ? 's' : ''} will be deleted automatically.
        </p>
      )}
      <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', marginBottom: 16 }}>
        {nonEmpty.length} folder{nonEmpty.length !== 1 ? 's' : ''} contain{nonEmpty.length === 1 ? 's' : ''} cards.
        Choose what to do with them:
      </p>
      {!loaded ? (
        <p style={{ color: 'var(--text-faint)', fontSize: '0.85rem' }}>Loading…</p>
      ) : (
        <>
          <div className={styles.deleteModeOpts}>
            {opts.map(o => (
              <button key={o.key}
                className={`${styles.deleteModeBtn} ${mode === o.key ? styles.deleteModeBtnActive : ''}`}
                onClick={() => { setMode(o.key); setTargetId(''); setCreateName('') }}>
                <span className={styles.deleteModeIcon}>
                  {o.key === 'delete' ? <TrashIcon size={16} /> : o.icon}
                </span>
                <span>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{o.label}</div>
                  <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>{o.desc}</div>
                </span>
              </button>
            ))}
          </div>

          {(mode === 'binder' || mode === 'deck') && (
            <>
              <select className={styles.deleteTargetSelect}
                value={targetId} onChange={e => setTargetId(e.target.value)}>
                <option value="">— Select {mode} —</option>
                {targets.length === 0
                  ? <option disabled>No {mode}s available</option>
                  : targets.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input
                  className={styles.newGroupInput}
                  value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleCreateTarget()
                  }}
                  placeholder={`Create new ${mode}…`}
                />
                <button
                  className={styles.newGroupSaveBtn}
                  disabled={busy || !createName.trim()}
                  onClick={handleCreateTarget}>
                  Create
                </button>
              </div>
            </>
          )}

          <button className={styles.deleteConfirmBtn}
            disabled={!canConfirm || busy}
            onClick={handleConfirm}>
            {busy ? 'Working…' : `Delete ${nonEmpty.length + empty.length} folders`}
          </button>
        </>
      )}
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function FoldersPage({ type }) {
  const { user }                        = useAuth()
  const { price_source, default_sort,
          binder_sort, deck_sort, list_sort, save: saveSettings } = useSettings()
  const sortSettingKey = type === 'deck' ? 'deck_sort' : type === 'list' ? 'list_sort' : 'binder_sort'
  const savedSort = type === 'deck' ? deck_sort : type === 'list' ? list_sort : binder_sort
  const [searchParams, setSearchParams] = useSearchParams()
  const [folders, setFolders]           = useState([])
  const [folderMeta, setFolderMeta]     = useState({})
  const [sort, setSort]                 = useState(savedSort || default_sort || 'name')
  const [loading, setLoading]           = useState(true)
  const [activeFolder, setActiveFolder] = useState(null)
  const [showAllCards, setShowAllCards] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [bulkDeleteData, setBulkDeleteData] = useState(null) // { nonEmpty, empty }
  const [shareFolder, setShareFolder]   = useState(null)
  const [bgTarget, setBgTarget]         = useState(null)
  const [selectMode, setSelectMode]     = useState(false)
  const [selectedIds, setSelectedIds]   = useState(new Set())
  const [moveToGroupTarget, setMoveToGroupTarget] = useState(null)
  const [showBulkMoveGroup, setShowBulkMoveGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [showExportAll, setShowExportAll]     = useState(false)
  const [exportAllCards, setExportAllCards]   = useState([])
  const [exportAllSfMap, setExportAllSfMap]   = useState({})
  const [exportAllLoading, setExportAllLoading] = useState(false)

  const noun = type === 'deck' ? 'Deck' : type === 'list' ? 'List' : 'Binder'

  const handleSortChange = (val) => {
    setSort(val)
    saveSettings({ [sortSettingKey]: val })
  }

  // ── Export all folders of this type ──────────────────────────────────────────
  const handleExportAll = useCallback(async () => {
    setExportAllLoading(true)
    setShowExportAll(true)
    try {
      const folderIds = folders.map(f => f.id)
      if (!folderIds.length) { setExportAllLoading(false); return }
      let allFc = [], from = 0
      while (true) {
        const { data: page } = await sb
          .from('folder_cards')
          .select('folder_id, qty, cards(name, set_code, collector_number, foil, condition, language, purchase_price)')
          .in('folder_id', folderIds)
          .range(from, from + 999)
        if (page?.length) allFc = [...allFc, ...page]
        if (!page || page.length < 1000) break
        from += 1000
      }
      const sfMap = await getInstantCache() || {}
      const cards = allFc.map(fc => {
        const folder = folders.find(f => f.id === fc.folder_id)
        return { ...fc.cards, _folder_qty: fc.qty, _folderName: folder?.name || '', _folderType: folder?.type || type }
      })
      setExportAllCards(cards)
      setExportAllSfMap(sfMap)
    } finally {
      setExportAllLoading(false)
    }
  }, [folders, type])

  // ── Supabase bg helper (merges bg_url into existing description JSON) ────────
  const saveFolderBg = useCallback(async (folder, url) => {
    let desc = {}
    try { desc = JSON.parse(folder.description || '{}') } catch {}
    if (!url) delete desc.bg_url
    else desc.bg_url = url
    const descStr = Object.keys(desc).length > 0 ? JSON.stringify(desc) : null
    await sb.from('folders').update({ description: descStr }).eq('id', folder.id)
    setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, description: descStr } : f))
  }, [])

  const loadFolders = useCallback(async () => {
    setLoading(true)
    const { data: foldersData } = await sb
      .from('folders').select('*')
      .eq('user_id', user.id).eq('type', type).order('name')

    if (!foldersData?.length) { setFolders([]); setFolderMeta({}); setLoading(false); return }
    setFolders(foldersData)

    const ids = foldersData.map(f => f.id)
    let allFc = [], fcFrom = 0
    while (true) {
      const { data: page } = await sb
        .from('folder_cards')
        .select('folder_id, qty, cards(set_code, collector_number, foil)')
        .in('folder_id', ids)
        .range(fcFrom, fcFrom + 999)
      if (page?.length) allFc = [...allFc, ...page]
      if (!page || page.length < 1000) break
      fcFrom += 1000
    }

    const sfMap = await getInstantCache() || {}
    const meta  = {}
    for (const f of foldersData) meta[f.id] = { count: 0, totalQty: 0, value: 0 }

    for (const row of allFc) {
      const m = meta[row.folder_id]
      if (!m) continue
      m.count++
      m.totalQty += row.qty || 1
      const card = row.cards
      if (card) {
        const sf = sfMap[`${card.set_code}-${card.collector_number}`]
        const p  = getPrice(sf, card.foil, { price_source }) ?? (parseFloat(card.purchase_price) || null)
        if (p != null) m.value += p * (row.qty || 1)
      }
    }

    setFolderMeta(meta)
    setLoading(false)
  }, [user.id, type, price_source])

  useEffect(() => { loadFolders() }, [loadFolders])

  // Auto-open folder from URL param
  useEffect(() => {
    const folderId = searchParams.get('folder')
    if (!folderId || !folders.length) return
    const target = folders.find(f => f.id === folderId)
    if (target) {
      setActiveFolder(target)
      setSearchParams({}, { replace: true })
    }
  }, [folders, searchParams])

  const deleteFolder = async (id) => {
    await sb.from('folders').delete().eq('id', id)
    setFolders(prev => prev.filter(f => f.id !== id))
  }

  const renameFolder = useCallback(async (folder, newName) => {
    await sb.from('folders').update({ name: newName }).eq('id', folder.id)
    setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, name: newName } : f))
  }, [])

  // Smart single-folder delete: empty → direct; has cards → show modal
  const handleDeleteClick = (folder) => {
    const isEmpty = (folderMeta[folder.id]?.totalQty || 0) === 0
    if (isEmpty) {
      deleteFolder(folder.id)
    } else {
      setDeleteTarget(folder)
    }
  }

  // Bulk delete handler
  const handleBulkDelete = () => {
    const selected = folders.filter(f => selectedIds.has(f.id))
    const nonEmpty = selected.filter(f => (folderMeta[f.id]?.totalQty || 0) > 0)
    const empty    = selected.filter(f => (folderMeta[f.id]?.totalQty || 0) === 0)
    if (nonEmpty.length > 0) {
      setBulkDeleteData({ nonEmpty, empty })
    } else {
      // All empty — delete directly
      Promise.all(selected.map(f => sb.from('folders').delete().eq('id', f.id))).then(() => {
        setFolders(prev => prev.filter(f => !selectedIds.has(f.id)))
        setSelectedIds(new Set())
        setSelectMode(false)
      })
    }
  }

  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()) }

  const bulkMoveToGroup = async (groupId) => {
    const selected = folders.filter(f => selectedIds.has(f.id) && !isGroupFolder(f))
    for (const folder of selected) {
      const newDesc = setFolderDescKey(folder.description, 'groupId', groupId || null)
      await sb.from('folders').update({ description: newDesc }).eq('id', folder.id)
      setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, description: newDesc } : f))
    }
    setShowBulkMoveGroup(false)
    setSelectedIds(new Set())
    setSelectMode(false)
  }

  // ── Group management ─────────────────────────────────────────────────────────
  const createGroup = async (name) => {
    if (!name.trim()) return
    const desc = JSON.stringify({ isGroup: true, sort_order: groups.length })
    const { data } = await sb.from('folders').insert({
      user_id: user.id, type, name: name.trim(), description: desc,
    }).select().single()
    if (data) setFolders(prev => [...prev, data])
  }

  const createFolder = async () => {
    if (!newFolderName.trim()) return
    const { data } = await sb.from('folders').insert({
      user_id: user.id, type, name: newFolderName.trim(),
    }).select().single()
    if (data) { setFolders(prev => [...prev, data]); setShowNewFolder(false); setNewFolderName('') }
  }

  const reorderGroup = async (group, direction) => {
    const idx = groups.findIndex(g => g.id === group.id)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= groups.length) return
    const other = groups[swapIdx]
    const orderA = parseFolderDesc(group.description).sort_order ?? idx
    const orderB = parseFolderDesc(other.description).sort_order ?? swapIdx
    const newDescA = setFolderDescKey(group.description, 'sort_order', orderB)
    const newDescB = setFolderDescKey(other.description, 'sort_order', orderA)
    await Promise.all([
      sb.from('folders').update({ description: newDescA }).eq('id', group.id),
      sb.from('folders').update({ description: newDescB }).eq('id', other.id),
    ])
    setFolders(prev => prev.map(f => {
      if (f.id === group.id) return { ...f, description: newDescA }
      if (f.id === other.id) return { ...f, description: newDescB }
      return f
    }))
  }

  const deleteGroup = async (group) => {
    // Ungroup all binders in this group (remove their groupId)
    const members = folders.filter(f => parseFolderDesc(f.description).groupId === group.id)
    for (const f of members) {
      const newDesc = setFolderDescKey(f.description, 'groupId', null)
      await sb.from('folders').update({ description: newDesc }).eq('id', f.id)
      setFolders(prev => prev.map(x => x.id === f.id ? { ...x, description: newDesc } : x))
    }
    await sb.from('folders').delete().eq('id', group.id)
    setFolders(prev => prev.filter(f => f.id !== group.id))
  }

  const moveToGroup = async (folder, groupId) => {
    const newDesc = setFolderDescKey(folder.description, 'groupId', groupId || null)
    await sb.from('folders').update({ description: newDesc }).eq('id', folder.id)
    setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, description: newDesc } : f))
    setMoveToGroupTarget(null)
  }

  const sortedFolders = useMemo(
    () => sortFolders(folders, folderMeta, sort),
    [folders, folderMeta, sort]
  )

  const groups = useMemo(() =>
    sortedFolders
      .filter(isGroupFolder)
      .sort((a, b) => {
        const ao = parseFolderDesc(a.description).sort_order ?? 9999
        const bo = parseFolderDesc(b.description).sort_order ?? 9999
        return ao - bo || a.name.localeCompare(b.name)
      }),
    [sortedFolders]
  )
  const regularFolders = useMemo(() => sortedFolders.filter(f => !isGroupFolder(f)), [sortedFolders])
  const foldersByGroup = useMemo(() => {
    const map = {}
    for (const f of regularFolders) {
      const gid = parseFolderDesc(f.description).groupId
      if (gid) {
        if (!map[gid]) map[gid] = []
        map[gid].push(f)
      }
    }
    return map
  }, [regularFolders])
  const ungroupedFolders = useMemo(
    () => regularFolders.filter(f => !parseFolderDesc(f.description).groupId),
    [regularFolders]
  )

  if (activeFolder) {
    if (type === 'deck') return (
      <DeckBrowser folder={activeFolder} onBack={() => { setActiveFolder(null); loadFolders() }} />
    )
    return (
      <FolderBrowser
        folder={activeFolder}
        folders={folders}
        noun={noun}
        onBack={() => { setActiveFolder(null); loadFolders() }}
      />
    )
  }

  if (showAllCards) {
    return (
      <FolderBrowser
        folders={regularFolders}
        title={`All ${noun} Cards`}
        noun={noun}
        onBack={() => { setShowAllCards(false); loadFolders() }}
      />
    )
  }

  if (loading) return <EmptyState>Loading {noun.toLowerCase()}s…</EmptyState>

  return (
    <div className={styles.page}>
      <SectionHeader
        title={`${noun}s`}
        action={
          <ResponsiveHeaderActions
            primary={!selectMode ? (
              <button className={styles.viewAllBtn} onClick={() => setShowAllCards(true)}>
                View All Cards
              </button>
            ) : null}
            menuLabel={`${noun}s actions`}
          >
            <div className={styles.headerActions}>
              {selectMode ? (
                <>
                <button className={styles.cancelSelectBtn} onClick={exitSelectMode}>
                  Cancel
                </button>
                {groups.length > 0 && (
                  <button
                    className={styles.newGroupBtn}
                    disabled={selectedIds.size === 0}
                    onClick={() => setShowBulkMoveGroup(true)}>
                    📁 Group ({selectedIds.size})
                  </button>
                )}
                <button
                  className={styles.bulkDeleteBtn}
                  disabled={selectedIds.size === 0}
                  onClick={handleBulkDelete}>
                  <TrashIcon size={12} />
                  Delete ({selectedIds.size})
                </button>
                </>
              ) : (
                <>
                <button className={styles.newGroupBtn} onClick={() => setShowNewGroup(true)}>
                  + New Group
                </button>
                <button className={styles.importBtn} onClick={() => setShowImport(true)}>↑ Import</button>
                <button className={styles.importBtn} onClick={handleExportAll}>↓ Export</button>
                <button className={styles.newFolderBtn} onClick={() => setShowNewFolder(true)}>+ New {noun}</button>
                <button className={styles.selectModeBtn} onClick={() => setSelectMode(true)}>Select</button>
                <SortDropdown value={sort} onChange={handleSortChange} options={SORT_OPTIONS} />
                </>
              )}
            </div>
          </ResponsiveHeaderActions>
        }
      />

      {folders.length === 0 && (
        <EmptyState>No {noun.toLowerCase()}s yet. Import your collection CSV from the Collection tab to populate them.</EmptyState>
      )}

      {/* Groups with their binders */}
      {groups.map((group, idx) => (
        <GroupSection
          key={group.id}
          group={group}
          folders={foldersByGroup[group.id] || []}
          folderMeta={folderMeta}
          priceSource={price_source}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelected}
          onEnterSelectMode={() => setSelectMode(true)}
          onOpenFolder={setActiveFolder}
          onDeleteGroup={deleteGroup}
          onRenameGroup={renameFolder}
          onDeleteFolder={handleDeleteClick}
          onEditBg={setBgTarget}
          onClearBg={(f) => saveFolderBg(f, null)}
          onMoveToGroup={setMoveToGroupTarget}
          onMoveUp={() => reorderGroup(group, 'up')}
          onMoveDown={() => reorderGroup(group, 'down')}
          isFirst={idx === 0}
          isLast={idx === groups.length - 1}
        />
      ))}

      {/* Ungrouped binders */}
      {ungroupedFolders.length > 0 && (
        <>
          {groups.length > 0 && <div className={styles.ungroupedHeader}>Ungrouped</div>}
          <div className={styles.folderGrid}>
            {ungroupedFolders.map(folder => (
              <FolderCard
                key={folder.id}
                folder={folder}
                meta={folderMeta[folder.id]}
                priceSource={price_source}
                onClick={() => setActiveFolder(folder)}
                onDelete={() => handleDeleteClick(folder)}
                onEditBg={() => setBgTarget(folder)}
                onClearBg={() => saveFolderBg(folder, null)}
                onRename={(name) => renameFolder(folder, name)}
                selectMode={selectMode}
                selected={selectedIds.has(folder.id)}
                onToggleSelect={() => toggleSelected(folder.id)}
                onEnterSelectMode={() => setSelectMode(true)}
                onMoveToGroup={() => setMoveToGroupTarget(folder)}
              />
            ))}
          </div>
        </>
      )}

      {/* New Group modal */}
      {showNewGroup && (
        <Modal onClose={() => setShowNewGroup(false)}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 14, fontSize: '1rem' }}>
            New Group
          </h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              className={styles.newGroupInput}
              value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newGroupName.trim()) {
                  createGroup(newGroupName)
                  setShowNewGroup(false)
                  setNewGroupName('')
                }
                if (e.key === 'Escape') setShowNewGroup(false)
              }}
              placeholder="Group name…"
            />
            <button
              className={styles.newGroupSaveBtn}
              disabled={!newGroupName.trim()}
              onClick={() => { createGroup(newGroupName); setShowNewGroup(false); setNewGroupName('') }}>
              Create
            </button>
          </div>
        </Modal>
      )}

      {/* Move to Group modal */}
      {moveToGroupTarget && (
        <Modal onClose={() => setMoveToGroupTarget(null)}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 14, fontSize: '1rem' }}>
            Move "{moveToGroupTarget.name}" to Group
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {groups.map(g => (
              <button key={g.id} className={styles.moveGroupItem} onClick={() => moveToGroup(moveToGroupTarget, g.id)}>
                📁 {g.name}
              </button>
            ))}
            {groups.length === 0 && (
              <p style={{ color: 'var(--text-faint)', fontSize: '0.85rem' }}>No groups yet. Create one first.</p>
            )}
            {parseFolderDesc(moveToGroupTarget.description).groupId && (
              <button className={styles.moveGroupRemove} onClick={() => moveToGroup(moveToGroupTarget, null)}>
                ✕ Remove from group
              </button>
            )}
          </div>
        </Modal>
      )}

      {/* Bulk Move to Group modal */}
      {showBulkMoveGroup && (
        <Modal onClose={() => setShowBulkMoveGroup(false)}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 14, fontSize: '1rem' }}>
            Move {selectedIds.size} {noun.toLowerCase()}{selectedIds.size !== 1 ? 's' : ''} to Group
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {groups.map(g => (
              <button key={g.id} className={styles.moveGroupItem} onClick={() => bulkMoveToGroup(g.id)}>
                📁 {g.name}
              </button>
            ))}
            <button className={styles.moveGroupRemove} onClick={() => bulkMoveToGroup(null)}>
              ✕ Remove from group
            </button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <DeleteFolderModal
          folder={deleteTarget}
          onDone={() => {
            setFolders(prev => prev.filter(f => f.id !== deleteTarget.id))
            setDeleteTarget(null)
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {bulkDeleteData && (
        <BulkDeleteModal
          nonEmpty={bulkDeleteData.nonEmpty}
          empty={bulkDeleteData.empty}
          onDone={(deletedIds) => {
            setFolders(prev => prev.filter(f => !deletedIds.includes(f.id)))
            setSelectedIds(new Set())
            setSelectMode(false)
            setBulkDeleteData(null)
          }}
          onCancel={() => setBulkDeleteData(null)}
        />
      )}
      {shareFolder && <ShareModal folder={shareFolder} onClose={() => setShareFolder(null)} />}
      {bgTarget && (
        <CardArtPicker
          onSelect={(url) => {
            saveFolderBg(bgTarget, url)
            setBgTarget(null)
          }}
          onClose={() => setBgTarget(null)}
        />
      )}

      {/* New Folder modal */}
      {showNewFolder && (
        <Modal onClose={() => { setShowNewFolder(false); setNewFolderName('') }}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 14, fontSize: '1rem' }}>
            New {noun}
          </h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              className={styles.newGroupInput}
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') setShowNewFolder(false) }}
              placeholder={`${noun} name…`}
            />
            <button className={styles.newGroupSaveBtn} disabled={!newFolderName.trim()} onClick={createFolder}>
              Create
            </button>
          </div>
        </Modal>
      )}

      {/* Import modal */}
      {showImport && user && (
        <ImportModal
          userId={user.id}
          folderType={type}
          folders={regularFolders}
          onClose={() => setShowImport(false)}
          onSaved={(fid) => {
            setShowImport(false)
            // Reload folders to show new counts
            sb.from('folders').select('*').eq('user_id', user.id).eq('type', type).then(({ data }) => {
              if (data) setFolders(data)
            })
          }}
        />
      )}

      {/* Export all modal */}
      {showExportAll && (
        <ExportModal
          cards={exportAllCards}
          sfMap={exportAllSfMap}
          title={`All ${noun}s`}
          folderType={type}
          loading={exportAllLoading}
          onClose={() => { setShowExportAll(false); setExportAllCards([]) }}
        />
      )}
    </div>
  )
}
