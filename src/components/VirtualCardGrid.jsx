import { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getImageUri, getPriceWithMeta, formatPriceMeta, getScryfallKey, resolveTileImage } from '../lib/scryfall'
import { FolderTypeIcon } from '../icons'
import { Badge } from './UI'
import styles from './VirtualCardGrid.module.css'
import { useLongPress } from '../hooks/useLongPress'
import { useDevicePixelRatio } from '../hooks/useDevicePixelRatio'
import {
  GRID_IMG_BORDER_PX,
  MOBILE_CARD_GRID_BREAKPOINT,
  MOBILE_CARD_GRID_GAP,
  getCardGridDensity,
  getDesktopCardGridMetrics,
} from '../lib/cardGridDensity'

const NON_DRAGGABLE_IMG_PROPS = {
  draggable: false,
  onDragStart: e => e.preventDefault(),
  onContextMenu: e => e.preventDefault(),
  style: {
    WebkitUserDrag: 'none',
    WebkitTouchCallout: 'none',
    userSelect: 'none',
  },
}

// Collection keeps taller rows for its price and folder metadata, but card
// widths and horizontal gaps come from the shared full-card grid contract.
const DENSITY_BASE_ROW_HEIGHT = { cozy: 375, comfortable: 325, compact: 260 }
const OVERSCAN = 3
// Edge interactions are contained by CSS, so the virtual grid does not need a
// second horizontal inset on top of the page gutter.
const ROW_SIDE_INSET = 0
const ROW_VERTICAL_GAP = 14
const CARD_ASPECT_RATIO = 88 / 63
const CARD_INFO_HEIGHT = 92

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

