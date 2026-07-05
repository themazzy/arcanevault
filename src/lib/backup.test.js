import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./supabase', () => ({ sb: {} }))

import {
  BACKUP_APP, BACKUP_KIND, BACKUP_VERSION,
  validateBackupFile, summarizeBackup,
  buildFolderInsertRows, buildLinkedPairUpdates, buildCardIdMap,
  buildFolderCardInsertRows, buildDeckAllocationInsertRows,
  groupListItemsByFolder, buildDeckCategoryInsertRows, buildDeckCardInsertRows,
} from './backup'

afterEach(() => vi.clearAllMocks())

let counter
function genId() { return `new-${counter++}` }
beforeEach(() => { counter = 0 })

describe('validateBackupFile', () => {
  it('rejects non-objects', () => {
    expect(validateBackupFile(null)).toMatch(/not valid JSON/)
    expect(validateBackupFile('nope')).toMatch(/not valid JSON/)
  })
  it('rejects files from another app/kind', () => {
    expect(validateBackupFile({ app: 'other', kind: BACKUP_KIND, version: 1 })).toMatch(/not a DeckLoom/)
    expect(validateBackupFile({ app: BACKUP_APP, kind: 'something-else', version: 1 })).toMatch(/not a DeckLoom/)
  })
  it('rejects a newer version than this client understands', () => {
    expect(validateBackupFile({ app: BACKUP_APP, kind: BACKUP_KIND, version: BACKUP_VERSION + 1 })).toMatch(/newer version/)
  })
  it('accepts a well-formed backup', () => {
    expect(validateBackupFile({ app: BACKUP_APP, kind: BACKUP_KIND, version: BACKUP_VERSION })).toBeNull()
  })
})

describe('summarizeBackup', () => {
  it('counts each section, defaulting to 0 when absent', () => {
    expect(summarizeBackup({})).toEqual({
      folders: 0, cards: 0, folderCards: 0, deckAllocations: 0, listItems: 0, deckCategories: 0, deckCards: 0,
    })
    expect(summarizeBackup({ folders: [{}, {}], cards: [{}] })).toEqual(
      expect.objectContaining({ folders: 2, cards: 1 })
    )
  })
})

describe('buildFolderInsertRows', () => {
  it('assigns a fresh id to every folder and maps old -> new', () => {
    counter = 0
    const folders = [
      { id: 'old-1', name: 'Binder A', type: 'binder', description: null },
      { id: 'old-2', name: 'Deck B', type: 'deck', description: '{}' },
    ]
    const { rows, idMap } = buildFolderInsertRows(folders, 'user-1', genId)
    expect(rows).toEqual([
      { id: 'new-0', user_id: 'user-1', name: 'Binder A', type: 'binder', description: null },
      { id: 'new-1', user_id: 'user-1', name: 'Deck B', type: 'deck', description: '{}' },
    ])
    expect(idMap.get('old-1')).toBe('new-0')
    expect(idMap.get('old-2')).toBe('new-1')
  })
})

describe('buildLinkedPairUpdates', () => {
  it('rewrites linked_deck_id/linked_builder_id to the new folder ids', () => {
    const folders = [
      { id: 'builder-old', description: JSON.stringify({ linked_deck_id: 'coll-old' }) },
      { id: 'coll-old', description: JSON.stringify({ linked_builder_id: 'builder-old' }) },
    ]
    const folderIdMap = new Map([['builder-old', 'builder-new'], ['coll-old', 'coll-new']])
    const updates = buildLinkedPairUpdates(folders, folderIdMap)
    expect(updates).toHaveLength(2)
    const builderUpdate = updates.find(u => u.id === 'builder-new')
    expect(JSON.parse(builderUpdate.description)).toEqual({ linked_deck_id: 'coll-new' })
    const collUpdate = updates.find(u => u.id === 'coll-new')
    expect(JSON.parse(collUpdate.description)).toEqual({ linked_builder_id: 'builder-new' })
  })
  it('skips folders with no linked pair fields', () => {
    const folders = [{ id: 'f1', description: JSON.stringify({ isGroup: true }) }]
    expect(buildLinkedPairUpdates(folders, new Map([['f1', 'f1-new']]))).toEqual([])
  })
  it('drops a link whose counterpart folder is missing from the map', () => {
    const folders = [{ id: 'builder-old', description: JSON.stringify({ linked_deck_id: 'gone' }) }]
    const updates = buildLinkedPairUpdates(folders, new Map([['builder-old', 'builder-new']]))
    expect(JSON.parse(updates[0].description)).toEqual({})
  })
})

