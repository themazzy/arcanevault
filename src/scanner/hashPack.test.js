import { describe, it, expect } from 'vitest'
import { encodeHashPack, decodeHashPack, HashPackStore, deriveImageUri, uuidToBytes, bytesToUuid } from './hashPack.js'
import { hashToHex, hexToHash } from './hashCore.js'

// Deterministic PRNG so failures reproduce.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomHex64(rng) {
  const words = new Uint32Array(8)
  for (let i = 0; i < 8; i++) words[i] = Math.floor(rng() * 0x100000000)
  return hashToHex(words)
}

function fakeUuid(i) {
  return `0000${String(i).padStart(4, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`
}

export function makeCards(count, { seed = 42, sets = ['abc', 'xyz', 'p123'] } = {}) {
  const rng = mulberry32(seed)
  return Array.from({ length: count }, (_, i) => ({
    scryfall_id: fakeUuid(i),
    name: i % 7 === 0 ? `Æther Card №${i} // Back Face` : `Card ${i}`,
    set_code: sets[i % sets.length],
    collector_number: i % 11 === 0 ? '' : `${i}${i % 3 === 0 ? 'a' : ''}`,
    flavor_name: i % 13 === 0 ? `Flavor ${i}` : '',
    face: i % 17 === 0 ? 1 : 0,
    phash_hex: randomHex64(rng),
    phash_hex2: randomHex64(rng),
    phash_full_hex: randomHex64(rng),
  }))
}

describe('uuid helpers', () => {
  it('round-trips a UUID through bytes', () => {
    const id = 'a4a2dd5b-6143-4b8d-ae71-e148cf19b66c'
    const bytes = new Uint8Array(16)
    expect(uuidToBytes(id, bytes)).toBe(true)
    expect(bytesToUuid(bytes)).toBe(id)
  })

  it('rejects non-UUID input', () => {
    expect(uuidToBytes('not-a-uuid', new Uint8Array(16))).toBe(false)
  })
})

describe('deriveImageUri', () => {
  it('builds the Scryfall CDN path from the card id', () => {
    expect(deriveImageUri('a4a2dd5b-6143-4b8d-ae71-e148cf19b66c'))
      .toBe('https://cards.scryfall.io/normal/front/a/4/a4a2dd5b-6143-4b8d-ae71-e148cf19b66c.jpg')
  })
})

