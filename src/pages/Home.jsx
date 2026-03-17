import { useState, useEffect, useRef, useCallback } from 'react'
import styles from './Home.module.css'

// ── Scryfall API helpers ──────────────────────────────────────────────────────
async function fetchRandom() {
  try {
    const res = await fetch('https://api.scryfall.com/cards/random')
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function fetchAutocomplete(q) {
  try {
    const res = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(q)}`)
    if (!res.ok) return []
    return (await res.json()).data || []
  } catch { return [] }
}

async function fetchByName(name) {
  try {
    const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function fetchSearchResults(q) {
  try {
    const res = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=name&unique=cards`)
    if (!res.ok) return []
    return (await res.json()).data || []
  } catch { return [] }
}

async function fetchRulings(card) {
  try {
    const url = card.rulings_uri || `https://api.scryfall.com/cards/${card.set}/${card.collector_number}/rulings`
    const res = await fetch(url)
    if (!res.ok) return []
    return (await res.json()).data || []
  } catch { return [] }
}

// ── Commander Spellbook API ───────────────────────────────────────────────────
async function fetchRandomCombo() {
  try {
    const r1 = await fetch('https://backend.commanderspellbook.com/variants/?limit=1')
    if (!r1.ok) return null
    const { count } = await r1.json()
    if (!count) return null
    const offset = Math.floor(Math.random() * Math.min(count, 4000))
    const r2 = await fetch(`https://backend.commanderspellbook.com/variants/?limit=1&offset=${offset}`)
    if (!r2.ok) return null
    const { results } = await r2.json()
    return results?.[0] || null
  } catch { return null }
}

// ── Mana symbol renderer (Scryfall SVGs) ─────────────────────────────────────
function ManaSymbol({ sym, size = 18 }) {
  const key = sym.replace(/\//g, '').toUpperCase()
  return (
    <img
      src={`https://svgs.scryfall.io/card-symbols/${key}.svg`}
      alt={`{${sym}}`}
      style={{ width: size, height: size, verticalAlign: 'middle', display: 'inline-block', flexShrink: 0 }}
    />
  )
}

function ManaCost({ cost, size = 18 }) {
  if (!cost) return null
  const syms = [...cost.matchAll(/\{([^}]+)\}/g)].map(m => m[1])
  return <span className={styles.manaCostRow}>{syms.map((s, i) => <ManaSymbol key={i} sym={s} size={size} />)}</span>
}

// Render a text string with {SYM} tokens replaced by inline SVG images
function renderWithSymbols(text, symSize = 16) {
  if (!text) return null
  return text.split(/(\{[^}]+\})/g).map((part, i) => {
    const m = part.match(/^\{([^}]+)\}$/)
    if (m) {
      const key = m[1].replace(/\//g, '').toUpperCase()
      return (
        <img key={i}
          src={`https://svgs.scryfall.io/card-symbols/${key}.svg`}
          alt={part}
          style={{ width: symSize, height: symSize, verticalAlign: 'middle', display: 'inline-block', margin: '0 1px' }}
        />
      )
    }
    return part
  })
}

function OracleText({ text }) {
  if (!text) return <p className={styles.oracleEmpty}>No oracle text.</p>
  return (
    <>
      {text.split('\n').map((line, i) => (
        <p key={i} className={styles.oracleLine}>{renderWithSymbols(line)}</p>
      ))}
    </>
  )
}

function getCardImage(card, size = 'normal', face = 0) {
  if (!card) return null
  if (card.card_faces?.[face]?.image_uris) return card.card_faces[face].image_uris[size] || card.card_faces[face].image_uris.normal
  return card.image_uris?.[size] || card.image_uris?.normal || null
}

function rarityColor(r) {
  return r === 'mythic' ? '#e8942a' : r === 'rare' ? '#c0a060' : r === 'uncommon' ? '#9ab4cc' : 'var(--text-faint)'
}

