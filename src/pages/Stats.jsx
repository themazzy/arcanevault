import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { getInstantCache, enrichCards, getPrice, formatPrice } from '../lib/scryfall'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { EmptyState, SectionHeader, ProgressBar } from '../components/UI'
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts'
import styles from './Stats.module.css'

const RARITY_COLORS = {
  common: '#6a6a7a', uncommon: '#8ab0c8', rare: '#c9a84c', mythic: '#c46030', special: '#8a6fc4'
}
const PIE_COLORS = ['#c9a84c', '#8a6fc4', '#8ab87a', '#c46060', '#5a9ab0', '#c47060', '#7a8ac0']

function StatCard({ label, value, sub }) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  )
}

const CustomTooltip = ({ active, payload, label, sym }) => {
  if (!active || !payload?.length) return null
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipLabel}>{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color || 'var(--gold)' }}>
          {p.name}: {typeof p.value === 'number' && p.name.includes(sym) ? `${sym}${p.value.toFixed(2)}` : p.value}
        </div>
      ))}
    </div>
  )
}

export default function StatsPage() {
  const { user } = useAuth()
  const { price_source, display_currency } = useSettings()
  const sym = display_currency === 'USD' ? '$' : '€'
  const fmt = v => formatPrice(v, price_source, display_currency)

  const [cards, setCards]         = useState([])
  const [sfMap, setSfMap]         = useState({})
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading]     = useState(true)
  const [loadProgress, setLoadProgress] = useState(0)
  const [progLabel, setProgLabel] = useState('')

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setLoadProgress(0)

      // Paginated card fetch — no 1000-row limit
      // Phase 1: DB fetch reports 0 → 40%
      let allCards = [], from = 0, pageNum = 0
      const PAGE = 1000
      setProgLabel('Loading collection…')
      while (true) {
        const { data, error } = await sb.from('cards')
          .select('id,set_code,collector_number,foil,qty,purchase_price,condition,language')
          .eq('user_id', user.id)
          .range(from, from + PAGE - 1)
        if (error || !data?.length) break
        allCards = [...allCards, ...data]
        pageNum++
        // 8% per page, capped at 40% — progress grows as pages are fetched
        setLoadProgress(Math.min(40, pageNum * 8))
        if (data.length < PAGE) break
        from += PAGE
      }

      const { data: snaps } = await sb.from('price_snapshots')
        .select('*').eq('user_id', user.id).order('taken_at').limit(90)

      setCards(allCards)

      // Phase 2: Scryfall enrichment reports 40 → 100%
      // Try instant cache first; if empty, run a full enrichment
      let cached = await getInstantCache()
      if (!cached && allCards.length) {
        setProgLabel('Fetching card data…')
        cached = await enrichCards(allCards, (pct, label) => {
          // Map enrichCards 0–100 into the 40–100 window so bar never goes backwards
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

  const stats = useMemo(() => {
    if (!cards.length) return null
    let totalValue = 0, totalCost = 0, totalQty = 0
    let foilCount = 0, foilValue = 0
    const byRarity = {}, bySet = {}, byType = {}

    for (const c of cards) {
      const sf  = sfMap[`${c.set_code}-${c.collector_number}`]
      const price = getPrice(sf, c.foil, { price_source, cardId: c.id })
      const val   = price != null ? price * c.qty : 0
      totalValue += val
      totalCost  += (c.purchase_price || 0) * c.qty
      totalQty   += c.qty
      if (c.foil) { foilCount += c.qty; foilValue += val }

      const rarity = sf?.rarity || 'unknown'
      if (!byRarity[rarity]) byRarity[rarity] = { count: 0, value: 0 }
      byRarity[rarity].count += c.qty; byRarity[rarity].value += val

      const setName = sf?.set_name || c.set_code?.toUpperCase() || '?'
      if (!bySet[setName]) bySet[setName] = { count: 0, value: 0 }
      bySet[setName].count += c.qty; bySet[setName].value += val

      const tl = (sf?.type_line || '').toLowerCase()
      const type = tl.includes('creature') ? 'Creature'
        : tl.includes('instant')     ? 'Instant'
        : tl.includes('sorcery')     ? 'Sorcery'
        : tl.includes('enchantment') ? 'Enchantment'
        : tl.includes('artifact')    ? 'Artifact'
        : tl.includes('planeswalker')? 'Planeswalker'
        : tl.includes('land')        ? 'Land'
        : tl.includes('battle')      ? 'Battle'
        : 'Other'
      byType[type] = (byType[type] || 0) + c.qty
    }

    const rarityData = Object.entries(byRarity).map(([name, v]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      count: v.count, value: parseFloat(v.value.toFixed(2)),
      fill: RARITY_COLORS[name] || '#6a6a7a'
    })).sort((a, b) => b.value - a.value)

    const topSets = Object.entries(bySet)
      .sort((a, b) => b[1].value - a[1].value).slice(0, 15)
      .map(([name, v]) => ({ name, count: v.count, value: parseFloat(v.value.toFixed(2)) }))

    const typeData = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, value: count }))

    const snapshotData = snapshots.map(s => ({
      date: new Date(s.taken_at).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }),
      [`${sym} Value`]: parseFloat(s.value_eur)
    }))

    const topCards = [...cards]
      .map(c => {
        const sf    = sfMap[`${c.set_code}-${c.collector_number}`]
        const price = getPrice(sf, c.foil, { price_source, cardId: c.id })
        return { ...c, _price: price, _sf: sf }
      })
      .filter(c => c._price != null)
      .sort((a, b) => b._price - a._price)
      .slice(0, 20)

    return {
      totalValue, totalCost, totalQty, foilCount, foilValue,
      pl: totalValue - totalCost,
      uniqueCards: cards.length,
      uniqueSets: Object.keys(bySet).length,
      rarityData, topSets, typeData, snapshotData, topCards
    }
  }, [cards, sfMap, snapshots, price_source, display_currency])

  const tt = (p) => <CustomTooltip {...p} sym={sym} />

  if (loading) return (
    <>
      <SectionHeader title="Collection Stats" />
      <ProgressBar value={loadProgress} label={progLabel || `Loading cards… ${cards.length > 0 ? `(${cards.length} so far)` : ''}`} />
    </>
  )
  if (!cards.length) return <EmptyState>Import your collection first to see stats.</EmptyState>

  return (
    <div>
      <SectionHeader title={`Collection Stats · ${cards.length.toLocaleString()} unique cards`} />

      {stats && <>
        <div className={styles.statGrid}>
          <StatCard label="Total Value"   value={fmt(stats.totalValue)}  sub={`${stats.totalQty.toLocaleString()} total cards`} />
          <StatCard label="P&L"           value={<span style={{ color: stats.pl >= 0 ? 'var(--green)' : '#e05252' }}>{stats.pl >= 0 ? '+' : ''}{fmt(stats.pl)}</span>} sub={`Cost basis: ${fmt(stats.totalCost)}`} />
          <StatCard label="Unique Cards"  value={stats.uniqueCards.toLocaleString()} sub={`across ${stats.uniqueSets} sets`} />
          <StatCard label="Foils"         value={stats.foilCount.toLocaleString()} sub={`${fmt(stats.foilValue)} value`} />
        </div>

        {stats.snapshotData.length > 1 && (
          <div className={styles.chartBox}>
            <div className={styles.chartTitle}>Collection Value Over Time</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={stats.snapshotData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="date" tick={{ fill: 'var(--text-dim)', fontSize: 11 }} />
                <YAxis tick={{ fill: 'var(--text-dim)', fontSize: 11 }} tickFormatter={v => fmt(v)} width={65} />
                <Tooltip content={tt} />
                <Line type="monotone" dataKey={`${sym} Value`} stroke="var(--gold)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className={styles.chartRow}>
          <div className={styles.chartBox}>
            <div className={styles.chartTitle}>Value by Rarity</div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={stats.rarityData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
                <XAxis type="number" tick={{ fill: 'var(--text-dim)', fontSize: 11 }} tickFormatter={v => fmt(v)} />
                <YAxis type="category" dataKey="name" tick={{ fill: 'var(--text-dim)', fontSize: 11 }} width={70} />
                <Tooltip content={tt} />
                <Bar dataKey="value" name={`${sym} Value`} radius={2}>
                  {stats.rarityData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className={styles.chartBox}>
            <div className={styles.chartTitle}>Cards by Type</div>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={stats.typeData} dataKey="value" nameKey="name" cx="50%" cy="50%"
                  outerRadius={80} paddingAngle={2}
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

        <div className={styles.chartBox}>
          <div className={styles.chartTitle}>Top 20 Most Valuable Cards</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  {['#', 'Card', 'Set', 'Foil', 'Qty', 'Price', 'Total'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', textAlign: h === '#' || h === 'Qty' ? 'center' : 'left', color: 'var(--text-dim)', fontFamily: 'var(--font-display)', fontSize: '0.68rem', letterSpacing: '0.07em', textTransform: 'uppercase', fontWeight: 400 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.topCards.map((c, i) => (
                  <tr key={c.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '7px 10px', textAlign: 'center', color: 'var(--text-faint)', width: 30 }}>{i + 1}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--gold)', fontFamily: 'var(--font-display)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--text-faint)', fontSize: '0.75rem' }}>{c._sf?.set_name || (c.set_code || '').toUpperCase()}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'center', color: c.foil ? '#c8a0ff' : 'var(--text-faint)' }}>{c.foil ? '✦' : '—'}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'center', color: 'var(--text-dim)' }}>{c.qty}</td>
                    <td style={{ padding: '7px 10px', color: c.foil ? '#c8a0ff' : 'var(--green)' }}>{fmt(c._price)}</td>
                    <td style={{ padding: '7px 10px', color: 'var(--green)', fontWeight: 600 }}>{fmt(c._price * c.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className={styles.chartBox}>
          <div className={styles.chartTitle}>Top 15 Sets by Value</div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={stats.topSets} margin={{ bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="name" tick={{ fill: 'var(--text-dim)', fontSize: 10, angle: -35, textAnchor: 'end' }} interval={0} height={70} />
              <YAxis tick={{ fill: 'var(--text-dim)', fontSize: 11 }} tickFormatter={v => `${sym}${v}`} width={60} />
              <Tooltip content={tt} />
              <Bar dataKey="value" name={`${sym} Value`} fill="var(--purple)" radius={2} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </>}
    </div>
  )
}
