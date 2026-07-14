import { PIP_COLORS } from '../../lib/deckBuilderConstants'
import { manaSymbolUrl } from '../../lib/deckBuilderHelpers'
import styles from '../../pages/DeckBuilder.module.css'

export function ColorPip({ color }) {
  return (
    <span className={styles.colorPip} style={{ background: PIP_COLORS[color] || '#666', color: '#000' }}>
      {color}
    </span>
  )
}

export function ManaCostInline({ cost, size = 14 }) {
  if (!cost) return <span>&mdash;</span>
  const sides = String(cost).split(' // ')
  const symbolCount = (String(cost).match(/\{[^}]+\}/g) || []).length
  const effectiveSize = symbolCount >= 5
    ? Math.max(9, size - 4)
    : symbolCount >= 4
      ? Math.max(10, size - 3)
      : symbolCount >= 3
        ? Math.max(11, size - 2)
        : size
  return (
    <span className={styles.manaCostInline}>
      {sides.map((side, sideIndex) => (
        <span key={`${side}:${sideIndex}`} className={styles.manaCostInline}>
          {sideIndex > 0 && <span className={styles.manaCostDivider}>{'//'}</span>}
          {(side.match(/\{[^}]+\}/g) || []).map((sym, symIndex) => (
            <img
              key={`${sym}:${symIndex}`}
              className={styles.manaSymbolInline}
              src={manaSymbolUrl(sym)}
              alt={sym}
              loading="lazy"
              style={{ width: effectiveSize, height: effectiveSize }}
            />
          ))}
        </span>
      ))}
    </span>
  )
}

export function OwnershipBadge({ ownedQty, ownedFoilAlt, ownedAlt, ownedInDeck, inCollDeck, ownershipReady = true }) {
  // Allocation indicators (inOtherDeckSet/collDeckSfSet) load slightly after
  // the deck's own card list — until they're in, ownedInDeck/inCollDeck default
  // to false and would misreport a card committed elsewhere as merely "Owned".
  if (!ownershipReady) return <span className={`${styles.stateBadge} ${styles.stateBadgePending}`} title="Checking ownership…">…</span>
  if (inCollDeck) return <span className={`${styles.stateBadge} ${styles.stateBadgeAssigned}`} title="Assigned to this collection deck">In Deck</span>
  if (ownedQty > 0 && !ownedInDeck) return <span className={`${styles.stateBadge} ${styles.stateBadgeOwned}`} title="Owned and available">Owned</span>
  if (ownedInDeck) return <span className={`${styles.stateBadge} ${styles.stateBadgeCommitted}`} title="Owned, but committed to another deck">In Other Deck</span>
  if (ownedFoilAlt > 0) return <span className={`${styles.stateBadge} ${styles.stateBadgeAlt}`} title="Owned as opposite foil variant">Wrong Foil</span>
  if (ownedAlt > 0) return <span className={`${styles.stateBadge} ${styles.stateBadgeAlt}`} title="A different version is owned">Other Print</span>
  return <span className={`${styles.stateBadge} ${styles.stateBadgeMissing}`} title="Not owned in collection">Not Owned</span>
}
