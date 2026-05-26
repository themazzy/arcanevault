import { ResponsiveMenu } from '../UI'
import { SettingsIcon } from '../../icons'
import { ManaCostInline, OwnershipBadge } from './primitives'
import { BOARD_ORDER, BOARD_LABELS } from '../../lib/deckBuilderConstants'
import { normalizeBoard, canBeCommander } from '../../lib/deckBuilderHelpers'
import { getScryfallKey } from '../../lib/scryfall'
import { consumeLongPressClick } from '../../lib/touchContextMenu'
import styles from '../../pages/DeckBuilder.module.css'
import uiStyles from '../UI.module.css'

// Body of the per-card "..." actions menu (commander toggle, board moves,
// foil toggle, version change, category picker). Rendered inside a
// ResponsiveMenu.
export function DeckCardActionsMenuBody({
  dc,
  isEDH,
  onSetCommander,
  onToggleFoil,
  onPickVersion,
  onMoveBoard,
  onOpenCategoryPicker,
  close,
  builderSfMap = {},
}) {
  const currentBoard = normalizeBoard(dc.board)
  const boardOptions = BOARD_ORDER.filter(board => board !== currentBoard && !(dc.is_commander && board !== 'main'))
  const sf = dc.set_code && dc.collector_number ? builderSfMap[getScryfallKey(dc)] || null : null
  return (
    <div className={uiStyles.responsiveMenuList}>
      {isEDH && dc.is_commander && (
        <button className={uiStyles.responsiveMenuAction} onClick={() => { onSetCommander(dc, false); close() }}>
          <span>Unset as Commander</span>
        </button>
      )}
      {isEDH && !dc.is_commander && canBeCommander(dc, sf) && (
        <button className={uiStyles.responsiveMenuAction} onClick={() => { onSetCommander(dc, true); close() }}>
          <span>Set as Commander</span>
        </button>
      )}
      {boardOptions.map(board => (
        <button key={board} className={uiStyles.responsiveMenuAction} onClick={() => { onMoveBoard?.(dc.id, board); close() }}>
          <span>Move to {BOARD_LABELS[board]}</span>
        </button>
      ))}
      <button className={uiStyles.responsiveMenuAction} onClick={() => { onToggleFoil(dc.id); close() }}>
        <span>{dc.foil ? 'Remove Foil' : 'Mark as Foil'}</span>
      </button>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { onPickVersion(dc); close() }}>
        <span>Change Version</span>
      </button>
      {dc.qty > 1 && (
        <button className={uiStyles.responsiveMenuAction} onClick={() => { onPickVersion(dc, { splitOne: true }); close() }}>
          <span>Split 1x To Other Version</span>
        </button>
      )}
      <div className={styles.menuDivider} />
      <button className={uiStyles.responsiveMenuAction} onClick={() => { onOpenCategoryPicker?.(dc); close() }}>
        <span>Change Category</span>
      </button>
    </div>
  )
}

// Trigger + ResponsiveMenu wrapper for DeckCardActionsMenuBody.
export function EditMenu({
  dc,
  isEDH,
  onSetCommander,
  onToggleFoil,
  onPickVersion,
  onMoveBoard,
  onOpenCategoryPicker,
  builderSfMap = {},
}) {
  return (
    <ResponsiveMenu
      title="Card Actions"
      wrapClassName={styles.editMenuCell}
      portal
      trigger={({ toggle }) => (
        <button
          className={styles.editBtn}
          onClick={e => { e.stopPropagation(); toggle() }}
          title="Edit"
        ><SettingsIcon size={13} /></button>
      )}
    >
      {({ close }) => (
        <DeckCardActionsMenuBody
          dc={dc}
          isEDH={isEDH}
          onSetCommander={onSetCommander}
          onToggleFoil={onToggleFoil}
          onPickVersion={onPickVersion}
          onMoveBoard={onMoveBoard}
          onOpenCategoryPicker={onOpenCategoryPicker}
          close={close}
          builderSfMap={builderSfMap}
        />
      )}
    </ResponsiveMenu>
  )
}

// List-view row for a deck card. Renders a thumbnail, name, optional
// columns (set/mana/cmc/price/status/actions/qty/remove) per visibleColumns.
export function DeckCardRow({
  dc, ownedQty, ownedFoilAlt, ownedAlt, ownedInDeck, inCollDeck,
  onChangeQty, onRemove, onMouseEnter, onMouseLeave, onMouseMove, onContextMenu, touchContextMenuHandlers, onDragStart,
  onPickVersion, onToggleFoil, onSetCommander, onMoveBoard, onOpenCategoryPicker, isEDH,
  visibleColumns, listGridTemplate, priceLabel, onOpenDetail, legalityWarnings = [],
  listGridMinWidth,
  builderSfMap = {},
}) {
  const setLabel = dc.set_code ? `${String(dc.set_code).toUpperCase()}${dc.collector_number ? ` #${dc.collector_number}` : ''}` : '-'
  return (
    <div className={`${styles.deckCardRow}${dc.is_commander ? ' ' + styles.isCommander : ''}${legalityWarnings.length ? ' ' + styles.deckCardIllegal : ''}`} title={(legalityWarnings.map(w => w.text).join('\n')) || undefined} style={{ '--deck-list-columns': listGridTemplate, '--deck-list-min-width': listGridMinWidth }} onContextMenu={onContextMenu} {...(touchContextMenuHandlers || {})} draggable onDragStart={onDragStart}>
      <div className={styles.deckCardLeft} style={{ cursor: 'pointer' }} onClick={(e) => { if (consumeLongPressClick(e)) return; onOpenDetail?.(dc) }}>
        {dc.image_uri
          ? <img className={styles.deckThumb} src={dc.image_uri} alt="" loading="lazy" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove} />
          : <div className={styles.deckThumbPlaceholder} />
        }
        <span className={styles.deckCardName} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove}>{dc.name}</span>
        {legalityWarnings.length > 0 && <span className={styles.illegalMark} title={legalityWarnings.map(w => w.text).join('\n')}>!</span>}
        {dc.foil && <span className={styles.foilBadge} title="Foil">*</span>}
      </div>
      {visibleColumns.set && <div className={styles.deckCardSet}>{setLabel}</div>}
      {visibleColumns.manaValue && <div className={styles.deckCardMetric}><ManaCostInline cost={dc.mana_cost} size={14} /></div>}
      {visibleColumns.cmc && <div className={styles.deckCardMetric}>{dc.cmc ?? '-'}</div>}
      {visibleColumns.price && <div className={styles.deckCardMetric}>{priceLabel}</div>}
      {visibleColumns.status && (
        <div className={styles.deckCardStatus}>
          <OwnershipBadge ownedQty={ownedQty} ownedFoilAlt={ownedFoilAlt} ownedAlt={ownedAlt} ownedInDeck={ownedInDeck} inCollDeck={inCollDeck} />
        </div>
      )}
      {visibleColumns.actions && <EditMenu dc={dc} isEDH={isEDH} onSetCommander={onSetCommander} onToggleFoil={onToggleFoil} onPickVersion={onPickVersion} onMoveBoard={onMoveBoard} onOpenCategoryPicker={onOpenCategoryPicker} builderSfMap={builderSfMap} />}
      {visibleColumns.qty && (
        <div className={styles.qtyControls}>
          <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, -1)}>-</button>
          <span className={styles.qtyVal}>{dc.qty}</span>
          <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, +1)}>+</button>
        </div>
      )}
      {visibleColumns.remove && <button className={styles.removeBtn} onClick={() => onRemove(dc.id)}>x</button>}
    </div>
  )
}