describe('buildCardIdMap', () => {
  const printMap = new Map([['sf-1', { id: 'print-1' }], ['sf-2', { id: 'print-2' }]])
  const getCardPrintFn = (map, card) => map.get(card.id) || null

  it('maps original card ids to the saved row sharing the same print/foil/lang/condition identity', () => {
    const backupCards = [
      { id: 'card-old-1', scryfall_id: 'sf-1', foil: false, language: 'en', condition: 'near_mint' },
      { id: 'card-old-2', scryfall_id: 'sf-1', foil: true, language: 'en', condition: 'near_mint' },
    ]
    const savedCards = [
      { id: 'card-new-1', card_print_id: 'print-1', foil: false, language: 'en', condition: 'near_mint' },
      { id: 'card-new-2', card_print_id: 'print-1', foil: true, language: 'en', condition: 'near_mint' },
    ]
    const idMap = buildCardIdMap(backupCards, savedCards, printMap, getCardPrintFn)
    expect(idMap.get('card-old-1')).toBe('card-new-1')
    expect(idMap.get('card-old-2')).toBe('card-new-2')
  })

  it('maps two duplicate backup rows onto the single merged saved row', () => {
    const backupCards = [
      { id: 'card-old-1', scryfall_id: 'sf-1', foil: false, language: 'en', condition: 'near_mint' },
      { id: 'card-old-2', scryfall_id: 'sf-1', foil: false, language: 'en', condition: 'near_mint' },
    ]
    const savedCards = [{ id: 'card-new-1', card_print_id: 'print-1', foil: false, language: 'en', condition: 'near_mint' }]
    const idMap = buildCardIdMap(backupCards, savedCards, printMap, getCardPrintFn)
    expect(idMap.get('card-old-1')).toBe('card-new-1')
    expect(idMap.get('card-old-2')).toBe('card-new-1')
  })

  it('skips a card whose print could not be resolved', () => {
    const idMap = buildCardIdMap([{ id: 'card-old', scryfall_id: 'missing' }], [], printMap, getCardPrintFn)
    expect(idMap.has('card-old')).toBe(false)
  })
})

describe('buildFolderCardInsertRows', () => {
  it('remaps folder_id/card_id and drops rows whose folder or card is missing', () => {
    counter = 0
    const folderIdMap = new Map([['f-old', 'f-new']])
    const cardIdMap = new Map([['c-old', 'c-new']])
    const rows = buildFolderCardInsertRows([
      { folder_id: 'f-old', card_id: 'c-old', qty: 3, trade_any_version: true, trade_note: 'note' },
      { folder_id: 'f-old', card_id: 'missing-card', qty: 1 },
      { folder_id: 'missing-folder', card_id: 'c-old', qty: 1 },
    ], folderIdMap, cardIdMap, genId)
    expect(rows).toEqual([
      { id: 'new-0', folder_id: 'f-new', card_id: 'c-new', qty: 3, trade_any_version: true, trade_note: 'note' },
    ])
  })
})

describe('buildDeckAllocationInsertRows', () => {
  it('remaps deck_id/card_id and attaches the current user', () => {
    counter = 0
    const folderIdMap = new Map([['d-old', 'd-new']])
    const cardIdMap = new Map([['c-old', 'c-new']])
    const rows = buildDeckAllocationInsertRows([{ deck_id: 'd-old', card_id: 'c-old', qty: 2 }], folderIdMap, cardIdMap, 'user-1', genId)
    expect(rows).toEqual([{ id: 'new-0', deck_id: 'd-new', user_id: 'user-1', card_id: 'c-new', qty: 2 }])
  })
})

describe('groupListItemsByFolder', () => {
  it('groups wishlist rows under their new folder id and drops unmapped folders', () => {
    const folderIdMap = new Map([['list-old', 'list-new']])
    const grouped = groupListItemsByFolder([
      { folder_id: 'list-old', scryfall_id: 'sf-1', name: 'A', foil: false, qty: 2 },
      { folder_id: 'gone', scryfall_id: 'sf-2', name: 'B', qty: 1 },
    ], folderIdMap)
    expect([...grouped.keys()]).toEqual(['list-new'])
    expect(grouped.get('list-new')).toEqual([{ scryfall_id: 'sf-1', name: 'A', set_code: undefined, collector_number: undefined, foil: false, qty: 2 }])
  })
})

describe('buildDeckCategoryInsertRows', () => {
  it('assigns fresh ids and maps old category id -> new', () => {
    counter = 0
    const folderIdMap = new Map([['deck-old', 'deck-new']])
    const { rows, idMap } = buildDeckCategoryInsertRows([
      { id: 'cat-old', deck_id: 'deck-old', name: 'Ramp', sort_order: 1 },
    ], folderIdMap, 'user-1', genId)
    expect(rows).toEqual([{ id: 'new-0', deck_id: 'deck-new', user_id: 'user-1', name: 'Ramp', sort_order: 1 }])
    expect(idMap.get('cat-old')).toBe('new-0')
  })
})

describe('buildDeckCardInsertRows', () => {
  const printMap = new Map([['sf-1', { id: 'print-1' }]])
  const getCardPrintFn = (map, card) => map.get(card.id) || null

  it('remaps deck_id/category_id and resolves card_print_id', () => {
    counter = 0
    const folderIdMap = new Map([['deck-old', 'deck-new']])
    const categoryIdMap = new Map([['cat-old', 'cat-new']])
    const rows = buildDeckCardInsertRows([
      { deck_id: 'deck-old', scryfall_id: 'sf-1', qty: 1, foil: false, is_commander: true, board: 'main', category_id: 'cat-old' },
    ], folderIdMap, categoryIdMap, printMap, 'user-1', getCardPrintFn, genId)
    expect(rows).toEqual([{
      id: 'new-0', deck_id: 'deck-new', user_id: 'user-1', card_print_id: 'print-1',
      qty: 1, foil: false, is_commander: true, board: 'main', category_id: 'cat-new',
    }])
  })

  it('drops deck cards whose print cannot be resolved', () => {
    const folderIdMap = new Map([['deck-old', 'deck-new']])
    const rows = buildDeckCardInsertRows([{ deck_id: 'deck-old', scryfall_id: 'missing' }], folderIdMap, new Map(), printMap, 'user-1', getCardPrintFn, genId)
    expect(rows).toEqual([])
  })
})
