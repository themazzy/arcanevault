import { useCallback, useRef, useState } from 'react'
import { searchCommanders, makeDebouncer } from '../lib/deckBuilderApi'

/**
 * Encapsulates the commander-picker search box state: the query input,
 * debounced Scryfall calls, dropdown open/close, and the result list.
 *
 * Picking a commander is intentionally NOT part of this hook — applying a
 * commander to the deck mutates `deck_cards` + `folders.description` and
 * needs page-level deck state. The hook just owns the search surface; the
 * page calls `close()` once it has accepted a pick.
 */
export function useCommanderSearch({ debounceMs = 300, scope = 'commander' } = {}) {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [isOpen,  setIsOpen]  = useState(false)
  const debounce = useRef(makeDebouncer(debounceMs))
  const requestId = useRef(0)

  const handleQuery = useCallback((q) => {
    setQuery(q)
    setIsOpen(true)
    if (!q.trim()) {
      setResults([])
      return
    }
    const id = ++requestId.current
    debounce.current(async () => {
      setLoading(true)
      const next = await searchCommanders(q, scope)
      // Drop stale results — a faster follow-up query may have already won.
      if (id !== requestId.current) return
      setResults(next)
      setLoading(false)
    })
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
    setQuery('')
    setResults([])
  }, [])

  return { query, results, loading, isOpen, setIsOpen, handleQuery, close }
}
