import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { enrichCards, getInstantCache, getScryfallKey, getPrice, getPriceSource, formatPrice } from '../lib/scryfall'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { CardGrid, CardDetail, FilterBar, applyFilterSort, EMPTY_FILTERS } from '../components/CardComponents'
import { EmptyState, SectionHeader, Button, Modal } from '../components/UI'
import DeckBrowser from './DeckBrowser'
import styles from './Folders.module.css'

// ── Folder background art (localStorage) ─────────────────────────────────────
const BG_KEY = 'arcanevault_folder_bg'
function getFolderBgs() {
  try { return JSON.parse(localStorage.getItem(BG_KEY) || '{}') } catch { return {} }
}
function setFolderBg(folderId, url) {
  const m = getFolderBgs()
  if (!url) delete m[folderId]
  else m[folderId] = url
  localStorage.setItem(BG_KEY, JSON.stringify(m))
}

// ── Art picker: search Scryfall for art_crop ──────────────────────────────────
function CardArtPicker({ onSelect, onClose }) {
  const [query, setQuery] = useState('')
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
              onClick={() => onSelect(card.image_uris.art_crop, card.name)}
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

// ── FolderCard ────────────────────────────────────────────────────────────────
function FolderCard({ folder, meta, priceSource, displayCurrency, onClick, onDelete, onEditBg }) {
  const value   = meta?.value
  const qty     = meta?.totalQty ?? meta?.count ?? 0
  const bgUrl   = getFolderBgs()[folder.id]

  return (
    <div className={styles.folderCard}
      style={bgUrl ? {
        backgroundImage: `linear-gradient(rgba(10,10,18,0.55) 0%, rgba(10,10,18,0.80) 100%), url(${bgUrl})`,
        backgroundSize: 'cover', backgroundPosition: 'center top',
      } : undefined}
      onClick={onClick}>
      <button className={styles.delBtn} onClick={e => { e.stopPropagation(); onDelete() }} title="Delete">🗑</button>
      <button className={styles.bgBtn} onClick={e => { e.stopPropagation(); onEditBg() }} title="Set background art">🖼</button>
      <div className={styles.folderName}>{folder.name}</div>
      <div className={styles.folderMeta}>
        <span>{qty} card{qty !== 1 ? 's' : ''}</span>
        <span style={{ color: value != null ? 'var(--green)' : 'var(--text-faint)' }}>
          {value != null ? formatPrice(value, priceSource, displayCurrency) : '—'}
        </span>
      </div>
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
  const [filters, setFilters]   = useState({ ...EMPTY_FILTERS })

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const { data } = await sb
        .from('folder_cards')
        .select('qty, cards(*)')
        .eq('folder_id', folder.id)
      if (data) {
        const cardList = data.map(row => ({ ...row.cards, _folder_qty: row.qty }))
        setCards(cardList)
        const map = await enrichCards(cardList, null)
        if (map) setSfMap({ ...map })
      }
      setLoading(false)
    }
    load()
  }, [folder.id])

  const filtered = useMemo(
    () => applyFilterSort(cards, sfMap, search, sort, filters),
    [cards, sfMap, search, sort, filters]
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
      <FilterBar search={search} setSearch={setSearch} sort={sort} setSort={setSort} filters={filters} setFilters={setFilters} />
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

// ── DeleteDeckModal ───────────────────────────────────────────────────────────
function DeleteDeckModal({ folder, onDone, onCancel }) {
  const [mode, setMode]     = useState(null)   // 'binder' | 'deck' | 'delete'
  const [targetId, setTargetId] = useState('')
  const [allFolders, setAllFolders] = useState([])
  const [busy, setBusy]     = useState(false)
  const [loaded, setLoaded] = useState(false)

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

  const handleConfirm = async () => {
    setBusy(true)
    if (mode === 'binder' || mode === 'deck') {
      // Transfer cards to target folder
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
      // Delete the cards from the collection entirely
      const { data: fc } = await sb.from('folder_cards').select('card_id').eq('folder_id', folder.id)
      const ids = (fc || []).map(r => r.card_id)
      if (ids.length) await sb.from('cards').delete().in('id', ids)
    }
    await sb.from('folders').delete().eq('id', folder.id)
    onDone()
  }

  const opts = [
    { key: 'binder', icon: '📁', label: 'Transfer to a binder', desc: 'Move all cards into an existing binder' },
    { key: 'deck',   icon: '🃏', label: 'Transfer to another deck', desc: 'Move all cards into another deck' },
    { key: 'delete', icon: '🗑', label: 'Delete the cards', desc: 'Remove these cards from your collection permanently' },
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
                onClick={() => { setMode(o.key); setTargetId('') }}>
                <span className={styles.deleteModeIcon}>{o.icon}</span>
                <span>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{o.label}</div>
                  <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>{o.desc}</div>
                </span>
              </button>
            ))}
          </div>

          {(mode === 'binder' || mode === 'deck') && (
            <select className={styles.deleteTargetSelect}
              value={targetId} onChange={e => setTargetId(e.target.value)}>
              <option value="">— Select {mode} —</option>
              {targets.length === 0
                ? <option disabled>No {mode}s available</option>
                : targets.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
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

// ── Main page ─────────────────────────────────────────────────────────────────
export default function FoldersPage({ type }) {
  const { user } = useAuth()
  const { price_source, display_currency, default_sort } = useSettings()
  const [searchParams, setSearchParams] = useSearchParams()
  const [folders, setFolders]           = useState([])
  const [folderMeta, setFolderMeta]     = useState({})
  const [sort, setSort]                 = useState(default_sort || 'name')
  const [loading, setLoading]           = useState(true)
  const [activeFolder, setActiveFolder]   = useState(null)
  const [deleteTarget, setDeleteTarget]   = useState(null)
  const [shareFolder, setShareFolder]     = useState(null)
  const [bgTarget, setBgTarget]           = useState(null)   // folder for art picker
  const [, forceUpdate]                   = useState(0)      // triggers re-render after bg save

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
        const p  = getPrice(sf, card.foil, { price_source })
        if (p != null) m.value += p * (row.qty || 1)
      }
    }

    setFolderMeta(meta)
    setLoading(false)
  }, [user.id, type, price_source])

  useEffect(() => { loadFolders() }, [loadFolders])

  // Auto-open folder from URL param (e.g. ?folder=uuid)
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

  const handleDeleteClick = (folder) => {
    if (type === 'deck') {
      setDeleteTarget(folder)
    } else {
      deleteFolder(folder.id)
    }
  }

  const sortedFolders = useMemo(
    () => sortFolders(folders, folderMeta, sort),
    [folders, folderMeta, sort]
  )

  if (activeFolder) {
    if (type === 'deck') return (
      <DeckBrowser folder={activeFolder} onBack={() => { setActiveFolder(null); loadFolders() }} />
    )
    return (
      <FolderBrowser folder={activeFolder} onBack={() => { setActiveFolder(null); loadFolders() }} />
    )
  }

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
            onDelete={() => handleDeleteClick(folder)}
            onEditBg={() => setBgTarget(folder)}
          />
        ))}
      </div>

      {deleteTarget && (
        <DeleteDeckModal
          folder={deleteTarget}
          onDone={() => { setFolders(prev => prev.filter(f => f.id !== deleteTarget.id)); setDeleteTarget(null) }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {shareFolder && <ShareModal folder={shareFolder} onClose={() => setShareFolder(null)} />}
      {bgTarget && (
        <CardArtPicker
          onSelect={(url) => {
            setFolderBg(bgTarget.id, url)
            setBgTarget(null)
            forceUpdate(n => n + 1)
          }}
          onClose={() => setBgTarget(null)}
        />
      )}
    </div>
  )
}
