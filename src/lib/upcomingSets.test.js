// @vitest-environment jsdom
// The mechanic-history cache lives in localStorage, so these need a DOM.

import { beforeEach, describe, it, expect, vi } from 'vitest'

const scryfallStatus = vi.fn()
vi.mock('./scryfall', () => ({
  sfGet: async () => null,
  sfGetOrStatus: (...args) => scryfallStatus(...args),
}))
import {
  selectUpcomingSets,
  groupSetsByParent,
  daysUntil,
  countdownLabel,
  cardColorBuckets,
  cardPrimaryType,
  summarizeSpoilers,
  extractMechanics,
  filterSpoilerCards,
  sortSpoilerCards,
  slimSpoilerCard,
  isNewMechanic,
  fetchMechanicHistory,
  mechanicReminderText,
  setTypeLabel,
} from './upcomingSets'

const card = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2),
  name: 'Card',
  type_line: 'Creature — Human',
  rarity: 'common',
  cmc: 1,
  collector_number: '1',
  color_identity: ['W'],
  keywords: [],
  oracle_text: '',
  ...over,
})

describe('selectUpcomingSets', () => {
  it('keeps every relevant future set and sorts them chronologically', () => {
    const sets = Array.from({ length: 10 }, (_, index) => ({
      code: `set-${index}`,
      released_at: `2027-${String(12 - index).padStart(2, '0')}-01`,
      set_type: 'expansion',
    }))
    sets.push({ code: 'past', released_at: '2026-01-01', set_type: 'expansion' })
    sets.push({ code: 'promo', released_at: '2027-01-01', set_type: 'promo' })

    const result = selectUpcomingSets(sets, '2026-07-19')

    expect(result).toHaveLength(10)
    expect(result.map(set => set.code)).toEqual([
      'set-9', 'set-8', 'set-7', 'set-6', 'set-5',
      'set-4', 'set-3', 'set-2', 'set-1', 'set-0',
    ])
  })
})

describe('groupSetsByParent', () => {
  const parent = { code: 'trk', released_at: '2026-11-13', set_type: 'expansion' }
  const child = { code: 'trc', parent_set_code: 'trk', released_at: '2026-11-13', set_type: 'commander' }

  it('nests a companion product under the set it ships with', () => {
    const grouped = groupSetsByParent([parent, child])
    expect(grouped).toHaveLength(1)
    expect(grouped[0].code).toBe('trk')
    expect(grouped[0].children.map(c => c.code)).toEqual(['trc'])
  })

  it('keeps a child top-level when its parent is not in the calendar', () => {
    const grouped = groupSetsByParent([child])
    expect(grouped.map(s => s.code)).toEqual(['trc'])
    expect(grouped[0].children).toEqual([])
  })

  it('does not drop a set that lists itself as its own parent', () => {
    const grouped = groupSetsByParent([{ ...parent, parent_set_code: 'trk' }])
    expect(grouped.map(s => s.code)).toEqual(['trk'])
  })
})

describe('daysUntil', () => {
  it('counts whole days between two ISO dates', () => {
    expect(daysUntil('2026-11-13', '2026-09-09')).toBe(65)
    expect(daysUntil('2026-09-09', '2026-09-09')).toBe(0)
    expect(daysUntil('2026-09-08', '2026-09-09')).toBe(-1)
  })

  // Local-midnight subtraction repeats a day across a DST change; UTC day
  // numbers do not. Europe/Berlin springs forward on 2027-03-28.
  it('is stable across a daylight-saving boundary', () => {
    expect(daysUntil('2027-03-29', '2027-03-27')).toBe(2)
    expect(daysUntil('2027-03-28', '2027-03-27')).toBe(1)
  })

  it('returns null for an unparseable date', () => {
    expect(daysUntil('soon', '2026-09-09')).toBeNull()
    expect(daysUntil(undefined, '2026-09-09')).toBeNull()
  })
})

describe('countdownLabel', () => {
  it('names the near dates instead of counting them', () => {
    expect(countdownLabel(0)).toBe('Out today')
    expect(countdownLabel(1)).toBe('Tomorrow')
    expect(countdownLabel(-3)).toBe('Released')
  })

  it('coarsens as the date gets further away', () => {
    expect(countdownLabel(4)).toBe('In 4 days')
    expect(countdownLabel(7)).toBe('In 1 week')
    expect(countdownLabel(21)).toBe('In 3 weeks')
    expect(countdownLabel(90)).toBe('In 3 months')
  })
})

