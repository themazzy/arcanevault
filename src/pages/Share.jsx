import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { enrichCards } from '../lib/scryfall'
import { CardGrid, CardDetail, FilterBar, applyFilterSort } from '../components/CardComponents'
import { EmptyState, ProgressBar } from '../components/UI'
import styles from './Share.module.css'

export default function SharePage() {
  const { token } = useParams()
  const [folder, setFolder] = useState(null)
  const [cards, setCards] = useState([])
  const [sfMap, setSfMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [enriching, setEnriching] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('name')
  const [foil, setFoil] = useState('all')
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    const load = async () => {
      const { data: shared } = await sb
        .from('shared_folders')
        .select('folder_id, folders(id, name, type)')
        .eq('public_token', token)
        .maybeSingle()

      if (!shared) { setNotFound(true); setLoading(false); return }

      const f = shared.folders
      setFolder(f)

      const { data: fc } = await sb
        .from('folder_cards')
        .select('qty, cards(*)')
        .eq('folder_id', f.id)

      if (fc?.length) {
        const c = fc.map(row => ({ ...row.cards, _folder_qty: row.qty }))
        setCards(c)
        setEnriching(true)
        const map = await enrichCards(c, () => {})
        setSfMap(map); setEnriching(false)
      }
      setLoading(false)
    }
    load()
  }, [token])

  const filtered = applyFilterSort(cards, sfMap, search, sort, foil)
  const selectedCard = selected ? cards.find(c => c.id === selected) : null
  const selectedSf = selectedCard ? sfMap[`${selectedCard.set_code}-${selectedCard.collector_number}`] : null

  if (loading) return (
    <div className={styles.screen}>
      <div className={styles.loading}>Loading…</div>
    </div>
  )

  if (notFound) return (
    <div className={styles.screen}>
      <div className={styles.logo}>ARCANE<span>VAULT</span></div>
      <EmptyState>This link is invalid or has been removed.</EmptyState>
    </div>
  )

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.logo}>ARCANE<span>VAULT</span></div>
        <div className={styles.folderInfo}>
          <div className={styles.folderName}>{folder?.name}</div>
          <div className={styles.folderType}>{folder?.type}</div>
        </div>
        <div className={styles.readOnly}>Read-only view</div>
      </header>
      <main className={styles.main}>
        <FilterBar search={search} setSearch={setSearch} sort={sort} setSort={setSort} foil={foil} setFoil={setFoil} />
        {enriching && <ProgressBar value={60} label="Loading prices…" />}
        <div className={styles.count}>{filtered.length} cards</div>
        <CardGrid cards={filtered} sfMap={sfMap} loading={enriching} onSelect={c => setSelected(c.id)} />
        {filtered.length === 0 && <EmptyState>No cards found.</EmptyState>}
        {selectedCard && <CardDetail card={selectedCard} sfCard={selectedSf} onClose={() => setSelected(null)} />}
      </main>
    </div>
  )
}
