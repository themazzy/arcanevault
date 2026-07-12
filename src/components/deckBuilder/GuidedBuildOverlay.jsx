import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './GuidedBuildOverlay.module.css'

/**
 * Full-screen blocker shown while a guided build spins up. It appears the
 * moment "Start Building" is clicked (in Builder) and stays through the route
 * change + DeckBuilder load + commander print resolution, so the empty builder
 * never flashes and the user doesn't think the page lagged. Both Builder and
 * DeckBuilder render it with identical markup, so the hand-off across the
 * navigation is seamless — the backdrop is opaque from the first frame (no
 * enter fade), so remounts during the transition never flash the page behind.
 * It only fades on the way *out*, once the Build Assistant is ready.
 *
 * Portaled to <body> so it covers the viewport regardless of where it's
 * mounted and can't be clipped by an ancestor's overflow/transform.
 */
export default function GuidedBuildOverlay({ visible, commanderName }) {
  const [mounted, setMounted] = useState(visible)

  useEffect(() => {
    if (visible) { setMounted(true); return }
    // Keep it around for the exit fade, then unmount.
    const t = setTimeout(() => setMounted(false), 240)
    return () => clearTimeout(t)
  }, [visible])

  if (!mounted) return null

  return createPortal(
    <div
      className={`${styles.overlay}${visible ? '' : ' ' + styles.out}`}
      role="status"
      aria-live="polite"
    >
      <div className={styles.card}>
        <div className={styles.ring} aria-hidden="true" />
        <div className={styles.text}>
          <div className={styles.title}>Preparing your build</div>
          <div className={styles.sub}>
            {commanderName ? (
              <>
                Summoning <span className={styles.name}>{commanderName}</span> and
                {' '}scanning your collection
              </>
            ) : (
              <>Setting things up</>
            )}
            <span className={styles.dots} aria-hidden="true">
              <span>.</span><span>.</span><span>.</span>
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
