// Touch long-press helper for desktop-style context menus on mobile.
// Stores per-element timer/fired flags directly on the DOM node so the
// state survives React re-renders triggered by the long-press itself.

const LONG_PRESS_MS = 500
const MOVE_THRESHOLD = 10

function clearTimer(node) {
  if (node.__lpTimer) {
    clearTimeout(node.__lpTimer)
    node.__lpTimer = null
  }
}

export function bindTouchContextMenu(onLongPress) {
  return {
    onTouchStart(e) {
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      const node = e.currentTarget
      node.__lpStart = { x: t.clientX, y: t.clientY }
      node.__lpFired = false
      clearTimer(node)
      node.__lpTimer = setTimeout(() => {
        node.__lpTimer = null
        node.__lpFired = true
        e.preventDefault?.()
        e.stopPropagation?.()
        onLongPress({
          clientX: node.__lpStart.x,
          clientY: node.__lpStart.y,
          preventDefault: () => {},
          stopPropagation: () => {},
          touchSource: true,
        })
      }, LONG_PRESS_MS)
    },
    onTouchMove(e) {
      const node = e.currentTarget
      if (!node.__lpStart || !node.__lpTimer) return
      const t = e.touches[0]
      if (
        Math.abs(t.clientX - node.__lpStart.x) > MOVE_THRESHOLD ||
        Math.abs(t.clientY - node.__lpStart.y) > MOVE_THRESHOLD
      ) {
        clearTimer(node)
      }
    },
    onTouchEnd(e) {
      clearTimer(e.currentTarget)
    },
    onTouchCancel(e) {
      clearTimer(e.currentTarget)
    },
    onContextMenu(e) {
      e.preventDefault()
      e.stopPropagation()
      clearTimer(e.currentTarget)
      onLongPress(e)
    },
  }
}

// Returns true and clears the flag if a long-press just fired on this node;
// callers should `return` early when this is true to suppress the synthesized
// click that follows the touch sequence.
export function consumeLongPressClick(e) {
  // Long-press flag is set on the element that received touchstart, which is
  // the outer wrapper. Click events fire on the innermost target. Walk up
  // until we find a node with the flag, or run out of ancestors.
  let node = e.currentTarget
  while (node) {
    if (node.__lpFired) {
      node.__lpFired = false
      return true
    }
    node = node.parentElement
  }
  return false
}
