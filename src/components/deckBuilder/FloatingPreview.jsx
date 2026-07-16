import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from '../../pages/DeckBuilder.module.css'

// .floatingImg is a fixed 300px-wide card render at MTG's 63:88mm aspect ratio,
// so the actual box height (~419px) is taller than it looks from the width alone.
const PREVIEW_HEIGHT = 300 * (88 / 63)
const PREVIEW_MARGIN = 16

export function computeFloatingPreviewPos(x, y, imageCount) {
  const width = imageCount > 1 ? 400 : 300
  const left = x > window.innerWidth - (width + 40) ? x - (width - 60) : x + 16
  const top = Math.max(
    PREVIEW_MARGIN,
    Math.min(y - 30, window.innerHeight - PREVIEW_HEIGHT - PREVIEW_MARGIN)
  )
  return { left, top }
}

// How long the fade-out opacity transition runs before we unmount. Kept in
// sync with the `transition` on `.floatingPreview` so the element stays mounted
// for the whole fade.
const FADE_MS = 100

export const FloatingPreview = forwardRef(function FloatingPreview(_props, ref) {
  const [imageUris, setImageUris] = useState([])
  const [visible, setVisible] = useState(false)
  const [initialPointer, setInitialPointer] = useState({ x: 0, y: 0 })
  const elRef = useRef(null)
  const latestPointerRef = useRef({ x: 0, y: 0 })
  const shownRef = useRef(false)
  const hideTimerRef = useRef(null)

  const hide = () => {
    shownRef.current = false
    setVisible(false)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setImageUris([]), FADE_MS)
  }

  useImperativeHandle(ref, () => ({
    setImages: (uris) => {
      const arr = Array.isArray(uris) ? uris : (uris ? [uris] : [])
      if (!arr.length) { hide(); return }
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
      setInitialPointer(latestPointerRef.current)
      setImageUris(arr)
      if (shownRef.current) {
        setVisible(true)               // already open — swap image instantly
      } else {
        setVisible(false)              // fresh open — mount hidden, then fade in.
        // Double rAF: let the opacity:0 state paint in one frame before we flip
        // to 1, otherwise the browser coalesces both and skips the transition.
        requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
      }
      shownRef.current = true
    },
    clearImages: () => hide(),
    setPos: (x, y) => {
      latestPointerRef.current = { x, y }
      const el = elRef.current
      if (!el) {
        setInitialPointer({ x, y })
        return
      }
      const count = el.querySelectorAll('img').length || 1
      const { left, top } = computeFloatingPreviewPos(x, y, count)
      el.style.left = `${left}px`
      el.style.top = `${top}px`
    },
  }), [])

  if (!imageUris.length) return null
  const { x, y } = initialPointer
  const { left, top } = computeFloatingPreviewPos(x, y, imageUris.length)
  return (
    <div ref={elRef} className={styles.floatingPreview} style={{ left, top, opacity: visible ? 1 : 0 }}>
      <div className={styles.floatingPreviewStack}>
        {imageUris.map((uri, index) => (
          <img key={`${uri}:${index}`} className={styles.floatingImg} src={uri} alt="" />
        ))}
      </div>
    </div>
  )
})

export function WarningTooltip({ tooltip }) {
  if (!tooltip) return null
  const left = Math.min(tooltip.x + 14, window.innerWidth - 320)
  const top = Math.min(tooltip.y + 14, window.innerHeight - 160)
  return createPortal(
    <div className={styles.warningTooltip} style={{ left, top }}>
      {tooltip.summary && <div className={styles.warningTooltipTitle}>{tooltip.summary}</div>}
      {Array.isArray(tooltip.details) ? (
        <ul className={styles.warningTooltipList}>
          {tooltip.details.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : (
        <div className={styles.warningTooltipBody}>{tooltip.detail}</div>
      )}
    </div>,
    document.body
  )
}
