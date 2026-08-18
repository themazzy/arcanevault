import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProfileSkeleton } from './Profile'

// CSS-module class names compile to `_name_hash`, so the leading and trailing
// underscores make these exact: `_banner_` does not match `_bannerInner_`.
const html = () => renderToStaticMarkup(<ProfileSkeleton />)

describe('ProfileSkeleton', () => {
  // The point of the rebuild. The old version was a 220px block against a real
  // banner of 280px+ (`calc(var(--nav-h) + 96px)` of padding around a 68px
  // avatar), plus a 52px margin it rendered as 28px. Rendering the real
  // containers means those numbers are never restated, so they cannot drift.
  it('renders the page’s own banner containers rather than a sized block', () => {
    const markup = html()
    for (const cls of ['_banner_', '_bannerInner_', '_identity_', '_avatar_', '_ledger_']) {
      expect(markup).toContain(cls)
    }
  })

  // The showcase had no placeholder at all, so the whole bento grid popped in
  // below the fold once the query resolved.
  it('reserves the showcase below the banner', () => {
    const markup = html()
    expect(markup).toContain('_panels_')
    expect((markup.match(/_section_/g) || []).length).toBeGreaterThan(0)
  })

  it('keeps <dl> term-before-definition order in the ledger', () => {
    const markup = html()
    expect(markup.indexOf('<dt')).toBeGreaterThan(-1)
    expect(markup.indexOf('<dt')).toBeLessThan(markup.indexOf('<dd'))
  })

  it('announces itself once and hides the placeholder shapes', () => {
    const markup = html()
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('role="status"')
    expect((markup.match(/aria-hidden="true"/g) || []).length).toBeGreaterThan(0)
  })
})
