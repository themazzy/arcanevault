import { ResponsiveMenu } from '../UI'
import { CloseIcon, SettingsIcon } from '../../icons'
import { ManaCostInline, OwnershipBadge } from './primitives'
import { BOARD_ORDER, BOARD_LABELS } from '../../lib/deckBuilderConstants'
import { normalizeBoard, canBeCommander } from '../../lib/deckBuilderHelpers'
import { isOathbreaker, isSignatureSpell } from '../../lib/commandZone'
import { getScryfallKey } from '../../lib/scryfall'
import { consumeLongPressClick } from '../../lib/touchContextMenu'
import { formatAttractionLights, isAttractionCard } from '../../lib/attractions'
import styles from '../../pages/DeckBuilder.module.css'
import uiStyles from '../UI.module.css'

// Body of the per-card "..." actions menu (commander toggle, board moves,
// foil toggle, version change, category picker). Rendered inside a
// ResponsiveMenu.
export function DeckCardActionsMenuBody({
  dc,
  isEDH,
  formatId,
  onSetCommander,
  onToggleFoil,
  onPickVersion,
  onMoveBoard,
  onOpenCategoryPicker,
  onChangeQty,
  onRemove,
  close,
  builderSfMap = {},
}) {
  const currentBoard = normalizeBoard(dc.board)
  const sf = dc.set_code && dc.collector_number ? builderSfMap[getScryfallKey(dc)] || null : null
  const attraction = isAttractionCard(dc, sf)
  const allowedBoards = attraction ? ['attraction', 'maybe'] : ['main', 'side', 'maybe']
  const boardOptions = BOARD_ORDER.filter(board => allowedBoards.includes(board) && board !== currentBoard && !(dc.is_commander && board !== 'main'))
  // Oathbreaker uses the same command-zone slots but accepts a planeswalker
  // (the Oathbreaker) and an instant/sorcery (the Signature Spell).
  const isOath = formatId === 'oathbreaker'
  const merged = { ...dc, type_line: sf?.type_line || dc.type_line }
  const canLead = isOath ? (isOathbreaker(merged) || isSignatureSpell(merged)) : canBeCommander(dc, sf)
  const setLabel = isOath ? (isOathbreaker(merged) ? 'Set as Oathbreaker' : 'Set as Signature Spell') : 'Set as Commander'
  const unsetLabel = isOath ? 'Remove from Command Zone' : 'Unset as Commander'
  return (
    <div className={uiStyles.responsiveMenuList}>
      {onChangeQty && onRemove && (
        <div className={styles.cardActionQuantity}>
          <span className={styles.cardActionQuantityLabel}>Quantity</span>
          <div className={styles.cardActionQuantityControls}>
            <button
              type="button"
              className={styles.cardActionQuantityBtn}
              onClick={() => {
                if (dc.qty <= 1) {
                  close()
                  onRemove(dc.id)
                } else {
                  onChangeQty(dc.id, -1)
                }
              }}
              aria-label={dc.qty <= 1 ? `Remove final copy of ${dc.name}` : `Decrease ${dc.name} quantity`}
            >
              -
            </button>
            <output className={styles.cardActionQuantityValue} aria-label={`${dc.name} quantity`}>{dc.qty}</output>
            <button
              type="button"
              className={styles.cardActionQuantityBtn}
              disabled={attraction && dc.qty >= 1}
              onClick={() => onChangeQty(dc.id, 1)}
              aria-label={`Increase ${dc.name} quantity`}
            >
              +
            </button>
          </div>
        </div>
      )}
      {isEDH && dc.is_commander && (
        <button className={uiStyles.responsiveMenuAction} onClick={() => { onSetCommander(dc, false); close() }}>
          <span>{unsetLabel}</span>
        </button>
      )}
      {isEDH && !dc.is_commander && !attraction && canLead && (
        <button className={uiStyles.responsiveMenuAction} onClick={() => { onSetCommander(dc, true); close() }}>
          <span>{setLabel}</span>
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
      {onRemove && (
        <button
          className={`${uiStyles.responsiveMenuAction} ${uiStyles.responsiveMenuActionDanger}`}
          onClick={() => { close(); onRemove(dc.id) }}
          aria-label={`Remove ${dc.name} from deck`}
        >
          <span>Remove from Deck</span>
        </button>
      )}
    </div>
  )
}

// Trigger + ResponsiveMenu wrapper for DeckCardActionsMenuBody.
export function EditMenu({
  dc,
  isEDH,
  formatId,
  onSetCommander,
  onToggleFoil,
  onPickVersion,
  onMoveBoard,
  onOpenCategoryPicker,
  onChangeQty,
  onRemove,
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
          title={`Edit ${dc.name}`}
          aria-label={`Edit ${dc.name}`}
        ><SettingsIcon size={13} /></button>
      )}
    >
      {({ close }) => (
        <DeckCardActionsMenuBody
          dc={dc}
          isEDH={isEDH}
          formatId={formatId}
          onSetCommander={onSetCommander}
          onToggleFoil={onToggleFoil}
          onPickVersion={onPickVersion}
          onMoveBoard={onMoveBoard}
          onOpenCategoryPicker={onOpenCategoryPicker}
          onChangeQty={onChangeQty}
          onRemove={onRemove}
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
  dc, ownedQty, ownedFoilAlt, ownedAlt, ownedInDeck, inCollDeck, ownershipReady,
  onChangeQty, onRemove, onMouseEnter, onMouseLeave, onMouseMove, onContextMenu, touchContextMenuHandlers, onDragStart,
  onPickVersion, onToggleFoil, onSetCommander, onMoveBoard, onOpenCategoryPicker, isEDH, formatId,
  visibleColumns, listGridTemplate, priceLabel, onOpenDetail, legalityWarnings = [],
  isWarningTarget = false,
  listGridMinWidth,
  builderSfMap = {},
}) {
  const sf = dc.set_code && dc.collector_number ? builderSfMap[getScryfallKey(dc)] || null : null
  const lights = formatAttractionLights(dc, sf)
  const setLabel = dc.set_code ? `${String(dc.set_code).toUpperCase()}${dc.collector_number ? ` #${dc.collector_number}` : ''}${lights ? ` · Lights ${lights}` : ''}` : '-'
  const attractionQtyLocked = normalizeBoard(dc.board) === 'attraction' && dc.qty >= 1
  return (
    <div
      className={`${styles.deckCardRow}${dc.is_commander ? ' ' + styles.isCommander : ''}${legalityWarnings.length ? ' ' + styles.deckCardIllegal : ''}${isWarningTarget ? ' ' + styles.warningCardTarget : ''}`}
      data-deck-card-id={dc.id}
      tabIndex={-1}
      role="group"
      aria-label={`Deck card ${dc.name}`}
      title={(legalityWarnings.map(w => w.text).join('\n')) || undefined}
      style={{ '--deck-list-columns': listGridTemplate, '--deck-list-min-width': listGridMinWidth }}
      onContextMenu={onContextMenu}
      {...(touchContextMenuHandlers || {})}
      draggable
      onDragStart={onDragStart}
    >
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
          <OwnershipBadge ownedQty={ownedQty} ownedFoilAlt={ownedFoilAlt} ownedAlt={ownedAlt} ownedInDeck={ownedInDeck} inCollDeck={inCollDeck} ownershipReady={ownershipReady} />
        </div>
      )}
      {visibleColumns.qty && (
        <div className={styles.qtyControls}>
          <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, -1)} aria-label={`Decrease ${dc.name} quantity`}>-</button>
          <span className={styles.qtyVal}>{dc.qty}</span>
          <button className={styles.qtyBtn} disabled={attractionQtyLocked} title={attractionQtyLocked ? 'Constructed Attraction decks allow one card of each English name.' : undefined} onClick={() => onChangeQty(dc.id, +1)} aria-label={`Increase ${dc.name} quantity`}>+</button>
        </div>
      )}
      {visibleColumns.actions && <EditMenu dc={dc} isEDH={isEDH} formatId={formatId} onSetCommander={onSetCommander} onToggleFoil={onToggleFoil} onPickVersion={onPickVersion} onMoveBoard={onMoveBoard} onOpenCategoryPicker={onOpenCategoryPicker} onChangeQty={onChangeQty} onRemove={onRemove} builderSfMap={builderSfMap} />}
      {visibleColumns.remove && <button className={styles.removeBtn} onClick={() => onRemove(dc.id)} aria-label={`Remove ${dc.name} from deck`}><CloseIcon size={13} /></button>}
    </div>
  )
}
