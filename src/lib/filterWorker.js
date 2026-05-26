// Runs in a Web Worker — module worker, so ES imports are bundled by Vite.
// Heavy lifting lives in filterCore.js; this file only handles message glue.

import { applyFilterSort } from './filterCore'

// Cached snapshot — set by 'snapshot' messages, reused by snapshot-mode filter messages.
// Legacy inline-cards messages bypass this and run self-contained for backwards
// compatibility with the useFilterWorker hook.
let SNAPSHOT = { cards: [], sfMap: {}, cardFolderMap: {} }

self.onmessage = (e) => {
  const data = e.data
  if (data.type === 'snapshot') {
    SNAPSHOT = {
      cards: data.cards || [],
      sfMap: data.sfMap || {},
      cardFolderMap: data.cardFolderMap || {},
    }
    return
  }
  const { id, search, sort, filters = {}, priceSource = 'cardmarket_trend' } = data
  const inlineMode = !!data.cards
  const cards = inlineMode ? data.cards : SNAPSHOT.cards
  const sfMap = inlineMode ? (data.sfMap || {}) : SNAPSHOT.sfMap
  const cardFolderMap = inlineMode ? (data.cardFolderMap || {}) : SNAPSHOT.cardFolderMap

  const r = applyFilterSort(cards, sfMap, {
    search,
    sort,
    filters,
    cardFolderMap,
    priceSource,
    strictPrice: true,   // Collection uses worker; price filter/sort tracks the selected currency.
    useFolderQty: false, // worker sees raw owned-card rows
  })

  if (inlineMode) {
    self.postMessage({ id, result: r })
  } else {
    const ids = new Array(r.length)
    for (let i = 0; i < r.length; i++) ids[i] = r[i].id
    self.postMessage({ id, ids })
  }
}
