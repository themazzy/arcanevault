import { useCallback, useRef, useState } from 'react'
import { searchCards, makeDebouncer } from '../lib/deckBuilderApi'

/**
 * Debounced Scryfall card search for the deck-builder left panel.
 *
 * State surface:
 *   query, results, loading, hasMore, page, error
 *   handleInput(q) — debounced; updates query and triggers page-1 fetch
 *   loadMore()    — fetches the next page and appends
 *
 * Format scoping is part of the search predicate, so the hook resubscribes
 * whenever the active deck format changes.
 *
 * Stale-request guard: a request id is bumped per fetch; older responses are
 * dropped so a slow page-1 can't overwrite the user's fresher page-2.
 */
export function useCardSearch({ format, debounceMs = 350 } = {}) {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [page,    setPage]    = useState(1)
  const [error,   setError]   = useState(false)

  const debounce  = useRef(makeDebouncer(debounceMs))
  const requestId = useRef(0)

  const search = useCallback(async (q, p = 1) => {
    const id = ++requestId.current
    setLoading(true)
    setError(false)
    const { cards, hasMore: more, error: err } = await searchCards({ query: q, format, page: p })
    if (id !== requestId.current) return
    setPage(p)
    setResults(prev => p === 1 ? cards : [...prev, ...cards])
    setHasMore(more)
    if (err) setError(true)
    setLoading(false)
  }, [format])

  const handleInput = useCallback((q) => {
    setQuery(q)
    debounce.current(() => search(q, 1))
  }, [search])

  const loadMore = useCallback(() => {
    search(query, page + 1)
  }, [query, page, search])

  return { query, results, loading, hasMore, page, error, handleInput, loadMore }
}
