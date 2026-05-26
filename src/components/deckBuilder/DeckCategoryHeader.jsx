import { ResponsiveMenu } from '../UI'
import { ChevronDownIcon, MenuIcon } from '../../icons'
import { formatPrice } from '../../lib/scryfall'
import styles from '../../pages/DeckBuilder.module.css'
import uiStyles from '../UI.module.css'

// Inline ResponsiveMenu rendered to the right of a category group header.
// Provides reorder (up/down or left/right) plus rename/delete for user-
// created categories. Renders nothing for non-category groupings.
function CategoryControls({
  group,
  groupOrder,
  isStacksView,
  isCategoryGroup,
  category,
  isDefaultCategory,
  onMove,
  onRename,
  onDelete,
}) {
  if (!isCategoryGroup) return null
  const prevLabel = isStacksView ? 'Move Left' : 'Move Up'
  const nextLabel = isStacksView ? 'Move Right' : 'Move Down'
  const prevDir = isStacksView ? 'left' : 'up'
  const nextDir = isStacksView ? 'right' : 'down'
  return (
    <ResponsiveMenu
      title="Category"
      wrapClassName={styles.categoryMenuWrap}
      portal
      trigger={({ toggle }) => (
        <button
          className={styles.categoryMenuBtn}
          onClick={e => { e.stopPropagation(); toggle() }}
          title="Category actions"
          aria-label="Category actions"
        >
          <MenuIcon size={13} />
        </button>
      )}
    >
      {({ close }) => (
        <div className={uiStyles.responsiveMenuList}>
          <button className={uiStyles.responsiveMenuAction} onClick={() => { onMove(group, prevDir, groupOrder); close() }}>
            <span>{prevLabel}</span>
          </button>
          <button className={uiStyles.responsiveMenuAction} onClick={() => { onMove(group, nextDir, groupOrder); close() }}>
            <span>{nextLabel}</span>
          </button>
          {category && !isDefaultCategory && (
            <>
              <button className={uiStyles.responsiveMenuAction} onClick={() => { onRename(category); close() }}>
                <span>Rename</span>
              </button>
              <button className={`${uiStyles.responsiveMenuAction} ${uiStyles.responsiveMenuActionDanger}`} onClick={() => { onDelete(category); close() }}>
                <span>Delete</span>
              </button>
            </>
          )}
        </div>
      )}
    </ResponsiveMenu>
  )
}

// Renders the header row of a deck group (category / type / rarity / set).
// Two visual variants:
//   - `isStacksView`: column-style stacks header (no price)
//   - default: list/grid header with price and optional color accent
//
// Drag/drop reordering is enabled only for category grouping; the parent
// supplies the actual reorder handlers.
export function DeckCategoryHeader({
  group,
  groupQty,
  groupPrice,
  groupColor,
  collapsed,
  collapsedKey,
  isStacksView = false,
  isCategoryGroup,
  draggedCategoryId,
  category,
  isDefaultCategory,
  groupOrder,
  priceSource,
  onToggleCollapsed,
  onDragStart,
  onDrop,
  onMoveCategory,
  onRenameCategory,
  onDeleteCategory,
}) {
  const headerClass = isStacksView ? styles.stackGroupHeader : styles.groupHeader
  const titleClass  = isStacksView ? styles.stackGroupTitle  : styles.groupName
  const countClass  = isStacksView ? styles.stackGroupCount  : styles.groupCount
  const draggable = isCategoryGroup

  const handleClickToggle = () => onToggleCollapsed(collapsedKey)

  const headerDragStart = e => {
    onDragStart?.(e)
    e.dataTransfer.setData('application/x-deck-category-name', group)
  }

  const headerDragOver = e => {
    if (draggedCategoryId && draggedCategoryId !== group) e.preventDefault()
  }

  const headerDrop = e => {
    const fromName = e.dataTransfer.getData('application/x-deck-category-name')
    if (!fromName || fromName === group) return
    e.preventDefault()
    onDrop?.(fromName, group, groupOrder)
  }

  const stackKeyDown = e => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onToggleCollapsed(collapsedKey)
  }

  return (
    <div
      className={headerClass}
      role={isStacksView ? 'button' : undefined}
      tabIndex={isStacksView ? 0 : undefined}
      draggable={draggable}
      onDragStart={draggable ? headerDragStart : undefined}
      onDragOver={draggable ? headerDragOver : undefined}
      onDrop={draggable ? headerDrop : undefined}
      onClick={handleClickToggle}
      onKeyDown={isStacksView ? stackKeyDown : undefined}
      style={!isStacksView ? { cursor: 'pointer' } : undefined}
    >
      <span className={`${styles.groupArrow}${collapsed ? ' ' + styles.groupArrowCollapsed : ''}`} aria-hidden="true">
        <ChevronDownIcon size={12} />
      </span>
      <span className={titleClass} style={!isStacksView && groupColor ? { color: groupColor } : undefined}>{group}</span>
      {!isStacksView && groupPrice > 0 && <span className={styles.groupPrice}>{formatPrice(groupPrice, priceSource)}</span>}
      <span className={countClass}>{groupQty}</span>
      <CategoryControls
        group={group}
        groupOrder={groupOrder}
        isStacksView={isStacksView}
        isCategoryGroup={isCategoryGroup}
        category={category}
        isDefaultCategory={isDefaultCategory}
        onMove={onMoveCategory}
        onRename={onRenameCategory}
        onDelete={onDeleteCategory}
      />
    </div>
  )
}
