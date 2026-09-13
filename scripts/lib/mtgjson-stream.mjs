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
 * Yields `[key, parsedObject]` for every entry of the top-level `data` object.
 *
 * @param {Readable} source  a stream of the GZIPPED bytes
 */
export async function* streamDataEntries(source) {
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
      buf = buf.slice(brace + 1)
      started = true
    }

    for (;;) {
      const k1 = buf.indexOf('"')
      if (k1 === -1) break
      const k2 = buf.indexOf('"', k1 + 1)
      if (k2 === -1) break
      const key = buf.slice(k1 + 1, k2)

      const open = buf.indexOf('{', k2)
      if (open === -1) break

      let depth = 0, end = -1, inStr = false, esc = false
      for (let p = open; p < buf.length; p++) {
        const code = buf.charCodeAt(p)
        if (esc) { esc = false; continue }
        if (code === BACKSLASH) { esc = true; continue }
        if (code === QUOTE) { inStr = !inStr; continue }
        if (inStr) continue
        if (code === OPEN) depth++
        else if (code === CLOSE) { depth--; if (depth === 0) { end = p; break } }
      }
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
export async function* streamBulkEntries(url, { userAgent } = {}) {
  const res = await fetch(url, { headers: userAgent ? { 'User-Agent': userAgent } : {} })
  if (!res.ok) throw new Error(`${url} responded ${res.status}`)
  yield* streamDataEntries(Readable.fromWeb(res.body))
}
