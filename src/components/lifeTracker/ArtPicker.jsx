import { useEffect, useRef, useState } from 'react'
import { ErrorBox, SearchInput } from '../UI'
import { SearchIcon } from '../../icons'
import { sfGet } from '../../lib/scryfall'
import c from './controls.module.css'

// Card-art search for seat backgrounds.
//
// One implementation, used by the seat sheet and the guest join page. The previous
// version of this existed three times (LifeTracker's ArtPicker, HostSetupScreen's
// inline copy, and JoinGame's inline copy), each calling api.scryfall.com with a
// raw fetch — no shared cache, no rate limiting, and no guard against a slow
// response for an old query landing after a newer one.
//
// Per CLAUDE.md, name search is served from our own tables, but `unique=art` is
// explicitly one of the queries that stays on Scryfall. It goes through sfGet so it
// inherits the shared 100ms throttle, retry/backoff and Accept header.

const DEBOUNCE_MS = 350
const MAX_RESULTS = 24

function artCropOf(card) {
  return card?.image_uris?.art_crop
    // Double-faced cards carry images per face, not at the top level.
    || card?.card_faces?.[0]?.image_uris?.art_crop
    || null
}

export default function ArtPicker({ value, onSelect, autoFocus = false }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const timer = useRef(null)
  // sfGet has no abort support, so requests are versioned instead: a response is
  // only applied if no newer search has started since it was issued.
  const requestId = useRef(0)

  useEffect(() => () => clearTimeout(timer.current), [])

  const run = async (term) => {
    const trimmed = term.trim()
    if (trimmed.length < 2) { setResults([]); setLoading(false); return }

    const id = ++requestId.current
    setLoading(true)
    setError('')

    const data = await sfGet(
      `/cards/search?q=${encodeURIComponent(trimmed)}&unique=art&order=name`,
    )
    if (id !== requestId.current) return

    setLoading(false)
    if (!data) { setError('Could not reach Scryfall. Try again.'); setResults([]); return }

    const found = (data.data || [])
      .filter(card => artCropOf(card))
      .slice(0, MAX_RESULTS)
    setResults(found)
    if (found.length === 0) setError(`No card art matches "${trimmed}".`)
  }

  const handleChange = (next) => {
    setQuery(next)
    clearTimeout(timer.current)
    if (next.trim().length < 2) {
      requestId.current++
      setResults([])
      setError('')
      setLoading(false)
      return
    }
    timer.current = setTimeout(() => run(next), DEBOUNCE_MS)
  }

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

      {loading && <p className={c.hint}>Searching…</p>}
      {!loading && error && <ErrorBox>{error}</ErrorBox>}

      {results.length > 0 && (
        <div className={c.artGrid}>
          {results.map(card => {
            const url = artCropOf(card)
            return (
              <button
                key={card.id}
                type="button"
                className={c.artOption}
                data-active={value === url ? 'true' : undefined}
                onClick={() => onSelect(url, card)}
                aria-label={`Use art from ${card.name}`}
              >
                <img src={url} alt="" loading="lazy" />
                <span className={c.artName}>{card.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
