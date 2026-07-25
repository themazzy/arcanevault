import { useEffect, useRef, useState } from 'react'
import { ErrorBox, SearchInput } from '../UI'
import { SearchIcon } from '../../icons'
import { MIN_ART_SEARCH_LENGTH, searchCardArt } from '../../lib/cardSearch'
import c from './controls.module.css'

// Card-art search for seat backgrounds.
//
// One implementation, used by the seat sheet and the guest join page. The previous
// version of this existed three times (LifeTracker's ArtPicker, HostSetupScreen's
// inline copy, and JoinGame's inline copy), each calling api.scryfall.com with a
// raw fetch — no shared cache, no rate limiting, and no guard against a slow
// response for an old query landing after a newer one.
//
// Results come from the `search_card_art` RPC over card_prints — the same source
// as the binder/wishlist/profile background pickers. Scryfall's `unique=art`
// search answered 404 for a name that matched nothing, which the browser logged
// as a failed request on every keystroke of a typo, and its per-face image_uris
// meant each caller had to unpack double-faced cards itself. The RPC returns the
// back face of a two-sided print as its own selectable artwork.

const DEBOUNCE_MS = 350
const MAX_RESULTS = 24

export default function ArtPicker({ value, onSelect, autoFocus = false }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Scryfall retires printings and card_prints keeps the row until the next sync
  // notices; drop a tile whose art 404s instead of rendering a broken image.
  const [deadArt, setDeadArt] = useState(() => new Set())

  const timer = useRef(null)
  // Requests are versioned: a response is only applied if no newer search has
  // started since it was issued.
  const requestId = useRef(0)

  useEffect(() => () => clearTimeout(timer.current), [])

  const run = async (term) => {
    const trimmed = term.trim()
    if (trimmed.length < MIN_ART_SEARCH_LENGTH) { setResults([]); setLoading(false); return }

    const id = ++requestId.current
    setLoading(true)
    setError('')

    try {
      const found = await searchCardArt(trimmed, { limit: MAX_RESULTS })
      if (id !== requestId.current) return
      setLoading(false)
      setResults(found)
      if (found.length === 0) setError(`No card art matches "${trimmed}".`)
    } catch {
      if (id !== requestId.current) return
      setLoading(false)
      setResults([])
      setError('Could not load card art. Try again.')
    }
  }

  const handleChange = (next) => {
    setQuery(next)
    clearTimeout(timer.current)
    if (next.trim().length < MIN_ART_SEARCH_LENGTH) {
      requestId.current++
      setResults([])
      setError('')
      setLoading(false)
      return
    }
    timer.current = setTimeout(() => run(next), DEBOUNCE_MS)
  }

  const tooShort = query.trim().length > 0 && query.trim().length < MIN_ART_SEARCH_LENGTH
  const visible = results.filter(art => !deadArt.has(art.url))

  return (
    <div className={c.field}>
      {/* SearchInput styles only its wrapper and clear button — the input itself
          carries whatever className the caller passes, so omitting it renders a
          bare browser input. */}
      <SearchInput
        className={c.textInput}
        leadingIcon={<SearchIcon size={13} />}
        value={query}
        onChange={e => handleChange(e.target.value)}
        onClear={() => handleChange('')}
        onKeyDown={e => {
          if (e.key === 'Enter') { clearTimeout(timer.current); run(query) }
        }}
        placeholder="Search card art…"
        aria-label="Search card art"
        autoFocus={autoFocus}
      />

      {tooShort && <p className={c.hint}>Type at least {MIN_ART_SEARCH_LENGTH} characters.</p>}
      {loading && !tooShort && <p className={c.hint}>Searching…</p>}
      {!loading && !tooShort && error && <ErrorBox>{error}</ErrorBox>}

      {visible.length > 0 && (
        <div className={c.artGrid}>
          {visible.map(art => (
            <button
              key={art.key}
              type="button"
              className={c.artOption}
              data-active={value === art.url ? 'true' : undefined}
              onClick={() => onSelect(art.url, art)}
              aria-label={`Use art from ${art.faceName}`}
            >
              <img
                src={art.url}
                alt=""
                loading="lazy"
                onError={() => setDeadArt(prev => new Set(prev).add(art.url))}
              />
              <span className={c.artName}>{art.faceName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
