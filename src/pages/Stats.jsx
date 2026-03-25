import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { getInstantCache, enrichCards, getPrice, formatPrice } from '../lib/scryfall'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { EmptyState, SectionHeader, ProgressBar } from '../components/UI'
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
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
  const [snapshots,    setSnapshots]    = useState([])
  const [loading,      setLoading]      = useState(true)
  const [loadProgress, setLoadProgress] = useState(0)
  const [progLabel,    setProgLabel]    = useState('')

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

      const { data: snaps } = await sb.from('price_snapshots')
        .select('*').eq('user_id', user.id).order('taken_at').limit(90)

      setCards(allCards)

      let cached = await getInstantCache()
      if (!cached && allCards.length) {
        setProgLabel('Fetching card data…')
        cached = await enrichCards(allCards, (pct, label) => {
          setLoadProgress(40 + Math.round(pct * 0.6))
          if (label) setProgLabel(label)
        })
      }
      setSfMap(cached || {})
      setSnapshots(snaps || [])
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
    const byRarity = {}, bySet = {}, byType = {}

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

      totalValue += val
      totalCost  += (c.purchase_price || 0) * c.qty
      totalQty   += c.qty
      if (c.foil) { foilCount += c.qty; foilValue += val }

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

    const snapshotData = snapshots.map(s => ({
      date: new Date(s.taken_at).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }),
      [`${sym} Value`]: parseFloat(s.value_eur),
    }))

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
      totalValue, totalCost, totalQty, foilCount, foilValue,
      pl: totalValue - totalCost,
      uniqueCards: cards.length,
      uniqueSets:  Object.keys(bySet).length,
      avgCardValue: totalQty > 0 ? totalValue / totalQty : 0,
      rarityData, topSets, typeData, snapshotData, topCards,
      valueTiers: valueTiers.filter(t => t.count > 0),
      legalityData, maxLegal,
      ageData,
      topGainers, topLosers,
      hasMoverData: movingCards.length > 0,
    }
  }, [cards, sfMap, snapshots, price_source, sym])

  const tt = (p) => <CustomTooltip {...p} fmt={fmt} />

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
        {stats.snapshotData.length > 1 && (
          <div className={styles.chartBox}>
            <SLabel>Collection Value Over Time</SLabel>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={stats.snapshotData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="date" tick={{ fill: 'var(--text-dim)', fontSize: 11 }} />
                <YAxis tick={{ fill: 'var(--text-dim)', fontSize: 11 }} tickFormatter={v => fmt(v)} width={68} />
                <Tooltip content={tt} />
                <Line type="monotone" dataKey={`${sym} Value`} stroke="var(--gold)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

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
                {stats.topGainers.map(c => (
                  <div key={c.id} className={styles.moverRow}>
                    <CardThumb sf={c._sf} size={26} />
                    <span className={styles.moverName}>
                      {c._sf?.name || `${c.set_code?.toUpperCase()}-${c.collector_number}`}
                    </span>
                    <span className={styles.moverPct} style={{ color: 'var(--green, #5dba70)' }}>
                      +{c._plPct.toFixed(0)}%
                    </span>
                    <span className={styles.moverVal} style={{ color: 'var(--green, #5dba70)' }}>
                      +{fmt(c._pl)}
                    </span>
                  </div>
                ))}
                {stats.topGainers.length === 0 && (
                  <div className={styles.moverEmpty}>No gainers tracked yet.</div>
                )}
              </div>
            </div>
            <div className={styles.chartBox}>
              <SLabel>Biggest Losers</SLabel>
              <div className={styles.moverList}>
                {stats.topLosers.map(c => (
                  <div key={c.id} className={styles.moverRow}>
                    <CardThumb sf={c._sf} size={26} />
                    <span className={styles.moverName}>
                      {c._sf?.name || `${c.set_code?.toUpperCase()}-${c.collector_number}`}
                    </span>
                    <span className={styles.moverPct} style={{ color: '#e05252' }}>
                      {c._plPct.toFixed(0)}%
                    </span>
                    <span className={styles.moverVal} style={{ color: '#e05252' }}>
                      {fmt(c._pl)}
                    </span>
                  </div>
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
                  cx="50%" cy="50%" outerRadius={78} paddingAngle={2}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
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
        <div className={styles.chartBox}>
          <SLabel>Top 20 Most Valuable Cards</SLabel>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {['#', 'Card', 'Set', 'Foil', 'Qty', 'Price', 'Total'].map(h => (
                    <th
                      key={h} className={styles.th}
                      style={{ textAlign: ['#', 'Foil', 'Qty'].includes(h) ? 'center' : 'left' }}
                    >{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.topCards.map((c, i) => (
                  <tr key={c.id} className={styles.tr}>
                    <td className={styles.tdRank}>{i + 1}</td>
                    <td className={styles.tdCard}>
                      <div className={styles.tdCardInner}>
                        <CardThumb sf={c._sf} size={26} />
                        <span className={styles.tdCardName}>
                          {c._sf?.name || `${c.set_code?.toUpperCase()}-${c.collector_number}`}
                        </span>
                        {c.foil && <span className={styles.foilTag}>FOIL</span>}
                      </div>
                    </td>
                    <td className={styles.tdSet}>{c._sf?.set_name || (c.set_code || '').toUpperCase()}</td>
                    <td className={styles.tdCenter} style={{ color: c.foil ? '#c8a0ff' : 'var(--text-faint)' }}>
                      {c.foil ? '✦' : '—'}
                    </td>
                    <td className={styles.tdCenter}>{c.qty}</td>
                    <td style={{ padding: '6px 10px', color: c.foil ? '#c8a0ff' : 'var(--green, #5dba70)' }}>
                      {fmt(c._price)}
                    </td>
                    <td className={styles.tdTotal}>{fmt(c._price * c.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

      </>}
    </div>
  )
}
