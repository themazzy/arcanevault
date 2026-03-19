import { useRef, useCallback } from 'react'

/**
 * Returns event handlers for a long-press gesture.
 * Usage:
 *   const bind = useLongPress(() => enterSelectMode(), { delay: 500 })
 *   <div {...bind}>…</div>
 */
export function useLongPress(callback, { delay = 500 } = {}) {
  const timerRef = useRef(null)
  const targetRef = useRef(null)

  const start = useCallback((e) => {
    // Only primary button for mouse, any touch
    if (e.type === 'mousedown' && e.button !== 0) return
    targetRef.current = e.currentTarget
    timerRef.current = setTimeout(() => {
      callback(e)
      timerRef.current = null
    }, delay)
  }, [callback, delay])

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  return {
    onMouseDown: start,
    onTouchStart: start,
    onMouseUp: cancel,
    onMouseLeave: cancel,
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  }
}
