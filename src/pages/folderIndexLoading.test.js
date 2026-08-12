import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Source guards for how the three collection index pages behave while they
// load. These are structural rules that no rendered assertion can reach
// cheaply — the pages pull in Supabase, IDB, React Query and a worker — but
// each one encodes a regression that is invisible until someone opens the page
// on a cold cache.

const read = name => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')

const PAGES = {
  'Folders.jsx': read('./Folders.jsx'),   // /binders and /decks
  'Lists.jsx':   read('./Lists.jsx'),     // /wishlists
}

describe.each(Object.entries(PAGES))('%s index loading', (_name, src) => {
  // The whole-page `if (loading) return <TileGridSkeleton />` this replaced
  // withheld the header, search and action buttons until the fetch landed, so
  // the page chrome popped in and pushed the grid down.
  it('skeletonizes only the grid, never the whole page', () => {
    expect(src).not.toMatch(/if \(loading\) return <TileGridSkeleton/)
    expect(src).toMatch(/\{gridLoading && <TileGridSkeleton/)
  })

  // A seeded render has real folder names in hand — replacing them with
  // placeholders would be a downgrade, not a loading state.
  it('only shows the grid skeleton when there is nothing to show', () => {
    expect(src).toMatch(/const gridLoading = loading && folders\.length === 0/)
  })

  // The empty state is the first-run case. Rendering it while the fetch is
  // still out told returning users they had no binders, one frame before their
  // binders appeared.
  it('holds the empty state back until loading settles', () => {
    expect(src).toMatch(/folders\.length === 0 && !loading/)
  })

  // Counts land before values, so `pricesPending` distinguishes "not priced
  // yet" from "worth nothing" on the tile. It must be cleared on the paths
  // where prices never arrive as well, or those tiles shimmer forever.
  it('clears pricesPending on failure paths, not just the happy one', () => {
    const clears = src.match(/setPricesPending\(false\)/g) || []
    expect(clears.length).toBeGreaterThanOrEqual(4)
    expect(src).toMatch(/foldersError\) \{[^}]*setPricesPending\(false\)/)
  })

  it('falls back to a dash once the price phase has settled', () => {
    expect(src).toMatch(/pricesPending \? <ValueSkeleton \/> : '—'/)
  })
})

describe('deck tile status badges', () => {
  const css = read('./Folders.module.css')
  const badge = name => css.match(new RegExp(`\\.${name} \\{([^}]*)\\}`))?.[1] ?? ''

  // A linked deck shows this badge on /decks and on /builder. It was a red
  // 999px pill here and an orange --radius-xs badge there, which read as two
  // different states rather than one.
  it('matches the Builder tile badge shape', () => {
    for (const name of ['tradeTag', 'unsyncedTag']) {
      const body = badge(name)
      expect(body).toMatch(/composes: labelSm from/)
      expect(body).toMatch(/border-radius: var\(--radius-xs\)/)
      expect(body).not.toMatch(/border-radius: (999px|var\(--radius-pill\))/)
      // Sizing comes from the label token, not a hand-picked rem value.
      expect(body).not.toMatch(/font-size:/)
    }
  })

  // Unsynced is the caution token, not the danger one: the pair has drifted,
  // nothing has failed.
  it('uses the caution colour for unsynced, not red', () => {
    const body = badge('unsyncedTag')
    expect(body).toMatch(/color: var\(--orange\)/)
    expect(body).not.toMatch(/var\(--red\)/)
  })
})