describe('cardColorBuckets', () => {
  it('puts a colourless card in C and never in a colour', () => {
    expect([...cardColorBuckets(card({ color_identity: [] }))]).toEqual(['C'])
  })

  it('lists a gold card under each of its colours and under M', () => {
    const buckets = cardColorBuckets(card({ color_identity: ['W', 'U'] }))
    expect(buckets.has('W')).toBe(true)
    expect(buckets.has('U')).toBe(true)
    expect(buckets.has('M')).toBe(true)
    expect(buckets.has('C')).toBe(false)
  })

  it('does not call a mono-coloured card multicolour', () => {
    expect(cardColorBuckets(card({ color_identity: ['R'] })).has('M')).toBe(false)
  })
})

describe('cardPrimaryType', () => {
  it('files an artifact creature under Creature', () => {
    expect(cardPrimaryType(card({ type_line: 'Artifact Creature — Golem' }))).toBe('Creature')
  })

  it('reads only the front face of a double-faced card', () => {
    expect(cardPrimaryType(card({ type_line: 'Instant // Land' }))).toBe('Instant')
  })

  it('falls back to the front face when there is no top-level type line', () => {
    expect(cardPrimaryType({ card_faces: [{ type_line: 'Enchantment — Aura' }] })).toBe('Enchantment')
  })

  it('buckets anything unrecognised rather than dropping it', () => {
    expect(cardPrimaryType(card({ type_line: 'Dungeon' }))).toBe('Other')
  })
})

describe('summarizeSpoilers', () => {
  it('counts rarity, colour and type across the spoiled cards', () => {
    const summary = summarizeSpoilers([
      card({ rarity: 'mythic', color_identity: ['W', 'U'], type_line: 'Legendary Creature — Human' }),
      card({ rarity: 'common', color_identity: [], type_line: 'Land' }),
      card({ rarity: 'common', color_identity: ['R'], type_line: 'Instant' }),
    ])
    expect(summary.total).toBe(3)
    expect(summary.rarity).toEqual({ mythic: 1, common: 2 })
    expect(summary.colors.find(c => c.id === 'M').count).toBe(1)
    expect(summary.colors.find(c => c.id === 'C').count).toBe(1)
    expect(summary.colors.find(c => c.id === 'W').count).toBe(1)
    expect(summary.types.map(t => t.type)).toContain('Land')
  })

  it('reports every colour bucket even when nothing is spoiled in it', () => {
    const summary = summarizeSpoilers([])
    expect(summary.total).toBe(0)
    expect(summary.colors).toHaveLength(7)
    expect(summary.colors.every(c => c.count === 0)).toBe(true)
  })
})

describe('extractMechanics', () => {
  it('counts keywords across cards, most common first', () => {
    const mechanics = extractMechanics([
      card({ keywords: ['Flying', 'Station'] }),
      card({ keywords: ['Flying'] }),
      card({ keywords: [] }),
    ])
    expect(mechanics).toEqual([
      { name: 'Flying', count: 2 },
      { name: 'Station', count: 1 },
    ])
  })

  it('breaks a count tie by name so the order is stable between renders', () => {
    const mechanics = extractMechanics([card({ keywords: ['Ward', 'Cycling'] })])
    expect(mechanics.map(m => m.name)).toEqual(['Cycling', 'Ward'])
  })
})

describe('mechanicReminderText', () => {
  it('lifts the reminder text a new mechanic is printed with', () => {
    const cards = [card({ oracle_text: 'Flying\nStation (Tap another creature you control: put charge counters.)' })]
    expect(mechanicReminderText(cards, 'Station'))
      .toBe('Tap another creature you control: put charge counters.')
  })

  it('reads past the argument a keyword takes', () => {
    const cards = [card({ oracle_text: 'Landcycling {2} (Discard this card: search for a land.)' })]
    expect(mechanicReminderText(cards, 'Landcycling')).toBe('Discard this card: search for a land.')
  })

  it('reads past the punctuation a keyword action is written with', () => {
    expect(mechanicReminderText(
      [card({ oracle_text: 'When this creature enters, surveil 1. (Look at the top card of your library.)' })],
      'Surveil',
    )).toBe('Look at the top card of your library.')
    expect(mechanicReminderText(
      [card({ oracle_text: 'II — Investigate. (Create a Clue token.)' })],
      'Investigate',
    )).toBe('Create a Clue token.')
  })

  // Verbatim from a real spoiler: distance alone hands Vigilance the text that
  // belongs to Ward, which is what the adjacency rule exists to prevent.
  it('does not hand a keyword the reminder text of the keyword after it', () => {
    const cards = [card({
      oracle_text: 'Vigilance, ward {2} (Whenever this creature becomes the target of a spell an opponent controls, counter it unless they pay {2}.)',
    })]
    expect(mechanicReminderText(cards, 'Vigilance')).toBeNull()
    expect(mechanicReminderText(cards, 'Ward')).toContain('Whenever this creature becomes the target')
  })

  // An ability word is written into the sentence rather than standing alone, so
  // the gap is allowed only because the reminder restates the ability word.
  it('still finds an ability word explained mid-sentence', () => {
    const cards = [card({
      oracle_text: 'Whenever you face a dilemma, draw a card. (You face a dilemma as you choose one or more modes.)',
    })]
    expect(mechanicReminderText(cards, 'Face a dilemma'))
      .toBe('You face a dilemma as you choose one or more modes.')
  })

  it('returns null when no spoiled card explains the mechanic', () => {
    expect(mechanicReminderText([card({ oracle_text: 'Flying' })], 'Flying')).toBeNull()
    expect(mechanicReminderText([], 'Station')).toBeNull()
    expect(mechanicReminderText([card()], '')).toBeNull()
  })
})

