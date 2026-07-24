import { describe, it, expect } from 'vitest'
import { scryfallImageUrlFromId } from './scryfall'

describe('scryfallImageUrlFromId', () => {
  const id = 'a4a2dd5b-6143-4b8d-ae71-e148cf19b66c'

  it('defaults to the normal .jpg tier, sharded by the first two id chars', () => {
    expect(scryfallImageUrlFromId(id)).toBe(
      `https://cards.scryfall.io/normal/front/a/4/${id}.jpg`,
    )
  })

  it('builds an art_crop URL', () => {
    expect(scryfallImageUrlFromId(id, 'art_crop')).toBe(
      `https://cards.scryfall.io/art_crop/front/a/4/${id}.jpg`,
    )
  })

  it('uses the .png extension only for the png tier', () => {
    expect(scryfallImageUrlFromId(id, 'png')).toBe(
      `https://cards.scryfall.io/png/front/a/4/${id}.png`,
    )
  })

  it('returns null for a missing or too-short id', () => {
    expect(scryfallImageUrlFromId(null)).toBeNull()
    expect(scryfallImageUrlFromId(undefined)).toBeNull()
    expect(scryfallImageUrlFromId('')).toBeNull()
    expect(scryfallImageUrlFromId('x')).toBeNull()
    expect(scryfallImageUrlFromId(123)).toBeNull()
  })
})
