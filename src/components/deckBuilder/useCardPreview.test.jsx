// @vitest-environment jsdom
//
// The reason this file exists is a performance regression, so most of it guards
// against that specific bug coming back: the hover preview used to hold its
// cursor position in React state, so every mousemove re-rendered the whole
// BuildAssistant (60 unmemoized tiles, 51 top-level memos) — ~5 fps in Firefox.
//
// The load-bearing test is "does not re-render while the pointer moves". If that
// one starts failing, the preview is back on setState and the assistant is slow
// again, whatever else still passes.

import { act, cleanup, renderHook } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cardPreviewStyle, useCardPreview, HOVER_PREVIEW_W, COMPARE_GAP } from './useCardPreview'

afterEach(() => {
  cleanup()
  delete window.matchMedia
})

const VP = { width: 1000, height: 800 }
const mouse = (x, y) => ({ clientX: x, clientY: y })

// Renders the hook while counting renders, so a test can assert that an
// interaction did NOT cause one.
function renderCounted() {
  let renders = 0
  const view = renderHook(() => { renders++; return useCardPreview() })
  return { ...view, renderCount: () => renders }
}

describe('cardPreviewStyle', () => {
  it('sits to the right of the cursor and centres on it vertically', () => {
    // 100 + 22 offset = 122; 400 - 476/2 = 162.
    expect(cardPreviewStyle(100, 400, 1, VP)).toMatchObject({ x: 122, y: 162, width: 340 })
  })

  it('emits the position as a translate3d transform, not left/top', () => {
    const s = cardPreviewStyle(100, 400, 1, VP)
    expect(s.transform).toBe('translate3d(122px, 162px, 0)')
    // left/top would invalidate layout every frame and force the blurred shadow
    // to repaint — the Firefox half of the original bug.
    expect(s).not.toHaveProperty('left')
    expect(s).not.toHaveProperty('top')
  })

  it('flips to the left of the cursor rather than overflowing the right edge', () => {
    // 900 + 22 + 340 + 12 pad > 1000, so it flips: 900 - 340 - 22 = 538.
    expect(cardPreviewStyle(900, 400, 1, VP).x).toBe(538)
  })

  it('clamps to the edge padding when flipping would run off the left', () => {
    // Narrow viewport: it cannot fit on either side, so it pins to the pad.
    expect(cardPreviewStyle(300, 400, 1, { width: 400, height: 800 }).x).toBe(12)
  })

  it('clamps the top edge for a cursor near the top of the viewport', () => {
    // 50 - 238 = -188, pinned to the 12px pad.
    expect(cardPreviewStyle(100, 50, 1, VP).y).toBe(12)
  })

  it('clamps the bottom edge for a cursor near the bottom of the viewport', () => {
    // 800 - 476 - 12 = 312.
    expect(cardPreviewStyle(100, 790, 1, VP).y).toBe(312)
  })

  it('widens for a side-by-side compare', () => {
    expect(cardPreviewStyle(100, 400, 2, VP)).toMatchObject({
      x: 122,
      width: HOVER_PREVIEW_W * 2 + COMPARE_GAP, // 690
    })
  })

  it('clamps a pair that fits as a single card — the clamp must know the width', () => {
    // At x=600 a single card still fits to the right (622 + 352 <= 1000)...
    expect(cardPreviewStyle(600, 400, 1, VP).x).toBe(622)
    // ...but the 690px pair does not, and cannot fit flipped either, so it pins.
    expect(cardPreviewStyle(600, 400, 2, VP).x).toBe(12)
  })

  it('falls back to the window when no viewport is injected', () => {
    expect(cardPreviewStyle(100, 400, 1)).toMatchObject({ x: 122, width: 340 })
  })
})

