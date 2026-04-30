import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useParams, Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { useSettings, DEFAULT_BENTO_CONFIG } from '../components/SettingsContext'
import { sfGet } from '../lib/scryfall'
import { Modal } from '../components/UI'
import { ImageIcon } from '../icons'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import styles from './Profile.module.css'

// ── Constants ─────────────────────────────────────────────────────────────────
const ACCENT_PALETTE = [
  '#c9a84c', '#e8c96a', '#e07840', '#e05c5c', '#c44569',
  '#9b59b6', '#6c5ce7', '#4a90d9', '#00b4d8', '#2ecc71',
  '#27ae60', '#a8e6cf', '#f9ca24', '#e84393', '#fd79a8',
  '#b2bec3', '#636e72', '#dfe6e9', '#2d3436', '#00cec9',
]

const MANA_COLORS = [
  { key: 'W', label: 'White',     color: '#e8e4d0', symbol: 'W' },
  { key: 'U', label: 'Blue',      color: '#4a90d9', symbol: 'U' },
  { key: 'B', label: 'Black',     color: '#8a7ca8', symbol: 'B' },
  { key: 'R', label: 'Red',       color: '#e05c5c', symbol: 'R' },
  { key: 'G', label: 'Green',     color: '#5dba70', symbol: 'G' },
  { key: 'C', label: 'Colorless', color: '#9ba8b0', symbol: 'C' },
]

const RARITY_DEFS = [
  { key: 'common',   label: 'Common',   color: '#9ba8b0' },
  { key: 'uncommon', label: 'Uncommon', color: '#7ab8e8' },
  { key: 'rare',     label: 'Rare',     color: '#c9a84c' },
  { key: 'mythic',   label: 'Mythic',   color: '#e87040' },
]

const FORMAT_LABEL = {
  standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern', legacy: 'Legacy',
  vintage: 'Vintage', commander: 'Commander', pauper: 'Pauper', historic: 'Historic',
  explorer: 'Explorer', alchemy: 'Alchemy', brawl: 'Brawl', oathbreaker: 'Oathbreaker',
}
const FORMAT_COLORS = {
  standard: '#4a90d9', pioneer: '#9b59b6', modern: '#2ecc71', legacy: '#e07840',
  vintage: '#c9a84c', commander: '#e05c5c', pauper: '#9ba8b0', historic: '#00cec9',
  explorer: '#6c5ce7', alchemy: '#fd79a8', brawl: '#e84393', oathbreaker: '#a8e6cf',
}

const MILESTONES = [
  { id: 'first_card',   label: 'First Card',   icon: '🃏', req: '1 card',         desc: 'Added your first card to the vault',           check: (s)    => (s?.total_cards       ?? 0) >= 1    },
  { id: 'collector',    label: 'Collector',    icon: '📦', req: '100 cards',      desc: 'Built a collection of 100 cards',              check: (s)    => (s?.total_cards       ?? 0) >= 100  },
  { id: 'dedicated',    label: 'Dedicated',    icon: '⚔️', req: '500 cards',      desc: 'Committed with 500 cards in the vault',        check: (s)    => (s?.total_cards       ?? 0) >= 500  },
  { id: 'obsessed',     label: 'Obsessed',     icon: '🔮', req: '1,000 cards',    desc: 'Reached the 1,000 card milestone',             check: (s)    => (s?.total_cards       ?? 0) >= 1000 },
  { id: 'legendary',    label: 'Legendary',    icon: '👑', req: '5,000 cards',    desc: 'An extraordinary vault of 5,000 cards',        check: (s)    => (s?.total_cards       ?? 0) >= 5000 },
  { id: 'first_foil',   label: 'First Foil',   icon: '✨', req: '1 foil',         desc: 'Added your first foil card',                   check: (s)    => (s?.foil_count        ?? 0) >= 1    },
  { id: 'shiny_hunter', label: 'Shiny Hunter', icon: '💎', req: '50 foils',       desc: 'Assembled a shimmer of 50 foil cards',         check: (s)    => (s?.foil_count        ?? 0) >= 50   },
  { id: 'deck_builder', label: 'Deck Builder', icon: '🏗️', req: '1 public deck',  desc: 'Shared your first deck with the community',    check: (_, p) => (p?.public_deck_count ?? 0) >= 1    },
  { id: 'architect',    label: 'Architect',    icon: '🗺️', req: '5 public decks', desc: 'Shared 5 decks with the community',            check: (_, p) => (p?.public_deck_count ?? 0) >= 5    },
  { id: 'valuable',     label: 'Valuable',     icon: '💰', req: '€100 value',     desc: 'Collection estimated value exceeds €100',      check: (_, p) => (p?.collection_value  ?? 0) >= 100  },
  { id: 'investor',     label: 'Investor',     icon: '📈', req: '€500 value',     desc: 'Collection estimated value exceeds €500',      check: (_, p) => (p?.collection_value  ?? 0) >= 500  },
]

// ── Block metadata ────────────────────────────────────────────────────────────
const BLOCK_DEFS = {
  bio:           { label: 'Text Block',       span: 'full'  },
  total:         { label: 'Total Cards',      span: 'third' },
  unique:        { label: 'Unique Prints',    span: 'third' },
  foils:         { label: 'Foil Count',       span: 'third' },
  sets:          { label: 'Sets Collected',   span: 'third' },
  since:         { label: 'Member Since',     span: 'third' },
  value:         { label: 'Est. Value',       span: 'third' },
  deck_count:    { label: 'Public Decks',     span: 'third' },
  winrate:       { label: 'Win Rate',         span: 'third' },
  fav_format:    { label: 'Most Played',      span: 'third' },
  color_pie:     { label: 'Color Pie',        span: 'half'  },
  rarity:        { label: 'Rarity Breakdown', span: 'half'  },
  formats:       { label: 'Formats Played',   span: 'half'  },
  fav_commander: { label: 'Fav. Commander',   span: 'half'  },
  crown:         { label: 'Crown Jewel',      span: 'third' },
  top_cards:     { label: 'Top Cards',        span: 'full'  },
  milestones:    { label: 'Milestones',       span: 'full'  },
  featured_deck: { label: 'Featured Deck',    span: 'full'  },
  recent_cards:  { label: 'Recently Added',   span: 'full'  },
  decks:         { label: 'Deck Showcase',    span: 'full'  },
}

