import { useCallback, useEffect, useRef, useState } from 'react'

// Press-and-hold stepping, shared by every surface in the tracker that counts
// something up and down: the seat's split-tap halves and the damage sheet's panes.
// One implementation so the feel — how long before it repeats, how fast, whether
// it accelerates — cannot drift between them.

export const HOLD_DELAY_MS = 420   // deliberate hold, not an accidental long tap
export const HOLD_TICK_MS = 130
const RAMP_TO_5_TICKS = 9   // ≈1.6s held
const RAMP_TO_10_TICKS = 18 // ≈2.8s held

function stepForTick(ticks, ramp) {
  if (!ramp) return 1
  if (ticks > RAMP_TO_10_TICKS) return 10
  if (ticks > RAMP_TO_5_TICKS) return 5
  return 1
}

// `apply` receives the signed step. `ramp: false` repeats at 1 for counters with a
// small useful range — commander damage tops out at 21, so accelerating to 10 a
// tick would overshoot the only number that matters.
export default function useHoldRepeat(apply, { ramp = true } = {}) {
  const [pressed, setPressed] = useState(null) // -1 | 1 | null
  const hold = useRef({ timeout: null, interval: null, ticks: 0 })

  // Held in a ref so a caller passing an inline arrow does not restart the timers
  // on every render.
  const applyRef = useRef(apply)
  useEffect(() => { applyRef.current = apply })

  const stop = useCallback(() => {
    const h = hold.current
    if (h.timeout) clearTimeout(h.timeout)
    if (h.interval) clearInterval(h.interval)
    h.timeout = null
    h.interval = null
    h.ticks = 0
  }, [])

  useEffect(() => stop, [stop])

  const start = useCallback((dir) => {
    const h = hold.current
    h.ticks = 0
    h.timeout = setTimeout(() => {
      h.interval = setInterval(() => {
        h.ticks += 1
        applyRef.current(dir * stepForTick(h.ticks, ramp))
      }, HOLD_TICK_MS)
    }, HOLD_DELAY_MS)
  }, [ramp])

  const end = useCallback(() => {
    stop()
    setPressed(null)
  }, [stop])

  const pressProps = useCallback((dir) => ({
    type: 'button',
    onPointerDown: (e) => {
      if (e.button > 0) return
      // Capture keeps pointerup on this element even if the finger slides off,
      // so a hold can never get stuck repeating.
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not critical */ }
      setPressed(dir)
      applyRef.current(dir)
      start(dir)
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    // A button activated from the keyboard or assistive tech fires click with
    // detail 0 and no pointerdown, so this is the only path that needs it.
    onClick: (e) => { if (e.detail === 0) applyRef.current(dir) },
    onContextMenu: (e) => e.preventDefault(),
  }), [start, end])

  return { pressed, pressProps }
}
