import { describe, it, expect, vi } from 'vitest'
import { runComboPass, runGameChangerPass } from './buildAssistantPasses'

// Spellbook-shaped almost-combo row.
const rawCombo = (id, useNames, identity = 'r') => ({
  id,
  identity,
  uses: useNames.map(n => ({ card: { name: n } })),
  produces: [{ feature: { name: 'Infinite mana' } }],
})

const spell = (id, name, qty = 1) => ({ id, name, qty, type_line: 'Artifact' })
const isLandRow = d => (d?.type_line || '').toLowerCase().includes('land')

describe('runComboPass', () => {
  // Deck at exactly 100 COPIES but only 92 rows (one qty-9 basics row): the
  // old row-count math saw 8 open slots and overfilled the deck with combo
  // pieces. With no cuttable filler either, the pass must add nothing.
  it('adds no pieces to a full deck whose basics sit in one multi-qty row', async () => {
    const populated = [
      { id: 'cmd', name: 'Cmd', qty: 1, is_commander: true, type_line: 'Legendary Creature' },
      ...Array.from({ length: 90 }, (_, i) => spell(`s${i}`, `Spell ${i}`)),
      { id: 'basics', name: 'Mountain', qty: 9, type_line: 'Basic Land — Mountain' },
    ]
    const addCards = vi.fn()
    const out = await runComboPass({
      populated,
      fillIds: [], // nothing from this run → nothing cuttable
      targetBracket: 4,
      commanderColorIdentity: ['R'],
      ownedNameKeys: new Set(['piece x']),
      deckSize: 100,
      isLandRow,
      fetchCombos: async () => ({ almost: [rawCombo('a', ['Spell 0', 'Spell 1', 'Piece X'])] }),
      analyzeCutFn: () => ({ recommended: [] }),
      addCards,
      removeCards: vi.fn(),
    })
    expect(out).toEqual({ comboRows: [], cutIds: [], combosCompleted: 0 })
    expect(addCards).not.toHaveBeenCalled()
  })

  it('ignores off-identity ("by adding colors") combos entirely', async () => {
    const populated = [
      { id: 'cmd', name: 'Cmd', qty: 1, is_commander: true, type_line: 'Legendary Creature' },
      spell('s0', 'Spell 0'),
    ]
    const addCards = vi.fn()
    const out = await runComboPass({
      populated,
      fillIds: ['s0'],
      targetBracket: 4,
      commanderColorIdentity: ['R'],
      ownedNameKeys: new Set(['blue piece']),
      deckSize: 100,
      isLandRow,
      fetchCombos: async () => ({ almost: [rawCombo('off', ['Spell 0', 'X', 'Blue Piece'], 'wu')] }),
      analyzeCutFn: () => ({ recommended: [] }),
      addCards,
    })
    expect(out.combosCompleted).toBe(0)
    expect(addCards).not.toHaveBeenCalled()
  })

  it('completes a fitting combo: cuts this run\'s filler and adds the piece', async () => {
    // Full 100-copy deck; f1/f2 were added by this run and are cuttable.
    const populated = [
      { id: 'cmd', name: 'Cmd', qty: 1, is_commander: true, type_line: 'Legendary Creature' },
      ...Array.from({ length: 97 }, (_, i) => spell(`s${i}`, `Spell ${i}`)),
      spell('f1', 'Filler One'),
      spell('f2', 'Filler Two'),
    ]
    const analyzeCutFn = vi.fn(() => ({ recommended: [{ id: 'f1' }] }))
    const removeCards = vi.fn(async ids => ids)
    const addCards = vi.fn(async items => ({ rows: items.map((it, i) => ({ id: `new${i}`, name: it.name })) }))
    const out = await runComboPass({
      populated,
      fillIds: ['f1', 'f2'],
      targetBracket: 4,
      commanderColorIdentity: ['R'],
      ownedNameKeys: new Set(['piece x']),
      deckSize: 100,
      isLandRow,
      fetchCombos: async () => ({ almost: [rawCombo('a', ['Spell 0', 'Spell 1', 'Piece X'])] }),
      analyzeCutFn,
      addCards,
      removeCards,
    })
    expect(out.combosCompleted).toBe(1)
    expect(out.cutIds).toEqual(['f1'])
    expect(out.comboRows.map(r => r.name)).toEqual(['Piece X'])
    // The cut analysis saw copy-accurate totals and locked everything but the
    // non-protected filler.
    const args = analyzeCutFn.mock.calls[0][0]
    expect(args.totalCards).toBe(101) // 100 copies + 1 piece
    expect(args.lockedIds.has('f1')).toBe(false)
    expect(args.lockedIds.has('s0')).toBe(true)
    // The commander is not in lockedIds — analyzeCut never considers
    // is_commander rows in the first place.
    expect(args.lockedIds.has('cmd')).toBe(false)
  })

  it('reports zero cuts when the removal fails', async () => {
    const populated = [
      { id: 'cmd', name: 'Cmd', qty: 1, is_commander: true, type_line: 'Legendary Creature' },
      ...Array.from({ length: 99 }, (_, i) => spell(`s${i}`, `Spell ${i}`)),
    ]
    const out = await runComboPass({
      populated,
      fillIds: ['s98'],
      targetBracket: 4,
      commanderColorIdentity: ['R'],
      ownedNameKeys: new Set(['piece x']),
      deckSize: 100,
      isLandRow,
      fetchCombos: async () => ({ almost: [rawCombo('a', ['Spell 0', 'Spell 1', 'Piece X'])] }),
      analyzeCutFn: () => ({ recommended: [{ id: 's98' }] }),
      addCards: async items => ({ rows: items.map((it, i) => ({ id: `new${i}`, name: it.name })) }),
      removeCards: async () => { throw new Error('network') },
    })
    expect(out.cutIds).toEqual([])
    expect(out.comboRows).toHaveLength(1) // pieces still land; Trim-to-100 handles the overage
  })

  it('does nothing at brackets that want no combos', async () => {
    const fetchCombos = vi.fn()
    const out = await runComboPass({ populated: [], targetBracket: 2, fetchCombos, addCards: vi.fn() })
    expect(out.combosCompleted).toBe(0)
    expect(fetchCombos).not.toHaveBeenCalled()
  })
})