describe('filterSpoilerCards', () => {
  const cards = [
    card({ name: 'Angel of Dawn', rarity: 'mythic', color_identity: ['W'], type_line: 'Creature — Angel', keywords: ['Flying'] }),
    card({ name: 'Shock Wave', rarity: 'common', color_identity: ['R'], type_line: 'Instant', oracle_text: 'Deal 3 damage.' }),
  ]

  it('matches oracle text as well as the name', () => {
    expect(filterSpoilerCards(cards, { search: 'damage' }).map(c => c.name)).toEqual(['Shock Wave'])
  })

  it('combines filters rather than replacing them', () => {
    expect(filterSpoilerCards(cards, { color: 'W', type: 'Instant' })).toEqual([])
    expect(filterSpoilerCards(cards, { color: 'W', type: 'Creature' })).toHaveLength(1)
  })

  it('filters by mechanic', () => {
    expect(filterSpoilerCards(cards, { mechanic: 'Flying' }).map(c => c.name)).toEqual(['Angel of Dawn'])
  })

  it('returns everything when no filter is set', () => {
    expect(filterSpoilerCards(cards, {})).toHaveLength(2)
  })
})

describe('sortSpoilerCards', () => {
  const cards = [
    card({ name: 'Beta', cmc: 3, rarity: 'common', collector_number: '20' }),
    card({ name: 'Alpha', cmc: 1, rarity: 'mythic', collector_number: '3' }),
  ]

  it('leaves the spoiled order untouched but does not mutate the input', () => {
    const sorted = sortSpoilerCards(cards, 'spoiled')
    expect(sorted.map(c => c.name)).toEqual(['Beta', 'Alpha'])
    expect(sorted).not.toBe(cards)
  })

  it('sorts by name, mana value, rarity and collector number', () => {
    expect(sortSpoilerCards(cards, 'name').map(c => c.name)).toEqual(['Alpha', 'Beta'])
    expect(sortSpoilerCards(cards, 'cmc').map(c => c.name)).toEqual(['Alpha', 'Beta'])
    expect(sortSpoilerCards(cards, 'rarity').map(c => c.name)).toEqual(['Alpha', 'Beta'])
    expect(sortSpoilerCards(cards, 'number').map(c => c.name)).toEqual(['Alpha', 'Beta'])
  })

  it('sorts a non-numeric collector number last instead of dropping it', () => {
    const withVariant = [...cards, card({ name: 'Zed', collector_number: '★12' })]
    expect(sortSpoilerCards(withVariant, 'number').map(c => c.name)).toEqual(['Alpha', 'Beta', 'Zed'])
  })
})

describe('slimSpoilerCard', () => {
  // The wishlist write path (addMissingToWishlist -> buildCardPrintPayload)
  // reads Scryfall's own field names off these cards, so the slimmed shape has
  // to keep them rather than renaming to image_uri/set_code.
  it('keeps the fields the wishlist write path reads', () => {
    const slim = slimSpoilerCard({
      id: 'abc',
      name: 'Test Card',
      set: 'trk',
      set_name: 'Star Trek',
      collector_number: '42',
      type_line: 'Instant',
      mana_cost: '{U}',
      cmc: 1,
      color_identity: ['U'],
      image_uris: { normal: 'n.jpg', art_crop: 'a.jpg', small: 's.jpg', large: 'l.jpg' },
      rarity: 'rare',
      prices: { eur: '1.00' },
      legalities: { commander: 'legal' },
    })
    expect(slim.set).toBe('trk')
    expect(slim.collector_number).toBe('42')
    expect(slim.image_uris.normal).toBe('n.jpg')
    expect(slim.image_uris.art_crop).toBe('a.jpg')
    expect(slim.prices).toBeUndefined()
    expect(slim.legalities).toBeUndefined()
  })

  it('carries the front face mana cost of a double-faced card', () => {
    const slim = slimSpoilerCard({
      id: 'dfc',
      name: 'Front // Back',
      card_faces: [
        { name: 'Front', mana_cost: '{1}{G}', type_line: 'Creature', image_uris: { normal: 'f.jpg' } },
        { name: 'Back', mana_cost: '', type_line: 'Land', image_uris: { normal: 'b.jpg' } },
      ],
    })
    expect(slim.mana_cost).toBe('{1}{G}')
    expect(slim.card_faces).toHaveLength(2)
    expect(slim.card_faces[1].image_uris.normal).toBe('b.jpg')
  })
})

