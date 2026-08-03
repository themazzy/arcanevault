import { describe, it, expect, vi } from 'vitest'
import { runComboPass, runGameChangerPass, runEnginePass } from './buildAssistantPasses'

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

// The `orderCombos` hook exists so the experimental assistant can prefer
// "soft combos" (loops producing a resource) over loops that just end the game.
// The shipped pass must be unaffected when the hook isn't supplied.
describe('runComboPass — orderCombos hook', () => {
  const twoCombos = {
    almost: [
      {
        id: 'win', identity: 'r',
        uses: [{ card: { name: 'Spell 0' } }, { card: { name: 'Win Piece' } }],
        produces: [{ feature: { name: 'Win the game' } }],
      },
      {
        id: 'mana', identity: 'r',
        uses: [{ card: { name: 'Spell 0' } }, { card: { name: 'Mana Piece' } }],
        produces: [{ feature: { name: 'Infinite colorless mana' } }],
      },
    ],
  }
  const populated = [
    { id: 'cmd', name: 'Cmd', qty: 1, is_commander: true, type_line: 'Legendary Creature' },
    spell('s0', 'Spell 0'),
  ]
  const args = addCards => ({
    populated,
    fillIds: ['s0'],
    targetBracket: 4, // allows 2-card combos, so both are eligible
    commanderColorIdentity: ['R'],
    ownedNameKeys: new Set(['win piece', 'mana piece']),
    deckSize: 100,
    isLandRow,
    fetchCombos: async () => twoCombos,
    analyzeCutFn: () => ({ recommended: [] }),
    addCards,
  })

  it('takes the combos in the default order when no hook is passed', async () => {
    const addCards = vi.fn(async () => ({ rows: [] }))
    await runComboPass(args(addCards))
    // Both are 1-missing and owned, so mapAlmostCombos keeps the input order.
    expect(addCards.mock.calls[0][0][0].name).toBe('Win Piece')
  })

  it('lets a caller reprioritise which combo gets completed first', async () => {
    const addCards = vi.fn(async () => ({ rows: [] }))
    await runComboPass({
      ...args(addCards),
      orderCombos: list => [...list].sort((a, b) => a.id.localeCompare(b.id)),
    })
    expect(addCards.mock.calls[0][0][0].name).toBe('Mana Piece')
  })
})

