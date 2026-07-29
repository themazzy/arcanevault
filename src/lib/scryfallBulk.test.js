import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  pickBulkDownload,
  isGzipUrl,
  bulkFilePath,
  streamBulkCardsFromFile,
} from '../../scripts/lib/scryfall-bulk.mjs'

let tmpDir

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scryfall-bulk-test-'))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function collect(iterable) {
  const out = []
  for await (const value of iterable) out.push(value)
  return out
}

describe('pickBulkDownload', () => {
  it('prefers the gzipped JSONL export Scryfall now publishes', () => {
    expect(pickBulkDownload({
      type: 'all_cards',
      jsonl_download_uri: 'https://data.scryfall.io/all-cards/all-cards-20260729.jsonl.gz',
      compressed_size: 389731550,
    })).toEqual({
      url: 'https://data.scryfall.io/all-cards/all-cards-20260729.jsonl.gz',
      format: 'jsonl',
      gzipped: true,
    })
  })

  it('falls back to the legacy uncompressed download_uri', () => {
    expect(pickBulkDownload({
      type: 'all_cards',
      download_uri: 'https://data.scryfall.io/all-cards/all-cards-20260101.json',
    })).toEqual({
      url: 'https://data.scryfall.io/all-cards/all-cards-20260101.json',
      format: 'json',
      gzipped: false,
    })
  })

  it('returns null when the entry carries no download URL', () => {
    expect(pickBulkDownload({ type: 'all_cards' })).toBeNull()
    expect(pickBulkDownload(null)).toBeNull()
  })
})

describe('isGzipUrl', () => {
  it('detects .gz with and without query strings', () => {
    expect(isGzipUrl('https://x/y.jsonl.gz')).toBe(true)
    expect(isGzipUrl('https://x/y.jsonl.gz?v=1')).toBe(true)
    expect(isGzipUrl('https://x/y.json')).toBe(false)
    expect(isGzipUrl(null)).toBe(false)
  })
})

describe('bulkFilePath', () => {
  it('names the local file after the export format', () => {
    expect(bulkFilePath('/tmp', 'all_cards', { format: 'jsonl', gzipped: true }))
      .toBe(path.join('/tmp', 'scryfall-all_cards.jsonl.gz'))
    expect(bulkFilePath('/tmp', 'oracle_cards', { format: 'json', gzipped: false }))
      .toBe(path.join('/tmp', 'scryfall-oracle_cards.json'))
  })
})

describe('streamBulkCardsFromFile', () => {
  it('inflates and parses a gzipped JSONL export', async () => {
    const file = path.join(tmpDir, 'cards.jsonl.gz')
    const lines = '{"id":"a","name":"Sol Ring"}\n{"id":"b","name":"Arcane Signet"}\n'
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(lines)))

    expect(await collect(streamBulkCardsFromFile(file, 'jsonl'))).toEqual([
      { id: 'a', name: 'Sol Ring' },
      { id: 'b', name: 'Arcane Signet' },
    ])
  })

  it('skips blank lines and stray array punctuation', async () => {
    const file = path.join(tmpDir, 'punctuation.jsonl.gz')
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from('[\n{"id":"a"},\n\n{"id":"b"}\n]\n')))

    expect(await collect(streamBulkCardsFromFile(file, 'jsonl'))).toEqual([
      { id: 'a' },
      { id: 'b' },
    ])
  })

  it('still reads a legacy plain JSON array', async () => {
    const file = path.join(tmpDir, 'cards.json')
    fs.writeFileSync(file, JSON.stringify([{ id: 'a' }, { id: 'b' }]))

    expect(await collect(streamBulkCardsFromFile(file, 'json'))).toEqual([
      { id: 'a' },
      { id: 'b' },
    ])
  })

  it('infers the format from the filename when none is given', async () => {
    const file = path.join(tmpDir, 'inferred.jsonl.gz')
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from('{"id":"a"}\n')))

    expect(await collect(streamBulkCardsFromFile(file))).toEqual([{ id: 'a' }])
  })
})
