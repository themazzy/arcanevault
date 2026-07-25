import { useEffect, useRef, useState } from 'react'
import { Modal, SearchInput, ErrorBox } from './UI'
import { SearchIcon } from '../icons'
import { MIN_ART_SEARCH_LENGTH, searchCardArt } from '../lib/cardSearch'
import styles from './CardArtPicker.module.css'

// Background-art picker for binders, wishlists and the profile header.
//
// One implementation replacing three near-identical copies (Folders.jsx,
// Lists.jsx, Profile.jsx) that each hit api.scryfall.com/cards/search directly
// and filtered on `card.image_uris.art_crop` — a field double-faced cards do
// not have, so transform/MDFC cards never showed up at all. Results now come
// from the `search_card_art` RPC over card_prints, which returns both faces of
// a two-sided print and answers an unknown name with an empty list instead of
// the 404 Scryfall logs to the console on every keystroke of a typo.

const DEBOUNCE_MS = 350

export default function CardArtPicker({
  title = 'Choose Card Art Background',
  onSelect,
  onClose,
  limit = 24,
}) {
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  // Scryfall retires printings, and card_prints keeps the row until the next
  // sync notices. Rather than render a broken-image box, drop the tile the
  // moment its art 404s.
  const [deadArt, setDeadArt] = useState(() => new Set())

  const inputRef = useRef(null)
  const timerRef = useRef(null)
  // Responses are versioned so a slow request for an old term can't overwrite
  // the results of a newer one.
  const requestId = useRef(0)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => () => clearTimeout(timerRef.current), [])

  const run = async (term) => {
    const trimmed = (term ?? '').trim()
    if (trimmed.length < MIN_ART_SEARCH_LENGTH) return

    const id = ++requestId.current
    setLoading(true)
    setError('')
    try {
      const found = await searchCardArt(trimmed, { limit })
      if (id !== requestId.current) return
      setResults(found)
      if (!found.length) setError(`No card art matches “${trimmed}”.`)
    } catch {
      if (id !== requestId.current) return
      setResults([])
      setError('Could not load card art. Try again in a moment.')
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }

  const handleChange = (next) => {
    setQuery(next)
    clearTimeout(timerRef.current)
    if (next.trim().length < MIN_ART_SEARCH_LENGTH) {
      requestId.current++
      setResults([])
      setError('')
      setLoading(false)
      return
    }
    timerRef.current = setTimeout(() => run(next), DEBOUNCE_MS)
  }

  const tooShort = query.trim().length > 0 && query.trim().length < MIN_ART_SEARCH_LENGTH
  const visible = results.filter(art => !deadArt.has(art.url))

  return (
    <Modal onClose={onClose}>
      <h2 className={styles.title}>{title}</h2>

      <div className={styles.searchRow}>
        <SearchInput
          ref={inputRef}
          className={styles.input}
          wrapClassName={styles.searchWrap}
          leadingIcon={<SearchIcon size={13} />}
          value={query}
          onChange={e => handleChange(e.target.value)}
          onClear={() => handleChange('')}
          onKeyDown={e => {
            if (e.key === 'Enter') { clearTimeout(timerRef.current); run(query) }
          }}
          placeholder="Search card name…"
          aria-label="Search card art"
        />
        {loading && <span className={styles.loading}>…</span>}
      </div>

      {tooShort && (
        <p className={styles.hint}>Type at least {MIN_ART_SEARCH_LENGTH} characters.</p>
      )}
      {!loading && !tooShort && error && <ErrorBox>{error}</ErrorBox>}

      {visible.length > 0 && (
        <div className={styles.grid}>
          {visible.map(art => (
            <button
              key={art.key}
              type="button"
              className={styles.item}
              onClick={() => onSelect(art.url, art)}
              title={art.artist ? `${art.faceName} — ${art.artist}` : art.faceName}
            >
              <img
                className={styles.img}
                src={art.url}
                alt=""
                loading="lazy"
                onError={() => setDeadArt(prev => new Set(prev).add(art.url))}
              />
              <div className={styles.caption}>
                <span className={styles.name}>{art.faceName}</span>
                {art.isBack && <span className={styles.faceBadge}>Back</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
