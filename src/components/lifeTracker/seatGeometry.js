// Seat hit testing for drag-to-swap.
//
// The snap target is a region in the MIDDLE of a seat, not the whole seat. Cells
// tile the grid, so a diagonal drag necessarily crosses the cells between its two
// endpoints — with a full-cell target the arrow snapped to each one on the way
// past. A centred region means the path has to actually aim at a seat.
//
// The same region decides both the snap preview and what a release does, so the
// arrow can never show one outcome and produce another.

// Fraction trimmed off each edge, leaving the central 56% of the cell.
//
// Solved rather than guessed: the tightest real case is a wide, short cell (the
// 2×3 portrait layout, roughly 180×100), where a steep diagonal crosses the middle
// band of the cells it passes. Clearing that needs an inset above 0.167, so 0.22
// leaves margin. It is still a comfortable target — about 62×50px on the smallest
// six-up phone panel, above the 44px touch minimum — while leaving the corners,
// where intent is genuinely ambiguous, dead. seatGeometry.test.js checks every
// shipped layout, so this number cannot be lowered without a failing test.
export const SNAP_INSET = 0.22

/**
 * Measure every seat cell once, in grid-relative coordinates.
 *
 * Cells are measured rather than seat panels because a cell is never transformed,
 * while a ±90° seat panel's bounding box is rotated. Called once per drag: seats do
 * not move until the drag is released, and the table cannot scroll (it is
 * position: fixed with overflow hidden), so the rects stay valid.
 *
 * @param {HTMLElement} grid
 * @returns {{ origin: {left:number, top:number}, rects: Record<number, object> }}
 */
export function measureSeats(grid) {
  const empty = { origin: { left: 0, top: 0 }, rects: {} }
  if (!grid) return empty
  const gridRect = grid.getBoundingClientRect()
  const rects = {}
  grid.querySelectorAll('[data-seat-index]').forEach(cell => {
    const rect = cell.getBoundingClientRect()
    const left = rect.left - gridRect.left
    const top = rect.top - gridRect.top
    rects[Number(cell.getAttribute('data-seat-index'))] = {
      left,
      top,
      width: rect.width,
      height: rect.height,
      cx: left + rect.width / 2,
      cy: top + rect.height / 2,
    }
  })
  return { origin: { left: gridRect.left, top: gridRect.top }, rects }
}

/**
 * The seat whose central region contains a grid-relative point, or null.
 * @param {Record<number, object>} rects from measureSeats
 * @param {number} x grid-relative
 * @param {number} y grid-relative
 * @param {number} [inset]
 * @returns {number | null}
 */
export function seatAtPoint(rects, x, y, inset = SNAP_INSET) {
  if (!rects || !Number.isFinite(x) || !Number.isFinite(y)) return null
  for (const key of Object.keys(rects)) {
    const rect = rects[key]
    const padX = rect.width * inset
    const padY = rect.height * inset
    if (
      x >= rect.left + padX && x <= rect.left + rect.width - padX &&
      y >= rect.top + padY && y <= rect.top + rect.height - padY
    ) {
      return Number(key)
    }
  }
  return null
}

/** Centre of a seat, for anchoring the arrow. */
export function seatCentre(rects, index) {
  const rect = rects?.[index]
  return rect ? { x: rect.cx, y: rect.cy } : null
}
