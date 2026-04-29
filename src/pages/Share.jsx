import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { CardGrid, CardDetail, FilterBar, applyFilterSort } from '../components/CardComponents'
import { EmptyState, ProgressBar } from '../components/UI'
import BRAND_MARK from '../icons/DeckLoom_logo.png'
import styles from './Share.module.css'

export default function SharePage() {
  const { token } = useParams()
  const { user, loading: authLoading } = useAuth()
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
    if (authLoading) return
    const load = async () => {
      // Step 1: resolve token → folder_id (flat query, no nested join)
      const { data: shared } = await sb
        .from('shared_folders')
        .select('folder_id')
        .eq('public_token', token)
        .maybeSingle()
      if (!shared) { setNotFound(true); setLoading(false); return }

      // Step 2: get folder metadata separately
      const { data: folderData } = await sb
        .from('folders')
        .select('id, name, type')
        .eq('id', shared.folder_id)
        .maybeSingle()
      if (!folderData) { setNotFound(true); setLoading(false); return }
      setFolder(folderData)

      // Step 3: get folder_cards (flat, no nested join)
      const { data: fc } = await sb
        .from('folder_cards')
        .select('card_id, qty')
        .eq('folder_id', shared.folder_id)

      if (fc?.length) {
        const cardIds = fc.map(r => r.card_id)
        // Step 4: get cards separately
        const { data: cardsData } = await sb
          .from('cards')
          .select('*')
          .in('id', cardIds)

        if (cardsData?.length) {
          const qtyMap = Object.fromEntries(fc.map(r => [r.card_id, r.qty]))
          const c = cardsData.map(card => ({ ...card, _folder_qty: qtyMap[card.id] ?? 1 }))
          setCards(c)
          setEnriching(true)
          const map = await loadCardMapWithSharedPrices(c)
          setSfMap(map)
          setEnriching(false)
        }
      }
      setLoading(false)
    }
    load()
  }, [token, authLoading])

  if (authLoading || loading) return (
    <div className={styles.screen}>
      <div className={styles.loading}>Loading…</div>
    </div>
  )

  // Unauthenticated: prompt sign-in instead of cryptic "not found"
  if (!user) return (
    <div className={styles.screen}>
      <div className={styles.logo}>
        <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
        <span className={styles.logoText}>Deck<span>Loom</span></span>
      </div>
      <div className={styles.loginPrompt}>
        <p className={styles.loginMsg}>Sign in to view this shared collection.</p>
        <a href="/login" className={styles.loginBtn}>Sign In to DeckLoom</a>
      </div>
    </div>
  )

  if (notFound) return (
    <div className={styles.screen}>
      <div className={styles.logo}>
        <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
        <span className={styles.logoText}>Deck<span>Loom</span></span>
      </div>
      <EmptyState>This link is invalid or has been removed.</EmptyState>
    </div>
  )

  const filtered = applyFilterSort(cards, sfMap, search, sort, foil)
  const selectedCard = selected ? cards.find(c => c.id === selected) : null
  const selectedSf = selectedCard ? sfMap[`${selectedCard.set_code}-${selectedCard.collector_number}`] : null

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
          <span className={styles.logoText}>Deck<span>Loom</span></span>
        </div>
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
        {filtered.length === 0 && !enriching && <EmptyState>No cards found.</EmptyState>}
        {selectedCard && <CardDetail card={selectedCard} sfCard={selectedSf} readOnly onClose={() => setSelected(null)} />}
      </main>
    </div>
  )
}
