import { describe, it, expect } from 'vitest'
import { MILESTONES, MILESTONE_GROUPS, groupedMilestones, getMilestone } from './milestones'

describe('milestone grouping', () => {
  it('assigns every milestone to exactly one group', () => {
    const grouped = MILESTONE_GROUPS.flatMap(g => g.ids)
    const all     = MILESTONES.map(m => m.id)

    // A milestone missing from MILESTONE_GROUPS would silently vanish from the
    // "all milestones" dialog, which is now the only place unearned ones appear.
    expect([...grouped].sort()).toEqual([...all].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it('resolves ids to milestone definitions', () => {
    expect(getMilestone('first_card')?.label).toBe('First Card')
    expect(getMilestone('nope')).toBeNull()
  })

  it('marks earned milestones from the profile stat shape', () => {
    // Exactly the shape get_public_profile returns.
    const stats = {
      total_cards: 150,
      unique_cards: 20,
      foil_count: 12,
      sets_count: 6,
      color_distribution: { W: 1, U: 1, B: 1, R: 1, G: 1, C: 30, M: 2 },
    }
    const profile = { public_deck_count: 1, collection_value: 120, game_stats: { wins: 0, total: 0 } }

    const groups = groupedMilestones(stats, profile)
    const byId = new Map(groups.flatMap(g => g.items).map(m => [m.id, m.earned]))

    expect(byId.get('collector')).toBe(true)        // 150 >= 100 cards
    expect(byId.get('dedicated')).toBe(false)       // 150 < 500
    expect(byId.get('foil_dabbler')).toBe(true)     // 12 >= 10 foils
    expect(byId.get('shiny_hunter')).toBe(false)    // 12 < 50
    expect(byId.get('set_dabbler')).toBe(true)      // 6 >= 5 sets
    expect(byId.get('rainbow')).toBe(true)          // one of each WUBRG
    expect(byId.get('colorless_keeper')).toBe(true) // 30 >= 25 colourless
    expect(byId.get('valuable')).toBe(true)         // €120 >= €100
    expect(byId.get('first_win')).toBe(false)       // no wins
  })

  it('reports nothing earned for a profile whose stats never loaded', () => {
    // The regression this page shipped with: get_public_profile stopped
    // returning foil_count / sets_count / color_distribution, so these checks
    // must degrade to "not earned" rather than throwing.
    const groups = groupedMilestones(undefined, undefined)
    expect(groups.flatMap(g => g.items).every(m => m.earned === false)).toBe(true)
  })
})
