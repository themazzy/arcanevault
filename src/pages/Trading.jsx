import { useCallback, useEffect, useMemo, useState } from 'react'
import { sb } from '../lib/supabase'
import { formatPrice, getImageUri, getPrice, sfGet } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { deleteCard, getLocalCards, putCards, putFolderCards, putFolders } from '../lib/db'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { EmptyState, ProgressBar, SectionHeader } from '../components/UI'
import styles from './Trading.module.css'

const SEARCH_LIMIT = 8
const RECENTLY_TRADED_BINDER = 'Recently Traded'
const DEFAULT_RECEIVED_LANGUAGE = 'en'
const DEFAULT_RECEIVED_CONDITION = 'near_mint'

async function fetchWantedCards(query) {
  if (!query.trim()) return []
  const json = await sfGet(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query.trim())}&order=name&unique=prints`)
  return (json?.data || []).slice(0, SEARCH_LIMIT)
}

function getCollectionCardName(card, sf) {
  return sf?.name || card.name || `${(card.set_code || '').toUpperCase()} #${card.collector_number || ''}`.trim()
}

function getOfferKey(item) {
  return `${item.setCode}-${item.collectorNumber}`
}

function createWantedItemId(sfCard, foil) {
  return `${sfCard.id}-${foil ? 'foil' : 'nonfoil'}`
}

function sumTradeValue(items, getUnitPrice) {
  return items.reduce((sum, item) => {
    const price = getUnitPrice(item)
    return price != null ? sum + (price * item.qty) : sum
  }, 0)
}

function countUnpriced(items, getUnitPrice) {
  return items.reduce((count, item) => count + (getUnitPrice(item) == null ? 1 : 0), 0)
}

