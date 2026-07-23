import { useCallback, useRef, useState } from 'react'
import { searchCards, makeDebouncer } from '../lib/deckBuilderApi'

/**
 * Debounced Supabase card search for the deck-builder Add Cards panel.
 *
 * State surface:
 *   query, results, loading, hasMore, page, error
 *   handleInput(q) — debounced; updates query and triggers page-1 fetch
 *   loadMore()    — fetches the next page and appends
 *
 * Stale-request guard: a request id is bumped per fetch; older responses are
 * dropped so a slow page-1 can't overwrite the user's fresher page-2.
 */
export function useCardSearch({ debounceMs = 350, priceSource = 'cardmarket_trend' } = {}) {
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
    const { cards, hasMore: more, error: err } = await searchCards({ query: q, page: p, priceSource })
    if (id !== requestId.current) return
    setPage(p)
    setResults(prev => p === 1 ? cards : [...prev, ...cards])
    setHasMore(more)
    if (err) setError(true)
    setLoading(false)
  }, [priceSource])

  const handleInput = useCallback((q) => {
    const shouldSearch = q.trim().length >= 2
    // A query owns its result list. Clear the previous query immediately and
    // invalidate any in-flight response so stale cards cannot flash back while
    // the new debounced request is waiting to start.
    requestId.current += 1
    setQuery(q)
    setResults([])
    setHasMore(false)
    setPage(1)
    setError(false)
    setLoading(shouldSearch)
    debounce.current(() => {
      if (shouldSearch) search(q, 1)
    })
  }, [search])

  const loadMore = useCallback(() => {
    search(query, page + 1)
  }, [query, page, search])

  return { query, results, loading, hasMore, page, error, handleInput, loadMore }
}
