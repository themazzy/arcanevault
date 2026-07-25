import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../SettingsContext'
import styles from './SwapArrow.module.css'

// The "this seat is going there" indicator drawn over the table during a seat drag.
//
// Coordinates are relative to the grid, and seat centres come from the grid cells
// rather than the seat panels: a cell is never transformed, so its bounding box is
// exact, while a ±90° seat panel's box is rotated.
//
// The dash animation is CSS so reduce_motion neutralises it globally (index.css
// flattens animation-duration under [data-reduce-motion="true"]) — the line stays,
// it just stops marching. The snap is interpolated in JS instead, because SVG
// geometry properties (x2/y2) are only CSS-animatable in Chromium and WebKit.

const END_GAP = 15    // keeps the head and origin dot clear of the seat borders
const MIN_LENGTH = 34 // below this the arrow is unreadable, so draw nothing
export const SNAP_MS = 100

const easeOut = t => 1 - (1 - t) ** 3

export default function SwapArrow({ from, to, snapped = false }) {
  const { reduce_motion } = useSettings()

  // Where the line currently ends on screen. Held in a ref so a snap can start
  // from wherever the arrow actually is, without depending on effect ordering.
  const endRef = useRef(null)
  const frameRef = useRef(0)
  const [animEnd, setAnimEnd] = useState(null)

  const toX = to?.x
  const toY = to?.y

  useEffect(() => {
    cancelAnimationFrame(frameRef.current)
    if (!Number.isFinite(toX) || !Number.isFinite(toY)) return undefined

    const target = { x: toX, y: toY }

    // Following the finger, or motion is turned off: no interpolation, or the
    // arrow would lag behind the thing it is attached to.
    if (!snapped || reduce_motion || !endRef.current) {
      endRef.current = target
      setAnimEnd(null)
      return undefined
    }

    const origin = endRef.current
    const startedAt = performance.now()
    const step = (now) => {
      const t = Math.min(1, (now - startedAt) / SNAP_MS)
      const e = easeOut(t)
      const point = {
        x: origin.x + (target.x - origin.x) * e,
        y: origin.y + (target.y - origin.y) * e,
      }
      endRef.current = point
      setAnimEnd(t < 1 ? point : null)
      if (t < 1) frameRef.current = requestAnimationFrame(step)
      else endRef.current = target
    }
    frameRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frameRef.current)
  }, [toX, toY, snapped, reduce_motion])

  useEffect(() => () => cancelAnimationFrame(frameRef.current), [])

  if (!from || !Number.isFinite(toX) || !Number.isFinite(toY)) return null
  const end = animEnd || { x: toX, y: toY }

  const dx = end.x - from.x
  const dy = end.y - from.y
  const length = Math.hypot(dx, dy)
  if (!Number.isFinite(length) || length < MIN_LENGTH) return null

  const ux = dx / length
  const uy = dy / length
  const tail = { x: from.x + ux * END_GAP, y: from.y + uy * END_GAP }
  const head = { x: end.x - ux * END_GAP, y: end.y - uy * END_GAP }

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
        x1={tail.x} y1={tail.y} x2={head.x} y2={head.y} />
      <line className={styles.line} data-snapped={snapped ? 'true' : undefined}
        x1={tail.x} y1={tail.y} x2={head.x} y2={head.y}
        markerEnd="url(#lt-swap-head)" />
      <circle className={styles.origin} cx={from.x} cy={from.y} r="5" />
    </svg>
  )
}