describe('runEnginePass', () => {
  const deck = (n, extra = []) => [
    { id: 'cmd', name: 'Cmd', qty: 1, is_commander: true, type_line: 'Legendary Creature' },
    ...Array.from({ length: n }, (_, i) => spell(`f${i}`, `Filler ${i}`)),
    ...extra,
  ]
  const coverageShort = (short = 2) => ([{
    enabler: 'sacOutlet', label: 'sacrifice outlets', why: '', target: 6,
    have: 6 - short, short, providers: ['Ashnod\'s Altar'],
  }])
  const providers = ['Viscera Seer', 'Carrion Feeder', 'Goblin Bombardment'].map(name => ({ name }))

  it('does nothing when every need is met', async () => {
    const addCards = vi.fn()
    const out = await runEnginePass({
      populated: deck(50), fillIds: ['f0'],
      coverage: [{ enabler: 'sacOutlet', target: 6, have: 7, short: 0, providers: [] }],
      providersFor: () => providers,
      analyzeCutFn: () => ({ recommended: [] }), addCards,
    })
    expect(out.added).toBe(0)
    expect(addCards).not.toHaveBeenCalled()
  })

  it('adds exactly the shortfall', async () => {
    const addCards = vi.fn(async () => ({ rows: [] }))
    const out = await runEnginePass({
      populated: deck(50), fillIds: ['f0', 'f1'],
      coverage: coverageShort(2), providersFor: () => providers,
      isLandRow, analyzeCutFn: () => ({ recommended: [] }), addCards,
    })
    expect(out.added).toBe(2)
    expect(addCards.mock.calls[0][0].map(c => c.name)).toEqual(['Viscera Seer', 'Carrion Feeder'])
  })

  it('never cuts a card that is itself an engine provider', async () => {
    // Ashnod's Altar is listed as an existing provider — cutting it to add
    // another outlet would be pure churn.
    const populated = deck(3, [spell('altar', "Ashnod's Altar")])
    const analyzeCutFn = vi.fn(() => ({ recommended: [] }))
    await runEnginePass({
      populated, fillIds: ['f0', 'f1', 'f2', 'altar'],
      coverage: coverageShort(1), providersFor: () => providers,
      isLandRow, analyzeCutFn, addCards: vi.fn(async () => ({ rows: [] })),
    })
    const locked = analyzeCutFn.mock.calls[0][0].lockedIds
    expect(locked.has('altar')).toBe(true)
  })

  it('only ever cuts cards this run added', async () => {
    const populated = deck(4)
    const analyzeCutFn = vi.fn(() => ({ recommended: [] }))
    await runEnginePass({
      populated, fillIds: ['f0'], // only f0 is ours
      coverage: coverageShort(1), providersFor: () => providers,
      isLandRow, analyzeCutFn, addCards: vi.fn(async () => ({ rows: [] })),
    })
    const locked = analyzeCutFn.mock.calls[0][0].lockedIds
    expect(locked.has('f1')).toBe(true)
    expect(locked.has('f0')).toBe(false)
  })

  it('respects the budget gate', async () => {
    const addCards = vi.fn(async () => ({ rows: [] }))
    await runEnginePass({
      populated: deck(50), fillIds: ['f0', 'f1'],
      coverage: coverageShort(2), providersFor: () => providers,
      passesBudget: name => name !== 'Viscera Seer',
      isLandRow, analyzeCutFn: () => ({ recommended: [] }), addCards,
    })
    expect(addCards.mock.calls[0][0].map(c => c.name)).toEqual(['Carrion Feeder', 'Goblin Bombardment'])
  })

  it('skips providers already in the deck', async () => {
    const addCards = vi.fn(async () => ({ rows: [] }))
    await runEnginePass({
      populated: deck(50, [spell('vs', 'Viscera Seer')]), fillIds: ['f0'],
      coverage: coverageShort(1), providersFor: () => providers,
      isLandRow, analyzeCutFn: () => ({ recommended: [] }), addCards,
    })
    expect(addCards.mock.calls[0][0].map(c => c.name)).toEqual(['Carrion Feeder'])
  })

  it('spends its budget on the most-short need first', async () => {
    const addCards = vi.fn(async () => ({ rows: [] }))
    await runEnginePass({
      populated: deck(50), fillIds: ['f0', 'f1', 'f2'],
      coverage: [
        { enabler: 'selfMill', target: 4, have: 3, short: 1, providers: [] },
        { enabler: 'sacOutlet', target: 6, have: 3, short: 3, providers: [] },
      ],
      providersFor: e => (e === 'sacOutlet' ? providers : [{ name: 'Stitcher\'s Supplier' }]),
      isLandRow, analyzeCutFn: () => ({ recommended: [] }), addCards, maxAdd: 3,
    })
    const names = addCards.mock.calls[0][0].map(c => c.name)
    expect(names.slice(0, 3)).toEqual(['Viscera Seer', 'Carrion Feeder', 'Goblin Bombardment'])
  })

  it('is a no-op when the pool has no providers', async () => {
    const addCards = vi.fn()
    const out = await runEnginePass({
      populated: deck(50), fillIds: ['f0'],
      coverage: coverageShort(2), providersFor: () => [],
      isLandRow, analyzeCutFn: () => ({ recommended: [] }), addCards,
    })
    expect(out.added).toBe(0)
    expect(addCards).not.toHaveBeenCalled()
  })
})

// The two post-fill passes run back to back and both cut from "cards this run
// added". If the engine pass's additions stay in that pool, the combo pass can
// cut the very enablers the engine pass just added — the deck ends with the
// combo and without the engine that was the point.
describe('engine pass and combo pass interaction', () => {
  it('combo pass cuts an engine addition when it is left in the fill pool', async () => {
    const populated = [
      { id: 'cmd', name: 'Cmd', qty: 1, is_commander: true, type_line: 'Legendary Creature' },
      ...Array.from({ length: 97 }, (_, i) => spell(`s${i}`, `Spell ${i}`)),
      spell('engine1', 'Viscera Seer'),   // added by the engine pass
      spell('f1', 'Filler One'),
    ]
    const analyzeCutFn = vi.fn(() => ({ recommended: [] }))
    await runComboPass({
      populated,
      // engine1 IS in fillIds — the bug
      fillIds: ['engine1', 'f1'],
      targetBracket: 4,
      commanderColorIdentity: ['R'],
      ownedNameKeys: new Set(['piece x']),
      deckSize: 100,
      isLandRow,
      fetchCombos: async () => ({ almost: [rawCombo('a', ['Spell 0', 'Piece X'])] }),
      analyzeCutFn,
      addCards: vi.fn(async () => ({ rows: [] })),
      removeCards: vi.fn(),
    })
    const locked = analyzeCutFn.mock.calls[0][0].lockedIds
    expect(locked.has('engine1')).toBe(false) // cuttable → the engine piece is at risk
  })

  it('excluding engine rows from the fill pool protects them', async () => {
    const populated = [
      { id: 'cmd', name: 'Cmd', qty: 1, is_commander: true, type_line: 'Legendary Creature' },
      ...Array.from({ length: 97 }, (_, i) => spell(`s${i}`, `Spell ${i}`)),
      spell('engine1', 'Viscera Seer'),
      spell('f1', 'Filler One'),
    ]
    const analyzeCutFn = vi.fn(() => ({ recommended: [] }))
    await runComboPass({
      populated,
      fillIds: ['f1'], // engine1 withheld — this is the fix
      targetBracket: 4,
      commanderColorIdentity: ['R'],
      ownedNameKeys: new Set(['piece x']),
      deckSize: 100,
      isLandRow,
      fetchCombos: async () => ({ almost: [rawCombo('a', ['Spell 0', 'Piece X'])] }),
      analyzeCutFn,
      addCards: vi.fn(async () => ({ rows: [] })),
      removeCards: vi.fn(),
    })
    const locked = analyzeCutFn.mock.calls[0][0].lockedIds
    expect(locked.has('engine1')).toBe(true)
  })
})

