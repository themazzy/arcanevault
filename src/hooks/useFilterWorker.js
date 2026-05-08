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

// Strip cards down to just the fields the worker actually reads. Avoids
// shipping owned_cards_view's wide rows (image_uri, art_crop_uri, type_line,
// mana_cost, color_identity, etc.) through structuredClone on every post —
// those fields come from sfMap inside the worker anyway. Cuts the postMessage
// payload roughly in half for an 11k-card collection.
const WORKER_CARD_FIELDS = [
  'id', 'name', 'set_code', 'collector_number',
  'foil', 'condition', 'language', 'qty',
  'altered', 'misprint', 'purchase_price', 'currency', 'added_at',
  '_folder_qty', '_folderName', '_sourceFolderId', '_displayKey',
]
function projectCards(cards) {
  if (!cards?.length) return []
  return cards.map(c => {
    const out = {}
    for (const k of WORKER_CARD_FIELDS) if (c[k] !== undefined) out[k] = c[k]
    return out
  })
}

// Off-main-thread filter+sort. Returns the latest worker result.
// Mirrors Collection.jsx's pattern: starts empty until the worker reports back.
export function useFilterWorker({ cards, sfMap, search, sort, filters, priceSource, cardFolderMap }) {
  const [result, setResult] = useState([])
  const reqIdRef = useRef(0)

  const projectedSfMap = useMemo(() => projectSfMap(cards, sfMap), [cards, sfMap])
  const projectedCards = useMemo(() => projectCards(cards), [cards])

  useEffect(() => {
    if (!projectedCards.length) {
      setResult([])
      reqIdRef.current++
      return
    }
    const worker = getWorker()
    const id = ++reqIdRef.current
    const handler = (e) => {
      if (e.data?.id !== id) return
      worker.removeEventListener('message', handler)
      // Worker returns the slimmed shape; remap back to the original card
      // objects (with image_uri etc.) using _displayKey when present —
      // Folders' "All" view repeats a card_id across folders and needs the
      // composite key for uniqueness. Falls back to id for plain pages.
      const cardByKey = new Map(cards.map(c => [c._displayKey || c.id, c]))
      const fullResult = (e.data.result || []).map(r => cardByKey.get(r._displayKey || r.id) || r)
      setResult(fullResult)
    }
    worker.addEventListener('message', handler)
    worker.postMessage({
      id,
      cards: projectedCards,
      sfMap: projectedSfMap,
      search,
      sort,
      filters,
      priceSource: priceSource || 'cardmarket_trend',
      cardFolderMap: cardFolderMap || {},
    })
    return () => worker.removeEventListener('message', handler)
  }, [cards, projectedCards, projectedSfMap, search, sort, filters, priceSource, cardFolderMap])

  return result
}
