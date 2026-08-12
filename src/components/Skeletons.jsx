import { useEffect, useState } from 'react'
import styles from './Skeletons.module.css'

// Shared loading skeletons for the collection surfaces.
//
// These replace centred "Loading…" text. The point is not decoration: each
// shape occupies the same space the real content will, so the swap does not
// reflow the page, and the user can see what kind of thing is arriving before
// it gets there.
//
// Every skeleton hides its placeholder blocks from assistive tech and exposes a
// single status message instead, so a screen reader hears "Loading binders"
// rather than a run of empty regions.

// `kind` is emitted as a data attribute rather than relying on the class name:
// CSS-module classes are hashed at build time, so they are not a stable handle
// for tests or for anyone inspecting the DOM.
function Block({ kind, className }) {
  return <span data-skeleton={kind} className={`${styles.block} ${className}`} />
}

function times(count, render) {
  return Array.from({ length: count }, (_, i) => render(i))
}

/**
 * Index pages: /binders, /decks, /lists. Mirrors .folderGrid / .folderCard.
 *
 * The tile is a real bordered card rather than one solid shimmer block, and it
 * carries the name and meta line the loaded tile will have, in the same places.
 * A featureless block reads as "something rectangular is coming"; this reads as
 * "binders are coming", and nothing moves when they arrive.
 *
 * This stands in for the grid only — the page header, search and actions are
 * rendered for real by the pages, so they never pop in.
 */
export function TileGridSkeleton({ count = 6, label = 'Loading' }) {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">{label}</span>
      <div className={styles.tileGrid} aria-hidden="true">
        {times(count, i => (
          <div key={i} data-skeleton="tile" className={styles.tile}>
            <Block kind="tile-name" className={styles.tileName} />
            <div className={styles.tileMeta}>
              <Block kind="tile-count" className={styles.tileCount} />
              <Block kind="tile-value" className={styles.tileValue} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The price slot of an index tile, while prices are still being computed.
 *
 * Counts land well before values on these pages (prices need a Scryfall map
 * plus a shared-price overlay), so the value slot would otherwise sit on a
 * faint "—" that is indistinguishable from a folder genuinely worth nothing.
 * Sized to a typical formatted price so the swap does not shift the meta row.
 *
 * Callers must stop rendering it once the price phase settles — including when
 * it settles by failing — or it shimmers forever. See `pricesPending`.
 */
export function ValueSkeleton({ label = 'Value loading' }) {
  return (
    <span data-skeleton="value" className={`${styles.block} ${styles.value}`}>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/**
 * Inside a binder, collection deck, or wishlist.
 *
 * `viewMode` matches the browser's own preference (grid / stacks / table /
 * text) so the placeholder is the shape the user actually has selected —
 * showing a card grid to someone who browses in table view would reflow twice.
 */
export function BrowserSkeleton({ viewMode = 'grid', count, label = 'Loading' }) {
  const isGrid = viewMode === 'grid'
  const items = count ?? (isGrid ? 12 : 10)

  return (
    <div className={styles.page} aria-busy="true">
      <span className="sr-only" role="status">{label}</span>
      <div className={styles.header} aria-hidden="true">
        <Block kind="header-title" className={styles.headerTitle} />
        <Block kind="header-meta" className={styles.headerMeta} />
        <Block kind="header-controls" className={styles.headerControls} />
      </div>
      {isGrid ? (
        <div className={styles.cardGrid} aria-hidden="true">
          {times(items, i => <Block key={i} kind="card" className={styles.card} />)}
        </div>
      ) : (
        <div className={styles.rowList} aria-hidden="true">
          {times(items, i => <Block key={i} kind="row" className={styles.row} />)}
        </div>
      )}
    </div>
  )
}

/**
 * Whole-app boot gate — AuthProvider, before the session resolves.
 *
 * Deliberately layout-agnostic. This renders above the router's route split, so
 * it cannot know whether the app shell or a public page like /d/:id is coming
 * next; committing to either would swap into the wrong shape for the other.
 *
 * Unlike the other skeletons it waits before appearing. The session normally
 * resolves from localStorage in a few milliseconds, and a shimmer that flashes
 * for a frame is worse than showing nothing at all. The delay only pays off on
 * the slow path — an expired token being refreshed over the network — which is
 * exactly the case where a blank screen would otherwise look like a hang.
 */
export function AppBootSkeleton({ delayMs = 150, label = 'Loading DeckLoom' }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), delayMs)
    return () => clearTimeout(timer)
  }, [delayMs])

  return (
    <div className={styles.boot} aria-busy="true">
      <span className="sr-only" role="status">{label}</span>
      {visible && (
        <>
          <div className={styles.bootBar} aria-hidden="true">
            <Block kind="boot-brand" className={styles.bootBrand} />
          </div>
          <div className={styles.bootBody} aria-hidden="true">
            <Block kind="boot-title" className={styles.bootTitle} />
            <Block kind="boot-line" className={styles.bootLine} />
            <div className={styles.bootGrid}>
              {times(3, i => <Block key={i} kind="boot-tile" className={styles.bootTile} />)}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
