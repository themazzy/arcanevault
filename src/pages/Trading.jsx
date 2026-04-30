import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { formatPrice, getImageUri, getInstantCache, getPrice, sfGet } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import {
  deleteCard,
  deleteDeckAllocationsByIds,
  deleteFolderCardsByIds,
  getAllDeckAllocationsForUser,
  getAllLocalFolderCards,
  getLocalCards,
  getLocalFolders,
  putCards,
  putDeckAllocations,
  putFolders,
  putFolderCards,
  replaceDeckAllocations,
  replaceLocalFolderCards,
} from '../lib/db'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { EmptyState, Modal, ProgressBar, SectionHeader } from '../components/UI'
import styles from './Trading.module.css'

const SEARCH_LIMIT = 8

function getCollectionCardName(card, sf) {
  return sf?.name || card.name || `${(card.set_code || '').toUpperCase()} #${card.collector_number || ''}`.trim()
}

function getOfferKey(item) {
  return `${item.setCode}-${item.collectorNumber}`
}

function createWantedItemId(scryfallId, foil) {
  return `${scryfallId}-${foil ? 'foil' : 'nonfoil'}`
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

function getSourceLabel(source) {
  if (!source) return 'Unplaced'
  const typeLabel = source.type === 'deck' ? 'Deck' : source.type === 'list' ? 'List' : 'Binder'
  return `${typeLabel}: ${source.name}`
}

function WarningTriangleIcon() {
  return (
    <svg
      className={styles.deckSourceIcon}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.2 14 13H2L8 2.2Z" />
      <path d="M8 5.5v3.8" />
      <circle cx="8" cy="11.2" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11.2 2.3 13.7 4.8 6 12.5 3.5 13l.5-2.5 7.2-8.2Z" />
      <path d="M10.5 3 13 5.5" />
    </svg>
  )
}

function FieldBlock({ label, value, accent = false }) {
  if (!value) return null
  return (
    <div className={styles.optionField}>
      <div className={styles.optionFieldLabel}>{label}</div>
      <div className={`${styles.optionFieldValue}${accent ? ` ${styles.optionFieldValueAccent}` : ''}`}>{value}</div>
    </div>
  )
}

function CustomPriceModal({ item, side, priceSource, onClose, onSave }) {
  const [value, setValue] = useState(item.customPrice != null ? String(item.customPrice) : '')

  return (
    <Modal onClose={onClose}>
      <div className={styles.optionPicker}>
        <h3 className={styles.optionPickerTitle}>Custom Price</h3>
        <div className={styles.customPriceTitle}>{item.name}</div>
        <div className={styles.customPriceHint}>
          {side === 'want'
            ? 'Used for trade totals and saved as the buy price.'
            : 'Used only for this trade row.'}
        </div>
        <input
          className={styles.searchInput}
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={`Enter ${formatPrice(0, priceSource).replace('0.00', '').trim()} price`}
          inputMode="decimal"
        />
        <div className={styles.customPriceActions}>
          <button
            className={styles.clearBtn}
            type="button"
            onClick={() => {
              onSave(null)
              onClose()
            }}
          >
            Clear
          </button>
          <button
            className={styles.tradeBtn}
            type="button"
            onClick={() => {
              const parsed = Number.parseFloat(value.replace(',', '.'))
              if (!Number.isFinite(parsed) || parsed < 0) return
              onSave(parsed)
              onClose()
            }}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  )
}

function SourceLabel({ source }) {
  if (!source) return null
  if (source.type === 'deck') {
    return (
      <>
        <span className={styles.deckSourceBadge}><WarningTriangleIcon />In Deck</span>
        <span>{source.name}</span>
      </>
    )
  }
  return <span>{getSourceLabel(source)}</span>
}

function buildCardFolderMap(folderRows, linkRows) {
  const folderById = Object.fromEntries((folderRows || []).map(folder => [folder.id, folder]))
  const map = {}
  for (const row of linkRows || []) {
    const folderId = row.folder_id || row.deck_id
    const folder = folderById[folderId]
    if (!folder) continue
    if (!map[row.card_id]) map[row.card_id] = []
    map[row.card_id].push({
      id: folder.id,
      name: folder.name,
      type: folder.type,
      qty: row.qty || 1,
    })
  }
  return map
}

async function fetchWantedCards(query) {
  if (!query.trim()) return []
  const json = await sfGet(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query.trim())}&order=name&unique=prints`)
  const grouped = new Map()
  for (const card of (json?.data || []).slice(0, 80)) {
    const key = card.oracle_id || card.name?.toLowerCase() || card.id
    const existing = grouped.get(key)
    if (existing) {
      existing.options.push(card)
      existing.printingCount += 1
      if (!existing.image) existing.image = getImageUri(card, 'small')
      continue
    }
    grouped.set(key, {
      id: `want-${key}`,
      name: card.name,
      image: getImageUri(card, 'small'),
      options: [card],
      printingCount: 1,
    })
  }
  return [...grouped.values()]
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .slice(0, SEARCH_LIMIT)
}

async function applyTradeResultToLocalDb(result) {
  if (!result) return
  const binder = result.binder || null
  const cards = result.cards || []
  const deletedCardIds = result.deleted_card_ids || []
  const folderCards = result.folder_cards || []
  const deletedFolderCardIds = result.deleted_folder_card_ids || []
  const deckAllocations = result.deck_allocations || []
  const deletedDeckAllocationIds = result.deleted_deck_allocation_ids || []

  if (binder) await putFolders([binder])
  if (cards.length) await putCards(cards)
  if (folderCards.length) await putFolderCards(folderCards)
  if (deckAllocations.length) await putDeckAllocations(deckAllocations)
  if (deletedFolderCardIds.length) await deleteFolderCardsByIds(deletedFolderCardIds)
  if (deletedDeckAllocationIds.length) await deleteDeckAllocationsByIds(deletedDeckAllocationIds)
  if (deletedCardIds.length) {
    await Promise.all(deletedCardIds.map(id => deleteCard(id)))
  }
}

function TradeRow({ item, side, unitPrice, totalPrice, onAdd, onSub, onRemove, onToggleFoil, onEditPrice, maxQty }) {
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
            {side === 'offer' && item.sourceName && <SourceLabel source={{ name: item.sourceName, type: item.sourceType }} />}
            {side === 'offer' && maxQty != null && <span>Available {maxQty}</span>}
            {side === 'want' && item.foil && <span>Foil</span>}
          </div>
          <div className={styles.tradePriceRow}>
            {item.qty > 1 ? (
              <>
                <span className={styles.tradeUnit}>{unitPrice != null ? formatPrice(unitPrice, item.priceSource) : 'Price unavailable'}</span>
                <span className={styles.tradeEquation}>× {item.qty} =</span>
                <span className={styles.tradeTotal}>{totalPrice != null ? formatPrice(totalPrice, item.priceSource) : '-'}</span>
              </>
            ) : (
              <span className={styles.tradeUnit}>{unitPrice != null ? formatPrice(unitPrice, item.priceSource) : 'Price unavailable'}</span>
            )}
            {onEditPrice && (
              <button className={styles.editPriceBtn} onClick={onEditPrice} type="button" title="Set custom price">
                <PencilIcon />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className={styles.tradeActions}>
        <button className={styles.qtyBtn} onClick={onSub} type="button">-</button>
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

function OptionPickerModal({ title, options, onClose, onSelect, mode, priceSource }) {
  const [query, setQuery] = useState('')

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(option => {
      const haystack = [
        option.name,
        option.setName,
        option.setCode,
        option.collectorNumber,
        option.sourceName,
        option.sourceType,
        option.foil ? 'foil' : 'nonfoil',
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [options, query])

  return (
    <Modal onClose={onClose}>
      <div className={styles.optionPicker}>
        <h3 className={styles.optionPickerTitle}>{title}</h3>
        <input
          className={styles.searchInput}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={mode === 'offer' ? 'Filter by set, collector number, or location...' : 'Filter by set or collector number...'}
        />
        <div className={styles.optionPickerList}>
          {filteredOptions.map(option => (
            (() => {
              const unitPrice = mode === 'offer'
                ? getPrice(option.sf, option.card?.foil, { price_source: priceSource, cardId: option.card?.id })
                : getPrice(option.sf, option.foil, { price_source: priceSource, cardId: option.scryfallId })
              return (
            <button
              key={option.id}
              className={styles.optionPickerItem}
              onClick={() => onSelect(option)}
              type="button"
            >
              {option.image
                ? <img src={option.image} alt="" className={styles.optionPickerImg} loading="lazy" />
                : <div className={styles.optionPickerImgPlaceholder}>No art</div>}
              <div className={styles.optionPickerMeta}>
                <div className={styles.optionPickerName}>{option.name}</div>
                <div className={styles.optionPickerFields}>
                  <FieldBlock
                    label="Set"
                    value={`${option.setName || option.setCode?.toUpperCase() || 'Unknown set'}${option.collectorNumber ? ` · #${option.collectorNumber}` : ''}`}
                  />
                  <FieldBlock
                    label="Price"
                    value={unitPrice != null ? formatPrice(unitPrice, priceSource) : 'Unavailable'}
                    accent={unitPrice != null}
                  />
                  {mode === 'offer' && (
                    <FieldBlock
                      label="Finish"
                      value={option.card?.foil ? 'Foil' : 'Non-foil'}
                      accent={!!option.card?.foil}
                    />
                  )}
                  {mode === 'offer' && (
                    <FieldBlock
                      label="Location"
                      value={(
                        <span className={styles.optionFieldInline}>
                          <SourceLabel source={{ name: option.sourceName, type: option.sourceType }} />
                        </span>
                      )}
                    />
                  )}
                  {mode === 'offer' && option.availableQty != null && (
                    <FieldBlock
                      label="Quantity"
                      value={`${option.availableQty} available`}
                      accent
                    />
                  )}
                  {mode === 'want' && (
                    <FieldBlock
                      label="Finish"
                      value={option.foil ? 'Foil' : 'Non-foil'}
                      accent={option.foil}
                    />
                  )}
                </div>
              </div>
            </button>
              )
            })()
          ))}
          {filteredOptions.length === 0 && (
            <EmptyState>No options match this filter.</EmptyState>
          )}
        </div>
      </div>
    </Modal>
  )
}

function TradeLogSection({ rows, loading, onRefresh, fmt }) {
  const [expanded, setExpanded] = useState(null)

  if (loading) return (
    <div className={styles.logEmpty}>Loading trade history…</div>
  )

  if (!rows.length) return (
    <div className={styles.logEmpty}>
      No trades recorded yet. Complete a trade on the Compare tab and it will appear here.
    </div>
  )

  return (
    <div className={styles.logList}>
      <div className={styles.logToolbar}>
        <span className={styles.logCount}>{rows.length} trade{rows.length !== 1 ? 's' : ''}</span>
        <button className={styles.logRefreshBtn} onClick={onRefresh}>Refresh</button>
      </div>
      {rows.map(row => {
        const net = (row.receiving_value ?? 0) - (row.giving_value ?? 0)
        const isOpen = expanded === row.id
        const giving = Array.isArray(row.giving) ? row.giving : []
        const receiving = Array.isArray(row.receiving) ? row.receiving : []
        const date = new Date(row.traded_at)
        const dateStr = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

        return (
          <div key={row.id} className={styles.logEntry}>
            <button className={styles.logEntryHead} onClick={() => setExpanded(isOpen ? null : row.id)}>
              <div className={styles.logEntryLeft}>
                <span className={styles.logDate}>{dateStr}</span>
                {row.partner_name && <span className={styles.logPartner}>with {row.partner_name}</span>}
              </div>
              <div className={styles.logEntryRight}>
                <div className={styles.logSides}>
                  <span className={styles.logGiving}>−{fmt(row.giving_value ?? 0)}</span>
                  <span className={styles.logSep}>·</span>
                  <span className={styles.logReceiving}>+{fmt(row.receiving_value ?? 0)}</span>
                </div>
                <span className={`${styles.logNet} ${net >= 0 ? styles.logNetPos : styles.logNetNeg}`}>
                  {net >= 0 ? '+' : ''}{fmt(net)}
                </span>
                <span className={styles.logChevron}>{isOpen ? '▲' : '▼'}</span>
              </div>
            </button>

            {isOpen && (
              <div className={styles.logEntryBody}>
                {giving.length > 0 && (
                  <div className={styles.logCardGroup}>
                    <div className={styles.logCardGroupLabel}>You gave</div>
                    {giving.map((c, i) => (
                      <div key={i} className={styles.logCardRow}>
                        <span className={styles.logCardQty}>{c.qty}×</span>
                        <span className={styles.logCardName}>{c.name}</span>
                        {c.foil && <span className={styles.logFoilTag}>FOIL</span>}
                        <span className={styles.logCardPrice}>{c.unit_price != null ? fmt(c.unit_price) : '—'}</span>
                      </div>
                    ))}
                  </div>
                )}
                {receiving.length > 0 && (
                  <div className={styles.logCardGroup}>
                    <div className={styles.logCardGroupLabel}>You received</div>
                    {receiving.map((c, i) => (
                      <div key={i} className={styles.logCardRow}>
                        <span className={styles.logCardQty}>{c.qty}×</span>
                        <span className={styles.logCardName}>{c.name}</span>
                        {c.foil && <span className={styles.logFoilTag}>FOIL</span>}
                        <span className={styles.logCardPrice}>{c.unit_price != null ? fmt(c.unit_price) : '—'}</span>
                      </div>
                    ))}
                  </div>
                )}
                {row.notes && <p className={styles.logNotes}>{row.notes}</p>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function TradingPage() {
  const { user } = useAuth()
  const { price_source, cache_ttl_h } = useSettings()
  const location = useLocation()

  const [cards, setCards] = useState([])
  const [folders, setFolders] = useState([])
  const [cardFolderMap, setCardFolderMap] = useState({})
  const [sfMap, setSfMap] = useState({})
  const [collectionLoaded, setCollectionLoaded] = useState(false)
  const [collectionLoading, setCollectionLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progLabel, setProgLabel] = useState('')
  const [collectionQuery, setCollectionQuery] = useState('')
  const [debouncedCollectionQuery, setDebouncedCollectionQuery] = useState('')
  const [wantedQuery, setWantedQuery] = useState('')
  const [wantedLoading, setWantedLoading] = useState(false)
  const [wantedError, setWantedError] = useState('')
  const [wantedResults, setWantedResults] = useState([])
  const [offerItems, setOfferItems] = useState([])
  const [wantItems, setWantItems] = useState([])
  const [tradeSaving, setTradeSaving] = useState(false)
  const [tradeError, setTradeError] = useState('')
  const [tradeMessage, setTradeMessage] = useState('')
  const [backgroundSyncing, setBackgroundSyncing] = useState(false)
  const [offerPicker, setOfferPicker] = useState(null)
  const [wantPicker, setWantPicker] = useState(null)
  const [priceEditor, setPriceEditor] = useState(null)
  const [tab, setTab] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('tab') === 'log' ? 'log' : 'compare'
  })
  const [partnerName, setPartnerName] = useState('')
  const [tradeLogRows, setTradeLogRows] = useState([])
  const [tradeLogLoading, setTradeLogLoading] = useState(false)

  const cardsById = useMemo(
    () => Object.fromEntries(cards.map(card => [card.id, card])),
    [cards]
  )

  const applyCollectionData = useCallback((nextCards, nextFolders, nextFolderCards, nextDeckAllocations) => {
    setCards(nextCards || [])
    setFolders(nextFolders || [])
    setCardFolderMap(buildCardFolderMap(nextFolders || [], [...(nextFolderCards || []), ...(nextDeckAllocations || [])]))
    setCollectionLoaded(true)
  }, [])

  const hydrateLocalCollection = useCallback(async () => {
    setCollectionLoading(true)
    setTradeError('')
    setProgress(5)
    setProgLabel('Loading local collection...')

    try {
      const [localCards, localFolders] = await Promise.all([
        getLocalCards(user.id),
        getLocalFolders(user.id),
      ])
      const nonDeckIds = localFolders.filter(folder => folder.type !== 'deck').map(folder => folder.id)
      const [localFolderCards, localDeckAllocations] = await Promise.all([
        nonDeckIds.length ? getAllLocalFolderCards(nonDeckIds) : Promise.resolve([]),
        getAllDeckAllocationsForUser(user.id),
      ])

      applyCollectionData(localCards, localFolders, localFolderCards, localDeckAllocations)
      setProgress(35)
      setProgLabel(navigator.onLine ? 'Syncing collection...' : '')
      return {
        cards: localCards,
        folders: localFolders,
        folderCards: localFolderCards,
        deckAllocations: localDeckAllocations,
      }
    } catch (err) {
      setTradeError(err.message || 'Failed to load local collection.')
      return null
    } finally {
      if (!navigator.onLine) {
        setCollectionLoading(false)
        setBackgroundSyncing(false)
        setProgress(100)
        setProgLabel('')
      }
    }
  }, [applyCollectionData, user.id])

  const syncRemoteCollection = useCallback(async () => {
    if (!navigator.onLine) return

    setCollectionLoading(true)
    setBackgroundSyncing(true)
    setProgress(current => Math.max(current, 40))
    setProgLabel('Syncing collection...')

    try {
      let cardFrom = 0
      const fetchedCards = []
      while (true) {
        const { data, error } = await sb.from('cards')
          .select('*')
          .eq('user_id', user.id)
          .order('name')
          .range(cardFrom, cardFrom + 999)
        if (error) throw error
        if (!data?.length) break
        fetchedCards.push(...data)
        if (data.length < 1000) break
        cardFrom += 1000
      }

      const { data: fetchedFolders, error: foldersError } = await sb.from('folders')
        .select('id,name,type,description,updated_at,user_id')
        .eq('user_id', user.id)
        .order('name')
      if (foldersError) throw foldersError

      const binderOrListIds = (fetchedFolders || []).filter(folder => folder.type !== 'deck').map(folder => folder.id)
      const deckIds = (fetchedFolders || []).filter(folder => folder.type === 'deck').map(folder => folder.id)

      let fetchedFolderCards = []
      let folderCardFrom = 0
      while (binderOrListIds.length) {
        const { data, error } = await sb.from('folder_cards')
          .select('id,card_id,folder_id,qty,updated_at')
          .in('folder_id', binderOrListIds)
          .range(folderCardFrom, folderCardFrom + 999)
        if (error) throw error
        if (!data?.length) break
        fetchedFolderCards.push(...data)
        if (data.length < 1000) break
        folderCardFrom += 1000
      }

      let fetchedDeckAllocations = []
      let deckAllocationFrom = 0
      while (deckIds.length) {
        const { data, error } = await sb.from('deck_allocations')
          .select('id,card_id,deck_id,qty,user_id,updated_at')
          .eq('user_id', user.id)
          .in('deck_id', deckIds)
          .range(deckAllocationFrom, deckAllocationFrom + 999)
        if (error) throw error
        if (!data?.length) break
        fetchedDeckAllocations.push(...data)
        if (data.length < 1000) break
        deckAllocationFrom += 1000
      }

      await putCards(fetchedCards)
      await putFolders(fetchedFolders || [])
      await replaceLocalFolderCards(binderOrListIds, fetchedFolderCards)
      await replaceDeckAllocations(deckIds, fetchedDeckAllocations)

      applyCollectionData(fetchedCards, fetchedFolders || [], fetchedFolderCards, fetchedDeckAllocations)
      setProgress(100)
      setProgLabel('')
    } catch (err) {
      setTradeError(err.message || 'Failed to sync collection.')
    } finally {
      setBackgroundSyncing(false)
      setCollectionLoading(false)
    }
  }, [applyCollectionData, user.id])

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setDebouncedCollectionQuery(collectionQuery)
    }, 120)
    return () => clearTimeout(timeoutId)
  }, [collectionQuery])

  useEffect(() => {
    let cancelled = false

    getInstantCache(cache_ttl_h * 3600000).then(map => {
      if (!cancelled && map) setSfMap(map)
    })

    hydrateLocalCollection().then(() => {
      if (!cancelled && navigator.onLine) {
        void syncRemoteCollection()
      }
    })

    return () => {
      cancelled = true
    }
  }, [cache_ttl_h, hydrateLocalCollection, syncRemoteCollection])

  useEffect(() => {
    let cancelled = false
    const timeoutId = setTimeout(async () => {
      if (!wantedQuery.trim()) {
        if (!cancelled) {
          setWantedResults([])
          setWantedError('')
          setWantedLoading(false)
        }
        return
      }

      if (!cancelled) {
        setWantedLoading(true)
        setWantedError('')
      }

      try {
        const results = await fetchWantedCards(wantedQuery)
        if (!cancelled) {
          setWantedResults(results)
        }
      } catch (err) {
        if (!cancelled) {
          setWantedResults([])
          setWantedError(err.message || 'Failed to search Scryfall.')
        }
      } finally {
        if (!cancelled) setWantedLoading(false)
      }
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [wantedQuery])

  const tradeSearchRows = useMemo(() => {
    const rows = []
    for (const card of cards) {
      const sources = (cardFolderMap[card.id] || []).filter(source => (source.qty || 0) > 0)
      for (const source of sources) {
        rows.push({
          id: `${card.id}:${source.type}:${source.id}`,
          cardId: card.id,
          name: card.name || '',
          setCode: card.set_code || '',
          collectorNumber: card.collector_number || '',
          foil: !!card.foil,
          sourceId: source.id,
          sourceType: source.type,
          sourceName: source.name || '',
          qty: source.qty || 1,
        })
      }
    }
    return rows
  }, [cardFolderMap, cards])

  const offerSearchResults = useMemo(() => {
    if (!collectionLoaded) return []
    const q = debouncedCollectionQuery.trim().toLowerCase()
    if (!q) return []

    const grouped = new Map()
    for (const row of tradeSearchRows) {
      const haystack = [
        row.name,
        row.setCode,
        row.collectorNumber,
        row.sourceName,
        row.sourceType,
      ].filter(Boolean).join(' ').toLowerCase()

      if (!haystack.includes(q)) continue

      const card = cardsById[row.cardId]
      if (!card) continue
      const sf = sfMap[`${row.setCode}-${row.collectorNumber}`]
      const displayName = sf?.name || row.name
      const groupKey = displayName.toLowerCase()
      const option = {
        id: row.id,
        card,
        sf,
        name: displayName,
        image: getImageUri(sf, 'small'),
        setName: sf?.set_name || row.setCode?.toUpperCase() || '',
        setCode: row.setCode,
        collectorNumber: row.collectorNumber,
        source: {
          id: row.sourceId,
          type: row.sourceType,
          name: row.sourceName,
          qty: row.qty,
        },
        availableQty: row.qty,
        sourceId: row.sourceId,
        sourceType: row.sourceType,
        sourceName: row.sourceName,
      }

      const existing = grouped.get(groupKey)
      if (existing) {
        existing.options.push(option)
        existing.printingKeys.add(`${row.setCode}-${row.collectorNumber}`)
        existing.sourceCount += 1
        if (!existing.image && option.image) existing.image = option.image
      } else {
        grouped.set(groupKey, {
          id: `offer-${groupKey}`,
          name: displayName,
          image: option.image,
          options: [option],
          printingKeys: new Set([`${row.setCode}-${row.collectorNumber}`]),
          sourceCount: 1,
        })
      }
    }

    return [...grouped.values()]
      .map(group => ({
        ...group,
        printingCount: group.printingKeys.size,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [cardsById, collectionLoaded, debouncedCollectionQuery, sfMap, tradeSearchRows])

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

  const ensureCardsData = useCallback(async (targetCards) => {
    const missing = (targetCards || []).filter(card => card && !sfMap[`${card.set_code}-${card.collector_number}`])
    if (!missing.length) return
    const map = await loadCardMapWithSharedPrices(missing)
    if (map) setSfMap(prev => ({ ...prev, ...map }))
  }, [sfMap])

  useEffect(() => {
    const visibleCards = [...new Map(
      offerSearchResults.slice(0, 24).map(group => {
        const option = group.options[0]
        return option ? [option.card.id, option.card] : null
      }).filter(Boolean)
    ).values()]
    if (!visibleCards.length) return
    void ensureCardsData(visibleCards)
  }, [ensureCardsData, offerSearchResults])

  useEffect(() => {
    const selectedCards = offerItems
      .map(item => cardsById[item.cardId])
      .filter(Boolean)
    if (!selectedCards.length) return
    void ensureCardsData(selectedCards)
  }, [cardsById, ensureCardsData, offerItems])

  const addOfferCard = async (entry) => {
    const { card, source } = entry
    const sf = entry.sf || await ensureOfferCardData(card)
    setOfferItems(prev => {
      const existing = prev.find(item => item.id === entry.id)
      const maxQty = source.qty || 1
      if (existing) {
        if (existing.qty >= maxQty) return prev
        return prev.map(item => item.id === entry.id ? { ...item, qty: item.qty + 1 } : item)
      }
      return [...prev, {
        id: entry.id,
        cardId: card.id,
        name: getCollectionCardName(card, sf),
        setName: sf?.set_name || card.set_code?.toUpperCase() || '',
        setCode: card.set_code,
        collectorNumber: card.collector_number,
        image: getImageUri(sf, 'small'),
        foil: !!card.foil,
        qty: 1,
        maxQty,
        sourceId: source.id,
        sourceType: source.type,
        sourceName: source.name,
        priceSource: price_source,
        customPrice: null,
      }]
    })
  }

  const handleOfferSearchSelect = async (group) => {
    const uniqueCards = [...new Map(group.options.map(option => [option.card.id, option.card])).values()]
    await ensureCardsData(uniqueCards)
    const options = group.options
      .map(option => {
        const card = option.card
        const sf = sfMap[`${card.set_code}-${card.collector_number}`] || option.sf
        return {
          ...option,
          sf,
          image: getImageUri(sf, 'small') || option.image,
          setName: sf?.set_name || option.setName,
          name: sf?.name || option.name,
        }
      })
      .sort((a, b) => (a.setName || '').localeCompare(b.setName || '') || (a.sourceName || '').localeCompare(b.sourceName || ''))

    if (options.length === 1) {
      await addOfferCard(options[0])
      return
    }

    setOfferPicker({
      title: `Choose Printing and Location for ${group.name}`,
      options,
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
    const itemId = createWantedItemId(sfCard.id, false)
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
        customPrice: null,
      }]
    })
  }

  const handleWantSearchSelect = (group) => {
    const options = [...group.options]
      .sort((a, b) => {
        if (!!a.foil !== !!b.foil) return a.foil ? -1 : 1
        return (a.set_name || '').localeCompare(b.set_name || '') || (a.collector_number || '').localeCompare(b.collector_number || '')
      })
      .map(card => ({
        id: `${card.id}-${card.foil ? 'foil' : 'nonfoil'}`,
        scryfallId: card.id,
        name: card.name,
        setName: card.set_name,
        setCode: card.set,
        collectorNumber: card.collector_number,
        image: getImageUri(card, 'small'),
        foil: false,
        sf: card,
      }))

    if (options.length === 1) {
      addWantedCard(options[0].sf)
      return
    }

    setWantPicker({
      title: `Choose Printing for ${group.name}`,
      options,
    })
  }

  const updateWantItem = (id, updater) => {
    setWantItems(prev => prev.flatMap(item => {
      if (item.id !== id) return [item]
      const next = updater(item)
      return next && next.qty > 0 ? [next] : []
    }))
  }

  const toggleWantItemFoil = (id) => {
    setWantItems(prev => {
      const current = prev.find(item => item.id === id)
      if (!current) return prev

      const nextFoil = !current.foil
      const nextId = createWantedItemId(current.scryfallId, nextFoil)
      const remaining = prev.filter(item => item.id !== id)
      const merged = remaining.find(item => item.id === nextId)

      if (merged) {
        return remaining.map(item => item.id === nextId
          ? { ...item, qty: item.qty + current.qty, foil: nextFoil, priceSource: price_source }
          : item
        )
      }

      return [...remaining, {
        ...current,
        id: nextId,
        foil: nextFoil,
        priceSource: price_source,
      }]
    })
  }

  const getOfferUnitPrice = useCallback((item) => {
    if (item.customPrice != null) return item.customPrice
    const sf = sfMap[getOfferKey(item)]
    return getPrice(sf, item.foil, { price_source, cardId: item.cardId })
  }, [price_source, sfMap])

  const getWantUnitPrice = useCallback((item) => {
    if (item.customPrice != null) return item.customPrice
    return getPrice(item.sf, item.foil, { price_source, cardId: item.scryfallId })
  }, [price_source])

  const setOfferCustomPrice = (id, customPrice) => {
    setOfferItems(prev => prev.map(item => item.id === id ? { ...item, customPrice } : item))
  }

  const setWantCustomPrice = (id, customPrice) => {
    setWantItems(prev => prev.map(item => item.id === id ? { ...item, customPrice } : item))
  }

  const offerTotal = useMemo(() => sumTradeValue(offerItems, getOfferUnitPrice), [offerItems, getOfferUnitPrice])
  const wantTotal = useMemo(() => sumTradeValue(wantItems, getWantUnitPrice), [wantItems, getWantUnitPrice])
  const offerUnpriced = useMemo(() => countUnpriced(offerItems, getOfferUnitPrice), [offerItems, getOfferUnitPrice])
  const wantUnpriced = useMemo(() => countUnpriced(wantItems, getWantUnitPrice), [wantItems, getWantUnitPrice])
  const delta = wantTotal - offerTotal

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const urlTab = params.get('tab') === 'log' ? 'log' : 'compare'
    setTab(urlTab)
  }, [location.search])

  const loadTradeLog = useCallback(async () => {
    setTradeLogLoading(true)
    try {
      const { data, error } = await sb.from('trade_log')
        .select('*')
        .eq('user_id', user.id)
        .order('traded_at', { ascending: false })
        .limit(100)
      if (error) throw error
      setTradeLogRows(data || [])
    } catch (err) {
      console.error('[Trading] log load:', err?.message)
    } finally {
      setTradeLogLoading(false)
    }
  }, [user.id])

  useEffect(() => {
    if (tab === 'log') loadTradeLog()
  }, [tab, loadTradeLog])

  const settlement = useMemo(() => {
    if (!offerItems.length && !wantItems.length) return 'Add cards to at least one side to compare the trade.'
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
      const currency = price_source === 'tcgplayer_market' ? 'USD' : 'EUR'
      const offerPayload = offerItems.map(item => ({
        card_id: item.cardId,
        source_id: item.sourceId,
        source_type: item.sourceType,
        qty: item.qty,
      }))
      const wantPayload = wantItems.map(item => ({
        scryfall_id: item.scryfallId,
        name: item.name,
        set_code: item.setCode,
        collector_number: item.collectorNumber,
        foil: item.foil,
        qty: item.qty,
        purchase_price: getWantUnitPrice(item) ?? 0,
        currency,
      }))

      const { data, error } = await sb.rpc('commit_trade', {
        p_offer_items: offerPayload,
        p_want_items: wantPayload,
      })
      if (error) throw error

      const result = typeof data === 'string' ? JSON.parse(data) : data
      await applyTradeResultToLocalDb(result)
      if (navigator.onLine) await syncRemoteCollection()
      else await hydrateLocalCollection()

      // Write trade log entry (non-fatal if it fails)
      try {
        const giving = offerItems.map(item => ({
          name: getCollectionCardName(cardsById[item.cardId], item.sf),
          set_code: item.setCode,
          collector_number: item.collectorNumber,
          foil: item.foil ?? false,
          qty: item.qty,
          unit_price: getOfferUnitPrice(item) ?? null,
        }))
        const receiving = wantItems.map(item => ({
          name: item.name,
          set_code: item.setCode,
          collector_number: item.collectorNumber,
          foil: item.foil ?? false,
          qty: item.qty,
          unit_price: getWantUnitPrice(item) ?? null,
        }))
        await sb.from('trade_log').insert({
          user_id: user.id,
          partner_name: partnerName.trim() || null,
          giving,
          receiving,
          giving_value: offerTotal,
          receiving_value: wantTotal,
        })
      } catch (logErr) {
        console.error('[Trading] log write failed:', logErr?.message)
      }

      setOfferItems([])
      setWantItems([])
      setCollectionQuery('')
      setWantedQuery('')
      setWantedResults([])
      setWantedError('')
      setOfferPicker(null)
      setWantPicker(null)
      setPartnerName('')
      setTradeMessage('Trade saved. Received cards were moved to the Recently Traded binder.')
    } catch (err) {
      setTradeError(err.message || 'Failed to save trade.')
    } finally {
      setTradeSaving(false)
    }
  }

  return (
    <div className={styles.page}>
      <SectionHeader title="Trading" />

      <div className={styles.tabs}>
        <button className={`${styles.tabBtn} ${tab === 'compare' ? styles.tabBtnActive : ''}`} onClick={() => setTab('compare')}>Compare</button>
        <button className={`${styles.tabBtn} ${tab === 'log' ? styles.tabBtnActive : ''}`} onClick={() => setTab('log')}>Trade Log</button>
      </div>

      {tab === 'log' ? (
        <TradeLogSection rows={tradeLogRows} loading={tradeLogLoading} onRefresh={loadTradeLog} fmt={v => formatPrice(v, price_source)} />
      ) : <>

      <div className={styles.intro}>
        Build both sides of a trade, compare live values, and choose the exact binder or deck copies you are trading away.
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
          <input
            className={styles.partnerInput}
            placeholder="Trading with… (optional)"
            value={partnerName}
            onChange={e => setPartnerName(e.target.value)}
          />
          <button
            className={styles.tradeBtn}
            type="button"
            disabled={tradeSaving || (!offerItems.length && !wantItems.length)}
            onClick={handleTrade}
          >
            {tradeSaving ? 'Saving trade...' : 'Complete Trade'}
          </button>
        </div>
      </div>

      <div className={styles.tradeGrid}>
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <div>
              <h3 className={styles.panelTitle}>You give</h3>
              <div className={styles.panelDesc}>Each result is tied to a specific binder, list, or collection deck source.</div>
            </div>
            {offerItems.length > 0 && (
              <button className={styles.clearBtn} onClick={() => setOfferItems([])} type="button">Clear</button>
            )}
          </div>

          <input
            className={styles.searchInput}
            value={collectionQuery}
            onChange={e => setCollectionQuery(e.target.value)}
            placeholder="Search your collection by name, set, or collector number..."
          />

          {!collectionQuery.trim() && !collectionLoaded && (
            <EmptyState>Collection cards will load when you start typing here.</EmptyState>
          )}

          {collectionLoading && !collectionLoaded && (
            <ProgressBar value={progress} label={progLabel || 'Loading collection...'} />
          )}

          {backgroundSyncing && collectionLoaded && (
              <div className={styles.searchState}>Local results ready. Syncing latest collection data...</div>
          )}

          {collectionQuery.trim() && collectionLoaded && (
            <>
              {offerSearchResults.length > 0 && <div className={styles.listLabel}>Search results</div>}
              <div className={styles.selectorList}>
                {offerSearchResults.slice(0, 80).map(group => {
                  const preview = group.options[0]
                  const previewCard = preview?.card
                  const previewSf = previewCard ? sfMap[`${previewCard.set_code}-${previewCard.collector_number}`] || preview.sf : null
                  const selectedQty = group.options.reduce((sum, option) => sum + (offerQtyById[option.id] || 0), 0)
                  const foilCount = group.options.filter(opt => !!opt.card?.foil).length
                  return (
                    <button
                      key={group.id}
                      className={styles.selectorItem}
                      onClick={() => handleOfferSearchSelect(group)}
                      type="button"
                    >
                      {group.image || getImageUri(previewSf, 'small')
                        ? <img src={group.image || getImageUri(previewSf, 'small')} alt="" className={styles.selectorImg} loading="lazy" />
                        : <div className={styles.selectorImgPlaceholder}>No art</div>}
                      <div className={styles.selectorMeta}>
                        <div className={styles.selectorName}>{group.name}</div>
                        <div className={styles.selectorSub}>
                          <span>{group.printingCount} printing{group.printingCount !== 1 ? 's' : ''}</span>
                          <span>{group.sourceCount} location{group.sourceCount !== 1 ? 's' : ''}</span>
                          {foilCount > 0 && <span className={styles.foilBadge}>✦ {foilCount === group.options.length ? 'Foil' : `${foilCount} foil`}</span>}
                        </div>
                      </div>
                      <div className={styles.selectorAside}>
                        <div className={styles.selectorPick}>{selectedQty > 0 ? `${selectedQty} selected` : 'Choose'}</div>
                      </div>
                    </button>
                  )
                })}
                {collectionLoaded && offerSearchResults.length === 0 && (
                  <EmptyState>No placed collection cards match this search.</EmptyState>
                )}
              </div>
            </>
          )}

          {(offerItems.length > 0 || !collectionQuery.trim()) && (
            <div className={styles.listLabel}>{offerItems.length > 0 ? 'Selected' : 'Your cards'}</div>
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
                  onEditPrice={() => setPriceEditor({ side: 'offer', item })}
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
              <div className={styles.panelDesc}>Search Scryfall and add the printings you expect to receive.</div>
            </div>
            {wantItems.length > 0 && (
              <button className={styles.clearBtn} onClick={() => setWantItems([])} type="button">Clear</button>
            )}
          </div>

          <input
            className={styles.searchInput}
            value={wantedQuery}
            onChange={e => setWantedQuery(e.target.value)}
            placeholder="Search any card or printing you want..."
          />

          {(wantedLoading || wantedResults.length > 0 || (!wantedLoading && wantedError)) && (
            <>
              {wantedResults.length > 0 && !wantedLoading && <div className={styles.listLabel}>Search results</div>}
              <div className={styles.selectorList}>
                {wantedLoading && <div className={styles.searchState}>Searching Scryfall...</div>}
                {!wantedLoading && wantedError && <div className={styles.searchState}>{wantedError}</div>}
                {!wantedLoading && !wantedError && wantedResults.map(group => (
                  <button
                    key={group.id}
                    className={styles.selectorItem}
                    onClick={() => handleWantSearchSelect(group)}
                    type="button"
                  >
                    {group.image
                      ? <img src={group.image} alt="" className={styles.selectorImg} loading="lazy" />
                      : <div className={styles.selectorImgPlaceholder}>No art</div>}
                    <div className={styles.selectorMeta}>
                      <div className={styles.selectorName}>{group.name}</div>
                      <div className={styles.selectorSub}>
                        <span>{group.printingCount} printing{group.printingCount !== 1 ? 's' : ''} available</span>
                      </div>
                    </div>
                    <div className={styles.selectorAside}>
                      <div className={styles.selectorPick}>Choose</div>
                    </div>
                  </button>
                ))}
                {!wantedLoading && !wantedError && wantedQuery.trim() && wantedResults.length === 0 && (
                  <EmptyState>No Scryfall results for this search.</EmptyState>
                )}
              </div>
            </>
          )}

          {(wantItems.length > 0 || !wantedQuery.trim()) && (
            <div className={styles.listLabel}>{wantItems.length > 0 ? 'Selected' : 'Cards you want'}</div>
          )}
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
                  onEditPrice={() => setPriceEditor({ side: 'want', item })}
                  onAdd={() => updateWantItem(item.id, current => ({ ...current, qty: current.qty + 1 }))}
                  onSub={() => updateWantItem(item.id, current => current.qty > 1 ? { ...current, qty: current.qty - 1 } : null)}
                  onRemove={() => updateWantItem(item.id, () => null)}
                  onToggleFoil={() => toggleWantItemFoil(item.id)}
                />
              )
            })}
          </div>
        </section>
      </div>

      {offerPicker && (
        <OptionPickerModal
          title={offerPicker.title}
          options={offerPicker.options}
          mode="offer"
          priceSource={price_source}
          onClose={() => setOfferPicker(null)}
          onSelect={async (option) => {
            await addOfferCard(option)
            setOfferPicker(null)
          }}
        />
      )}

      {wantPicker && (
        <OptionPickerModal
          title={wantPicker.title}
          options={wantPicker.options}
          mode="want"
          priceSource={price_source}
          onClose={() => setWantPicker(null)}
          onSelect={(option) => {
            addWantedCard(option.sf)
            setWantPicker(null)
          }}
        />
      )}

      {priceEditor && (
        <CustomPriceModal
          item={priceEditor.item}
          side={priceEditor.side}
          priceSource={price_source}
          onClose={() => setPriceEditor(null)}
          onSave={(customPrice) => {
            if (priceEditor.side === 'offer') setOfferCustomPrice(priceEditor.item.id, customPrice)
            else setWantCustomPrice(priceEditor.item.id, customPrice)
          }}
        />
      )}
      </>}
    </div>
  )
}
