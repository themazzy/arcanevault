import { describe, it, expect } from 'vitest'
import { parseCollectorLine, normalizeCollectorNumber, expandSetCandidates } from './collectorOcr.js'
import { encodeHashPack, HashPackStore } from './hashPack.js'
import { makeCards } from './hashPack.test.js'

describe('normalizeCollectorNumber', () => {
  it('strips leading zeros and lowercases suffixes', () => {
    expect(normalizeCollectorNumber('0123')).toBe('123')
    expect(normalizeCollectorNumber('0023S')).toBe('23s')
    expect(normalizeCollectorNumber('85')).toBe('85')
    expect(normalizeCollectorNumber('136p')).toBe('136p')
    expect(normalizeCollectorNumber('')).toBe(null)
    expect(normalizeCollectorNumber('ABC')).toBe(null)
  })
})

describe('parseCollectorLine', () => {
  // Raw texts below are real Tesseract outputs from the harness runs.
  it('parses the modern zero-padded layout', () => {
    const p = parseCollectorLine('U 0061\nTMT • EN Justyna Dura')
    expect(p.setCode).toBe('tmt')
    expect(p.collCandidates).toContain('61')
    expect(p.lang).toBe('en')
  })

  it('parses the 2014–2019 slash layout', () => {
    const p = parseCollectorLine('135/302 V\nNEO EN CAM W')
    expect(p.collCandidates[0]).toBe('135')
    expect(p.setCode).toBe('neo')
  })

  it('recovers the set code when OCR swallows the bullet (MKMEN)', () => {
    const p = parseCollectorLine('R 0136\nMKMEN JOSHUA RAPHAEL')
    expect(p.setCandidates).toContain('mkm')
    expect(p.lang).toBe('en')
    expect(p.collCandidates[0]).toBe('136')
  })

  it('handles digit-initial set codes', () => {
    const p = parseCollectorLine('0332/0332 M\n2XM • EN')
    expect(p.setCode).toBe('2xm')
  })

  it('maps printed language variants', () => {
    expect(parseCollectorLine('0042 C\nBLB • DE').lang).toBe('de')
    expect(parseCollectorLine('0042 C\nBLB • JP').lang).toBe('ja')
    expect(parseCollectorLine('0042 C\nBLB • CS').lang).toBe('zhs')
  })

  it('returns candidate lists in confidence order (slash > zero-padded > bare)', () => {
    const p = parseCollectorLine('M 0008S F 202\nTRC *EN JOSH')
    expect(p.collCandidates[0]).toBe('8s')       // zero-padded first
    expect(p.collCandidates).toContain('202')    // bare token later
  })

  it('finds nothing in noise (old frames, borderless cards)', () => {
    const p = parseCollectorLine('YW ILHEC QLLRCNEQ TNS')
    expect(p.setCandidates).toEqual([])
    expect(p.collCandidates).toEqual([])
    expect(p.lang).toBe(null)
  })
})

describe('expandSetCandidates', () => {
  const known = new Set(['fdn', 'mkm', 'neo', 'tmt', '2xm'])

  it('keeps exact matches with priority', () => {
    expect(expandSetCandidates(['mkm'], known)).toEqual(['mkm'])
  })

  it('recovers single-character misreads', () => {
    expect(expandSetCandidates(['fon'], known)).toEqual(['fdn'])   // O → D
    expect(expandSetCandidates(['fdn2'], known)).toContain('fdn')  // extra char
  })

  it('drops candidates without close matches', () => {
    expect(expandSetCandidates(['zzz9'], known)).toEqual([])
  })
})

describe('HashPackStore.findByPrint', () => {
  const cards = makeCards(40, { sets: ['abc', 'pxy2'] })
  const store = new HashPackStore()
  store.appendChunkBuffer(encodeHashPack(cards, 6))

  it('finds exact set + collector number', () => {
    // card 3: set 'pxy2' (i % 2 === 1), collNum '3a' (3 % 3 === 0 → 'a' suffix)
    const idx = store.findByPrint('pxy2', '3a')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(store.getCardPublic(idx, 0).id).toBe(cards[3].scryfall_id)
  })

  it('falls back to the promo-prefixed set (printed FDN → Scryfall pFDN)', () => {
    // querying 'xy2' should reach set 'pxy2' via the p-prefix fallback
    const idx = store.findByPrint('xy2', '3a')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(store.getCardPublic(idx, 0).setCode).toBe('pxy2')
  })

  it('returns -1 for unknown prints and empty inputs', () => {
    expect(store.findByPrint('abc', '99999')).toBe(-1)
    expect(store.findByPrint(null, '3')).toBe(-1)
    expect(store.findByPrint('abc', null)).toBe(-1)
  })

  it('exposes the known set list', () => {
    expect(store.allSets()).toEqual(new Set(['abc', 'pxy2']))
  })
})
