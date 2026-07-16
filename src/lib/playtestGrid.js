// Battlefield placement grid for the deck playtester.
//
// The battlefield body paints a 22px radial-gradient dot lattice whose dots are
// centred in each tile, i.e. at (11 + 22i, 11 + 22j) from the body's padding-box
// origin — the same origin absolutely positioned cards resolve left/top against.
// Snapping a card's top-left to that lattice therefore lands it exactly on a dot.

export const BATTLEFIELD_GRID_SIZE = 22
export const BATTLEFIELD_GRID_OFFSET = BATTLEFIELD_GRID_SIZE / 2

// Mirrors .battlefieldCard in DeckGoldfish.module.css. Only used to keep dropped
// cards inside the battlefield, so small drift (e.g. the 102px mobile width) is
// harmless.
export const BATTLEFIELD_CARD_WIDTH = 116
export const BATTLEFIELD_CARD_HEIGHT = 164

export function snapToBattlefieldGrid(value, limit) {
  const max = Math.max(0, limit)
  const clamped = Math.max(0, Math.min(value, max))
  const steps = Math.round((clamped - BATTLEFIELD_GRID_OFFSET) / BATTLEFIELD_GRID_SIZE)
  let snapped = steps * BATTLEFIELD_GRID_SIZE + BATTLEFIELD_GRID_OFFSET
  // Snapping can push the card past an edge; step back onto the nearest in-range
  // lattice point rather than clamping off-lattice.
  if (snapped < 0) snapped += BATTLEFIELD_GRID_SIZE
  if (snapped > max) snapped -= BATTLEFIELD_GRID_SIZE
  return Math.max(0, Math.min(snapped, max))
}

export function computeBattlefieldPlacement({
  x,
  y,
  bodyWidth,
  bodyHeight,
  cardWidth = BATTLEFIELD_CARD_WIDTH,
  cardHeight = BATTLEFIELD_CARD_HEIGHT,
}) {
  return {
    x: snapToBattlefieldGrid(x, bodyWidth - cardWidth),
    y: snapToBattlefieldGrid(y, bodyHeight - cardHeight),
  }
}
