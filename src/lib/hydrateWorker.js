// Phase 2b (performance-upgrade-plan.md): hydrate the Scryfall metadata cache
// off the main thread. Reading + deserializing ~12k IDB entries was the
// single largest main-thread block at startup; doing it here lets the UI
// paint while the map builds. The main thread receives one structured-clone
// of the finished map (unavoidable, but far cheaper than read+build).

import { openDB } from 'idb'

self.onmessage = async (e) => {
  if (e.data !== 'hydrate') return
  try {
    // Open without a version so this NEVER runs migrations — schema upgrades
    // belong to the main thread (db.js). On a fresh install this may create
    // an empty v1 database; we just report zero entries and the main thread's
    // normal path takes over.
    const db = await openDB('arcanevault')
    const entries = db.objectStoreNames.contains('scryfall')
      ? await db.getAll('scryfall')
      : []
    db.close()

    const map = {}
    for (const entry of entries) {
      if (entry?.key) map[entry.key] = entry
    }
    self.postMessage({ ok: true, map, count: entries.length })
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) })
  }
}
