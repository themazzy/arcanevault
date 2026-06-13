// Phase 2b/2e (performance-upgrade-plan.md): hydrate the Scryfall metadata
// cache AND pre-read today's+yesterday's shared price rows off the main
// thread. Reading + deserializing ~12k metadata entries plus ~21k price rows
// was the two largest main-thread blocks at startup; doing both here lets the
// UI paint while they run, and the main thread receives one structured clone.

import { openDB } from 'idb'

function isoDateUtc(daysOffset = 0) {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + daysOffset)
  return date.toISOString().slice(0, 10)
}

self.onmessage = async (e) => {
  if (e.data !== 'hydrate') return
  try {
    // Open without a version so this NEVER runs migrations — schema upgrades
    // belong to the main thread (db.js). On a fresh install this may create
    // an empty database; we just report zero entries and the main thread's
    // normal path takes over.
    const db = await openDB('arcanevault')

    const entries = db.objectStoreNames.contains('scryfall')
      ? await db.getAll('scryfall')
      : []

    // Pre-read shared price rows for the two snapshot dates the overlay needs.
    const priceDates = [isoDateUtc(0), isoDateUtc(-1)]
    let priceRows = []
    if (db.objectStoreNames.contains('card_prices')) {
      const byDate = await Promise.all(
        priceDates.map(d => db.getAllFromIndex('card_prices', 'snapshot_date', d)),
      )
      priceRows = byDate.flat()
    }

    db.close()

    const map = {}
    for (const entry of entries) {
      if (entry?.key) map[entry.key] = entry
    }
    self.postMessage({ ok: true, map, count: entries.length, priceRows, priceDates })
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) })
  }
}
