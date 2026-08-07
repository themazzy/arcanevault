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

/** Index pages: /binders, /decks, /lists. Mirrors .folderGrid / .folderCard. */
export function TileGridSkeleton({ count = 6, label = 'Loading' }) {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">{label}</span>
      <div className={styles.tileGrid} aria-hidden="true">
        {times(count, i => <Block key={i} kind="tile" className={styles.tile} />)}
      </div>
    </div>
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
