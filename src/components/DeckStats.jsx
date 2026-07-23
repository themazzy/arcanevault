import { useState, useMemo, useEffect, useRef } from 'react'
import { getPrice, formatPrice } from '../lib/scryfall'
import { CAT_ORDER, CAT_COLORS, getCardCategory } from '../lib/cardCategory'
import BracketBadge from './BracketBadge'
import { analyzeBracket, fetchGameChangerNames } from '../lib/commanderBracket'
import { CloseIcon } from '../icons'
import { Select } from './UI'
import { hypergeomAtLeast, expectedCount, openingHandLands } from '../lib/deckProbability'
import { extractTokenExtras, extractTokenNames, fetchDeckTokenCards } from '../lib/deckTokens'
import styles from './DeckStats.module.css'

// Re-export so existing consumers that import from DeckStats keep working.
export { CAT_ORDER, CAT_COLORS, getCardCategory }

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_ORDER = ['Commander', 'Creatures', 'Planeswalkers', 'Battles', 'Instants',
  'Sorceries', 'Artifacts', 'Enchantments', 'Lands', 'Other']

const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G']
const COLOR_BG = { W: '#c0a850', U: '#2a5890', B: '#382050', R: '#7a2c28', G: '#1c5830', C: '#505068' }
const COLOR_LABEL = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless', M: 'Multi' }

const CURVE_SEG_ORDER = {
  color: ['W', 'U', 'B', 'R', 'G', 'M', 'C'],
  type:  ['Creatures', 'Planeswalkers', 'Battles', 'Instants', 'Sorceries', 'Enchantments', 'Artifacts', 'Other'],
}
const CURVE_SEG_COLOR = {
  W: '#c0a850', U: '#2a5890', B: '#6a4080', R: '#7a2c28', G: '#1c5830', M: '#9a7030', C: '#505068',
  Creatures: '#4a8a5a', Planeswalkers: '#bb6622', Battles: '#aa4444',
  Instants: '#4455bb', Sorceries: '#8833aa', Enchantments: '#6a5aaa',
  Artifacts: '#7a7a8a', Other: '#555',
}

const LAND_SUBTYPE_COLOR = { forest: 'G', mountain: 'R', swamp: 'B', island: 'U', plains: 'W', wastes: 'C' }

const BAR_MAX_PX = 72

const PLAY_ROLE_ORDER = [
  'Ramp', 'Card Draw', 'Tutor', 'Cost Reduction', 'Removal', 'Board Wipe',
  'Counterspell', 'Protection', 'Combo', 'Copy', 'Cheat',
]

const COMMON_KEYWORDS = [
  'Flying', 'First Strike', 'Double Strike', 'Deathtouch', 'Lifelink', 'Vigilance',
  'Haste', 'Trample', 'Flash', 'Reach', 'Menace', 'Hexproof', 'Indestructible',
  'Defender', 'Ward', 'Prowess', 'Cascade', 'Storm', 'Persist', 'Undying', 'Shroud',
  'Wither', 'Infect', 'Convoke', 'Delve', 'Improvise', 'Kicker', 'Mutate', 'Surveil',
  'Proliferate', 'Annihilator', 'Equip', 'Goad', 'Myriad', 'Riot', 'Cycling',
  'Flashback', 'Jumpstart',
]
const KW_RE = new RegExp(`(?:^|\\n|, ?)(${COMMON_KEYWORDS.map(k => k.replace(/[-\s]/g, '[-\\s]')).join('|')})(?=\\n|$|,)`, 'gim')

function getKeywordCounts(cards) {
  const counts = {}
  for (const card of cards) {
    const qty = card.qty || 1
    const seen = new Set()
    // Prefer the structured keywords array when available
    for (const kw of (card.keywords || [])) {
      if (!seen.has(kw)) { seen.add(kw); counts[kw] = (counts[kw] || 0) + qty }
    }
    // Fall back to scanning oracle text for known keywords
    if (!card.keywords?.length && card.oracle_text) {
      for (const m of card.oracle_text.matchAll(KW_RE)) {
        const kw = m[1]
        if (!seen.has(kw)) { seen.add(kw); counts[kw] = (counts[kw] || 0) + qty }
      }
    }
  }
  return Object.entries(counts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 14)
}

// Creature subtypes from the type line. Handles MDFC ("//"), Kindred/Tribal,
// and the em-dash separator Scryfall uses. Returns [[subtype, qtyCount], …].
const CREATURE_TYPE_RE = /\b(Creature|Kindred|Tribal)\b/i
export function creatureSubtypesOf(typeLine) {
  const subs = []
  for (const face of String(typeLine || '').split('//')) {
    if (!CREATURE_TYPE_RE.test(face)) continue
    const dash = face.indexOf('—')
    if (dash === -1) continue
    for (const s of face.slice(dash + 1).trim().split(/\s+/)) {
      if (s) subs.push(s)
    }
  }
  return subs
}

export function getCreatureTypeCounts(cards) {
  const counts = {}
  for (const card of cards) {
    const qty = card.qty || 1
    const seen = new Set()
    for (const sub of creatureSubtypesOf(card.type_line)) {
      if (seen.has(sub)) continue
      seen.add(sub)
      counts[sub] = (counts[sub] || 0) + qty
    }
  }
  return Object.entries(counts).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 14)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCardType(typeLine = '') {
  const tl = typeLine.toLowerCase()
  if (tl.includes('battle'))       return 'Battles'
  if (tl.includes('creature'))     return 'Creatures'
  if (tl.includes('planeswalker')) return 'Planeswalkers'
  if (tl.includes('instant'))      return 'Instants'
  if (tl.includes('sorcery'))      return 'Sorceries'
  if (tl.includes('artifact'))     return 'Artifacts'
  if (tl.includes('enchantment'))  return 'Enchantments'
  if (tl.includes('land'))         return 'Lands'
  return 'Other'
}

