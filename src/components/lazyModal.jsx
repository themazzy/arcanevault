import { Suspense, lazy } from 'react'

// Route-level code splitting stops at the page. DeckBuilder is the page, but
// most of its weight is in modals that a given session may never open — the
// Build Assistant alone is ~37% of the route's JavaScript and a third of its
// CSS, downloaded on every deck open whether or not the wizard is used.
//
// Wrapping a lazy import in its own Suspense lets each call site stay exactly as
// it was: these modals are already rendered conditionally (`{showSync && <SyncModal/>}`),
// so the chunk is requested by the same condition that mounts the component, and
// nothing above needs a boundary.
//
// `fallback` is null on purpose. Every one of these is an overlay opened by a
// deliberate click, so the correct appearance while its chunk arrives is the
// page the user was already looking at — a spinner or a half-drawn shell would
// be a flash of new UI over the top of it.
//
// `pick` names the export for a module that has no default.
export function lazyModal(loader, pick = null) {
  const Inner = lazy(pick ? () => loader().then(m => ({ default: m[pick] })) : loader)
  function LazyModal(props) {
    return (
      <Suspense fallback={null}>
        <Inner {...props} />
      </Suspense>
    )
  }
  // Without this every split modal shows up as "LazyModal" in the React
  // profiler and in component stacks, which is exactly where you go looking
  // when one of them is slow.
  LazyModal.displayName = `LazyModal(${pick || 'default'})`
  return LazyModal
}