const GRID_DROP_ID = 'drop-grid'
const TRAY_DROP_ID = 'drop-tray'
const noDisplace   = () => null

function mergeBlocks(configBlocks) {
  const allIds     = Object.keys(BLOCK_DEFS)
  const existing   = configBlocks || []
  const existingIds = existing.map(b => b.id)
  return [
    ...existing.filter(b => allIds.includes(b.id)),
    ...allIds.filter(id => !existingIds.includes(id)).map(id => ({ id, enabled: false })),
  ]
}

function fmtNum(val) {
  return val != null && typeof val === 'number' ? val.toLocaleString() : '—'
}

function spanClass(id) {
  const span = BLOCK_DEFS[id]?.span
  if (span === 'full')  return styles.blockFull
  if (span === 'half')  return styles.blockHalf
  if (span === 'third') return styles.blockThird
  return styles.blockThird
}

const MANA_SYMBOL_URL = c => `https://svgs.scryfall.io/card-symbols/${c}.svg`

// ── Card art picker (header background) ──────────────────────────────────────
function CardArtPicker({ onSelect, onClose }) {
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)
  const timerRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => () => clearTimeout(timerRef.current), [])

  const search = async (q) => {
    const term = (q ?? query).trim()
    if (!term) return
    setLoading(true)
    try {
      const data = await sfGet(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(term)}&unique=art&order=name`)
      setResults((data?.data || []).filter(c => c.image_uris?.art_crop).slice(0, 24))
    } catch { setResults([]) }
    setLoading(false)
  }

  const handleChange = v => {
    setQuery(v)
    clearTimeout(timerRef.current)
    if (v.trim().length < 2) { setResults([]); return }
    timerRef.current = setTimeout(() => search(v), 350)
  }

  return (
    <Modal onClose={onClose}>
      <h2 className={styles.artPickerTitle}>Choose Header Background Art</h2>
      <div className={styles.artPickerSearch}>
        <input ref={inputRef} className={styles.artPickerInput} value={query}
          onChange={e => handleChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { clearTimeout(timerRef.current); search() } }}
          placeholder="Search card name…" />
        {loading && <span className={styles.artPickerLoading}>…</span>}
      </div>
      {results.length > 0 && (
        <div className={styles.artPickerGrid}>
          {results.map(card => (
            <button key={card.id} className={styles.artPickerItem}
              onClick={() => onSelect(card.image_uris.art_crop)} title={card.name}>
              <img src={card.image_uris.art_crop} alt={card.name} className={styles.artPickerImg} />
              <div className={styles.artPickerName}>{card.name}</div>
            </button>
          ))}
        </div>
      )}
      {!loading && results.length === 0 && query.trim().length >= 2 && (
        <p className={styles.artPickerEmpty}>No results. Try a different card name.</p>
      )}
    </Modal>
  )
}

// ── Standout card picker (featured deck) ─────────────────────────────────────
function StandoutCardPicker({ deck, selected, onAdd, onRemove, onClose }) {
  const [cards, setCards]     = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!deck) return
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        let rows = []
        if (deck.type === 'builder_deck') {
          const { data } = await sb.from('deck_cards_view').select('scryfall_id,name').eq('deck_id', deck.id)
          rows = data || []
        } else {
          const { data } = await sb.from('deck_allocations_view').select('scryfall_id,name').eq('deck_id', deck.id)
          rows = data || []
        }

        const seen   = new Set()
        const unique = rows.filter(r => {
          if (!r.scryfall_id || seen.has(r.scryfall_id)) return false
          seen.add(r.scryfall_id)
          return true
        })

        if (!unique.length) { if (!cancelled) setCards([]); return }

        const ids = unique.map(r => r.scryfall_id)
        const { data: priceRows } = await sb.from('card_prices')
          .select('scryfall_id,price_eur,price_usd')
          .in('scryfall_id', ids)
          .order('snapshot_date', { ascending: false })

        const priceMap = {}
        for (const p of (priceRows || [])) {
          if (!priceMap[p.scryfall_id]) priceMap[p.scryfall_id] = p.price_eur ?? p.price_usd ?? 0
        }

        const result = unique.map(r => ({
          scryfall_id: r.scryfall_id,
          name:        r.name,
          art_crop:    `https://cards.scryfall.io/art_crop/front/${r.scryfall_id[0]}/${r.scryfall_id[1]}/${r.scryfall_id}.jpg`,
          price:       priceMap[r.scryfall_id] ?? 0,
        })).sort((a, b) => b.price - a.price)

        if (!cancelled) setCards(result)
      } catch { if (!cancelled) setCards([]) }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [deck?.id, deck?.type])

  const isSelected = card => selected.some(s => s.scryfall_id
    ? s.scryfall_id === card.scryfall_id
    : s.name === card.name)
  const full = selected.length >= 5

  return (
    <Modal onClose={onClose}>
      <h2 className={styles.artPickerTitle}>Standout Cards ({selected.length}/5)</h2>
      {selected.length > 0 && (
        <div className={styles.standoutSelected}>
          {selected.map((c, i) => (
            <div key={i} className={styles.standoutSelectedItem}>
              <img src={c.art_crop} alt={c.name} className={styles.standoutSelectedImg} />
              <span className={styles.standoutSelectedName}>{c.name}</span>
              <button className={styles.standoutSelectedRemove} onClick={() => onRemove(i)}>✕</button>
            </div>
          ))}
        </div>
      )}
      {loading ? (
        <div className={styles.standoutPickerLoading}>Loading deck cards…</div>
      ) : cards.length === 0 ? (
        <p className={styles.artPickerEmpty}>No cards found in this deck.</p>
      ) : (
        <div className={styles.standoutPickerGrid}>
          {cards.map(card => {
            const sel      = isSelected(card)
            const disabled = full && !sel
            return (
              <button key={card.scryfall_id}
                className={`${styles.standoutPickerItem}${sel ? ' ' + styles.standoutPickerItemSel : ''}${disabled ? ' ' + styles.standoutPickerItemDisabled : ''}`}
                onClick={() => { if (!disabled && !sel) onAdd({ scryfall_id: card.scryfall_id, name: card.name, art_crop: card.art_crop }) }}
                title={card.name}>
                <img src={card.art_crop} alt={card.name} className={styles.standoutPickerImg} />
                {card.price > 0 && <div className={styles.standoutPickerPrice}>€{card.price.toFixed(2)}</div>}
                {sel && <div className={styles.standoutPickerCheck}>✓</div>}
                <div className={styles.standoutPickerName}>{card.name}</div>
              </button>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

// ── Block components ──────────────────────────────────────────────────────────
function TextBlock({ text, editMode, onChangeText }) {
  if (editMode) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Text Block</div>
      <textarea className={styles.bioTextarea} value={text}
        onChange={e => onChangeText(e.target.value)}
        placeholder="Add any text — favourite format, goals, deck philosophy…"
        maxLength={500} rows={4} />
      <div className={styles.bioCount}>{text.length}/500</div>
    </div>
  )
  if (!text) return null
  return <div className={styles.blockInner}><div className={styles.bioText}>{text}</div></div>
}

function StatBlock({ label, value, sub, valueColor }) {
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>{label}</div>
      <div className={styles.statBig} style={valueColor ? { color: valueColor } : undefined}>{value}</div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  )
}

function ColorPieBlock({ distribution }) {
  if (!distribution) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Color Pie</div>
      <div className={styles.emptyNote}>No color data yet.</div>
    </div>
  )
  const total   = MANA_COLORS.reduce((a, c) => a + (distribution[c.key] || 0), 0) || 1
  const present = MANA_COLORS.filter(c => distribution[c.key])
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Color Pie</div>
      <div className={styles.colorPieBar}>
        {present.map(c => (
          <div key={c.key} className={styles.colorPieSegment}
            style={{ flex: distribution[c.key] / total, background: c.color }}
            title={`${c.label}: ${distribution[c.key].toLocaleString()}`} />
        ))}
      </div>
      <div className={styles.colorPieLegend}>
        {present.map(c => (
          <div key={c.key} className={styles.colorPieEntry}>
            <img src={`https://svgs.scryfall.io/card-symbols/${c.symbol}.svg`} className={styles.colorPipSm} alt={c.label} />
            <span>{Math.round(distribution[c.key] / total * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RarityBlock({ breakdown }) {
  if (!breakdown) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Rarity Breakdown</div>
      <div className={styles.emptyNote}>No data yet.</div>
    </div>
  )
  const total   = RARITY_DEFS.reduce((a, r) => a + (breakdown[r.key] || 0), 0) || 1
  const present = RARITY_DEFS.filter(r => breakdown[r.key])
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Rarity Breakdown</div>
      <div className={styles.rarityBar}>
        {present.map(r => (
          <div key={r.key} className={styles.raritySegment}
            style={{ flex: breakdown[r.key] / total, background: r.color }}
            title={`${r.label}: ${breakdown[r.key].toLocaleString()}`} />
        ))}
      </div>
      <div className={styles.rarityRows}>
        {present.map(r => (
          <div key={r.key} className={styles.rarityRow}>
            <span className={styles.rarityDot} style={{ background: r.color }} />
            <span className={styles.rarityLabel}>{r.label}</span>
            <span className={styles.rarityCount}>{breakdown[r.key].toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function FormatsBlock({ decks }) {
  const formats = [...new Set((decks || []).map(d => d.format).filter(Boolean))]
  if (!formats.length) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Formats Played</div>
      <div className={styles.emptyNote}>No public decks yet.</div>
    </div>
  )
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Formats Played</div>
      <div className={styles.formatPills}>
        {formats.map(f => (
          <span key={f} className={styles.formatPill}
            style={{ borderColor: FORMAT_COLORS[f] || 'var(--border)', color: FORMAT_COLORS[f] || 'var(--text-dim)' }}>
            {FORMAT_LABEL[f] || f}
          </span>
        ))}
      </div>
    </div>
  )
}

function FavCommanderBlock({ decks }) {
  const { name: commanderName, art: commanderArt } = useMemo(() => {
    if (!decks?.length) return {}
    const counts = {}
    decks.forEach(d => { if (d.commander_name) counts[d.commander_name] = (counts[d.commander_name] || 0) + 1 })
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
    if (!top) return {}
    return { name: top[0], art: decks.find(d => d.commander_name === top[0])?.cover_art_uri || null }
  }, [decks])

  if (!commanderName) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Fav. Commander</div>
      <div className={styles.emptyNote}>No public commander decks yet.</div>
    </div>
  )
  return (
    <div className={`${styles.blockInner} ${styles.commanderBlock}`}>
      {commanderArt && <div className={styles.commanderArtBg} style={{ backgroundImage: `url(${commanderArt})` }} />}
      <div className={styles.commanderContent}>
        <div className={styles.blockTitle}>Fav. Commander</div>
        <div className={styles.commanderName}>{commanderName}</div>
      </div>
    </div>
  )
}

function WinRateBlock({ gameStats }) {
  if (!gameStats || gameStats.total === 0) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Win Rate</div>
      <div className={styles.emptyNote}>No games tracked yet.</div>
    </div>
  )
  const pct = Math.round(gameStats.wins / gameStats.total * 100)
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Win Rate</div>
      <div className={styles.statBig} style={{ color: pct >= 50 ? 'var(--green)' : '#e05c5c' }}>{pct}%</div>
      <div className={styles.statSub}>{gameStats.wins}W – {gameStats.losses}L · {gameStats.total} games</div>
    </div>
  )
}

function FavFormatBlock({ gameStats, decks }) {
  const format = useMemo(() => {
    if (gameStats?.fav_format) return gameStats.fav_format
    if (!decks?.length) return null
    const counts = {}
    decks.forEach(d => { if (d.format) counts[d.format] = (counts[d.format] || 0) + 1 })
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null
  }, [gameStats, decks])
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Most Played</div>
      <div className={`${styles.statBig} ${styles.statBigMd}`}>
        {format ? (FORMAT_LABEL[format] || format) : '—'}
      </div>
    </div>
  )
}

// ── Milestone tooltip (portal) ────────────────────────────────────────────────
function MilestoneTooltip({ m, earned, earnedAt, rect }) {
  const x = rect.left + rect.width / 2
  const y = rect.top

  return createPortal(
    <div className={styles.milestoneTooltip} style={{ left: x, top: y }}>
      <div className={styles.milestoneTooltipHeader}>
        <span className={styles.milestoneTooltipIcon}>{m.icon}</span>
        <span className={styles.milestoneTooltipTitle}>{m.label}</span>
        {earned && <span className={styles.milestoneTooltipBadge}>Earned</span>}
      </div>
      <div className={styles.milestoneTooltipDesc}>{m.desc}</div>
      {!earned && <div className={styles.milestoneTooltipReq}>Requires: {m.req}</div>}
      {earned && earnedAt && (
        <div className={styles.milestoneTooltipDate}>
          Since {new Date(earnedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
        </div>
      )}
    </div>,
    document.body
  )
}

function MilestonesBlock({ stats, profile }) {
  const [tooltip, setTooltip] = useState(null)
  const earnedAt = profile?.bento_config?.milestone_earned_at || {}

  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Milestones</div>
      <div className={styles.milestoneGrid}>
        {MILESTONES.map(m => {
          const earned = m.check(stats, profile)
          return (
            <div
              key={m.id}
              className={`${styles.milestone}${earned ? ' ' + styles.milestoneEarned : ''}`}
              onMouseEnter={e => setTooltip({ m, earned, earnedAt: earnedAt[m.id], rect: e.currentTarget.getBoundingClientRect() })}
              onMouseLeave={() => setTooltip(null)}
            >
              <span className={styles.milestoneIcon}>{m.icon}</span>
              <span className={styles.milestoneName}>{m.label}</span>
            </div>
          )
        })}
      </div>
      {tooltip && (
        <MilestoneTooltip
          m={tooltip.m}
          earned={tooltip.earned}
          earnedAt={tooltip.earnedAt}
          rect={tooltip.rect}
        />
      )}
    </div>
  )
}

// ── Featured Deck block ───────────────────────────────────────────────────────
const _artCache = {}
function useDeckArt(coverArtUri, commanderScryfallId) {
  const [art, setArt] = useState(coverArtUri || _artCache[commanderScryfallId] || null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    if (art || !commanderScryfallId) return
    fetch(`https://api.scryfall.com/cards/${commanderScryfallId}?format=json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const url = d?.image_uris?.art_crop || d?.card_faces?.[0]?.image_uris?.art_crop || null
        if (url) _artCache[commanderScryfallId] = url
        if (mounted.current && url) setArt(url)
      })
      .catch(() => {})
    return () => { mounted.current = false }
  }, [commanderScryfallId])
  return art
}

function FeaturedDeckInner({ deck, standoutCards, deckStats, editMode, decks, onChangeDeck, onChangeCards }) {
  const art = useDeckArt(deck.cover_art_uri, deck.commander_scryfall_id)
  const colors = Array.isArray(deck.color_identity) ? deck.color_identity : []
  const [showPicker, setShowPicker] = useState(false)

  return (
    <div className={styles.featuredDeckWrap}>
      {art && <div className={styles.featuredDeckArt} style={{ backgroundImage: `url(${art})` }} />}
      <div className={styles.featuredDeckContent}>
        <div className={styles.blockTitle}>Featured Deck</div>

        <div className={styles.featuredDeckHeader}>
          {art && <div className={styles.featuredCommanderArt} style={{ backgroundImage: `url(${art})` }} />}
          <div className={styles.featuredDeckInfo}>
            <Link to={`/d/${deck.id}`} className={styles.featuredDeckName}>{deck.name}</Link>
            {deck.commander_name && (
              <div className={styles.featuredDeckCommander}>{deck.commander_name}</div>
            )}
            <div className={styles.featuredDeckMeta}>
              {deck.format && FORMAT_LABEL[deck.format] && (
                <span className={styles.deckBadgeFormat}>{FORMAT_LABEL[deck.format]}</span>
              )}
              {colors.length > 0 && (
                <div className={styles.deckTilePips}>
                  {colors.map(c => <img key={c} className={styles.deckTilePip} src={MANA_SYMBOL_URL(c)} alt={c} />)}
                </div>
              )}
              <span className={styles.featuredDeckCount}>{deck.card_count} cards</span>
            </div>
            {deckStats && deckStats.total > 0 && (
              <div className={styles.featuredDeckStats}>
                <span className={styles.featuredStatW}>{deckStats.wins}W</span>
                <span className={styles.featuredStatL}>{deckStats.losses}L</span>
                <span className={styles.featuredStatGames}>· {deckStats.total} games</span>
              </div>
            )}
          </div>
        </div>

        {(standoutCards?.length > 0 || editMode) && (
          <div className={styles.featuredStandoutSection}>
            <div className={styles.featuredStandoutLabel}>Standout Cards</div>
            <div className={styles.featuredStandoutStrip}>
              {(standoutCards || []).map((c, i) => (
                <div key={i} className={styles.featuredStandoutCard} title={c.name}>
                  <img src={c.art_crop} alt={c.name} className={styles.featuredStandoutImg} loading="lazy" />
                  {editMode && (
                    <button className={styles.featuredStandoutRemove}
                      onClick={() => onChangeCards((standoutCards || []).filter((_, j) => j !== i))}>✕</button>
                  )}
                </div>
              ))}
              {editMode && (standoutCards || []).length < 5 && (
                <button className={styles.featuredStandoutAdd} onClick={() => setShowPicker(true)}>+</button>
              )}
            </div>
          </div>
        )}

        {editMode && decks?.length > 1 && (
          <select className={styles.featuredDeckPicker} value={deck.id} onChange={e => onChangeDeck(e.target.value)}>
            {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
      </div>

      {showPicker && (
        <StandoutCardPicker
          deck={deck}
          selected={standoutCards || []}
          onAdd={card => onChangeCards([...(standoutCards || []), card])}
          onRemove={i => onChangeCards((standoutCards || []).filter((_, j) => j !== i))}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}

function FeaturedDeckBlock({ decks, featuredDeckId, standoutCards, deckStats, editMode, onChangeFeaturedDeck, onChangeStandoutCards }) {
  const deck = useMemo(
    () => decks?.find(d => d.id === featuredDeckId) || decks?.[0] || null,
    [decks, featuredDeckId]
  )
  if (!deck) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Featured Deck</div>
      <div className={styles.emptyNote}>No public decks to feature yet.</div>
    </div>
  )
  return (
    <FeaturedDeckInner
      deck={deck}
      standoutCards={standoutCards}
      deckStats={deckStats}
      editMode={editMode}
      decks={decks}
      onChangeDeck={onChangeFeaturedDeck}
      onChangeCards={onChangeStandoutCards}
    />
  )
}

function RecentCardsBlock({ cards }) {
  if (!cards?.length) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Recently Added</div>
      <div className={styles.emptyNote}>No cards to show yet.</div>
    </div>
  )
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Recently Added</div>
      <div className={styles.recentCardsStrip}>
        {cards.map((card, i) => (
          <div key={i} className={styles.recentCardItem} title={card.name}>
            {card.image_uri
              ? <img src={card.image_uri} alt={card.name} className={styles.recentCardImg} loading="lazy" />
              : <div className={styles.recentCardPlaceholder}>{card.name?.[0] || '?'}</div>
            }
          </div>
        ))}
      </div>
    </div>
  )
}

function ProfileDeckTile({ deck }) {
  const art    = useDeckArt(deck.cover_art_uri, deck.commander_scryfall_id)
  const colors = Array.isArray(deck.color_identity) ? deck.color_identity : []
  const fmtLabel     = FORMAT_LABEL[deck.format] || null
  const isCollection = deck.type === 'deck'
  return (
    <Link to={`/d/${deck.id}`} className={styles.deckTile}>
      {art && <div className={styles.deckTileArt} style={{ backgroundImage: `url(${art})` }} />}
      <div className={styles.deckTileContent}>
        <div className={styles.deckTileTop}>
          <div className={styles.deckTileBadges}>
            {isCollection
              ? <span className={styles.deckBadgeCollection}>Collection</span>
              : <span className={styles.deckBadgeFormat}>{fmtLabel || 'Builder'}</span>
            }
            {isCollection && fmtLabel && <span className={styles.deckBadgeFormat}>{fmtLabel}</span>}
          </div>
        </div>
        <div className={styles.deckTileBottom}>
          <div className={styles.deckTileName}>{deck.name}</div>
          {deck.commander_name && <div className={styles.deckTileCommander}>{deck.commander_name}</div>}
          {colors.length > 0 && (
            <div className={styles.deckTilePips}>
              {colors.map(c => <img key={c} className={styles.deckTilePip} src={MANA_SYMBOL_URL(c)} alt={c} />)}
            </div>
          )}
          <div className={styles.deckTileCount}>{deck.card_count} cards</div>
        </div>
      </div>
    </Link>
  )
}

function DecksBlock({ decks }) {
  if (!decks?.length) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Deck Showcase</div>
      <div className={styles.emptyNote}>No public decks yet.</div>
    </div>
  )
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Deck Showcase</div>
      <div className={styles.deckGrid}>
        {decks.map(deck => <ProfileDeckTile key={deck.id} deck={deck} />)}
      </div>
    </div>
  )
}

function CrownBlock({ topCard }) {
  if (!topCard) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Crown Jewel</div>
      <div className={styles.emptyNote}>No price data yet.</div>
    </div>
  )
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Crown Jewel</div>
      <div className={styles.crownWrap}>
        {topCard.image_uri && <img className={styles.crownImg} src={topCard.image_uri} alt={topCard.name} loading="lazy" />}
        <div className={styles.crownInfo}>
          <div className={styles.crownName}>{topCard.name}</div>
          <div className={styles.crownSet}>{(topCard.set_code || '').toUpperCase()} #{topCard.collector_number}</div>
          {topCard.price != null && <div className={styles.crownPrice}>€{Number(topCard.price).toFixed(2)}</div>}
        </div>
      </div>
    </div>
  )
}

function TopCardsBlock({ cards }) {
  if (!cards?.length) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Top Cards</div>
      <div className={styles.emptyNote}>No price data yet. Enable this block so prices get fetched.</div>
    </div>
  )
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Top Cards</div>
      <div className={styles.topCardsStrip}>
        {cards.map((c, i) => (
          <div key={i} className={styles.topCardItem} title={c.name}>
            <div className={styles.topCardArt} style={{ backgroundImage: `url(${c.art_crop})` }}>
              <div className={styles.topCardRank}>#{i + 1}</div>
              {c.foil && <div className={styles.topCardFoilBadge}>✦</div>}
            </div>
            <div className={styles.topCardInfo}>
              <div className={styles.topCardName}>{c.name}</div>
              {c.price != null && (
                <div className={styles.topCardPrice}>€{Number(c.price).toFixed(2)}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── dnd-kit sortable items ────────────────────────────────────────────────────
function SortableBentoBlock({ id, editMode, onHide, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  return (
    <div ref={setNodeRef} style={style}
      className={`${styles.blockOuter} ${spanClass(id)}${isDragging ? ' ' + styles.blockDragging : ''}`}
      {...attributes}>
      {editMode && (
        <div className={styles.blockEditBar}>
          <div className={styles.blockDragArea} {...listeners}>
            <span className={styles.blockDragHandle}>⠿</span>
            <span className={styles.blockEditLabel}>{BLOCK_DEFS[id]?.label}</span>
          </div>
          <button className={styles.blockRemoveBtn}
            onClick={e => { e.stopPropagation(); onHide(id) }}
            title="Move to available" aria-label={`Hide ${BLOCK_DEFS[id]?.label}`}>✕</button>
        </div>
      )}
      {children}
    </div>
  )
}

function SortableTrayItem({ id, onShow }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const def   = BLOCK_DEFS[id]
  return (
    <div ref={setNodeRef} style={style}
      className={`${styles.availableItem}${isDragging ? ' ' + styles.availableItemDragging : ''}`}
      {...attributes} {...listeners}>
      <span className={styles.blockDragHandle}>⠿</span>
      <span className={styles.availableItemText}>
        <span className={styles.availableItemName}>{def?.label}</span>
        <span className={styles.availableItemSpan}>{def?.span}</span>
      </span>
      <button className={styles.blockShowBtn}
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onShow(id) }}
        title="Add to grid" aria-label={`Show ${def?.label}`}>+</button>
    </div>
  )
}

function DroppableTray({ children, className }) {
  const { setNodeRef, isOver } = useDroppable({ id: TRAY_DROP_ID })
  return (
    <aside ref={setNodeRef} className={`${className}${isOver ? ' ' + styles.availablePanelActive : ''}`}>
      {children}
    </aside>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const { username } = useParams()
  const { user }     = useAuth()
  const settings     = useSettings()

  const [profile, setProfile]               = useState(null)
  const [publicDecks, setPublicDecks]       = useState([])
  const [gameStats, setGameStats]           = useState(null)
  const [featuredDeckStats, setFeaturedDeckStats] = useState(null)
  const [loading, setLoading]               = useState(true)
  const [notFound, setNotFound]             = useState(false)

  const [editMode, setEditMode]                       = useState(false)
  const [draftBio, setDraftBio]                       = useState('')
  const [draftAccent, setDraftAccent]                 = useState('')
  const [draftBlocks, setDraftBlocks]                 = useState([])
  const [draftHeaderArt, setDraftHeaderArt]           = useState('')
  const [draftTextContent, setDraftTextContent]       = useState('')
  const [draftFeaturedDeckId, setDraftFeaturedDeckId] = useState('')
  const [draftStandoutCards, setDraftStandoutCards]   = useState([])
  const [showArtPicker, setShowArtPicker]             = useState(false)
  const [saving, setSaving]                           = useState(false)

  const [activeId, setActiveId] = useState(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 5 } })
  )

  const decodedUsername = decodeURIComponent(username)
  const isOwn = !!(user && settings.nickname &&
    decodedUsername.toLowerCase() === settings.nickname.toLowerCase())

  const ownProfileFallback = useMemo(() => ({
    user_id:           user?.id,
    nickname:          settings.nickname,
    bio:               settings.profile_bio || '',
    accent:            settings.profile_accent || '',
    premium:           settings.premium,
    bento_config:      settings.profile_config || DEFAULT_BENTO_CONFIG,
    stats:             null,
    top_card:          null,
    recent_cards:      null,
    joined_at:         null,
    collection_value:  null,
    public_deck_count: null,
  }), [user?.id, settings.nickname, settings.profile_bio, settings.profile_accent, settings.premium, settings.profile_config])

  const ownFallbackRef = useRef(ownProfileFallback)
  useEffect(() => { ownFallbackRef.current = ownProfileFallback }, [ownProfileFallback])

  // ── Load ───────────────────────────────────────────────────────────────────
  const loadProfile = useCallback(async () => {
    setLoading(true)
    setNotFound(false)
    const { data, error } = await sb.rpc('get_public_profile', { p_username: decodedUsername })
    if (error || !data) {
      if (isOwn) { setProfile(ownFallbackRef.current); setPublicDecks([]) }
      else setNotFound(true)
      setLoading(false)
      return
    }
    setProfile(data)
    sb.rpc('get_public_decks', { p_username: decodedUsername })
      .then(({ data: decks }) => setPublicDecks(decks || []))
      .catch(() => {})
    setLoading(false)
  }, [decodedUsername, isOwn])

  useEffect(() => { loadProfile() }, [loadProfile])

  // Sync own profile fields when settings change
  useEffect(() => {
    if (!isOwn) return
    setProfile(prev => prev ? {
      ...prev,
      nickname:     settings.nickname,
      bio:          settings.profile_bio   ?? prev.bio,
      accent:       settings.profile_accent ?? prev.accent,
      bento_config: settings.profile_config ?? prev.bento_config,
      premium:      settings.premium,
    } : prev)
  }, [isOwn, settings.nickname, settings.profile_bio, settings.profile_accent, settings.profile_config, settings.premium])

  // Fetch overall game stats (owner only)
  useEffect(() => {
    if (!isOwn || !user) return
    sb.from('game_results').select('placement, format').eq('user_id', user.id)
      .then(({ data: rows }) => {
        if (!rows?.length) return
        const wins = rows.filter(r => r.placement === 1).length
        const fmt  = {}
        rows.forEach(r => { if (r.format) fmt[r.format] = (fmt[r.format] || 0) + 1 })
        const fav_format = Object.entries(fmt).sort((a, b) => b[1] - a[1])[0]?.[0] || null
        setGameStats({ wins, losses: rows.length - wins, total: rows.length, fav_format })
      })
      .catch(() => {})
  }, [isOwn, user?.id])

  // Fetch featured deck stats (owner only)
  const savedFeaturedDeckId = profile?.bento_config?.featured_deck_id || publicDecks?.[0]?.id || null
  useEffect(() => {
    if (!isOwn || !user || !savedFeaturedDeckId) return
    sb.from('game_results').select('placement').eq('user_id', user.id).eq('deck_id', savedFeaturedDeckId)
      .then(({ data: rows }) => {
        if (!rows?.length) { setFeaturedDeckStats({ wins: 0, losses: 0, total: 0 }); return }
        const wins = rows.filter(r => r.placement === 1).length
        setFeaturedDeckStats({ wins, losses: rows.length - wins, total: rows.length })
      })
      .catch(() => {})
  }, [isOwn, user?.id, savedFeaturedDeckId])

  // Track milestone earn dates for owner
  useEffect(() => {
    if (!isOwn || !user || !profile?.stats) return
    const cfg      = profile.bento_config || {}
    const earnedAt = cfg.milestone_earned_at || {}
    const now      = new Date().toISOString()
    let updated    = false
    const newEarnedAt = { ...earnedAt }
    MILESTONES.forEach(m => {
      if (!newEarnedAt[m.id] && m.check(profile.stats, profile)) {
        newEarnedAt[m.id] = now
        updated = true
      }
    })
    if (!updated) return
    const newConfig = { ...cfg, milestone_earned_at: newEarnedAt }
    sb.from('user_settings').update({ profile_config: newConfig, updated_at: now }).eq('user_id', user.id)
      .then(() => {
        settings.save({ profile_config: newConfig })
        setProfile(prev => prev ? { ...prev, bento_config: newConfig } : prev)
      })
      .catch(() => {})
  }, [isOwn, user?.id, profile?.stats, profile?.public_deck_count, profile?.collection_value])

  // ── Edit mode ──────────────────────────────────────────────────────────────
  function enterEdit() {
    const cfg = profile?.bento_config || {}
    setDraftBio(profile?.bio || '')
    setDraftAccent(profile?.accent || '')
    setDraftBlocks(mergeBlocks(cfg.blocks))
    setDraftHeaderArt(cfg.header_art || '')
    setDraftTextContent(cfg.text_content || '')
    setDraftFeaturedDeckId(cfg.featured_deck_id || '')
    setDraftStandoutCards(cfg.featured_deck_standout_cards || [])
    setEditMode(true)
  }

  function cancelEdit() {
    setEditMode(false)
    setActiveId(null)
    setShowArtPicker(false)
  }

  async function saveEdit() {
    setSaving(true)
    const newConfig = {
      blocks:                       draftBlocks,
      header_art:                   draftHeaderArt,
      text_content:                 draftTextContent,
      featured_deck_id:             draftFeaturedDeckId,
      featured_deck_standout_cards: draftStandoutCards,
      milestone_earned_at:          profile?.bento_config?.milestone_earned_at || {},
    }
    await sb.from('user_settings').update({
      profile_bio:    draftBio,
      profile_accent: draftAccent,
      profile_config: newConfig,
      updated_at:     new Date().toISOString(),
    }).eq('user_id', user.id)
    settings.save({ profile_bio: draftBio, profile_accent: draftAccent, profile_config: newConfig })
    setProfile(prev => prev ? { ...prev, bio: draftBio, accent: draftAccent, bento_config: newConfig } : prev)
    setEditMode(false)
    setSaving(false)
  }

  function hideBlock(id) { setDraftBlocks(prev => prev.map(b => b.id === id ? { ...b, enabled: false } : b)) }
  function showBlock(id) { setDraftBlocks(prev => prev.map(b => b.id === id ? { ...b, enabled: true  } : b)) }

  // ── dnd-kit handlers ───────────────────────────────────────────────────────
  const gridIds = useMemo(() => draftBlocks.filter(b => b.enabled).map(b => b.id),  [draftBlocks])
  const trayIds = useMemo(() => draftBlocks.filter(b => !b.enabled).map(b => b.id), [draftBlocks])

  function handleDragStart({ active }) { setActiveId(active.id) }
  function handleDragEnd({ active, over }) {
    setActiveId(null)
    if (!over || active.id === over.id) return
    const overId   = over.id
    const fromGrid = gridIds.includes(active.id)
    const toGrid   = gridIds.includes(overId) || overId === GRID_DROP_ID
    const toTray   = trayIds.includes(overId) || overId === TRAY_DROP_ID
    setDraftBlocks(prev => {
      const gridBlocks  = prev.filter(b => b.enabled)
      const trayBlocks  = prev.filter(b => !b.enabled)
      const activeBlock = prev.find(b => b.id === active.id)
      if (!activeBlock) return prev
      if (fromGrid && toGrid) {
        const oldIdx = gridBlocks.findIndex(b => b.id === active.id)
        const newIdx = overId === GRID_DROP_ID ? gridBlocks.length - 1 : gridBlocks.findIndex(b => b.id === overId)
        if (newIdx < 0 || oldIdx === newIdx) return prev
        return [...arrayMove(gridBlocks, oldIdx, newIdx), ...trayBlocks]
      }
      if (!fromGrid && toTray) {
        const oldIdx = trayBlocks.findIndex(b => b.id === active.id)
        const newIdx = overId === TRAY_DROP_ID ? trayBlocks.length - 1 : trayBlocks.findIndex(b => b.id === overId)
        if (newIdx < 0 || oldIdx === newIdx) return prev
        return [...gridBlocks, ...arrayMove(trayBlocks, oldIdx, newIdx)]
      }
      if (fromGrid && toTray) {
        return [...gridBlocks.filter(b => b.id !== active.id), ...trayBlocks, { ...activeBlock, enabled: false }]
      }
      if (!fromGrid && toGrid) {
        const overIdx  = overId === GRID_DROP_ID ? gridBlocks.length : gridBlocks.findIndex(b => b.id === overId)
        const insertAt = overIdx < 0 ? gridBlocks.length : overIdx
        const newGrid  = [...gridBlocks]
        newGrid.splice(insertAt, 0, { ...activeBlock, enabled: true })
        return [...newGrid, ...trayBlocks.filter(b => b.id !== active.id)]
      }
      return prev
    })
  }

  // ── Block renderer ─────────────────────────────────────────────────────────
  function renderBlock(block) {
    const { stats, top_card, joined_at, collection_value, public_deck_count, recent_cards } = profile || {}
    const cfg   = profile?.bento_config || {}
    const featId = editMode ? draftFeaturedDeckId : cfg.featured_deck_id
    const standout = editMode ? draftStandoutCards : (cfg.featured_deck_standout_cards || [])
    switch (block.id) {
      case 'bio':           return <TextBlock text={editMode ? draftTextContent : (cfg.text_content || '')} editMode={editMode} onChangeText={setDraftTextContent} />
      case 'total':         return <StatBlock label="Total Cards"    value={fmtNum(stats?.total_cards)} />
      case 'unique':        return <StatBlock label="Unique Prints"  value={fmtNum(stats?.unique_cards)} />
      case 'foils':         return <StatBlock label="Foil Count"     value={fmtNum(stats?.foil_count)} />
      case 'sets':          return <StatBlock label="Sets Collected" value={fmtNum(stats?.sets_count)} />
      case 'since':         return <StatBlock label="Member Since"   value={joined_at ? new Date(joined_at).getFullYear() : '—'} />
      case 'value':         return <StatBlock label="Est. Value"     value={collection_value != null ? `€${Number(collection_value).toFixed(2)}` : '—'} />
      case 'deck_count':    return <StatBlock label="Public Decks"   value={fmtNum(public_deck_count)} />
      case 'winrate':       return <WinRateBlock gameStats={gameStats} />
      case 'fav_format':    return <FavFormatBlock gameStats={gameStats} decks={publicDecks} />
      case 'color_pie':     return <ColorPieBlock distribution={stats?.color_distribution} />
      case 'rarity':        return <RarityBlock breakdown={stats?.rarity_breakdown} />
      case 'formats':       return <FormatsBlock decks={publicDecks} />
      case 'fav_commander': return <FavCommanderBlock decks={publicDecks} />
      case 'crown':         return <CrownBlock topCard={top_card} />
      case 'top_cards':     return <TopCardsBlock cards={profile?.top_cards} />
      case 'milestones':    return <MilestonesBlock stats={stats} profile={profile} />
      case 'featured_deck': return (
        <FeaturedDeckBlock
          decks={publicDecks}
          featuredDeckId={featId}
          standoutCards={standout}
          deckStats={featuredDeckStats}
          editMode={editMode}
          onChangeFeaturedDeck={setDraftFeaturedDeckId}
          onChangeStandoutCards={setDraftStandoutCards}
        />
      )
      case 'recent_cards':  return <RecentCardsBlock cards={recent_cards} />
      case 'decks':         return <DecksBlock decks={publicDecks} />
      default:              return null
    }
  }

  const headerArt   = editMode ? draftHeaderArt : (profile?.bento_config?.header_art || '')
  const accentColor = (editMode ? draftAccent : profile?.accent) || 'var(--gold)'
  const displayName = profile?.nickname || username
  const viewBlocks  = mergeBlocks(profile?.bento_config?.blocks).filter(b => b.enabled)
  const headerBio   = editMode ? draftBio : (profile?.bio || '')

  if (loading) return <div className={styles.page}><div className={styles.loadingMsg}>Loading profile…</div></div>

  if (notFound) return (
    <div className={styles.page}>
      <div className={styles.notFound}>
        <div className={styles.notFoundTitle}>Profile not found</div>
        <div className={styles.notFoundSub}>No user with the nickname "{username}" was found.</div>
        <Link to="/" className={styles.notFoundLink}>← Back to Home</Link>
      </div>
    </div>
  )

  return (
    <div className={styles.page}>
      {/* ── Profile header ── */}
      <div className={styles.header} style={{ '--profile-accent': accentColor }}>
        {headerArt && <div className={styles.headerArtBg} style={{ backgroundImage: `url(${headerArt})` }} />}
        <div className={styles.headerAccentBar} />
        <div className={styles.headerContent}>
          <div className={styles.avatar} style={{ borderColor: accentColor, color: accentColor }}>
            {(displayName[0] || '?').toUpperCase()}
          </div>

          <div className={styles.headerInfo}>
            <div className={styles.displayName}>
              {displayName}
              {profile?.premium && <span className={styles.premiumBadge}>✦ Supporter</span>}
            </div>
            {editMode
              ? <textarea className={styles.headerBioEdit} value={draftBio}
                  onChange={e => setDraftBio(e.target.value)}
                  placeholder="Tell the community about yourself…" maxLength={300} rows={2} />
              : headerBio && <p className={styles.headerBio}>{headerBio}</p>
            }
          </div>

          <div className={styles.headerActions}>
            {isOwn && !editMode && (
              <button className={styles.editBtn} onClick={enterEdit}>Edit Profile</button>
            )}
            {isOwn && editMode && (
              <>
                <div className={styles.accentPalette}>
                  {ACCENT_PALETTE.map(color => (
                    <button key={color}
                      className={`${styles.accentSwatch}${(draftAccent || '#c9a84c') === color ? ' ' + styles.accentSwatchActive : ''}`}
                      style={{ background: color }}
                      onClick={() => setDraftAccent(color)}
                      title={color} aria-label={`Accent color ${color}`} />
                  ))}
                </div>
                <button className={styles.artBtn} onClick={() => setShowArtPicker(true)}
                  title={draftHeaderArt ? 'Change header background' : 'Set header background'}>
                  <ImageIcon size={13} />
                  {draftHeaderArt ? 'Change Art' : 'Add Art'}
                </button>
                {draftHeaderArt && (
                  <button className={styles.artRemoveBtn} onClick={() => setDraftHeaderArt('')}>✕ Art</button>
                )}
                <button className={styles.saveBtn} onClick={saveEdit} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button className={styles.cancelBtn} onClick={cancelEdit}>Cancel</button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── View mode ── */}
      {!editMode && (
        <div className={styles.bento}>
          {viewBlocks.map(block => (
            <div key={block.id} className={`${styles.blockOuter} ${spanClass(block.id)}`}>
              {renderBlock(block)}
            </div>
          ))}
        </div>
      )}

      {/* ── Edit mode ── */}
      {editMode && (
        <DndContext sensors={sensors} collisionDetection={closestCenter}
          onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className={`${styles.bentoEditor} ${styles.bentoEditorActive}`}>
            <div className={`${styles.bento} ${styles.bentoEdit}`}>
              <div className={styles.editHint}>Drag blocks to reorder. Use ✕ to hide or + to show.</div>
              <SortableContext items={gridIds} strategy={noDisplace}>
                {draftBlocks.filter(b => b.enabled).map(block => (
                  <SortableBentoBlock key={block.id} id={block.id} editMode={editMode} onHide={hideBlock}>
                    {renderBlock(block)}
                  </SortableBentoBlock>
                ))}
              </SortableContext>
            </div>

            <DroppableTray className={styles.availablePanel}>
              <div className={styles.availableTitle}>Available</div>
              <div className={styles.availableSub}>Drag here to hide, or drag back to show.</div>
              <div className={styles.availableList}>
                {trayIds.length === 0
                  ? <div className={styles.availableEmpty}>All blocks are on the grid.</div>
                  : (
                    <SortableContext items={trayIds} strategy={verticalListSortingStrategy}>
                      {draftBlocks.filter(b => !b.enabled).map(block => (
                        <SortableTrayItem key={block.id} id={block.id} onShow={showBlock} />
                      ))}
                    </SortableContext>
                  )
                }
              </div>
            </DroppableTray>
          </div>

          <DragOverlay dropAnimation={{ duration: 150, easing: 'ease' }}>
            {activeId && (
              <div className={styles.dragGhost}>
                <span>⠿</span>{BLOCK_DEFS[activeId]?.label}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {showArtPicker && (
        <CardArtPicker
          onSelect={url => { setDraftHeaderArt(url); setShowArtPicker(false) }}
          onClose={() => setShowArtPicker(false)}
        />
      )}
    </div>
  )
}
