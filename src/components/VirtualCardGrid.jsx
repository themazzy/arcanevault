import { useRef, useCallback, useEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getImageUri, getPriceWithMeta, formatPriceMeta } from '../lib/scryfall'
import { Badge } from './UI'
import { FolderTypeIcon } from './Icons'
import styles from './VirtualCardGrid.module.css'
import { useLongPress } from '../hooks/useLongPress'

const DENSITY_MIN_WIDTH   = { cozy: 210, comfortable: 168, compact: 128 }
const DENSITY_CARD_HEIGHT = { cozy: 375, comfortable: 325, compact: 260 }
const OVERSCAN = 3


const TYPE_COLOR  = { binder: 'rgba(201,168,76,0.18)', deck: 'rgba(138,111,196,0.18)', list: 'rgba(100,180,100,0.15)' }
const TYPE_BORDER = { binder: 'rgba(201,168,76,0.35)', deck: 'rgba(138,111,196,0.35)', list: 'rgba(100,180,100,0.3)' }

function FolderTags({ folders }) {
  if (!folders?.length) return null
  const visible = folders.slice(0, 2)
  const extra   = folders.length - visible.length
  return (
    <div className={styles.folderTags}>
      {visible.map((f, i) => (
        <span key={i} className={styles.folderTag}
          style={{ background: TYPE_COLOR[f.type], borderColor: TYPE_BORDER[f.type] }}
          title={`${f.type}: ${f.name}`}
        >
          <FolderTypeIcon type={f.type} size={11} />{' '}{f.name}
        </span>
      ))}
      {extra > 0 && <span className={styles.folderTagMore}>+{extra}</span>}
    </div>
  )
}

function CardItem({ card, sfCard, loading, onClick, selectMode, isSelected, totalQty, onToggleSelect, onEnterSelectMode, onAdjustQty, splitState, priceSource, showPrice, density, cardFolders }) {
  const img     = getImageUri(sfCard, 'normal')
  const priceMeta = getPriceWithMeta(sfCard, card.foil, { price_source: priceSource })
  const buyPrice = parseFloat(card.purchase_price) || null
  const isBuyFallback = priceMeta == null && buyPrice != null
  const plPct = (card.purchase_price > 0 && priceMeta?.value)
    ? ((priceMeta.value - card.purchase_price) / card.purchase_price) * 100
    : null

  const selQty = splitState?.get(card.id) ?? 1

  // If card has a _displayFolder it's an expanded entry — show only that folder
  // Otherwise show all folders from cardFolderMap
  const folders = card._displayFolder
    ? [card._displayFolder]
    : (cardFolders?.[card.id] || [])

  const handleClick = () => {
    if (selectMode) {
      onToggleSelect?.(card._displayKey || card.id, totalQty)
    } else {
      onClick?.(card)
    }
  }

  const longPress = useLongPress(() => {
    if (!selectMode) onEnterSelectMode?.()
  }, { delay: 500 })

  const { onMouseLeave: lpLeave, ...lpRest } = longPress

  return (
    <div
      className={`${styles.cardWrap}${isSelected ? ' ' + styles.cardSelected : ''}`}
      onClick={handleClick}
      onMouseLeave={lpLeave}
      {...lpRest}
    >
      <div className={`${styles.imgContainer}${isSelected ? ' ' + styles.imgSelected : ''}`}>
        {img
          ? <img className={styles.img} src={img} alt={card.name} loading="lazy" decoding="async" />
          : <div className={styles.imgPlaceholder}>{card.name}</div>
        }
        {card.foil && <div style={{ position: 'absolute', top: 5, left: 5 }}><Badge variant="foil">Foil</Badge></div>}
        {card.qty > 1 && !card._multiFolder && <div className={styles.qty}>×{card.qty}</div>}
        {selectMode && isSelected && totalQty > 1 && (
          <div className={styles.qtyOverlay}>
            <button className={styles.qtyBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(card.id, +1, totalQty) }}>+</button>
            <div className={styles.qtyDisplay}>{selQty} of {totalQty}</div>
            <button className={styles.qtyBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(card.id, -1, totalQty) }}>−</button>
          </div>
        )}
      </div>

      <div className={styles.cardInfo}>
        <div className={styles.cardName}>{card.name}</div>
        <div className={styles.cardMeta}>
          <span className={styles.setCode}>{(card.set_code || '').toUpperCase()}</span>
          {showPrice && (
            <span className={styles.priceWrap}>
              <span className={`${styles.price}${(priceMeta == null && !isBuyFallback) ? ' ' + styles.priceNa : (priceMeta?.isFallback || isBuyFallback ? ' ' + styles.priceFallback : '')}`}>
                {priceMeta ? formatPriceMeta(priceMeta) : isBuyFallback ? `${priceSource === 'tcgplayer_market' ? '$' : '€'}${buyPrice.toFixed(2)}` : loading ? '…' : '—'}
              </span>
              {plPct != null && (
                <span className={`${styles.pricePct} ${plPct >= 0 ? styles.pricePctUp : styles.pricePctDown}`}>
                  ({plPct >= 0 ? '+' : ''}{plPct.toFixed(1)}%)
                </span>
              )}
            </span>
          )}
        </div>
        <FolderTags folders={folders} />
      </div>
    </div>
  )
}

