import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { getInstantCache, getScryfallKey, getPrice, getPriceSource, formatPrice } from '../lib/scryfall'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { CardGrid, CardDetail, FilterBar, applyFilterSort } from '../components/CardComponents'
import { EmptyState, SectionHeader, Button, Modal } from '../components/UI'
import styles from './Folders.module.css'

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

// ── FolderCard ────────────────────────────────────────────────────────────────
function FolderCard({ folder, meta, priceSource, displayCurrency, onClick, onDelete, onShare }) {
  const value = meta?.value
  const qty   = meta?.totalQty ?? meta?.count ?? 0

  return (
    <div className={styles.folderCard} onClick={onClick}>
      <button className={styles.delBtn} onClick={e => { e.stopPropagation(); onDelete() }}>✕</button>
      <div className={styles.folderName}>{folder.name}</div>
      <div className={styles.folderMeta}>
        <span>{qty} card{qty !== 1 ? 's' : ''}</span>
        <span style={{ color: value != null ? 'var(--green)' : 'var(--text-faint)' }}>
          {value != null ? formatPrice(value, priceSource, displayCurrency) : '—'}
        </span>
      </div>
      <button className={styles.shareBtn} onClick={e => { e.stopPropagation(); onShare() }} title="Share">⬡</button>
    </div>
  )
}

// ── FolderBrowser ─────────────────────────────────────────────────────────────
function FolderBrowser({ folder, onBack }) {
  const { price_source, display_currency, default_sort } = useSettings()
  const [cards, setCards]       = useState([])
  const [sfMap, setSfMap]       = useState({})
  const [loading, setLoading]   = useState(true)
  const [selected, setSelected] = useState(null)
  const [search, setSearch]     = useState('')
  const [sort, setSort]         = useState(default_sort || 'name')
  const [foil, setFoil]         = useState('all')

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const { data } = await sb
        .from('folder_cards')
        .select('qty, cards(*)')
        .eq('folder_id', folder.id)
      if (data) {
        setCards(data.map(row => ({ ...row.cards, _folder_qty: row.qty })))
        const cached = getInstantCache()
        if (cached) setSfMap(cached)
      }
      setLoading(false)
    }
    load()
  }, [folder.id])

  const filtered = useMemo(
    () => applyFilterSort(cards, sfMap, search, sort, foil),
    [cards, sfMap, search, sort, foil]
  )

  const { totalValue, totalQty } = useMemo(() => {
    let v = 0, q = 0
    for (const c of cards) {
      const p   = getPrice(sfMap[getScryfallKey(c)], c.foil, { price_source })
      const qty = c._folder_qty || c.qty
      if (p != null) v += p * qty
      q += qty
    }
    return { totalValue: v, totalQty: q }
  }, [cards, sfMap, price_source])

  const selectedCard = selected ? cards.find(c => c.id === selected) : null
  const selectedSf   = selectedCard ? sfMap[getScryfallKey(selectedCard)] : null

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
      <FilterBar search={search} setSearch={setSearch} sort={sort} setSort={setSort} foil={foil} setFoil={setFoil} />
      <div className={styles.gridHeader}>
        <span>Showing {filtered.length} of {cards.length} unique · {totalQty} total</span>
        <span>Value: <strong style={{ color: 'var(--green)' }}>{formatPrice(totalValue, price_source, display_currency)}</strong></span>
      </div>
      <CardGrid cards={filtered} sfMap={sfMap} onSelect={c => setSelected(c.id)} />
      {filtered.length === 0 && <EmptyState>No cards match your search.</EmptyState>}
      {selectedCard && <CardDetail card={selectedCard} sfCard={selectedSf} priceSource={price_source} displayCurrency={display_currency} onClose={() => setSelected(null)} />}
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

  const url = token ? `${window.location.origin}/share/${token}` : ''

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

// ── Main page ─────────────────────────────────────────────────────────────────
export default function FoldersPage({ type }) {
  const { user } = useAuth()
  const { price_source, display_currency, default_sort } = useSettings()
  const [folders, setFolders]           = useState([])
  const [folderMeta, setFolderMeta]     = useState({})
  const [sort, setSort]                 = useState(default_sort || 'name')
  const [loading, setLoading]           = useState(true)
  const [activeFolder, setActiveFolder] = useState(null)
  const [shareFolder, setShareFolder]   = useState(null)

  const noun = type === 'deck' ? 'Deck' : type === 'list' ? 'List' : 'Binder'

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

    const sfMap = getInstantCache() || {}
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
        const p  = getPrice(sf, card.foil, { price_source })
        if (p != null) m.value += p * (row.qty || 1)
      }
    }

    setFolderMeta(meta)
    setLoading(false)
  }, [user.id, type, price_source])

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
    <FolderBrowser folder={activeFolder} onBack={() => { setActiveFolder(null); loadFolders() }} />
  )

  if (loading) return <EmptyState>Loading {noun.toLowerCase()}s…</EmptyState>

  return (
    <div>
      <SectionHeader
        title={`${noun}s`}
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
        <EmptyState>No {noun.toLowerCase()}s yet. Import your collection CSV from the Collection tab to populate them.</EmptyState>
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
            onShare={() => setShareFolder(folder)}
          />
        ))}
      </div>

      {shareFolder && <ShareModal folder={shareFolder} onClose={() => setShareFolder(null)} />}
    </div>
  )
}
