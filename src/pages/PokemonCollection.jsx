import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { Button, EmptyState, ErrorBox, Modal, SectionHeader, Select } from '../components/UI'
import {
  getPokemonCardmarketBreakdown,
  createPokemonCardSnapshot,
  formatPokemonPrice,
  getPokemonCard,
  getPokemonCardImage,
  getPokemonPrice,
  getPokemonPriceOptions,
  getPokemonTcgplayerBreakdown,
  searchPokemonCards,
} from '../lib/pokemonTcg'
import styles from './PokemonCollection.module.css'

const STORAGE_PREFIX = 'arcanevault_pokemon_collection_v1'
const SORT_OPTIONS = [
  ['recent', 'Recently Added'],
  ['name', 'Name'],
  ['value_desc', 'Value High to Low'],
  ['value_asc', 'Value Low to High'],
  ['set', 'Set'],
]

function getStorageKey(userId) {
  return `${STORAGE_PREFIX}_${userId}`
}

function readStoredCollection(userId) {
  if (!userId) return []
  try {
    const raw = localStorage.getItem(getStorageKey(userId))
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeStoredCollection(userId, items) {
  if (!userId) return
  localStorage.setItem(getStorageKey(userId), JSON.stringify(items))
}

function createCollectionEntry(card, variantKey, qty, localId = crypto.randomUUID()) {
  const now = new Date().toISOString()
  const options = getPokemonPriceOptions(card)
  const resolvedVariant = options.find(option => option.key === variantKey)?.key || options[0]?.key || 'cardmarket'
  return {
    localId,
    cardId: card.id,
    variantKey: resolvedVariant,
    qty: Math.max(1, parseInt(qty, 10) || 1),
    snapshot: createPokemonCardSnapshot(card),
    addedAt: now,
    updatedAt: now,
  }
}

function addCollectionEntry(items, entry) {
  const existing = items.find(item => item.cardId === entry.cardId && item.variantKey === entry.variantKey)
  if (!existing) return [entry, ...items]
  return items.map(item => (
    item.localId === existing.localId
      ? {
          ...item,
          qty: item.qty + entry.qty,
          snapshot: entry.snapshot,
          updatedAt: entry.updatedAt,
        }
      : item
  ))
}

function saveCollectionEntry(items, localId, entry) {
  const remaining = items.filter(item => item.localId !== localId)
  const existing = remaining.find(item => item.cardId === entry.cardId && item.variantKey === entry.variantKey)
  if (!existing) {
    return [{
      ...entry,
      localId,
      addedAt: items.find(item => item.localId === localId)?.addedAt || entry.addedAt,
    }, ...remaining]
  }
  return remaining.map(item => (
    item.localId === existing.localId
      ? {
          ...item,
          qty: item.qty + entry.qty,
          snapshot: entry.snapshot,
          updatedAt: entry.updatedAt,
        }
      : item
  ))
}

function getDisplayCard(item, liveCardsById) {
  return liveCardsById[item.cardId] || item.snapshot || null
}

function getItemPriceMeta(item, liveCardsById) {
  return getPokemonPrice(getDisplayCard(item, liveCardsById), item.variantKey)
}

function itemMatchesQuery(item, liveCardsById, query) {
  if (!query) return true
  const card = getDisplayCard(item, liveCardsById)
  const haystack = [
    card?.name,
    card?.id,
    card?.set?.name,
    card?.set?.series,
    card?.set?.id,
    card?.set?.ptcgoCode,
    card?.number,
    card?.rarity,
    ...(card?.types || []),
    ...(card?.subtypes || []),
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(query)
}

function gridDensityClass(gridDensity) {
  if (gridDensity === 'compact') return styles.gridCompact
  if (gridDensity === 'cozy') return styles.gridCozy
  return styles.gridComfortable
}

function SearchThumb({ card }) {
  const image = getPokemonCardImage(card, 'small')
  return image
    ? <img className={styles.searchThumb} src={image} alt="" />
    : <div className={styles.searchThumb} />
}

function PreviewArt({ card, fallbackText = 'No image' }) {
  const image = getPokemonCardImage(card, 'large')
  return image
    ? <img className={styles.previewArt} src={image} alt={card?.name || 'Pokemon card'} />
    : <div className={styles.searchPlaceholder}>{fallbackText}</div>
}

function PriceDataPanel({ card }) {
  const tcgplayer = getPokemonTcgplayerBreakdown(card)
  const cardmarket = getPokemonCardmarketBreakdown(card)
  const hasTcgplayer = tcgplayer.variants.length > 0
  const hasCardmarket = cardmarket.metrics.length > 0

  return (
    <div className={styles.pricePanel}>
      <div className={styles.fieldLabel}>Available Price Data</div>

      <div className={styles.priceSection}>
        <div className={styles.priceSectionHead}>
          <span>TCGplayer</span>
          {tcgplayer.updatedAt ? <span>{tcgplayer.updatedAt}</span> : null}
        </div>
        {hasTcgplayer ? (
          <div className={styles.priceTable}>
            {tcgplayer.variants.map(variant => (
              <div key={variant.key} className={styles.priceVariant}>
                <div className={styles.priceVariantLabel}>{variant.label}</div>
                <div className={styles.priceMetrics}>
                  {variant.metrics.map(([label, value]) => (
                    <div key={label} className={styles.priceMetric}>
                      <span>{label}</span>
                      <strong>{formatPokemonPrice(value, tcgplayer.currency)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.priceEmpty}>No TCGplayer price buckets returned for this printing.</div>
        )}
      </div>

      <div className={styles.priceSection}>
        <div className={styles.priceSectionHead}>
          <span>Cardmarket</span>
          {cardmarket.updatedAt ? <span>{cardmarket.updatedAt}</span> : null}
        </div>
        {hasCardmarket ? (
          <div className={styles.priceMetrics}>
            {cardmarket.metrics.map(([label, value]) => (
              <div key={label} className={styles.priceMetric}>
                <span>{label}</span>
                <strong>{formatPokemonPrice(value, cardmarket.currency)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.priceEmpty}>No Cardmarket price fields returned for this printing.</div>
        )}
      </div>

      <div className={styles.priceSection}>
        <div className={styles.priceSectionHead}>
          <span>Graded / Slab Data</span>
        </div>
        <div className={styles.priceEmpty}>The Pokemon TCG API does not expose graded card price data.</div>
      </div>
    </div>
  )
}

function PokemonCollectionCard({ item, card, liveCardsById, showPrice, onOpen }) {
  const image = getPokemonCardImage(card, 'large')
  const priceMeta = getItemPriceMeta(item, liveCardsById)
  const totalPrice = priceMeta?.amount != null ? priceMeta.amount * item.qty : null

  return (
    <button type="button" className={styles.card} onClick={onOpen}>
      <div className={styles.cardArtWrap}>
        {image
          ? <img className={styles.cardArt} src={image} alt={card?.name || item.snapshot?.name || 'Pokemon card'} loading="lazy" />
          : <div className={styles.cardArtFallback}>No image</div>}
        {item.qty > 1 && <div className={styles.cardQty}>x{item.qty}</div>}
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardTitle}>{card?.name || item.snapshot?.name || 'Unknown card'}</div>
        <div className={styles.cardMetaLine}>
          <span>{card?.set?.name || item.snapshot?.set?.name || 'Unknown set'}</span>
          <span>#{card?.number || item.snapshot?.number || '-'}</span>
        </div>
        <div className={styles.cardVariant}>
          {getPokemonPrice(card || item.snapshot, item.variantKey)?.label || item.variantKey}
        </div>
        {showPrice && (
          <div className={styles.cardPriceRow}>
            <span className={styles.cardPrice}>
              {totalPrice != null ? formatPokemonPrice(totalPrice, priceMeta?.currency || 'USD') : '-'}
            </span>
            <span className={styles.cardPriceSource}>{priceMeta?.source || 'No price'}</span>
          </div>
        )}
      </div>
    </button>
  )
}

function PokemonAddModal({ onClose, onAdd }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [error, setError] = useState('')
  const [selectedCardId, setSelectedCardId] = useState(null)
  const [selectedCardDetails, setSelectedCardDetails] = useState(null)
  const [variantKey, setVariantKey] = useState('')
  const [qty, setQty] = useState(1)
  const deferredQuery = useDeferredValue(query)

  useEffect(() => {
    if (!deferredQuery.trim() || deferredQuery.trim().length < 2) {
      setResults([])
      setSelectedCardId(null)
      setError('')
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError('')

    searchPokemonCards(deferredQuery, { signal: controller.signal })
      .then(cards => {
        setResults(cards)
        setSelectedCardDetails(null)
        setSelectedCardId(current => (current && cards.some(card => card.id === current)) ? current : cards[0]?.id || null)
      })
      .catch(err => {
        if (err.name === 'AbortError') return
        setError(err.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [deferredQuery])

  const selectedCard = useMemo(
    () => results.find(card => card.id === selectedCardId) || null,
    [results, selectedCardId]
  )

  useEffect(() => {
    if (!selectedCardId) {
      setSelectedCardDetails(null)
      return
    }

    const fallback = results.find(card => card.id === selectedCardId) || null
    setSelectedCardDetails(current => current?.id === selectedCardId ? current : fallback)

    const controller = new AbortController()
    setLoadingDetails(true)

    getPokemonCard(selectedCardId, { signal: controller.signal })
      .then(card => {
        if (!controller.signal.aborted && card) setSelectedCardDetails(card)
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDetails(false)
      })

    return () => controller.abort()
  }, [results, selectedCardId])

  const resolvedSelectedCard = selectedCardDetails || selectedCard

  const priceOptions = useMemo(
    () => getPokemonPriceOptions(resolvedSelectedCard),
    [resolvedSelectedCard]
  )

  useEffect(() => {
    if (!priceOptions.length) {
      setVariantKey('')
      return
    }
    setVariantKey(current => priceOptions.some(option => option.key === current) ? current : priceOptions[0].key)
  }, [priceOptions])

  const selectedPrice = priceOptions.find(option => option.key === variantKey) || priceOptions[0] || null

  return (
    <Modal onClose={onClose}>
      <div className={styles.modalShell}>
        <h2 className={styles.modalTitle}>Add Pokemon Card</h2>
        <p className={styles.modalIntro}>Search Pokemon cards, pick the exact printing, then choose the finish you want to track.</p>

        <input
          className={styles.modalSearch}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by name, set, or code like POR 007"
          autoFocus
        />

        <ErrorBox>{error}</ErrorBox>

        <div className={styles.modalLayout}>
          <div className={styles.searchResults}>
            {!query.trim() && <div className={styles.searchPlaceholder}>Start typing to search the Pokemon TCG API.</div>}
            {loading && <div className={styles.searchPlaceholder}>Searching...</div>}
            {!loading && query.trim().length >= 2 && results.length === 0 && <div className={styles.searchPlaceholder}>No printings found.</div>}
            {results.map(card => (
              <button
                key={card.id}
                type="button"
                className={`${styles.searchResult} ${card.id === selectedCardId ? styles.searchResultActive : ''}`}
                onClick={() => setSelectedCardId(card.id)}
              >
                <SearchThumb card={card} />
                <div className={styles.searchInfo}>
                  <div className={styles.searchName}>{card.name}</div>
                  <div className={styles.searchMeta}>
                    <span>{card.set?.name || 'Unknown set'}</span>
                    <span>#{card.number || '-'}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className={styles.previewPanel}>
            {selectedCard ? (
              <>
                <div className={styles.previewArtWrap}>
                  <PreviewArt card={resolvedSelectedCard} />
                </div>
                <div className={styles.previewTitle}>{resolvedSelectedCard?.name}</div>
                <div className={styles.previewSet}>
                  {resolvedSelectedCard?.set?.name || 'Unknown set'}
                  {resolvedSelectedCard?.set?.ptcgoCode ? ` (${resolvedSelectedCard.set.ptcgoCode})` : ''}
                  {' | '}
                  #{resolvedSelectedCard?.number || '-'}
                </div>
                <div className={styles.previewTypeLine}>
                  {[resolvedSelectedCard?.supertype, ...(resolvedSelectedCard?.subtypes || []), ...(resolvedSelectedCard?.types || [])].filter(Boolean).join(' | ') || 'Card details unavailable'}
                </div>

                <div className={styles.fieldLabel}>Finish / price bucket</div>
                <div className={styles.variantChips}>
                  {priceOptions.length > 0 ? priceOptions.map(option => (
                    <button
                      key={option.key}
                      type="button"
                      className={`${styles.variantChip} ${variantKey === option.key ? styles.variantChipActive : ''}`}
                      onClick={() => setVariantKey(option.key)}
                    >
                      <span>{option.label}</span>
                      <span>{formatPokemonPrice(option.amount, option.currency)}</span>
                    </button>
                  )) : <div className={styles.searchPlaceholder}>{loadingDetails ? 'Loading full card pricing...' : 'No price data on this printing.'}</div>}
                </div>

                <div className={styles.fieldLabel}>Quantity</div>
                <div className={styles.qtyRow}>
                  <button type="button" className={styles.qtyBtn} onClick={() => setQty(value => Math.max(1, value - 1))}>-</button>
                  <input
                    className={styles.qtyInput}
                    type="number"
                    min="1"
                    value={qty}
                    onChange={e => setQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  />
                  <button type="button" className={styles.qtyBtn} onClick={() => setQty(value => value + 1)}>+</button>
                </div>

                <div className={styles.previewPriceSummary}>
                  {selectedPrice
                    ? `Tracked at ${formatPokemonPrice(selectedPrice.amount, selectedPrice.currency)} each via ${selectedPrice.source}`
                    : loadingDetails
                      ? 'Checking full pricing data for this printing...'
                      : 'This printing currently has no market price data.'}
                </div>

                <PriceDataPanel card={resolvedSelectedCard} />
              </>
            ) : (
              <div className={styles.searchPlaceholder}>Select a printing to configure it.</div>
            )}
          </div>
        </div>

        <div className={styles.modalActions}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="purple"
            disabled={!selectedCard}
            onClick={() => resolvedSelectedCard && onAdd(resolvedSelectedCard, variantKey, qty)}
          >
            Add to Pokemon Collection
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function PokemonDetailModal({ item, card, onClose, onSave, onDelete }) {
  const [qty, setQty] = useState(item.qty)
  const [variantKey, setVariantKey] = useState(item.variantKey)
  const priceOptions = useMemo(() => getPokemonPriceOptions(card), [card])

  useEffect(() => {
    if (!priceOptions.length) return
    setVariantKey(current => priceOptions.some(option => option.key === current) ? current : priceOptions[0].key)
  }, [priceOptions])

  const selectedPrice = priceOptions.find(option => option.key === variantKey) || priceOptions[0] || null

  return (
    <Modal onClose={onClose}>
      <div className={styles.modalShell}>
        <div className={styles.detailTop}>
          <div className={styles.previewArtWrap}>
            <PreviewArt card={card} />
          </div>

          <div className={styles.detailInfo}>
            <h2 className={styles.modalTitle}>{card?.name || item.snapshot?.name || 'Pokemon card'}</h2>
            <div className={styles.previewSet}>
              {card?.set?.name || item.snapshot?.set?.name || 'Unknown set'}
              {(card?.set?.ptcgoCode || item.snapshot?.set?.ptcgoCode) ? ` (${card?.set?.ptcgoCode || item.snapshot?.set?.ptcgoCode})` : ''}
              {' | '}
              #{card?.number || item.snapshot?.number || '-'}
            </div>
            <div className={styles.previewTypeLine}>
              {[card?.supertype, ...(card?.subtypes || []), ...(card?.types || [])].filter(Boolean).join(' | ') || 'Card details unavailable'}
            </div>

            <div className={styles.fieldLabel}>Finish / price bucket</div>
            <div className={styles.variantChips}>
              {priceOptions.length > 0 ? priceOptions.map(option => (
                <button
                  key={option.key}
                  type="button"
                  className={`${styles.variantChip} ${variantKey === option.key ? styles.variantChipActive : ''}`}
                  onClick={() => setVariantKey(option.key)}
                >
                  <span>{option.label}</span>
                  <span>{formatPokemonPrice(option.amount, option.currency)}</span>
                </button>
              )) : <div className={styles.searchPlaceholder}>No price data on this printing.</div>}
            </div>

            <div className={styles.fieldLabel}>Quantity</div>
            <div className={styles.qtyRow}>
              <button type="button" className={styles.qtyBtn} onClick={() => setQty(value => Math.max(1, value - 1))}>-</button>
              <input
                className={styles.qtyInput}
                type="number"
                min="1"
                value={qty}
                onChange={e => setQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
              />
              <button type="button" className={styles.qtyBtn} onClick={() => setQty(value => value + 1)}>+</button>
            </div>

            <div className={styles.previewPriceSummary}>
              {selectedPrice
                ? `${formatPokemonPrice(selectedPrice.amount, selectedPrice.currency)} each | ${formatPokemonPrice(selectedPrice.amount * qty, selectedPrice.currency)} total`
                : 'This printing currently has no market price data.'}
            </div>

            <PriceDataPanel card={card} />
          </div>
        </div>

        <div className={styles.modalActions}>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="ghost" className={styles.deleteBtn} onClick={() => onDelete(item.localId)}>Delete</Button>
          <Button variant="purple" onClick={() => onSave(item.localId, card, variantKey, qty)}>Save</Button>
        </div>
      </div>
    </Modal>
  )
}

export default function PokemonCollectionPage() {
  const { user } = useAuth()
  const { grid_density, show_price } = useSettings()

  const [items, setItems] = useState([])
  const [liveCardsById, setLiveCardsById] = useState({})
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('recent')
  const [showAddModal, setShowAddModal] = useState(false)
  const [activeItemId, setActiveItemId] = useState(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const deferredSearch = useDeferredValue(search.trim().toLowerCase())

  useEffect(() => {
    if (!user?.id) return
    setItems(readStoredCollection(user.id))
  }, [user?.id])

  useEffect(() => {
    if (!user?.id) return
    writeStoredCollection(user.id, items)
  }, [items, user?.id])

  const refreshCards = useCallback(async (force = false) => {
    const uniqueIds = [...new Set(items.map(item => item.cardId))]
    const idsToLoad = force ? uniqueIds : uniqueIds.filter(id => !liveCardsById[id])
    if (!idsToLoad.length) return

    setRefreshing(true)
    setError('')

    try {
      const results = await Promise.all(idsToLoad.map(async cardId => {
        try {
          const card = await getPokemonCard(cardId)
          return [cardId, card]
        } catch {
          return [cardId, null]
        }
      }))

      setLiveCardsById(prev => {
        const next = { ...prev }
        results.forEach(([cardId, card]) => {
          if (card) next[cardId] = card
        })
        return next
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setRefreshing(false)
    }
  }, [items, liveCardsById])

  useEffect(() => {
    if (!items.length) return
    refreshCards(false)
  }, [items, refreshCards])

  const visibleItems = useMemo(() => {
    const filtered = items.filter(item => itemMatchesQuery(item, liveCardsById, deferredSearch))
    return filtered.sort((a, b) => {
      const cardA = getDisplayCard(a, liveCardsById)
      const cardB = getDisplayCard(b, liveCardsById)
      const valueA = getItemPriceMeta(a, liveCardsById)?.amount || 0
      const valueB = getItemPriceMeta(b, liveCardsById)?.amount || 0

      if (sort === 'name') return String(cardA?.name || '').localeCompare(String(cardB?.name || ''))
      if (sort === 'value_desc') return valueB - valueA
      if (sort === 'value_asc') return valueA - valueB
      if (sort === 'set') {
        const setDelta = String(cardA?.set?.name || '').localeCompare(String(cardB?.set?.name || ''))
        if (setDelta !== 0) return setDelta
        return String(cardA?.name || '').localeCompare(String(cardB?.name || ''))
      }
      return new Date(b.addedAt || 0) - new Date(a.addedAt || 0)
    })
  }, [deferredSearch, items, liveCardsById, sort])

  const totalQty = useMemo(
    () => items.reduce((sum, item) => sum + (item.qty || 0), 0),
    [items]
  )

  const totalValue = useMemo(
    () => items.reduce((sum, item) => {
      const price = getItemPriceMeta(item, liveCardsById)?.amount
      return sum + ((price || 0) * item.qty)
    }, 0),
    [items, liveCardsById]
  )

  const activeItem = items.find(item => item.localId === activeItemId) || null
  const activeCard = activeItem ? getDisplayCard(activeItem, liveCardsById) : null

  const handleAddCard = useCallback((card, variantKey, qty) => {
    setLiveCardsById(prev => ({ ...prev, [card.id]: card }))
    setItems(prev => addCollectionEntry(prev, createCollectionEntry(card, variantKey, qty)))
    setShowAddModal(false)
  }, [])

  const handleSaveItem = useCallback((localId, card, variantKey, qty) => {
    setLiveCardsById(prev => ({ ...prev, [card.id]: card }))
    setItems(prev => saveCollectionEntry(prev, localId, createCollectionEntry(card, variantKey, qty, localId)))
    setActiveItemId(null)
  }, [])

  const handleDeleteItem = useCallback((localId) => {
    setItems(prev => prev.filter(item => item.localId !== localId))
    setActiveItemId(null)
  }, [])

  const statusItems = [
    refreshing ? 'Refreshing Pokemon prices...' : null,
    items.length ? 'Local-only test collection' : null,
    items.length ? 'Hidden route only: /pokemon' : null,
  ].filter(Boolean)

  return (
    <div className={styles.page}>
      <SectionHeader
        title={`Pokemon Lab${items.length ? ` | ${items.length} printings` : ''}`}
        action={(
          <div className={styles.headerActions}>
            <Button variant="ghost" onClick={() => refreshCards(true)} disabled={!items.length || refreshing}>Refresh Prices</Button>
            <Button variant="purple" onClick={() => setShowAddModal(true)}>+ Add Pokemon</Button>
          </div>
        )}
      />

      <div className={styles.toolbar}>
        <input
          className={styles.searchInput}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search your Pokemon collection by name, set, or code..."
        />
        <Select value={sort} onChange={e => setSort(e.target.value)} className={styles.sortSelect} title="Sort Pokemon collection">
          {SORT_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </Select>
      </div>

      <ErrorBox>{error}</ErrorBox>

      {statusItems.length > 0 && (
        <div className={styles.statusBar}>
          {statusItems.map(item => <span key={item} className={styles.statusChip}>{item}</span>)}
        </div>
      )}

      {!items.length ? (
        <div className={styles.emptyPanel}>
          <div className={styles.emptyTitle}>No Pokemon cards saved yet.</div>
          <div className={styles.emptyText}>This page is local-only for now. Add a few printings from the Pokemon TCG API to test the flow.</div>
          <Button variant="purple" onClick={() => setShowAddModal(true)}>Search Pokemon Cards</Button>
        </div>
      ) : (
        <>
          <div className={styles.statsGrid}>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{items.length}</div>
              <div className={styles.statLabel}>Unique Printings</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{totalQty}</div>
              <div className={styles.statLabel}>Cards Tracked</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{formatPokemonPrice(totalValue, 'USD')}</div>
              <div className={styles.statLabel}>Collection Value</div>
              <div className={styles.statSub}>TCGplayer market with Cardmarket USD fallback</div>
            </div>
          </div>

          <div className={styles.gridHeader}>
            <span>Showing {visibleItems.length} of {items.length} printings</span>
            {show_price && <span>Prices shown in USD</span>}
          </div>

          {visibleItems.length ? (
            <div className={`${styles.cardGrid} ${gridDensityClass(grid_density)}`}>
              {visibleItems.map(item => (
                <PokemonCollectionCard
                  key={item.localId}
                  item={item}
                  card={getDisplayCard(item, liveCardsById)}
                  liveCardsById={liveCardsById}
                  showPrice={show_price}
                  onOpen={() => setActiveItemId(item.localId)}
                />
              ))}
            </div>
          ) : (
            <EmptyState>No Pokemon cards match your search.</EmptyState>
          )}
        </>
      )}

      {showAddModal && (
        <PokemonAddModal
          onClose={() => setShowAddModal(false)}
          onAdd={handleAddCard}
        />
      )}

      {activeItem && activeCard && (
        <PokemonDetailModal
          item={activeItem}
          card={activeCard}
          onClose={() => setActiveItemId(null)}
          onSave={handleSaveItem}
          onDelete={handleDeleteItem}
        />
      )}
    </div>
  )
}
