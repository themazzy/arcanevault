import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The import modals drifted off the design system far enough to ship real
// bugs — a hover rule that greyed out its own active tab, a field with no
// keyboard affordance at all, and chips that looked exactly like the one
// button beside them. None of that is reachable from a rendering test: vitest
// stubs CSS modules, so there is no cascade to assert against. These read the
// stylesheets as text instead. See DESIGN.md §4, §7, §10.

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const SHEETS = {
  'ImportModal.module.css': read('./ImportModal.module.css'),
  'DeckImportModal.module.css': read('./deckBuilder/DeckImportModal.module.css'),
  'ImportReviewList.module.css': read('./import/ImportReviewList.module.css'),
  'ImportSourceStep.module.css': read('./import/ImportSourceStep.module.css'),
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every rule block, as [selector, body] pairs. */
const rules = (css) =>
  [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2]])

describe.each([
  ['ImportModal.module.css', SHEETS['ImportModal.module.css']],
  ['DeckImportModal.module.css', SHEETS['DeckImportModal.module.css']],
])('%s dialog sizing', (_name, raw) => {
  const modal = stripComments(raw).match(/\.modal\s*\{([^}]*)\}/)?.[1] || ''

  it('fixes its own height instead of following its content', () => {
    // Both modals pass Modal `autoHeight={false}`, so the CSS is the only thing
    // sizing them. Without a height here the dialog collapses to its content
    // and starts jumping again on every step and status change.
    expect(modal).toMatch(/height:\s*min\(/)
  })

  it('never grows past the viewport', () => {
    expect(modal).toMatch(/calc\(100dvh/)
  })
})

describe.each(Object.entries(SHEETS))('%s', (_name, raw) => {
  const css = stripComments(raw)

  it('scopes tab hover with :not() so it cannot outrank the active tab', () => {
    // `.tab:hover` is (0,2,0) and `.tabActive` is (0,1,0), so a bare hover rule
    // wins and the selected tab greys out under the pointer. DESIGN.md §10.
    expect(css.match(/\.\w*[Tt]ab\w*:hover(?!:not\()/g)).toBeNull()
  })

  it('never kills the focus outline', () => {
    // index.css carries a zero-specificity :focus-visible baseline. A local
    // `outline: none` is (0,1,0) and silently defeats it — which is how the
    // new-folder name field ended up with no keyboard affordance whatsoever.
    expect(css).not.toMatch(/outline:\s*none/)
  })

  it('uses colour tokens rather than raw hex or rgba literals', () => {
    // Hardcoded rgba borders/backgrounds are invisible on light themes, and a
    // hex like #e07070 bypasses --red-bright, the token added precisely
    // because --red is too dark for small text. DESIGN.md §1.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/\brgba?\(/)
  })

  it('keeps radii on the token scale', () => {
    for (const [, body] of rules(raw)) {
      const radius = body.match(/border-radius:\s*([^;]+);/)?.[1]?.trim()
      if (!radius) continue
      // 50% is a circle (the foil switch knob); everything else is a token.
      expect(radius === '50%' || /^var\(--radius-/.test(radius)).toBe(true)
    }
  })

  it('shapes every chip as a chip, never as a button', () => {
    // DESIGN.md §4 — a chip and a button must never be mistakable. These all
    // wore a 1px border and a 3px radius, identical to the Edit button sitting
    // in the same row. Covers the shared chips and the per-modal ones each
    // import passes in through renderRowTags.
    for (const [selector, body] of rules(raw)) {
      if (!/^\s*\.(tag|rowTag)/i.test(selector)) continue
      if (/:hover|:focus|:disabled|\s\./.test(selector)) continue
      if (!/border-radius|border:/.test(body)) continue // colour-only modifier
      expect(body, `${selector} must use the pill radius`).toMatch(/border-radius:\s*var\(--radius-pill\)/)
      expect(body, `${selector} must not have a border`).not.toMatch(/^\s*border:/m)
      // Fixed-height box + small caps needs line-height:1 or the glyphs ride high.
      expect(body, `${selector} needs an explicit line-height`).toMatch(/line-height:\s*(1\b|20px)/)
    }
  })
})
