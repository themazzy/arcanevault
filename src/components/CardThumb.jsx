import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { scryfallImageUrlFromId } from '../lib/scryfall'
import { lastInputWasTouch } from '../lib/inputType'
import styles from './CardThumb.module.css'

// Device capability: a fine pointer (mouse/trackpad) can hover. Touch-only
// phones can't — they get tap-to-open instead. `lastInputWasTouch` refines this
// per-event so a hybrid laptop's touchscreen doesn't fire a hover on tap.
const CAN_HOVER = typeof window !== 'undefined'
  && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches

/**
 * A small card thumbnail with a device-appropriate full-card preview:
 *  - mouse devices: hover shows a floating card that follows the cursor
 *  - touch / keyboard: click or Enter opens a centered, dismissible overlay
 * Falls back to a neutral placeholder when no scryfall id is available.
 *
 * `variant`: 'art' (default) is a square art_crop crop; 'card' is a portrait
 * (5:7) full-card thumbnail. `size` is the width in px; card variant derives
 * its height. `fill` ignores `size` and stretches to the parent's width at the
 * variant's aspect ratio (for responsive grid tiles). Both preview the full
 * `normal` card image.
 */
export default function CardThumb({ scryfallId, name, size = 40, variant = 'art', fill = false }) {
  const isCard = variant === 'card'
  const thumb = scryfallImageUrlFromId(scryfallId, isCard ? 'small' : 'art_crop')
  const full = scryfallImageUrlFromId(scryfallId, 'normal')
  const w = size
  const h = isCard ? Math.round(size * 7 / 5) : size
  const boxStyle = fill
    ? { width: '100%', aspectRatio: isCard ? '5 / 7' : '1' }
    : { width: w, height: h }
  const [hoverPos, setHoverPos] = useState(null) // {x,y} while hovering (mouse only)
  const [open, setOpen] = useState(false)         // click/tap overlay
  const [broken, setBroken] = useState(false)

  const startHover = useCallback((e) => {
    if (!CAN_HOVER || lastInputWasTouch || !full) return
    setHoverPos({ x: e.clientX, y: e.clientY })
  }, [full])
  const moveHover = useCallback((e) => {
    setHoverPos(prev => (prev ? { x: e.clientX, y: e.clientY } : prev))
  }, [])
  const endHover = useCallback(() => setHoverPos(null), [])

  const openPreview = useCallback((e) => {
    if (!full) return
    // Click-to-enlarge is touch- (and keyboard-) only — on a mouse device the
    // hover preview already covers it, matching the app's established card
    // behavior (DeckBuilder et al.). A keyboard-activated click reports
    // detail === 0, so those still open the overlay for accessibility.
    const isKeyboard = e.detail === 0
    if (CAN_HOVER && !lastInputWasTouch && !isKeyboard) return
    // Don't let the click reach the row (select toggles, etc.).
    e.stopPropagation()
    setHoverPos(null)
    setOpen(true)
  }, [full])

  // Escape closes the preview — and is captured so it doesn't also close the
  // parent modal's focus-trap.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!thumb || broken) {
    return <span className={styles.placeholder} style={boxStyle} aria-hidden="true" />
  }

  return (
    <>
      <button
        type="button"
        className={styles.thumb}
        style={boxStyle}
        onMouseEnter={startHover}
        onMouseMove={moveHover}
        onMouseLeave={endHover}
        onClick={openPreview}
        aria-label={name ? `Preview ${name}` : 'Preview card'}
      >
        <img src={thumb} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />
      </button>

      {hoverPos && full && createPortal(
        <div
          className={styles.floating}
          style={{ left: hoverPos.x + 18, top: Math.max(8, hoverPos.y - 170) }}
        >
          <img className={styles.floatingImg} src={full} alt="" />
        </div>,
        document.body,
      )}

      {open && full && createPortal(
        <div className={styles.overlay} onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label={name || 'Card preview'}>
          <img className={styles.overlayImg} src={full} alt={name || ''} />
        </div>,
        document.body,
      )}
    </>
  )
}