describe('useCardPreview — which card', () => {
  it('gives no preview affordance to a card with no image to enlarge', () => {
    const { result } = renderHook(() => useCardPreview())
    expect(result.current.previewHandlers({ name: 'Sol Ring' })).toEqual({})
  })

  it.each([
    ['a scryfall id', { name: 'Sol Ring', scryfall_id: 'abc' }],
    ['a painted url', { name: 'Sol Ring', img: 'https://x/a.jpg' }],
    ['only a fallback url', { name: 'Sol Ring', fallbackImg: 'https://x/b.jpg' }],
  ])('attaches hover handlers to a card with %s', (_label, card) => {
    const { result } = renderHook(() => useCardPreview())
    expect(Object.keys(result.current.previewHandlers(card)).sort())
      .toEqual(['onMouseEnter', 'onMouseLeave', 'onMouseMove'])
  })

  it('opens on mouseenter and closes on mouseleave', () => {
    const { result } = renderHook(() => useCardPreview())
    const card = { name: 'Sol Ring', scryfall_id: 'abc' }

    expect(result.current.preview).toBeNull()
    act(() => result.current.previewHandlers(card).onMouseEnter(mouse(100, 400)))
    expect(result.current.preview).toMatchObject({ name: 'Sol Ring', scryfall_id: 'abc' })

    act(() => result.current.previewHandlers(card).onMouseLeave())
    expect(result.current.preview).toBeNull()
  })

  it('does not put the cursor position into the previewed card', () => {
    const { result } = renderHook(() => useCardPreview())
    act(() => result.current.previewHandlers({ name: 'Sol Ring', scryfall_id: 'abc' })
      .onMouseEnter(mouse(100, 400)))
    expect(result.current.preview).not.toHaveProperty('x')
    expect(result.current.preview).not.toHaveProperty('y')
  })

  it('carries a compare card through for a benched cut', () => {
    const { result } = renderHook(() => useCardPreview())
    const card = { name: 'Rampant Growth', scryfall_id: 'a', compare: { name: "Kodama's Reach", scryfall_id: 'b' } }
    act(() => result.current.previewHandlers(card).onMouseEnter(mouse(100, 400)))
    expect(result.current.preview.compare).toMatchObject({ name: "Kodama's Reach" })
  })
})

describe('useCardPreview — pointer follow does not render', () => {
  it('does not re-render while the pointer moves', () => {
    const { result, renderCount } = renderCounted()
    const card = { name: 'Sol Ring', scryfall_id: 'abc' }

    act(() => result.current.previewHandlers(card).onMouseEnter(mouse(100, 400)))
    const afterOpen = renderCount()

    // Twenty frames of pointer movement — one render's worth of work in the old
    // implementation was the whole assistant, twenty times over.
    act(() => {
      for (let i = 0; i < 20; i++) {
        result.current.previewHandlers(card).onMouseMove(mouse(100 + i, 400 + i))
      }
    })

    expect(renderCount()).toBe(afterOpen)
    expect(result.current.preview).toMatchObject({ name: 'Sol Ring' })
  })

  it('renders once per hover, not once per pointer event', () => {
    const { result, renderCount } = renderCounted()
    const before = renderCount()
    act(() => result.current.previewHandlers({ name: 'Sol Ring', scryfall_id: 'abc' })
      .onMouseEnter(mouse(100, 400)))
    expect(renderCount() - before).toBe(1)
  })

  it('writes the moved position straight onto the anchor node', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })

    const { result } = renderCounted()
    const card = { name: 'Sol Ring', scryfall_id: 'abc' }
    const el = document.createElement('div')

    act(() => result.current.previewHandlers(card).onMouseEnter(mouse(200, 400)))
    // The portal attaches the anchor; the inline style is the first paint.
    const props = result.current.anchorProps(1)
    expect(props.style).toEqual({ transform: 'translate3d(222px, 162px, 0)', width: 340 })
    act(() => props.ref(el))

    act(() => result.current.previewHandlers(card).onMouseMove(mouse(300, 500)))
    expect(el.style.transform).toBe('translate3d(322px, 262px, 0)')
    expect(el.style.width).toBe('340px')
  })

  it('keeps the compare width when the anchor holds a pair', () => {
    const { result } = renderCounted()
    const card = { name: 'Rampant Growth', scryfall_id: 'a', compare: { name: "Kodama's Reach" } }
    const el = document.createElement('div')

    act(() => result.current.previewHandlers(card).onMouseEnter(mouse(200, 400)))
    act(() => result.current.anchorProps(2).ref(el))
    act(() => result.current.previewHandlers(card).onMouseMove(mouse(210, 410)))

    expect(el.style.width).toBe('690px')
  })

  it('survives a move with no anchor attached', () => {
    const { result } = renderHook(() => useCardPreview())
    const card = { name: 'Sol Ring', scryfall_id: 'abc' }
    expect(() => act(() => result.current.previewHandlers(card).onMouseMove(mouse(1, 1)))).not.toThrow()
  })
})

