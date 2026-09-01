import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// `navigateFallback` is precache-first, not offline-only: with the service
// worker installed it answers every in-scope navigation from cache. A /d/<id>
// open therefore never left the browser, Cloudflare never saw the request, and
// the og-worker never counted the view — deck views were only ever recorded for
// people who had never visited DeckLoom before.
//
// Losing this one entry silently reverts that, and nothing else in the suite
// would notice, so it is asserted from the config source.
const config = readFileSync(resolve(process.cwd(), 'vite.config.js'), 'utf8')

function denylistSource() {
  const match = config.match(/navigateFallbackDenylist:\s*\[([^\]]*)\]/)
  return match?.[1] ?? ''
}

describe('service worker navigation denylist', () => {
  it('is configured at all', () => {
    expect(denylistSource()).not.toBe('')
  })

  it('excludes /d/ so shared-deck opens reach the network and get counted', () => {
    expect(denylistSource()).toContain('/^\\/d\\//')
  })

  it('still excludes /api/ so worker endpoints are never served from cache', () => {
    expect(denylistSource()).toContain('/^\\/api\\//')
  })

  it('leaves the app shell fallback in place for every other route', () => {
    // The denylist is an exception list; removing navigateFallback entirely
    // would break offline app-shell loading for the whole SPA.
    expect(config).toMatch(/navigateFallback:\s*'index\.html'/)
  })
})