// card is a normalized card object: { type_line, color_identity, oracle_text? }
function getProducedColors(card) {
  if (!card) return []

  const typeLine = (card.type_line    || '').toLowerCase()
  const oracle   = (card.oracle_text  || '').toLowerCase()
  const isLand   = typeLine.includes('land')

  if (isLand) {
    const fromSubtype = Object.entries(LAND_SUBTYPE_COLOR)
      .filter(([k]) => typeLine.includes(k))
      .map(([, v]) => v)
    if (fromSubtype.length) return [...new Set(fromSubtype)]
    const ci = (card.color_identity || []).filter(c => 'WUBRG'.includes(c))
    return ci.length ? ci : ['C']
  }

  if (/add \{/.test(oracle)) {
    const found = []
    const re = /add (?:[^.]*?)\{([WUBRG2C])/g
    let m
    while ((m = re.exec(oracle)) !== null) {
      if ('WUBRG'.includes(m[1])) { if (!found.includes(m[1])) found.push(m[1]) }
      else if (m[1] === 'C' || m[1] === '2') { if (!found.includes('C')) found.push('C') }
    }
    if (found.length) return found
    const ci = (card.color_identity || []).filter(c => 'WUBRG'.includes(c))
    return ci.length ? ci : ['C']
  }

  return []
}

function countColorPips(manaCost) {
  const counts = { W: 0, U: 0, B: 0, R: 0, G: 0 }
  if (!manaCost) return counts
  const re = /\{([WUBRG])(?:\/[WUBRG2P])?\}/g
  let m
  while ((m = re.exec(manaCost)) !== null) counts[m[1]]++
  return counts
}

// ── Normalizers ───────────────────────────────────────────────────────────────

/**
 * Convert DeckBrowser collection cards + sfMap to normalized format.
 * @param {Array} cards  - collection cards: { set_code, collector_number, qty, _folder_qty, name, ... }
 * @param {Object} sfMap - keyed by "set_code-collector_number"
 */
export function normalizeDeckBrowserCards(cards, sfMap) {
  return cards.map(c => {
    const key = `${c.set_code}-${c.collector_number}`
    const sf = sfMap[key] || {}
    return {
      name:           c.name || sf.name || '',
      type_line:      sf.type_line || '',
      mana_cost:      sf.mana_cost || sf.card_faces?.[0]?.mana_cost || '',
      cmc:            sf.cmc ?? 0,
      color_identity: sf.color_identity || [],
      oracle_text:    sf.oracle_text || (sf.card_faces?.map(f => f.oracle_text || '').join('\n')) || '',
      keywords:       sf.keywords || [],
      image_uri:      sf.image_uris?.normal || sf.image_uris?.small || '',
      qty:            c._folder_qty || c.qty || 1,
      is_commander:   false,
    }
  })
}

/**
 * Convert DeckBuilder deck_cards to normalized format.
 * Pass sfMap (keyed by "set_code-collector_number") to fill in oracle_text and keywords.
 */
export function normalizeDeckBuilderCards(deckCards, sfMap, opts = {}) {
  const { price_source } = opts
  return deckCards.map(dc => {
    const sfKey = dc.set_code && dc.collector_number ? `${dc.set_code}-${dc.collector_number}` : null
    const sf = sfKey && sfMap ? (sfMap[sfKey] || {}) : {}
    const oracleText = dc.oracle_text || sf.oracle_text
      || (sf.card_faces?.map(f => f.oracle_text || '').join('\n')) || ''
    const price = sf && Object.keys(sf).length ? (getPrice(sf, dc.foil, { price_source }) ?? null) : null
    return {
      name:           dc.name || sf.name || '',
      type_line:      dc.type_line || sf.type_line || '',
      mana_cost:      dc.mana_cost || sf.mana_cost || sf.card_faces?.[0]?.mana_cost || '',
      cmc:            dc.cmc ?? sf.cmc ?? 0,
      color_identity: dc.color_identity?.length ? dc.color_identity : (sf.color_identity || []),
      oracle_text:    oracleText,
      keywords:       sf.keywords || dc.keywords || [],
      image_uri:      dc.image_uri || sf.image_uris?.normal || sf.image_uris?.small || '',
      qty:            dc.qty || 1,
      foil:           dc.foil || false,
      price,
      is_commander:   dc.is_commander || false,
    }
  })
}

// ── UI Sub-components ─────────────────────────────────────────────────────────

function TypeIcon({ type, size = 14, style: extraStyle }) {
  const s = size
  const icons = {
    Commander: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={extraStyle}>
        <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm2 4h10v-2H7v2z"/>
      </svg>
    ),
    Creatures: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={extraStyle}>
        <path d="M20.71 3.29a1 1 0 00-1.42 0L13 9.59l-1.29-1.3-1.42 1.42 1.3 1.29L3 19.59V21h1.41l8.59-8.59 1.29 1.3 1.42-1.42-1.3-1.29 6.3-6.29a1 1 0 000-1.42z"/>
        <path d="M6.5 17.5l-2 2 1 1 2-2z" opacity=".5"/>
      </svg>
    ),
    Planeswalkers: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={extraStyle}>
        <circle cx="12" cy="5" r="2"/>
        <path d="M12 9c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4zm-1 9h2l1 4h-4l1-4z"/>
        <path d="M10 9l-3 5h2l-1 5h4l-1-5h2z" opacity=".3"/>
      </svg>
    ),
    Battles: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={extraStyle}>
        <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm0 15l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/>
      </svg>
    ),
    Instants: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={extraStyle}>
        <path d="M7 2v11h3v9l7-12h-4l4-8z"/>
      </svg>
    ),
    Sorceries: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={extraStyle}>
        <path d="M12 23c-4.97 0-9-4.03-9-9 0-4.97 3.5-8.5 7-10 .5 1.5-.5 3.5-1 4.5 1.5-1 3-2 3.5-3.5C13 8.5 14 11.5 12 14c1 0 2.5-.5 3-1.5.5 2.5-.5 5-1 6 3-1.5 5-4.5 5-8 0-5.52-4.48-10-10-10C4.48 0 0 4.48 0 10c0 5.52 4.48 10 10 10h2c-4.42 0-8-3.58-8-8 0-1.5.42-2.89 1.15-4.08C5.77 10.76 8 13.5 8 15c.5-1.5-.5-4 0-6 1 1.5 2 3 1.5 5.5C10.5 13 11 12 12 12c-1 4-4 6-4 9 0 .34.03.67.08 1H12z"/>
      </svg>
    ),
    Artifacts: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={extraStyle}>
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a7 7 0 00-1.62-.94l-.36-2.54A.484.484 0 0014 2h-4a.484.484 0 00-.48.41l-.36 2.54a7.4 7.4 0 00-1.62.94l-2.39-.96a.48.48 0 00-.59.22L2.74 8.47c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.36 1.04.67 1.62.94l.36 2.54c.05.24.27.41.48.41h4c.24 0 .44-.17.47-.41l.36-2.54a7.4 7.4 0 001.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 00-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
      </svg>
    ),
    Enchantments: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={extraStyle}>
        <path d="M12 3L9.5 8.5H4l4.5 3.5L7 17.5l5-3.5 5 3.5-1.5-5.5L20 8.5h-5.5z" opacity=".35"/>
        <path d="M12 2l1.09 3.26L16.18 4l-2.09 2.74L17 9l-3.35-.5L12 12l-1.65-3.5L7 9l2.91-2.26L7.82 4l3.09 1.26z"/>
      </svg>
    ),
    Lands: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={extraStyle}>
        <path d="M14 6l-1-2H5v17h2v-7h5l1 2h7V6h-6zm4 8h-4l-1-2H7V6h5l1 2h5v6z"/>
      </svg>
    ),
    Other: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={extraStyle}>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>
      </svg>
    ),
  }
  return icons[type] || icons.Other
}

