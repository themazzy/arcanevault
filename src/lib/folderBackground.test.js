import { describe, it, expect } from 'vitest'
import { parseFolderBgUrl, withFolderBgUrl } from './folderBackground'

const ART = 'https://cards.scryfall.io/art_crop/front/a/b/abc.jpg'

describe('parseFolderBgUrl', () => {
  it('reads bg_url out of the description blob', () => {
    expect(parseFolderBgUrl(JSON.stringify({ bg_url: ART }))).toBe(ART)
  })

  it('returns null for a description with no background', () => {
    expect(parseFolderBgUrl(JSON.stringify({ isGroup: true }))).toBeNull()
    expect(parseFolderBgUrl(null)).toBeNull()
    expect(parseFolderBgUrl('')).toBeNull()
  })

  it('returns null rather than throwing on an unparseable description', () => {
    expect(parseFolderBgUrl('not json')).toBeNull()
  })
})

describe('withFolderBgUrl', () => {
  it('keeps every other key in the blob', () => {
    // The description is shared with deck-link meta — a background write that
    // replaced the blob would unpair a linked deck.
    const before = JSON.stringify({ linked_builder_id: 'deck-1', groupId: 'g1' })
    const after = JSON.parse(withFolderBgUrl(before, ART))
    expect(after).toEqual({ linked_builder_id: 'deck-1', groupId: 'g1', bg_url: ART })
  })

  it('replaces an existing background', () => {
    const before = JSON.stringify({ bg_url: 'https://old/art.jpg', isGroup: true })
    const after = JSON.parse(withFolderBgUrl(before, ART))
    expect(after).toEqual({ isGroup: true, bg_url: ART })
  })

  it('drops the key when clearing, leaving the rest intact', () => {
    const before = JSON.stringify({ bg_url: ART, linked_builder_id: 'deck-1' })
    expect(JSON.parse(withFolderBgUrl(before, null))).toEqual({ linked_builder_id: 'deck-1' })
  })

  it('returns null when clearing the only key, so the column does not hold {}', () => {
    expect(withFolderBgUrl(JSON.stringify({ bg_url: ART }), null)).toBeNull()
  })

  it('builds a fresh blob from an empty description', () => {
    expect(JSON.parse(withFolderBgUrl(null, ART))).toEqual({ bg_url: ART })
  })

  it('starts over rather than throwing on an unparseable description', () => {
    expect(JSON.parse(withFolderBgUrl('not json', ART))).toEqual({ bg_url: ART })
  })
})
