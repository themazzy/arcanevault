import { useState, useRef, useEffect, useCallback, startTransition } from 'react'
import { SearchInput } from '../UI'

export const DECK_FILTER_SEARCH_DELAY_MS = 160

/**
 * Keep raw keystrokes out of DeckBuilder's state. Updating the page-level
 * search on every input event synchronously re-rendered the entire builder,
 * including every deck view. The local draft stays instant; the actual filter
 * is committed once typing pauses and runs as an interruptible transition.
 *
 * Lives outside DeckBuilder.jsx so the draft/commit handshake below can be
 * tested without standing up the whole page.
 */
export default function DeckFilterSearchInput({
  value, onCommit, className = '', wrapClassName = '', leadingIcon = null,
  placeholder = 'Search name, type or rules text...',
}) {
  const [draft, setDraft] = useState(value || '')
  const timerRef = useRef(null)
  const latestDraftRef = useRef(value || '')
  const lastCommitRef = useRef(value || '')

  useEffect(() => () => clearTimeout(timerRef.current), [])

  // Reflect clears initiated elsewhere (for example, revealing a warning).
  useEffect(() => {
    const next = value || ''
    if (next === lastCommitRef.current) return
    lastCommitRef.current = next
    latestDraftRef.current = next
    setDraft(next)
  }, [value])

  // The draft must move with the commit, not just alongside it. The clear (X)
  // commits '' directly without going through schedule(), and the value-sync
  // effect above then early-returns because lastCommitRef already matches — so
  // leaving draft alone unfiltered the list while the box kept the old text.
  const commit = useCallback((next) => {
    clearTimeout(timerRef.current)
    timerRef.current = null
    lastCommitRef.current = next
    latestDraftRef.current = next
    setDraft(next)
    startTransition(() => onCommit(next))
  }, [onCommit])

  const schedule = useCallback((next) => {
    latestDraftRef.current = next
    setDraft(next)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => commit(next), DECK_FILTER_SEARCH_DELAY_MS)
  }, [commit])

  const flush = useCallback(() => {
    if (timerRef.current) commit(latestDraftRef.current)
  }, [commit])

  return (
    <SearchInput
      className={className}
      wrapClassName={wrapClassName}
      leadingIcon={leadingIcon}
      value={draft}
      onChange={e => schedule(e.target.value)}
      onClear={() => commit('')}
      onBlur={flush}
      placeholder={placeholder}
      aria-label="Search cards in this deck"
    />
  )
}
