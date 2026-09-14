import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { streamDataEntries } from '../../scripts/lib/mtgjson-stream.mjs'

// The bulk reader walks `{"meta": {...}, "data": {"<key>": {...}, ...}}` by
// brace depth rather than parsing it, because AllPrices uncompressed exceeds
// Node's maximum string length and cannot be JSON.parse'd at all.

/** Feed a JSON document through the reader the way the real gzip arrives. */
async function read(doc, { chunkSize = 64 * 1024, opts } = {}) {
  const gz = gzipSync(Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc)))
  const source = Readable.from((function* () {
    for (let i = 0; i < gz.length; i += chunkSize) yield gz.subarray(i, i + chunkSize)
  })())
  const out = []
  for await (const entry of streamDataEntries(source, opts)) out.push(entry)
  return out
}

describe('streamDataEntries', () => {
  it('yields every entry of the data object', async () => {
    const entries = await read({ meta: { date: '2026-09-13' }, data: { a: { v: 1 }, b: { v: 2 } } })
    expect(entries).toEqual([['a', { v: 1 }], ['b', { v: 2 }]])
  })

  it('reports the meta block before the first entry', async () => {
    // The price ingest anchors its staging window on the build date, so meta
    // has to arrive while there is still time to use it.
    const seen = []
    await read(
      { meta: { date: '2026-09-13', version: '5.2.2' }, data: { a: { v: 1 } } },
      { opts: { onMeta: m => seen.push(m) } },
    )
    expect(seen).toEqual([{ date: '2026-09-13', version: '5.2.2' }])
  })

  it('reports null meta rather than throwing when the shape changes', async () => {
    const seen = []
    await read('{"data":{"a":{"v":1}}}', { opts: { onMeta: m => seen.push(m) } })
    expect(seen).toEqual([null])
  })

  it('reassembles an entry that straddles chunks', async () => {
    // The real file arrives in 64 KB pieces with no regard for entry
    // boundaries; a card whose object spans two of them must not be dropped.
    const doc = { meta: { date: '2026-09-13' }, data: { a: { pad: 'x'.repeat(200) }, b: { v: 2 } } }
    expect(await read(doc, { chunkSize: 16 })).toEqual([
      ['a', { pad: 'x'.repeat(200) }],
      ['b', { v: 2 }],
    ])
  })

  it('is not confused by braces or quotes inside string values', async () => {
    const doc = { meta: {}, data: { a: { name: 'Ach! Hans, {run!}' }, b: { name: 'a "quoted" \\ brace }' } } }
    expect(await read(doc, { chunkSize: 8 })).toEqual([
      ['a', { name: 'Ach! Hans, {run!}' }],
      ['b', { name: 'a "quoted" \\ brace }' }],
    ])
  })

  it('detaches keys from the read buffer', async () => {
    // V8 answers `slice` with a SlicedString that holds its PARENT alive, so a
    // caller keeping one key per entry keeps every chunk those keys were cut
    // from: 1.4 GB of retained buffer across AllPrices' 115k entries, measured
    // 2026-09-14, against 8 MB for the keys themselves. That is what exhausted
    // the price-history job's heap.
    //
    // Retention is not directly observable, so this measures it: keep only the
    // keys from a document padded far beyond their own size and check that the
    // padding went away with them. Needs --expose-gc to be deterministic.
    //
    // The keys must be real uuids. V8 only answers with a SlicedString above
    // SlicedString::kMinLength (13 characters) and copies anything shorter, so
    // a fixture keyed "a"/"b" passes against the bug it is meant to catch.
    const PAD = 2 * 1024 * 1024
    const uuids = ['00010d56-fe38-5e35-8aed-518019aa36a5', '1a2b3c4d-5e6f-4708-9a0b-1c2d3e4f5061']
    const doc = { meta: {}, data: { [uuids[0]]: { pad: 'y'.repeat(PAD) }, [uuids[1]]: { pad: 'z'.repeat(PAD) } } }

    global.gc?.()
    const before = process.memoryUsage().heapUsed
    const keys = (await read(doc)).map(([key]) => key)   // values dropped, keys kept
    expect(keys).toEqual(uuids)

    if (!global.gc) return                     // run vitest with --expose-gc to assert
    global.gc(); global.gc()
    // Two 36-character keys. Verified 2026-09-14 against the pre-fix reader,
    // which retained 2.25 MB here; the fixed one nets below zero.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(PAD)
    // Allocating 4 MB of padding and forcing two GCs is slow, and slower again
    // when vitest is running every other file in parallel: this passed alone in
    // 2.7 s and timed out at the 5 s default in a full run. The duration is not
    // part of what is being asserted, so it gets room rather than a flake.
  }, 30000)
})