function ColorStackBar({ colorCounts, totalPips, title, cardCounts = null }) {
  const allKeys = [...COLOR_ORDER, 'C']
  const entries = allKeys.map(c => ({ c, v: colorCounts[c] || 0 })).filter(x => x.v > 0)
  const [selected, setSelected] = useState(null)
  if (!entries.length) return null

  const sel = entries.find(e => e.c === selected)
  const selPct = sel ? Math.round((sel.v / totalPips) * 100) : null
  const selCards = sel ? (cardCounts ? (cardCounts[sel.c] || 0) : sel.v) : null

  return (
    <div>
      <div className={styles.contentLabel}>
        {title}
      </div>
      <div style={{ display: 'flex', height: 36, borderRadius: 5, overflow: 'hidden', gap: 1 }}>
        {entries.map(({ c, v }) => (
          <button key={c}
            type="button"
            aria-pressed={selected === c}
            aria-label={`${title}: ${COLOR_LABEL[c] || c}, ${v}`}
            style={{
              flex: v,
              background: COLOR_BG[c] || '#505068',
              minWidth: 36,
              cursor: 'pointer',
              opacity: selected && selected !== c ? 0.35 : 1,
              filter: selected === c ? 'brightness(1.3)' : 'none',
              transition: 'opacity 0.15s, filter 0.15s',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: 0, padding: 0,
            }}
            onClick={() => setSelected(s => s === c ? null : c)}
          >
            <img src={`https://svgs.scryfall.io/card-symbols/${c}.svg`} alt={c}
              style={{ width: 18, height: 18, opacity: 0.9 }} />
          </button>
        ))}
      </div>
      <div style={{ minHeight: '1.2em', fontSize: '0.75rem', color: 'var(--text-dim)', paddingLeft: 2, marginTop: 3, overflowWrap: 'anywhere' }}>
        {sel && (
          <>
            <span style={{ color: COLOR_BG[sel.c] || '#ccc', fontWeight: 600, marginRight: 4 }}>
              {COLOR_LABEL[sel.c] || sel.c}
            </span>
            {cardCounts
              ? `${sel.v} pip${sel.v !== 1 ? 's' : ''} · ${selCards} card${selCards !== 1 ? 's' : ''} · ${selPct}%`
              : `${sel.v} source${sel.v !== 1 ? 's' : ''} · ${selPct}%`
            }
          </>
        )}
      </div>
    </div>
  )
}

function StatsDisclosure({ title, metric, className = '', bodyClassName = '', children }) {
  const [isOpen, setIsOpen] = useState(true)

  return (
    <details
      className={`${styles.panel} ${styles.disclosure} ${className}`.trim()}
      open={isOpen}
      onToggle={event => setIsOpen(event.currentTarget.open)}
    >
      <summary className={styles.disclosureSummary}>
        <span className={styles.panelTitle}>{title}</span>
        {metric != null && <span className={styles.disclosureMetric}>{metric}</span>}
      </summary>
      <div className={`${styles.disclosureBody} ${bodyClassName}`.trim()}>{children}</div>
    </details>
  )
}

