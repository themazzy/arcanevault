import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  bridgeShortGaps,
  expandSeries,
  fetchPriceHistory,
  niceTicks,
  priceBounds,
  summarize,
  toSegments,
} from '../lib/priceHistory'
import styles from './PriceHistoryChart.module.css'

/**
 * Cardmarket price over the stored window, for one printing and one finish.
 *
 * ONE series, so no legend — the heading names it. Normal and foil are not
 * drawn together: card detail is about a specific owned copy, the card knows
 * its own finish, and a second line costs a legend plus vertical range for two
 * numbers that are rarely compared.
 *
 * SIZING: the SVG is measured and drawn at 1 unit = 1 px. It previously used a
 * fixed viewBox with preserveAspectRatio="none", which stretched the drawing
 * horizontally to fill the panel — turning every marker into an ellipse and
 * smearing the axis text. A viewBox is only safe here if the aspect is
 * preserved, and this chart has to be full-width at any panel size.
 */

const HEIGHT = 168
const PAD = { top: 12, right: 14, bottom: 22, left: 52 }
const MIN_WIDTH = 280

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatEur(v) {
  return `€${v.toFixed(2)}`
}

function formatDay(iso) {
  const [, m, d] = iso.split('-')
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`
}

function formatTick(v) {
  if (v >= 1000) return Math.round(v).toLocaleString()
  if (v >= 100) return v.toFixed(0)
  if (v >= 10) return v.toFixed(1)
  return v.toFixed(2)
}

export default function PriceHistoryChart({ scryfallId, foil = false }) {
  const [row, setRow] = useState(undefined)     // undefined = loading, null = none
  const [hoverIdx, setHoverIdx] = useState(null)
  const [width, setWidth] = useState(0)
  const wrapRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    setRow(undefined)
    setHoverIdx(null)
    if (!scryfallId) { setRow(null); return undefined }
    fetchPriceHistory(scryfallId)
      .then(data => { if (!cancelled) setRow(data) })
      .catch(() => { if (!cancelled) setRow(null) })
    return () => { cancelled = true }
  }, [scryfallId])

  // Measured rather than stretched, so markers stay round and text stays put.
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const apply = () => setWidth(Math.max(MIN_WIDTH, el.clientWidth))
    apply()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [row])

  const points = useMemo(() => (row ? bridgeShortGaps(expandSeries(row, foil)) : []), [row, foil])
  const stats = useMemo(() => summarize(points), [points])
  const segments = useMemo(() => toSegments(points), [points])
  const bounds = useMemo(() => (stats ? priceBounds(stats.min, stats.max) : null), [stats])
  const ticks = useMemo(() => (bounds ? niceTicks(bounds.lo, bounds.hi, 3) : []), [bounds])

  const plotW = Math.max(1, width - PAD.left - PAD.right)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const xOf = i => PAD.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2)
  const yOf = v => PAD.top + plotH - ((v - bounds.lo) / (bounds.hi - bounds.lo)) * plotH

  const tone = foil ? styles.foil : styles.normal

  if (row === undefined) {
    return <div ref={wrapRef} className={styles.skeleton} aria-hidden="true" />
  }
  if (!stats || !bounds) {
    return (
      <div ref={wrapRef} className={styles.empty}>
        No price history recorded for this printing{foil ? ' in foil' : ''}.
      </div>
    )
  }

  const lineFor = seg => seg
    .map((p, i) => `${i ? 'L' : 'M'}${xOf(p.index).toFixed(1)} ${yOf(p.price).toFixed(1)}`)
    .join(' ')

  // One area per run, not one for the longest: a single fill spanning the whole
  // width shaded days that had no price and read as a solid block rather than
  // as the area under a line.
  const areaFor = seg => {
    if (seg.length < 2) return null
    const base = (PAD.top + plotH).toFixed(1)
    return `${lineFor(seg)} L${xOf(seg[seg.length - 1].index).toFixed(1)} ${base} L${xOf(seg[0].index).toFixed(1)} ${base} Z`
  }

  const up = stats.change >= 0
  const hovered = hoverIdx != null ? points[hoverIdx] : null

  function locate(clientX) {
    const el = wrapRef.current
    if (!el || points.length < 2) return null
    const rect = el.getBoundingClientRect()
    const ratio = (clientX - rect.left - PAD.left) / plotW
    const idx = Math.round(ratio * (points.length - 1))
    const clamped = Math.max(0, Math.min(points.length - 1, idx))
    return points[clamped]?.price != null ? clamped : null
  }

  return (
    <figure className={`${styles.figure} ${tone}`}>
      <figcaption className={styles.head}>
        <span className={styles.label}>
          Cardmarket{foil ? ' foil' : ''} · {formatDay(stats.first.date)} – {formatDay(stats.last.date)}
        </span>
        <span className={styles.headline}>
          <span className={styles.now}>{formatEur(stats.last.price)}</span>
          <span className={up ? styles.up : styles.down}>
            {up ? '▲' : '▼'} {formatEur(Math.abs(stats.change))}
            {stats.changePct != null && ` (${up ? '+' : '−'}${Math.abs(stats.changePct).toFixed(1)}%)`}
          </span>
        </span>
      </figcaption>

      <div
        ref={wrapRef}
        className={styles.plot}
        onMouseMove={e => setHoverIdx(locate(e.clientX))}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {width > 0 && (
          <svg
            className={styles.svg}
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            role="img"
            aria-label={
              `Cardmarket${foil ? ' foil' : ''} price, ${stats.first.date} to ${stats.last.date}: `
              + `${formatEur(stats.first.price)} to ${formatEur(stats.last.price)}, `
              + `${up ? 'up' : 'down'} ${Math.abs(stats.changePct ?? 0).toFixed(1)} percent. `
              + `Low ${formatEur(stats.min)}, high ${formatEur(stats.max)}.`
            }
          >
            {ticks.map(v => (
              <g key={v}>
                <line className={styles.grid} x1={PAD.left} x2={width - PAD.right} y1={yOf(v)} y2={yOf(v)} />
                <text className={styles.axisText} x={PAD.left - 8} y={yOf(v) + 3} textAnchor="end">
                  {formatTick(v)}
                </text>
              </g>
            ))}

            {segments.map((seg, i) => {
              const d = areaFor(seg)
              return d ? <path key={`a${i}`} className={styles.area} d={d} /> : null
            })}

            {segments.map((seg, i) =>
              seg.length > 1
                ? <path key={`l${i}`} className={styles.line} d={lineFor(seg)} />
                : <circle key={`l${i}`} className={styles.point} cx={xOf(seg[0].index)} cy={yOf(seg[0].price)} r="2" />
            )}

            <circle className={styles.endpoint} cx={xOf(stats.last.index)} cy={yOf(stats.last.price)} r="3.5" />

            {hovered && (
              <>
                <line
                  className={styles.crosshair}
                  x1={xOf(hovered.index)} x2={xOf(hovered.index)}
                  y1={PAD.top} y2={PAD.top + plotH}
                />
                <circle className={styles.hoverDot} cx={xOf(hovered.index)} cy={yOf(hovered.price)} r="4" />
              </>
            )}

            <text className={styles.axisText} x={PAD.left} y={HEIGHT - 6}>{formatDay(stats.first.date)}</text>
            <text className={styles.axisText} x={width - PAD.right} y={HEIGHT - 6} textAnchor="end">
              {formatDay(stats.last.date)}
            </text>
          </svg>
        )}
      </div>

      <div className={styles.readout} aria-live="polite">
        {hovered
          ? <><strong>{formatEur(hovered.price)}</strong><span className={styles.readoutSep}>·</span>{formatDay(hovered.date)}</>
          : <>Low <strong>{formatEur(stats.min)}</strong><span className={styles.readoutSep}>·</span>High <strong>{formatEur(stats.max)}</strong></>}
      </div>
    </figure>
  )
}
