import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { getPrice, formatPrice, getScryfallKey, getPriceSource } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { CardDetail } from '../components/CardComponents'
import { EmptyState, SectionHeader, ProgressBar } from '../components/UI'
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

const SETS_CACHE_KEY = 'av_scryfall_sets'
const SETS_CACHE_TTL = 24 * 60 * 60 * 1000
const LOCAL_SET_ICONS = new Set((setIconManifest?.icons || []).map(code => String(code).toLowerCase()))

async function fetchScryfallSetsMap() {
  try {
    const raw = localStorage.getItem(SETS_CACHE_KEY)
    if (raw) {
      const { ts, data } = JSON.parse(raw)
      if (Date.now() - ts < SETS_CACHE_TTL) return data
    }
    const r = await fetch('https://api.scryfall.com/sets')
    const json = await r.json()
    const data = {}
    for (const s of (json.data || [])) data[s.code] = { name: s.name, count: s.card_count }
    localStorage.setItem(SETS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }))
    return data
  } catch {
    return {}
  }
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
  return code ? `/set-icons/${String(code).toLowerCase()}.svg` : ''
}
function getRemoteSetIconUrl(code) {
  return code ? `https://svgs.scryfall.io/sets/${String(code).toLowerCase()}.svg` : ''
}

function SetIcon({ code }) {
  const localUrl = getSetIconUrl(code)
  const remoteUrl = getRemoteSetIconUrl(code)
  const hasLocalIcon = !!(code && LOCAL_SET_ICONS.has(String(code).toLowerCase()))

  if (hasLocalIcon) {
    return (
      <span
        className={styles.setRowIcon}
        style={{ '--set-icon': `url("${localUrl}")` }}
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
    return Object.values(map)
  }, [cards, sfMap])

  useEffect(() => {
    if (ownedBySet.length) fetchScryfallSetsMap().then(setSetsMap)
  }, [ownedBySet.length])

  const rows = useMemo(() => {
    return ownedBySet.map(s => {
      const total = setsMap?.[s.code]?.count || null
      const pct = total ? Math.min(100, Math.round((s.nums.size / total) * 100)) : null
      return { code: s.code, name: setsMap?.[s.code]?.name || s.name, owned: s.nums.size, total, pct }
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
                {expanded ? '▲ Show less' : `▼ Show all ${rows.length} sets`}
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
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.07)',
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
  const sym = price_source === 'tcgplayer_market' ? '$' : '€'
  const fmt = v => formatPrice(v, price_source)

  const [cards,        setCards]        = useState([])
  const [sfMap,        setSfMap]        = useState({})
  const [loading,      setLoading]      = useState(true)
  const [loadProgress, setLoadProgress] = useState(0)
  const [progLabel,    setProgLabel]    = useState('')
  const [detailCardId, setDetailCardId] = useState(null)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setLoadProgress(0)

      let allCards = [], from = 0, pageNum = 0
      setProgLabel('Loading collection…')
      while (true) {
        const { data, error } = await sb.from('cards')
          .select('id,set_code,collector_number,foil,qty,purchase_price,condition,language')
          .eq('user_id', user.id)
          .range(from, from + 999)
        if (error || !data?.length) break
        allCards = [...allCards, ...data]
        pageNum++
        setLoadProgress(Math.min(40, pageNum * 8))
        if (data.length < 1000) break
        from += 1000
      }

      setCards(allCards)

      const map = allCards.length
        ? await loadCardMapWithSharedPrices(allCards, {
            onProgress: (pct, label) => {
              setLoadProgress(40 + Math.round(pct * 0.6))
              if (label) setProgLabel(label)
            },
          })
        : {}
      setSfMap(map)
      setLoadProgress(100)
      setLoading(false)
    }
    load()
  }, [user.id])

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

    // Movers
    const movingCards = []

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

    // ── BUG FIX: name + image come from _sf, NOT c.name ────────────────────
    const topCards = [...cards]
      .map(c => {
        const sf    = sfMap[`${c.set_code}-${c.collector_number}`]
        const price = getPrice(sf, c.foil, { price_source, cardId: c.id })
        return { ...c, _sf: sf, _price: price }
      })
      .filter(c => c._price != null)
      .sort((a, b) => b._price - a._price)
      .slice(0, 20)

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

      {stats && <>

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
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
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
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
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
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
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
                  outerRadius={window.innerWidth < 480 ? 60 : 78}
                  paddingAngle={2}
                  label={window.innerWidth < 480
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

        {/* ── Top 20 most valuable cards — BUG FIXED ── */}
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
          <SLabel>Top 20 Most Valuable Cards</SLabel>
          <TopValuableShowcase cards={stats.topCards} fmt={fmt} onOpen={setDetailCardId} />
        </div>

        {/* ── Top 15 sets by value ── */}
        <div className={styles.chartBox}>
          <SLabel>Top 15 Sets by Value</SLabel>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={stats.topSets} margin={{ bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
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