function ManaCurveChart({ curve, avgCmc, curveMode, curveSegData, onModeChange }) {
  const maxVal = Math.max(1, ...Object.values(curve))
  const labels = ['0', '1', '2', '3', '4', '5', '6', '7+']
  const curveCounts = labels.map((_, index) => Number(curve[index] || 0))
  const highEndCount = curveCounts.slice(5).reduce((sum, count) => sum + count, 0)
  const segOrder = CURVE_SEG_ORDER[curveMode] || []
  const [tooltip, setTooltip] = useState(null)

  const legendKeys = curveMode === 'flat' ? [] :
    segOrder.filter(k => Object.values(curveSegData).some(b => (b[k] || 0) > 0))

  const showTooltip = (e, cmcLabel, count, segs) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const parentRect = e.currentTarget.closest('[data-curve-chart]')?.getBoundingClientRect()
    const x = rect.left - (parentRect?.left || 0) + rect.width / 2
    const y = rect.top  - (parentRect?.top  || 0)
    let items
    if (segs) {
      items = segOrder.filter(k => (segs[k] || 0) > 0).map(k => ({
        name: curveMode === 'color' ? (COLOR_LABEL[k] || k) : k,
        count: segs[k],
        color: CURVE_SEG_COLOR[k],
      }))
    } else {
      items = []
    }
    setTooltip({ x, y, label: cmcLabel, total: count, items })
  }

  return (
    <StatsDisclosure
      title="Mana Curve"
      metric={`avg ${avgCmc} · ${highEndCount} at MV 5+`}
      bodyClassName={styles.curveBody}
    >
      <div className={styles.panelToolbar}>
          {[['flat', '—'], ['color', 'Color'], ['type', 'Type']].map(([m, l]) => (
            <button key={m}
              type="button"
              aria-pressed={curveMode === m}
              aria-label={`Show mana curve ${m === 'flat' ? 'totals' : `by ${m}`}`}
              style={{
                background: curveMode === m ? 'rgba(201,168,76,0.12)' : 'none',
                border: `1px solid ${curveMode === m ? 'rgba(201,168,76,0.35)' : 'var(--s-border2)'}`,
                borderRadius: 4, padding: '0 10px', minHeight: 36, fontSize: '0.64rem',
                color: curveMode === m ? 'var(--gold)' : 'var(--text-faint)',
                cursor: 'pointer', fontFamily: 'var(--font-display)', letterSpacing: '0.04em',
                transition: 'all 0.15s',
              }}
              onClick={() => onModeChange(m)}
            >
              {l}
            </button>
          ))}
      </div>

      {/* Bars */}
      <div
        style={{ display: 'flex', alignItems: 'flex-end', gap: 4, position: 'relative', minWidth: 0 }}
        data-curve-chart
        onMouseLeave={() => setTooltip(null)}
      >
        {labels.map((label, i) => {
          const count = curve[i] || 0
          const barPx = count > 0 ? Math.max(Math.round((count / maxVal) * BAR_MAX_PX), 4) : 0
          const segs = curveMode !== 'flat' ? curveSegData[i] : null
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flex: '1 1 0', minWidth: 0 }}>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-faint)', minHeight: 12, lineHeight: '12px', textAlign: 'center' }}>
                {count > 0 ? count : ''}
              </span>
              <div style={{ width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', height: BAR_MAX_PX }}>
                {barPx > 0 && (
                  <button
                    type="button"
                    aria-label={`Mana value ${label}: ${count} ${count === 1 ? 'card' : 'cards'}`}
                    style={{
                      width: '100%', maxWidth: 44, height: BAR_MAX_PX,
                      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                      padding: 0, border: 0, background: 'none', cursor: 'pointer',
                    }}
                    onMouseEnter={event => showTooltip(event, label, count, segs)}
                    onFocus={event => showTooltip(event, label, count, segs)}
                    onClick={event => showTooltip(event, label, count, segs)}
                    onBlur={() => setTooltip(null)}
                  >
                    {segs
                      ? <span style={{ width: 24, height: barPx, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: '2px 2px 0 0' }}>
                          {segOrder.filter(k => (segs[k] || 0) > 0).map(k => (
                            <span key={k} style={{ flex: segs[k], background: CURVE_SEG_COLOR[k] }} />
                          ))}
                        </span>
                      : <span style={{ width: 24, height: barPx, background: 'linear-gradient(180deg, var(--gold) 0%, rgba(201,168,76,0.45) 100%)', borderRadius: '2px 2px 0 0', transition: 'height 0.35s ease' }} />
                    }
                  </button>
                )}
              </div>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-faint)', textAlign: 'center' }}>{label}</span>
            </div>
          )
        })}

        {/* Floating tooltip */}
        {tooltip && (
          <div style={{
            position: 'absolute',
            left: tooltip.x, top: Math.max(0, tooltip.y - 10),
            transform: 'translate(-50%, -100%)',
            background: 'rgba(18,14,32,0.96)',
            border: '1px solid rgba(201,168,76,0.3)',
            borderRadius: 5, padding: '8px 12px',
            pointerEvents: 'none', zIndex: 100,
            minWidth: 110,
            boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
          }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.7rem', color: 'var(--gold)', letterSpacing: '0.06em', marginBottom: tooltip.items.length ? 5 : 0 }}>
              MV {tooltip.label} · {tooltip.total} {tooltip.total === 1 ? 'card' : 'cards'}
            </div>
            {tooltip.items.map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', marginTop: 3 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: item.color, flexShrink: 0 }} />
                <span style={{ color: 'var(--text-dim)' }}>{item.name}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--text)', fontFamily: 'var(--font-display)' }}>{item.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      {legendKeys.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--s-medium)' }}>
          {legendKeys.map(k => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.59rem', color: 'var(--text-faint)' }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: CURVE_SEG_COLOR[k], flexShrink: 0 }} />
              <span>{curveMode === 'color' ? (COLOR_LABEL[k] || k) : k}</span>
            </div>
          ))}
        </div>
      )}
    </StatsDisclosure>
  )
}

