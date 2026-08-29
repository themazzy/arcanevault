// Inline folder/deck rename, shared by DeckBrowser and Folders.
//
// Both had their own copy of this and both made the same mistake: after the
// write succeeded they assigned the new name onto the folder object they had
// been handed. That object is shared, so a sibling list rendering from the same
// reference appeared to follow along — but nothing re-rendered off the
// assignment, and the query cache still held the old name until something else
// invalidated it.
//
// The helper takes an id and two strings, never the folder object, so there is
// nothing to mutate. Keeping the cache correct is `invalidate`'s job.
//
// UI state (closing the editor, focusing the input) stays in the component;
// this owns only the guard, the optimistic update, the write, and the rollback.

/**
 * @returns {'skipped'|'renamed'|'failed'} what happened, for callers and tests.
 */
export async function commitFolderRename({
  folderId,
  nextName,
  currentName,
  rename,
  setName,
  invalidate,
  notifySuccess,
  notifyError,
}) {
  const trimmed = String(nextName ?? '').trim()

  // Nothing to do: no folder, an empty name, or the name it already has.
  // Whitespace-only input lands here too rather than clearing the name.
  if (!folderId || !trimmed || trimmed === currentName) return 'skipped'

  // Optimistic: the title updates before the round trip, and is put back if the
  // write fails.
  setName(trimmed)
  try {
    await rename(folderId, trimmed)
    invalidate?.()
    notifySuccess?.(trimmed)
    return 'renamed'
  } catch (err) {
    setName(currentName)
    notifyError?.(err?.message || 'Rename failed.')
    return 'failed'
  }
}
