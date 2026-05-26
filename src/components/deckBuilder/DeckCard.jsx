import { ManaCostInline, OwnershipBadge } from './primitives'
import { EditMenu } from './DeckCardRow'
import { bindTouchContextMenu, consumeLongPressClick } from '../../lib/touchContextMenu'
import styles from '../../pages/DeckBuilder.module.css'

// Grid-view tile for a deck card. Renders a portrait image with qty/foil
// badges and a controls row (edit menu, qty +/-, remove).
function DeckCardGrid({
  dc, legalityWarnings, warningTitle,
  gridDensity, priceLabel, ownership,
  isEDH, builderSfMap,
  onChangeQty, onRemove, onOpenDetail, onContextMenu, onDragStart,
  onPickVersion, onToggleFoil, onSetCommander, onMoveBoard, onOpenCategoryPicker,
}) {
  return (
    <div
      key={dc.id}
      className={`${styles.visualCard}${dc.is_commander ? ' '+styles.isCommander : ''}${legalityWarnings.length ? ' '+styles.visualCardIllegal : ''}`}
      title={warningTitle || undefined}
      draggable
      onDragStart={e => onDragStart(dc, e)}
      onClick={(e) => { if (consumeLongPressClick(e)) return; onOpenDetail(dc) }}
      onContextMenu={e => onContextMenu(dc, e)}
      {...bindTouchContextMenu(e => onContextMenu(dc, e))}
    >
      <div className={styles.visualImgWrap}>
        {dc.image_uri
          ? <img src={gridDensity === 'compact' ? dc.image_uri?.replace(/\/(normal|large|png|border_crop|art_crop)\//, '/small/') : dc.image_uri} alt={dc.name} className={styles.visualCardImg} loading="lazy" />
          : <div className={styles.visualCardPlaceholder}>{dc.name}</div>}
        {dc.qty > 1 && <span className={styles.visualCardQty}>x{dc.qty}</span>}
        {dc.foil && <span className={styles.visualCardFoil} title="Foil">*</span>}
      </div>
      <div className={styles.visualCardBottom}>
        <div className={styles.visualCardInfoRow}>
          <span className={styles.visualCardPrice}>{priceLabel}</span>
          <OwnershipBadge {...ownership} />
        </div>
        <div className={styles.visualCardControls}>
          <EditMenu dc={dc} isEDH={isEDH} onSetCommander={onSetCommander} onToggleFoil={onToggleFoil} onPickVersion={onPickVersion} onMoveBoard={onMoveBoard} onOpenCategoryPicker={onOpenCategoryPicker} builderSfMap={builderSfMap} />
          <button className={styles.visualCardBtn} onClick={(ev) => { ev.stopPropagation(); onChangeQty(dc.id, -1) }}>-</button>
          <span className={styles.visualCardCount}>{dc.qty}</span>
          <button className={styles.visualCardBtn} onClick={(ev) => { ev.stopPropagation(); onChangeQty(dc.id, +1) }}>+</button>
          <button className={styles.visualCardBtn} onClick={(ev) => { ev.stopPropagation(); onRemove(dc.id) }}>x</button>
        </div>
      </div>
    </div>
  )
}

// Stacks-view card: portrait card layered into a column with hover-aware
// pushdown behavior. Tracks which card in the stack is currently "active"
// so touch users can two-tap (first to expand, second to open detail).
function DeckCardStack({
  dc, legalityWarnings, warningTitle,
  stackContext, stackHoverState, touchActiveStack, setStackHoverState, setTouchActiveStack,
  canHover, lastInputWasTouch,
  priceLabel, ownership,
  isEDH, builderSfMap,
  onChangeQty, onRemove, onOpenDetail, onContextMenu, onDragStart,
  onHoverEnter, onHoverLeave, onHoverMove,
  onPickVersion, onToggleFoil, onSetCommander, onMoveBoard, onOpenCategoryPicker,
}) {
  const activeHover = stackHoverState || touchActiveStack
  const isPushedDown = activeHover
    && activeHover.group === stackContext?.group
    && stackContext?.idx > activeHover.stackIdx
  const isTouchActive = touchActiveStack?.id === dc.id

  return (
    <div
      key={dc.id}
      className={`${styles.stackCard}${dc.is_commander ? ' '+styles.isCommander : ''}${legalityWarnings.length ? ' '+styles.stackCardIllegal : ''}${isPushedDown ? ' '+styles.stackCardPushedDown : ''}${isTouchActive ? ' '+styles.stackCardActive : ''}`}
      style={{ zIndex: isTouchActive ? 200 : (stackContext?.idx ?? 0) }}
      title={warningTitle || dc.name}
      draggable
      onDragStart={e => onDragStart(dc, e)}
      onClick={(e) => {
        if (consumeLongPressClick(e)) return
        if (!canHover) {
          if (isTouchActive) {
            setTouchActiveStack(null)
            onOpenDetail(dc)
          } else {
            setTouchActiveStack({ group: stackContext?.group, stackIdx: stackContext?.idx ?? 0, id: dc.id })
          }
          return
        }
        onOpenDetail(dc)
      }}
      onContextMenu={e => {
        onContextMenu(dc, e)
        setStackHoverState(null)
      }}
      {...bindTouchContextMenu(e => {
        onContextMenu(dc, e)
        setStackHoverState(null)
      })}
      onMouseEnter={canHover && !lastInputWasTouch ? e => {
        setStackHoverState({ group: stackContext?.group, stackIdx: stackContext?.idx ?? 0 })
        onHoverEnter(dc, e)
      } : undefined}
      onMouseLeave={canHover ? () => {
        setStackHoverState(null)
        onHoverLeave()
      } : undefined}
      onMouseMove={canHover ? e => onHoverMove(e.clientX, e.clientY) : undefined}
    >
      <div className={styles.stackImgWrap}>
        {dc.image_uri
          ? <img src={dc.image_uri} alt={dc.name} className={styles.stackCardImg} loading="lazy" />
          : <div className={styles.stackCardPlaceholder}>{dc.name}</div>}
        {legalityWarnings.length > 0 && <span className={styles.stackWarn} title={warningTitle}>!</span>}
        {dc.qty > 1 && <span className={styles.stackQty}>×{dc.qty}</span>}
        {dc.foil && <span className={styles.stackFoil} title="Foil">*</span>}
      </div>
      <div className={styles.stackCardControls} onClick={ev => ev.stopPropagation()}>
        <div className={styles.stackCardInfo}>
          <span className={styles.stackCardPrice}>{priceLabel}</span>
          <OwnershipBadge {...ownership} />
        </div>
        <div className={styles.stackControlsRow}>
          <EditMenu dc={dc} isEDH={isEDH} onSetCommander={onSetCommander} onToggleFoil={onToggleFoil} onPickVersion={onPickVersion} onMoveBoard={onMoveBoard} onOpenCategoryPicker={onOpenCategoryPicker} builderSfMap={builderSfMap} />
          <button className={styles.stackControlBtn} onClick={(ev) => { ev.stopPropagation(); onChangeQty(dc.id, -1) }}>-</button>
          <span className={styles.stackControlCount}>{dc.qty}</span>
          <button className={styles.stackControlBtn} onClick={(ev) => { ev.stopPropagation(); onChangeQty(dc.id, +1) }}>+</button>
          <button className={styles.stackControlBtn} onClick={(ev) => { ev.stopPropagation(); onRemove(dc.id) }}>x</button>
        </div>
      </div>
    </div>
  )
}

// Compact-view row: dense single-line entry with optional columns driven by
// `compactVisibleColumns`.
function DeckCardCompact({
  dc, legalityWarnings, warningTitle,
  compactVisibleColumns,
  canHover,
  priceLabel, ownership,
  isEDH, builderSfMap,
  onChangeQty, onRemove, onOpenDetail, onContextMenu, onDragStart,
  onHoverEnter, onHoverLeave, onHoverMove,
  onPickVersion, onToggleFoil, onSetCommander, onMoveBoard, onOpenCategoryPicker,
}) {
  return (
    <div
      key={dc.id}
      className={`${styles.compactRow}${dc.is_commander ? ' '+styles.isCommander : ''}${legalityWarnings.length ? ' '+styles.deckCardIllegal : ''}`}
      title={warningTitle || undefined}
      onContextMenu={e => onContextMenu(dc, e)}
      {...bindTouchContextMenu(e => onContextMenu(dc, e))}
      draggable
      onDragStart={e => onDragStart(dc, e)}
    >
      <span className={styles.compactQty}>{dc.qty}</span>
      <span className={styles.compactName}
        style={{ cursor: 'pointer' }}
        onClick={(e) => { if (consumeLongPressClick(e)) return; onOpenDetail(dc) }}
        onMouseEnter={canHover ? e => onHoverEnter(dc, e) : undefined}
        onMouseLeave={canHover ? () => onHoverLeave() : undefined}
        onMouseMove={canHover ? e => onHoverMove(e.clientX, e.clientY) : undefined}>
        {dc.name}
      </span>
      {dc.foil && <span className={styles.foilBadge} title="Foil">*</span>}
      {compactVisibleColumns.set && <span className={styles.compactMeta}>{dc.set_code ? `${String(dc.set_code).toUpperCase()}${dc.collector_number ? ` #${dc.collector_number}` : ''}` : '-'}</span>}
      {compactVisibleColumns.manaValue && <span className={styles.compactMeta}><ManaCostInline cost={dc.mana_cost} size={13} /></span>}
      {compactVisibleColumns.cmc && <span className={styles.compactMeta}>{dc.cmc ?? '-'}</span>}
      {compactVisibleColumns.price && <span className={styles.compactMeta}>{priceLabel}</span>}
      {compactVisibleColumns.status && <OwnershipBadge {...ownership} />}
      {compactVisibleColumns.actions && <EditMenu dc={dc} isEDH={isEDH} onSetCommander={onSetCommander} onToggleFoil={onToggleFoil} onPickVersion={onPickVersion} onMoveBoard={onMoveBoard} onOpenCategoryPicker={onOpenCategoryPicker} builderSfMap={builderSfMap} />}
      {compactVisibleColumns.qty && (
        <div className={styles.qtyControls}>
          <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, -1)}>-</button>
          <span className={styles.qtyVal}>{dc.qty}</span>
          <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, +1)}>+</button>
        </div>
      )}
      {compactVisibleColumns.remove && <button className={styles.removeBtn} onClick={() => onRemove(dc.id)}>x</button>}
    </div>
  )
}

// View-aware deck card. Dispatches to the grid / stacks / compact variant.
// (List view is handled by DeckCardRow elsewhere — it lives at component
// scope of DeckBuilder because it sits inside the list-grid layout.)
export function DeckCard({ view, ...rest }) {
  if (view === 'grid') return <DeckCardGrid {...rest} />
  if (view === 'stacks') return <DeckCardStack {...rest} />
  if (view === 'compact') return <DeckCardCompact {...rest} />
  return null
}