function CardItem({ card, sfCard, loading, onClick, selectMode, isSelected, totalQty, onToggleSelect, onEnterSelectMode, onAdjustQty, splitState, priceSource, showPrice, cardFolders, imageWidth, dpr }) {
  const [webpFailed, setWebpFailed] = useState(false)
  const { src, fallback } = resolveTileImage(getImageUri(sfCard, 'normal'), imageWidth, dpr)
  const img = webpFailed && fallback ? fallback : src
  const displayQty = card._folder_qty ?? card.qty ?? 1
  const priceMeta = getPriceWithMeta(sfCard, card.foil, { price_source: priceSource })
  const buyPrice = parseFloat(card.purchase_price) || null
  const isBuyFallback = priceMeta == null && buyPrice != null
  const totalPriceMeta = priceMeta ? { ...priceMeta, value: priceMeta.value * displayQty } : null
  const plPct = (card.purchase_price > 0 && priceMeta?.value)
    ? ((priceMeta.value - card.purchase_price) / card.purchase_price) * 100
    : null

  const displayKey = card._displayKey || card.id
  const selQty = splitState?.get(displayKey) ?? 1

  // If card has a _displayFolder it's an expanded entry; show only that folder.
  // Otherwise show all folders from cardFolderMap.
  const folders = card._displayFolder
    ? [card._displayFolder]
    : (cardFolders?.[card.id] || [])

  const handleClick = () => {
    if (selectMode) {
      onToggleSelect?.(displayKey, totalQty)
    } else {
      onClick?.(card)
    }
  }

  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.(displayKey, totalQty)
  }, { delay: 500 })

  const { onMouseLeave: lpLeave, consumeFired, ...lpRest } = longPress

  return (
    <div
      className={`${styles.cardWrap}${isSelected ? ' ' + styles.cardSelected : ''}`}
      onClick={() => {
        if (consumeFired()) return
        handleClick()
      }}
      onMouseLeave={lpLeave}
      {...lpRest}
    >
      <div className={`${styles.imgContainer}${isSelected ? ' ' + styles.imgSelected : ''}`}>
        {img
          ? <img className={styles.img} src={img} alt={card.name} loading="lazy" decoding="async" onError={fallback && !webpFailed ? () => setWebpFailed(true) : undefined} {...NON_DRAGGABLE_IMG_PROPS} />
          : <div className={styles.imgPlaceholder}>{card.name}</div>
        }
        {card.foil && <Badge variant="foil">Foil</Badge>}
        {displayQty > 1 && <div className={styles.qty}>x{displayQty}</div>}
        {selectMode && isSelected && totalQty > 1 && (
          <div className={styles.qtyOverlay}>
            <button className={styles.qtyBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(displayKey, +1, totalQty) }}>+</button>
            <div className={styles.qtyDisplay}>{selQty} of {totalQty}</div>
            <button className={styles.qtyBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(displayKey, -1, totalQty) }}>-</button>
          </div>
        )}
      </div>

      <div className={styles.cardInfo}>
        <div className={styles.cardNameRow}>
          <div className={styles.cardName}>{card.name}</div>
          {card.foil && <span className={styles.foilMark}>✦</span>}
        </div>
        <div className={styles.cardMeta}>
          <span className={styles.setCode}>{(card.set_code || '').toUpperCase()}</span>
          {showPrice && (
            <span className={styles.priceWrap}>
              <span className={`${styles.price}${(totalPriceMeta == null && !isBuyFallback) ? ' ' + styles.priceNa : (totalPriceMeta?.isFallback || isBuyFallback ? ' ' + styles.priceFallback : '')}`}>
                {totalPriceMeta ? formatPriceMeta(totalPriceMeta) : isBuyFallback ? `${priceSource === 'tcgplayer_market' ? '$' : 'EUR '}${(buyPrice * displayQty).toFixed(2)}` : loading ? '...' : '-'}
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
  onScroll,
}) {
  const parentRef = useRef(null)
  const dpr = useDevicePixelRatio()
  const densitySpec = getCardGridDensity(density)
  const [cols, setCols] = useState(4)
  const [cardWidth, setCardWidth] = useState(densitySpec.px + GRID_IMG_BORDER_PX)
  const [columnGap, setColumnGap] = useState(densitySpec.desktopGap)
  const [rowHeight, setRowHeight] = useState(DENSITY_BASE_ROW_HEIGHT[density] || 310)
  // Actual scrollbar width (0 on overlay-scrollbar platforms), exposed as
  // --sbw so page CSS can compute "gutter minus scrollbar" insets.
  const [scrollbarWidth, setScrollbarWidth] = useState(0)

  const baseRowHeight = DENSITY_BASE_ROW_HEIGHT[density] || 310

  const measureCols = useCallback(() => {
    if (!parentRef.current) return
    // clientWidth includes padding; rows render inside the content box, so
    // measure that (Collection pads the scroller to park the scrollbar in
    // the page gutter).
    const cs = getComputedStyle(parentRef.current)
    const w = parentRef.current.clientWidth
      - (parseFloat(cs.paddingLeft) || 0)
      - (parseFloat(cs.paddingRight) || 0)
    const isMobile = w <= MOBILE_CARD_GRID_BREAKPOINT
    let nextCols
    let nextCardWidth
    let nextColumnGap

    if (isMobile) {
      nextCols = densitySpec.mobileCols
      nextColumnGap = MOBILE_CARD_GRID_GAP
      const availableWidth = Math.max(0, w - (ROW_SIDE_INSET * 2) - (nextColumnGap * (nextCols - 1)))
      nextCardWidth = availableWidth > 0 ? availableWidth / nextCols : densitySpec.px + GRID_IMG_BORDER_PX
    } else {
      const metrics = getDesktopCardGridMetrics(w, density, { sideInset: ROW_SIDE_INSET })
      nextCols = metrics.columns
      nextCardWidth = metrics.columnWidth
      nextColumnGap = metrics.columnGap
    }
    const nextRowHeight = Math.max(
      baseRowHeight,
      Math.ceil(nextCardWidth * CARD_ASPECT_RATIO + CARD_INFO_HEIGHT),
    )

    setCols(nextCols)
    setCardWidth(nextCardWidth)
    setColumnGap(nextColumnGap)
    setRowHeight(nextRowHeight)
    setScrollbarWidth(parentRef.current.offsetWidth - parentRef.current.clientWidth)
  }, [baseRowHeight, density, densitySpec])

  useEffect(() => {
    measureCols()
    const ro = new ResizeObserver(measureCols)
    if (parentRef.current) ro.observe(parentRef.current)
    return () => ro.disconnect()
  }, [measureCols])

  // Attach _totalQty to each card so CardItem knows the full qty for the adjuster.
  const cardsWithQty = useMemo(() =>
    cards.map(card => ({ ...card, _totalQty: card._folder_qty ?? card.qty ?? 1 }))
  , [cards])

  const rowCount = Math.ceil(cardsWithQty.length / cols)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight + ROW_VERTICAL_GAP,
    overscan: OVERSCAN,
  })

  return (
    <div ref={parentRef} className={styles.scroll} style={{ '--sbw': `${scrollbarWidth}px` }} onScroll={onScroll}>
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
                left: ROW_SIDE_INSET,
                right: ROW_SIDE_INSET,
                height: rowHeight,
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, minmax(0, ${cardWidth}px))`,
                justifyContent: 'start',
                columnGap,
              }}
            >
              {rowCards.map(card => {
                const displayKey = card._displayKey || card.id
                return (
                  <CardItem
                    key={displayKey}
                    card={card}
                    sfCard={sfMap?.[getScryfallKey(card)]}
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
                    cardFolders={cardFolders}
                    imageWidth={Math.max(1, cardWidth - GRID_IMG_BORDER_PX)}
                    dpr={dpr}
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
