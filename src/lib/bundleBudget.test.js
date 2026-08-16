// Bundle-size budgets.
//
// Measures the built output rather than the source, because the thing that
// costs a user time is the bytes on the wire, and nothing in the source tree
// tells you what those are. A single `import` added to the wrong module can
// pull a chart library into the app shell without changing a line of visible
// code.
//
// Budgets are gzip, not raw. Cloudflare and GitHub Pages both serve these
// compressed, so raw size is a number no user ever experiences — and the two
// diverge sharply here (Stats is 468 kB raw / 132 kB gzip).
//
// SKIPS when dist/ is absent, so `npm test` still works on a clean checkout.
// CI builds before testing specifically so these run there (see ci.yml).
//
// When a budget fails the answer is usually NOT to raise the number. Check
// what moved into the chunk first: `npx vite build` prints per-chunk sizes,
// and a chunk that grew without a matching feature is normally an import that
// crossed a lazy-route boundary.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'

const DIST = path.join(process.cwd(), 'dist')
const ASSETS = path.join(DIST, 'assets')
const hasDist = fs.existsSync(ASSETS)

const KB = 1024

function gzipKB(file) {
  return zlib.gzipSync(fs.readFileSync(file)).length / KB
}

/** Chunks are content-hashed (`Stats-DUA1vM5_.js`), so match on the stem. */
function findChunk(stem) {
  const hit = fs.readdirSync(ASSETS)
    .filter(f => f.endsWith('.js') && !f.endsWith('.map'))
    .find(f => f.replace(/-[A-Za-z0-9_-]{6,}\.js$/, '') === stem)
  return hit ? path.join(ASSETS, hit) : null
}

describe.skipIf(!hasDist)('bundle budgets', () => {
  // The entry chunk is the one file every visitor downloads and parses before
  // anything renders, on every route. It is the only budget here that is
  // about latency rather than bandwidth, which is why it is the tightest.
  it('entry chunk stays small', () => {
    const entry = findChunk('index')
    expect(entry, 'no dist/assets/index-*.js — did the build change its entry name?').toBeTruthy()
    expect(gzipKB(entry)).toBeLessThan(35)
  })

  // Stats is the largest route chunk in the app by a wide margin because it
  // is the only thing importing recharts. That is acceptable *as long as it
  // stays the only one* — recharts appearing in a second chunk would mean it
  // had been duplicated rather than shared.
  it('recharts stays confined to the Stats chunk', () => {
    const chunks = fs.readdirSync(ASSETS).filter(f => f.endsWith('.js') && !f.endsWith('.map'))
    const withRecharts = chunks.filter(f => {
      const src = fs.readFileSync(path.join(ASSETS, f), 'utf8')
      // A recharts-specific internal string; stable across minification
      // because it is a runtime-emitted class name, not an identifier.
      return src.includes('recharts-wrapper') || src.includes('recharts-surface')
    })
    expect(withRecharts.length, `recharts found in: ${withRecharts.join(', ')}`).toBeLessThanOrEqual(1)
  })

  it('no single route chunk exceeds 150 kB gzip', () => {
    const oversized = fs.readdirSync(ASSETS)
      .filter(f => f.endsWith('.js') && !f.endsWith('.map'))
      .map(f => ({ f, kb: gzipKB(path.join(ASSETS, f)) }))
      .filter(x => x.kb > 150)
      .map(x => `${x.f} ${x.kb.toFixed(0)}kB`)
    expect(oversized, `oversized chunks: ${oversized.join(', ')}`).toEqual([])
  })

  // Everything the service worker precaches is downloaded in the background
  // on a first visit, whether or not the user goes near that route — Admin,
  // Help, Terms and Stats included. This is the budget that governs what a
  // new visitor actually pays for, so it is the one worth watching.
  it('service-worker precache stays under 4 MB', () => {
    const sw = path.join(DIST, 'sw.js')
    expect(fs.existsSync(sw), 'dist/sw.js missing — PWA plugin did not run').toBe(true)

    const manifest = fs.readFileSync(sw, 'utf8')
    const urls = [...manifest.matchAll(/"(?:\.\/)?([^"]+?\.(?:js|css|html|ico|png|svg|webmanifest))"/g)]
      .map(m => m[1])

    let total = 0
    let counted = 0
    for (const url of urls) {
      const file = path.join(DIST, url)
      if (!fs.existsSync(file)) continue
      total += fs.statSync(file).size
      counted++
    }

    expect(counted, 'parsed no precache entries out of sw.js').toBeGreaterThan(50)
    expect(total / KB / KB).toBeLessThan(4)
  })
})
