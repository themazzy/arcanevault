import { useEffect, useMemo, useRef, useState } from 'react'

// Module-singleton worker — shared across pages. Each consumer scopes by request id.
let _worker = null
function getWorker() {
  if (!_worker) {
    _worker = new Worker(new URL('../lib/filterWorker.js', import.meta.url), { type: 'module' })
  }
  return _worker
}

// Builds a sfMap restricted to the cards present, so we don't ship the entire
// Scryfall cache to the worker on every keystroke.
function projectSfMap(cards, sfMap) {
  if (!cards?.length || !sfMap) return {}
  const out = {}
  for (const c of cards) {
    const key = `${c.set_code}-${c.collector_number}`
    if (sfMap[key]) out[key] = sfMap[key]
  }
  return out
}

// Off-main-thread filter+sort. Returns the latest worker result.
// Mirrors Collection.jsx's pattern: starts empty until the worker reports back.
export function useFilterWorker({ cards, sfMap, search, sort, filters, priceSource, cardFolderMap }) {
  const [result, setResult] = useState([])
  const reqIdRef = useRef(0)

  const projectedSfMap = useMemo(() => projectSfMap(cards, sfMap), [cards, sfMap])

  useEffect(() => {
    if (!cards?.length) {
      setResult([])
      reqIdRef.current++
      return
    }
    const worker = getWorker()
    const id = ++reqIdRef.current
    const handler = (e) => {
      if (e.data?.id !== id) return
      worker.removeEventListener('message', handler)
      setResult(e.data.result || [])
    }
    worker.addEventListener('message', handler)
    worker.postMessage({
      id,
      cards,
      sfMap: projectedSfMap,
      search,
      sort,
      filters,
      priceSource: priceSource || 'cardmarket_trend',
      cardFolderMap: cardFolderMap || {},
    })
    return () => worker.removeEventListener('message', handler)
  }, [cards, projectedSfMap, search, sort, filters, priceSource, cardFolderMap])

  return result
}
