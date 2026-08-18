import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TradePostStatusSkeleton } from './TradePostPanel'

// CSS-module class names compile to `_name_hash`, so the trailing underscore
// makes these exact: `_statusStat_` does not match `_statusStats_`.
const html = () => renderToStaticMarkup(<TradePostStatusSkeleton />)

describe('TradePostStatusSkeleton', () => {
  // It replaced a centred "Loading your trade post…" line, which was a fraction
  // of the card's height — the panel jumped once the counts arrived. Rendering
  // .statusCard and the rows inside it means the height comes from the card's
  // own padding and gaps rather than from a number restated here.
  it('renders the real status card and its rows', () => {
    const markup = html()
    for (const cls of ['_statusCard_', '_statusHead_', '_statusStats_', '_linkRow_']) {
      expect(markup).toContain(cls)
    }
  })

  it('reserves both stat cells, not one', () => {
    expect((html().match(/_statusStat_/g) || []).length).toBe(2)
  })

  it('announces itself once and hides the placeholder shapes', () => {
    const markup = html()
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('role="status"')
    expect((markup.match(/aria-hidden="true"/g) || []).length).toBe(3)
  })
})
