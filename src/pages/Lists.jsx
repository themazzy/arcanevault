import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { sb } from '../lib/supabase'
import { getLocalFolders, getLocalListItems, getAllLocalListItemsForFolders, putListItems, replaceLocalListItems, deleteListItemsByIds, getFolderMetaCache, setFolderMetaCache } from '../lib/db'
import { toListItemRow } from '../lib/deckBuilderWrites'
import { queryClient } from '../lib/queryClient'
import { invalidateWishlistQueries } from '../lib/queryInvalidation'
import { trackActivity } from '../lib/activity'
import { getPrice, formatPrice, getScryfallKey } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { useToast } from '../components/ToastContext'
import { EmptyState, LibraryEmptyState, SectionHeader, Modal, ResponsiveHeaderActions, ResponsiveMenu, Button, SearchInput, Select } from '../components/UI'
import { CardDetail, FilterBar, BulkActionBar, EMPTY_FILTERS } from '../components/CardComponents'
import { useLongPress } from '../hooks/useLongPress'
import { useFilterWorker } from '../hooks/useFilterWorker'
import AddCardModal from '../components/AddCardModal'
import ShareModal from '../components/ShareModal'
import ImportModal from '../components/ImportModal'
import ExportModal from '../components/ExportModal'
import { CardBrowserViewControls, CardBrowserContent } from '../components/CardBrowserViews'
import styles from './Folders.module.css'
import { CloseIcon, CheckIcon, AddIcon, BinderIcon, ChevronLeftIcon, CollectionIcon, DeleteIcon, EditIcon, ExportIcon, ImageIcon, ImportIcon, RemoveIcon, SearchIcon, SettingsIcon, ShareIcon, SortIcon, StacksViewIcon, WishlistsIcon } from '../icons'
import uiStyles from '../components/UI.module.css'
import { useLibraryBrowserPreferences } from '../hooks/useLibraryBrowserPreferences'
import { fetchPrintingsByName } from '../lib/cardSearch'
import { ensureCardPrints, getCardPrint } from '../lib/cardPrints'

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
  ['name',       'Name A→Z'],
  ['name_desc',  'Name Z→A'],
  ['value_desc', 'Value ↓'],
  ['value_asc',  'Value ↑'],
  ['count_desc', 'Cards ↓'],
  ['count_asc',  'Cards ↑'],
]