// Both post-fill passes run BEFORE the basics top-up, so the deck they see has
// its nonland slots full and its land slots empty. Treating that gap as free
// space is how an auto-fill finished on 34 lands against a 37 target: the
// engine pass took 8 of the reserved slots and the combo pass took another.
describe('post-fill passes leave the basics top-up its land slots', () => {
  // 55 nonlands + 30 lands = 85 copies, so 15 slots are open — but the build
  // wants 37 lands and only has 30, so 7 of those 15 belong to the manabase.
  const partlyLanded = () => [
    { id: 'cmd', name: 'Cmd', qty: 1, is_commander: true, type_line: 'Legendary Creature' },
    ...Array.from({ length: 54 }, (_, i) => spell(`f${i}`, `Filler ${i}`)),
    { id: 'lands', name: 'Mountain', qty: 30, type_line: 'Basic Land — Mountain' },
  ]
  const coverage = short => ([{
    enabler: 'sacOutlet', label: 'sacrifice outlets', why: '', target: 20,
    have: 20 - short, short, providers: [],
  }])
  const manyProviders = Array.from({ length: 20 }, (_, i) => ({ name: `Outlet ${i}` }))

  it('caps the engine pass to the slots the manabase does not need', async () => {
    const addCards = vi.fn(async () => ({ rows: [] }))
    const out = await runEnginePass({
      populated: partlyLanded(),
      fillIds: [], // no cuttable filler, so open slots are the only room
      coverage: coverage(20),
      providersFor: () => manyProviders,
      deckSize: 100,
      maxAdd: 20, // above the default 8, so the land reserve is what binds
      landTarget: 37,
      isLandRow,
      analyzeCutFn: () => ({ recommended: [] }),
      addCards,
    })
    // 15 open − 7 still owed to the manabase = 8 spendable.
    expect(out.added).toBe(8)
  })

  it('spends every open slot when the manabase is already at target', async () => {
    const addCards = vi.fn(async () => ({ rows: [] }))
    const out = await runEnginePass({
      populated: partlyLanded(),
      fillIds: [],
      coverage: coverage(20),
      providersFor: () => manyProviders,
      deckSize: 100,
      maxAdd: 20, // above the default 8, so the land reserve is what binds
      landTarget: 30, // already met
      isLandRow,
      analyzeCutFn: () => ({ recommended: [] }),
      addCards,
    })
    expect(out.added).toBe(15)
  })

  it('caps the combo pass the same way', async () => {
    const addCards = vi.fn(async () => ({ rows: [] }))
    // Four separate one-piece-away combos: uncapped the pass would add all four.
    const almost = [
      rawCombo('a', ['Filler 0', 'Piece A']),
      rawCombo('b', ['Filler 1', 'Piece B']),
      rawCombo('c', ['Filler 2', 'Piece C']),
      rawCombo('d', ['Filler 3', 'Piece D']),
    ]
    const out = await runComboPass({
      populated: [
        { id: 'cmd', name: 'Cmd', qty: 1, is_commander: true, type_line: 'Legendary Creature' },
        ...Array.from({ length: 54 }, (_, i) => spell(`f${i}`, `Filler ${i}`)),
        { id: 'lands', name: 'Mountain', qty: 43, type_line: 'Basic Land — Mountain' },
      ],
      fillIds: [], // nothing cuttable
      targetBracket: 4,
      commanderColorIdentity: ['R'],
      ownedNameKeys: new Set(['piece a', 'piece b', 'piece c', 'piece d']),
      deckSize: 100,
      landTarget: 45, // 2 lands short, and only 2 slots open
      isLandRow,
      fetchCombos: async () => ({ almost }),
      analyzeCutFn: () => ({ recommended: [] }),
      addCards,
      removeCards: vi.fn(),
    })
    // 2 open slots, both owed to the manabase -> nothing spendable.
    expect(out.comboRows).toEqual([])
    expect(addCards).not.toHaveBeenCalled()
  })

  it('is unchanged when no land target is supplied', async () => {
    const addCards = vi.fn(async () => ({ rows: [] }))
    const out = await runEnginePass({
      populated: partlyLanded(),
      fillIds: [],
      coverage: coverage(20),
      providersFor: () => manyProviders,
      deckSize: 100,
      maxAdd: 20, // above the default 8, so the land reserve is what binds
      isLandRow,
      analyzeCutFn: () => ({ recommended: [] }),
      addCards,
    })
    expect(out.added).toBe(15)
  })
})
