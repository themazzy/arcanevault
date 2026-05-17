import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { uuidV4, installRandomUUIDPolyfill } from './uuid'

const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuidV4', () => {
  it('returns a syntactically valid RFC4122 v4 UUID', () => {
    for (let i = 0; i < 50; i++) expect(uuidV4()).toMatch(V4_RE)
  })

  it('encodes version 4 in the 13th hex character', () => {
    expect(uuidV4().charAt(14)).toBe('4')
  })

  it('encodes the variant bits (10xx) in the 17th hex character', () => {
    const v = uuidV4().charAt(19)
    expect(['8', '9', 'a', 'b']).toContain(v)
  })

  it('produces unique values across many calls', () => {
    const seen = new Set()
    for (let i = 0; i < 1000; i++) seen.add(uuidV4())
    expect(seen.size).toBe(1000)
  })
})

describe('installRandomUUIDPolyfill', () => {
  let originalRandomUUID

  beforeEach(() => {
    originalRandomUUID = globalThis.crypto?.randomUUID
  })
  afterEach(() => {
    if (originalRandomUUID) globalThis.crypto.randomUUID = originalRandomUUID
  })

  it('is a no-op when crypto.randomUUID already exists', () => {
    const sentinel = () => 'native'
    globalThis.crypto.randomUUID = sentinel
    installRandomUUIDPolyfill()
    expect(globalThis.crypto.randomUUID).toBe(sentinel)
  })

  it('installs a working polyfill when crypto.randomUUID is missing', () => {
    delete globalThis.crypto.randomUUID
    installRandomUUIDPolyfill()
    expect(typeof globalThis.crypto.randomUUID).toBe('function')
    expect(globalThis.crypto.randomUUID()).toMatch(V4_RE)
  })

  it('is idempotent — second call does not overwrite the first install', () => {
    delete globalThis.crypto.randomUUID
    installRandomUUIDPolyfill()
    const installed = globalThis.crypto.randomUUID
    installRandomUUIDPolyfill()
    expect(globalThis.crypto.randomUUID).toBe(installed)
  })
})
