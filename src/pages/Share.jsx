import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { getPrice, formatPrice } from '../lib/scryfall'
import { useSettings } from '../components/SettingsContext'
import { CardGrid, CardDetail, FilterBar, applyFilterSort } from '../components/CardComponents'
import { EmptyState, ProgressBar } from '../components/UI'
import { CheckIcon } from '../icons'
import BRAND_MARK from '../icons/DeckLoom_logo.png'
import styles from './Share.module.css'

export default function SharePage() {
  const { token } = useParams()
  const { user, loading: authLoading } = useAuth()
  const { price_source } = useSettings()
  const [folder, setFolder] = useState(null)
  const [cards, setCards] = useState([])
  const [wishlist, setWishlist] = useState(null) // null until loaded; array for list folders
  const [sfMap, setSfMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [enriching, setEnriching] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [claimBusy, setClaimBusy] = useState(null)
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
        // Wishlist: items + per-viewer claim flags come from the RPC (the
        // owner is shown no claim state by design).
        const { data: items, error } = await sb.rpc('get_shared_wishlist', { p_token: token })
        if (error) { setNotFound(true); setLoading(false); return }
        const rows = items || []
        setWishlist(rows)
        setLoading(false)
        if (rows.length) {
          setEnriching(true)
          const map = await loadCardMapWithSharedPrices(rows.map(r => ({
            set_code: r.set_code, collector_number: r.collector_number, scryfall_id: r.scryfall_id, foil: r.foil,
          })))
          setSfMap(map || {})
          setEnriching(false)
        }
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

  const toggleClaim = async (item) => {
    if (claimBusy) return
    setClaimBusy(item.id)
    const next = !item.claimed_by_me
    // Optimistic update.
    setWishlist(prev => prev.map(r => r.id === item.id
      ? { ...r, claimed_by_me: next, is_claimed: next } : r))
    try {
      const { data, error } = await sb.rpc('toggle_wishlist_claim', {
        p_token: token, p_item_id: item.id, p_claimed: next,
      })
      if (error) throw error
      const result = Array.isArray(data) ? data[0] : data
      setWishlist(prev => prev.map(r => r.id === item.id
        ? { ...r, claimed_by_me: !!result?.claimed_by_me, is_claimed: !!result?.is_claimed } : r))
    } catch {
      // Roll back on failure.
      setWishlist(prev => prev.map(r => r.id === item.id
        ? { ...r, claimed_by_me: item.claimed_by_me, is_claimed: item.is_claimed } : r))
    }
    setClaimBusy(null)
  }

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
          <WishlistView
            items={wishlist || []}
            sfMap={sfMap}
            enriching={enriching}
            priceSource={price_source}
            claimBusy={claimBusy}
            onToggleClaim={toggleClaim}
          />
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

function WishlistView({ items, sfMap, enriching, priceSource, claimBusy, onToggleClaim }) {
  if (!items.length && !enriching) return <EmptyState>This wishlist is empty.</EmptyState>
  return (
    <>
      <p className={styles.wishlistHint}>
        Claim a card to let others know you’re getting it. Claims are private to gift-givers — the list owner can’t see them.
      </p>
      {enriching && <ProgressBar value={60} label="Loading prices…" />}
      <div className={styles.wishlistGrid}>
        {items.map(item => {
          const sf = sfMap[`${item.set_code}-${item.collector_number}`]
          const price = sf ? getPrice(sf, item.foil, { price_source: priceSource }) : null
          const img = item.image_uri || sf?.image_uris?.normal
          const claimedByOther = item.is_claimed && !item.claimed_by_me
          return (
            <div key={item.id} className={`${styles.wishlistItem}${item.is_claimed ? ' ' + styles.wishlistItemClaimed : ''}`}>
              {img && <img className={styles.wishlistImg} src={img} alt="" loading="lazy" />}
              <div className={styles.wishlistBody}>
                <div className={styles.wishlistName}>{item.name}{item.foil ? ' ✦' : ''}</div>
                <div className={styles.wishlistMeta}>
                  {(item.set_code || '').toUpperCase()} · {item.qty}× {price != null ? `· ${formatPrice(price, priceSource)}` : ''}
                </div>
                <button
                  type="button"
                  className={`${styles.claimBtn}${item.claimed_by_me ? ' ' + styles.claimBtnMine : ''}`}
                  disabled={claimBusy === item.id || claimedByOther}
                  onClick={() => onToggleClaim(item)}
                >
                  {item.claimed_by_me
                    ? <><CheckIcon size={13} /> You’re getting this</>
                    : claimedByOther
                      ? 'Claimed'
                      : 'I’ll get this'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </>
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
