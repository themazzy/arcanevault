import {
  getLocalCards,
  getLocalFolders,
  getAllLocalFolderCards,
  getAllDeckAllocationsForUser,
} from './db'

function isGroupFolder(folder) {
  try { return JSON.parse(folder?.description || '{}').isGroup === true } catch { return false }
}

export async function hydrateCollectionQueriesFromIdb(queryClient, userId) {
  if (!queryClient || !userId) return

  const [localCards, localFolders] = await Promise.all([
    getLocalCards(userId),
    getLocalFolders(userId),
  ])

  if (localCards.length) {
    queryClient.setQueryData(['cards', userId], localCards, { updatedAt: 0 })
  }

  if (!localFolders.length) return

  const placementFolders = localFolders.filter(folder => !isGroupFolder(folder))
  queryClient.setQueryData(['folders', userId], placementFolders, { updatedAt: 0 })

  const binderIds = placementFolders
    .filter(folder => folder.type !== 'deck' && folder.type !== 'builder_deck')
    .map(folder => folder.id)

  const [folderCards, deckAllocations] = await Promise.all([
    getAllLocalFolderCards(binderIds),
    getAllDeckAllocationsForUser(userId),
  ])

  queryClient.setQueryData(
    ['folderPlacements', userId],
    { folderCards, deckAllocations },
    { updatedAt: 0 }
  )
}