describe('encodeHashPack / decodeHashPack', () => {
  it('round-trips cards through the binary format', () => {
    const cards = makeCards(257) // odd count exercises the u16 section padding
    const buf = encodeHashPack(cards, 6)
    const store = new HashPackStore()
    store.appendChunkBuffer(buf)

    expect(store.count).toBe(257)
    expect(store.hashVersion).toBe(6)

    for (const idx of [0, 1, 7, 11, 128, 256]) {
      const card = store.getCardPublic(idx, 0)
      expect(card.id).toBe(cards[idx].scryfall_id)
      expect(card.name).toBe(cards[idx].name)
      expect(card.setCode).toBe(cards[idx].set_code)
      expect(card.collNum).toBe(cards[idx].collector_number || null)
      expect(card.imageUri).toBe(deriveImageUri(cards[idx].scryfall_id))
    }

    // Stored hashes survive bit-for-bit (re-hexed from the packed words).
    const { chunk, local } = store.locate(37)
    const hexes = HashPackStore.rowHexes(chunk, local)
    expect(hexes.phash_hex).toBe(cards[37].phash_hex)
    expect(hexes.phash_hex2).toBe(cards[37].phash_hex2)
    expect(hexes.phash_full_hex).toBe(cards[37].phash_full_hex)

    // v2 extras: face flags, flavor names, full-hash availability
    expect(store.hasFullHashes).toBe(true)
    expect(chunk.faces[34 - store.starts[0]]).toBe(1)          // 34 % 17 === 0
    expect(store.getCardPublic(26, 0).flavorName).toBe('Flavor 26')
    expect(store.getCardPublic(27, 0).flavorName).toBe(null)
    expect([...store.entries()][34]).toEqual({ id: cards[34].scryfall_id, face: 1 })
  })

  it('still decodes format-v1 chunks (deployed pack before the v7 reseed)', () => {
    // Minimal v1 encoder: header v1 + sections without full hashes/faces and
    // 2-field meta — mirrors the layout the live pack currently uses.
    const cards = makeCards(5).map(c => ({ ...c, face: 0 }))
    const enc = new TextEncoder()
    const metas = cards.map(c => enc.encode(`${c.name}\x1F${c.collector_number}`))
    const metaLen = metas.reduce((s, m) => s + m.length, 0)
    const sets = [...new Set(cards.map(c => c.set_code))]
    const setParts = sets.map(s => enc.encode(s))
    const setLen = setParts.reduce((s, p) => s + 1 + p.length, 0)
    const n = cards.length
    const pad4 = v => (v + 3) & ~3
    const offA = 32, offB = offA + n * 32, offC = offB + n * 32
    const offD = offC + n * 16, offE = offD + pad4(n * 2), offF = offE + (n + 1) * 4
    const buf = new ArrayBuffer(offF + metaLen + setLen)
    const view = new DataView(buf); const u8 = new Uint8Array(buf)
    view.setUint32(0, 0x31485641, true); view.setUint16(4, 1, true); view.setUint16(6, 6, true)
    view.setUint32(8, n, true); view.setUint32(12, metaLen, true)
    view.setUint16(16, sets.length, true); view.setUint32(20, setLen, true)
    const luma = new Uint32Array(buf, offA, n * 8), color = new Uint32Array(buf, offB, n * 8)
    const setIdx = new Uint16Array(buf, offD, n), metaOff = new Uint32Array(buf, offE, n + 1)
    let cursor = 0
    cards.forEach((c, i) => {
      luma.set(hexToHash(c.phash_hex), i * 8)
      color.set(hexToHash(c.phash_hex2), i * 8)
      uuidToBytes(c.scryfall_id, u8, offC + i * 16)
      setIdx[i] = sets.indexOf(c.set_code)
      metaOff[i] = cursor
      u8.set(metas[i], offF + cursor)
      cursor += metas[i].length
    })
    metaOff[n] = cursor
    let sc = offF + metaLen
    for (const p of setParts) { u8[sc++] = p.length; u8.set(p, sc); sc += p.length }

    const store = new HashPackStore()
    store.appendChunkBuffer(buf)
    expect(store.count).toBe(5)
    expect(store.hasFullHashes).toBe(false)
    const card = store.getCardPublic(2, 0)
    expect(card.id).toBe(cards[2].scryfall_id)
    expect(card.name).toBe(cards[2].name)
    expect(card.collNum).toBe(cards[2].collector_number || null)
    expect(card.flavorName).toBe(null)
    expect(HashPackStore.rowHexes(store.chunks[0], 2).phash_full_hex).toBe(null)
  })

  it('spans multiple chunks with correct global indexing', () => {
    const cards = makeCards(60)
    const store = new HashPackStore()
    store.appendChunkBuffer(encodeHashPack(cards.slice(0, 25), 6))
    store.appendChunkBuffer(encodeHashPack(cards.slice(25), 6))
    expect(store.count).toBe(60)
    expect(store.getCardPublic(24, 0).id).toBe(cards[24].scryfall_id)
    expect(store.getCardPublic(25, 0).id).toBe(cards[25].scryfall_id)
    expect(store.getCardPublic(59, 0).id).toBe(cards[59].scryfall_id)
    expect([...store.ids()]).toEqual(cards.map(c => c.scryfall_id))
  })

  it('rejects buffers with a bad magic or truncated sections', () => {
    expect(() => decodeHashPack(new ArrayBuffer(8))).toThrow(/too small/)
    const buf = encodeHashPack(makeCards(3), 6)
    new DataView(buf).setUint32(0, 0xDEADBEEF, true)
    expect(() => decodeHashPack(buf)).toThrow(/bad magic/)
    const truncated = encodeHashPack(makeCards(3), 6).slice(0, 100)
    expect(() => decodeHashPack(truncated)).toThrow(/truncated/)
  })

  it('rejects mixed hash versions in one store', () => {
    const store = new HashPackStore()
    store.appendChunkBuffer(encodeHashPack(makeCards(3), 6))
    expect(() => store.appendChunkBuffer(encodeHashPack(makeCards(3), 7))).toThrow(/version mismatch/)
  })

  it('rejects rows with invalid hashes or ids', () => {
    const bad = makeCards(2)
    bad[1].phash_hex = 'zz'
    expect(() => encodeHashPack(bad, 6)).toThrow(/Invalid phash_hex/)
    const badId = makeCards(2)
    badId[1].scryfall_id = 'not-a-uuid'
    expect(() => encodeHashPack(badId, 6)).toThrow(/Non-UUID/)
  })
})
