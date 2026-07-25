import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./supabase', () => ({ sb: { rpc: vi.fn() } }))

const { sb } = await import('./supabase')
const { artRowToOption, searchCardArt, MIN_ART_SEARCH_LENGTH } = await import('./cardSearch')

const FRONT_ROW = {
  scryfall_id: 'abc-123',
  card_name: 'Delver of Secrets // Insectile Aberration',
  face_name: 'Delver of Secrets',
  face_index: 0,
  set_code: 'isd',
  set_name: 'Innistrad',
  collector_number: '51',
  artist: 'Nils Hamm',
  art_crop_uri: 'https://cards.scryfall.io/art_crop/front/a/b/abc-123.jpg',
  released_at: '2011-09-30',
}

const BACK_ROW = {
  ...FRONT_ROW,
  face_name: 'Insectile Aberration',
  face_index: 1,
  art_crop_uri: 'https://cards.scryfall.io/art_crop/back/a/b/abc-123.jpg',
}

beforeEach(() => { sb.rpc.mockReset() })

describe('artRowToOption', () => {
  it('maps a front-face row', () => {
    const option = artRowToOption(FRONT_ROW)
    expect(option).toMatchObject({
      url: FRONT_ROW.art_crop_uri,
      cardName: 'Delver of Secrets // Insectile Aberration',
      faceName: 'Delver of Secrets',
      isBack: false,
      setCode: 'isd',
      artist: 'Nils Hamm',
    })
  })

  it('flags the back face of a double-faced print', () => {
    expect(artRowToOption(BACK_ROW).isBack).toBe(true)
  })

  it('keys the two faces of one print separately', () => {
    // Both faces come from the same scryfall_id; a key that ignored face_index
    // would make React collapse them into a single tile.
    expect(artRowToOption(FRONT_ROW).key).not.toBe(artRowToOption(BACK_ROW).key)
  })

  it('drops a row with no art', () => {
    expect(artRowToOption({ ...FRONT_ROW, art_crop_uri: null })).toBeNull()
  })
})

describe('searchCardArt', () => {
  it('does not call the RPC below the minimum term length', async () => {
    const short = 'x'.repeat(MIN_ART_SEARCH_LENGTH - 1)
    await expect(searchCardArt(short)).resolves.toEqual([])
    expect(sb.rpc).not.toHaveBeenCalled()
  })

  it('returns both faces of a double-faced card', async () => {
    sb.rpc.mockResolvedValue({ data: [FRONT_ROW, BACK_ROW], error: null })
    const options = await searchCardArt('delver', { limit: 10 })
    expect(sb.rpc).toHaveBeenCalledWith('search_card_art', {
      search_term: 'delver',
      max_results: 10,
    })
    expect(options.map(o => o.faceName)).toEqual(['Delver of Secrets', 'Insectile Aberration'])
  })

  it('resolves to an empty list for a name that matches nothing', async () => {
    // The Scryfall path this replaced answered 404 here, which the browser
    // logged as a failed request on every keystroke of a typo.
    sb.rpc.mockResolvedValue({ data: [], error: null })
    await expect(searchCardArt('qqqzzz')).resolves.toEqual([])
  })

  it('throws when Supabase errors, so the UI can say so', async () => {
    sb.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(searchCardArt('delver')).rejects.toBeTruthy()
  })

  it('trims the term before measuring and sending it', async () => {
    sb.rpc.mockResolvedValue({ data: [], error: null })
    await searchCardArt('  bolt  ')
    expect(sb.rpc).toHaveBeenCalledWith('search_card_art', expect.objectContaining({ search_term: 'bolt' }))
  })
})