// ── Card Detail View ──────────────────────────────────────────────────────────
function CardView({ card, onClose, badge }) {
  const [tab, setTab]         = useState('rules')
  const [face, setFace]       = useState(0)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [rulings, setRulings] = useState(null)  // null = not loaded yet

  const hasFaces = card.card_faces?.length > 1

  useEffect(() => {
    setTab('rules'); setFace(0); setImgLoaded(false); setRulings(null)
  }, [card.id])

  useEffect(() => {
    if (tab === 'rulings' && rulings === null) {
      fetchRulings(card).then(setRulings)
    }
  }, [tab, card, rulings])

  const img        = getCardImage(card, 'normal', face)
  const displayFace = hasFaces ? (card.card_faces[face] || card) : card
  const oracle     = displayFace.oracle_text || card.oracle_text || ''
  const flavor     = displayFace.flavor_text || card.flavor_text || ''
  const typeLine   = displayFace.type_line   || card.type_line   || ''
  const manaCost   = displayFace.mana_cost   || card.mana_cost   || ''
  const power      = displayFace.power       ?? card.power
  const toughness  = displayFace.toughness   ?? card.toughness
  const loyalty    = displayFace.loyalty     ?? card.loyalty

  const prices = card.prices || {}

  return (
    <div className={styles.cardView}>
      {onClose && <button className={styles.cvClose} onClick={onClose}>✕</button>}
      {badge && <div className={styles.cvBadge}>{badge}</div>}

      <div className={styles.cvLayout}>
        {/* ── Left: Art ── */}
        <div className={styles.cvArtCol}>
          <div className={styles.cvArtWrap}>
            {img
              ? <img src={img} alt={card.name} className={`${styles.cvImg} ${imgLoaded ? styles.cvImgVisible : ''}`} onLoad={() => setImgLoaded(true)} />
              : <div className={styles.cvImgPlaceholder}>{card.name}</div>
            }
          </div>
          {hasFaces && (
            <button className={styles.cvFlipBtn} onClick={() => setFace(f => 1 - f)}>↺ Flip</button>
          )}
          <div className={styles.cvArtCaption}>
            <span style={{ color: rarityColor(card.rarity) }}>
              {card.rarity ? card.rarity.charAt(0).toUpperCase() + card.rarity.slice(1) : ''}
            </span>
            <span>{card.set_name}</span>
            <span style={{ color: 'var(--text-faint)' }}>#{card.collector_number}</span>
          </div>
        </div>

        {/* ── Right: Details ── */}
        <div className={styles.cvBody}>
          {/* Header */}
          <div className={styles.cvHeader}>
            <div className={styles.cvName}>{displayFace.name || card.name}</div>
            <ManaCost cost={manaCost} size={18} />
          </div>
          <div className={styles.cvType}>{typeLine}</div>
          {(power != null || loyalty != null) && (
            <div className={styles.cvStats}>
              {power != null && <span className={styles.cvStatBadge}>{power}/{toughness}</span>}
              {loyalty != null && <span className={styles.cvStatBadge}>◆ {loyalty}</span>}
            </div>
          )}

          {/* Tab bar */}
          <div className={styles.tabBar}>
            {['rules', 'prices', 'legality', 'rulings'].map(t => (
              <button key={t} className={`${styles.tabBtn} ${tab === t ? styles.tabActive : ''}`} onClick={() => setTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {/* ── Rules Text ── */}
          {tab === 'rules' && (
            <div className={styles.tabContent}>
              <div className={styles.oracleBox}>
                <OracleText text={oracle} />
              </div>
              {flavor && <div className={styles.flavorText}>{renderWithSymbols(flavor)}</div>}
              {card.artist && (
                <div className={styles.artistLine}>Illustrated by <em>{card.artist}</em></div>
              )}
              <a href={card.scryfall_uri} target="_blank" rel="noopener noreferrer" className={styles.scryfallLink}>
                View on Scryfall ↗
              </a>
            </div>
          )}

          {/* ── Prices ── */}
          {tab === 'prices' && (
            <div className={styles.tabContent}>
              <div className={styles.pricesGrid}>
                {[
                  { label: 'EUR (Non-foil)',  val: prices.eur,       foil: false },
                  { label: 'EUR (Foil)',      val: prices.eur_foil,  foil: true },
                  { label: 'USD (Non-foil)',  val: prices.usd,       foil: false },
                  { label: 'USD (Foil)',      val: prices.usd_foil,  foil: true },
                  { label: 'USD (Etched)',    val: prices.usd_etched,foil: true },
                  { label: 'MTGO (tix)',      val: prices.tix,       tix: true  },
                ].filter(p => p.val && parseFloat(p.val) > 0).map(p => (
                  <div key={p.label} className={styles.priceBlock}>
                    <div className={styles.priceLabel}>{p.label}</div>
                    <div className={styles.priceVal} style={{ color: p.tix ? 'var(--text-dim)' : p.foil ? 'var(--purple)' : 'var(--green)' }}>
                      {p.tix ? `${parseFloat(p.val).toFixed(2)} tix` : p.label.includes('EUR') ? `€${parseFloat(p.val).toFixed(2)}` : `$${parseFloat(p.val).toFixed(2)}`}
                    </div>
                  </div>
                ))}
              </div>
              {card.purchase_uris?.tcgplayer && (
                <a href={card.purchase_uris.tcgplayer} target="_blank" rel="noopener noreferrer" className={styles.scryfallLink} style={{ marginTop: 12 }}>
                  Buy on TCGPlayer ↗
                </a>
              )}
              {card.purchase_uris?.cardmarket && (
                <a href={card.purchase_uris.cardmarket} target="_blank" rel="noopener noreferrer" className={styles.scryfallLink} style={{ marginTop: 8 }}>
                  Buy on Cardmarket ↗
                </a>
              )}
            </div>
          )}

          {/* ── Legality ── */}
          {tab === 'legality' && (
            <div className={styles.tabContent}>
              <div className={styles.legalGrid}>
                {[
                  ['standard','Standard'],['pioneer','Pioneer'],['explorer','Explorer'],
                  ['modern','Modern'],['legacy','Legacy'],['vintage','Vintage'],
                  ['commander','Commander'],['oathbreaker','Oathbreaker'],
                  ['pauper','Pauper'],['penny','Penny Dreadful'],['historic','Historic'],
                  ['alchemy','Alchemy'],
                ].map(([fmt, label]) => {
                  const status = card.legalities?.[fmt]
                  if (!status || status === 'not_legal') return null
                  const color = status === 'legal' ? '#4a9a5a' : status === 'restricted' ? '#c9a84c' : '#7a4a4a'
                  const bg    = status === 'legal' ? 'rgba(74,154,90,0.1)' : status === 'restricted' ? 'rgba(201,168,76,0.1)' : 'rgba(200,80,80,0.08)'
                  return (
                    <div key={fmt} className={styles.legalRow} style={{ background: bg, borderColor: color + '55' }}>
                      <span>{label}</span>
                      <span style={{ color }}>
                        {status === 'legal' ? '✓ Legal' : status === 'restricted' ? '⚠ Restricted' : '✕ Banned'}
                      </span>
                    </div>
                  )
                }).filter(Boolean)}
              </div>
            </div>
          )}

          {/* ── Rulings ── */}
          {tab === 'rulings' && (
            <div className={styles.tabContent}>
              {rulings === null
                ? <p className={styles.oracleEmpty}>Loading rulings…</p>
                : rulings.length === 0
                  ? <p className={styles.oracleEmpty}>No rulings on record.</p>
                  : <div className={styles.rulingsList}>
                      {rulings.map((r, i) => (
                        <div key={i} className={styles.rulingItem}>
                          <span className={styles.rulingDate}>{r.published_at}</span>
                          <span className={styles.rulingText}>{r.comment}</span>
                        </div>
                      ))}
                    </div>
              }
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Search Results Grid ───────────────────────────────────────────────────────
function SearchResultGrid({ results, onSelect }) {
  return (
    <div className={styles.resultsGrid}>
      {results.slice(0, 32).map(card => (
        <div key={card.id} className={styles.resultCard} onClick={() => onSelect(card)}>
          {getCardImage(card, 'small')
            ? <img src={getCardImage(card, 'small')} alt={card.name} className={styles.resultImg} loading="lazy" />
            : <div className={styles.resultImgPlaceholder}>{card.name}</div>
          }
          <div className={styles.resultName}>{card.name}</div>
          <div className={styles.resultSet}>{card.set_name}</div>
          {card.prices?.eur && (
            <div className={styles.resultPrice}>€{parseFloat(card.prices.eur).toFixed(2)}</div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Card Lookup Section ───────────────────────────────────────────────────────
function CardLookupSection() {
  const [query, setQuery]       = useState('')
  const [suggestions, setSuggs] = useState([])
  const [showSuggs, setShowSuggs] = useState(false)
  const [card, setCard]         = useState(null)
  const [results, setResults]   = useState([])
  const [mode, setMode]         = useState('idle') // idle | card | results
  const [loading, setLoading]   = useState(false)
  const debounce = useRef(null)

  const handleInput = e => {
    const v = e.target.value
    setQuery(v)
    clearTimeout(debounce.current)
    if (v.length < 2) { setSuggs([]); setShowSuggs(false); return }
    debounce.current = setTimeout(async () => {
      const r = await fetchAutocomplete(v)
      setSuggs(r.slice(0, 10)); setShowSuggs(r.length > 0)
    }, 200)
  }

  const pickSuggestion = async name => {
    setQuery(name); setShowSuggs(false); setSuggs([])
    setLoading(true); setMode('idle')
    const c = await fetchByName(name)
    setCard(c); setResults([]); setMode(c ? 'card' : 'idle')
    setLoading(false)
  }

  const handleSearch = async e => {
    e.preventDefault()
    if (!query.trim()) return
    setShowSuggs(false); setCard(null); setLoading(true); setMode('idle')
    // Try exact name first
    const exact = await fetchByName(query.trim())
    if (exact) { setCard(exact); setMode('card'); setLoading(false); return }
    // Fall back to search
    const r = await fetchSearchResults(query.trim())
    setResults(r); setMode('results'); setLoading(false)
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>⊛ Card Lookup</h2>
        {mode !== 'idle' && (
          <button className={styles.clearBtn} onClick={() => { setCard(null); setResults([]); setMode('idle'); setQuery('') }}>
            Clear
          </button>
        )}
      </div>
      <p className={styles.sectionDesc}>Search any Magic card — browse art, oracle text, prices and rulings.</p>

      <form className={styles.searchForm} onSubmit={handleSearch}>
        <div className={styles.searchWrap}>
          <input
            className={styles.searchInput}
            placeholder="Card name or search query…"
            value={query}
            onChange={handleInput}
            onFocus={() => suggestions.length && setShowSuggs(true)}
            onBlur={() => setTimeout(() => setShowSuggs(false), 160)}
            autoComplete="off"
          />
          {showSuggs && (
            <ul className={styles.suggList}>
              {suggestions.map(n => (
                <li key={n} className={styles.suggItem} onMouseDown={() => pickSuggestion(n)}>{n}</li>
              ))}
            </ul>
          )}
        </div>
        <button className={styles.searchBtn} type="submit" disabled={loading || !query.trim()}>
          {loading ? '…' : 'Search'}
        </button>
      </form>

      {loading && <div className={styles.loadingMsg}>Searching Scryfall…</div>}

      {!loading && mode === 'card' && card && (
        <CardView card={card} onClose={() => { setCard(null); setMode('idle') }} />
      )}

      {!loading && mode === 'results' && (
        <>
          {results.length === 0
            ? <div className={styles.emptyMsg}>No cards found for "{query}".</div>
            : <>
                <div className={styles.resultsHeader}>{results.length} result{results.length !== 1 ? 's' : ''} for "{query}" — click a card for details</div>
                <SearchResultGrid results={results} onSelect={c => { setCard(c); setMode('card') }} />
              </>
          }
        </>
      )}
    </section>
  )
}

// ── Random Card Section ───────────────────────────────────────────────────────
function RandomCardSection() {
  const [card, setCard]     = useState(null)
  const [loading, setLoading] = useState(true)

  const roll = useCallback(async () => {
    setLoading(true); setCard(null)
    const c = await fetchRandom()
    setCard(c); setLoading(false)
  }, [])

  useEffect(() => { roll() }, [roll])

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>🎲 Random Card</h2>
        <button className={styles.rerollBtn} onClick={roll} disabled={loading}>
          {loading ? 'Rolling…' : '⟳ Reroll'}
        </button>
      </div>
      {loading ? (
        <div className={styles.skeletonLayout}>
          <div className={styles.skeletonImg} />
          <div className={styles.skeletonBody} />
        </div>
      ) : card ? (
        <CardView card={card} badge="✦ Random" />
      ) : (
        <div className={styles.emptyMsg}>Failed to load card.</div>
      )}
    </section>
  )
}

// ── Commander Combo Section ───────────────────────────────────────────────────
const BRACKET_LABELS = { 1: 'Casual', 2: 'Focused', 3: 'Optimized', 4: 'Competitive' }
const BRACKET_COLORS = { 1: '#6a9a6a', 2: '#5a90bb', 3: '#c9a84c', 4: '#cc5555' }

function ComboSection() {
  const [combo, setCombo]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]       = useState(false)

  const roll = useCallback(async () => {
    setLoading(true); setCombo(null); setErr(false)
    const c = await fetchRandomCombo()
    if (c) { setCombo(c); setErr(false) }
    else setErr(true)
    setLoading(false)
  }, [])

  useEffect(() => { roll() }, [roll])

  // Parse combo data
  const cards    = combo?.uses?.map(u => u.card?.name || u.template?.name || '?') || []
  const produces = combo?.produces?.map(p => p.feature?.name || '?') || []
  const description = combo?.description || combo?.notes || ''
  const bracket  = combo?.bracketTag

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>⚡ Commander Combo</h2>
        <button className={styles.rerollBtn} onClick={roll} disabled={loading}>
          {loading ? 'Loading…' : '⟳ New Combo'}
        </button>
      </div>
      <p className={styles.sectionDesc}>A random infinite combo from Commander Spellbook.</p>

      {loading && <div className={styles.loadingMsg}>Fetching combo…</div>}
      {err && <div className={styles.emptyMsg}>Could not load combo. Check your connection.</div>}

      {!loading && combo && (
        <div className={styles.comboCard}>
          <div className={styles.comboRow}>
            <div className={styles.comboCol}>
              <div className={styles.comboColTitle}>Cards Needed</div>
              <ul className={styles.comboCardList}>
                {cards.map((name, i) => (
                  <li key={i} className={styles.comboCardItem}>
                    <span className={styles.comboDot}>▸</span>
                    <a
                      href={`https://scryfall.com/search?q=!${encodeURIComponent(name)}`}
                      target="_blank" rel="noopener noreferrer"
                      className={styles.comboCardLink}
                    >
                      {name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div className={styles.comboCol}>
              <div className={styles.comboColTitle}>Produces</div>
              <ul className={styles.comboProduceList}>
                {produces.map((p, i) => (
                  <li key={i} className={styles.comboProduce}>
                    <span style={{ color: 'var(--gold)' }}>⚡</span> {p}
                  </li>
                ))}
              </ul>
              {bracket && (
                <div className={styles.comboBracket} style={{ borderColor: (BRACKET_COLORS[bracket] || '#888') + '55', color: BRACKET_COLORS[bracket] || '#888' }}>
                  Bracket {bracket} — {BRACKET_LABELS[bracket]}
                </div>
              )}
            </div>
          </div>

          {description && (
            <div className={styles.comboDesc}>
              <div className={styles.comboDescTitle}>How it works</div>
              <p>{description}</p>
            </div>
          )}

          <a
            href={`https://commanderspellbook.com/combo/${combo.id}/`}
            target="_blank" rel="noopener noreferrer"
            className={styles.scryfallLink}
          >
            View on Commander Spellbook ↗
          </a>
        </div>
      )}
    </section>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function HomePage() {
  return (
    <div className={styles.home}>
      <div className={styles.hero}>
        <div className={styles.heroTitle}>ARCANE<span>VAULT</span></div>
        <div className={styles.heroSub}>Your Magic: The Gathering collection manager</div>
      </div>
      <CardLookupSection />
      <RandomCardSection />
      <ComboSection />
    </div>
  )
}
