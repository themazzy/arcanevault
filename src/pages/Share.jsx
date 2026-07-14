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
    if (authLoading || !user) return
    const load = async () => {
      const { data: shared } = await sb
        .from('shared_folders')
        .select('folder_id')
        .eq('public_token', token)
        .maybeSingle()
      if (!shared) { setNotFound(true); setLoading(false); return }

      const { data: folderData } = await sb
        .from('folders')
        .select('id, name, type')
        .eq('id', shared.folder_id)
        .maybeSingle()
      if (!folderData) { setNotFound(true); setLoading(false); return }
      setFolder(folderData)

      if (folderData.type === 'list') {
        // Collaborative wishlist sharing was retired in favour of per-user
        // Trade Posts (/trade/:username). A list token no longer renders here.
        setLoading(false)
        return
      }

      // Binder / deck: owned cards via folder_cards.
      const { data: fc } = await sb.from('folder_cards').select('card_id, qty').eq('folder_id', shared.folder_id)
      if (fc?.length) {
        const cardIds = fc.map(r => r.card_id)
        const { data: cardsData } = await sb.from('owned_cards_view').select('*').in('id', cardIds)
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
  }, [token, authLoading, user])

  if (authLoading || loading) return (
    <div className={styles.screen}><div className={styles.loading}>Loading…</div></div>
  )

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

  const isWishlist = folder?.type === 'list'

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
          <span className={styles.logoText}>Deck<span>Loom</span></span>
        </div>
        <div className={styles.folderInfo}>
          <div className={styles.folderName}>{folder?.name}</div>
          <div className={styles.folderType}>{isWishlist ? 'wishlist' : folder?.type}</div>
        </div>
        <div className={styles.readOnly}>{isWishlist ? 'Mark items as bought' : 'Read-only view'}</div>
      </header>

      <main className={styles.main}>
        {isWishlist ? (
          <EmptyState>
            Wishlist sharing has moved. Ask {folder?.name ? 'the owner' : 'them'} for their
            trade post link (deckloom.app/trade/…) to see what they’re trading.
          </EmptyState>
        ) : (
          <BinderView
            cards={cards} sfMap={sfMap} enriching={enriching}
            search={search} setSearch={setSearch} sort={sort} setSort={setSort}
            foil={foil} setFoil={setFoil} selected={selected} setSelected={setSelected}
          />
        )}
      </main>
    </div>
  )
}


function BinderView({ cards, sfMap, enriching, search, setSearch, sort, setSort, foil, setFoil, selected, setSelected }) {
  const filtered = applyFilterSort(cards, sfMap, search, sort, foil)
  const selectedCard = selected ? cards.find(c => c.id === selected) : null
  const selectedSf = selectedCard ? sfMap[`${selectedCard.set_code}-${selectedCard.collector_number}`] : null
  return (
    <>
      <FilterBar search={search} setSearch={setSearch} sort={sort} setSort={setSort} foil={foil} setFoil={setFoil} />
      {enriching && <ProgressBar value={60} label="Loading prices…" />}
      <div className={styles.count}>{filtered.length} cards</div>
      <CardGrid cards={filtered} sfMap={sfMap} loading={enriching} onSelect={c => setSelected(c.id)} />
      {filtered.length === 0 && !enriching && <EmptyState>No cards found.</EmptyState>}
      {selectedCard && <CardDetail card={selectedCard} sfCard={selectedSf} readOnly onClose={() => setSelected(null)} />}
    </>
  )
}
