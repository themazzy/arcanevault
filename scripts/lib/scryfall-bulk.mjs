import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { streamArray } from 'stream-json/streamers/stream-array.js'

// Shared access to Scryfall's bulk-data exports.
//
// Scryfall changed the bulk-data manifest in July 2026: entries no longer carry
// `download_uri` (a plain, uncompressed JSON array) — they expose
// `jsonl_download_uri` instead, a gzipped JSON-Lines file served as
// `Content-Type: application/gzip` with no `Content-Encoding`, so fetch does
// NOT transparently decompress it. Every sync script used to reach for
// `download_uri` directly and died on `Could not find Scryfall bulk data type`.
// Both shapes are handled here so the scripts keep working whichever fields the
// manifest returns.

export const BULK_MANIFEST_URL = 'https://api.scryfall.com/bulk-data'

const DEFAULT_USER_AGENT = 'DeckLoomBulkSync/1.0'

/** True when a URL points at a gzip-compressed file we must inflate ourselves. */
export function isGzipUrl(url) {
  return /\.gz(?:[?#]|$)/i.test(String(url ?? ''))
}

/**
 * Pick the download descriptor for one bulk-data manifest entry.
 * Prefers the current JSONL export, falls back to the legacy JSON array.
 * Returns null when the entry carries neither.
 */
export function pickBulkDownload(entry) {
  const jsonl = entry?.jsonl_download_uri
  if (typeof jsonl === 'string' && jsonl) {
    return { url: jsonl, format: 'jsonl', gzipped: isGzipUrl(jsonl) }
  }
  const json = entry?.download_uri
  if (typeof json === 'string' && json) {
    return { url: json, format: 'json', gzipped: isGzipUrl(json) }
  }
  return null
}

/** Local filename for a downloaded bulk export, extension matching its format. */
export function bulkFilePath(dir, type, download) {
  const ext = download?.format === 'jsonl' ? 'jsonl' : 'json'
  return path.join(dir, `scryfall-${type}.${ext}${download?.gzipped ? '.gz' : ''}`)
}

function headers(userAgent, accept) {
  return { Accept: accept, 'User-Agent': userAgent || DEFAULT_USER_AGENT }
}

/** Resolve `{ url, format, gzipped, updatedAt }` for a bulk-data type. */
export async function resolveBulkDownload(type, { userAgent } = {}) {
  const res = await fetch(BULK_MANIFEST_URL, { headers: headers(userAgent, 'application/json') })
  if (!res.ok) throw new Error(`Request failed (${res.status}) for ${BULK_MANIFEST_URL}`)
  const manifest = await res.json()
  const entry = (manifest?.data || []).find(item => item.type === type)
  if (!entry) throw new Error(`Could not find Scryfall bulk data type "${type}".`)
  const download = pickBulkDownload(entry)
  if (!download) {
    throw new Error(
      `Scryfall bulk data "${type}" has no download URL (manifest fields: ${Object.keys(entry).join(', ')}).`
    )
  }
  return { ...download, updatedAt: entry.updated_at ?? null }
}

/** Stream a bulk export to disk, compression untouched. */
export async function downloadBulkFile(url, destination, { userAgent } = {}) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const res = await fetch(url, {
    headers: headers(userAgent, 'application/json, application/octet-stream;q=0.9, */*;q=0.8'),
  })
  if (!res.ok || !res.body) throw new Error(`Bulk download failed (${res.status})`)

  const fileStream = fs.createWriteStream(destination)
  const bodyStream = Readable.fromWeb(res.body)
  await new Promise((resolve, reject) => {
    bodyStream.pipe(fileStream)
    bodyStream.on('error', reject)
    fileStream.on('finish', resolve)
    fileStream.on('error', reject)
  })
}

/** Resolve + download in one step; returns the descriptor plus the local `path`. */
export async function downloadBulkData(type, { dir, userAgent } = {}) {
  const download = await resolveBulkDownload(type, { userAgent })
  const filePath = bulkFilePath(dir, type, download)
  await downloadBulkFile(download.url, filePath, { userAgent })
  return { ...download, path: filePath }
}

async function* streamBulk(source, { format, gzipped }) {
  let stream = source
  if (gzipped) {
    const gunzip = zlib.createGunzip()
    // .pipe() does not forward source errors — surface them on the iterator.
    source.on('error', err => gunzip.destroy(err))
    stream = source.pipe(gunzip)
  }

  if (format === 'jsonl') {
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of lines) {
      const trimmed = line.trim().replace(/,$/, '')
      if (!trimmed || trimmed === '[' || trimmed === ']') continue
      yield JSON.parse(trimmed)
    }
    return
  }

  for await (const { value } of stream.pipe(streamArray.withParserAsStream())) yield value
}

/** Async-iterate the card objects in a downloaded bulk export. */
export async function* streamBulkCardsFromFile(filePath, format) {
  yield* streamBulk(fs.createReadStream(filePath), {
    format: format ?? (/\.jsonl(\.gz)?$/i.test(filePath) ? 'jsonl' : 'json'),
    gzipped: isGzipUrl(filePath),
  })
}

/** Async-iterate a bulk export straight off the network, no temp file. */
export async function* streamBulkCardsFromUrl(url, format, { userAgent } = {}) {
  const res = await fetch(url, {
    headers: headers(userAgent, 'application/json, application/octet-stream;q=0.9, */*;q=0.8'),
  })
  if (!res.ok || !res.body) throw new Error(`Bulk download failed (${res.status}) for ${url}`)
  yield* streamBulk(Readable.fromWeb(res.body), { format, gzipped: isGzipUrl(url) })
}