function CardPreviewDialog({ label, cards, onClose }) {
  const closeRef = useRef(null)

  useEffect(() => {
    if (!label) return undefined
    closeRef.current?.focus()
    const onKey = event => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [label, onClose])

  if (!label || !cards.length) return null
  const totalCopies = cards.reduce((sum, card) => sum + (card.qty || 1), 0)

  return (
    <div className={styles.previewOverlay} onClick={onClose}>
      <div
        className={styles.previewPanel}
        role="dialog"
        aria-modal="true"
        aria-label={`${totalCopies} cards in ${label}`}
        onClick={event => event.stopPropagation()}
      >
        <div className={styles.previewHead}>
          <span className={styles.previewTitle}>
            {totalCopies} card{totalCopies !== 1 ? 's' : ''} · {label}
          </span>
          <button ref={closeRef} type="button" className={styles.previewClose} onClick={onClose} aria-label="Close card preview">
            <CloseIcon size={15} />
          </button>
        </div>
        <div className={styles.previewGrid}>
          {cards.map((card, index) => (
            <div key={`${card.name}-${index}`} className={styles.previewCard}>
              {card.image_uri
                ? <img className={styles.previewImg} src={card.image_uri} alt={card.name} title={card.name} loading="lazy" />
                : <div className={styles.previewImgFallback}>{card.name}</div>
              }
              {card.qty > 1 && <span className={styles.previewQty}>×{card.qty}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function cardsWithType(cards, type) {
  return cards.filter(card => getCardType(card.type_line || '') === type)
}

function cardsWithCategory(cards, category) {
  return cards.filter(card => getCardCategory(
    (card.oracle_text || '').toLowerCase(),
    (card.type_line || '').toLowerCase(),
    card.keywords || [],
  ) === category)
}

function TypeBreakdown({ typeCounts, cards }) {
  const [selectedType, setSelectedType] = useState(null)
  const entries = Object.entries(typeCounts)
    .filter(([k]) => k !== 'Lands' && k !== 'Commander')
    .sort((a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))
  const landCount = typeCounts['Lands'] || 0
  const totalCards = Object.values(typeCounts).reduce((sum, count) => sum + count, 0)
  const maxVal = Math.max(1, ...entries.map(([, v]) => v))

  return (
    <StatsDisclosure title="Card Types" metric={`${totalCards} cards`} bodyClassName={styles.breakdownBody}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {entries.filter(([, v]) => v > 0).map(([type, count]) => (
          <button
            key={type}
            type="button"
            className={styles.breakdownRow}
            aria-label={`View ${count} card${count === 1 ? '' : 's'} of type ${type}`}
            onClick={() => setSelectedType(type)}
          >
            <div style={{ flex: '0 1 clamp(68px, 28vw, 90px)', fontSize: '0.72rem', color: 'var(--text-dim)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
              <TypeIcon type={type} size={13} style={{ verticalAlign: 'middle' }} />
              {' '}{type}
            </div>
            <div style={{ flex: 1, height: 7, background: 'var(--s-medium)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(count / maxVal) * 100}%`, background: 'rgba(201,168,76,0.5)', borderRadius: 3, transition: 'width 0.4s ease', minWidth: 2 }} />
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', width: 22, textAlign: 'right', flexShrink: 0 }}>{count}</div>
          </button>
        ))}
        {landCount > 0 && (
          <button
            type="button"
            className={`${styles.breakdownRow} ${styles.breakdownRowMuted}`}
            aria-label={`View ${landCount} land cards`}
            onClick={() => setSelectedType('Lands')}
          >
            <div style={{ flex: '0 1 clamp(68px, 28vw, 90px)', fontSize: '0.72rem', color: 'var(--text-dim)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
              <TypeIcon type="Lands" size={13} style={{ verticalAlign: 'middle' }} />
              {' '}Lands
            </div>
            <div style={{ flex: 1, height: 7, background: 'var(--s-medium)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(landCount / Math.max(maxVal, landCount)) * 100}%`, background: 'var(--text-faint)', borderRadius: 3, transition: 'width 0.4s ease', minWidth: 2 }} />
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', width: 22, textAlign: 'right', flexShrink: 0 }}>{landCount}</div>
          </button>
        )}
      </div>
      <CardPreviewDialog
        label={selectedType}
        cards={selectedType ? cardsWithType(cards, selectedType) : []}
        onClose={() => setSelectedType(null)}
      />
    </StatsDisclosure>
  )
}

function CategoryBreakdown({ catCounts, cards }) {
  const [selectedCategory, setSelectedCategory] = useState(null)
  const entries = PLAY_ROLE_ORDER
    .map(cat => ({ cat, count: catCounts[cat] || 0 }))
    .filter(e => e.count > 0)
  if (!entries.length) return null

  return (
    <StatsDisclosure title="Playability Roles" metric={`${entries.length} roles`}>
      <div className={styles.roleGrid}>
        {entries.map(({ cat, count }) => (
          <button
            key={cat}
            type="button"
            className={styles.roleButton}
            onClick={() => setSelectedCategory(cat)}
            aria-label={`View ${count} card${count === 1 ? '' : 's'} categorized as ${cat}`}
          >
            <span className={styles.roleName} style={{ color: CAT_COLORS[cat] || 'var(--text-dim)' }}>{cat}</span>
            <strong className={styles.roleCount}>{count}</strong>
          </button>
        ))}
      </div>
      <CardPreviewDialog
        label={selectedCategory}
        cards={selectedCategory ? cardsWithCategory(cards, selectedCategory) : []}
        onClose={() => setSelectedCategory(null)}
      />
    </StatsDisclosure>
  )
}

// Returns cards that have the given keyword ability
function cardsWithKeyword(cards, kw) {
  const re = new RegExp(`(?:^|\\n|, ?)${kw.replace(/[-\s]/g, '[-\\s]')}(?=\\n|$|,| )`, 'i')
  return cards.filter(c =>
    c.keywords?.some(k => k.toLowerCase() === kw.toLowerCase()) ||
    (c.oracle_text && re.test(c.oracle_text))
  )
}

// Returns cards whose creature subtypes include the given type.
function cardsWithCreatureType(cards, type) {
  return cards.filter(c => creatureSubtypesOf(c.type_line).includes(type))
}

// Generic pill cloud with an on-hover/tap card-image popover. Used for both
// the keyword and creature-type breakdowns.
function PillFrequency({ label, counts, cards, getMatchingCards, embedded = false }) {
  // Click a pill to open a centered preview of the matching cards (replaces
  // the old hover popover — works the same on touch and desktop).
  const [openValue, setOpenValue] = useState(null)

  const previewCards = useMemo(
    () => openValue ? getMatchingCards(cards, openValue) : [],
    [openValue, cards, getMatchingCards]
  )

  // Close on Escape.
  useEffect(() => {
    if (!openValue) return
    const onKey = e => { if (e.key === 'Escape') setOpenValue(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openValue])

  if (!counts.length) return null

  const totalCopies = previewCards.reduce((s, c) => s + (c.qty || 1), 0)

  return (
    <div className={embedded ? styles.traitGroup : styles.panel} style={{ padding: '14px 14px 12px' }}>
      <div className={styles.contentLabel}>
        {label}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 6px' }}>
        {counts.map(([value, count]) => (
          <button
            key={value}
            type="button"
            className={styles.freqPill}
            onClick={() => setOpenValue(v => v === value ? null : value)}
            aria-expanded={openValue === value}
            aria-label={`View ${count} cards with ${value}`}
          >
            {value}
            <span className={styles.freqPillCount}>×{count}</span>
          </button>
        ))}
      </div>

      {openValue && previewCards.length > 0 && (
        <div className={styles.previewOverlay} onClick={() => setOpenValue(null)}>
          <div className={styles.previewPanel} role="dialog" aria-modal="true" aria-label={`${totalCopies} cards with ${openValue}`} onClick={e => e.stopPropagation()}>
            <div className={styles.previewHead}>
              <span className={styles.previewTitle}>
                {totalCopies} card{totalCopies !== 1 ? 's' : ''} with {openValue}
              </span>
              <button type="button" className={styles.previewClose} onClick={() => setOpenValue(null)} aria-label="Close card preview">
                <CloseIcon size={15} />
              </button>
            </div>
            <div className={styles.previewGrid}>
              {previewCards.map((c, i) => (
                <div key={i} className={styles.previewCard}>
                  {c.image_uri
                    ? <img className={styles.previewImg} src={c.image_uri} alt={c.name} title={c.name} loading="lazy" />
                    : <div className={styles.previewImgFallback}>{c.name}</div>
                  }
                  {c.qty > 1 && <span className={styles.previewQty}>×{c.qty}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function pct(p) {
  if (p >= 0.995) return '>99%'
  if (p > 0 && p < 0.01) return '<1%'
  return `${Math.round(p * 100)}%`
}

function Stepper({ value, min, max, onChange, label }) {
  const num = Number(value)
  const set = (v) => onChange(String(Math.max(min, Math.min(max, v))))
  return (
    <div className={styles.stepper}>
      <button type="button" className={styles.stepperBtn} onClick={() => set((Number.isFinite(num) ? num : min) - 1)} aria-label={`Decrease ${label}`}>−</button>
      <input
        className={styles.stepperInput}
        type="number" min={min} max={max} value={value} aria-label={label}
        onChange={e => onChange(e.target.value)}
      />
      <button type="button" className={styles.stepperBtn} onClick={() => set((Number.isFinite(num) ? num : min) + 1)} aria-label={`Increase ${label}`}>+</button>
    </div>
  )
}

// Hypergeometric draw odds: opening-hand land summary + a "chance to draw"
// calculator over the deck's types / categories / creature types.
function ProbabilitySection({ deckSize, landCount, catCounts, typeCounts, creatureTypeCounts }) {
  const groups = useMemo(() => {
    const typeItems = Object.entries(typeCounts)
      .filter(([, v]) => v > 0)
      .map(([t, v]) => ({ value: `type:${t}`, label: t, K: v }))
    const catItems = Object.entries(catCounts)
      .filter(([, v]) => v > 0)
      .map(([t, v]) => ({ value: `cat:${t}`, label: t, K: v }))
    const subItems = (creatureTypeCounts || [])
      .map(([t, v]) => ({ value: `sub:${t}`, label: t, K: v }))
    return [
      { label: null, items: [{ value: 'lands', label: 'Lands', K: landCount }] },
      { label: 'Card Types', items: typeItems },
      { label: 'Categories', items: catItems },
      { label: 'Creature Types', items: subItems },
    ].filter(g => g.items.length)
  }, [typeCounts, catCounts, creatureTypeCounts, landCount])

  const flat = useMemo(() => groups.flatMap(g => g.items), [groups])
  const [targetValue, setTargetValue] = useState('lands')
  const [drawn, setDrawn] = useState(7)
  const [wantK, setWantK] = useState(1)

  if (deckSize < 2 || !flat.length) return null

  const target = flat.find(t => t.value === targetValue) || flat[0]
  const K = target?.K || 0
  const n = Math.max(1, Math.min(Math.round(drawn) || 1, deckSize))
  // "at least" copies: 1..min(target count, cards seen); above that it's impossible.
  const kMax = Math.max(1, Math.min(K, n))
  const k = Math.max(1, Math.min(Math.round(wantK) || 1, kMax))
  const atLeastK = hypergeomAtLeast(deckSize, K, n, k)
  const exp = expectedCount(deckSize, K, n)
  const oh = openingHandLands(deckSize, landCount)

  return (
    <StatsDisclosure
      title="Advanced Probabilities"
      metric={`${pct(oh.idealPct)} keepable`}
      bodyClassName={styles.probCalc}
    >
      {landCount > 0 && (
        <div className={styles.probOpening}>
          <span className={styles.probOpeningLabel}>Opening hand</span>
          <span className={styles.probOpeningVal}>
            <strong>~{oh.avg.toFixed(1)}</strong> lands · <strong>{pct(oh.idealPct)}</strong> chance of a keepable 2–4
          </span>
        </div>
      )}

      <div className={styles.probCalcRow}>
        <span className={styles.probCalcText}>Draw at least</span>
        <Stepper value={wantK} min={1} max={kMax} onChange={setWantK} label="copies to draw" />
        <Select className={styles.probSelect} title="Target" value={targetValue} onChange={e => setTargetValue(e.target.value)}>
          {groups.map((g) => (
            g.label
              ? <optgroup key={g.label} label={g.label}>
                  {g.items.map(it => <option key={it.value} value={it.value}>{it.label} ({it.K})</option>)}
                </optgroup>
              : g.items.map(it => <option key={it.value} value={it.value}>{it.label} ({it.K})</option>)
          ))}
        </Select>
        <span className={styles.probCalcText}>in</span>
        <Stepper value={drawn} min={1} max={deckSize} onChange={setDrawn} label="cards seen" />
        <span className={styles.probCalcText}>cards</span>
      </div>

      <div className={styles.probResultCard}>
        <div className={styles.probResultTop}>
          <span className={styles.probResultPct}>{pct(atLeastK)}</span>
          <span className={styles.probResultDesc}>
            to draw {k === 1 ? 'at least one' : `${k}+`} · ~{exp.toFixed(2)} expected in {n}
          </span>
        </div>
        <div className={styles.probBarTrack}>
          <div className={styles.probBarFill} style={{ width: `${Math.round(atLeastK * 100)}%` }} />
        </div>
      </div>
    </StatsDisclosure>
  )
}

function PriceBreakdown({ totalPrice, avgPrice: _avgPrice, priceByCategory, topCards, price_source }) {
  const [selectedCard, setSelectedCard] = useState(null)
  if (totalPrice <= 0) return null

  const catEntries = CAT_ORDER
    .map(cat => ({ cat, total: priceByCategory[cat] || 0 }))
    .filter(e => e.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)
  const maxCatPrice = Math.max(1, ...catEntries.map(e => e.total))

  return (
    <StatsDisclosure title="Price" metric={`${formatPrice(totalPrice, price_source)} total`}>

      {/* Price by category bars */}
      {catEntries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {catEntries.map(({ cat, total }) => (
            <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <div style={{ flex: '0 1 clamp(72px, 30vw, 100px)', fontSize: '0.72rem', color: CAT_COLORS[cat] || 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cat}
              </div>
              <div style={{ flex: 1, height: 7, background: 'var(--s-medium)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(total / maxCatPrice) * 100}%`, background: CAT_COLORS[cat] || 'rgba(201,168,76,0.5)', opacity: 0.7, borderRadius: 3, transition: 'width 0.4s ease', minWidth: 2 }} />
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--green)', width: 46, textAlign: 'right', flexShrink: 0 }}>{formatPrice(total, price_source)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Top expensive cards */}
      {topCards.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className={styles.contentLabel}>Most Expensive</div>
          {topCards.map((c, i) => (
            <button key={i} type="button" className={styles.topCardRow} onClick={() => setSelectedCard(c.card)} aria-label={`Preview ${c.name}`}>
              <div style={{ width: 28, height: 20, borderRadius: 3, overflow: 'hidden', flexShrink: 0, background: 'var(--s2)' }}>
                {c.image_uri && <img src={c.image_uri} alt={c.name} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center 15%' }} />}
              </div>
              <div style={{ flex: 1, fontSize: '0.75rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.name}{c.qty > 1 && <span style={{ color: 'var(--text-faint)', marginLeft: 4 }}>×{c.qty}</span>}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--green)', fontFamily: 'var(--font-display)', flexShrink: 0 }}>{formatPrice(c.total, price_source)}</div>
            </button>
          ))}
        </div>
      )}
      <CardPreviewDialog
        label={selectedCard?.name || null}
        cards={selectedCard ? [selectedCard] : []}
        onClose={() => setSelectedCard(null)}
      />
    </StatsDisclosure>
  )
}

function TokensExtras({ allItems, tokenImages }) {
  if (!allItems.length) return null
  return (
    <StatsDisclosure title="Tokens & Extras" metric={allItems.length} bodyClassName={styles.tokenGrid}>
        {allItems.map(name => {
          const imgUri = tokenImages[name]
          return (
            <div key={name} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{
                width: 58, height: 82,
                borderRadius: 4, overflow: 'hidden',
                background: 'var(--s2)', border: '1px solid var(--s-border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                {imgUri === undefined
                  ? <div style={{ width: '100%', height: '100%', background: 'linear-gradient(90deg,var(--s2) 25%,var(--s3) 50%,var(--s2) 75%)', backgroundSize: '200%', animation: 'shimmer 1.5s infinite' }} />
                  : imgUri
                    ? <img src={imgUri} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : <span style={{ fontSize: '0.58rem', color: 'var(--text-faint)', textAlign: 'center', padding: 4, lineHeight: 1.3 }}>{name}</span>
                }
              </div>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-faint)', textAlign: 'center', maxWidth: 62, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            </div>
          )
        })}
    </StatsDisclosure>
  )
}

// ── Main DeckStats Component ──────────────────────────────────────────────────

/**
 * Shared deck stats panel.
 *
 * @param {Array}    cards            - Normalized cards (use normalizeDeckBrowserCards or normalizeDeckBuilderCards)
 * @param {number|null} bracketOverride  - Manual bracket override (null = auto)
 * @param {Function} onBracketOverride  - Callback to set override
 */
export default function DeckStats({ cards, bracketOverride, onBracketOverride, price_source, showBracket = true, combos = null, bracketAnalysis: bracketAnalysisProp = null, gameChangerNames: gameChangerNamesProp = null }) {
  const [curveMode, setCurveMode] = useState('flat')
  const [tokenImages, setTokenImages] = useState({}) // name → img uri | null

  // Commander Bracket estimate — Game Changers list is live from Scryfall
  // (7-day localStorage cache inside fetchGameChangerNames). A caller that
  // already computed this (e.g. DeckBuilder, to share it with the art banner)
  // can pass it in directly and skip the fetch/analysis below entirely.
  const [gameChangerNamesState, setGameChangerNames] = useState(null)
  const gameChangerNames = gameChangerNamesProp || gameChangerNamesState
  useEffect(() => {
    if (bracketAnalysisProp || gameChangerNamesProp) return
    if (!showBracket || gameChangerNames) return
    let active = true
    fetchGameChangerNames()
      .then(names => { if (active) setGameChangerNames(names) })
      .catch(() => { if (active) setGameChangerNames(new Set()) })
    return () => { active = false }
  }, [showBracket, gameChangerNames, bracketAnalysisProp, gameChangerNamesProp])

  const bracketAnalysis = useMemo(() => {
    if (bracketAnalysisProp) return bracketAnalysisProp
    if (!showBracket) return null
    return analyzeBracket({
      cards,
      gameChangerNames: gameChangerNames || new Set(),
      comboCardLists: combos?.fetched ? (combos.nameLists || []) : null,
    })
  }, [bracketAnalysisProp, showBracket, cards, gameChangerNames, combos?.fetched, combos?.nameLists])

  const stats = useMemo(() => {
    const curve = {}
    const curveByColor = {}
    const curveByType  = {}
    const costColors = { W: 0, U: 0, B: 0, R: 0, G: 0 }
    const costCards  = { W: 0, U: 0, B: 0, R: 0, G: 0 }
    const prodMana   = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }
    const typeCounts = {}
    const catCounts  = {}

    let nonLandCount = 0, cmcSum = 0

    for (const c of cards) {
      const type = getCardType(c.type_line || '')
      const qty  = c.qty || 1

      typeCounts[type] = (typeCounts[type] || 0) + qty

      // Functional category
      const cat = getCardCategory(
        (c.oracle_text || '').toLowerCase(),
        (c.type_line || '').toLowerCase(),
        c.keywords || [],
      )
      catCounts[cat] = (catCounts[cat] || 0) + qty

      // Production from all cards
      for (const color of getProducedColors(c)) {
        const k = COLOR_ORDER.includes(color) ? color : 'C'
        prodMana[k] += qty
      }

      if (type !== 'Lands') {
        const cmc = c.cmc ?? 0
        const bucket = Math.min(Math.floor(cmc), 7)
        curve[bucket] = (curve[bucket] || 0) + qty
        nonLandCount += qty
        cmcSum += cmc * qty

        // Curve by color
        if (!curveByColor[bucket]) curveByColor[bucket] = {}
        const ci = c.color_identity || []
        const colorKey = ci.length === 0 ? 'C' : ci.length > 1 ? 'M' : ci[0]
        curveByColor[bucket][colorKey] = (curveByColor[bucket][colorKey] || 0) + qty

        // Curve by type
        if (!curveByType[bucket]) curveByType[bucket] = {}
        curveByType[bucket][type] = (curveByType[bucket][type] || 0) + qty

        const mc = c.mana_cost || ''
        const pips = countColorPips(mc)
        const countedColors = new Set()
        for (const [k, v] of Object.entries(pips)) {
          if (v > 0) {
            costColors[k] += v
            if (!countedColors.has(k)) { costCards[k] += 1; countedColors.add(k) }
          }
        }
        if (!mc && c.color_identity?.length) {
          for (const k of c.color_identity) if (k in costColors) { costColors[k] += 1; costCards[k] += 1 }
        }
      }
    }

    const totalCostPips = Object.values(costColors).reduce((a, b) => a + b, 0)
    const totalProdMana = Object.values(prodMana).reduce((a, b) => a + b, 0)
    const avgCmc = nonLandCount > 0 ? (cmcSum / nonLandCount).toFixed(2) : '—'

    const kwCounts = getKeywordCounts(cards)
    const creatureTypeCounts = getCreatureTypeCounts(cards)
    const combinedOracle = cards.map(c => c.oracle_text || '').join('\n')
    const tokenNames = extractTokenNames(combinedOracle)
    const extras = extractTokenExtras(combinedOracle)

    // Price stats
    let totalPrice = 0, pricedCardCount = 0
    const priceByCategory = {}
    const priceByCard = []
    for (const c of cards) {
      const p = c.price
      const qty = c.qty || 1
      if (p != null && p > 0) {
        const cardTotal = p * qty
        totalPrice += cardTotal
        pricedCardCount++
        const cat = getCardCategory(
          (c.oracle_text || '').toLowerCase(),
          (c.type_line || '').toLowerCase(),
          c.keywords || [],
        )
        priceByCategory[cat] = (priceByCategory[cat] || 0) + cardTotal
        priceByCard.push({ name: c.name, price: p, qty, total: cardTotal, image_uri: c.image_uri, card: c })
      }
    }
    priceByCard.sort((a, b) => b.total - a.total)
    const topCards = priceByCard.slice(0, 5)
    const avgPrice = pricedCardCount > 0 ? totalPrice / pricedCardCount : 0

    return { curve, curveByColor, curveByType, costColors, costCards, prodMana, typeCounts, catCounts, totalCostPips, totalProdMana, nonLandCount, avgCmc, kwCounts, creatureTypeCounts, tokenNames, extras, totalPrice, avgPrice, priceByCategory, topCards }
  }, [cards])

  // Fetch token + extra images from Scryfall — newest paper printing
  useEffect(() => {
    const items = [
      ...stats.tokenNames.map(name => ({ name, kind: 'token' })),
      ...stats.extras.map(name => ({ name, kind: 'extra' })),
    ]
    if (!items.length) return undefined

    let active = true
    fetchDeckTokenCards(items, 'small', {
      concurrency: 2,
      onResult: result => {
        if (!active) return
        setTokenImages(prev => ({ ...prev, [result.name]: result.imageUri }))
      },
    }).catch(() => {})

    return () => { active = false }
  }, [stats.tokenNames, stats.extras])

  const { curve, curveByColor, curveByType, costColors, costCards, prodMana, typeCounts, catCounts, totalCostPips, totalProdMana, avgCmc, kwCounts, creatureTypeCounts, tokenNames, extras, totalPrice, avgPrice, priceByCategory, topCards } = stats
  const curveSegData = curveMode === 'color' ? curveByColor : curveByType
  const effectiveBracket = bracketOverride ?? bracketAnalysis?.bracket ?? 1
  const deckSize = Object.values(typeCounts).reduce((sum, count) => sum + count, 0)
  const landCount = typeCounts['Lands'] || 0

  const hasOracleData = cards.some(c => c.oracle_text)

  return (
    <div className={styles.statsStack}>
      {showBracket && bracketAnalysis && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <BracketBadge
            analysis={bracketAnalysis}
            bracket={effectiveBracket}
            isOverridden={bracketOverride != null}
            onOverride={onBracketOverride}
            combos={combos}
          />
        </div>
      )}

      {/* Mana demand and production are directly comparable in one panel. */}
      {(totalCostPips > 0 || totalProdMana > 0) && (
        <StatsDisclosure
          title="Mana"
          metric={`${totalProdMana} sources · ${totalCostPips} pips`}
          bodyClassName={styles.manaBody}
        >
          {totalCostPips > 0 && (
            <ColorStackBar colorCounts={costColors} totalPips={totalCostPips} title="Mana Cost" cardCounts={costCards} />
          )}
          {totalProdMana > 0 && (
            <ColorStackBar colorCounts={prodMana} totalPips={totalProdMana} title="Mana Production" />
          )}
        </StatsDisclosure>
      )}

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 14, minWidth: 0 }}>
        <ManaCurveChart
          curve={curve}
          avgCmc={avgCmc}
          curveMode={curveMode}
          curveSegData={curveSegData}
          onModeChange={setCurveMode}
        />
        <TypeBreakdown typeCounts={typeCounts} cards={cards} />
      </div>

      {/* Draw probabilities (hypergeometric) */}
      <ProbabilitySection
        deckSize={deckSize}
        landCount={landCount}
        catCounts={catCounts}
        typeCounts={typeCounts}
        creatureTypeCounts={creatureTypeCounts}
      />

      {/* Category breakdown + Keywords (only when oracle text is available) */}
      {hasOracleData && (
        <CategoryBreakdown catCounts={catCounts} cards={cards} />
      )}

      {/* Creature types (from type lines — no oracle text needed) */}
      {(kwCounts.length > 0 || creatureTypeCounts.length > 0) && (
        <StatsDisclosure
          title="Card Traits"
          metric={`${kwCounts.length} keywords · ${creatureTypeCounts.length} creature types`}
          bodyClassName={styles.traitGrid}
        >
          {kwCounts.length > 0 && (
            <PillFrequency embedded label="Keywords" counts={kwCounts} cards={cards} getMatchingCards={cardsWithKeyword} />
          )}
          {creatureTypeCounts.length > 0 && (
            <PillFrequency embedded label="Creature Types" counts={creatureTypeCounts} cards={cards} getMatchingCards={cardsWithCreatureType} />
          )}
        </StatsDisclosure>
      )}

      {/* Price breakdown */}
      <PriceBreakdown
        totalPrice={totalPrice}
        avgPrice={avgPrice}
        priceByCategory={priceByCategory}
        topCards={topCards}
        price_source={price_source}
      />

      {/* Tokens & Extras */}
      {hasOracleData && (tokenNames.length > 0 || extras.length > 0) && (
        <TokensExtras allItems={[...tokenNames, ...extras]} tokenImages={tokenImages} />
      )}
    </div>
  )
}
