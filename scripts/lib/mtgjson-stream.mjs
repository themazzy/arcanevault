/**
 * Streaming reader for MTGJSON's bulk files.
 *
 * These cannot be JSON.parse'd: AllPrices is 143 MB gzipped and its
 * uncompressed text exceeds Node's maximum string length outright
 * (ERR_STRING_TOO_LONG). So the top-level `data` object is walked entry by
 * entry, yielding one `[key, object]` pair at a time and keeping only a small
 * buffer plus whatever the caller retains.
 *
 * It is a brace-depth scanner rather than a full JSON parser because the shape
 * is known and fixed: `{"meta": {...}, "data": {"<uuid>": {...}, ...}}`. String
 * literals are tracked so braces inside card names or dates cannot confuse the
 * depth count.
 */
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'

const BACKSLASH = 92, QUOTE = 34, OPEN = 123, CLOSE = 125

/**
 * Index of the `}` closing the object that opens at `open`, or -1 if the buffer
 * does not yet hold it.
 */
function matchingBrace(s, open) {
  let depth = 0, inStr = false, esc = false
  for (let p = open; p < s.length; p++) {
    const code = s.charCodeAt(p)
    if (esc) { esc = false; continue }
    if (code === BACKSLASH) { esc = true; continue }
    if (code === QUOTE) { inStr = !inStr; continue }
    if (inStr) continue
    if (code === OPEN) depth++
    else if (code === CLOSE) { depth--; if (depth === 0) return p }
  }
  return -1
}

/**
 * The `meta` block, which sits ahead of `data` in every MTGJSON bulk file and
 * carries the build `date` and `version`.
 *
 * Parsed opportunistically from the prefix already in the buffer when `data` is
 * found — meta is ~60 bytes, so it is always in the same chunk. Returns null
 * rather than throwing if the shape ever changes; the caller decides whether it
 * can proceed without it.
 */
function extractMeta(prefix) {
  const i = prefix.indexOf('"meta"')
  if (i === -1) return null
  const open = prefix.indexOf('{', i + 6)
  if (open === -1) return null
  const end = matchingBrace(prefix, open)
  if (end === -1) return null
  try { return JSON.parse(prefix.slice(open, end + 1)) } catch { return null }
}

/**
 * A standalone copy of a string cut out of the read buffer.
 *
 * V8 answers `slice` with a SlicedString — a length and an offset into the
 * PARENT string, which stays alive as long as the slice does. A caller that
 * keeps the 36-character key of every entry therefore keeps every chunk the
 * keys were cut from: measured at 1.4 GB of retained buffer across AllPrices'
 * 115k entries, against 8 MB for the keys themselves. Round-tripping through a
 * Buffer forces a flat string with no parent.
 *
 * Values need no such treatment — JSON.parse builds its own strings.
 */
function detached(s) {
  return Buffer.from(s, 'utf8').toString('utf8')
}

/**
 * Yields `[key, parsedObject]` for every entry of the top-level `data` object.
 *
 * `onMeta` fires once, before the first entry is yielded, so a caller can
 * anchor on the build date while it streams.
 *
 * @param {Readable} source  a stream of the GZIPPED bytes
 */
export async function* streamDataEntries(source, { onMeta } = {}) {
  const gz = source.pipe(createGunzip())
  let buf = ''
  let started = false

  for await (const chunk of gz) {
    buf += chunk.toString('utf8')

    if (!started) {
      const i = buf.indexOf('"data"')
      if (i === -1) { buf = buf.slice(-1000); continue }   // keep a tail for a split token
      const brace = buf.indexOf('{', i + 6)
      if (brace === -1) continue
      onMeta?.(extractMeta(buf.slice(0, i)))
      buf = buf.slice(brace + 1)
      started = true
    }

    for (;;) {
      const k1 = buf.indexOf('"')
      if (k1 === -1) break
      const k2 = buf.indexOf('"', k1 + 1)
      if (k2 === -1) break
      const key = detached(buf.slice(k1 + 1, k2))

      const open = buf.indexOf('{', k2)
      if (open === -1) break

      const end = matchingBrace(buf, open)
      if (end === -1) break            // entry straddles chunks — wait for more

      const text = buf.slice(open, end + 1)
      buf = buf.slice(end + 1)
      let parsed
      try { parsed = JSON.parse(text) } catch { continue }
      yield [key, parsed]
    }
  }
}

/** Fetches a URL and streams its gzipped body through `streamDataEntries`. */
export async function* streamBulkEntries(url, { userAgent, onMeta } = {}) {
  const res = await fetch(url, { headers: userAgent ? { 'User-Agent': userAgent } : {} })
  if (!res.ok) throw new Error(`${url} responded ${res.status}`)
  yield* streamDataEntries(Readable.fromWeb(res.body), { onMeta })
}
