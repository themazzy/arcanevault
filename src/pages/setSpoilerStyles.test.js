import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// A CSS module that is missing a class fails *silently*: `styles.cardName` is
// just `undefined`, the element renders with no class, and the build stays
// green. An edit to SetSpoiler.module.css dropped .cardCaption, .cardName and
// .tileSkeleton without anything noticing, so the loading skeletons and card
// captions shipped unstyled.
//
// This pins the JSX and the stylesheet to each other in the only direction that
// matters: every class the page asks for must exist. The reverse (unused CSS)
// is untidy, not broken, so it is not asserted.
const jsx = readFileSync(new URL('./SetSpoiler.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./SetSpoiler.module.css', import.meta.url), 'utf8')

const referenced = new Set(
  [...jsx.matchAll(/\bstyles\.([A-Za-z_][\w]*)/g)].map(m => m[1]),
)
const defined = new Set(
  [...css.matchAll(/^\s*\.([A-Za-z_][\w]*)/gm)].map(m => m[1]),
)

describe('SetSpoiler stylesheet', () => {
  it('defines every class the page references', () => {
    const missing = [...referenced].filter(name => !defined.has(name)).sort()
    expect(missing).toEqual([])
  })

  it('is actually reading both files', () => {
    expect(referenced.size).toBeGreaterThan(20)
    expect(defined.size).toBeGreaterThan(20)
  })
})