describe('runGameChangerPass', () => {
  const gcNames = new Set(['rhystic study', 'smothering tithe', 'the one ring', 'fierce guardianship'])
  const deckWith = names => [
    { id: 'cmd', name: 'Cmd', qty: 1, is_commander: true },
    ...names.map((n, i) => ({ id: `d${i}`, name: n, qty: 1 })),
  ]
  const roles = [
    {
      role: 'Ramp',
      ownedCandidates: [
        { name: 'Smothering Tithe', edhrecInclusion: 40 },
        { name: 'The One Ring', edhrecInclusion: 60 },
        { name: 'Sol Ring', edhrecInclusion: 90 }, // not a GC — never picked
      ],
    },
  ]

  it('tops up to the 4-GC floor from owned candidates, best inclusion first, capped to maxAdd', async () => {
    const addCards = vi.fn(async items => ({ rows: items.map((it, i) => ({ id: `g${i}`, name: it.name })) }))
    const out = await runGameChangerPass({
      populated: deckWith(['Rhystic Study', 'Fierce Guardianship']), // 2 GCs in deck → need 2
      maxAdd: 1,
      targetBracket: 4,
      source: 'owned',
      gameChangerNames: gcNames,
      roles,
      addCards,
    })
    expect(out.gcRows.map(r => r.name)).toEqual(['The One Ring']) // capped to 1, highest inclusion
  })

  it('budget-gates suggestion GCs on the recommended source', async () => {
    const addCards = vi.fn(async items => ({ rows: items.map((it, i) => ({ id: `g${i}`, name: it.name })) }))
    const out = await runGameChangerPass({
      populated: deckWith([]),
      maxAdd: 4,
      targetBracket: 4,
      source: 'recommended',
      gameChangerNames: gcNames,
      roles: [{ role: 'Draw', ownedCandidates: [] }],
      upgradesFor: () => [
        { name: 'Rhystic Study', edhrecInclusion: 70 },
        { name: 'The One Ring', edhrecInclusion: 80 },
      ],
      passesBudget: name => name !== 'The One Ring', // over budget
      addCards,
    })
    expect(out.gcRows.map(r => r.name)).toEqual(['Rhystic Study'])
  })

  it('does nothing off-target, at the floor, or without room', async () => {
    const addCards = vi.fn()
    const base = { populated: deckWith([]), maxAdd: 4, gameChangerNames: gcNames, roles, addCards }
    expect((await runGameChangerPass({ ...base, targetBracket: 3 })).gcRows).toEqual([])
    expect((await runGameChangerPass({ ...base, targetBracket: 4, maxAdd: 0 })).gcRows).toEqual([])
    const atFloor = deckWith(['Rhystic Study', 'Smothering Tithe', 'The One Ring', 'Fierce Guardianship'])
    expect((await runGameChangerPass({ ...base, targetBracket: 4, populated: atFloor })).gcRows).toEqual([])
    expect(addCards).not.toHaveBeenCalled()
  })
})
