import {
  getLocalCards,
  getLocalFolders,
  getAllLocalFolderCards,
  getAllDeckAllocationsForUser,
  getAllLocalListItems,
} from './db'
import { getInstantCache } from './scryfall'

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
    // Seed the Scryfall map too, or the tiles paint without their images.
    //
    // Card rows hydrate instantly here, so a grid of names, set codes and
    // purchase-price fallbacks appears at once — but `sfMap` starts at its
    // placeholder `{}`, and `getImageUri(undefined)` is undefined, so every
    // tile renders a text placeholder until the *network* query resolves:
    // an IDB read, then metadata enrichment, then the price overlay. On a
    // phone that was 10-15 s of imageless tiles, and then every visible image
    // requesting at once the instant the map landed.
    //
    // The image URLs were on the device the whole time. This is the same
    // IndexedDB cache that fetchSfMap itself starts from, so seeding costs one
    // local read and no network at all. The real query still runs and replaces
    // this with prices attached — updatedAt: 0 marks the seed stale so it
    // always refetches, exactly as the card seed above does.
    //
    // Deliberately not parallelised with the reads above: those are the ones
    // that put cards on screen, and this must not delay them. It is also
    // fire-and-forget — a cold Scryfall cache returns null and the grid simply
    // behaves as it did before.
    seedScryfallMap(queryClient, userId)
  }

  if (!localFolders.length) return

  const placementFolders = localFolders.filter(folder => !isGroupFolder(folder))
  queryClient.setQueryData(['folders', userId], placementFolders, { updatedAt: 0 })

  const binderIds = placementFolders
    .filter(folder => folder.type !== 'deck' && folder.type !== 'builder_deck')
    .map(folder => folder.id)

  const [folderCards, deckAllocations, listItems] = await Promise.all([
    getAllLocalFolderCards(binderIds),
    getAllDeckAllocationsForUser(userId),
    getAllLocalListItems(userId),
  ])

  queryClient.setQueryData(
    ['folderPlacements', userId],
    // Seed folders alongside placements so the first paint builds its
    // card→folder map from one consistent snapshot (matches fetchFolderPlacements).
    { folders: placementFolders, folderCards, deckAllocations },
    { updatedAt: 0 }
  )

  if (listItems.length) {
    queryClient.setQueryData(['listItems', userId], listItems, { updatedAt: 0 })
  }
}

/**
 * Publish the cached Scryfall map so images can paint before the network work.
 *
 * Never rejects and never blocks its caller: an empty or unreadable cache just
 * means the grid waits for the query, which is the pre-existing behaviour.
 */
function seedScryfallMap(queryClient, userId) {
  getInstantCache()
    .then(map => {
      // An empty object would still count as data and satisfy the query, so
      // only seed when there is something real to show.
      if (!map || !Object.keys(map).length) return
      // Lost the race: the network query already resolved while this local read
      // was in flight. Its map is the same one plus current prices, so seeding
      // now would replace a complete map with a staler one and un-price the
      // grid. Rare (an IDB read normally beats a round trip) but not
      // impossible on a warm cache and a fast connection.
      if (queryClient.getQueryData(['sfMap', userId]) !== undefined) return
      queryClient.setQueryData(['sfMap', userId], map, { updatedAt: 0 })
    })
    .catch(() => { /* cold cache — the query fills it in */ })
}
