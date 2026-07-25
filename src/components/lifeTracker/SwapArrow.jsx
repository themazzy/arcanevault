import styles from './SwapArrow.module.css'

// The "this seat is going there" indicator drawn over the table during a seat drag.
//
// Coordinates are relative to the grid, and seat centres are measured from the
// grid cells rather than the seat panels: a cell is never transformed, so its
// bounding box is exact, while a ±90° seat panel's box is rotated.
//
// The dash animation is CSS rather than JS so that reduce_motion neutralises it
// globally (index.css flattens animation-duration under
// [data-reduce-motion="true"]) — the line stays, it just stops marching.

const END_GAP = 15   // keeps the head and origin dot clear of the seat borders
const MIN_LENGTH = 34 // below this the arrow is unreadable, so draw nothing

export default function SwapArrow({ from, to }) {
  if (!from || !to) return null

  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (!Number.isFinite(length) || length < MIN_LENGTH) return null

  const ux = dx / length
  const uy = dy / length
  const start = { x: from.x + ux * END_GAP, y: from.y + uy * END_GAP }
  const end = { x: to.x - ux * END_GAP, y: to.y - uy * END_GAP }

  return (
    <svg className={styles.layer} aria-hidden="true">
      <defs>
        <marker id="lt-swap-head" viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>

      {/* A wide dark stroke under the line keeps it legible over pale card art. */}
      <line className={styles.shadow}
        x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
      <line className={styles.line}
        x1={start.x} y1={start.y} x2={end.x} y2={end.y}
        markerEnd="url(#lt-swap-head)" />
      <circle className={styles.origin} cx={from.x} cy={from.y} r="5" />
    </svg>
  )
}
