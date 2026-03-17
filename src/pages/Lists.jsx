import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { enrichCards, getInstantCache, getPrice, getPriceSource, formatPrice } from '../lib/scryfall'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { EmptyState, SectionHeader, Button, Modal } from '../components/UI'
import styles from './Folders.module.css'
import listStyles from './Lists.module.css'

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

// ── ListCard (wishlist item) ──────────────────────────────────────────────────
function WishlistItem({ item, sfCard, priceSource, displayCurrency, onDelete }) {
  const price = getPrice(sfCard, item.foil, { price_source: priceSource })
  const img = sfCard?.image_uris?.small

  return (
    <div className={listStyles.item}>
      {img && <img className={listStyles.itemImg} src={img} alt={item.name} loading="lazy" />}
      <div className={listStyles.itemBody}>
        <div className={listStyles.itemName}>
          {item.name}
          {item.foil && <span style={{ color: '#c8a0ff', fontSize: '0.65rem', marginLeft: 4 }}>✦ Foil</span>}
        </div>
        <div className={listStyles.itemMeta}>
          <span className={listStyles.itemSet}>{(item.set_code || '').toUpperCase()} #{item.collector_number}</span>
          <span className={listStyles.itemPrice} style={{ color: price != null ? 'var(--green)' : 'var(--text-faint)' }}>
            {price != null ? formatPrice(price, priceSource, displayCurrency) : '—'}
          </span>
        </div>
        {item.qty > 1 && <div className={listStyles.itemQty}>×{item.qty}</div>}
      </div>
      <button className={listStyles.itemDelete} onClick={() => onDelete(item.id)}>✕</button>
    </div>
  )
}

// ── List browser (inside a list folder) ──────────────────────────────────────
function ListBrowser({ folder, onBack }) {
  const { price_source, display_currency } = useSettings()
  const [items, setItems]       = useState([])
  const [sfMap, setSfMap]       = useState({})
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const { data } = await sb.from('list_items').select('*').eq('folder_id', folder.id).order('name')
      if (data) {
        setItems(data)
        const map = await enrichCards(data, null)
        if (map) setSfMap({ ...map })
      }
      setLoading(false)
    }
    load()
  }, [folder.id])

  const filtered = useMemo(() => {
    if (!search) return items
    const q = search.toLowerCase()
    return items.filter(i => i.name.toLowerCase().includes(q) || (i.set_code || '').toLowerCase().includes(q))
  }, [items, search])

  const { totalValue, totalQty } = useMemo(() => {
    let v = 0, q = 0
    for (const item of items) {
      const sf = sfMap[`${item.set_code}-${item.collector_number}`]
      const p  = getPrice(sf, item.foil, { price_source })
      if (p != null) v += p * item.qty
      q += item.qty
    }
    return { totalValue: v, totalQty: q }
  }, [items, sfMap, price_source])

  const handleDelete = async (id) => {
    await sb.from('list_items').delete().eq('id', id)
    setItems(prev => prev.filter(i => i.id !== id))
  }

  if (loading) return <EmptyState>Loading…</EmptyState>

  return (
    <div>
      <button className={styles.backBtn} onClick={onBack}>← Back</button>
      <SectionHeader
        title={folder.name}
        action={
          <span style={{ color: 'var(--text-dim)', fontSize: '0.82rem' }}>
            {totalQty} cards · <strong style={{ color: 'var(--green)' }}>{formatPrice(totalValue, price_source, display_currency)}</strong>
          </span>
        }
      />
      <div className={listStyles.searchWrap}>
        <input
          className={listStyles.search}
          placeholder="Search cards…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <span style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>
          {filtered.length} of {items.length} cards
        </span>
      </div>
      {filtered.length === 0 && <EmptyState>No cards match.</EmptyState>}
      <div className={listStyles.list}>
        {filtered.map(item => (
          <WishlistItem
            key={item.id}
            item={item}
            sfCard={sfMap[`${item.set_code}-${item.collector_number}`]}
            priceSource={price_source}
            displayCurrency={display_currency}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  )
}

// ── Folder card ───────────────────────────────────────────────────────────────
function FolderCard({ folder, meta, priceSource, displayCurrency, onClick, onDelete }) {
  const value = meta?.value
  const qty   = meta?.totalQty ?? 0

  return (
    <div className={styles.folderCard} onClick={onClick}>
      <button className={styles.delBtn} onClick={e => { e.stopPropagation(); onDelete() }}>✕</button>
      <div className={styles.folderName}>{folder.name}</div>
      <div className={styles.folderMeta}>
        <span>{qty} want{qty !== 1 ? 's' : ''}</span>
        <span style={{ color: value != null ? 'var(--green)' : 'var(--text-faint)' }}>
          {value != null ? formatPrice(value, priceSource, displayCurrency) : '—'}
        </span>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ListsPage() {
  const { user } = useAuth()
  const { price_source, display_currency, default_sort } = useSettings()
  const [folders, setFolders]           = useState([])
  const [folderMeta, setFolderMeta]     = useState({})
  const [sort, setSort]                 = useState(default_sort || 'name')
  const [loading, setLoading]           = useState(true)
  const [activeFolder, setActiveFolder] = useState(null)

  const loadFolders = useCallback(async () => {
    setLoading(true)
    const { data: foldersData } = await sb
      .from('folders').select('*')
      .eq('user_id', user.id).eq('type', 'list').order('name')

    if (!foldersData?.length) { setFolders([]); setFolderMeta({}); setLoading(false); return }
    setFolders(foldersData)

    // Load all list_items for all folders in one paginated query
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

  const deleteFolder = async (id) => {
    await sb.from('folders').delete().eq('id', id)
    setFolders(prev => prev.filter(f => f.id !== id))
  }

  const sortedFolders = useMemo(
    () => sortFolders(folders, folderMeta, sort),
    [folders, folderMeta, sort]
  )

  if (activeFolder) return (
    <ListBrowser folder={activeFolder} onBack={() => { setActiveFolder(null); loadFolders() }} />
  )

  if (loading) return <EmptyState>Loading wishlists…</EmptyState>

  return (
    <div>
      <SectionHeader
        title="Wishlists"
        action={
          <select
            value={sort} onChange={e => setSort(e.target.value)}
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', color: 'var(--text)', fontSize: '0.82rem', cursor: 'pointer' }}
          >
            {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        }
      />

      {folders.length === 0 && (
        <EmptyState>No wishlists yet. Lists from your Manabox CSV will appear here after import.</EmptyState>
      )}

      <div className={styles.folderGrid}>
        {sortedFolders.map(folder => (
          <FolderCard
            key={folder.id}
            folder={folder}
            meta={folderMeta[folder.id]}
            priceSource={price_source}
            displayCurrency={display_currency}
            onClick={() => setActiveFolder(folder)}
            onDelete={() => deleteFolder(folder.id)}
          />
        ))}
      </div>
    </div>
  )
}
