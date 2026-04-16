import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { sb } from '../lib/supabase'
import { getPrice, formatPrice, getScryfallKey } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { EmptyState, SectionHeader, Modal, ResponsiveHeaderActions, ResponsiveMenu, Button } from '../components/UI'
import { CardGrid, CardDetail, FilterBar, BulkActionBar, applyFilterSort, EMPTY_FILTERS } from '../components/CardComponents'
import { useLongPress } from '../hooks/useLongPress'
import AddCardModal from '../components/AddCardModal'
import ImportModal from '../components/ImportModal'
import ExportModal from '../components/ExportModal'
import { CardBrowserViewControls, CardBrowserContent } from '../components/CardBrowserViews'
import styles from './Folders.module.css'
import listStyles from './Lists.module.css'
import { BinderIcon, DeleteIcon, EditIcon, ImageIcon, RemoveIcon, SettingsIcon } from '../icons'
import uiStyles from '../components/UI.module.css'

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


// ── Sort dropdown ─────────────────────────────────────────────────────────────
function SortDropdown({ value, onChange, options, compact = false }) {
  const current = options.find(([v]) => v === value)
  return (
    <ResponsiveMenu
      title="Sort Lists"
      align="left"
      wrapClassName={styles.sortDropdown}
      trigger={({ open, toggle }) => (
        <button className={styles.sortDropdownBtn} onClick={toggle}>
          <span>{compact ? 'Sort' : (current?.[1] || value)}</span>
          <span className={styles.sortArrowWrap} aria-hidden="true">
            <svg className={`${styles.sortArrow} ${open ? styles.sortArrowOpen : ''}`}
              width="10" height="10" viewBox="0 0 10 10" fill="none"
              stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="2,3 5,7 8,3" />
            </svg>
          </span>
        </button>
      )}
    >
      {({ close }) => (
        <div className={uiStyles.responsiveMenuList}>
          {options.map(([v, l]) => (
            <button key={v}
              className={`${uiStyles.responsiveMenuAction} ${v === value ? uiStyles.responsiveMenuActionActive : ''}`}
              onClick={() => { onChange(v); close() }}>
              <span>{l}</span>
              <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{v === value ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </ResponsiveMenu>
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
        <Button onClick={search} disabled={loading}>{loading ? '…' : 'Search'}</Button>
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
function WishlistItem({ item, sfCard, priceSource, onDelete, selectMode, selected, onToggleSelect, onEnterSelectMode, folderName = '' }) {
  const price    = getPrice(sfCard, item.foil, { price_source: priceSource })
  const img      = sfCard?.image_uris?.small
  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.()
  }, { delay: 500 })
  const { onMouseLeave: lpLeave, fired: lpFired, ...lpRest } = longPress

  const handleClick = () => {
    if (lpFired.current) {
      lpFired.current = false
      return
    }
    if (selectMode) onToggleSelect?.()
  }

  return (
    <div
      className={`${listStyles.item}${selectMode ? ` ${listStyles.itemSelectMode}` : ''}${selected ? ` ${listStyles.itemSelected}` : ''}`}
      onClick={handleClick}
      onMouseLeave={lpLeave}
      {...lpRest}
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
        {folderName && <div className={listStyles.itemFolder}>{folderName}</div>}
        {item.qty > 1 && <div className={listStyles.itemQty}>×{item.qty}</div>}
      </div>
      {!selectMode && <button className={listStyles.itemDelete} onClick={() => onDelete(item.id)}>✕</button>}
    </div>
  )
}

// ── ListBrowser ───────────────────────────────────────────────────────────────
function ListBrowser({ folder = null, folders = [], title = '', onBack }) {
  const { price_source, default_sort, grid_density } = useSettings()
  const { user } = useAuth()
  const [items, setItems]       = useState([])
  const [sfMap, setSfMap]       = useState({})
  const [allFolders, setAllFolders] = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [sort, setSort]         = useState(default_sort || 'name')
  const [filters, setFilters]   = useState({ ...EMPTY_FILTERS })
  const [selectMode, setSelectMode]       = useState(false)
  const [selectedItems, setSelectedItems] = useState(new Set())
  const [splitState, setSplitState]       = useState(new Map())
  const [showAddCard, setShowAddCard]     = useState(false)
  const [showImport, setShowImport]       = useState(false)
  const [showExport, setShowExport]       = useState(false)
  const [viewMode, setViewMode]           = useState('grid')
  const [groupBy, setGroupBy]             = useState('none')
  const [selectedItemId, setSelectedItemId] = useState(null)
  const [hoverImg, setHoverImg]           = useState(null)
  const [hoverPos, setHoverPos]           = useState({ x: 0, y: 0 })
  const isAllView = !folder
  const browserTitle = title || folder?.name || 'All Wishlist Cards'
  const folderIds = useMemo(() => folders.map(f => f.id), [folders])
  const folderNameById = useMemo(
    () => Object.fromEntries((folders || []).map(f => [f.id, f.name])),
    [folders]
  )
  const handleHover = useCallback((img) => setHoverImg(img), [])
  const handleHoverEnd = useCallback(() => setHoverImg(null), [])
  const handleMouseMove = useCallback((e) => setHoverPos({ x: e.clientX, y: e.clientY }), [])

  const reload = useCallback(async () => {
    setLoading(true)
    let rows = []
    if (isAllView) {
      if (folderIds.length) {
        let from = 0
        while (true) {
          const { data } = await sb.from('list_items')
            .select('*')
            .in('folder_id', folderIds)
            .order('name')
            .range(from, from + 999)
          if (data?.length) rows = [...rows, ...data]
          if (!data || data.length < 1000) break
          from += 1000
        }
      }
    } else {
      const { data } = await sb.from('list_items').select('*').eq('folder_id', folder.id).order('name')
      if (data?.length) rows = data
    }
    setItems(rows)
    if (rows.length) {
      const map = await loadCardMapWithSharedPrices(rows)
      if (map) setSfMap({ ...map })
    } else {
      setSfMap({})
    }
    setLoading(false)
  }, [folder?.id, folderIds, isAllView])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    if (folders.length) {
      setAllFolders(
        isAllView
          ? folders
          : folders.filter(f => f.id !== folder.id)
      )
      return
    }
    sb.from('folders').select('id, name, type').eq('user_id', user.id).eq('type', 'list').then(({ data }) => {
      setAllFolders(isAllView ? (data || []) : (data || []).filter(f => f.id !== folder.id))
    })
  }, [user.id, folder?.id, folders, isAllView])

  const filtered = useMemo(
    () => applyFilterSort(items, sfMap, search, sort, filters),
    [items, sfMap, search, sort, filters]
  )
  const selectedItem = selectedItemId ? items.find(item => item.id === selectedItemId) : null
  const selectedSf = selectedItem ? sfMap[`${selectedItem.set_code}-${selectedItem.collector_number}`] : null

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

  const toggleSelectMode  = () => { setSelectMode(v => !v); setSelectedItems(new Set()); setSplitState(new Map()) }
  const clearSelect = () => { setSelectedItems(new Set()); setSplitState(new Map()); setSelectMode(false) }
  const enterSelectMode   = useCallback(() => setSelectMode(true), [])
  const onToggleSelect = useCallback((id, totalQty) => {
    setSelectedItems(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        setSplitState(s => { const n = new Map(s); n.delete(id); return n })
      } else {
        next.add(id)
        if (totalQty > 1) setSplitState(s => new Map(s).set(id, 1))
      }
      return next
    })
  }, [])

  const onAdjustQty = useCallback((id, delta, totalQty) => {
    setSplitState(prev => {
      const current = prev.get(id) ?? 1
      const next = Math.min(totalQty, current + delta)
      if (next <= 0) {
        setSelectedItems(sel => {
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

  const handleDelete = async (id) => {
    await sb.from('list_items').delete().eq('id', id)
    setItems(prev => prev.filter(i => i.id !== id))
  }

  const handleBulkDelete = async () => {
    const toDelete = [], toUpdate = []
    for (const id of selectedItems) {
      const item = items.find(i => i.id === id)
      const totalQty = item?.qty || 1
      const selQty = splitState.get(id) ?? 1
      const remaining = totalQty - selQty
      remaining > 0 ? toUpdate.push({ id, remaining }) : toDelete.push(id)
    }
    if (toDelete.length) await sb.from('list_items').delete().in('id', toDelete)
    for (const { id, remaining } of toUpdate) {
      await sb.from('list_items').update({ qty: remaining }).eq('id', id)
    }
    setItems(prev => prev.map(i => {
      if (toDelete.includes(i.id)) return null
      const upd = toUpdate.find(u => u.id === i.id)
      return upd ? { ...i, qty: upd.remaining } : i
    }).filter(Boolean))
    setSelectedItems(new Set()); setSplitState(new Map()); setSelectMode(false)
  }

  const handleMoveToWishlist = async (targetFolder) => {
    const toDelete = []
    const toUpdate = []
    const upserts = []

    for (const id of selectedItems) {
      const item = items.find(i => i.id === id)
      if (!item) continue
      if (item.folder_id === targetFolder.id) continue
      const totalQty = item.qty || 1
      const selQty = splitState.get(id) ?? 1
      const remaining = totalQty - selQty

      upserts.push({
        folder_id: targetFolder.id,
        user_id: user.id,
        name: item.name,
        set_code: item.set_code || null,
        collector_number: item.collector_number || null,
        scryfall_id: item.scryfall_id || null,
        foil: item.foil ?? false,
        qty: selQty,
      })

      if (remaining > 0) toUpdate.push({ id, remaining })
      else toDelete.push(id)
    }

    if (upserts.length) {
      const { error } = await sb.from('list_items')
        .upsert(upserts, { onConflict: 'folder_id,set_code,collector_number,foil' })
      if (error) return
    }
    if (toDelete.length) await sb.from('list_items').delete().in('id', toDelete)
    for (const { id, remaining } of toUpdate) {
      await sb.from('list_items').update({ qty: remaining }).eq('id', id)
    }

    setItems(prev => prev.map(i => {
      if (toDelete.includes(i.id)) return null
      const upd = toUpdate.find(u => u.id === i.id)
      return upd ? { ...i, qty: upd.remaining } : i
    }).filter(Boolean))
    setSelectedItems(new Set())
    setSplitState(new Map())
    setSelectMode(false)
  }

  if (loading) return <EmptyState>Loading…</EmptyState>

  return (
    <div onMouseMove={handleMouseMove} onMouseLeave={handleHoverEnd}>
      {/* ── Wishlist header ── */}
      <div className={styles.binderHeader}>
        <Button variant="ghost" size="sm" className={styles.backBtn} onClick={onBack}>← Back to Wishlists</Button>
        <div className={styles.binderTitleRow}>
          <h2 className={styles.binderTitle}>{browserTitle}</h2>
          <div className={styles.binderMeta}>
            <span>{totalQty} wants</span>
            <span className={styles.binderValue}>{formatPrice(totalValue, price_source)}</span>
            <div className={styles.browserHeaderActionsDesktop}>
              <Button variant="secondary" size="sm" onClick={() => setShowExport(true)}>↓ Export</Button>
              {!isAllView && <Button variant="secondary" size="sm" onClick={() => setShowImport(true)}>↑ Import</Button>}
              <Button size="sm" onClick={() => setShowAddCard(true)}>+ Add Cards</Button>
            </div>
            <div className={styles.browserHeaderActionsMobile}>
              <ResponsiveMenu
                title="Wishlist Actions"
                trigger={({ open, toggle }) => (
                  <button className={styles.mobileHeaderActionsBtn} onClick={toggle}>
                    <span>Actions</span>
                    <svg className={`${styles.mobileViewChevron} ${open ? styles.mobileViewChevronOpen : ''}`}
                      width="10" height="10" viewBox="0 0 10 10" fill="none"
                      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="2,3 5,6.5 8,3" />
                    </svg>
                  </button>
                )}
              >
                {({ close }) => (
                  <div className={uiStyles.responsiveMenuList}>
                    <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowExport(true); close() }}>
                      <span>Export</span>
                    </button>
                    {!isAllView && <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowImport(true); close() }}>
                      <span>Import</span>
                    </button>}
                    <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowAddCard(true); close() }}>
                      <span>Add Cards</span>
                    </button>
                  </div>
                )}
              </ResponsiveMenu>
            </div>
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
        <CardBrowserViewControls
          viewMode={viewMode}
          setViewMode={setViewMode}
          groupBy={groupBy}
          setGroupBy={setGroupBy}
        />
        {false && (
        <>
        <div className={styles.browserControlsDesktop}>
          <div className={`${styles.viewToggle} ${uiStyles.segmented}`}>
            <Button variant="toggle" size="sm" active={view === 'list'}
              onClick={() => setView('list')}>≡ List</Button>
            <Button variant="toggle" size="sm" active={view === 'grid'}
              onClick={() => setView('grid')}>⊞ Grid</Button>
          </div>
        </div>
        <div className={styles.browserControlsMobile}>
          <ResponsiveMenu
            title="View Mode"
            trigger={({ open, toggle }) => (
              <button className={styles.mobileViewBtn} onClick={toggle}>
                <span>View</span>
                <svg className={`${styles.mobileViewChevron} ${open ? styles.mobileViewChevronOpen : ''}`}
                  width="10" height="10" viewBox="0 0 10 10" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="2,3 5,6.5 8,3" />
                </svg>
              </button>
            )}
          >
            {({ close }) => (
              <div className={uiStyles.responsiveMenuList}>
                <button className={`${uiStyles.responsiveMenuAction} ${view === 'list' ? uiStyles.responsiveMenuActionActive : ''}`}
                  onClick={() => { setView('list'); close() }}>
                  <span>List</span>
                  <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{view === 'list' ? '✓' : ''}</span>
                </button>
                <button className={`${uiStyles.responsiveMenuAction} ${view === 'grid' ? uiStyles.responsiveMenuActionActive : ''}`}
                  onClick={() => { setView('grid'); close() }}>
                  <span>Grid</span>
                  <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{view === 'grid' ? '✓' : ''}</span>
                </button>
              </div>
            )}
          </ResponsiveMenu>
        </div>
        </>
        )}
      </div>

      {selectMode && selectedItems.size > 0 && (
        <BulkActionBar
          selected={selectedItems}
          selectedQty={[...selectedItems].reduce((sum, id) => sum + (splitState.get(id) ?? 1), 0)}
          total={filtered.length}
          onSelectAll={() => setSelectedItems(new Set(filtered.map(i => i.id)))}
          onDeselectAll={clearSelect}
          onDelete={handleBulkDelete}
          onMoveToFolder={handleMoveToWishlist}
          folders={allFolders}
          allowedFolderTypes={['list']}
          onCreateFolder={async (_type, name) => {
            const { data: newFolder } = await sb.from('folders')
              .insert({ user_id: user.id, type: 'list', name })
              .select('id, name, type')
              .single()
            if (newFolder) {
              setAllFolders(prev => [...prev, newFolder])
              await handleMoveToWishlist(newFolder)
            }
          }}
        />
      )}

      {filtered.length === 0 && <EmptyState>No cards match.</EmptyState>}

      {filtered.length > 0 && (
        <CardBrowserContent
          cards={filtered.map(item => ({
            ...item,
            _folderName: isAllView ? folderNameById[item.folder_id] || '' : '',
          }))}
          sfMap={sfMap}
          priceSource={price_source}
          viewMode={viewMode}
          groupBy={groupBy}
          density={grid_density}
          onSelect={item => setSelectedItemId(item.id)}
          selectMode={selectMode}
          selectedCards={selectedItems}
          onToggleSelect={onToggleSelect}
          onAdjustQty={onAdjustQty}
          splitState={splitState}
          onEnterSelectMode={enterSelectMode}
          onHover={handleHover}
          onHoverEnd={handleHoverEnd}
        />
      )}
      {false && view === 'list' && filtered.length > 0 && (
        <div className={listStyles.list}>
          {filtered.map(item => (
            <WishlistItem
              key={item.id}
              item={item}
              sfCard={sfMap[`${item.set_code}-${item.collector_number}`]}
              priceSource={price_source}
              selectMode={selectMode}
              selected={selectedItems.has(item.id)}
              onToggleSelect={() => onToggleSelect(item.id, item.qty || 1)}
              onDelete={handleDelete}
              onEnterSelectMode={enterSelectMode}
              folderName={isAllView ? folderNameById[item.folder_id] || '' : ''}
            />
          ))}
        </div>
      )}

      {false && view === 'grid' && filtered.length > 0 && (
        <CardGrid
          cards={filtered}
          sfMap={sfMap}
          onSelect={() => {}}
          selectMode={selectMode}
          selected={selectedItems}
          onToggleSelect={onToggleSelect}
          onEnterSelectMode={enterSelectMode}
          splitState={splitState}
          onAdjustQty={onAdjustQty}
        />
      )}

      {selectedItem && (
        <CardDetail
          card={selectedItem}
          sfCard={selectedSf}
          priceSource={price_source}
          readOnly
          onClose={() => setSelectedItemId(null)}
        />
      )}
      {hoverImg && (
        <div className={styles.floatingPreview}
          style={{ left: hoverPos.x + 18, top: Math.max(8, hoverPos.y - 160), pointerEvents: 'none' }}>
          <img className={styles.floatingImg} src={hoverImg} alt="" />
        </div>
      )}

      {showImport && user && !isAllView && (
        <ImportModal
          userId={user.id}
          folderType="list"
          folders={[folder]}
          defaultFolderId={folder.id}
          onClose={() => setShowImport(false)}
          onSaved={() => { setShowImport(false); reload() }}
        />
      )}
      {showAddCard && user && (
        <AddCardModal
          userId={user.id}
          folderMode
          defaultFolderType="list"
          defaultFolderId={folder?.id || null}
          onClose={() => setShowAddCard(false)}
          onSaved={async () => { setShowAddCard(false); await reload() }}
        />
      )}
      {showExport && (
        <ExportModal
          cards={items.map(item => ({
            ...item,
            _folder_qty: item.qty,
            _folderName: folderNameById[item.folder_id] || '',
            _folderType: 'list',
          }))}
          sfMap={sfMap}
          title={browserTitle}
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
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming]   = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const renameRef = useRef(null)

  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.()
  }, { delay: 500 })
  const { fired: lpFired, ...longPressHandlers } = longPress

  useEffect(() => { if (renaming) renameRef.current?.focus() }, [renaming])

  const startRename = () => { setRenameVal(folder.name); setRenaming(true) }
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
    if (lpFired.current) {
      lpFired.current = false
      return
    }
    if (selectMode) { onToggleSelect(); return }
    onClick()
  }
  const longPressProps = renaming ? {} : longPressHandlers

  return (
    <div
      className={`${styles.folderCard}${menuOpen ? ` ${styles.folderCardMenuOpen}` : ''}${selectMode ? ` ${styles.folderCardSelectMode}` : ''}${selectMode && selected ? ` ${styles.folderCardSelected}` : ''}`}
      style={{
        ...(bgUrl ? {
          backgroundImage: `linear-gradient(rgba(10,10,18,0.55) 0%, rgba(10,10,18,0.80) 100%), url(${bgUrl})`,
          backgroundSize: 'cover', backgroundPosition: 'center top',
        } : {}),
      }}
      onClick={handleCardClick}
      {...longPressProps}>

      {selectMode ? (
        <div
          className={`${styles.selectCheckbox}${selected ? ` ${styles.selectCheckboxChecked}` : ''}`}
          onClick={e => { e.stopPropagation(); onToggleSelect() }}
        />
      ) : (
        <ResponsiveMenu
          title="Options"
          wrapClassName={styles.cogMenuWrap}
          onOpenChange={setMenuOpen}
          trigger={({ toggle }) => (
            <button className={styles.cogBtn} onClick={e => { e.stopPropagation(); toggle() }} title="Options">
              <SettingsIcon size={14} />
            </button>
          )}
        >
          {({ close }) => (
            <div className={uiStyles.responsiveMenuList}>
              <button
                className={uiStyles.responsiveMenuAction}
                onClick={e => { e.stopPropagation(); startRename(); close() }}
              >
                <span className={styles.cogMenuItemIcon}><EditIcon size={12} /> Rename</span>
              </button>
              <button
                className={uiStyles.responsiveMenuAction}
                onClick={e => { e.stopPropagation(); onEditBg?.(); close() }}
              >
                <span className={styles.cogMenuItemIcon}><ImageIcon size={12} /> Set background art</span>
              </button>
              {bgUrl && (
                <button
                  className={uiStyles.responsiveMenuAction}
                  onClick={e => { e.stopPropagation(); onClearBg?.(); close() }}
                >
                  <span className={styles.cogMenuItemIcon}><RemoveIcon size={12} /> Clear background</span>
                </button>
              )}
              <button
                className={uiStyles.responsiveMenuAction}
                onClick={e => { e.stopPropagation(); onMoveToGroup?.(); close() }}
              >
                <span className={styles.cogMenuItemIcon}><BinderIcon size={12} /> Move to Group</span>
              </button>
              <button
                className={`${uiStyles.responsiveMenuAction} ${uiStyles.responsiveMenuActionDanger}`}
                onClick={e => { e.stopPropagation(); onDelete(); close() }}
              >
                <span className={styles.cogMenuItemIcon}><DeleteIcon size={12} /> Delete</span>
              </button>
            </div>
          )}
        </ResponsiveMenu>
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
  const [renaming, setRenaming]   = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const renameRef = useRef(null)

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
        <ResponsiveMenu
          title="Group Actions"
          wrapClassName={styles.groupCogWrap}
          trigger={({ toggle }) => (
            <button className={styles.groupCogBtn} onClick={e => { e.stopPropagation(); toggle() }}>...</button>
          )}
        >
          {({ close }) => (
            <div className={uiStyles.responsiveMenuList}>
              {!isFirst && (
                <button className={uiStyles.responsiveMenuAction} onClick={() => { onMoveUp(); close() }}>
                  Move Up
                </button>
              )}
              {!isLast && (
                <button className={uiStyles.responsiveMenuAction} onClick={() => { onMoveDown(); close() }}>
                  Move Down
                </button>
              )}
              <button className={uiStyles.responsiveMenuAction} onClick={() => { setRenameVal(group.name); setRenaming(true); close() }}>
                Rename
              </button>
              <button className={`${uiStyles.responsiveMenuAction} ${uiStyles.responsiveMenuActionDanger}`} onClick={() => { onDeleteGroup(group); close() }}>
                Delete Group
              </button>
            </div>
          )}
        </ResponsiveMenu>
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
  const [folderSearch, setFolderSearch] = useState('')
  const [loading, setLoading]           = useState(true)
  const [activeFolder, setActiveFolder] = useState(null)
  const [showAllCards, setShowAllCards] = useState(false)
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
      const cards = allItems.map(item => {
        const folder = folders.find(f => f.id === item.folder_id)
        return { ...item, _folder_qty: item.qty, _folderName: folder?.name || '', _folderType: 'list' }
      })
      const sfMap = cards.length ? await loadCardMapWithSharedPrices(cards) : {}
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

    const sfMap = allItems.length ? await loadCardMapWithSharedPrices(allItems) : {}
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
  const normalizedFolderSearch = folderSearch.trim().toLowerCase()
  const filteredRegularFolders = useMemo(() => {
    if (!normalizedFolderSearch) return regularFolders
    return regularFolders.filter(f => f.name.toLowerCase().includes(normalizedFolderSearch))
  }, [regularFolders, normalizedFolderSearch])
  const filteredGroups = useMemo(() => {
    if (!normalizedFolderSearch) return groups
    const memberGroupIds = new Set(filteredRegularFolders.map(f => parseFolderDesc(f.description).groupId).filter(Boolean))
    return groups.filter(group =>
      group.name.toLowerCase().includes(normalizedFolderSearch) || memberGroupIds.has(group.id)
    )
  }, [groups, filteredRegularFolders, normalizedFolderSearch])
  const filteredFoldersByGroup = useMemo(() => {
    if (!normalizedFolderSearch) return foldersByGroup
    const map = {}
    for (const group of filteredGroups) {
      const groupMatches = group.name.toLowerCase().includes(normalizedFolderSearch)
      map[group.id] = groupMatches
        ? (foldersByGroup[group.id] || [])
        : filteredRegularFolders.filter(f => parseFolderDesc(f.description).groupId === group.id)
    }
    return map
  }, [filteredGroups, filteredRegularFolders, foldersByGroup, normalizedFolderSearch])
  const filteredUngroupedFolders = useMemo(
    () => filteredRegularFolders.filter(f => !parseFolderDesc(f.description).groupId),
    [filteredRegularFolders]
  )

  if (activeFolder) return (
    <ListBrowser folder={activeFolder} folders={regularFolders} onBack={() => { setActiveFolder(null); loadFolders() }} />
  )

  if (showAllCards) return (
    <ListBrowser
      folders={regularFolders}
      title="All Wishlist Cards"
      onBack={() => { setShowAllCards(false); loadFolders() }}
    />
  )

  if (loading) return <EmptyState>Loading wishlists…</EmptyState>

  return (
    <div className={styles.page}>
      <SectionHeader
        title="Wishlists"
        action={
          <ResponsiveHeaderActions
            primary={!selectMode ? (
              <Button size="sm" className={styles.viewAllBtn} onClick={() => setShowAllCards(true)}>View All Cards</Button>
            ) : null}
            menuLabel="Wishlist actions"
            mobileExtra={!selectMode ? (
              <div className={styles.mobileHeaderControls}>
                <input
                  className={styles.folderSearch}
                  value={folderSearch}
                  onChange={e => setFolderSearch(e.target.value)}
                  placeholder="Search wishlists…"
                />
                <SortDropdown value={sort} onChange={handleSortChange} options={SORT_OPTIONS} compact />
              </div>
            ) : null}
          >
            <div className={styles.headerActions}>
              {selectMode ? (
                <>
                <Button variant="ghost" size="sm" onClick={exitSelectMode}>Cancel</Button>
                {groups.length > 0 && (
                  <Button variant="secondary" size="sm" disabled={selectedIds.size === 0}
                    onClick={() => setShowBulkMoveGroup(true)}>
                    📁 Group ({selectedIds.size})
                  </Button>
                )}
                <Button variant="danger" size="sm" disabled={selectedIds.size === 0}
                  onClick={handleBulkDelete}>
                  <DeleteIcon size={12} /> Delete ({selectedIds.size})
                </Button>
                </>
              ) : (
                <>
                <Button variant="secondary" size="sm" onClick={() => setShowNewGroup(true)}>+ New Group</Button>
                <Button variant="ghost" size="sm" onClick={() => setShowImport(true)}>↑ Import</Button>
                <Button variant="ghost" size="sm" onClick={handleExportAll}>↓ Export</Button>
                <Button size="sm" onClick={() => setShowNewFolder(true)}>+ New Wishlist</Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectMode(true)}>Select</Button>
                <input
                  className={`${styles.folderSearch} ${styles.desktopOnlySearch}`}
                  value={folderSearch}
                  onChange={e => setFolderSearch(e.target.value)}
                  placeholder="Search wishlists…"
                />
                <div className={styles.desktopOnlyAction}>
                  <SortDropdown value={sort} onChange={handleSortChange} options={SORT_OPTIONS} />
                </div>
                </>
              )}
            </div>
          </ResponsiveHeaderActions>
        }
      />

      {folders.length === 0 && (
        <EmptyState>No wishlists yet. Lists from your Manabox CSV will appear here after import.</EmptyState>
      )}

      {filteredGroups.map((group, idx) => (
        <GroupSection
          key={group.id}
          group={group}
          folders={filteredFoldersByGroup[group.id] || []}
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
          isLast={idx === filteredGroups.length - 1}
        />
      ))}

      {filteredUngroupedFolders.length > 0 && (
        <>
          {filteredGroups.length > 0 && <div className={styles.ungroupedHeader}>Ungrouped</div>}
          <div className={styles.folderGrid}>
            {filteredUngroupedFolders.map(folder => (
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

      {folders.length > 0 && filteredGroups.length === 0 && filteredUngroupedFolders.length === 0 && (
        <EmptyState>No wishlists match "{folderSearch.trim()}".</EmptyState>
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

