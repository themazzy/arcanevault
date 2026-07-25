/**
 * A folder's user-chosen background art lives under `bg_url` inside the
 * `folders.description` JSON blob, alongside whatever else that blob carries
 * (`isGroup`, `groupId`, deck meta…). Both readers and the writer have to merge
 * rather than replace, which is why these live in one place: three surfaces set
 * the background now (the index tile cog menu, and the More menu of an opened
 * binder / collection deck / wishlist).
 */

export function parseFolderBgUrl(description) {
  try { return JSON.parse(description || '{}').bg_url || null } catch { return null }
}

/**
 * Merge a background URL into a folder description, or drop it when `url` is
 * falsy. Returns the new description string, or null when nothing is left —
 * the column stays null rather than holding an empty `{}`.
 */
export function withFolderBgUrl(description, url) {
  let desc = {}
  try { desc = JSON.parse(description || '{}') } catch { /* replace unparseable */ }
  if (!url) delete desc.bg_url
  else desc.bg_url = url
  return Object.keys(desc).length > 0 ? JSON.stringify(desc) : null
}