function TradeRow({ item, side, unitPrice, totalPrice, onAdd, onSub, onRemove, onToggleFoil, maxQty }) {
  return (
    <div className={styles.tradeRow}>
      <div className={styles.tradeCard}>
        {item.image ? (
          <img src={item.image} alt="" className={styles.tradeImg} loading="lazy" />
        ) : (
          <div className={styles.tradeImgPlaceholder}>No art</div>
        )}
        <div className={styles.tradeMeta}>
          <div className={styles.tradeName}>{item.name}</div>
          <div className={styles.tradeSub}>
            <span>{item.setName || item.setCode?.toUpperCase() || 'Unknown set'}</span>
            {item.collectorNumber && <span>#{item.collectorNumber}</span>}
            {side === 'offer' && maxQty != null && <span>Owned {maxQty}</span>}
          </div>
          <div className={styles.tradePriceRow}>
            <span className={styles.tradeUnit}>{unitPrice != null ? formatPrice(unitPrice, item.priceSource) : 'Price unavailable'}</span>
            <span className={styles.tradeTotal}>{totalPrice != null ? formatPrice(totalPrice, item.priceSource) : '—'}</span>
          </div>
        </div>
      </div>
      <div className={styles.tradeActions}>
        <button className={styles.qtyBtn} onClick={onSub} type="button">−</button>
        <div className={styles.qtyVal}>{item.qty}</div>
        <button className={styles.qtyBtn} onClick={onAdd} disabled={maxQty != null && item.qty >= maxQty} type="button">+</button>
        {onToggleFoil && (
          <button
            className={`${styles.foilBtn}${item.foil ? ` ${styles.foilBtnActive}` : ''}`}
            onClick={onToggleFoil}
            type="button"
          >
            Foil
          </button>
        )}
        <button className={styles.removeBtn} onClick={onRemove} type="button">Remove</button>
      </div>
    </div>
  )
}

export default function TradingPage() {
  const { user } = useAuth()
  const { price_source } = useSettings()

  const [cards, setCards] = useState([])
  const [sfMap, setSfMap] = useState({})
  const [collectionLoaded, setCollectionLoaded] = useState(false)
  const [collectionLoading, setCollectionLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progLabel, setProgLabel] = useState('')
  const [collectionQuery, setCollectionQuery] = useState('')
  const [wantedQuery, setWantedQuery] = useState('')
  const [wantedLoading, setWantedLoading] = useState(false)
  const [wantedResults, setWantedResults] = useState([])
  const [offerItems, setOfferItems] = useState([])
  const [wantItems, setWantItems] = useState([])
  const [tradeSaving, setTradeSaving] = useState(false)
  const [tradeError, setTradeError] = useState('')
  const [tradeMessage, setTradeMessage] = useState('')

  const loadCollection = useCallback(async () => {
    if (collectionLoaded || collectionLoading) return

    setCollectionLoading(true)
    setTradeError('')
    setProgress(0)
    setProgLabel('Loading collection…')

    try {
      const localCards = await getLocalCards(user.id)
      if (localCards.length) {
        setCards(localCards)
        setProgress(35)
      }

      let allCards = localCards
      if (navigator.onLine) {
        let from = 0
        const fetched = []
        while (true) {
          const { data, error } = await sb.from('cards')
            .select('*')
            .eq('user_id', user.id)
            .order('name')
            .range(from, from + 999)
          if (error) throw error
          if (!data?.length) break
          fetched.push(...data)
          if (data.length < 1000) break
          from += 1000
        }
        if (fetched.length) {
          allCards = fetched
          await putCards(fetched)
          setCards(fetched)
        }
      }

      setCards(allCards)
      const map = allCards.length ? await loadCardMapWithSharedPrices(allCards) : {}
      setSfMap(map)
      setCollectionLoaded(true)
      setProgress(100)
    } catch (err) {
      setTradeError(err.message || 'Failed to load collection.')
    } finally {
      setCollectionLoading(false)
    }
  }, [collectionLoaded, collectionLoading, user.id])

  useEffect(() => {
    if (collectionQuery.trim() && !collectionLoaded && !collectionLoading) {
      loadCollection()
    }
  }, [collectionQuery, collectionLoaded, collectionLoading, loadCollection])

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      if (!wantedQuery.trim()) {
        setWantedResults([])
        return
      }
      setWantedLoading(true)
      const results = await fetchWantedCards(wantedQuery)
      if (!cancelled) {
        setWantedResults(results)
        setWantedLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [wantedQuery])

  const filteredCards = useMemo(() => {
    if (!collectionLoaded) return []
    const q = collectionQuery.trim().toLowerCase()
    if (!q) return []
    return cards.filter(card => {
      const sf = sfMap[`${card.set_code}-${card.collector_number}`]
      const haystack = [
        card.name,
        sf?.name,
        sf?.set_name,
        card.set_code,
        card.collector_number,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [cards, collectionLoaded, collectionQuery, sfMap])

  const offerQtyById = useMemo(
    () => Object.fromEntries(offerItems.map(item => [item.id, item.qty])),
    [offerItems]
  )

  const ensureOfferCardData = useCallback(async (card) => {
    const key = `${card.set_code}-${card.collector_number}`
    if (sfMap[key]) return sfMap[key]
    const map = await loadCardMapWithSharedPrices([card])
    if (map) {
      setSfMap(prev => ({ ...prev, ...map }))
      return map[key]
    }
    return null
  }, [sfMap])

  const addOfferCard = async (card) => {
    const sf = await ensureOfferCardData(card)
    setOfferItems(prev => {
      const existing = prev.find(item => item.id === card.id)
      const maxQty = card.qty || 1
      if (existing) {
        if (existing.qty >= maxQty) return prev
        return prev.map(item => item.id === card.id ? { ...item, qty: item.qty + 1 } : item)
      }
      return [...prev, {
        id: card.id,
        name: getCollectionCardName(card, sf),
        setName: sf?.set_name || card.set_code?.toUpperCase() || '',
        setCode: card.set_code,
        collectorNumber: card.collector_number,
        image: getImageUri(sf, 'small'),
        foil: !!card.foil,
        qty: 1,
        maxQty,
        priceSource: price_source,
      }]
    })
  }

  const updateOfferItem = (id, updater) => {
    setOfferItems(prev => prev.flatMap(item => {
      if (item.id !== id) return [item]
      const next = updater(item)
      return next && next.qty > 0 ? [next] : []
    }))
  }

  const addWantedCard = (sfCard) => {
    const itemId = createWantedItemId(sfCard, false)
    setWantItems(prev => {
      const existing = prev.find(item => item.id === itemId)
      if (existing) return prev.map(item => item.id === itemId ? { ...item, qty: item.qty + 1 } : item)
      return [...prev, {
        id: itemId,
        scryfallId: sfCard.id,
        name: sfCard.name,
        setName: sfCard.set_name,
        setCode: sfCard.set,
        collectorNumber: sfCard.collector_number,
        image: getImageUri(sfCard, 'small'),
        foil: false,
        qty: 1,
        sf: sfCard,
        priceSource: price_source,
      }]
    })
  }

  const updateWantItem = (id, updater) => {
    setWantItems(prev => prev.flatMap(item => {
      if (item.id !== id) return [item]
      const next = updater(item)
      return next && next.qty > 0 ? [next] : []
    }))
  }

  const getOfferUnitPrice = useCallback((item) => {
    const sf = sfMap[getOfferKey(item)]
    return getPrice(sf, item.foil, { price_source, cardId: item.id })
  }, [price_source, sfMap])

  const getWantUnitPrice = useCallback((item) => {
    return getPrice(item.sf, item.foil, { price_source, cardId: item.scryfallId })
  }, [price_source])

  const offerTotal = useMemo(() => sumTradeValue(offerItems, getOfferUnitPrice), [offerItems, getOfferUnitPrice])
  const wantTotal = useMemo(() => sumTradeValue(wantItems, getWantUnitPrice), [wantItems, getWantUnitPrice])
  const offerUnpriced = useMemo(() => countUnpriced(offerItems, getOfferUnitPrice), [offerItems, getOfferUnitPrice])
  const wantUnpriced = useMemo(() => countUnpriced(wantItems, getWantUnitPrice), [wantItems, getWantUnitPrice])
  const delta = wantTotal - offerTotal

  const settlement = useMemo(() => {
    if (!offerItems.length && !wantItems.length) return 'Add cards to both sides to compare the trade.'
    if (Math.abs(delta) < 0.005) return 'Even trade at current market prices.'
    if (delta > 0) return `You still need to pay ${formatPrice(delta, price_source)}.`
    return `You should receive ${formatPrice(Math.abs(delta), price_source)} back.`
  }, [delta, offerItems.length, wantItems.length, price_source])

  const handleTrade = async () => {
    if (tradeSaving) return
    if (!offerItems.length && !wantItems.length) return

    setTradeSaving(true)
    setTradeError('')
    setTradeMessage('')

    try {
      let nextCards = [...cards]
      const touchedCards = []
      const insertedFolderRows = []

      let tradedBinder = null
      const { data: existingBinder, error: binderLookupError } = await sb.from('folders')
        .select('*')
        .eq('user_id', user.id)
        .eq('type', 'binder')
        .eq('name', RECENTLY_TRADED_BINDER)
        .maybeSingle()
      if (binderLookupError) throw binderLookupError

      if (existingBinder) {
        tradedBinder = existingBinder
      } else {
        const { data: createdBinder, error: binderCreateError } = await sb.from('folders')
          .insert({
            user_id: user.id,
            type: 'binder',
            name: RECENTLY_TRADED_BINDER,
            description: '{}',
          })
          .select()
          .single()
        if (binderCreateError) throw binderCreateError
        tradedBinder = createdBinder
      }
      await putFolders([tradedBinder])

      for (const item of offerItems) {
        const current = nextCards.find(card => card.id === item.id)
        if (!current) continue

        const remaining = (current.qty || 1) - item.qty
        if (remaining > 0) {
          const updated = { ...current, qty: remaining, updated_at: new Date().toISOString() }
          const { error } = await sb.from('cards').update({ qty: remaining, updated_at: updated.updated_at }).eq('id', item.id)
          if (error) throw error
          nextCards = nextCards.map(card => card.id === item.id ? updated : card)
          touchedCards.push(updated)
        } else {
          const { error } = await sb.from('cards').delete().eq('id', item.id)
          if (error) throw error
          nextCards = nextCards.filter(card => card.id !== item.id)
          await deleteCard(item.id)

          // Remove dangling folder links when the underlying collection card is gone.
          await sb.from('folder_cards').delete().eq('card_id', item.id)
        }
      }

      const currency = price_source === 'tcgplayer_market' ? 'USD' : 'EUR'

      for (const item of wantItems) {
        const unitPrice = getWantUnitPrice(item) ?? 0

        const { data: existingCard, error: existingCardError } = await sb.from('cards')
          .select('*')
          .eq('user_id', user.id)
          .eq('set_code', item.setCode)
          .eq('collector_number', item.collectorNumber)
          .eq('foil', item.foil)
          .eq('language', DEFAULT_RECEIVED_LANGUAGE)
          .eq('condition', DEFAULT_RECEIVED_CONDITION)
          .maybeSingle()
        if (existingCardError) throw existingCardError

        let savedCard = existingCard
        if (existingCard) {
          const nextQty = (existingCard.qty || 1) + item.qty
          const updated = { ...existingCard, qty: nextQty, updated_at: new Date().toISOString() }
          const { error } = await sb.from('cards')
            .update({ qty: nextQty, updated_at: updated.updated_at })
            .eq('id', existingCard.id)
          if (error) throw error
          savedCard = updated
        } else {
          const insertPayload = {
            user_id: user.id,
            name: item.name,
            set_code: item.setCode,
            collector_number: item.collectorNumber,
            scryfall_id: item.scryfallId,
            foil: item.foil,
            qty: item.qty,
            condition: DEFAULT_RECEIVED_CONDITION,
            language: DEFAULT_RECEIVED_LANGUAGE,
            purchase_price: unitPrice,
            currency,
          }
          const { data: createdCard, error } = await sb.from('cards')
            .insert(insertPayload)
            .select()
            .single()
          if (error) throw error
          savedCard = createdCard
        }

        nextCards = nextCards.some(card => card.id === savedCard.id)
          ? nextCards.map(card => card.id === savedCard.id ? savedCard : card)
          : [...nextCards, savedCard]
        touchedCards.push(savedCard)

        const { data: existingLink, error: linkLookupError } = await sb.from('folder_cards')
          .select('*')
          .eq('folder_id', tradedBinder.id)
          .eq('card_id', savedCard.id)
          .maybeSingle()
        if (linkLookupError) throw linkLookupError

        if (existingLink) {
          const nextQty = (existingLink.qty || 0) + item.qty
          const { data: updatedLink, error } = await sb.from('folder_cards')
            .update({ qty: nextQty })
            .eq('id', existingLink.id)
            .select()
            .single()
          if (error) throw error
          insertedFolderRows.push(updatedLink)
        } else {
          const { data: createdLink, error } = await sb.from('folder_cards')
            .insert({ folder_id: tradedBinder.id, card_id: savedCard.id, qty: item.qty })
            .select()
            .single()
          if (error) throw error
          insertedFolderRows.push(createdLink)
        }
      }

      if (touchedCards.length) await putCards(touchedCards)
      if (insertedFolderRows.length) await putFolderCards(insertedFolderRows)

      setCards(nextCards)
      setOfferItems([])
      setWantItems([])
      setCollectionQuery('')
      setWantedQuery('')
      setWantedResults([])
      setTradeMessage(`Trade saved. Received cards were moved to the ${RECENTLY_TRADED_BINDER} binder.`)
    } catch (err) {
      setTradeError(err.message || 'Failed to save trade.')
    } finally {
      setTradeSaving(false)
    }
  }

  return (
    <div className={styles.page}>
      <SectionHeader title="Trading" />
      <div className={styles.intro}>
        Build both sides of a trade, compare live values, and save the result back into your collection.
      </div>

      {(tradeError || tradeMessage) && (
        <div className={`${styles.notice}${tradeError ? ` ${styles.noticeError}` : ''}`}>
          {tradeError || tradeMessage}
        </div>
      )}

      <div className={styles.summaryGrid}>
        <div className={styles.summaryCard}>
          <div className={styles.summaryLabel}>Your cards</div>
          <div className={styles.summaryValue}>{formatPrice(offerTotal, price_source)}</div>
          <div className={styles.summarySub}>
            {offerItems.reduce((sum, item) => sum + item.qty, 0)} cards selected
            {offerUnpriced > 0 ? ` · ${offerUnpriced} unpriced` : ''}
          </div>
        </div>
        <div className={styles.summaryCard}>
          <div className={styles.summaryLabel}>Cards you want</div>
          <div className={styles.summaryValue}>{formatPrice(wantTotal, price_source)}</div>
          <div className={styles.summarySub}>
            {wantItems.reduce((sum, item) => sum + item.qty, 0)} cards selected
            {wantUnpriced > 0 ? ` · ${wantUnpriced} unpriced` : ''}
          </div>
        </div>
        <div className={`${styles.summaryCard} ${delta > 0 ? styles.summaryWarn : Math.abs(delta) < 0.005 ? styles.summaryEven : styles.summaryGood}`}>
          <div className={styles.summaryLabel}>Settlement</div>
          <div className={styles.summaryValue}>
            {Math.abs(delta) < 0.005 ? formatPrice(0, price_source) : formatPrice(Math.abs(delta), price_source)}
          </div>
          <div className={styles.summarySub}>{settlement}</div>
          <button
            className={styles.tradeBtn}
            type="button"
            disabled={tradeSaving || (!offerItems.length && !wantItems.length)}
            onClick={handleTrade}
          >
            {tradeSaving ? 'Saving trade…' : 'Trade'}
          </button>
        </div>
      </div>

      <div className={styles.tradeGrid}>
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3 className={styles.panelTitle}>You give</h3>
              <div className={styles.panelDesc}>Search your collection only when you need it.</div>
            </div>
            {offerItems.length > 0 && (
              <button className={styles.clearBtn} onClick={() => setOfferItems([])} type="button">Clear</button>
            )}
          </div>

          <input
            className={styles.searchInput}
            value={collectionQuery}
            onChange={e => setCollectionQuery(e.target.value)}
            placeholder="Search your collection by name, set, or collector number…"
          />

          {!collectionQuery.trim() && !collectionLoaded && (
            <EmptyState>Collection cards will load when you start typing here.</EmptyState>
          )}

          {collectionLoading && (
            <ProgressBar value={progress} label={progLabel || 'Loading collection…'} />
          )}

          {collectionQuery.trim() && !collectionLoading && (
            <div className={styles.selectorList}>
              {filteredCards.slice(0, 80).map(card => {
                const sf = sfMap[`${card.set_code}-${card.collector_number}`]
                const maxQty = card.qty || 1
                const selectedQty = offerQtyById[card.id] || 0
                const unitPrice = getPrice(sf, card.foil, { price_source, cardId: card.id })
                return (
                  <button
                    key={card.id}
                    className={styles.selectorItem}
                    onClick={() => addOfferCard(card)}
                    disabled={selectedQty >= maxQty}
                    type="button"
                  >
                    {getImageUri(sf, 'small')
                      ? <img src={getImageUri(sf, 'small')} alt="" className={styles.selectorImg} loading="lazy" />
                      : <div className={styles.selectorImgPlaceholder}>No art</div>}
                    <div className={styles.selectorMeta}>
                      <div className={styles.selectorName}>{getCollectionCardName(card, sf)}</div>
                      <div className={styles.selectorSub}>
                        <span>{sf?.set_name || card.set_code?.toUpperCase() || 'Unknown set'}</span>
                        <span>Owned {maxQty}</span>
                        {card.foil && <span>Foil</span>}
                      </div>
                    </div>
                    <div className={styles.selectorAside}>
                      <div className={styles.selectorPrice}>{unitPrice != null ? formatPrice(unitPrice, price_source) : '—'}</div>
                      <div className={styles.selectorPick}>{selectedQty > 0 ? `${selectedQty}/${maxQty}` : 'Add'}</div>
                    </div>
                  </button>
                )
              })}
              {collectionLoaded && filteredCards.length === 0 && (
                <EmptyState>No collection cards match this search.</EmptyState>
              )}
            </div>
          )}

          <div className={styles.selectedList}>
            {offerItems.length === 0 ? (
              <EmptyState>No cards selected from your collection yet.</EmptyState>
            ) : offerItems.map(item => {
              const sf = sfMap[getOfferKey(item)]
              const unitPrice = getOfferUnitPrice(item)
              const totalPrice = unitPrice != null ? unitPrice * item.qty : null
              return (
                <TradeRow
                  key={item.id}
                  item={{
                    ...item,
                    image: getImageUri(sf, 'small') || item.image,
                    setName: sf?.set_name || item.setName,
                    name: sf?.name || item.name,
                  }}
                  side="offer"
                  unitPrice={unitPrice}
                  totalPrice={totalPrice}
                  maxQty={item.maxQty}
                  onAdd={() => updateOfferItem(item.id, current => current.qty < current.maxQty ? { ...current, qty: current.qty + 1 } : current)}
                  onSub={() => updateOfferItem(item.id, current => current.qty > 1 ? { ...current, qty: current.qty - 1 } : null)}
                  onRemove={() => updateOfferItem(item.id, () => null)}
                />
              )
            })}
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3 className={styles.panelTitle}>You receive</h3>
              <div className={styles.panelDesc}>Search Scryfall and add the cards you want to buy or trade for.</div>
            </div>
            {wantItems.length > 0 && (
              <button className={styles.clearBtn} onClick={() => setWantItems([])} type="button">Clear</button>
            )}
          </div>

          <input
            className={styles.searchInput}
            value={wantedQuery}
            onChange={e => setWantedQuery(e.target.value)}
            placeholder="Search any card or printing you want…"
          />

          <div className={styles.selectorList}>
            {wantedLoading && <div className={styles.searchState}>Searching Scryfall…</div>}
            {!wantedLoading && wantedResults.map(card => {
              const unitPrice = getPrice(card, false, { price_source, cardId: card.id })
              return (
                <button
                  key={card.id}
                  className={styles.selectorItem}
                  onClick={() => addWantedCard(card)}
                  type="button"
                >
                  {getImageUri(card, 'small')
                    ? <img src={getImageUri(card, 'small')} alt="" className={styles.selectorImg} loading="lazy" />
                    : <div className={styles.selectorImgPlaceholder}>No art</div>}
                  <div className={styles.selectorMeta}>
                    <div className={styles.selectorName}>{card.name}</div>
                    <div className={styles.selectorSub}>
                      <span>{card.set_name}</span>
                      <span>#{card.collector_number}</span>
                    </div>
                  </div>
                  <div className={styles.selectorAside}>
                    <div className={styles.selectorPrice}>{unitPrice != null ? formatPrice(unitPrice, price_source) : '—'}</div>
                    <div className={styles.selectorPick}>Add</div>
                  </div>
                </button>
              )
            })}
            {!wantedLoading && wantedQuery.trim() && wantedResults.length === 0 && (
              <EmptyState>No Scryfall results for this search.</EmptyState>
            )}
          </div>

          <div className={styles.selectedList}>
            {wantItems.length === 0 ? (
              <EmptyState>No wanted cards added yet.</EmptyState>
            ) : wantItems.map(item => {
              const unitPrice = getWantUnitPrice(item)
              const totalPrice = unitPrice != null ? unitPrice * item.qty : null
              return (
                <TradeRow
                  key={item.id}
                  item={item}
                  side="want"
                  unitPrice={unitPrice}
                  totalPrice={totalPrice}
                  onAdd={() => updateWantItem(item.id, current => ({ ...current, qty: current.qty + 1 }))}
                  onSub={() => updateWantItem(item.id, current => current.qty > 1 ? { ...current, qty: current.qty - 1 } : null)}
                  onRemove={() => updateWantItem(item.id, () => null)}
                  onToggleFoil={() => updateWantItem(item.id, current => ({ ...current, foil: !current.foil }))}
                />
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
