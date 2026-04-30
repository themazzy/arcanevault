import { useState, useEffect, useMemo, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { getPrice, formatPrice, getScryfallKey, getPriceSource } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { getLocalCards } from '../lib/db'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { CardDetail } from '../components/CardComponents'
import { EmptyState, SectionHeader, ProgressBar } from '../components/UI'
import { parseDeckMeta } from '../lib/deckBuilderApi'
import { MILESTONES } from '../lib/milestones'
import { ChevronDownIcon, ChevronUpIcon } from '../icons'
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import setIconManifest from '../data/setIconManifest.json'
import styles from './Stats.module.css'

// ── Colour palettes ───────────────────────────────────────────────────────────
const RARITY_COLORS = {
  common: '#6a6a7a', uncommon: '#8ab0c8', rare: '#c9a84c', mythic: '#c46030', special: '#8a6fc4',
}
const PIE_COLORS = ['#c9a84c', '#8a6fc4', '#8ab87a', '#c46060', '#5a9ab0', '#c47060', '#7a8ac0']
const FORMAT_COLORS = {
  Commander: '#c9a84c', Modern: '#5a9ab0', Pioneer: '#8ab87a',
  Standard: '#c46030', Legacy: '#8a6fc4', Vintage: '#6a6a7a',
}
const PLACEMENT_COLORS = {
  1: 'var(--gold)',
  2: '#8ab0c8',
  3: '#c47060',
  4: '#6a6a7a',
}

const GAME_MODE_LABELS = {
  standard: 'Standard',
  commander: 'Commander',
  brawl: 'Brawl',
  oathbreaker: 'Oathbreaker',
  planechase: 'Planechase',
  custom: 'Custom',
}
const LANGUAGE_LABELS = {
  en: 'English',
  de: 'German',
  fr: 'French',
  it: 'Italian',
  es: 'Spanish',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  cs: 'Traditional Chinese',
  ct: 'Simplified Chinese',
  he: 'Hebrew',
  ar: 'Arabic',
  la: 'Latin',
  ph: 'Phyrexian',
}
const CONDITION_LABELS = {
  near_mint: 'Near Mint',
  lightly_played: 'Lightly Played',
  moderately_played: 'Moderately Played',
  heavily_played: 'Heavily Played',
  damaged: 'Damaged',
}

// ── Security helpers ──────────────────────────────────────────────────────────
const SAFE_BG_ORIGINS = [
  'https://cards.scryfall.io',
  'https://c1.scryfall.com',
  'https://c2.scryfall.com',
]
function safeBgUrl(raw) {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    if (!SAFE_BG_ORIGINS.some(o => raw.startsWith(o))) return null
    return raw
  } catch { return null }
}

function sanitizeStr(s, maxLen = 64) {
  if (typeof s !== 'string') return ''
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, maxLen)
}

function sanitizeGameRow(row) {
  return {
    ...row,
    player_name: sanitizeStr(row.player_name),
    format: typeof row.format === 'string' ? row.format.slice(0, 32) : null,
    players_json: Array.isArray(row.players_json)
      ? row.players_json.map(p => ({
          ...p,
          name: sanitizeStr(p.name),
          deckName: sanitizeStr(p.deckName),
        }))
      : [],
  }
}

const SETS_CACHE_KEY = 'av_scryfall_sets'
const SETS_CACHE_TTL = 24 * 60 * 60 * 1000
const LOCAL_SET_ICONS = Object.fromEntries(
  Object.entries(setIconManifest?.icons || {}).map(([code, relPath]) => [String(code).toLowerCase(), `${import.meta.env.BASE_URL}${String(relPath).replace(/^\/+/, '')}`])
)

async function fetchScryfallSetsMap() {
  try {
    const raw = localStorage.getItem(SETS_CACHE_KEY)
    if (raw) {
      const { ts, data } = JSON.parse(raw)
      if (Date.now() - ts < SETS_CACHE_TTL) return data
    }
    const r = await fetch('https://api.scryfall.com/sets')
    if (!r.ok) return {}
    const json = await r.json()
    const data = {}
    for (const s of (json.data || [])) {
      if (typeof s.code !== 'string' || s.code.length > 10) continue
      if (typeof s.name !== 'string' || s.name.length > 120) continue
      data[s.code] = { name: s.name, count: typeof s.card_count === 'number' ? s.card_count : 0 }
    }
    try {
      localStorage.setItem(SETS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }))
    } catch (storageErr) {
      console.warn('[Stats] Could not cache sets to localStorage:', storageErr)
    }
    return data
  } catch (err) {
    console.warn('[Stats] fetchScryfallSetsMap failed:', err?.message ?? String(err))
    return {}
  }
}

// ── Hooks ─────────────────────────────────────────────────────────────────────
function useWindowWidth() {
  const [width, setWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200)
  useEffect(() => {
    const handler = () => setWidth(window.innerWidth)
    window.addEventListener('resize', handler, { passive: true })
    return () => window.removeEventListener('resize', handler)
  }, [])
  return width
}

// ── Sub-components ────────────────────────────────────────────────────────────
function StatCard({ label, value, sub }) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  )
}

/** Section label — matches DeckView extending-rule style */
function SLabel({ children }) {
  return <div className={styles.sectionLabel}>{children}</div>
}
function getSetIconUrl(code) {
  return code ? LOCAL_SET_ICONS[String(code).toLowerCase()] || '' : ''
}
function getRemoteSetIconUrl(code) {
  return code ? `https://svgs.scryfall.io/sets/${String(code).toLowerCase()}.svg` : ''
}

function SetIcon({ code }) {
  const localUrl = getSetIconUrl(code)
  const remoteUrl = getRemoteSetIconUrl(code)
  const hasLocalIcon = !!localUrl

  if (hasLocalIcon) {
    return (
      <span
        className={styles.setRowIcon}
        style={{
          WebkitMaskImage: `url("${localUrl}")`,
          maskImage: `url("${localUrl}")`,
        }}
        aria-hidden="true"
      />
    )
  }

  return (
    <img
      src={remoteUrl}
      alt=""
      className={styles.setRowIconFallback}
      loading="lazy"
      aria-hidden="true"
    />
  )
}

function SetRow({ row }) {
  const pct = row.pct ?? 0
  return (
    <div className={styles.setRow}>
      <div className={styles.setRowMeta}>
        <span className={styles.setRowName}>
          <SetIcon code={row.code} />
          <span>{row.name}</span>
        </span>
        <span className={styles.setRowCount}>
          {row.owned}{row.total ? `/${row.total}` : ''}{row.pct != null ? ` · ${row.pct}%` : ''}
        </span>
      </div>
      <div className={styles.setRowTrack}>
        <div className={styles.setRowFill} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  )
}