describe('isNewMechanic', () => {
  it('calls a mechanic new only when nothing printed it before this set', () => {
    expect(isNewMechanic({ priorCount: 0 })).toBe(true)
    expect(isNewMechanic({ priorCount: 34 })).toBe(false)
  })

  it('does not claim novelty when the history lookup failed', () => {
    expect(isNewMechanic(null)).toBe(false)
    expect(isNewMechanic(undefined)).toBe(false)
  })
})

describe('setTypeLabel', () => {
  it('titles an unmapped set type instead of showing the raw enum', () => {
    expect(setTypeLabel('expansion')).toBe('Expansion')
    expect(setTypeLabel('arsenal')).toBe('Arsenal')
    expect(setTypeLabel('from_the_vault')).toBe('From The Vault')
  })
})

describe('fetchMechanicHistory', () => {
  beforeEach(() => {
    localStorage.clear()
    scryfallStatus.mockReset()
  })

  const history = (keyword = 'Ward') =>
    fetchMechanicHistory(keyword, { setCode: 'hob', releasedAt: '2026-08-14' })

  it('excludes the set itself and any other unreleased set from the lookup', async () => {
    scryfallStatus.mockResolvedValue({ ok: true, status: 200, json: { total_cards: 0, data: [] } })
    await history('Station')
    const url = decodeURIComponent(scryfallStatus.mock.calls[0][0])
    expect(url).toContain('keyword:"Station"')
    expect(url).toContain('-e:hob')
    expect(url).toContain('date<2026-08-14')
  })

  it('reports prior printings and the set that introduced the mechanic', async () => {
    scryfallStatus.mockResolvedValue({
      ok: true,
      status: 200,
      json: { total_cards: 34, data: [{ set: 'eoe', set_name: 'Edge of Eternities', released_at: '2025-08-01' }] },
    })
    const result = await history('Station')
    expect(result.priorCount).toBe(34)
    expect(result.firstSet).toBe('Edge of Eternities')
    expect(isNewMechanic(result)).toBe(false)
  })

  // Scryfall answers 404 when a search matches nothing. That is a real answer,
  // and the one that makes a mechanic new.
  it('treats a 404 as a genuine zero', async () => {
    scryfallStatus.mockResolvedValue({ ok: false, status: 404 })
    const result = await history('Face a dilemma')
    expect(result.priorCount).toBe(0)
    expect(isNewMechanic(result)).toBe(true)
  })

  // The bug this pins: a rate-limited lookup used to come back as priorCount 0,
  // which labelled Ward new on a set big enough to exhaust the rate limit — and
  // then cached that for a week.
  it('does not call a mechanic new when the lookup was rate-limited', async () => {
    scryfallStatus.mockResolvedValue({ ok: false, status: 429 })
    const result = await history('Ward')
    expect(result).toBeNull()
    expect(isNewMechanic(result)).toBe(false)
  })

  it('does not call a mechanic new when the request never completed', async () => {
    scryfallStatus.mockResolvedValue({ ok: false, status: 0 })
    expect(await history('Ward')).toBeNull()
  })

  it('never caches an unanswered lookup, so it is retried rather than remembered', async () => {
    scryfallStatus.mockResolvedValue({ ok: false, status: 429 })
    expect(await history('Ward')).toBeNull()

    scryfallStatus.mockResolvedValue({ ok: true, status: 200, json: { total_cards: 900, data: [] } })
    const retried = await history('Ward')
    expect(retried.priorCount).toBe(900)
    expect(scryfallStatus).toHaveBeenCalledTimes(2)
  })

  it('serves a definitive answer from cache instead of asking again', async () => {
    scryfallStatus.mockResolvedValue({ ok: true, status: 200, json: { total_cards: 900, data: [] } })
    await history('Ward')
    await history('Ward')
    expect(scryfallStatus).toHaveBeenCalledTimes(1)
  })
})