describe('useCardPreview — touch', () => {
  const asTouchDevice = () => {
    window.matchMedia = query => ({
      matches: false, media: query,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false },
    })
  }

  it('uses a tap toggle instead of hover handlers', () => {
    asTouchDevice()
    const { result } = renderHook(() => useCardPreview())
    expect(result.current.hoverCapable).toBe(false)

    const handlers = result.current.previewHandlers({ name: 'Sol Ring', scryfall_id: 'abc' })
    expect(Object.keys(handlers)).toEqual(['onClick'])
  })

  it('toggles the same card closed on a second tap', () => {
    asTouchDevice()
    const { result } = renderHook(() => useCardPreview())
    const card = { name: 'Sol Ring', scryfall_id: 'abc' }

    act(() => result.current.previewHandlers(card).onClick())
    expect(result.current.preview).toMatchObject({ name: 'Sol Ring' })
    act(() => result.current.previewHandlers(card).onClick())
    expect(result.current.preview).toBeNull()
  })

  it('switches to a different card rather than closing', () => {
    asTouchDevice()
    const { result } = renderHook(() => useCardPreview())

    act(() => result.current.previewHandlers({ name: 'Sol Ring', scryfall_id: 'a' }).onClick())
    act(() => result.current.previewHandlers({ name: 'Arcane Signet', scryfall_id: 'b' }).onClick())
    expect(result.current.preview).toMatchObject({ name: 'Arcane Signet' })
  })
})

describe('useCardPreview — clearing', () => {
  it('clears unconditionally', () => {
    const { result } = renderHook(() => useCardPreview())
    act(() => result.current.previewHandlers({ name: 'Sol Ring', scryfall_id: 'a' }).onMouseEnter(mouse(1, 1)))
    act(() => result.current.clearPreview())
    expect(result.current.preview).toBeNull()
  })

  it('clears for a named card, case-insensitively', () => {
    const { result } = renderHook(() => useCardPreview())
    act(() => result.current.previewHandlers({ name: 'Sol Ring', scryfall_id: 'a' }).onMouseEnter(mouse(1, 1)))
    act(() => result.current.clearPreviewFor('sol ring'))
    expect(result.current.preview).toBeNull()
  })

  it('leaves a preview of a different card alone', () => {
    const { result } = renderHook(() => useCardPreview())
    act(() => result.current.previewHandlers({ name: 'Sol Ring', scryfall_id: 'a' }).onMouseEnter(mouse(1, 1)))
    act(() => result.current.clearPreviewFor('Arcane Signet'))
    expect(result.current.preview).toMatchObject({ name: 'Sol Ring' })
  })
})

// The hook writes a transform to the anchor node, which only works if the
// stylesheet keeps the two-element split: an unanimated positioner outside, the
// animated card inside. Merging them back looks harmless and silently breaks the
// entry animation (the animation's own `transform` overrides the inline one for
// its full 120ms, flashing the card at the top-left corner first).
describe('hover preview stylesheet', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/components/deckBuilder/BuildAssistant.module.css'),
    'utf8',
  )
  const ruleFor = name => {
    const m = css.match(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`))
    return m ? m[1] : null
  }

  it('has a separate positioner for the cursor-follow transform', () => {
    const anchor = ruleFor('hoverPreviewAnchor')
    expect(anchor).toBeTruthy()
    expect(anchor).toMatch(/position:\s*fixed/)
    expect(anchor).toMatch(/pointer-events:\s*none/) // never eat the driving hover
  })

  it('does not position the animated card itself', () => {
    const card = ruleFor('hoverPreview')
    expect(card).toBeTruthy()
    expect(card).toMatch(/animation:\s*hoverPreviewIn/)
    expect(card).not.toMatch(/position:\s*fixed/)
    expect(card).not.toMatch(/^\s*(left|top):/m)
  })
})
