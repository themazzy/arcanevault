import { useCallback, useRef, useState } from 'react'

// Large-image card preview shared by every hoverable card surface in the build
// assistant (suggestion tiles, cut rows, buy-list rows).
//
// Extracted from BuildAssistant.jsx because of a performance bug, and the shape
// of the fix is the reason this is a hook rather than inline state:
//
//   The preview follows the cursor. It used to do that by holding {x, y} in
//   React state and calling setPreview on every mousemove — which re-rendered
//   the whole assistant (up to MAX_TILES=60 unmemoized tiles, 51 top-level
//   useMemos, freshly-allocated handler props per tile) once per pointer frame.
//   Measured at ~5 fps in Firefox on a desktop; bad but survivable in Chrome,
//   which is why it went unnoticed. React Compiler is off (see AGENTS.md), so
//   nothing was auto-memoizing any of it.
//
// So the position is a ref, not state, and moving the pointer writes a transform
// straight onto the portal node. State still holds *which* card is previewed,
// which changes once per hover rather than once per frame.
//
// Anything that follows the cursor in this file should use the same split. The
// giveaway that it has regressed: a setState in an onMouseMove handler.

// Painted width of one card in the preview, so CardImg can pick the tier it
// actually needs. Keep in sync with `.hoverPreviewImg` in the stylesheet.
export const HOVER_PREVIEW_W = 340
export const COMPARE_GAP = 10 // between the two cards of a side-by-side compare

const PREVIEW_H = 476 // tallest the preview paints; used only for the clamp
const EDGE_PAD = 12   // keep at least this much of it inside the viewport
const CURSOR_OFF = 22 // gap between the cursor and the near edge of the card

// Where the preview should sit for a cursor at (x, y): beside the cursor,
// flipping to the other side and then clamping so a 340x476 card (or a 690px
// pair) never spills off-screen.
//
// `cards` is how many are shown side by side — a benched cut shows the deck card
// next to its replacement, and the clamp has to know it is twice as wide or the
// pair runs off the edge instead of flipping.
//
// `viewport` is injectable so the clamping is testable without a real window.
//
// Returns the clamped top-left as {x, y} for assertions, plus the `transform`
// that actually positions the node. It is a transform and not left/top because
// left/top invalidate layout on every frame and keep the node off the
// compositor's fast path — with a 44px blurred box-shadow on the card, that is a
// full repaint of the shadow per frame, and Firefox is markedly slower at it
// than Chrome. As a transform the shadow rasterises once and the layer moves.
export function cardPreviewStyle(x, y, cards = 1, viewport = null) {
  const width = HOVER_PREVIEW_W * cards + (cards - 1) * COMPARE_GAP
  const vw = viewport?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1200)
  const vh = viewport?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 800)

  let left = x + CURSOR_OFF
  if (left + width + EDGE_PAD > vw) left = x - width - CURSOR_OFF
  if (left < EDGE_PAD) left = EDGE_PAD

  let top = y - PREVIEW_H / 2
  if (top < EDGE_PAD) top = EDGE_PAD
  if (top + PREVIEW_H + EDGE_PAD > vh) top = vh - PREVIEW_H - EDGE_PAD

  return { x: left, y: top, width, transform: `translate3d(${left}px, ${top}px, 0)` }
}

// True on pointer devices (hover preview), false on touch (tap-to-open
// lightbox). Read once per mount — the input class does not change mid-session.
function detectHoverCapable() {
  if (typeof window === 'undefined' || !window.matchMedia) return true
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

export function useCardPreview() {
  // { name, scryfall_id?, img?, fallbackImg?, compare? } | null — which card is
  // previewed, NOT where. Changes once per hover.
  const [preview, setPreview] = useState(null)
  const [hoverCapable] = useState(detectHoverCapable)

  const posRef = useRef({ x: 0, y: 0 })   // latest cursor position
  const nodeRef = useRef(null)            // the portaled positioner element
  const cardsRef = useRef(1)              // 1, or 2 for a side-by-side compare

  // Writes the current cursor position straight onto the portal node. This is
  // the whole point of the hook: it runs per pointer frame and does not render.
  const positionPreview = useCallback(() => {
    const el = nodeRef.current
    if (!el) return
    const { x, y } = posRef.current
    const { transform, width } = cardPreviewStyle(x, y, cardsRef.current)
    el.style.transform = transform
    el.style.width = `${width}px`
  }, [])

  // Event handlers for one hoverable card. `card` is
  // { name, scryfall_id?, img?, fallbackImg?, compare? }; a card with none of
  // scryfall_id / img / fallbackImg has no image to enlarge and gets no
  // affordance at all.
  const previewHandlers = useCallback(card => {
    if (!card?.scryfall_id && !card?.img && !card?.fallbackImg) return {}
    if (hoverCapable) {
      return {
        onMouseEnter: e => {
          posRef.current = { x: e.clientX, y: e.clientY }
          setPreview(card)
        },
        // No setState here. See the header comment.
        onMouseMove: e => {
          posRef.current = { x: e.clientX, y: e.clientY }
          positionPreview()
        },
        onMouseLeave: () => setPreview(null),
      }
    }
    return {
      onClick: () => setPreview(p => (p && p.name === card.name ? null : card)),
    }
  }, [hoverCapable, positionPreview])

  // Props for the positioner element wrapping the preview. The inline style
  // makes the first paint land at the cursor (the ref callback fires after the
  // browser has already painted, so positioning only there flashes the card at
  // the top-left corner); every move after that goes through positionPreview.
  const anchorProps = useCallback(cards => {
    cardsRef.current = cards
    const { transform, width } = cardPreviewStyle(posRef.current.x, posRef.current.y, cards)
    return {
      ref: el => { nodeRef.current = el },
      style: { transform, width },
    }
  }, [])

  const clearPreview = useCallback(() => setPreview(null), [])

  // Close the preview if it is showing this card — used when the card is removed
  // from the deck under the cursor, so the preview does not outlive its row.
  const clearPreviewFor = useCallback(name => {
    setPreview(p => (p?.name?.toLowerCase() === (name || '').toLowerCase() ? null : p))
  }, [])

  return { preview, hoverCapable, previewHandlers, anchorProps, clearPreview, clearPreviewFor }
}
