export function invalidateOwnedCollectionQueries(queryClient, userId, options = {}) {
  if (!queryClient || !userId) return Promise.resolve()
  const {
    includeFolders = false,
    includeCards = false,
    includePlacements = true,
  } = options
  const invalidations = []
  if (includePlacements) invalidations.push(queryClient.invalidateQueries({ queryKey: ['folderPlacements', userId] }))
  if (includeFolders) invalidations.push(queryClient.invalidateQueries({ queryKey: ['folders', userId] }))
  if (includeCards) {
    invalidations.push(queryClient.invalidateQueries({ queryKey: ['cards', userId] }))
    invalidations.push(queryClient.invalidateQueries({ queryKey: ['sfMap', userId] }))
  }
  return Promise.all(invalidations)
}

export function invalidateWishlistQueries(queryClient, userId, options = {}) {
  if (!queryClient || !userId) return Promise.resolve()
  const {
    includeFolders = false,
    includeItems = true,
  } = options
  const invalidations = []
  if (includeItems) invalidations.push(queryClient.invalidateQueries({ queryKey: ['listItems', userId] }))
  if (includeFolders) invalidations.push(queryClient.invalidateQueries({ queryKey: ['folders', userId] }))
  return Promise.all(invalidations)
}
