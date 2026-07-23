import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { formatPrice, getPrice, getScryfallKey } from '../lib/scryfall'
import styles from './VirtualCardTable.module.css'

const ROW_HEIGHT = 56

export default function VirtualCardTable({
  cards,
  sfMap,
  onSelect,
  selectMode,
  selected,
  onToggleSelect,
  splitState,
  onAdjustQty,
  priceSource,
  showPrice = true,
  cardFolders,
  onScroll,
}) {
  const parentRef = useRef(null)
  // Actual scrollbar width (0 on overlay-scrollbar platforms), exposed as
  // --sbw so page CSS can compute "gutter minus scrollbar" insets.
  const [scrollbarWidth, setScrollbarWidth] = useState(0)
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const measure = () => setScrollbarWidth(el.offsetWidth - el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  return (
    <div className={styles.table}>
      <div className={styles.header} aria-hidden="true">
        <span>Qty</span><span>Card</span><span>Set</span><span>Value</span><span>Location</span>
      </div>
      <div ref={parentRef} className={styles.scroll} style={{ '--sbw': `${scrollbarWidth}px` }} onScroll={onScroll}>
        <div className={styles.virtualBody} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(virtualRow => {
            const card = cards[virtualRow.index]
            const key = card._displayKey || card.id
            const qty = card._folder_qty ?? card.qty ?? 1
            const selectedQty = splitState?.get(key) ?? 1
            const isSelected = selectMode && selected?.has(key)
            const sfCard = sfMap?.[getScryfallKey(card)]
            const unitPrice = getPrice(sfCard, card.foil, { price_source: priceSource }) ?? (parseFloat(card.purchase_price) || null)
            const folders = card._displayFolder ? [card._displayFolder] : (cardFolders?.[card.id] || [])

            const activate = () => {
              if (selectMode) onToggleSelect?.(key, qty)
              else onSelect?.(card)
            }

            return (
              <div
                key={virtualRow.key}
                className={`${styles.row}${isSelected ? ` ${styles.rowSelected}` : ''}`}
                style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}
              >
                <div className={styles.qtyCell}>
                  {isSelected && qty > 1 ? (
                    <span className={styles.qtyAdjuster}>
                      <button type="button" onClick={() => onAdjustQty?.(key, -1, qty)} aria-label={`Select fewer copies of ${card.name}`}>−</button>
                      <span>{selectedQty}/{qty}</span>
                      <button type="button" onClick={() => onAdjustQty?.(key, 1, qty)} aria-label={`Select more copies of ${card.name}`}>+</button>
                    </span>
                  ) : qty}
                </div>
                <button type="button" className={styles.rowAction} onClick={activate} aria-pressed={selectMode ? isSelected : undefined}>
                  <span className={styles.cardName}>{card.name}{card.foil ? <em>Foil</em> : null}</span>
                  <span className={styles.setCode}>{(card.set_code || '').toUpperCase()} {card.collector_number ? `#${card.collector_number}` : ''}</span>
                  <span className={styles.value}>{showPrice && unitPrice != null ? formatPrice(unitPrice * qty, priceSource) : '—'}</span>
                  <span className={styles.locations} title={folders.map(folder => folder.name).join(', ')}>
                    {folders.length ? folders.slice(0, 2).map(folder => folder.name).join(', ') : 'Unassigned'}{folders.length > 2 ? ` +${folders.length - 2}` : ''}
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