export default function VirtualCardGrid({
  cards, sfMap, loading, onSelect,
  selectMode, selected, onToggleSelect, onEnterSelectMode,
  splitState, onAdjustQty,
  priceSource = 'cardmarket_trend',
  showPrice = true, density = 'comfortable',
  cardFolders,
}) {
  const parentRef = useRef(null)
  const colsRef   = useRef(4)

  const minW  = DENSITY_MIN_WIDTH[density]   || 168
  const cardH = DENSITY_CARD_HEIGHT[density] || 310

  const measureCols = useCallback(() => {
    if (!parentRef.current) return
    const w = parentRef.current.offsetWidth
    colsRef.current = Math.max(1, Math.floor(w / minW))
  }, [minW])

  useEffect(() => {
    measureCols()
    const ro = new ResizeObserver(measureCols)
    if (parentRef.current) ro.observe(parentRef.current)
    return () => ro.disconnect()
  }, [measureCols])

  // Attach _totalQty to each card so CardItem knows the full qty for the adjuster
  const cardsWithQty = useMemo(() =>
    cards.map(card => ({ ...card, _totalQty: card.qty || 1 }))
  , [cards])

  const cols    = colsRef.current
  const rowCount = Math.ceil(cardsWithQty.length / cols)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => cardH + 14,
    overscan: OVERSCAN,
  })

  return (
    <div ref={parentRef} className={styles.scroll}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(vRow => {
          const startIdx = vRow.index * cols
          const rowCards = cardsWithQty.slice(startIdx, startIdx + cols)
          return (
            <div
              key={vRow.key}
              style={{
                position: 'absolute',
                top: vRow.start,
                left: 0, right: 0,
                height: cardH,
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gap: 14,
              }}
            >
              {rowCards.map(card => {
                const displayKey = card._displayKey || card.id
                return (
                  <CardItem
                    key={displayKey}
                    card={card}
                    sfCard={sfMap?.[`${card.set_code}-${card.collector_number}`]}
                    loading={loading}
                    onClick={onSelect}
                    selectMode={selectMode}
                    isSelected={selectMode && selected?.has(card._displayKey || card.id)}
                    totalQty={card._totalQty}
                    onToggleSelect={onToggleSelect}
                    onEnterSelectMode={onEnterSelectMode}
                    onAdjustQty={onAdjustQty}
                    splitState={splitState}
                    priceSource={priceSource}
                    showPrice={showPrice}
                    density={density}
                    cardFolders={cardFolders}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
