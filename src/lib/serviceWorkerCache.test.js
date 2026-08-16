// Service-worker runtime cache guards.
//
// Asserts against the BUILT dist/sw.js rather than vite.config.js, because the
// config is only an input — what governs a user's browser is whatever
// vite-plugin-pwa actually emitted. A config change that silently fails to
// reach the output would pass a config-level test and still ship broken.
//
// SKIPS without dist/, like bundleBudget.test.js. CI builds before testing.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SW = path.join(process.cwd(), 'dist', 'sw.js')
const hasSw = fs.existsSync(SW)

/**
 * Pull a numeric option out of the ExpirationPlugin call that follows a named
 * cache. Workbox is minified in the build, so numbers arrive in exponent form
 * (`12e3`, `2592e3`) — Number() normalises both that and plain digits.
 */
function cacheOption(source, cacheName, option) {
  const at = source.indexOf(`${cacheName}"`)
  if (at === -1) return null
  // Bounded window: long enough to cover the plugin list for one cache entry,
  // short enough that it cannot run into the next cache's options.
  const window = source.slice(at, at + 400)
  const match = window.match(new RegExp(`${option}:([0-9.e+]+)`))
  return match ? Number(match[1]) : null
}

describe.skipIf(!hasSw)('service worker runtime caches', () => {
  const sw = hasSw ? fs.readFileSync(SW, 'utf8') : ''

  // The card-image cache must clear the largest real collection (11,354
  // distinct prints as of 2026-08-16) in one pass. Below that it does not cap
  // the cache so much as guarantee permanent re-downloading: the tail of a
  // scroll evicts the head, so scrolling back refetches images already stored.
  it('caches enough card images to cover a full collection', () => {
    const maxEntries = cacheOption(sw, 'scryfall-card-images', 'maxEntries')
    expect(maxEntries, 'scryfall-card-images maxEntries not found in dist/sw.js').toBeTypeOf('number')
    expect(maxEntries).toBeGreaterThanOrEqual(12000)
  })

  // Without this the cache cannot yield when the browser runs low, which is
  // what makes a cap this large safe to ship — especially on mobile.
  it('lets the browser reclaim the image cache under quota pressure', () => {
    const at = sw.indexOf('scryfall-card-images"')
    expect(at, 'scryfall-card-images not found in dist/sw.js').toBeGreaterThan(-1)
    expect(sw.slice(at, at + 400)).toMatch(/purgeOnQuotaError:(!0|true)/)
  })

  // Card art never changes, so a stale-while-revalidate or network-first
  // handler here would spend requests re-validating immutable bytes.
  it('serves card images cache-first', () => {
    expect(sw).toMatch(/CacheFirst/)
  })

  // The scanner pack is ~15 MB of binary chunks cached in IndexedDB by the
  // scanner itself; precaching it would put that on every first visit.
  it('never precaches the scanner hash pack', () => {
    expect(sw).not.toMatch(/scanner\/hashpack/)
  })
})