function SetCompletionSection({ cards, sfMap, loading }) {
  const [setsMap, setSetsMap] = useState(null)
  const [expanded, setExpanded] = useState(false)

  const ownedBySet = useMemo(() => {
    if (!cards.length) return []
    const map = {}
    for (const card of cards) {
      if (!card?.set_code || !card?.collector_number) continue
      const sf = sfMap[`${card.set_code}-${card.collector_number}`]
      if (!map[card.set_code]) {
        map[card.set_code] = {
          code: card.set_code,
          name: sf?.set_name || card.set_code.toUpperCase(),
          nums: new Set(),
        }
      }
      map[card.set_code].nums.add(card.collector_number)
    }
    return Object.values(map).map(s => ({ code: s.code, name: s.name, owned: s.nums.size }))
  }, [cards, sfMap])

  useEffect(() => {
    if (ownedBySet.length) fetchScryfallSetsMap().then(setSetsMap)
  }, [ownedBySet])

  const rows = useMemo(() => {
    return ownedBySet.map(s => {
      const total = setsMap?.[s.code]?.count || null
      const pct = total ? Math.min(100, Math.round((s.owned / total) * 100)) : null
      return { code: s.code, name: setsMap?.[s.code]?.name || s.name, owned: s.owned, total, pct }
    }).sort((a, b) => {
      if (a.pct != null && b.pct != null) return b.pct - a.pct
      if (a.pct != null) return -1
      if (b.pct != null) return 1
      return b.owned - a.owned
    })
  }, [ownedBySet, setsMap])

  if (!loading && rows.length === 0) return null

  const top = rows.slice(0, 5)
  const rest = rows.slice(5)

  return (
    <div className={styles.chartBox}>
      <div className={styles.sectionHead}>
        <SLabel>Set Completion</SLabel>
        <span className={styles.sectionCount}>{rows.length} sets</span>
      </div>
      {loading ? (
        <div className={styles.setSkeletons}>{[0, 1, 2].map(i => <div key={i} className={styles.setSkeleton} />)}</div>
      ) : (
        <>
          <div className={styles.setList}>
            {top.map(r => <SetRow key={r.code} row={r} />)}
          </div>
          {rest.length > 0 && (
            <div className={styles.setDropdown}>
              <button className={styles.setDropdownToggle} onClick={() => setExpanded(v => !v)}>
                {expanded
                  ? <><ChevronUpIcon size={10} /> Show less</>
                  : <><ChevronDownIcon size={10} /> Show all {rows.length} sets</>}
              </button>
              {expanded && (
                <div className={styles.setDropdownList}>
                  {rest.map(r => <SetRow key={r.code} row={r} />)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Card thumbnail with DFC support */
function CardThumb({ sf, size = 28 }) {
  const url = sf?.image_uris?.small || sf?.card_faces?.[0]?.image_uris?.small
  const h   = Math.round(size * 1.4)
  if (!url) return (
    <div style={{
      width: size, height: h, flexShrink: 0,
      background: 'var(--s2)',
      border: '1px solid var(--s-border)',
      borderRadius: 2,
    }} />
  )
  return (
    <img
      src={url} alt="" loading="lazy"
      style={{
        width: size, height: h, objectFit: 'cover',
        borderRadius: 2, boxShadow: '0 1px 5px rgba(0,0,0,0.45)', flexShrink: 0,
      }}
    />
  )
}

function MoverRow({ card, tone, onOpen, fmt }) {
  const isPositive = tone === 'positive'
  const accent = isPositive ? 'var(--green, #5dba70)' : '#e05252'
  const pctText = `${isPositive ? '+' : ''}${card._plPct.toFixed(0)}%`
  const deltaText = `${isPositive ? '+' : ''}${fmt(card._pl)}`

  return (
    <div className={styles.moverRow}>
      <button
        type="button"
        className={`${styles.cardButton} ${styles.moverCardButton}`}
        onClick={() => onOpen(card.id)}
      >
        <CardThumb sf={card._sf} size={26} />
        <span className={styles.moverName}>
          {card._sf?.name || `${card.set_code?.toUpperCase()}-${card.collector_number}`}
        </span>
        {card.foil && <span className={styles.foilTag}>FOIL</span>}
      </button>
      <span className={styles.moverPct} style={{ color: accent }}>{pctText}</span>
      <span className={styles.moverPrice} style={{ color: accent }}>{fmt(card._price)}</span>
      <span className={styles.moverVal} style={{ color: accent }}>{deltaText}</span>
    </div>
  )
}

function getShowcaseImage(sf) {
  return sf?.image_uris?.normal
    || sf?.image_uris?.large
    || sf?.card_faces?.[0]?.image_uris?.normal
    || sf?.card_faces?.[0]?.image_uris?.large
    || null
}

function TopValuableShowcase({ cards, fmt, onOpen }) {
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!cards.length) return
    setActiveIndex(prev => Math.min(prev, cards.length - 1))
  }, [cards])

  useEffect(() => {
    if (cards.length < 2) return undefined
    const timer = window.setInterval(() => {
      setActiveIndex(prev => (prev + 1) % cards.length)
    }, 4200)
    return () => window.clearInterval(timer)
  }, [cards])

  if (!cards.length) return null

  const active = cards[activeIndex]
  const image = getShowcaseImage(active._sf)
  const total = active._price != null ? active._price * active.qty : 0

  return (
    <div className={styles.showcase}>
      <button
        type="button"
        className={styles.showcaseHero}
        onClick={() => onOpen(active.id)}
      >
        <div className={styles.showcaseArtFrame}>
          {image ? (
            <div className={styles.showcaseArtStage}>
              <img
                key={`${active.id}-${activeIndex}`}
                src={image}
                alt={active._sf?.name || active.name || 'Card'}
                className={styles.showcaseArt}
              />
              {active.foil && <div className={styles.showcaseFoil} aria-hidden="true" />}
            </div>
          ) : (
            <div className={styles.showcaseArtFallback}>No image</div>
          )}
        </div>

        <div className={styles.showcaseBody}>
          <div className={styles.showcaseEyebrow}>Featured Value Card</div>
          <div className={styles.showcaseNameRow}>
            <div className={styles.showcaseName}>
              {active._sf?.name || `${active.set_code?.toUpperCase()}-${active.collector_number}`}
            </div>
            {active.foil && <span className={styles.foilTag}>FOIL</span>}
          </div>
          <div className={styles.showcaseSet}>
            {active._sf?.set_name || (active.set_code || '').toUpperCase()} · #{active.collector_number}
          </div>
          <div className={styles.showcaseMetrics}>
            <div className={styles.showcaseMetric}>
              <span className={styles.showcaseMetricLabel}>Price</span>
              <strong>{fmt(active._price)}</strong>
            </div>
            <div className={styles.showcaseMetric}>
              <span className={styles.showcaseMetricLabel}>Qty</span>
              <strong>{active.qty}</strong>
            </div>
            <div className={styles.showcaseMetric}>
              <span className={styles.showcaseMetricLabel}>Total</span>
              <strong>{fmt(total)}</strong>
            </div>
          </div>
        </div>
      </button>

      <div className={styles.showcaseRail}>
        {cards.map((card, index) => {
          const selected = index === activeIndex
          return (
            <button
              key={card.id}
              type="button"
              className={`${styles.showcaseChip} ${selected ? styles.showcaseChipActive : ''}`}
              onClick={() => setActiveIndex(index)}
            >
              <div className={styles.showcaseChipThumb}>
                <CardThumb sf={card._sf} size={34} />
              </div>
              <div className={styles.showcaseChipMeta}>
                <span className={styles.showcaseChipRank}>#{index + 1}</span>
                <span className={styles.showcaseChipName}>
                  {card._sf?.name || `${card.set_code?.toUpperCase()}-${card.collector_number}`}
                </span>
                <span className={styles.showcaseChipValue}>{fmt(card._price)}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function DistributionBars({ items, total, labels = {} }) {
  const max = items.length ? Math.max(...items.map(item => item.qty)) : 1

  return (
    <div className={styles.distList}>
      {items.map(item => {
        const label = labels[item.key] || String(item.key || 'unknown').toUpperCase()
        const pct = total ? Math.round((item.qty / total) * 100) : 0
        return (
          <div key={item.key} className={styles.distRow}>
            <div className={styles.distHead}>
              <span className={styles.distLabel}>{label}</span>
              <span className={styles.distValue}>{item.qty.toLocaleString()} · {pct}%</span>
            </div>
            <div className={styles.distTrack}>
              <div className={styles.distFill} style={{ width: `${(item.qty / max) * 100}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

const MTG_COLOR_META = {
  W: { label: 'White',      dot: '#f5f0dc' },
  U: { label: 'Blue',       dot: '#4a8fcf' },
  B: { label: 'Black',      dot: '#3a2a3e' },
  R: { label: 'Red',        dot: '#c83a3a' },
  G: { label: 'Green',      dot: '#2a7a44' },
  M: { label: 'Multicolor', dot: '#c9a84c' },
  C: { label: 'Colorless',  dot: '#8a8a9a' },
}
const MTG_COLOR_ORDER = ['W', 'U', 'B', 'R', 'G', 'M', 'C']

function ColorDistributionBars({ byColor, totalQty }) {
  const items = MTG_COLOR_ORDER.filter(c => (byColor[c] || 0) > 0).map(c => ({
    key: c,
    label: MTG_COLOR_META[c].label,
    qty: byColor[c],
    dot: MTG_COLOR_META[c].dot,
  }))
  const max = items.length ? Math.max(...items.map(i => i.qty)) : 1
  return (
    <div className={styles.distList}>
      {items.map(item => {
        const pct = totalQty ? Math.round((item.qty / totalQty) * 100) : 0
        return (
          <div key={item.key} className={styles.distRow}>
            <div className={styles.distHead}>
              <span className={styles.distLabel}>
                <span className={styles.colorDot} style={{ background: item.dot }} />
                {item.label}
              </span>
              <span className={styles.distValue}>{item.qty.toLocaleString()} · {pct}%</span>
            </div>
            <div className={styles.distTrack}>
              <div className={styles.distFill} style={{ width: `${(item.qty / max) * 100}%`, background: item.dot, opacity: 0.72 }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function MilestonesSection({ stats, historyRows, publicDeckCount }) {
  const statsShape = {
    total_cards: stats.totalQty,
    unique_cards: stats.uniqueCards,
    foil_count: stats.foilCount,
    sets_count: stats.uniqueSets,
    color_distribution: stats.colorDistribution,
  }
  const wins = historyRows.filter(r => r.placement === 1).length
  const profileShape = {
    collection_value: stats.totalValue,
    public_deck_count: publicDeckCount,
    game_stats: { wins, total: historyRows.length },
  }
  const earned  = MILESTONES.filter(m => m.check(statsShape, profileShape))
  const pending = MILESTONES.filter(m => !m.check(statsShape, profileShape))

  return (
    <div className={styles.chartBox}>
      <div className={styles.sectionHead}>
        <SLabel>Milestones</SLabel>
        <span className={styles.sectionCount}>{earned.length} / {MILESTONES.length} earned</span>
      </div>
      {earned.length > 0 && (
        <>
          <div className={styles.milestonesSubLabel}>Earned</div>
          <div className={styles.milestonesGrid}>
            {earned.map(m => (
              <div key={m.id} className={`${styles.milestoneCard} ${styles.milestoneEarned}`} title={m.desc}>
                <div className={styles.milestoneIcon}>{m.icon}</div>
                <div className={styles.milestoneInfo}>
                  <div className={styles.milestoneName}>{m.label}</div>
                  <div className={styles.milestoneReq}>{m.req}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {pending.length > 0 && (
        <>
          <div className={`${styles.milestonesSubLabel} ${styles.milestonesSubLabelPending}`}>In progress</div>
          <div className={styles.milestonesGrid}>
            {pending.map(m => (
              <div key={m.id} className={`${styles.milestoneCard} ${styles.milestonePending}`} title={m.desc}>
                <div className={styles.milestoneIcon}>{m.icon}</div>
                <div className={styles.milestoneInfo}>
                  <div className={styles.milestoneName}>{m.label}</div>
                  <div className={styles.milestoneReq}>{m.req}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function HistoryEntryCard({ row, deckMeta, onEdit, onDelete }) {
  const [notes, setNotes] = useState(row.notes || '')
  const [placement, setPlacement] = useState(row.placement || 1)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => { setNotes(row.notes || '') }, [row.notes])
  useEffect(() => { setPlacement(row.placement || 1) }, [row.placement])

  const players = [...(row.players_json || [])].sort((a, b) => (a.placement || 99) - (b.placement || 99))
  const playedAt = row.played_at || row.game_ended_at
  const mins = row.game_started_at && row.game_ended_at
    ? Math.round((new Date(row.game_ended_at) - new Date(row.game_started_at)) / 60000)
    : 0
  const bgUrl = safeBgUrl(deckMeta?.coverArtUri || deckMeta?.bg_url || null)

  const save = async () => {
    setSaving(true)
    try {
      await onEdit(row.id, { notes: notes.trim(), placement: Number(placement) })
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <article className={styles.historyCard}>
      {bgUrl && (
        <>
          <div className={styles.historyCardBg} style={{ backgroundImage: `url("${bgUrl}")` }} />
          <div className={styles.historyCardShade} />
        </>
      )}
      <div className={styles.historyCardContent}>
        <div className={styles.historyCardHead}>
          <div className={styles.historyCardModeRow}>
            <span className={styles.histMode}>{GAME_MODE_LABELS[row.format] ?? 'Game'}</span>
            {playedAt && (
              <span className={styles.histDate}>
                {new Date(playedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            )}
            {mins > 0 && <span className={styles.histDur}>{mins} min</span>}
          </div>
          <div className={styles.historyDeckBlock}>
            <div className={styles.historyDeckLabel}>Your Deck</div>
            <div className={styles.historyDeckName}>{row.deck_name || deckMeta?.name || 'No deck selected'}</div>
            <div className={styles.historyResultLine}>
              <span className={`${styles.historyPlacementPill} ${row.placement === 1 ? styles.historyPlacementWin : ''}`}>
                Place #{row.placement}
              </span>
              <span className={styles.historyPlayerMeta}>
                {row.player_name || 'You'}{Number.isFinite(row.final_life) ? ` · ${row.final_life} life` : ''}
              </span>
            </div>
          </div>
        </div>

        <div className={styles.historyStandings}>
          <div className={styles.historyStandingsLabel}>Final Standings</div>
          <div className={styles.historyStandingsList}>
            {players.map((p, idx) => (
              <div key={`${row.id}-${idx}`} className={styles.historyStandingRow}>
                <span className={styles.historyStandingPlace}>{p.placement}.</span>
                <span className={styles.historyStandingDot} style={{ background: p.color || 'var(--gold)' }} />
                <span className={styles.historyStandingName}>{p.name}</span>
                {p.deckName && <span className={styles.historyStandingDeck}>{p.deckName}</span>}
              </div>
            ))}
          </div>
        </div>

        {editing ? (
          <div className={styles.historyEditor}>
            <label className={styles.historyField}>
              <span>Placement</span>
              <select className={styles.historySelect} value={placement} onChange={e => setPlacement(e.target.value)}>
                {Array.from({ length: Math.max(row.player_count || players.length || 1, 1) }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className={styles.historyField}>
              <span>Private notes</span>
              <textarea
                className={styles.historyTextarea}
                rows={4}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Only visible to you"
              />
            </label>
            <div className={styles.historyEntryActions}>
              <button className={styles.historySecondaryBtn} onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
              <button className={styles.historyPrimaryBtn} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        ) : (
          <>
            {row.notes && <p className={styles.historyNotes}>{row.notes}</p>}
            <div className={styles.historyEntryActions}>
              {confirmingDelete ? (
                <>
                  <span style={{ fontSize: '0.76rem', color: 'var(--text-dim)', alignSelf: 'center' }}>Delete this entry?</span>
                  <button className={styles.historySecondaryBtn} onClick={() => setConfirmingDelete(false)}>Cancel</button>
                  <button className={styles.historyDangerBtn} onClick={() => { setConfirmingDelete(false); onDelete(row) }}>Confirm</button>
                </>
              ) : (
                <>
                  <button className={styles.historySecondaryBtn} onClick={() => setEditing(true)}>Edit</button>
                  <button className={styles.historyDangerBtn} onClick={() => setConfirmingDelete(true)}>Delete</button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  )
}

function GameHistorySection({ rows, loading, deckMap, onRefresh, onEdit, onDelete }) {
  return (
    <div className={styles.chartBox}>
      <div className={styles.sectionHead}>
        <SLabel>Game History</SLabel>
        <div className={styles.historyToolbar}>
          <span className={styles.sectionCount}>{rows.length} entries</span>
          <button className={styles.historyRefreshBtn} onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className={styles.historyEmpty}>Loading game history…</div>
      ) : rows.length === 0 ? (
        <div className={styles.historyEmpty}>No saved game history yet.</div>
      ) : (
        <div className={styles.historyList}>
          {rows.map(row => (
            <HistoryEntryCard
              key={row.id}
              row={row}
              deckMeta={deckMap[row.deck_id] || null}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const PLACEMENT_RANK_COLORS = {
  0: 'var(--gold)',
  1: '#8ab0c8',
  2: '#c47060',
  3: '#6a6a7a',
}

const PLACEMENT_LABELS = ['1st', '2nd', '3rd', '4th']
const PLACEMENT_KEYS   = ['p1',  'p2',  'p3',  'p4']

function DeckWinratesSection({ rows, loading, deckMap }) {
  const deckStats = useMemo(() => {
    if (!rows.length) return []
    const map = {}
    for (const row of rows) {
      const deckName = row.deck_name || deckMap[row.deck_id]?.name
      if (!deckName || deckName === 'No deck selected') continue
      const key = row.deck_id || `name:${row.deck_name}`
      if (!map[key]) {
        map[key] = {
          id: row.deck_id,
          name: deckName,
          games: 0, p1: 0, p2: 0, p3: 0, p4: 0,
          formats: new Set(),
        }
      }
      const d = map[key]
      d.games++
      const p = Number(row.placement) || 1
      if (p === 1) d.p1++
      else if (p === 2) d.p2++
      else if (p === 3) d.p3++
      else d.p4++
      if (row.format) d.formats.add(row.format)
    }
    return Object.values(map)
      .map(d => ({
        ...d,
        winRate: d.games > 0 ? (d.p1 / d.games) * 100 : 0,
        losses: d.games - d.p1,
        formats: [...d.formats],
      }))
      .sort((a, b) => b.winRate - a.winRate || b.games - a.games)
  }, [rows, deckMap])

  const qualifiedRows = rows.filter(r => r.deck_name || deckMap[r.deck_id]?.name)
  const totalGames    = qualifiedRows.length
  const totalWins     = qualifiedRows.filter(r => r.placement === 1).length
  const overallWinRate = totalGames > 0 ? (totalWins / totalGames) * 100 : 0

  if (loading) return (
    <div className={styles.chartBox}>
      <SLabel>Deck Win Rates</SLabel>
      <div className={styles.historyEmpty}>Loading game history…</div>
    </div>
  )

  if (!deckStats.length) return (
    <div className={styles.chartBox}>
      <SLabel>Deck Win Rates</SLabel>
      <div className={styles.historyEmpty}>No game history yet. Play some games to see deck stats.</div>
    </div>
  )

  return (
    <>
      <div className={styles.statGrid} style={{ marginBottom: 16 }}>
        <StatCard label="Games Tracked" value={totalGames.toLocaleString()} sub={`${deckStats.length} deck${deckStats.length !== 1 ? 's' : ''}`} />
        <StatCard label="Overall Win Rate" value={`${overallWinRate.toFixed(0)}%`} sub={`${totalWins}W · ${totalGames - totalWins}L`} />
        <StatCard label="Best Deck" value={deckStats[0]?.name || '—'} sub={deckStats[0] ? `${deckStats[0].winRate.toFixed(0)}% win rate` : ''} />
      </div>

      <div className={styles.chartBox}>
        <SLabel>By Deck</SLabel>
        <div className={styles.winrateLeaderboard}>
          {deckStats.map((deck, idx) => {
            const rankColor = PLACEMENT_RANK_COLORS[Math.min(idx, 3)]
            const segs = PLACEMENT_KEYS
              .map((k, i) => ({ label: PLACEMENT_LABELS[i], count: deck[k], color: PLACEMENT_COLORS[i + 1] }))
              .filter(s => s.count > 0)

            return (
              <div key={deck.id || deck.name} className={styles.winrateEntry}>
                <div className={styles.winrateEntryAccent} style={{ background: rankColor }} />

                <div className={styles.winrateEntryRank} style={{ color: rankColor }}>
                  #{idx + 1}
                </div>

                <div className={styles.winrateEntryMain}>
                  <div className={styles.winrateEntryHead}>
                    <span className={styles.winrateDeckName}>{deck.name}</span>
                    <div className={styles.winrateDeckMeta}>
                      {deck.formats.map(f => (
                        <span key={f} className={styles.winrateFormatPill}>{GAME_MODE_LABELS[f] || f}</span>
                      ))}
                      <span className={styles.winrateGameCount}>{deck.games} {deck.games === 1 ? 'Game' : 'Games'}</span>
                    </div>
                  </div>

                  <div className={styles.winrateEntryStats}>
                    <div className={styles.winrateBar}>
                      {segs.map((s, i) => (
                        <div
                          key={s.label}
                          className={`${styles.winrateBarSeg} ${i === 0 ? styles.winrateBarSegFirst : ''} ${i === segs.length - 1 ? styles.winrateBarSegLast : ''} ${segs.length === 1 ? styles.winrateBarSegOnly : ''}`}
                          style={{ flex: s.count, background: s.color }}
                          title={`${s.label}: ${s.count}`}
                        />
                      ))}
                    </div>

                    <div className={styles.winratePlacementGrid}>
                      {PLACEMENT_KEYS.map((k, i) => (
                        <div key={k} className={styles.winratePlacementCell}>
                          <span className={styles.winratePlacementDot} style={{ background: PLACEMENT_COLORS[i + 1] }} />
                          <span className={styles.winratePlacementLbl}>{PLACEMENT_LABELS[i]}</span>
                          <span className={styles.winratePlacementNum}>{deck[k]}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={styles.winrateEntryScore}>
                  <div
                    className={styles.winrateRateBig}
                    style={{
                      color: deck.winRate >= 50 ? 'var(--gold)'
                        : deck.winRate >= 25 ? 'var(--text)'
                        : 'var(--text-dim)',
                    }}
                  >
                    {deck.winRate.toFixed(0)}%
                  </div>
                  <div className={styles.winrateWL}>
                    <span className={styles.winrateW}>{deck.p1}W</span>
                    <span className={styles.winrateWLSep}>·</span>
                    <span className={styles.winrateL}>{deck.losses}L</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

const CustomTooltip = ({ active, payload, label, fmt }) => {
  if (!active || !payload?.length) return null
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipLabel}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || 'var(--gold)' }}>
          {p.name}:{' '}
          {typeof p.value === 'number' && (p.name?.includes('€') || p.name?.includes('$') || p.name?.includes('Value'))
            ? fmt(p.value)
            : p.value?.toLocaleString?.() ?? p.value}
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function StatsPage() {
  const { user }         = useAuth()
  const { price_source } = useSettings()
  const sym = getPriceSource(price_source).symbol
  const fmt = useCallback(v => formatPrice(v, price_source), [price_source])
  const windowWidth = useWindowWidth()

  const [tab,            setTab]          = useState('overview')
  const [cards,          setCards]        = useState([])
  const [sfMap,          setSfMap]        = useState({})
  const [loading,        setLoading]      = useState(true)
  const [loadProgress,   setLoadProgress] = useState(0)
  const [progLabel,      setProgLabel]    = useState('')
  const [detailCardId,   setDetailCardId] = useState(null)
  const [historyRows,      setHistoryRows]      = useState([])
  const [historyLoading,   setHistoryLoading]   = useState(false)
  const [deckMap,          setDeckMap]          = useState({})
  const [publicDeckCount,  setPublicDeckCount]  = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setLoadProgress(0)
      setProgLabel('Loading collection…')

      const allCards = await getLocalCards(user.id)
      if (cancelled) return
      setCards(allCards)
      setLoadProgress(40)

      const map = allCards.length
        ? await loadCardMapWithSharedPrices(allCards, {
            onProgress: (pct, label) => {
              if (cancelled) return
              setLoadProgress(40 + Math.round(pct * 0.6))
              if (label) setProgLabel(label)
            },
          })
        : {}
      if (cancelled) return
      setSfMap(map)
      setLoadProgress(100)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [user.id])

  useEffect(() => {
    if (!user?.id) return
    sb.from('shared_folders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .then(({ count }) => setPublicDeckCount(count || 0))
  }, [user?.id])

  const refreshHistory = useCallback(async () => {
    if (!user?.id) return
    setHistoryLoading(true)
    try {
      const [{ data: rows, error: rowsError }, { data: decks, error: decksError }] = await Promise.all([
        sb.from('game_results')
          .select('id,deck_id,deck_name,format,player_count,placement,played_at,player_name,player_color,final_life,game_started_at,game_ended_at,players_json,notes,updated_at')
          .eq('user_id', user.id)
          .order('played_at', { ascending: false })
          .limit(500),
        sb.from('folders')
          .select('id,name,description')
          .eq('user_id', user.id)
          .in('type', ['deck', 'builder_deck']),
      ])
      if (rowsError) throw rowsError
      if (decksError) throw decksError

      setHistoryRows((rows || []).map(sanitizeGameRow))
      setDeckMap(Object.fromEntries((decks || []).map(deck => [deck.id, { name: deck.name, ...parseDeckMeta(deck.description) }])))
    } catch (error) {
      console.error('[Stats] history load:', error?.message ?? String(error))
      setHistoryRows([])
      setDeckMap({})
    } finally {
      setHistoryLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    if (tab === 'history' || tab === 'winrates') refreshHistory()
  }, [tab, refreshHistory])

  const handleHistoryEdit = useCallback(async (rowId, patch) => {
    if (!user?.id) return
    const payload = { ...patch, updated_at: new Date().toISOString() }
    const { error } = await sb.from('game_results').update(payload).eq('id', rowId).eq('user_id', user.id)
    if (error) {
      console.error('[Stats] history update:', error?.message ?? String(error))
      window.alert('Could not update your game history entry.')
      return
    }
    await refreshHistory()
  }, [refreshHistory, user?.id])

  const handleHistoryDelete = useCallback(async (row) => {
    if (!user?.id) return
    const { error } = await sb.from('game_results').delete().eq('id', row.id).eq('user_id', user.id)
    if (error) {
      console.error('[Stats] history delete:', error?.message ?? String(error))
      window.alert('Could not delete your game history entry.')
      return
    }
    await refreshHistory()
  }, [refreshHistory, user?.id])

  // ── All derived stats ───────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!cards.length) return null

    let totalValue = 0, totalCost = 0, totalQty = 0
    let foilCount  = 0, foilValue = 0
    let dayChange  = 0
    const byRarity = {}, bySet = {}, byType = {}, byLanguage = {}, byCondition = {}
    const priceSourceMeta = getPriceSource(price_source)

    // Value tiers
    const TIER_BOUNDS = [0, 1, 5, 20, 50, Infinity]
    const TIER_LABELS = [`<${sym}1`, `${sym}1–5`, `${sym}5–20`, `${sym}20–50`, `${sym}50+`]
    const valueTiers  = TIER_LABELS.map(label => ({ label, count: 0, value: 0 }))

    // Format legality (unique card entries, not qty)
    const LEGALITY_FMTS = ['commander', 'modern', 'pioneer', 'standard', 'legacy', 'vintage']
    const legalCounts   = Object.fromEntries(LEGALITY_FMTS.map(f => [f, 0]))
    let hasLegalityData = false

    // Collection age
    const byYear = {}

    // Color distribution
    const byColor = {}

    // Movers + priced index for top cards
    const movingCards = []
    const allPriced = []

    for (const c of cards) {
      const key   = `${c.set_code}-${c.collector_number}`
      const sf    = sfMap[key]
      const price = getPrice(sf, c.foil, { price_source, cardId: c.id })
      const val   = price != null ? price * c.qty : 0
      const prevField = c.foil ? priceSourceMeta.foilField : priceSourceMeta.field
      const prevPrice = Number.parseFloat(sf?.prices_prev?.[prevField] || 0) || null

      totalValue += val
      totalCost  += (c.purchase_price || 0) * c.qty
      totalQty   += c.qty
      if (c.foil) { foilCount += c.qty; foilValue += val }
      if (price != null && prevPrice != null) dayChange += (price - prevPrice) * c.qty
      byLanguage[c.language || 'en'] = (byLanguage[c.language || 'en'] || 0) + c.qty
      byCondition[c.condition || 'near_mint'] = (byCondition[c.condition || 'near_mint'] || 0) + c.qty

      // Rarity
      const rarity = sf?.rarity || 'unknown'
      if (!byRarity[rarity]) byRarity[rarity] = { count: 0, value: 0 }
      byRarity[rarity].count += c.qty
      byRarity[rarity].value += val

      // Set
      const setName = sf?.set_name || c.set_code?.toUpperCase() || '?'
      if (!bySet[setName]) bySet[setName] = { count: 0, value: 0 }
      bySet[setName].count += c.qty
      bySet[setName].value += val

      // Type
      const tl   = (sf?.type_line || '').toLowerCase()
      const type = tl.includes('creature')     ? 'Creature'
                 : tl.includes('instant')      ? 'Instant'
                 : tl.includes('sorcery')      ? 'Sorcery'
                 : tl.includes('enchantment')  ? 'Enchantment'
                 : tl.includes('artifact')     ? 'Artifact'
                 : tl.includes('planeswalker') ? 'Planeswalker'
                 : tl.includes('land')         ? 'Land'
                 : tl.includes('battle')       ? 'Battle'
                 : 'Other'
      byType[type] = (byType[type] || 0) + c.qty

      // Color distribution
      const colorIdentity = sf?.color_identity || []
      if (colorIdentity.length === 0) {
        byColor['C'] = (byColor['C'] || 0) + c.qty
      } else if (colorIdentity.length > 1) {
        byColor['M'] = (byColor['M'] || 0) + c.qty
      } else {
        byColor[colorIdentity[0]] = (byColor[colorIdentity[0]] || 0) + c.qty
      }

      // Value tier bucket
      if (price != null) {
        const ti = TIER_BOUNDS.findIndex((b, i) =>
          i < TIER_BOUNDS.length - 1 && price >= b && price < TIER_BOUNDS[i + 1]
        )
        if (ti >= 0) { valueTiers[ti].count += c.qty; valueTiers[ti].value += price * c.qty }
      }

      // Format legality
      if (sf?.legalities) {
        hasLegalityData = true
        for (const f of LEGALITY_FMTS) {
          if (sf.legalities[f] === 'legal') legalCounts[f]++
        }
      }

      // Collection age
      if (sf?.released_at) {
        const yr = new Date(sf.released_at).getFullYear()
        if (!byYear[yr]) byYear[yr] = { count: 0, value: 0 }
        byYear[yr].count += c.qty
        byYear[yr].value += val
      }

      // Biggest movers (need purchase price)
      if (c.purchase_price > 0 && price != null) {
        const pl    = (price - c.purchase_price) * c.qty
        const plPct = ((price - c.purchase_price) / c.purchase_price) * 100
        movingCards.push({ ...c, _sf: sf, _price: price, _pl: pl, _plPct: plPct })
      }

      if (price != null) allPriced.push({ ...c, _sf: sf, _price: price })
    }

    // ── Derived collections ─────────────────────────────────────────────────
    const rarityData = Object.entries(byRarity).map(([name, v]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      count: v.count, value: parseFloat(v.value.toFixed(2)),
      fill: RARITY_COLORS[name] || '#6a6a7a',
    })).sort((a, b) => b.value - a.value)

    const topSets = Object.entries(bySet)
      .sort((a, b) => b[1].value - a[1].value).slice(0, 15)
      .map(([name, v]) => ({ name, count: v.count, value: parseFloat(v.value.toFixed(2)) }))

    const typeData = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, value: count }))

    const languageData = Object.entries(byLanguage)
      .sort((a, b) => b[1] - a[1])
      .map(([key, qty]) => ({ key, qty }))

    const conditionData = Object.entries(byCondition)
      .sort((a, b) => b[1] - a[1])
      .map(([key, qty]) => ({ key, qty }))

    const topCards = [...allPriced].sort((a, b) => b._price - a._price).slice(0, 20)

    const ageData = Object.entries(byYear)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([year, d]) => ({ year: String(year), count: d.count, value: parseFloat(d.value.toFixed(2)) }))

    const legalityData = hasLegalityData
      ? LEGALITY_FMTS
          .map(f => ({ name: f.charAt(0).toUpperCase() + f.slice(1), count: legalCounts[f] }))
          .filter(d => d.count > 0)
          .sort((a, b) => b.count - a.count)
      : null
    const maxLegal = legalityData ? Math.max(...legalityData.map(d => d.count)) : 1

    movingCards.sort((a, b) => b._pl - a._pl)
    const topGainers = movingCards.slice(0, 5)
    const topLosers  = [...movingCards].sort((a, b) => a._pl - b._pl).slice(0, 5)

    return {
      totalValue, totalCost, totalQty, foilCount, foilValue, dayChange,
      pl: totalValue - totalCost,
      uniqueCards: cards.length,
      uniqueSets:  Object.keys(bySet).length,
      avgCardValue: totalQty > 0 ? totalValue / totalQty : 0,
      languageData, conditionData,
      rarityData, topSets, typeData, topCards,
      valueTiers: valueTiers.filter(t => t.count > 0),
      legalityData, maxLegal,
      ageData,
      topGainers, topLosers,
      hasMoverData: movingCards.length > 0,
      colorDistribution: byColor,
    }
  }, [cards, sfMap, price_source, sym])

  const tt = (p) => <CustomTooltip {...p} fmt={fmt} />
  const selectedCard = detailCardId ? cards.find(c => c.id === detailCardId) : null
  const selectedSf   = selectedCard ? sfMap[getScryfallKey(selectedCard)] : null

  if (loading) return (
    <>
      <SectionHeader title="Collection Stats" />
      <ProgressBar
        value={loadProgress}
        label={progLabel || `Loading… ${cards.length > 0 ? `(${cards.length} cards)` : ''}`}
      />
    </>
  )
  if (!cards.length) return <EmptyState>Import your collection first to see stats.</EmptyState>

  return (
    <div className={styles.page}>
      <SectionHeader title={`Collection Stats · ${cards.length.toLocaleString()} unique cards`} />

      <div className={styles.statsTabs} role="tablist">
        <button
          role="tab" aria-selected={tab === 'overview'}
          className={`${styles.statsTabBtn} ${tab === 'overview' ? styles.statsTabBtnActive : ''}`}
          onClick={() => setTab('overview')}>
          Overview
        </button>
        <button
          role="tab" aria-selected={tab === 'winrates'}
          className={`${styles.statsTabBtn} ${tab === 'winrates' ? styles.statsTabBtnActive : ''}`}
          onClick={() => setTab('winrates')}>
          Deck Win Rates
        </button>
        <button
          role="tab" aria-selected={tab === 'history'}
          className={`${styles.statsTabBtn} ${tab === 'history' ? styles.statsTabBtnActive : ''}`}
          onClick={() => setTab('history')}>
          Game History
        </button>
      </div>

      {tab === 'history' ? (
        <GameHistorySection
          rows={historyRows}
          loading={historyLoading}
          deckMap={deckMap}
          onRefresh={refreshHistory}
          onEdit={handleHistoryEdit}
          onDelete={handleHistoryDelete}
        />
      ) : tab === 'winrates' ? (
        <DeckWinratesSection
          rows={historyRows}
          loading={historyLoading}
          deckMap={deckMap}
        />
      ) : stats && <>

        {/* ── Summary stat cards ── */}
        <div className={styles.statGrid}>
          <StatCard
            label="Total Value"
            value={fmt(stats.totalValue)}
            sub={`${stats.totalQty.toLocaleString()} total cards`}
          />
          <StatCard
            label="P&L"
            value={
              <span style={{ color: stats.pl >= 0 ? 'var(--green)' : '#e05252' }}>
                {stats.pl >= 0 ? '+' : ''}{fmt(stats.pl)}
              </span>
            }
            sub={`Cost basis: ${fmt(stats.totalCost)}`}
          />
          <StatCard
            label="24h Change"
            value={
              <span style={{ color: stats.dayChange >= 0 ? 'var(--green)' : '#e05252' }}>
                {stats.dayChange >= 0 ? '+' : ''}{fmt(stats.dayChange)}
              </span>
            }
            sub="Today vs yesterday"
          />
          <StatCard
            label="Avg Card Value"
            value={fmt(stats.avgCardValue)}
            sub="per copy owned"
          />
          <StatCard
            label="Unique Cards"
            value={stats.uniqueCards.toLocaleString()}
            sub={`across ${stats.uniqueSets} sets`}
          />
          <StatCard
            label="Foils"
            value={stats.foilCount.toLocaleString()}
            sub={`${fmt(stats.foilValue)} value`}
          />
        </div>

        {/* ── Collection value over time ── */}
        <SetCompletionSection cards={cards} sfMap={sfMap} loading={loading} />

        {/* ── Value distribution + Format legality ── */}
        <div className={stats.legalityData ? styles.chartRow : undefined}>
          <div className={styles.chartBox}>
            <SLabel>Value Distribution</SLabel>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={stats.valueTiers}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--s-border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: 'var(--text-dim)', fontSize: 11 }} />
                <YAxis tick={{ fill: 'var(--text-dim)', fontSize: 11 }} tickFormatter={v => v.toLocaleString()} />
                <Tooltip content={tt} />
                <Bar dataKey="count" name="Cards" fill="var(--gold)" radius={[3, 3, 0, 0]} opacity={0.85} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {stats.legalityData && (
            <div className={styles.chartBox}>
              <SLabel>Format Legality</SLabel>
              <div className={styles.legalityList}>
                {stats.legalityData.map(d => (
                  <div key={d.name} className={styles.legalityRow}>
                    <span className={styles.legalityFormat}>{d.name}</span>
                    <div className={styles.legalityTrack}>
                      <div
                        className={styles.legalityFill}
                        style={{
                          width: `${(d.count / stats.maxLegal) * 100}%`,
                          background: FORMAT_COLORS[d.name] || 'var(--gold)',
                        }}
                      />
                    </div>
                    <span className={styles.legalityCount}>{d.count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Biggest movers ── */}
        {stats.hasMoverData && (
          <div className={styles.chartRow}>
            <div className={styles.chartBox}>
              <SLabel>Biggest Gainers</SLabel>
              <div className={styles.moverList}>
                {stats.topGainers.length > 0 && (
                  <div className={styles.moverHead}>
                    <span className={styles.moverHeadCard}>Card</span>
                    <span className={styles.moverHeadStat}>Change</span>
                    <span className={styles.moverHeadStat}>Price</span>
                    <span className={styles.moverHeadStat}>P&amp;L</span>
                  </div>
                )}
                {stats.topGainers.map(c => (
                  <MoverRow key={c.id} card={c} tone="positive" onOpen={setDetailCardId} fmt={fmt} />
                ))}
                {stats.topGainers.length === 0 && (
                  <div className={styles.moverEmpty}>No gainers tracked yet.</div>
                )}
              </div>
            </div>
            <div className={styles.chartBox}>
              <SLabel>Biggest Losers</SLabel>
              <div className={styles.moverList}>
                {stats.topLosers.length > 0 && (
                  <div className={styles.moverHead}>
                    <span className={styles.moverHeadCard}>Card</span>
                    <span className={styles.moverHeadStat}>Change</span>
                    <span className={styles.moverHeadStat}>Price</span>
                    <span className={styles.moverHeadStat}>P&amp;L</span>
                  </div>
                )}
                {stats.topLosers.map(c => (
                  <MoverRow key={c.id} card={c} tone="negative" onOpen={setDetailCardId} fmt={fmt} />
                ))}
                {stats.topLosers.length === 0 && (
                  <div className={styles.moverEmpty}>No losers tracked yet.</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Collection age spread ── */}
        {stats.ageData.length > 1 && (
          <div className={styles.chartBox}>
            <SLabel>Collection Age Spread</SLabel>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={stats.ageData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--s-border)" vertical={false} />
                <XAxis dataKey="year" tick={{ fill: 'var(--text-dim)', fontSize: 10 }} interval={1} />
                <YAxis tick={{ fill: 'var(--text-dim)', fontSize: 11 }} tickFormatter={v => v.toLocaleString()} width={50} />
                <Tooltip content={tt} />
                <Bar dataKey="count" name="Cards" fill="var(--purple, #8a6fc4)" radius={[2, 2, 0, 0]} opacity={0.85} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ── Value by rarity + Cards by type ── */}
        <div className={styles.chartRow}>
          <div className={styles.chartBox}>
            <SLabel>Value by Rarity</SLabel>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={stats.rarityData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--s-border)" horizontal={false} />
                <XAxis type="number" tick={{ fill: 'var(--text-dim)', fontSize: 11 }} tickFormatter={v => fmt(v)} />
                <YAxis type="category" dataKey="name" tick={{ fill: 'var(--text-dim)', fontSize: 11 }} width={72} />
                <Tooltip content={tt} />
                <Bar dataKey="value" name={`${sym} Value`} radius={2}>
                  {stats.rarityData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className={styles.chartBox}>
            <SLabel>Cards by Type</SLabel>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={stats.typeData} dataKey="value" nameKey="name"
                  cx="50%" cy="50%"
                  outerRadius={windowWidth < 480 ? 60 : 78}
                  paddingAngle={2}
                  label={windowWidth < 480
                    ? ({ percent }) => `${(percent * 100).toFixed(0)}%`
                    : ({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {stats.typeData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className={styles.chartRow}>
          <div className={styles.chartBox}>
            <SLabel>Language Distribution</SLabel>
            <DistributionBars items={stats.languageData} total={stats.totalQty} labels={LANGUAGE_LABELS} />
          </div>

          <div className={styles.chartBox}>
            <SLabel>Condition Distribution</SLabel>
            <DistributionBars items={stats.conditionData} total={stats.totalQty} labels={CONDITION_LABELS} />
          </div>
        </div>

        <div className={styles.chartBox}>
          <SLabel>Color Distribution</SLabel>
          <ColorDistributionBars byColor={stats.colorDistribution} totalQty={stats.totalQty} />
        </div>

        <MilestonesSection stats={stats} historyRows={historyRows} publicDeckCount={publicDeckCount} />

        <div className={styles.chartBox}>
          <SLabel>Top 20 Most Valuable Cards</SLabel>
          <TopValuableShowcase cards={stats.topCards} fmt={fmt} onOpen={setDetailCardId} />
        </div>

        {/* ── Top 15 sets by value ── */}
        <div className={styles.chartBox}>
          <SLabel>Top 15 Sets by Value</SLabel>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={stats.topSets} margin={{ bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--s-border)" />
              <XAxis
                dataKey="name"
                tick={{ fill: 'var(--text-dim)', fontSize: 10, angle: -35, textAnchor: 'end' }}
                interval={0} height={70}
              />
              <YAxis tick={{ fill: 'var(--text-dim)', fontSize: 11 }} tickFormatter={v => `${sym}${v}`} width={62} />
              <Tooltip content={tt} />
              <Bar dataKey="value" name={`${sym} Value`} fill="var(--purple, #8a6fc4)" radius={2} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {selectedCard && (
          <CardDetail
            card={selectedCard}
            sfCard={selectedSf}
            priceSource={price_source}
            readOnly
            onClose={() => setDetailCardId(null)}
          />
        )}

      </>}
    </div>
  )
}
