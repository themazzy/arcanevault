import { useEffect, useMemo, useRef, useState } from 'react'
import { expandSeries, fetchPriceHistory, priceBounds, summarize, toSegments } from '../lib/priceHistory'
import styles from './PriceHistoryChart.module.css'

/**
 * Cardmarket price over the stored window, for one printing and one finish.
 *
 * ONE series, so there is no legend — the heading names it. Showing normal and
 * foil together was rejected: card detail is about a specific owned copy, the
 * card already knows its own finish, and a second line would need a legend plus
 * a second scale's worth of vertical range for two numbers that are rarely
 * compared.
 *
 * Gaps are drawn as gaps (one path per run of priced days). A line bridging a
 * week with no Cardmarket listing invents market data that never existed.
 */

const VIEW_W = 560
const VIEW_H = 150
const PAD = { top: 10, right: 10, bottom: 20, left: 44 }

function formatEur(v) {
  return `€${v.toFixed(2)}`
}

function formatDay(iso) {
  const [, m, d] = iso.split('-')
  return `${Number(d)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]}`
}

export default function PriceHistoryChart({ scryfallId, foil = false }) {
  const [row, setRow] = useState(undefined)   // undefined = loading, null = none
  const [hover, setHover] = useState(null)
  const svgRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setRow(undefined)
    if (!scryfallId) { setRow(null); return undefined }
    fetchPriceHistory(scryfallId)
      .then(data => { if (!cancelled) setRow(data) })
      .catch(() => { if (!cancelled) setRow(null) })
    return () => { cancelled = true }
  }, [scryfallId])

  const points = useMemo(() => (row ? expandSeries(row, foil) : []), [row, foil])
  const stats = useMemo(() => summarize(points), [points])
  const segments = useMemo(() => toSegments(points), [points])
  const bounds = useMemo(() => (stats ? priceBounds(stats.min, stats.max) : null), [stats])

  const plotW = VIEW_W - PAD.left - PAD.right
  const plotH = VIEW_H - PAD.top - PAD.bottom

  const xOf = i => PAD.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2)
  const yOf = v => PAD.top + plotH - ((v - bounds.lo) / (bounds.hi - bounds.lo)) * plotH

  if (row === undefined) return <div className={styles.skeleton} aria-hidden="true" />
  if (!stats || !bounds) {
    return (
      <p className={styles.empty}>
        No price history for this printing{foil ? ' in foil' : ''}.
      </p>
    )
  }

  const pathFor = seg => seg
    .map((p, i) => `${i ? 'L' : 'M'}${xOf(points.indexOf(p)).toFixed(1)} ${yOf(p.price).toFixed(1)}`)
    .join(' ')

  // Area sits under the longest run only; filling across a gap would shade days
  // that have no price.
  const longest = segments.reduce((a, b) => (b.length > a.length ? b : a), segments[0])
  const areaPath = longest.length > 1
    ? `${pathFor(longest)} L${xOf(points.indexOf(longest[longest.length - 1])).toFixed(1)} ${(PAD.top + plotH).toFixed(1)}`
      + ` L${xOf(points.indexOf(longest[0])).toFixed(1)} ${(PAD.top + plotH).toFixed(1)} Z`
    : null

  const up = stats.change >= 0
  const gridValues = [bounds.hi, (bounds.hi + bounds.lo) / 2, bounds.lo]

  function onMove(e) {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * VIEW_W
    const ratio = (x - PAD.left) / plotW
    const idx = Math.round(ratio * (points.length - 1))
    const p = points[Math.max(0, Math.min(points.length - 1, idx))]
    setHover(p && p.price != null ? p : null)
  }

  return (
    <figure className={styles.figure}>
      <figcaption className={styles.head}>
        <span className={styles.label}>
          Cardmarket{foil ? ' foil' : ''} · last {stats.count} days
        </span>
        <span className={styles.headline}>
          <span className={styles.now}>{formatEur(stats.last.price)}</span>
          <span className={up ? styles.up : styles.down}>
            {up ? '▲' : '▼'} {formatEur(Math.abs(stats.change))}
            {stats.changePct != null && ` (${up ? '+' : '−'}${Math.abs(stats.changePct).toFixed(1)}%)`}
          </span>
        </span>
      </figcaption>

      <svg
        ref={svgRef}
        className={styles.svg}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={
          `Cardmarket${foil ? ' foil' : ''} price over ${stats.count} days: `
          + `from ${formatEur(stats.first.price)} on ${stats.first.date} `
          + `to ${formatEur(stats.last.price)} on ${stats.last.date}. `
          + `Low ${formatEur(stats.min)}, high ${formatEur(stats.max)}.`
        }
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {gridValues.map((v, i) => (
          <g key={i}>
            <line
              className={styles.grid}
              x1={PAD.left} x2={VIEW_W - PAD.right}
              y1={yOf(v)} y2={yOf(v)}
            />
            <text className={styles.axisText} x={PAD.left - 6} y={yOf(v) + 3} textAnchor="end">
              {v >= 100 ? Math.round(v) : v.toFixed(2)}
            </text>
          </g>
        ))}

        {areaPath && <path className={styles.area} d={areaPath} />}
        {segments.map((seg, i) =>
          seg.length > 1
            ? <path key={i} className={styles.line} d={pathFor(seg)} />
            : <circle key={i} className={styles.dot} cx={xOf(points.indexOf(seg[0]))} cy={yOf(seg[0].price)} r="2.5" />
        )}

        <circle className={styles.endpoint} cx={xOf(points.indexOf(stats.last))} cy={yOf(stats.last.price)} r="3.5" />

        {hover && (
          <g>
            <line
              className={styles.crosshair}
              x1={xOf(points.indexOf(hover))} x2={xOf(points.indexOf(hover))}
              y1={PAD.top} y2={PAD.top + plotH}
            />
            <circle className={styles.hoverDot} cx={xOf(points.indexOf(hover))} cy={yOf(hover.price)} r="4" />
          </g>
        )}

        <text className={styles.axisText} x={PAD.left} y={VIEW_H - 5}>{formatDay(stats.first.date)}</text>
        <text className={styles.axisText} x={VIEW_W - PAD.right} y={VIEW_H - 5} textAnchor="end">
          {formatDay(stats.last.date)}
        </text>
      </svg>

      <div className={styles.readout} aria-live="polite">
        {hover
          ? <><strong>{formatEur(hover.price)}</strong> on {formatDay(hover.date)}</>
          : <>Low {formatEur(stats.min)} · High {formatEur(stats.max)}</>}
      </div>
    </figure>
  )
}
