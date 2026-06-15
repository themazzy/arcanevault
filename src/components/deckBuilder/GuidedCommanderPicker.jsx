import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckIcon } from '../../icons'
import { getLocalCards } from '../../lib/db'
import { getInstantCache } from '../../lib/scryfall'
import { searchCommanders } from '../../lib/deckBuilderApi'
import styles from './GuidedCommanderPicker.module.css'

// Commander picker for guided deck creation: lists the user's OWNED commanders
// first (legendary creatures from their collection) and offers a Scryfall search
// to pick any legal commander. Selecting one calls onSelect(sfCard) — a full
// Scryfall card object, the same shape pickCommander() expects.

function isCommanderType(typeLine = '') {
  const t = typeLine.toLowerCase()
  return t.includes('legendary') && t.includes('creature')
}

// Pull a usable type line from a Scryfall card, including the front face of a
// double-faced card (commanders like Kenrith are single-faced, but partners /
// MDFCs can hide the legendary creature on face 0).
function typeLineOf(sf) {
  return sf?.type_line || sf?.card_faces?.[0]?.type_line || ''
}

export function GuidedCommanderPicker({ userId, value, onSelect }) {
  const [owned, setOwned] = useState(null) // null = loading
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef(null)

  // Load owned commanders once.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [cards, cache] = await Promise.all([
          getLocalCards(userId),
          getInstantCache().catch(() => null),
        ])
        const map = cache || {}
        const seen = new Set()
        const list = []
        for (const c of cards || []) {
          const sf = map[c?.scryfall_id]
          if (!sf) continue
          if (!isCommanderType(typeLineOf(sf))) continue
          const key = (sf.name || '').toLowerCase()
          if (!key || seen.has(key)) continue
          seen.add(key)
          list.push(sf)
        }
        list.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        if (!cancelled) setOwned(list)
      } catch {
        if (!cancelled) setOwned([])
      }
    })()
    return () => { cancelled = true }
  }, [userId])

  // Debounced Scryfall commander search.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const q = query.trim()
    if (q.length < 2) { setResults([]); setSearching(false); return }
    setSearching(true)
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await searchCommanders(q)
        setResults(res || [])
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [query])

  const selectedName = (value?.name || '').toLowerCase()
  const q = query.trim()

  // Filter owned by the query too, so typing narrows both lists.
  const filteredOwned = useMemo(() => {
    if (!owned) return null
    if (q.length < 1) return owned
    const lower = q.toLowerCase()
    return owned.filter(sf => (sf.name || '').toLowerCase().includes(lower))
  }, [owned, q])

  const renderItem = sf => {
    const selected = (sf.name || '').toLowerCase() === selectedName
    return (
      <button
        key={sf.id || sf.name}
        type="button"
        className={`${styles.item}${selected ? ' ' + styles.itemSelected : ''}`}
        onClick={() => onSelect(sf)}
      >
        <span className={styles.itemName}>{sf.name}</span>
        <span className={styles.itemMeta}>
          <span className={styles.itemType}>{typeLineOf(sf).replace(/^Legendary Creature — /, '')}</span>
          {selected && <CheckIcon size={13} />}
        </span>
      </button>
    )
  }

  return (
    <div className={styles.picker}>
      <input
        className={styles.search}
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search commanders…"
      />

      {value && (
        <div className={styles.selected}>
          <span>Commander: <strong>{value.name}</strong></span>
        </div>
      )}

      <div className={styles.scroll}>
        {/* Owned commanders */}
        <div className={styles.sectionLabel}>Your commanders</div>
        {filteredOwned === null ? (
          <div className={styles.hint}>Loading your collection…</div>
        ) : filteredOwned.length === 0 ? (
          <div className={styles.hint}>
            {owned?.length ? 'No owned commanders match.' : 'No commanders in your collection yet.'}
          </div>
        ) : (
          <div className={styles.list}>{filteredOwned.map(renderItem)}</div>
        )}

        {/* Scryfall search results (only the not-owned ones, to avoid dupes) */}
        {q.length >= 2 && (
          <>
            <div className={styles.sectionLabel}>All commanders</div>
            {searching ? (
              <div className={styles.hint}>Searching…</div>
            ) : results.length === 0 ? (
              <div className={styles.hint}>No matches.</div>
            ) : (
              <div className={styles.list}>
                {results
                  .filter(sf => !(owned || []).some(o => (o.name || '').toLowerCase() === (sf.name || '').toLowerCase()))
                  .map(renderItem)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
