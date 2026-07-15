import { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getImageUri, getPriceWithMeta, formatPriceMeta, getScryfallKey, resolveTileImage } from '../lib/scryfall'
import { FolderTypeIcon } from './Icons'
import { Badge } from './UI'
import styles from './VirtualCardGrid.module.css'
import { useLongPress } from '../hooks/useLongPress'
import { useDevicePixelRatio } from '../hooks/useDevicePixelRatio'

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

// Tiles are capped at these widths rather than stretching to fill the row. The
// browser resamples an image from a pre-filtered mipmap level, so a tile at an
// arbitrary width undersamples and shimmers; these widths are mip levels of the
// tier they get served at (see DENSITY_IMAGE in CardBrowserViews, which these
// mirror). Leftover row width becomes margin instead of stretch.
const DENSITY_MAX_WIDTH = { cozy: 244, comfortable: 146, compact: 122 }
const DENSITY_MIN_WIDTH = { cozy: 210, comfortable: 130, compact: 112 }
const DENSITY_BASE_ROW_HEIGHT = { cozy: 375, comfortable: 325, compact: 260 }
const OVERSCAN = 3
// Must leave room for the selection outline (2px + 2px offset) and the hover
// zoom (scale 1.025) on edge columns — the scroll container clips overflow-x.
const ROW_SIDE_INSET = 10
const ROW_GAP = 14
const CARD_ASPECT_RATIO = 88 / 63
const CARD_INFO_HEIGHT = 92
const MOBILE_GRID_BREAKPOINT = 430
const MOBILE_DENSITY_COLS = { cozy: 1, comfortable: 2, compact: 3 }

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

function CardItem({ card, sfCard, loading, onClick, selectMode, isSelected, totalQty, onToggleSelect, onEnterSelectMode, onAdjustQty, splitState, priceSource, showPrice, cardFolders, cardWidth, dpr }) {
  const [webpFailed, setWebpFailed] = useState(false)
  const { src, fallback } = resolveTileImage(getImageUri(sfCard, 'normal'), cardWidth, dpr)
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
  const [cols, setCols] = useState(4)
  const [cardWidth, setCardWidth] = useState(DENSITY_MAX_WIDTH[density] || 146)
  const [rowHeight, setRowHeight] = useState(DENSITY_BASE_ROW_HEIGHT[density] || 310)

  const minW  = DENSITY_MIN_WIDTH[density]   || 130
  const maxW  = DENSITY_MAX_WIDTH[density]   || 146
  const baseRowHeight = DENSITY_BASE_ROW_HEIGHT[density] || 310

  const measureCols = useCallback(() => {
    if (!parentRef.current) return
    const w = parentRef.current.offsetWidth
    const isMobile = w <= MOBILE_GRID_BREAKPOINT
    const nextCols = isMobile
      ? (MOBILE_DENSITY_COLS[density] || 2)
      : Math.max(1, Math.floor(w / minW))

    const availableWidth = Math.max(0, w - (ROW_SIDE_INSET * 2) - (ROW_GAP * (nextCols - 1)))
    const stretched = availableWidth > 0 ? availableWidth / nextCols : minW
    // Cap on desktop so tiles land on a mip level instead of stretching to an
    // arbitrary width. Mobile keeps stretching: its column count is fixed, so a
    // cap would just strand a wide gutter, and at DPR 2-3 the served tier is
    // large enough that the ratio stays shallow anyway.
    const nextCardWidth = isMobile ? stretched : Math.min(stretched, maxW)
    const nextRowHeight = Math.max(
      baseRowHeight,
      Math.ceil(nextCardWidth * CARD_ASPECT_RATIO + CARD_INFO_HEIGHT),
    )

    setCols(nextCols)
    setCardWidth(nextCardWidth)
    setRowHeight(nextRowHeight)
  }, [baseRowHeight, density, minW, maxW])

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
    estimateSize: () => rowHeight + ROW_GAP,
    overscan: OVERSCAN,
  })

  return (
    <div ref={parentRef} className={styles.scroll} onScroll={onScroll}>
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
                justifyContent: 'center',
                gap: ROW_GAP,
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
                    cardWidth={cardWidth}
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
