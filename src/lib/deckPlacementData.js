import { sb } from './supabase'
import {
  getAllDeckAllocationsForUser,
  getAllLocalFolderCards,
  getLocalCards,
  getLocalFolders,
  deleteDeckAllocationsByCardIds,
  deleteFolderCardsByCardIds,
  putCards,
  putDeckAllocations,
  putFolderCards,
  putFolders,
  replaceDeckAllocations,
  replaceLocalFolderCards,
} from './db'

const CHUNK_SIZE = 500

function unique(values) {
  return [...new Set((values || []).filter(Boolean))]
}

function chunks(values, size = CHUNK_SIZE) {
  const out = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase()
}

function matchesFilters(card, { cardIds, names, scryfallIds } = {}) {
  if (cardIds?.size && !cardIds.has(card.id)) return false
  const cardName = normalizeName(card.name)
  const hasLooseFilter = !!(names?.size || scryfallIds?.size)
  if (!hasLooseFilter) return true
  return (!!names?.size && names.has(cardName)) || (!!scryfallIds?.size && scryfallIds.has(card.scryfall_id))
}

function buildSnapshot({ userId, cards = [], folders = [], folderRows = [], deckRows = [] }) {
  const folderById = new Map((folders || []).map(folder => [folder.id, folder]))
  const folderRowsByCardId = new Map()
  const deckRowsByCardId = new Map()
  const binderQtyByCardId = new Map()
  const deckQtyByCardId = new Map()

  for (const row of folderRows || []) {
    if (!row?.card_id) continue
    const list = folderRowsByCardId.get(row.card_id) || []
    list.push(row)
    folderRowsByCardId.set(row.card_id, list)

    const folder = folderById.get(row.folder_id)
    if (!folder || folder.type === 'binder') {
      binderQtyByCardId.set(row.card_id, (binderQtyByCardId.get(row.card_id) || 0) + (row.qty || 0))
    }
  }

  for (const row of deckRows || []) {
    if (!row?.card_id) continue
    const list = deckRowsByCardId.get(row.card_id) || []
    list.push(row)
    deckRowsByCardId.set(row.card_id, list)
    deckQtyByCardId.set(row.card_id, (deckQtyByCardId.get(row.card_id) || 0) + (row.qty || 0))
  }

  return {
    userId,
    cards,
    folders,
    folderById,
    wishlistFolders: folders.filter(folder => folder.type === 'list'),
    folderRows,
    deckRows,
    binderQtyByCardId,
    deckQtyByCardId,
    folderRowsByCardId,
    deckRowsByCardId,
  }
}

export async function loadLocalPlacementSnapshot(userId, opts = {}) {
  if (!userId) return buildSnapshot({ userId })

  const cardIdSet = opts.cardIds?.length ? new Set(opts.cardIds) : null
  const nameSet = opts.names?.length ? new Set(opts.names.map(normalizeName).filter(Boolean)) : null
  const scryfallIdSet = opts.scryfallIds?.length ? new Set(opts.scryfallIds.filter(Boolean)) : null

  const [allCards, folders, allDeckRows] = await Promise.all([
    getLocalCards(userId),
    getLocalFolders(userId),
    getAllDeckAllocationsForUser(userId),
  ])
  const folderRows = await getAllLocalFolderCards((folders || []).map(folder => folder.id).filter(Boolean))

  const cards = (allCards || []).filter(card => matchesFilters(card, {
    cardIds: cardIdSet,
    names: nameSet,
    scryfallIds: scryfallIdSet,
  }))
  const allowedCardIds = new Set(cards.map(card => card.id).filter(Boolean))
  const filteredFolderRows = allowedCardIds.size
    ? (folderRows || []).filter(row => allowedCardIds.has(row.card_id))
    : []
  const filteredDeckRows = allowedCardIds.size
    ? (allDeckRows || []).filter(row => allowedCardIds.has(row.card_id))
    : []

  return buildSnapshot({
    userId,
    cards,
    folders: folders || [],
    folderRows: filteredFolderRows,
    deckRows: filteredDeckRows,
  })
}

