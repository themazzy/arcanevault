import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Regression guard for a bug that shipped three separate times: `SearchInput`
// puts only the caller's className on the inner <input>, so a caller passing a
// layout-only class (or none at all) rendered a bare white browser field.
// UI.module.css carries a zero-specificity baseline that makes that impossible.
// If the rule is edited away or its :where() wrappers are dropped, this fails.

const css = readFileSync(
  fileURLToPath(new URL('./UI.module.css', import.meta.url)),
  'utf8',
)

const BASELINE = /:where\(\.searchWrap\)\s+:where\(input\)\s*\{([^}]*)\}/

describe('SearchInput baseline styling', () => {
  it('styles the inner input, not just the wrapper', () => {
    const match = css.match(BASELINE)
    expect(match).toBeTruthy()
    const body = match[1]
    // The properties whose absence produced the "unstyled white box" look.
    expect(body).toMatch(/background:/)
    expect(body).toMatch(/border:/)
    expect(body).toMatch(/color:/)
  })

  it('keeps both selector parts inside :where() so any caller class wins', () => {
    // Specificity 0,0,0. A caller class is 0,1,0 and beats it regardless of
    // which CSS-module chunk the bundler emits first — stylesheet order is not
    // a reliable tiebreaker across modules.
    expect(css).not.toMatch(/(?<!:where\()\.searchWrap\s+input\s*\{/)
    expect(css).toMatch(BASELINE)
  })

  it('covers focus and placeholder too', () => {
    expect(css).toMatch(/:where\(\.searchWrap\)\s+:where\(input\):focus\s*\{/)
    expect(css).toMatch(/:where\(\.searchWrap\)\s+:where\(input\)::placeholder\s*\{/)
  })
})
