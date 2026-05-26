import styles from '../../pages/DeckBuilder.module.css'

// Per-group section in the deck list/grid view. Renders the category header
// (passed in as a slot), then the group's cards either as a grid or a list
// depending on `view`. The wrapping div catches card drops onto the section
// (for cross-category re-assignment).
export function DeckCardSection({
  cards,
  view,
  visualMin,
  collapsed,
  collapsedKey,
  isCategoryGroup,
  onCardDrop,
  header,
  renderCard,
  renderListHeader,
}) {
  return (
    <div
      key={collapsedKey}
      className={styles.deckGroup}
      onDragOver={isCategoryGroup ? e => e.preventDefault() : undefined}
      onDrop={isCategoryGroup ? onCardDrop : undefined}
    >
      {header}
      {!collapsed && (view === 'grid'
        ? <div className={styles.visualGrid} style={{ '--deckbuilder-grid-min': `${visualMin}px` }}>{cards.map(dc => renderCard(dc))}</div>
        : (
          <>
            {renderListHeader?.()}
            {cards.map(dc => renderCard(dc))}
          </>
        )
      )}
    </div>
  )
}
