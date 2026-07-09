// fake-indexeddb/auto must be imported before db.js so idb's openDB sees the
// polyfilled globals.
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { getMeta, setMeta, _simulateExternalConnectionClose } from './db'

describe('IDB connection recovery', () => {
  it('reads and writes through the meta store', async () => {
    await setMeta('probe-key', 'probe-value')
    expect(await getMeta('probe-key')).toBe('probe-value')
  })

  // Browsers close IDB connections behind backgrounded tabs (Android under
  // memory pressure especially). The cached handle then throws "Failed to
  // execute 'transaction' on 'IDBDatabase': The database connection is
  // closing" on every call until reload — seen live in the Build Assistant.
  // The db layer must detect the dead handle and reopen transparently.
  it('recovers after the browser closes the connection externally', async () => {
    await setMeta('survives-close', 'yes')

    await _simulateExternalConnectionClose()

    expect(await getMeta('survives-close')).toBe('yes')
    // Writes must recover too, not just reads.
    await setMeta('post-close-write', 'ok')
    expect(await getMeta('post-close-write')).toBe('ok')
  })

  it('recovers repeatedly, not just once', async () => {
    for (let i = 0; i < 3; i++) {
      await _simulateExternalConnectionClose()
      await setMeta(`round-${i}`, i)
      expect(await getMeta(`round-${i}`)).toBe(i)
    }
  })
})