async function fetchCards(userId, opts = {}) {
  const byId = new Map()
  const addRows = rows => {
    for (const row of rows || []) {
      if (row?.id) byId.set(row.id, row)
    }
  }
  const select = 'id,user_id,name,set_code,collector_number,scryfall_id,foil,qty,card_print_id,type_line,mana_cost,cmc,color_identity,image_uri,updated_at'
  const cardIds = unique(opts.cardIds)
  const names = unique(opts.names)
  const scryfallIds = unique(opts.scryfallIds)

  if (!cardIds.length && !names.length && !scryfallIds.length) {
    const { data, error } = await sb.from('owned_cards_view').select(select).eq('user_id', userId)
    if (error) throw error
    addRows(data)
    return [...byId.values()]
  }

  for (const chunk of chunks(cardIds)) {
    const { data, error } = await sb.from('owned_cards_view').select(select).eq('user_id', userId).in('id', chunk)
    if (error) throw error
    addRows(data)
  }
  for (const chunk of chunks(names)) {
    const { data, error } = await sb.from('owned_cards_view').select(select).eq('user_id', userId).in('name', chunk)
    if (error) throw error
    addRows(data)
  }
  for (const chunk of chunks(scryfallIds)) {
    const { data, error } = await sb.from('owned_cards_view').select(select).eq('user_id', userId).in('scryfall_id', chunk)
    if (error) throw error
    addRows(data)
  }
  return [...byId.values()]
}

async function fetchFolderRows({ cardIds, folderIds }) {
  const rows = []
  if (cardIds?.length) {
    for (const chunk of chunks(cardIds)) {
      const { data, error } = await sb.from('folder_cards').select('id,folder_id,card_id,qty,updated_at').in('card_id', chunk)
      if (error) throw error
      rows.push(...(data || []))
    }
    return rows
  }

  for (const chunk of chunks(folderIds || [])) {
    const { data, error } = await sb.from('folder_cards').select('id,folder_id,card_id,qty,updated_at').in('folder_id', chunk)
    if (error) throw error
    rows.push(...(data || []))
  }
  return rows
}

async function fetchDeckRows(userId, cardIds) {
  const rows = []
  if (cardIds?.length) {
    for (const chunk of chunks(cardIds)) {
      const { data, error } = await sb
        .from('deck_allocations')
        .select('id,deck_id,card_id,qty,user_id')
        .eq('user_id', userId)
        .in('card_id', chunk)
      if (error) throw error
      rows.push(...(data || []))
    }
    return rows
  }

  const { data, error } = await sb
    .from('deck_allocations')
    .select('id,deck_id,card_id,qty,user_id')
    .eq('user_id', userId)
  if (error) throw error
  return data || []
}

export async function refreshRemotePlacementSnapshot(userId, opts = {}) {
  if (!userId) return buildSnapshot({ userId })

  const [cards, { data: folders, error: foldersErr }] = await Promise.all([
    fetchCards(userId, opts),
    sb.from('folders').select('id,user_id,name,type,description').eq('user_id', userId),
  ])
  if (foldersErr) throw foldersErr

  const cardIds = unique(cards.map(card => card.id))
  const folderIds = unique((folders || []).map(folder => folder.id))
  const hasCardFilters = !!(opts.cardIds?.length || opts.names?.length || opts.scryfallIds?.length)
  const [folderRows, deckRows] = await Promise.all([
    hasCardFilters && !cardIds.length ? Promise.resolve([]) : fetchFolderRows({ cardIds: cardIds.length ? cardIds : null, folderIds }),
    hasCardFilters && !cardIds.length ? Promise.resolve([]) : fetchDeckRows(userId, cardIds.length ? cardIds : null),
  ])

  putFolders(folders || []).catch(() => {})
  putCards(cards || []).catch(() => {})
  if (cardIds.length) {
    deleteFolderCardsByCardIds(cardIds)
      .then(() => putFolderCards(folderRows))
      .catch(() => {})
    deleteDeckAllocationsByCardIds(cardIds)
      .then(() => putDeckAllocations(deckRows))
      .catch(() => {})
  } else if (!hasCardFilters) {
    replaceLocalFolderCards(folderIds, folderRows).catch(() => {})
    replaceDeckAllocations((folders || []).filter(folder => folder.type === 'deck').map(folder => folder.id), deckRows).catch(() => {})
  }

  return buildSnapshot({
    userId,
    cards,
    folders: folders || [],
    folderRows,
    deckRows,
  })
}

export function buildDeckAllocationViewRows(snapshot, deckId) {
  if (!snapshot || !deckId) return []
  const cardById = new Map((snapshot.cards || []).map(card => [card.id, card]))
  return (snapshot.deckRows || [])
    .filter(row => row.deck_id === deckId)
    .map(row => {
      const card = cardById.get(row.card_id) || {}
      return {
        ...card,
        id: row.id,
        allocation_id: row.id,
        deck_id: row.deck_id,
        card_id: row.card_id,
        qty: row.qty || 0,
        user_id: row.user_id || snapshot.userId || card.user_id,
        name: card.name || 'Card',
        foil: card.foil ?? false,
      }
    })
}
