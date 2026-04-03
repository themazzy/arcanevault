import { useRef, useCallback } from 'react'

/**
 * Returns event handlers for a long-press gesture.
 * Cancels if the pointer moves more than `moveThreshold` px (scroll detection).
 * Usage:
 *   const bind = useLongPress(() => enterSelectMode(), { delay: 500 })
 *   <div {...bind}>…</div>
 */
export function useLongPress(callback, { delay = 500, moveThreshold = 10 } = {}) {
  const timerRef   = useRef(null)
  const originRef  = useRef(null) // { x, y } of initial touch
  const firedRef   = useRef(false) // true after long-press fires; lets callers suppress the follow-up click

  const start = useCallback((e) => {
    if (e.type === 'mousedown' && e.button !== 0) return
    firedRef.current = false
    const touch = e.touches?.[0]
    originRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null
    timerRef.current = setTimeout(() => {
      firedRef.current = true
      callback(e)
      timerRef.current = null
    }, delay)
  }, [callback, delay])

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    originRef.current = null
  }, [])

  const onTouchMove = useCallback((e) => {
    if (!timerRef.current || !originRef.current) return
    const t = e.touches[0]
    const dx = t.clientX - originRef.current.x
    const dy = t.clientY - originRef.current.y
    if (Math.abs(dx) > moveThreshold || Math.abs(dy) > moveThreshold) {
      cancel()
    }
  }, [cancel, moveThreshold])

  return {
    onMouseDown:  start,
    onTouchStart: start,
    onMouseUp:    cancel,
    onMouseLeave: cancel,
    onTouchEnd:   cancel,
    onTouchCancel: cancel,
    onTouchMove,
    fired: firedRef, // ref — truthy when long-press just fired; consumer must reset after reading
  }
}
