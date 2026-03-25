import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { sb } from '../lib/supabase'
import { enrichCards, getInstantCache, getPrice, formatPrice, getScryfallKey } from '../lib/scryfall'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { EmptyState, SectionHeader, Modal } from '../components/UI'
import { FilterBar, BulkActionBar, applyFilterSort, EMPTY_FILTERS } from '../components/CardComponents'
import { useLongPress } from '../hooks/useLongPress'
import AddCardModal from '../components/AddCardModal'
import ImportModal from '../components/ImportModal'
import ExportModal from '../components/ExportModal'
import styles from './Folders.module.css'
import listStyles from './Lists.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────
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
function parseBgUrl(description) {
  try { return JSON.parse(description || '{}').bg_url || null } catch { return null }
}

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

// ── Sort dropdown ─────────────────────────────────────────────────────────────
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

// ── Art picker ────────────────────────────────────────────────────────────────
function CardArtPicker({ onSelect, onClose }) {
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  const search = async () => {
    if (!query.trim()) return
    setLoading(true)
    try {
      const r = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=art&order=name`)
      const data = await r.json()
      setResults((data.data || []).filter(c => c.image_uris?.art_crop).slice(0, 20))
    } catch { setResults([]) }
    setLoading(false)
  }
  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 14, fontSize: '1rem' }}>
        Choose Card Art Background
      </h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="Search card name…"
          style={{ flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)',
            borderRadius: 4, padding: '8px 12px', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }} />
        <button onClick={search} disabled={loading}
          style={{ background: 'rgba(201,168,76,0.12)', border: '1px solid rgba(201,168,76,0.35)',
            borderRadius: 4, color: 'var(--gold)', padding: '8px 14px', cursor: 'pointer', fontSize: '0.85rem' }}>
          {loading ? '…' : 'Search'}
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px,1fr))', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
        {results.map(c => (
          <img key={c.id} src={c.image_uris.art_crop} alt={c.name} title={c.name}
            onClick={() => onSelect(c.image_uris.art_crop)}
            style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: 4,
              cursor: 'pointer', border: '2px solid transparent', transition: 'border-color 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--gold)'}
            onMouseLeave={e => e.currentTarget.style.borderColor = 'transparent'} />
        ))}
      </div>
    </Modal>
  )
}

// ── WishlistItem ──────────────────────────────────────────────────────────────
function WishlistItem({ item, sfCard, priceSource, onDelete, selectMode, selected, onToggleSelect }) {
  const price = getPrice(sfCard, item.foil, { price_source: priceSource })
  const img = sfCard?.image_uris?.small

  return (
    <div
      className={`${listStyles.item}${selectMode ? ` ${listStyles.itemSelectMode}` : ''}${selected ? ` ${listStyles.itemSelected}` : ''}`}
      onClick={selectMode ? onToggleSelect : undefined}
    >
      {selectMode && (
        <div className={`${listStyles.itemCheckbox}${selected ? ` ${listStyles.itemCheckboxChecked}` : ''}`}>
          {selected && '✓'}
        </div>
      )}
      {img && <img className={listStyles.itemImg} src={img} alt={item.name} loading="lazy" />}
      <div className={listStyles.itemBody}>
        <div className={listStyles.itemName}>
          {item.name}
          {item.foil && <span style={{ color: '#c8a0ff', fontSize: '0.65rem', marginLeft: 4 }}>✦ Foil</span>}
        </div>
        <div className={listStyles.itemMeta}>
          <span className={listStyles.itemSet}>{(item.set_code || '').toUpperCase()} #{item.collector_number}</span>
          <span className={listStyles.itemPrice} style={{ color: price != null ? 'var(--green)' : 'var(--text-faint)' }}>
            {price != null ? formatPrice(price, priceSource) : '—'}
          </span>
        </div>
        {item.qty > 1 && <div className={listStyles.itemQty}>×{item.qty}</div>}
      </div>
      {!selectMode && <button className={listStyles.itemDelete} onClick={() => onDelete(item.id)}>✕</button>}
    </div>
  )
}

// ── Wishlist grid view ────────────────────────────────────────────────────────
function WishlistGrid({ items, sfMap, priceSource, selectMode, selectedItems, onToggleSelect, onDelete }) {
  return (
    <div className={listStyles.gridView}>
      {items.map(item => {
        const sf       = sfMap[`${item.set_code}-${item.collector_number}`]
        const price    = getPrice(sf, item.foil, { price_source: priceSource })
        const img      = sf?.image_uris?.normal || sf?.image_uris?.small || sf?.card_faces?.[0]?.image_uris?.normal
        const selected = selectedItems.has(item.id)
        return (
          <div
            key={item.id}
            className={`${listStyles.gridItem}${selectMode ? ` ${listStyles.gridItemSelectMode}` : ''}${selected ? ` ${listStyles.gridItemSelected}` : ''}`}
            onClick={selectMode ? () => onToggleSelect(item.id) : undefined}
          >
            {selectMode && (
              <div className={`${listStyles.gridCheckbox}${selected ? ` ${listStyles.gridCheckboxChecked}` : ''}`} />
            )}
            {item.qty > 1 && <div className={listStyles.gridQty}>×{item.qty}</div>}
            {img
              ? <img src={img} className={listStyles.gridImg} alt={item.name} loading="lazy" />
              : <div className={listStyles.gridImgPlaceholder}>{item.name}</div>
            }
            <div className={listStyles.gridFooter}>
              <span className={listStyles.gridName}>
                {item.name}
                {item.foil && <span className={listStyles.gridFoilBadge}>✦</span>}
              </span>
              <span className={listStyles.gridPrice} style={{ color: price != null ? 'var(--green)' : 'var(--text-faint)' }}>
                {price != null ? formatPrice(price, priceSource) : '—'}
              </span>
            </div>
            {!selectMode && (
              <button className={listStyles.gridDelete} onClick={e => { e.stopPropagation(); onDelete(item.id) }}>✕</button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── ListBrowser ───────────────────────────────────────────────────────────────
function ListBrowser({ folder, onBack }) {
  const { price_source, default_sort } = useSettings()
  const { user } = useAuth()
  const [items, setItems]       = useState([])
  const [sfMap, setSfMap]       = useState({})
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [sort, setSort]         = useState(default_sort || 'name')
  const [filters, setFilters]   = useState({ ...EMPTY_FILTERS })
  const [selectMode, setSelectMode]       = useState(false)
  const [selectedItems, setSelectedItems] = useState(new Set())
  const [showAddCard, setShowAddCard]     = useState(false)
  const [showExport, setShowExport]       = useState(false)
  const [view, setView]                   = useState('list')   // 'list' | 'grid'

  const reload = useCallback(async () => {
    setLoading(true)
    const { data } = await sb.from('list_items').select('*').eq('folder_id', folder.id).order('name')
    if (data) {
      setItems(data)
      const map = await enrichCards(data, null)
      if (map) setSfMap({ ...map })
    }
    setLoading(false)
  }, [folder.id])

  useEffect(() => { reload() }, [reload])

  const filtered = useMemo(
    () => applyFilterSort(items, sfMap, search, sort, filters),
    [items, sfMap, search, sort, filters]
  )

  const { totalValue, totalQty } = useMemo(() => {
    let v = 0, q = 0
    for (const item of items) {
      const sf = sfMap[`${item.set_code}-${item.collector_number}`]
      const p  = getPrice(sf, item.foil, { price_source }) ?? (parseFloat(item.purchase_price) || null)
      if (p != null) v += p * item.qty
      q += item.qty
    }
    return { totalValue: v, totalQty: q }
  }, [items, sfMap, price_source])

  const toggleSelectMode = () => { setSelectMode(v => !v); setSelectedItems(new Set()) }
  const onToggleSelect = useCallback(id => setSelectedItems(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
  }), [])

  const handleDelete = async (id) => {
    await sb.from('list_items').delete().eq('id', id)
    setItems(prev => prev.filter(i => i.id !== id))
  }

  const handleBulkDelete = async () => {
    const ids = [...selectedItems]
    await sb.from('list_items').delete().in('id', ids)
    setItems(prev => prev.filter(i => !selectedItems.has(i.id)))
    setSelectedItems(new Set()); setSelectMode(false)
  }

  if (loading) return <EmptyState>Loading…</EmptyState>

  return (
    <div>
      {/* ── Wishlist header ── */}
      <div className={styles.binderHeader}>
        <button className={styles.backBtn} onClick={onBack}>← Back to Wishlists</button>
        <div className={styles.binderTitleRow}>
          <h2 className={styles.binderTitle}>{folder.name}</h2>
          <div className={styles.binderMeta}>
            <span>{totalQty} wants</span>
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
          {filtered.length < items.length
            ? `${filtered.length} of ${items.length} cards`
            : `${items.length} cards`} · {totalQty} total
        </span>
        <div className={styles.viewToggle}>
          <button className={`${styles.viewBtn} ${view === 'list' ? styles.viewActive : ''}`}
            onClick={() => setView('list')}>≡ List</button>
          <button className={`${styles.viewBtn} ${view === 'grid' ? styles.viewActive : ''}`}
            onClick={() => setView('grid')}>⊞ Grid</button>
        </div>
      </div>

      {selectMode && selectedItems.size > 0 && (
        <BulkActionBar
          selected={selectedItems}
          total={filtered.length}
          onSelectAll={() => setSelectedItems(new Set(filtered.map(i => i.id)))}
          onDeselectAll={() => setSelectedItems(new Set())}
          onDelete={handleBulkDelete}
          folders={[]}
        />
      )}

      {filtered.length === 0 && <EmptyState>No cards match.</EmptyState>}

      {view === 'list' && filtered.length > 0 && (
        <div className={listStyles.list}>
          {filtered.map(item => (
            <WishlistItem
              key={item.id}
              item={item}
              sfCard={sfMap[`${item.set_code}-${item.collector_number}`]}
              priceSource={price_source}
              selectMode={selectMode}
              selected={selectedItems.has(item.id)}
              onToggleSelect={() => onToggleSelect(item.id)}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {view === 'grid' && filtered.length > 0 && (
        <WishlistGrid
          items={filtered}
          sfMap={sfMap}
          priceSource={price_source}
          selectMode={selectMode}
          selectedItems={selectedItems}
          onToggleSelect={onToggleSelect}
          onDelete={handleDelete}
        />
      )}

      {showAddCard && user && (
        <AddCardModal
          userId={user.id}
          folderMode
          defaultFolderType="list"
          defaultFolderId={folder.id}
          onClose={() => setShowAddCard(false)}
          onSaved={async () => { setShowAddCard(false); await reload() }}
        />
      )}
      {showExport && (
        <ExportModal
          cards={items}
          sfMap={sfMap}
          title={folder.name}
          folderType="list"
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  )
}

// ── FolderCard ────────────────────────────────────────────────────────────────
function FolderCard({ folder, meta, priceSource, onClick, onDelete, onRename,
  selectMode, selected, onToggleSelect, onEnterSelectMode, onMoveToGroup, onEditBg, onClearBg }) {
  const value  = meta?.value
  const qty    = meta?.totalQty ?? 0
  const bgUrl  = useMemo(() => parseBgUrl(folder.description), [folder.description])
  const [cogOpen, setCogOpen]     = useState(false)
  const [renaming, setRenaming]   = useState(false)
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
                onClick={e => { e.stopPropagation(); setCogOpen(false); onEditBg?.() }}>
                Set background art
              </button>
              {bgUrl && (
                <button className={styles.cogMenuItem}
                  onClick={e => { e.stopPropagation(); setCogOpen(false); onClearBg?.() }}>
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
          <input ref={renameRef} className={styles.renameInput} value={renameVal}
            onChange={e => setRenameVal(e.target.value)} onKeyDown={handleRenameKey} />
          <div className={styles.renameBtns}>
            <button className={styles.renameConfirm} onClick={e => { e.stopPropagation(); confirmRename() }}>✓</button>
            <button className={styles.renameCancel} onClick={e => { e.stopPropagation(); setRenaming(false) }}>✕</button>
          </div>
        </div>
      ) : (
        <div className={styles.folderName}>{folder.name}</div>
      )}
      <div className={styles.folderMeta}>
        <span>{qty} want{qty !== 1 ? 's' : ''}</span>
        <span style={{ color: value != null ? 'var(--green)' : 'var(--text-faint)' }}>
          {value != null ? formatPrice(value, priceSource) : '—'}
        </span>
      </div>
    </div>
  )
}

// ── GroupSection ──────────────────────────────────────────────────────────────
function GroupSection({ group, folders, folderMeta, priceSource, selectMode, selectedIds,
  onToggleSelect, onEnterSelectMode, onOpenFolder, onDeleteGroup, onRenameGroup,
  onDeleteFolder, onEditBg, onClearBg, onMoveToGroup, onMoveUp, onMoveDown, isFirst, isLast }) {
  const [collapsed, setCollapsed] = useState(false)
  const [cogOpen, setCogOpen]     = useState(false)
  const [renaming, setRenaming]   = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const cogRef    = useRef(null)
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
          <input ref={renameRef} className={styles.groupRenameInput} value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { onRenameGroup(group, renameVal.trim()); setRenaming(false) }
              if (e.key === 'Escape') setRenaming(false)
            }}
            onClick={e => e.stopPropagation()} />
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

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ListsPage() {
  const { user } = useAuth()
  const { price_source, list_sort, save: saveSettings } = useSettings()
  const [folders, setFolders]           = useState([])
  const [folderMeta, setFolderMeta]     = useState({})
  const [sort, setSort]                 = useState(list_sort || 'name')
  const [loading, setLoading]           = useState(true)
  const [activeFolder, setActiveFolder] = useState(null)
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

  const handleSortChange = (val) => {
    setSort(val)
    saveSettings({ list_sort: val })
  }

  const handleExportAll = useCallback(async () => {
    setExportAllLoading(true)
    setShowExportAll(true)
    try {
      const folderIds = folders.map(f => f.id)
      if (!folderIds.length) { setExportAllLoading(false); return }
      let allItems = [], from = 0
      while (true) {
        const { data: page } = await sb
          .from('list_items')
          .select('*')
          .in('folder_id', folderIds)
          .range(from, from + 999)
        if (page?.length) allItems = [...allItems, ...page]
        if (!page || page.length < 1000) break
        from += 1000
      }
      const sfMap = await getInstantCache() || {}
      const cards = allItems.map(item => {
        const folder = folders.find(f => f.id === item.folder_id)
        return { ...item, _folder_qty: item.qty, _folderName: folder?.name || '', _folderType: 'list' }
      })
      setExportAllCards(cards)
      setExportAllSfMap(sfMap)
    } finally {
      setExportAllLoading(false)
    }
  }, [folders])

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
      .eq('user_id', user.id).eq('type', 'list').order('name')

    if (!foldersData?.length) { setFolders([]); setFolderMeta({}); setLoading(false); return }
    setFolders(foldersData)

    const ids = foldersData.map(f => f.id)
    let allItems = [], from = 0
    while (true) {
      const { data: page } = await sb
        .from('list_items')
        .select('folder_id, qty, set_code, collector_number, foil')
        .in('folder_id', ids)
        .range(from, from + 999)
      if (page?.length) allItems = [...allItems, ...page]
      if (!page || page.length < 1000) break
      from += 1000
    }

    const sfMap = await getInstantCache() || {}
    const meta  = {}
    for (const f of foldersData) meta[f.id] = { count: 0, totalQty: 0, value: 0 }
    for (const row of allItems) {
      const m = meta[row.folder_id]
      if (!m) continue
      m.count++
      m.totalQty += row.qty || 1
      const sf = sfMap[`${row.set_code}-${row.collector_number}`]
      const p  = getPrice(sf, row.foil, { price_source })
      if (p != null) m.value += p * (row.qty || 1)
    }
    setFolderMeta(meta)
    setLoading(false)
  }, [user.id, price_source])

  useEffect(() => { loadFolders() }, [loadFolders])

  const deleteFolder = async (folder) => {
    await sb.from('list_items').delete().eq('folder_id', folder.id)
    await sb.from('folders').delete().eq('id', folder.id)
    setFolders(prev => prev.filter(f => f.id !== folder.id))
  }

  const renameFolder = useCallback(async (folder, newName) => {
    await sb.from('folders').update({ name: newName }).eq('id', folder.id)
    setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, name: newName } : f))
  }, [])

  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()) }

  const handleBulkDelete = async () => {
    const selected = folders.filter(f => selectedIds.has(f.id) && !isGroupFolder(f))
    await Promise.all(selected.map(async f => {
      await sb.from('list_items').delete().eq('folder_id', f.id)
      await sb.from('folders').delete().eq('id', f.id)
    }))
    setFolders(prev => prev.filter(f => !selectedIds.has(f.id)))
    setSelectedIds(new Set())
    setSelectMode(false)
  }

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

  // ── Group management ──────────────────────────────────────────────────────
  const createGroup = async (name) => {
    if (!name.trim()) return
    const desc = JSON.stringify({ isGroup: true, sort_order: groups.length })
    const { data } = await sb.from('folders').insert({
      user_id: user.id, type: 'list', name: name.trim(), description: desc,
    }).select().single()
    if (data) setFolders(prev => [...prev, data])
  }

  const createFolder = async () => {
    if (!newFolderName.trim()) return
    const { data } = await sb.from('folders').insert({
      user_id: user.id, type: 'list', name: newFolderName.trim(),
    }).select().single()
    if (data) { setFolders(prev => [...prev, data]); setShowNewFolder(false); setNewFolderName('') }
  }

  const deleteGroup = async (group) => {
    const members = folders.filter(f => parseFolderDesc(f.description).groupId === group.id)
    for (const f of members) {
      const newDesc = setFolderDescKey(f.description, 'groupId', null)
      await sb.from('folders').update({ description: newDesc }).eq('id', f.id)
      setFolders(prev => prev.map(x => x.id === f.id ? { ...x, description: newDesc } : x))
    }
    await sb.from('folders').delete().eq('id', group.id)
    setFolders(prev => prev.filter(f => f.id !== group.id))
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

  if (activeFolder) return (
    <ListBrowser folder={activeFolder} onBack={() => { setActiveFolder(null); loadFolders() }} />
  )

  if (loading) return <EmptyState>Loading wishlists…</EmptyState>

  return (
    <div className={styles.page}>
      <SectionHeader
        title="Wishlists"
        action={
          <div className={styles.headerActions}>
            {selectMode ? (
              <>
                <button className={styles.cancelSelectBtn} onClick={exitSelectMode}>Cancel</button>
                {groups.length > 0 && (
                  <button className={styles.newGroupBtn} disabled={selectedIds.size === 0}
                    onClick={() => setShowBulkMoveGroup(true)}>
                    📁 Group ({selectedIds.size})
                  </button>
                )}
                <button className={styles.bulkDeleteBtn} disabled={selectedIds.size === 0}
                  onClick={handleBulkDelete}>
                  <TrashIcon size={12} /> Delete ({selectedIds.size})
                </button>
              </>
            ) : (
              <>
                <button className={styles.newGroupBtn} onClick={() => setShowNewGroup(true)}>
                  + New Group
                </button>
                <button className={styles.importBtn} onClick={() => setShowImport(true)}>↑ Import</button>
                <button className={styles.importBtn} onClick={handleExportAll}>↓ Export</button>
                <button className={styles.newFolderBtn} onClick={() => setShowNewFolder(true)}>+ New Wishlist</button>
                <button className={styles.selectModeBtn} onClick={() => setSelectMode(true)}>Select</button>
                <SortDropdown value={sort} onChange={handleSortChange} options={SORT_OPTIONS} />
              </>
            )}
          </div>
        }
      />

      {folders.length === 0 && (
        <EmptyState>No wishlists yet. Lists from your Manabox CSV will appear here after import.</EmptyState>
      )}

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
          onDeleteFolder={deleteFolder}
          onEditBg={setBgTarget}
          onClearBg={(f) => saveFolderBg(f, null)}
          onMoveToGroup={setMoveToGroupTarget}
          onMoveUp={() => reorderGroup(group, 'up')}
          onMoveDown={() => reorderGroup(group, 'down')}
          isFirst={idx === 0}
          isLast={idx === groups.length - 1}
        />
      ))}

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
                onDelete={() => deleteFolder(folder)}
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

      {showNewGroup && (
        <Modal onClose={() => setShowNewGroup(false)}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 14, fontSize: '1rem' }}>
            New Group
          </h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <input autoFocus className={styles.newGroupInput} value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newGroupName.trim()) {
                  createGroup(newGroupName); setShowNewGroup(false); setNewGroupName('')
                }
                if (e.key === 'Escape') setShowNewGroup(false)
              }}
              placeholder="Group name…" />
            <button className={styles.newGroupSaveBtn} disabled={!newGroupName.trim()}
              onClick={() => { createGroup(newGroupName); setShowNewGroup(false); setNewGroupName('') }}>
              Create
            </button>
          </div>
        </Modal>
      )}

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

      {showBulkMoveGroup && (
        <Modal onClose={() => setShowBulkMoveGroup(false)}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 14, fontSize: '1rem' }}>
            Move {selectedIds.size} list{selectedIds.size !== 1 ? 's' : ''} to Group
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

      {bgTarget && (
        <CardArtPicker
          onSelect={async (url) => { await saveFolderBg(bgTarget, url); setBgTarget(null) }}
          onClose={() => setBgTarget(null)}
        />
      )}

      {/* New Wishlist modal */}
      {showNewFolder && (
        <Modal onClose={() => { setShowNewFolder(false); setNewFolderName('') }}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 14, fontSize: '1rem' }}>
            New Wishlist
          </h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              className={styles.newGroupInput}
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') setShowNewFolder(false) }}
              placeholder="Wishlist name…"
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
          folderType="list"
          folders={regularFolders}
          onClose={() => setShowImport(false)}
          onSaved={() => { setShowImport(false); loadFolders() }}
        />
      )}

      {/* Export all wishlists modal */}
      {showExportAll && (
        <ExportModal
          cards={exportAllCards}
          sfMap={exportAllSfMap}
          title="All Wishlists"
          folderType="list"
          loading={exportAllLoading}
          onClose={() => { setShowExportAll(false); setExportAllCards([]) }}
        />
      )}
    </div>
  )
}