function sortFolders(folders, meta, sort) {
  return [...folders].sort((a, b) => {
    const ma = meta[a.id] || {}, mb = meta[b.id] || {}
    if (sort === 'value_desc') return (mb.value || 0) - (ma.value || 0)
    if (sort === 'value_asc')  return (ma.value || 0) - (mb.value || 0)
    if (sort === 'count_desc') return (mb.totalQty || 0) - (ma.totalQty || 0)
    if (sort === 'count_asc')  return (ma.totalQty || 0) - (mb.totalQty || 0)
    if (sort === 'name_desc')  return b.name.localeCompare(a.name)
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
      portal
      trigger={({ open, toggle }) => (
        <button className={styles.sortDropdownBtn} onClick={toggle}>
          <SortIcon size={14} />
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
              <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{v === value ? <CheckIcon size={12} /> : null}</span>
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
  const timerRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => () => clearTimeout(timerRef.current), [])

  const search = async (q) => {
    const term = q ?? query
    if (!term.trim()) return
    setLoading(true)
    try {
      const r = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(term)}&unique=art&order=name`)
      const data = await r.json()
      setResults((data.data || []).filter(c => c.image_uris?.art_crop).slice(0, 20))
    } catch { setResults([]) }
    setLoading(false)
  }

  const handleQueryChange = (v) => {
    setQuery(v)
    clearTimeout(timerRef.current)
    if (v.trim().length < 2) { setResults([]); return }
    timerRef.current = setTimeout(() => search(v), 350)
  }

  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 14, fontSize: '1rem' }}>
        Choose Card Art Background
      </h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <SearchInput ref={inputRef} value={query} onChange={e => handleQueryChange(e.target.value)}
          onClear={() => handleQueryChange('')}
          onKeyDown={e => { if (e.key === 'Enter') { clearTimeout(timerRef.current); search() } }}
          placeholder="Search card name…"
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--s-border2)',
            borderRadius: 4, padding: '8px 12px', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }} />
        {loading && <span style={{ alignSelf: 'center', color: 'var(--text-faint)', fontSize: '0.85rem' }}>…</span>}
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

// ── ListBrowser ───────────────────────────────────────────────────────────────
function WishlistItemEditModal({ item, onClose, onSaved }) {
  const [qty, setQty] = useState(item.qty || 1)
  const [foil, setFoil] = useState(!!item.foil)
  const [printings, setPrintings] = useState([])
  const [printingId, setPrintingId] = useState(item.scryfall_id || '')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchPrintingsByName(item.name, { language: 'all' })
      .then(rows => {
        if (cancelled) return
        setPrintings(rows || [])
        if (!printingId && rows?.[0]?.id) setPrintingId(rows[0].id)
      })
      .catch(() => { if (!cancelled) setError('Could not load available printings.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [item.name]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      const selectedPrinting = printings.find(printing => printing.id === printingId)
      let cardPrintId = item.card_print_id
      if (selectedPrinting && selectedPrinting.id !== item.scryfall_id) {
        const printMap = await ensureCardPrints([selectedPrinting])
        cardPrintId = getCardPrint(printMap, selectedPrinting)?.id
      }
      if (!cardPrintId) throw new Error('Could not resolve that printing.')

      const { data: existing, error: existingError } = await sb.from('list_items')
        .select('id,qty')
        .eq('folder_id', item.folder_id)
        .eq('card_print_id', cardPrintId)
        .eq('foil', foil)
        .neq('id', item.id)
        .maybeSingle()
      if (existingError) throw existingError

      if (existing) {
        const { error: mergeError } = await sb.from('list_items').update({ qty: (existing.qty || 0) + qty }).eq('id', existing.id)
        if (mergeError) throw mergeError
        const { error: deleteError } = await sb.from('list_items').delete().eq('id', item.id)
        if (deleteError) throw deleteError
      } else {
        const { error: updateError } = await sb.from('list_items')
          .update({ qty, foil, card_print_id: cardPrintId })
          .eq('id', item.id)
        if (updateError) throw updateError
      }

      await onSaved()
      onClose()
    } catch (err) {
      setError(err.message || 'Could not update this wishlist item.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className={styles.wishlistEditTitle}>Edit wanted card</h2>
      <p className={styles.wishlistEditName}>{item.name}</p>
      <div className={styles.wishlistEditGrid}>
        <label>
          <span>Quantity wanted</span>
          <input type="number" min="1" value={qty} onChange={event => setQty(Math.max(1, parseInt(event.target.value) || 1))} />
        </label>
        <label>
          <span>Printing</span>
          <Select value={printingId} onChange={event => setPrintingId(event.target.value)} disabled={loading}>
            {!printings.length && <option value={printingId}>{loading ? 'Loading printings…' : `${(item.set_code || '').toUpperCase()} #${item.collector_number || ''}`}</option>}
            {printings.map(printing => (
              <option key={printing.id} value={printing.id}>
                {printing.set_name || printing.set?.toUpperCase()} · {(printing.set || '').toUpperCase()} #{printing.collector_number}
              </option>
            ))}
          </Select>
        </label>
        <label className={styles.wishlistFoilRow}>
          <input type="checkbox" checked={foil} onChange={event => setFoil(event.target.checked)} />
          <span>Foil</span>
        </label>
      </div>
      {error && <p className={styles.wishlistEditError} role="alert">{error}</p>}
      <div className={styles.wishlistEditActions}>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button size="sm" onClick={save} disabled={saving || loading}>{saving ? 'Saving…' : 'Save changes'}</Button>
      </div>
    </Modal>
  )
}

function ListBrowser({ folder = null, folders = [], title = '', onBack }) {
  const { price_source, default_sort, grid_density } = useSettings()
  const { user } = useAuth()
  const toast = useToast()
  const [items, setItems]       = useState([])
  const [sfMap, setSfMap]       = useState({})
  const [allFolders, setAllFolders] = useState([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [sort, setSort]         = useState(
    ['pl_desc', 'pl_asc'].includes(default_sort) ? 'name' : (default_sort || 'name'),
  )
  const [filters, setFilters]   = useState({ ...EMPTY_FILTERS })
  const [selectMode, setSelectMode]       = useState(false)
  const [selectedItems, setSelectedItems] = useState(new Set())
  const [splitState, setSplitState]       = useState(new Map())
  const [showAddCard, setShowAddCard]     = useState(false)
  const [showImport, setShowImport]       = useState(false)
  const [importText, setImportText]       = useState('')
  const [showExport, setShowExport]       = useState(false)
  const [showShare, setShowShare]         = useState(false)
  const [editItem, setEditItem]           = useState(null)
  const [acquireItem, setAcquireItem]     = useState(null)
  const { viewMode, setViewMode, groupBy, setGroupBy } = useLibraryBrowserPreferences('wishlist')
  const [filterOpen, setFilterOpen]       = useState(false)
  const [selectedItemId, setSelectedItemId] = useState(null)
  const [hoverImg, setHoverImg]           = useState(null)
  const [hoverPos, setHoverPos]           = useState({ x: 0, y: 0 })
  const isAllView = !folder
  const browserTitle = title || folder?.name || 'All Wishlist Cards'
  const openImport = () => { setImportText(''); setShowImport(true) }

  // Inline rename: click the title (same treatment as the deck browser)
  const [folderName, setFolderName] = useState(folder?.name || '')
  const [renamingFolder, setRenamingFolder] = useState(false)
  const [renameVal, setRenameVal] = useState(folder?.name || '')
  const renameInputRef = useRef(null)
  useEffect(() => { setFolderName(folder?.name || ''); setRenameVal(folder?.name || '') }, [folder?.name])
  useEffect(() => { if (renamingFolder) renameInputRef.current?.select() }, [renamingFolder])
  const startRenameFolder = () => { if (!folder) return; setRenameVal(folderName); setRenamingFolder(true) }
  const commitRenameFolder = async () => {
    setRenamingFolder(false)
    const trimmed = renameVal.trim()
    if (!folder || !trimmed || trimmed === folderName) return
    const prev = folderName
    setFolderName(trimmed)
    const { error } = await sb.from('folders').update({ name: trimmed }).eq('id', folder.id)
    if (error) { setFolderName(prev); toast.error('Rename failed.') }
    else { folder.name = trimmed; toast.success('Wishlist renamed.') }
  }
  const folderIds = useMemo(() => folders.map(f => f.id), [folders])
  const folderNameById = useMemo(
    () => Object.fromEntries((folders || []).map(f => [f.id, f.name])),
    [folders]
  )
  const handleHover = useCallback((img) => setHoverImg(img), [])
  const handleHoverEnd = useCallback(() => setHoverImg(null), [])
  const handleMouseMove = useCallback((e) => setHoverPos({ x: e.clientX, y: e.clientY }), [])

  const reload = useCallback(async () => {
    // Phase A — IDB-first read for instant paint.
    let seeded = false
    try {
      const localRows = isAllView
        ? (folderIds.length ? await getAllLocalListItemsForFolders(folderIds) : [])
        : await getLocalListItems(folder.id)
      if (localRows.length) {
        const sorted = [...localRows].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        setItems(sorted)
        const map = await loadCardMapWithSharedPrices(sorted, { priceLookup: 'set' })
        if (map) setSfMap(prev => ({ ...prev, ...map }))
        setLoading(false)
        seeded = true
      }
    } catch {}

    if (!seeded) setLoading(true)

    // Phase B — Supabase reconcile.
    let rows = []
    let networkError = false
    if (isAllView) {
      if (folderIds.length) {
        let from = 0
        while (true) {
          const { data, error } = await sb.from('list_items_view')
            .select('*')
            .in('folder_id', folderIds)
            .order('name')
            .range(from, from + 999)
          if (error) { networkError = true; break }
          if (data?.length) rows = [...rows, ...data]
          if (!data || data.length < 1000) break
          from += 1000
        }
      }
    } else {
      const { data, error } = await sb.from('list_items_view').select('*').eq('folder_id', folder.id).order('name')
      if (error) networkError = true
      else if (data?.length) rows = data
    }

    // Network error: keep seeded data on screen, never wipe.
    if (networkError) { if (!seeded) setLoading(false); return }

    setItems(rows)
    if (rows.length) {
      const map = await loadCardMapWithSharedPrices(rows, { priceLookup: 'set' })
      if (map) setSfMap(prev => ({ ...prev, ...map }))
    } else {
      setSfMap({})
    }
    setLoading(false)

    // Phase C — Mirror fresh server state into IDB so next mount paints instantly.
    try {
      if (isAllView) {
        if (folderIds.length) await replaceLocalListItems(folderIds, rows)
      } else {
        await replaceLocalListItems([folder.id], rows)
      }
    } catch {}
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
    let cancelled = false
    getLocalFolders(user.id)
      .then(data => {
        if (cancelled) return
        const regular = (data || []).filter(f => f.type === 'list' && !isGroupFolder(f))
        setAllFolders(isAllView ? regular : regular.filter(f => f.id !== folder.id))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [user.id, folder?.id, folders, isAllView])

  const itemById = useMemo(() => {
    const m = new Map()
    for (const item of items) {
      if (item?.id != null) m.set(item.id, item)
    }
    return m
  }, [items])

  const filtered = useFilterWorker({ cards: items, sfMap, search, sort, filters, priceSource: price_source })
  const availableSets = useMemo(() => {
    const seen = {}
    for (const item of items) {
      if (!item.set_code) continue
      const sf = sfMap[getScryfallKey(item)]
      if (!seen[item.set_code]) seen[item.set_code] = sf?.set_name || item.set_code.toUpperCase()
    }
    return Object.entries(seen)
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [items, sfMap])
  const selectedItem = selectedItemId ? (itemById.get(selectedItemId) ?? null) : null
  const selectedSf = selectedItem ? sfMap[`${selectedItem.set_code}-${selectedItem.collector_number}`] : null
  const selectableItemQty = useMemo(() =>
    filtered.reduce((sum, item) => sum + (item.qty || 1), 0)
  , [filtered])
  const selectedQty = useMemo(() =>
    [...selectedItems].reduce((sum, id) => sum + (splitState.get(id) ?? 1), 0)
  , [selectedItems, splitState])

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
  const invalidateListCaches = useCallback((options = {}) => (
    invalidateWishlistQueries(queryClient, user?.id, options).catch(() => {})
  ), [user?.id])

  const _handleDelete = async (id) => {
    await sb.from('list_items').delete().eq('id', id)
    setItems(prev => prev.filter(i => i.id !== id))
    try { await deleteListItemsByIds([id]) } catch {}
    await invalidateListCaches()
    toast.success('Deleted 1 wishlist item.')
  }

  const handleBulkDelete = () => trackActivity(async () => {
    const deleteCount = [...selectedItems].reduce((sum, id) => sum + (splitState.get(id) ?? 1), 0)
    const toDelete = [], toUpdate = []
    for (const id of selectedItems) {
      const item = itemById.get(id)
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
    // Mirror to IDB so a tab reload paints the post-delete state instantly.
    try {
      if (toDelete.length) await deleteListItemsByIds(toDelete)
      if (toUpdate.length) {
        const updatedRows = toUpdate
          .map(({ id, remaining }) => {
            const existing = itemById.get(id)
            return existing ? { ...existing, qty: remaining } : null
          })
          .filter(Boolean)
        if (updatedRows.length) await putListItems(updatedRows)
      }
    } catch {}
    await invalidateListCaches()
    setSelectedItems(new Set()); setSplitState(new Map()); setSelectMode(false)
    toast.success(`Deleted ${deleteCount} ${deleteCount === 1 ? 'wishlist item' : 'wishlist items'}.`)
  })

  const handleMoveToWishlist = (targetFolder) => trackActivity(async () => {
    const toDelete = []
    const toUpdate = []
    const upsertMap = new Map()

    for (const id of selectedItems) {
      const item = itemById.get(id)
      if (!item) continue
      if (item.folder_id === targetFolder.id) continue
      const totalQty = item.qty || 1
      const selQty = splitState.get(id) ?? 1
      const remaining = totalQty - selQty

      const key = `${targetFolder.id}|${item.card_print_id || `${item.set_code}-${item.collector_number}`}|${item.foil ? 'foil' : 'normal'}`
      const existing = upsertMap.get(key)
      if (existing) {
        existing.qty += selQty
      } else {
        upsertMap.set(key, {
          folder_id: targetFolder.id,
          user_id: user.id,
          name: item.name,
          set_code: item.set_code || null,
          collector_number: item.collector_number || null,
          scryfall_id: item.scryfall_id || null,
          card_print_id: item.card_print_id || null,
          foil: item.foil ?? false,
          qty: selQty,
        })
      }

      if (remaining > 0) toUpdate.push({ id, remaining })
      else toDelete.push(id)
    }

    const incomingRows = [...upsertMap.values()]
    if (incomingRows.length) {
      const printIds = [...new Set(incomingRows.map(row => row.card_print_id).filter(Boolean))]
      let existingRows = []
      if (printIds.length) {
        const { data, error: existingError } = await sb.from('list_items')
          .select('card_print_id,foil,qty')
          .eq('folder_id', targetFolder.id)
          .in('card_print_id', printIds)
        if (existingError) return
        existingRows = data || []
      }
      const existingQtyByKey = new Map(existingRows.map(row => [`${row.card_print_id}|${row.foil ? 'foil' : 'normal'}`, row.qty || 0]))
      const upserts = incomingRows.map(row => ({
        ...row,
        qty: row.qty + (existingQtyByKey.get(`${row.card_print_id}|${row.foil ? 'foil' : 'normal'}`) || 0),
      }))
      const { error } = await sb.from('list_items')
        .upsert(upserts.map(toListItemRow), { onConflict: 'folder_id,card_print_id,foil' })
      if (error) return
    }
    if (toDelete.length) await sb.from('list_items').delete().in('id', toDelete)
    for (const { id, remaining } of toUpdate) {
      await sb.from('list_items').update({ qty: remaining }).eq('id', id)
    }

    setSelectedItems(new Set())
    setSplitState(new Map())
    setSelectMode(false)
    await reload()
    await invalidateListCaches()
    const movedQty = incomingRows.reduce((sum, row) => sum + row.qty, 0)
    if (movedQty > 0) toast.success(`Moved ${movedQty} ${movedQty === 1 ? 'item' : 'items'} to ${targetFolder.name}.`)
  })

  if (loading) return <EmptyState>Loading…</EmptyState>

  return (
    <div onMouseMove={handleMouseMove} onMouseLeave={handleHoverEnd}>
      {/* ── Wishlist header ── */}
      <div className={styles.binderHeader}>
        <div className={styles.binderTitleRow}>
          {renamingFolder ? (
            <input
              ref={renameInputRef}
              className={styles.binderTitleInput}
              value={renameVal}
              maxLength={100}
              onChange={e => setRenameVal(e.target.value)}
              onBlur={commitRenameFolder}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRenameFolder()
                if (e.key === 'Escape') { setRenameVal(folderName); setRenamingFolder(false) }
              }}
              aria-label="Wishlist name"
            />
          ) : (
            <h2 className={styles.binderTitle}>
              {folder ? (
                <button className={styles.binderTitleBtn} onClick={startRenameFolder} title="Rename wishlist">
                  {folderName}
                </button>
              ) : browserTitle}
            </h2>
          )}
          <div className={styles.binderMeta}>
            <span>{totalQty} wanted</span>
            <span className={styles.wishlistCost}>Est. cost {formatPrice(totalValue, price_source)}</span>
            <div className={styles.browserHeaderActionsDesktop}>
              {!isAllView && <Button variant="secondary" size="sm" onClick={() => setShowShare(true)}><ShareIcon size={12} /> Share</Button>}
              <Button variant="secondary" size="sm" onClick={() => setShowExport(true)}>↓ Export</Button>
              {!isAllView && <Button variant="secondary" size="sm" onClick={openImport}>↑ Import</Button>}
              <Button size="sm" onClick={() => setShowAddCard(true)}>+ Add Cards</Button>
            </div>
          </div>
        </div>
        <div className={styles.browserBackRow}>
          <Button variant="secondary" size="sm" className={styles.browserBackBtn} onClick={onBack}>
            <ChevronLeftIcon size={13} /> Back to Wishlists
          </Button>
        </div>
      </div>

      {items.length > 0 && <FilterBar
        search={search} setSearch={setSearch}
        sort={sort} setSort={setSort}
        filters={filters} setFilters={setFilters}
        mode="wishlist"
        sets={availableSets}
        selectMode={selectMode}
        onToggleSelectMode={toggleSelectMode}
        filterOpen={filterOpen}
        onFilterOpenChange={setFilterOpen}
        hideActionsMobile
        hideSortFilterMobile
      />}

      {/* ── Control bar ── */}
      {items.length > 0 && <div className={styles.binderControlBar}>
        <span className={styles.binderCount}>
          Showing {filtered.length} of {items.length} unique · {totalQty} total cards
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
          onImport={!isAllView ? openImport : undefined}
          onExport={() => setShowExport(true)}
          onShare={!isAllView ? () => setShowShare(true) : undefined}
          bulkBarVisible={selectMode && selectedItems.size > 0}
        />
      </div>}

      {selectMode && selectedItems.size > 0 && (
        <BulkActionBar
          selected={selectedItems}
          selectedQty={selectedQty}
          total={selectableItemQty}
          onSelectAll={() => {
            setSelectedItems(new Set(filtered.map(i => i.id)))
            setSplitState(new Map(
              filtered
                .filter(i => (i.qty || 1) > 1)
                .map(i => [i.id, i.qty || 1])
            ))
          }}
          onDeselectAll={clearSelect}
          onDelete={handleBulkDelete}
          onMoveToFolder={handleMoveToWishlist}
          folders={allFolders}
          allowedFolderTypes={['list']}
          floatingMobile
          onCreateFolder={async (_type, name) => {
            const { data: newFolder } = await sb.from('folders')
              .insert({ user_id: user.id, type: 'list', name })
              .select('id, name, type')
              .single()
            if (newFolder) {
              setAllFolders(prev => [...prev, newFolder])
              await invalidateListCaches({ includeFolders: true, includeItems: false })
              await handleMoveToWishlist(newFolder)
            }
          }}
        />
      )}

      {items.length === 0 && !isAllView && (
        <LibraryEmptyState
          compact
          icon={<WishlistsIcon size={32} />}
          title={`Add cards to ${folder.name}`}
          description="Add cards you want or import an existing list. Wishlist-specific filters and views will appear once it contains cards."
          importFirst={false}
          manualAction={{
            label: 'Add wanted cards',
            icon: <AddIcon size={14} />,
            onClick: () => setShowAddCard(true),
          }}
          importAction={{
            label: 'Import a wishlist',
            description: 'Drop a .csv or .txt list here, or click to paste or upload.',
            onClick: openImport,
            onFile: async file => { setImportText(await file.text()); setShowImport(true) },
          }}
        />
      )}
      {items.length === 0 && isAllView && <EmptyState>Your wishlists do not contain any cards yet.</EmptyState>}
      {items.length > 0 && filtered.length === 0 && <EmptyState>No wishlist cards match your search or filters.</EmptyState>}

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

      {selectedItem && (
        <CardDetail
          card={selectedItem}
          sfCard={selectedSf}
          priceSource={price_source}
          readOnly
          actions={(
            <>
              <Button variant="secondary" size="sm" onClick={() => { setEditItem(selectedItem); setSelectedItemId(null) }}>
                <EditIcon size={13} /> Edit wanted card
              </Button>
              <Button size="sm" onClick={() => { setAcquireItem(selectedItem); setSelectedItemId(null) }}>
                <CollectionIcon size={13} /> Add to collection
              </Button>
            </>
          )}
          onClose={() => setSelectedItemId(null)}
        />
      )}
      {hoverImg && (
        <div className={styles.floatingPreview}
          style={{ left: hoverPos.x + 18, top: Math.max(8, hoverPos.y - 160), pointerEvents: 'none' }}>
          <img className={styles.floatingImg} src={hoverImg} alt="" />
        </div>
      )}

      {acquireItem && user && (
        <AddCardModal
          userId={user.id}
          initialCard={acquireItem}
          onClose={() => setAcquireItem(null)}
          onSaved={async () => { setAcquireItem(null); await invalidateListCaches(); await reload() }}
        />
      )}
      {editItem && (
        <WishlistItemEditModal
          item={editItem}
          onClose={() => setEditItem(null)}
          onSaved={async () => { await invalidateListCaches(); await reload() }}
        />
      )}
      {showShare && folder && <ShareModal folder={folder} onClose={() => setShowShare(false)} />}

      {showImport && user && !isAllView && (
        <ImportModal
          userId={user.id}
          folderType="list"
          folders={[folder]}
          defaultFolderId={folder.id}
          initialText={importText || undefined}
          onClose={() => setShowImport(false)}
          onSaved={() => { setShowImport(false); invalidateListCaches(); reload() }}
        />
      )}
      {showAddCard && user && (
        <AddCardModal
          userId={user.id}
          folderMode
          defaultFolderType="list"
          defaultFolderId={folder?.id || null}
          onClose={() => setShowAddCard(false)}
          onSaved={async () => { setShowAddCard(false); await invalidateListCaches(); await reload() }}
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
  const { consumeFired, ...longPressHandlers } = longPress

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
    if (consumeFired()) return
    if (selectMode) { onToggleSelect(); return }
    onClick()
  }
  const longPressProps = renaming ? {} : longPressHandlers

  return (
    <div
      className={`${styles.folderCard}${bgUrl ? ` ${styles.folderCardHasBg}` : ''}${menuOpen ? ` ${styles.folderCardMenuOpen}` : ''}${selectMode ? ` ${styles.folderCardSelectMode}` : ''}${selectMode && selected ? ` ${styles.folderCardSelected}` : ''}`}
      onClick={handleCardClick}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleCardClick()
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${folder.name}, ${qty} ${qty === 1 ? 'wanted card' : 'wanted cards'}`}
      aria-pressed={selectMode ? selected : undefined}
      {...longPressProps}>

      {bgUrl && (
        <div className={styles.folderCardArt} style={{ backgroundImage: `url(${bgUrl})` }} aria-hidden="true" />
      )}

      {selectMode ? null : (
        <ResponsiveMenu
          title="Options"
          wrapClassName={styles.cogMenuWrap}
          onOpenChange={setMenuOpen}
          portal
          trigger={({ toggle }) => (
            <button className={styles.cogBtn} onClick={e => { e.stopPropagation(); toggle() }} title="Options" aria-label={`Options for ${folder.name}`}>
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
            onChange={e => setRenameVal(e.target.value)} onKeyDown={handleRenameKey} maxLength={100} />
          <div className={styles.renameBtns}>
            <button className={styles.renameConfirm} onClick={e => { e.stopPropagation(); confirmRename() }}><CheckIcon size={13} /></button>
            <button className={styles.renameCancel} onClick={e => { e.stopPropagation(); setRenaming(false) }}><CloseIcon size={13} /></button>
          </div>
        </div>
      ) : (
        <div className={styles.folderName}>{folder.name}</div>
      )}
      <div className={styles.folderMeta}>
        <span>{qty} want{qty !== 1 ? 's' : ''}</span>
        <span className={styles.wishlistEstimate}>
          {value != null ? `Est. ${formatPrice(value, priceSource)}` : '—'}
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
        <button className={styles.groupCollapseBtn} onClick={() => setCollapsed(v => !v)} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${group.name}`} aria-expanded={!collapsed}>
          {collapsed ? '▸' : '▾'}
        </button>
        {renaming ? (
          <input ref={renameRef} className={styles.groupRenameInput} value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { onRenameGroup(group, renameVal.trim()); setRenaming(false) }
              if (e.key === 'Escape') setRenaming(false)
            }}
            onClick={e => e.stopPropagation()} maxLength={50} />
        ) : (
          <span className={styles.groupName}>{group.name}</span>
        )}
        <span className={styles.groupCount}>{folders.length}</span>
        <ResponsiveMenu
          title="Group Actions"
          wrapClassName={styles.groupCogWrap}
          trigger={({ toggle }) => (
            <button className={styles.groupCogBtn} onClick={e => { e.stopPropagation(); toggle() }} aria-label={`Options for ${group.name}`}><SettingsIcon size={13} /></button>
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
  const [importModalText, setImportModalText] = useState('')
  const [showExportAll, setShowExportAll]     = useState(false)
  const [exportAllCards, setExportAllCards]   = useState([])
  const [exportAllSfMap, setExportAllSfMap]   = useState({})
  const [exportAllLoading, setExportAllLoading] = useState(false)

  const openImport = () => {
    setImportModalText('')
    setShowImport(true)
  }

  const handleEmptyImportFile = async (file) => {
    setImportModalText(await file.text())
    setShowImport(true)
  }

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
          .from('list_items_view')
          .select('*')
          .in('folder_id', folderIds)
          .range(from, from + 999)
        if (page?.length) allItems = [...allItems, ...page]
        if (!page || page.length < 1000) break
        from += 1000
      }
      const folderById = new Map(folders.map(f => [f.id, f]))
      const cards = allItems.map(item => {
        const folder = folderById.get(item.folder_id)
        return { ...item, _folder_qty: item.qty, _folderName: folder?.name || '', _folderType: 'list' }
      })
      const sfMap = cards.length ? await loadCardMapWithSharedPrices(cards, { priceLookup: 'set' }) : {}
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
    await invalidateWishlistQueries(queryClient, user?.id, { includeFolders: true, includeItems: false }).catch(() => {})
  }, [user?.id])

  const computeListMeta = useCallback((foldersData, items, sfMap) => {
    const meta = {}
    for (const f of foldersData) meta[f.id] = { count: 0, totalQty: 0, value: 0 }
    for (const row of items) {
      const m = meta[row.folder_id]
      if (!m) continue
      m.count++
      m.totalQty += row.qty || 1
      const sf = sfMap[`${row.set_code}-${row.collector_number}`]
      const p  = sf ? getPrice(sf, row.foil, { price_source }) : null
      if (p != null) m.value += p * (row.qty || 1)
    }
    return meta
  }, [price_source])

  const loadFolders = useCallback(async () => {
    // Phase 0 — instant paint of the folder grid + meta from React Query cache + IDB.
    let seeded = false
    const cachedFolders = queryClient.getQueryData(['folders', user.id])
    let cachedTyped = []
    if (cachedFolders?.length) {
      cachedTyped = cachedFolders
        .filter(f => f.type === 'list')
        .slice()
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      if (cachedTyped.length) {
        setFolders(cachedTyped)
        seeded = true
      }
    }

    if (seeded) {
      // Step 1 — instantly paint last-known meta from the persisted cache so $ values
      // show up before the IDB walk + sfMap load complete.
      try {
        const persisted = await getFolderMetaCache(user.id, 'list')
        if (persisted?.meta && persisted.priceSource === price_source) {
          const seedMeta = {}
          for (const f of cachedTyped) {
            const cached = persisted.meta[f.id]
            seedMeta[f.id] = cached
              ? { count: cached.count || 0, totalQty: cached.totalQty || 0, value: cached.value ?? null }
              : { count: 0, totalQty: 0, value: null }
          }
          setFolderMeta(seedMeta)
          setLoading(false)
        }
      } catch {}

      // Step 2 — recompute from local IDB items + sfMap (Scryfall metadata cache is in-memory).
      try {
        const localItems = await getAllLocalListItemsForFolders(cachedTyped.map(f => f.id))
        if (localItems.length) {
          const sfMap = await loadCardMapWithSharedPrices(localItems, { priceLookup: 'set' }) || {}
          const recomputed = computeListMeta(cachedTyped, localItems, sfMap)
          setFolderMeta(recomputed)
          setFolderMetaCache(user.id, 'list', recomputed, price_source).catch(() => {})
        } else {
          const placeholder = {}
          for (const f of cachedTyped) placeholder[f.id] = { count: 0, totalQty: 0, value: 0 }
          setFolderMeta(placeholder)
        }
        setLoading(false)
      } catch {}
    } else {
      setLoading(true)
    }

    // Phase 1 — Supabase reconcile.
    const { data: foldersData, error: foldersError } = await sb
      .from('folders').select('*')
      .eq('user_id', user.id).eq('type', 'list').order('name')

    if (foldersError) { if (!seeded) setLoading(false); return }
    if (!foldersData?.length) { setFolders([]); setFolderMeta({}); setLoading(false); return }
    setFolders(foldersData)

    const ids = foldersData.map(f => f.id)
    let allItems = [], from = 0
    let itemsError = false
    while (true) {
      const { data: page, error } = await sb
        .from('list_items_view')
        .select('*')
        .in('folder_id', ids)
        .range(from, from + 999)
      if (error) { itemsError = true; break }
      if (page?.length) allItems = [...allItems, ...page]
      if (!page || page.length < 1000) break
      from += 1000
    }

    // Network error: keep seeded counts/values, don't overwrite with empty.
    if (itemsError) { setLoading(false); return }

    const sfMap = allItems.length ? (await loadCardMapWithSharedPrices(allItems, { priceLookup: 'set' }) || {}) : {}
    const freshMeta = computeListMeta(foldersData, allItems, sfMap)
    setFolderMeta(freshMeta)
    setLoading(false)

    // Phase 2 — Mirror fresh server items + meta into IDB.
    try { await replaceLocalListItems(ids, allItems) } catch {}
    setFolderMetaCache(user.id, 'list', freshMeta, price_source).catch(() => {})
  }, [user.id, price_source, computeListMeta])

  useEffect(() => { loadFolders() }, [loadFolders])

  // Refresh when a card acquired elsewhere auto-removes a wishlist item.
  useEffect(() => {
    const onWishlistUpdated = () => loadFolders()
    window.addEventListener('av:wishlist-updated', onWishlistUpdated)
    return () => window.removeEventListener('av:wishlist-updated', onWishlistUpdated)
  }, [loadFolders])

  const invalidateListIndexCaches = useCallback((options = {}) => (
    invalidateWishlistQueries(queryClient, user?.id, { includeFolders: true, ...options }).catch(() => {})
  ), [user?.id])

  const deleteFolder = async (folder) => {
    await sb.from('list_items').delete().eq('folder_id', folder.id)
    await sb.from('folders').delete().eq('id', folder.id)
    setFolders(prev => prev.filter(f => f.id !== folder.id))
    try { await replaceLocalListItems([folder.id], []) } catch {}
    await invalidateListIndexCaches()
  }

  const renameFolder = useCallback(async (folder, newName) => {
    await sb.from('folders').update({ name: newName }).eq('id', folder.id)
    setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, name: newName } : f))
    await invalidateListIndexCaches({ includeItems: false })
  }, [invalidateListIndexCaches])

  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()) }

  const handleBulkDelete = () => trackActivity(async () => {
    const selected = folders.filter(f => selectedIds.has(f.id) && !isGroupFolder(f))
    await Promise.all(selected.map(async f => {
      await sb.from('list_items').delete().eq('folder_id', f.id)
      await sb.from('folders').delete().eq('id', f.id)
    }))
    try { await replaceLocalListItems(selected.map(f => f.id), []) } catch {}
    setFolders(prev => prev.filter(f => !selectedIds.has(f.id)))
    setSelectedIds(new Set())
    setSelectMode(false)
    await invalidateListIndexCaches()
  })

  const bulkMoveToGroup = async (groupId) => {
    const selected = folders.filter(f => selectedIds.has(f.id) && !isGroupFolder(f))
    for (const folder of selected) {
      const newDesc = setFolderDescKey(folder.description, 'groupId', groupId || null)
      await sb.from('folders').update({ description: newDesc }).eq('id', folder.id)
      setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, description: newDesc } : f))
    }
    await invalidateListIndexCaches({ includeItems: false })
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
    await invalidateListIndexCaches({ includeItems: false })
  }

  const createFolder = async () => {
    if (!newFolderName.trim()) return
    const { data } = await sb.from('folders').insert({
      user_id: user.id, type: 'list', name: newFolderName.trim(),
    }).select().single()
    if (data) { setFolders(prev => [...prev, data]); setShowNewFolder(false); setNewFolderName('') }
    await invalidateListIndexCaches({ includeItems: false })
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
    await invalidateListIndexCaches({ includeItems: false })
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
    await invalidateListIndexCaches({ includeItems: false })
  }

  const moveToGroup = async (folder, groupId) => {
    const newDesc = setFolderDescKey(folder.description, 'groupId', groupId || null)
    await sb.from('folders').update({ description: newDesc }).eq('id', folder.id)
    setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, description: newDesc } : f))
    await invalidateListIndexCaches({ includeItems: false })
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
        action={folders.length > 0 ? (
          <ResponsiveHeaderActions
            primary={!selectMode ? (
              <Button size="sm" onClick={() => setShowNewFolder(true)} title="New wishlist" aria-label="New wishlist">
                <AddIcon size={14} />
                <span>New Wishlist</span>
              </Button>
            ) : null}
            menuLabel="Wishlist actions"
            mobileToolbar
          >
            <div className={styles.headerActions}>
              {selectMode ? (
                <>
                <Button variant="ghost" size="sm" onClick={exitSelectMode} title="Cancel selection" aria-label="Cancel selection">
                  <RemoveIcon size={14} />
                  <span>Cancel</span>
                </Button>
                {groups.length > 0 && (
                  <Button variant="secondary" size="sm" disabled={selectedIds.size === 0}
                    onClick={() => setShowBulkMoveGroup(true)}
                    title="Move to group"
                    aria-label="Move to group">
                    <BinderIcon size={14} />
                    <span>Group ({selectedIds.size})</span>
                  </Button>
                )}
                <Button variant="danger" size="sm" disabled={selectedIds.size === 0}
                  onClick={handleBulkDelete}>
                  <DeleteIcon size={12} />
                  <span>Delete ({selectedIds.size})</span>
                </Button>
                </>
              ) : (
                <>
                {/* Browse action, not the page CTA — secondary so the gold
                    stays reserved for New Wishlist (incl. the mobile pill bar) */}
                <Button variant="secondary" size="sm" className={styles.viewAllBtn} onClick={() => setShowAllCards(true)} title="View all cards" aria-label="View all cards">
                  <CollectionIcon size={14} />
                  <span>All Cards</span>
                </Button>
                <SearchInput
                  className={styles.folderSearch}
                  wrapClassName={styles.desktopOnlySearch}
                  wrapStyle={{ flex: '0 1 auto', minWidth: 200, maxWidth: 280 }}
                  value={folderSearch}
                  onChange={e => setFolderSearch(e.target.value)}
                  onClear={() => setFolderSearch('')}
                  placeholder="Search wishlists…"
                />
                <div className={styles.desktopOnlyAction}>
                  <SortDropdown value={sort} onChange={handleSortChange} options={SORT_OPTIONS} compact />
                </div>
                <ResponsiveMenu
                  title="Wishlist Actions"
                  portal
                  trigger={({ toggle }) => (
                    <Button variant="ghost" size="sm" onClick={toggle} title="More actions" aria-label="More wishlist actions">
                      <SettingsIcon size={14} /> <span>More</span>
                    </Button>
                  )}
                >
                  {({ close }) => (
                    <div className={uiStyles.responsiveMenuList}>
                      <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowNewGroup(true); close() }}>
                        <span><StacksViewIcon size={14} /> New Group</span>
                      </button>
                      <button className={uiStyles.responsiveMenuAction} onClick={() => { openImport(); close() }}>
                        <span><ImportIcon size={14} /> Import</span>
                      </button>
                      <button className={uiStyles.responsiveMenuAction} onClick={() => { handleExportAll(); close() }}>
                        <span><ExportIcon size={14} /> Export</span>
                      </button>
                      <button className={uiStyles.responsiveMenuAction} onClick={() => { setSelectMode(true); close() }}>
                        <span><CheckIcon size={14} /> Select</span>
                      </button>
                    </div>
                  )}
                </ResponsiveMenu>
                </>
              )}
            </div>
          </ResponsiveHeaderActions>
        ) : null}
      />
      {!selectMode && folders.length > 0 && (
        <div className={styles.overviewStickySearch}>
          <SearchInput
            className={styles.folderSearch}
            leadingIcon={<SearchIcon size={14} />}
            value={folderSearch}
            onChange={e => setFolderSearch(e.target.value)}
            onClear={() => setFolderSearch('')}
            placeholder="Search wishlists..."
          />
        </div>
      )}

      {folders.length === 0 && (
        <LibraryEmptyState
          icon={<WishlistsIcon size={34} />}
          title="Save cards for later"
          description="Wishlists track cards you want without adding them to your owned collection. Create one manually or import an existing list."
          importFirst={false}
          manualAction={{
            label: 'Create your first wishlist',
            icon: <AddIcon size={14} />,
            onClick: () => setShowNewFolder(true),
          }}
          importAction={{
            label: 'Import a wishlist',
            description: 'Drop a .csv or .txt list here, or click to paste or upload.',
            onClick: openImport,
            onFile: handleEmptyImportFile,
          }}
          footer="Wishlist cards do not count toward collection totals or values."
        />
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
          <div className={styles.modalInlineForm}>
            <input autoFocus className={styles.newGroupInput} value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newGroupName.trim()) {
                  createGroup(newGroupName); setShowNewGroup(false); setNewGroupName('')
                }
                if (e.key === 'Escape') setShowNewGroup(false)
              }}
              placeholder="Group name…" maxLength={50} />
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
                <CloseIcon size={11} /> Remove from group
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
              <CloseIcon size={11} /> Remove from group
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
          <div className={styles.modalInlineForm}>
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
          initialText={importModalText || undefined}
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

