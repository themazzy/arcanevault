import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { enrichCards, getPrice, formatPrice, getScryfallKey } from '../lib/scryfall'
import { useSettings } from '../components/SettingsContext'
import { CardDetail, FilterBar, applyFilterSort, EMPTY_FILTERS } from '../components/CardComponents'
import { EmptyState } from '../components/UI'
import styles from './DeckBrowser.module.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_ORDER = ['Commander', 'Creatures', 'Planeswalkers', 'Battles', 'Instants',
  'Sorceries', 'Artifacts', 'Enchantments', 'Lands', 'Other']

// MTG-style SVG type icons (14×14 default)
function TypeIcon({ type, size = 14, style }) {
  const s = size
  const icons = {
    Commander: ( // Crown
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm2 4h10v-2H7v2z"/>
      </svg>
    ),
    Creatures: ( // Sword (MTG-style blade pointing up-right)
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M20.71 3.29a1 1 0 00-1.42 0L13 9.59l-1.29-1.3-1.42 1.42 1.3 1.29L3 19.59V21h1.41l8.59-8.59 1.29 1.3 1.42-1.42-1.3-1.29 6.3-6.29a1 1 0 000-1.42z"/>
        <path d="M6.5 17.5l-2 2 1 1 2-2z" opacity=".5"/>
      </svg>
    ),
    Planeswalkers: ( // Spark / flame person
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <circle cx="12" cy="5" r="2"/>
        <path d="M12 9c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4zm-1 9h2l1 4h-4l1-4z"/>
        <path d="M10 9l-3 5h2l-1 5h4l-1-5h2z" opacity=".3"/>
      </svg>
    ),
    Battles: ( // Shield
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm0 15l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/>
      </svg>
    ),
    Instants: ( // Lightning bolt
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M7 2v11h3v9l7-12h-4l4-8z"/>
      </svg>
    ),
    Sorceries: ( // Flame / arcane symbol
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M12 23c-4.97 0-9-4.03-9-9 0-4.97 3.5-8.5 7-10 .5 1.5-.5 3.5-1 4.5 1.5-1 3-2 3.5-3.5C13 8.5 14 11.5 12 14c1 0 2.5-.5 3-1.5.5 2.5-.5 5-1 6 3-1.5 5-4.5 5-8 0-5.52-4.48-10-10-10C4.48 0 0 4.48 0 10c0 5.52 4.48 10 10 10h2c-4.42 0-8-3.58-8-8 0-1.5.42-2.89 1.15-4.08C5.77 10.76 8 13.5 8 15c.5-1.5-.5-4 0-6 1 1.5 2 3 1.5 5.5C10.5 13 11 12 12 12c-1 4-4 6-4 9 0 .34.03.67.08 1H12z"/>
      </svg>
    ),
    Artifacts: ( // Cog / gear
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a7 7 0 00-1.62-.94l-.36-2.54A.484.484 0 0014 2h-4a.484.484 0 00-.48.41l-.36 2.54a7.4 7.4 0 00-1.62.94l-2.39-.96a.48.48 0 00-.59.22L2.74 8.47c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.36 1.04.67 1.62.94l.36 2.54c.05.24.27.41.48.41h4c.24 0 .44-.17.47-.41l.36-2.54a7.4 7.4 0 001.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 00-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
      </svg>
    ),
    Enchantments: ( // Sparkle / aura eye
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M12 3L9.5 8.5H4l4.5 3.5L7 17.5l5-3.5 5 3.5-1.5-5.5L20 8.5h-5.5z" opacity=".35"/>
        <path d="M12 2l1.09 3.26L16.18 4l-2.09 2.74L17 9l-3.35-.5L12 12l-1.65-3.5L7 9l2.91-2.26L7.82 4l3.09 1.26z"/>
      </svg>
    ),
    Lands: ( // Mountain peak
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M14 6l-1-2H5v17h2v-7h5l1 2h7V6h-6zm4 8h-4l-1-2H7V6h5l1 2h5v6z"/>
      </svg>
    ),
    Other: ( // Question mark in circle
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>
      </svg>
    ),
  }
  return icons[type] || icons.Other
}

const TYPE_ICONS_KEYS = Object.fromEntries(
  ['Commander','Creatures','Planeswalkers','Battles','Instants','Sorceries','Artifacts','Enchantments','Lands','Other'].map(k => [k, k])
)

const CAT_ORDER = ['Ramp', 'Mana Rock', 'Card Draw', 'Removal', 'Board Wipe',
  'Counterspell', 'Tutor', 'Burn', 'Tokens', 'Graveyard', 'Protection',
  'Extra Turns', 'Combo', 'Creature', 'Artifact', 'Enchantment',
  'Instant', 'Sorcery', 'Planeswalker', 'Land', 'Other']

const CAT_COLORS = {
  'Ramp':'#4a9a5a', 'Mana Rock':'#5a8a9a', 'Card Draw':'#5a70bb', 'Removal':'#cc5555',
  'Board Wipe':'#aa3333', 'Counterspell':'#4470cc', 'Tutor':'#9a5abb', 'Burn':'#e07020',
  'Tokens':'#6a9a4a', 'Graveyard':'#7a4a8a', 'Protection':'#aaaaaa',
  'Extra Turns':'#cc88aa', 'Combo':'#c9a84c', 'Creature':'#5a8a5a',
  'Artifact':'#8a8a9a', 'Enchantment':'#7a6aaa', 'Instant':'#5555bb',
  'Sorcery':'#9944aa', 'Planeswalker':'#cc7722', 'Land':'#6a7a5a', 'Other':'#666',
}

const COLOR_ORDER = ['W','U','B','R','G']
const COLOR_BG = { W:'#c0a850', U:'#2a5890', B:'#382050', R:'#7a2c28', G:'#1c5830', C:'#505068' }
const COLOR_LABEL = { W:'White', U:'Blue', B:'Black', R:'Red', G:'Green', C:'Colorless', M:'Multi' }

// Curve segmentation
const CURVE_SEG_ORDER = {
  color: ['W','U','B','R','G','M','C'],
  type:  ['Creatures','Planeswalkers','Battles','Instants','Sorceries','Enchantments','Artifacts','Other'],
}
const CURVE_SEG_COLOR = {
  W:'#c0a850', U:'#2a5890', B:'#6a4080', R:'#7a2c28', G:'#1c5830', M:'#9a7030', C:'#505068',
  Creatures:'#4a8a5a', Planeswalkers:'#bb6622', Battles:'#aa4444',
  Instants:'#4455bb', Sorceries:'#8833aa', Enchantments:'#6a5aaa',
  Artifacts:'#7a7a8a', Other:'#555',
}

// Game changers for bracket
const BRACKET_4_CARDS = new Set([
  "Thassa's Oracle","Demonic Consultation","Tainted Pact","Underworld Breach",
  "Flash","Ad Nauseam","Hermit Druid","Food Chain","Earthcraft",
])
const BRACKET_3_CARDS = new Set([
  "Mana Crypt","Mana Vault","Grim Monolith","Chrome Mox","Mox Diamond","Mox Opal","Jeweled Lotus",
  "Demonic Tutor","Vampiric Tutor","Imperial Seal","Mystical Tutor","Enlightened Tutor",
  "Worldly Tutor","Survival of the Fittest","Diabolic Intent",
  "Rhystic Study","Smothering Tithe","Necropotence","Dark Confidant","Skullclamp",
  "Sensei's Divining Top","Sylvan Library","Wheel of Fortune","Timetwister","Time Spiral",
  "Mana Drain","Force of Will","Force of Negation","Fierce Guardianship",
  "Cyclonic Rift","Dockside Extortionist","Hullbreacher","Opposition Agent","Protean Hulk",
  "Gaea's Cradle","Blood Moon","Stasis","Winter Orb","Back to Basics","Trinisphere",
])
const BRACKET_2_CARDS = new Set(["Sol Ring","Arcane Signet","Commander's Sphere"])
const BRACKET_META = {
  1:{ label:'Casual',      color:'#6aaa6a', desc:'Precon power level, no notable game-changers.' },
  2:{ label:'Focused',     color:'#5a9abb', desc:'Some staples; plays fair but consistently.' },
  3:{ label:'Optimized',   color:'#c9a84c', desc:'Tutors, fast mana, powerful synergies.' },
  4:{ label:'Competitive', color:'#cc5555', desc:'Built to win as fast as possible (cEDH).' },
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

function getCardCategory(card, sfCard) {
  const oracle = (sfCard?.oracle_text || '').toLowerCase()
  const type   = (sfCard?.type_line   || '').toLowerCase()
  const kw     = (sfCard?.keywords    || []).map(k => k.toLowerCase())

  // Specific functional categories first
  if (/counter target (spell|creature spell|instant or sorcery|noncreature spell)/.test(oracle)) return 'Counterspell'
  if (/search your library for a?.*(basic )?land/.test(oracle))                                  return 'Ramp'
  if (type.includes('artifact') && /\{t\}.*add /.test(oracle))                                   return 'Mana Rock'
  if (!type.includes('land') && /add \{[wubrg2c]/.test(oracle))                                  return 'Ramp'
  if (/draw (two|three|four|\d+) cards|draw a card/.test(oracle))                                return 'Card Draw'
  if (/(destroy|exile) all (creatures|permanents|nonland)/.test(oracle))                         return 'Board Wipe'
  if (/search your library for a? ?(instant|sorcery|creature|artifact|enchantment|planeswalker)/.test(oracle) &&
      !oracle.includes('basic land'))                                                              return 'Tutor'
  if (/(exile|destroy) target (creature|permanent|artifact|enchantment|planeswalker)/.test(oracle)) return 'Removal'
  if (/deals? \d+ damage to (any target|target player|each opponent|each player)/.test(oracle))  return 'Burn'
  if (/create (a|one|two|three|four|\d+) .*token/.test(oracle))                                  return 'Tokens'
  if (/return.*from (your |a )?(graveyard|exile)/.test(oracle))                                  return 'Graveyard'
  if (/gains? hexproof|gains? indestructible|protection from/.test(oracle))                      return 'Protection'
  if (/take an? extra turn/.test(oracle))                                                         return 'Extra Turns'
  if (/infinite|whenever.*untap.*\{t\}.*\{t\}|win the game|you lose no life/.test(oracle))      return 'Combo'

  // Fall back to card type
  if (type.includes('land'))        return 'Land'
  if (type.includes('creature'))    return 'Creature'
  if (type.includes('planeswalker'))return 'Planeswalker'
  if (type.includes('instant'))     return 'Instant'
  if (type.includes('sorcery'))     return 'Sorcery'
  if (type.includes('artifact'))    return 'Artifact'
  if (type.includes('enchantment')) return 'Enchantment'
  return 'Other'
}

// Infer what colors a card produces — Scryfall's produced_mana field is unreliable
// (absent for most lands/dorks). Fall back to land subtypes + oracle text + color_identity.
const LAND_SUBTYPE_COLOR = { forest:'G', mountain:'R', swamp:'B', island:'U', plains:'W', wastes:'C' }

function getProducedColors(sf) {
  if (!sf) return []

  // 1. Use Scryfall's field if present
  if (sf.produced_mana?.length) return sf.produced_mana

  const typeLine  = (sf.type_line    || '').toLowerCase()
  const oracle    = (sf.oracle_text  || '').toLowerCase()
  const isLand    = typeLine.includes('land')

  // 2. For lands: extract from land subtypes (Forest/Mountain/Swamp/Island/Plains/Wastes)
  if (isLand) {
    const fromSubtype = Object.entries(LAND_SUBTYPE_COLOR)
      .filter(([k]) => typeLine.includes(k))
      .map(([, v]) => v)
    if (fromSubtype.length) return [...new Set(fromSubtype)]
    // Non-basic land with no known subtype → use color_identity
    const ci = (sf.color_identity || []).filter(c => 'WUBRG'.includes(c))
    return ci.length ? ci : ['C']
  }

  // 3. Non-land mana producers: oracle has "add {"
  if (/add \{/.test(oracle)) {
    // Detect specific colors from oracle: {G}, {R}, {W}, {U}, {B}
    const found = []
    const re = /add (?:[^.]*?)\{([WUBRG2C])/g
    let m
    while ((m = re.exec(oracle)) !== null) {
      if ('WUBRG'.includes(m[1])) { if (!found.includes(m[1])) found.push(m[1]) }
      else if (m[1] === 'C' || m[1] === '2') { if (!found.includes('C')) found.push('C') }
    }
    if (found.length) return found
    // Has "add {" but couldn't parse color → use color_identity, fallback colorless
    const ci = (sf.color_identity || []).filter(c => 'WUBRG'.includes(c))
    return ci.length ? ci : ['C']
  }

  return []
}

function countColorPips(manaCost) {
  const counts = { W:0, U:0, B:0, R:0, G:0 }
  if (!manaCost) return counts
  const re = /\{([WUBRG])(?:\/[WUBRG2P])?\}/g
  let m
  while ((m = re.exec(manaCost)) !== null) counts[m[1]]++
  return counts
}

function calcDeckBracket(cardNames) {
  const b4=[]; const b3=[]; const b2=[]
  for (const name of cardNames) {
    if (BRACKET_4_CARDS.has(name)) b4.push(name)
    else if (BRACKET_3_CARDS.has(name)) b3.push(name)
    else if (BRACKET_2_CARDS.has(name)) b2.push(name)
  }
  if (b4.length > 0 || b3.length >= 4) return { bracket:4, gc:[...b4,...b3.slice(0,8)] }
  if (b3.length >= 2)                  return { bracket:4, gc:b3.slice(0,8) }
  if (b3.length === 1)                 return { bracket:3, gc:b3 }
  if (b2.length >= 1)                  return { bracket:2, gc:b2.slice(0,5) }
  return { bracket:1, gc:[] }
}

// ── Mana symbol ───────────────────────────────────────────────────────────────

function InlineMana({ cost, size = 14 }) {
  if (!cost) return null
  const syms = [...cost.matchAll(/\{([^}]+)\}/g)].map(m => m[1])
  return (
    <span style={{ display:'inline-flex', gap:2, alignItems:'center', flexWrap:'wrap' }}>
      {syms.map((s, i) => (
        <img key={i}
          src={`https://svgs.scryfall.io/card-symbols/${s.replace(/\//g,'').toUpperCase()}.svg`}
          alt={`{${s}}`}
          style={{ width:size, height:size, verticalAlign:'middle', display:'inline-block', flexShrink:0 }}
        />
      ))}
    </span>
  )
}

// ── Stat Components ───────────────────────────────────────────────────────────

function BracketBadge({ bracket, autobracket, gameChangers, onOverride }) {
  const meta = BRACKET_META[bracket] || BRACKET_META[1]
  const [open, setOpen] = useState(false)
  const isOverridden = bracket !== autobracket
  return (
    <div className={styles.bracketWrap}>
      <button className={styles.bracketBtn}
        style={{ borderColor: meta.color+'55', color: meta.color }}
        onClick={() => setOpen(v => !v)}>
        <span className={styles.bracketNum} style={{ background: meta.color }}>{bracket}</span>
        {meta.label}
        {isOverridden && <span style={{ fontSize:'0.6rem', opacity:0.6 }}>✎</span>}
        <span style={{ fontSize:'0.65rem', opacity:0.7 }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className={styles.bracketDetail}>
          <p className={styles.bracketDesc}>{meta.desc}</p>
          <div className={styles.bracketGcTitle}>Set bracket manually:</div>
          <div className={styles.bracketBtns}>
            {[1,2,3,4].map(n => {
              const m = BRACKET_META[n]
              return (
                <button key={n} className={styles.bracketPickBtn}
                  style={{ borderColor: m.color+'66', color: n === bracket ? '#0a0a0f' : m.color,
                           background: n === bracket ? m.color : 'transparent' }}
                  onClick={() => { onOverride(n); setOpen(false) }}>
                  {n}
                </button>
              )
            })}
            {isOverridden && (
              <button className={styles.bracketResetBtn}
                onClick={() => { onOverride(null); setOpen(false) }}>
                Reset
              </button>
            )}
          </div>
          {gameChangers.length > 0 && (
            <>
              <div className={styles.bracketGcTitle} style={{ marginTop:10 }}>Auto-detected game-changers:</div>
              <ul className={styles.bracketGcList}>{gameChangers.map((n,i) => <li key={i}>{n}</li>)}</ul>
            </>
          )}
          {gameChangers.length === 0 && <div style={{fontSize:'0.78rem',color:'var(--text-faint)',marginTop:6}}>No game-changing cards detected.</div>}
        </div>
      )}
    </div>
  )
}

// Stacked color bar (cost or production)
function ColorStackBar({ colorCounts, totalPips, title }) {
  const allKeys = [...COLOR_ORDER, 'C']
  const entries = allKeys.map(c => ({ c, v: colorCounts[c] || 0 })).filter(x => x.v > 0)
  if (!entries.length) return null
  return (
    <div className={styles.stackBarWrap}>
      <div className={styles.stackBarLabel}>{title}</div>
      <div className={styles.stackBar}>
        {entries.map(({ c, v }) => (
          <div key={c} className={styles.stackBarSeg}
            style={{ flex: v, background: COLOR_BG[c] || '#505068', minWidth: 20 }}
            title={`${COLOR_LABEL[c] || c}: ${v} (${Math.round((v/totalPips)*100)}%)`}>
            <img src={`https://svgs.scryfall.io/card-symbols/${c}.svg`} alt={c}
              style={{ width:18, height:18, opacity:0.9 }} />
          </div>
        ))}
      </div>
    </div>
  )
}

// Archidekt-style per-color Cost vs Production comparison table
function ColorCostProdRows({ costColors, prodMana, totalCostPips, totalProdMana }) {
  const allColors = [...COLOR_ORDER, 'C']
  const rows = allColors.map(sym => ({
    sym,
    costPips: costColors[sym] || 0,
    prodSrcs: prodMana[sym]   || 0,
    costPct: totalCostPips > 0 ? Math.round(((costColors[sym]||0) / totalCostPips) * 100) : 0,
    prodPct: totalProdMana > 0 ? Math.round(((prodMana[sym]||0) / totalProdMana) * 100) : 0,
  })).filter(r => r.costPips > 0 || r.prodSrcs > 0)

  if (!rows.length) return null
  return (
    <div className={styles.colorMatrix}>
      <div className={styles.colorMatrixHeader}>
        <span />
        <span className={styles.colorMatrixHdr}>Cost (pips)</span>
        <span className={styles.colorMatrixHdr}>Production (sources)</span>
      </div>
      {rows.map(({ sym, costPips, prodSrcs, costPct, prodPct }) => (
        <div key={sym} className={styles.colorMatrixRow}>
          <img src={`https://svgs.scryfall.io/card-symbols/${sym}.svg`} alt={sym} className={styles.colorMatrixPip} />
          <div className={styles.colorMatrixCell}>
            <div className={styles.colorMatrixTrack}>
              <div className={styles.colorMatrixFill} style={{ width:`${costPct}%`, background: COLOR_BG[sym] || '#505068' }} />
            </div>
            <span className={styles.colorMatrixVal}>{costPips}</span>
          </div>
          <div className={styles.colorMatrixCell}>
            <div className={styles.colorMatrixTrack}>
              <div className={styles.colorMatrixFill} style={{ width:`${prodPct}%`, background: (COLOR_BG[sym] || '#505068') + '99' }} />
            </div>
            <span className={styles.colorMatrixVal}>{prodSrcs}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

const BAR_MAX_PX = 72

function ManaCurveChart({ curve, avgCmc, curveMode, curveSegData, onModeChange }) {
  const maxVal = Math.max(1, ...Object.values(curve))
  const labels = ['0','1','2','3','4','5','6','7+']
  const segOrder = CURVE_SEG_ORDER[curveMode] || []
  const [tooltip, setTooltip] = useState(null) // { x, y, label, items: [{name, count, color}] }

  // Legend: only keys that appear in any bucket
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
      items = [] // header already shows CMC label + total
    }
    setTooltip({ x, y, label: cmcLabel, total: count, items })
  }

  return (
    <div className={styles.chartCard}>
      <div className={styles.chartTitleRow}>
        <span className={styles.chartTitle}>Mana Curve</span>
        {avgCmc && <span className={styles.chartSub}>avg {avgCmc}</span>}
        <div className={styles.curveModeToggle}>
          {[['flat','—'],['color','Color'],['type','Type']].map(([m,l]) => (
            <button key={m}
              className={`${styles.curveModeBtn} ${curveMode === m ? styles.curveModeBtnActive : ''}`}
              onClick={() => onModeChange(m)}>{l}</button>
          ))}
        </div>
      </div>
      <div className={styles.curveChart} data-curve-chart style={{ position: 'relative' }}
        onMouseLeave={() => setTooltip(null)}>
        {labels.map((label, i) => {
          const count = curve[i] || 0
          const barPx = count > 0 ? Math.max(Math.round((count/maxVal)*BAR_MAX_PX), 4) : 0
          const segs = curveMode !== 'flat' ? curveSegData[i] : null
          return (
            <div key={i} className={styles.curveCol}>
              <span className={styles.curveCount}>{count > 0 ? count : ''}</span>
              <div className={styles.curveBarSlot}>
                {barPx > 0 && (
                  segs
                    ? <div className={styles.curveBar}
                        style={{ height: barPx, background: 'none', display:'flex', flexDirection:'column', overflow:'hidden', borderRadius:'2px 2px 0 0', cursor:'pointer' }}
                        onMouseEnter={e => showTooltip(e, label, count, segs)}>
                        {segOrder.filter(k => (segs[k]||0) > 0).map(k => (
                          <div key={k} style={{ flex: segs[k], background: CURVE_SEG_COLOR[k] }} />
                        ))}
                      </div>
                    : <div className={styles.curveBar} style={{ height: barPx, cursor: 'pointer' }}
                        onMouseEnter={e => showTooltip(e, label, count, null)} />
                )}
              </div>
              <span className={styles.curveLabel}>{label}</span>
            </div>
          )
        })}

        {/* Floating tooltip */}
        {tooltip && (
          <div style={{
            position: 'absolute',
            left: tooltip.x,
            top: Math.max(0, tooltip.y - 10),
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
      {legendKeys.length > 0 && (
        <div className={styles.curveLegend}>
          {legendKeys.map(k => (
            <div key={k} className={styles.curveLegendItem}>
              <div className={styles.curveLegendDot} style={{ background: CURVE_SEG_COLOR[k] }} />
              <span>{curveMode === 'color' ? (COLOR_LABEL[k] || k) : k}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TypeBreakdown({ typeCounts }) {
  const entries = Object.entries(typeCounts)
    .filter(([k]) => k !== 'Lands' && k !== 'Commander')
    .sort((a,b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))
  const landCount = typeCounts['Lands'] || 0
  const maxVal = Math.max(1, ...entries.map(([,v]) => v))
  return (
    <div className={styles.chartCard}>
      <div className={styles.chartTitleRow}><span className={styles.chartTitle}>Card Types</span></div>
      <div className={styles.typeBars}>
        {entries.filter(([,v]) => v > 0).map(([type, count]) => (
          <div key={type} className={styles.typeRow}>
            <div className={styles.typeLabel}><TypeIcon type={type} size={13} style={{ verticalAlign:'middle', marginRight:3 }} /> {type}</div>
            <div className={styles.typeBarTrack}>
              <div className={styles.typeBarFill} style={{ width:`${(count/maxVal)*100}%` }} />
            </div>
            <div className={styles.typeCount}>{count}</div>
          </div>
        ))}
        {landCount > 0 && (
          <div className={styles.typeRow} style={{ opacity:0.7 }}>
            <div className={styles.typeLabel}><TypeIcon type="Lands" size={13} style={{ verticalAlign:'middle', marginRight:3 }} /> Lands</div>
            <div className={styles.typeBarTrack}>
              <div className={styles.typeBarFill} style={{ width:`${(landCount/Math.max(maxVal,landCount))*100}%`, background:'var(--text-faint)' }} />
            </div>
            <div className={styles.typeCount}>{landCount}</div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Full Deck Stats Panel ─────────────────────────────────────────────────────

function DeckStats({ cards, sfMap, bracketResult, bracketOverride, onBracketOverride }) {
  const [curveMode, setCurveMode] = useState('flat')

  const stats = useMemo(() => {
    const curve = {}
    const curveByColor = {}
    const curveByType  = {}
    const costColors = { W:0, U:0, B:0, R:0, G:0 }
    const prodMana   = { W:0, U:0, B:0, R:0, G:0, C:0 }
    const typeCounts = {}

    let nonLandCount=0, cmcSum=0

    for (const c of cards) {
      const sf   = sfMap[getScryfallKey(c)]
      const type = getCardType(sf?.type_line || '')
      const qty  = c._folder_qty || c.qty || 1

      typeCounts[type] = (typeCounts[type] || 0) + qty

      // Production from ALL cards: lands, mana rocks, mana dorks, etc.
      for (const color of getProducedColors(sf)) {
        const k = COLOR_ORDER.includes(color) ? color : 'C'
        prodMana[k] += 1  // count unique sources (1 per card)
      }

      if (type !== 'Lands') {
        const cmc = sf?.cmc ?? 0
        const bucket = Math.min(Math.floor(cmc), 7)
        curve[bucket] = (curve[bucket] || 0) + qty
        nonLandCount += qty
        cmcSum += cmc * qty

        // Curve by color
        if (!curveByColor[bucket]) curveByColor[bucket] = {}
        const ci = sf?.color_identity || []
        const colorKey = ci.length === 0 ? 'C' : ci.length > 1 ? 'M' : ci[0]
        curveByColor[bucket][colorKey] = (curveByColor[bucket][colorKey] || 0) + qty

        // Curve by type
        if (!curveByType[bucket]) curveByType[bucket] = {}
        curveByType[bucket][type] = (curveByType[bucket][type] || 0) + qty

        const mc = sf?.mana_cost || sf?.card_faces?.[0]?.mana_cost || ''
        const pips = countColorPips(mc)
        for (const [k,v] of Object.entries(pips)) {
          if (v > 0) costColors[k] += v
        }
        if (!mc && sf?.color_identity?.length) {
          for (const k of sf.color_identity) if (k in costColors) costColors[k] += 1
        }
      }
    }

    const totalCostPips = Object.values(costColors).reduce((a,b)=>a+b,0)
    const totalProdMana = Object.values(prodMana).reduce((a,b)=>a+b,0)
    const avgCmc = nonLandCount > 0 ? (cmcSum/nonLandCount).toFixed(2) : '—'

    return { curve, curveByColor, curveByType, costColors, prodMana, typeCounts, totalCostPips, totalProdMana, nonLandCount, avgCmc }
  }, [cards, sfMap])

  const { curve, curveByColor, curveByType, costColors, prodMana, typeCounts, totalCostPips, totalProdMana, nonLandCount, avgCmc } = stats
  const curveSegData = curveMode === 'color' ? curveByColor : curveByType
  const effectiveBracket = bracketOverride ?? bracketResult.bracket

  return (
    <div className={styles.statsPanel}>
      {/* Pills row */}
      <div className={styles.statsRow}>
        <BracketBadge
          bracket={effectiveBracket}
          autobracket={bracketResult.bracket}
          gameChangers={bracketResult.gc}
          onOverride={onBracketOverride}
        />
        <div className={styles.statPill}>
          <span className={styles.statPillLabel}>Avg CMC</span>
          <span className={styles.statPillVal}>{avgCmc}</span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statPillLabel}>Non-Land</span>
          <span className={styles.statPillVal}>{nonLandCount}</span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statPillLabel}>Lands</span>
          <span className={styles.statPillVal}>{typeCounts['Lands'] || 0}</span>
        </div>
      </div>

      {/* Stacked bars + comparison table */}
      {(totalCostPips > 0 || totalProdMana > 0) && (
        <div className={styles.manaOverview}>
          {totalCostPips > 0 && (
            <ColorStackBar colorCounts={costColors} totalPips={totalCostPips} title="Mana Cost" />
          )}
          {totalProdMana > 0 && (
            <ColorStackBar colorCounts={prodMana} totalPips={totalProdMana} title="Mana Production" />
          )}
          <ColorCostProdRows
            costColors={costColors} prodMana={prodMana}
            totalCostPips={totalCostPips} totalProdMana={totalProdMana}
          />
        </div>
      )}

      {/* Charts */}
      <div className={styles.chartsRow}>
        <ManaCurveChart curve={curve} avgCmc={avgCmc}
          curveMode={curveMode} curveSegData={curveSegData} onModeChange={setCurveMode} />
        <TypeBreakdown typeCounts={typeCounts} />
      </div>
    </div>
  )
}

// ── View: Text ────────────────────────────────────────────────────────────────

function TextView({ groups, groupOrder, getKey }) {
  return (
    <div className={styles.textView}>
      {groupOrder.filter(g => groups[g]?.length).map(group => {
        const cards = groups[group]
        const total = cards.reduce((s,c) => s+(c._folder_qty||c.qty||1), 0)
        return (
          <div key={group} className={styles.textGroup}>
            <div className={styles.textGroupHeader}>
              <span style={{ color: CAT_COLORS[group] || 'var(--gold-dim)' }}>{group}</span>
              <span className={styles.textGroupCount}>{total}</span>
            </div>
            {cards
              .slice()
              .sort((a,b) => a.name.localeCompare(b.name))
              .map(c => (
                <div key={c.id} className={styles.textRow}>
                  <span className={styles.textQty}>{c._folder_qty||c.qty||1}x</span>
                  <span className={styles.textName}>{c.name}</span>
                  {c.foil && <span className={styles.textFoil}>✦</span>}
                </div>
              ))}
          </div>
        )
      })}
    </div>
  )
}

// ── View: Table ───────────────────────────────────────────────────────────────

function TableView({ cards, sfMap, priceSource, displayCurrency, onSelect }) {
  const [sortCol, setSortCol] = useState('name')
  const [sortDir, setSortDir] = useState(1)

  const sorted = useMemo(() => {
    return [...cards].sort((a,b) => {
      const sfA = sfMap[getScryfallKey(a)], sfB = sfMap[getScryfallKey(b)]
      let va, vb
      if (sortCol==='name')  { va=a.name; vb=b.name; return sortDir*(va<vb?-1:va>vb?1:0) }
      if (sortCol==='cmc')   { va=sfA?.cmc??99; vb=sfB?.cmc??99 }
      if (sortCol==='type')  { va=getCardType(sfA?.type_line||''); vb=getCardType(sfB?.type_line||''); return sortDir*(va<vb?-1:va>vb?1:0) }
      if (sortCol==='price') { va=getPrice(sfA,a.foil,{price_source:priceSource})??-1; vb=getPrice(sfB,b.foil,{price_source:priceSource})??-1 }
      if (sortCol==='qty')   { va=a._folder_qty||a.qty||1; vb=b._folder_qty||b.qty||1 }
      return sortDir*(va-vb)
    })
  }, [cards, sfMap, sortCol, sortDir, priceSource])

  const thClick = col => {
    if (sortCol===col) setSortDir(d => -d)
    else { setSortCol(col); setSortDir(1) }
  }
  const arrow = col => sortCol===col ? (sortDir>0?'↑':'↓') : ''

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {[['qty','Qty'],['name','Name'],['cmc','CMC'],['type','Type'],['price','Price']].map(([k,l]) => (
              <th key={k} className={styles.th} onClick={() => thClick(k)}>
                {l} <span className={styles.thArrow}>{arrow(k)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(card => {
            const sf = sfMap[getScryfallKey(card)]
            const price = getPrice(sf, card.foil, { price_source: priceSource })
            const mc = sf?.mana_cost || sf?.card_faces?.[0]?.mana_cost || ''
            return (
              <tr key={card.id} className={styles.tr} onClick={() => onSelect(card)}>
                <td className={styles.td} style={{ textAlign:'center', color:'var(--text-faint)' }}>
                  {card._folder_qty||card.qty||1}
                </td>
                <td className={styles.td}>
                  <span className={styles.tableName}>{card.name}</span>
                  {card.foil && <span className={styles.tableFoil}>✦</span>}
                </td>
                <td className={styles.td} style={{ textAlign:'center', color:'var(--text-dim)' }}>
                  <InlineMana cost={mc} size={13} />
                </td>
                <td className={styles.td} style={{ color:'var(--text-faint)', fontSize:'0.76rem' }}>
                  {(sf?.type_line||'—').split('—')[0].trim()}
                </td>
                <td className={styles.td} style={{ textAlign:'right', color: card.foil ? 'var(--purple)' : 'var(--green)', fontFamily:'var(--font-display)', fontSize:'0.8rem' }}>
                  {price != null ? formatPrice(price,priceSource,displayCurrency) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── View: Stacks ──────────────────────────────────────────────────────────────

function StacksView({ groups, groupOrder, sfMap, onSelect }) {
  return (
    <div className={styles.stacksWrap}>
      {groupOrder.filter(g => groups[g]?.length).map(group => {
        const cards = groups[group]
        const total = cards.reduce((s,c) => s+(c._folder_qty||c.qty||1), 0)
        return (
          <div key={group} className={styles.stackGroup}>
            <div className={styles.stackGroupHeader}>
              <span style={{ color: CAT_COLORS[group] || 'var(--gold-dim)' }}>{group}</span>
              <span className={styles.stackGroupCount}>{total}</span>
            </div>
            <div className={styles.stackCards}>
              {cards.map((card, idx) => {
                const sf  = sfMap[getScryfallKey(card)]
                const img = sf?.image_uris?.normal || sf?.card_faces?.[0]?.image_uris?.normal
                const qty = card._folder_qty || card.qty || 1
                return (
                  <div key={card.id} className={styles.stackCard}
                    style={{ zIndex: idx }}
                    onClick={() => onSelect(card)}
                    title={card.name}>
                    {img
                      ? <img src={img} alt={card.name} className={styles.stackCardImg} loading="lazy" />
                      : <div className={styles.stackCardPlaceholder}>{card.name}</div>
                    }
                    {qty > 1 && <div className={styles.stackQty}>×{qty}</div>}
                    {card.foil && <div className={styles.stackFoil}>✦</div>}
                    <div className={styles.stackCardName}>{card.name}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Deck List (grouped rows, existing) ────────────────────────────────────────

function DeckListRow({ card, sfCard, priceSource, displayCurrency, onClick }) {
  const price   = getPrice(sfCard, card.foil, { price_source: priceSource })
  const typeLine = sfCard?.type_line || ''
  const mc = sfCard?.mana_cost || sfCard?.card_faces?.[0]?.mana_cost || ''
  const qty = card._folder_qty || card.qty || 1
  return (
    <div className={styles.deckRow} onClick={onClick}>
      <span className={styles.deckRowQty}>×{qty}</span>
      <span className={styles.deckRowName}>{card.name}</span>
      <span className={styles.deckRowMana}><InlineMana cost={mc} size={13} /></span>
      <span className={styles.deckRowType}>{typeLine.split('—')[0].trim()}</span>
      <span className={`${styles.deckRowPrice} ${card.foil ? styles.foilPrice : ''}`}>
        {price != null ? formatPrice(price,priceSource,displayCurrency) : '—'}
      </span>
    </div>
  )
}

function DeckListGroup({ groupName, cards, sfMap, priceSource, displayCurrency, onSelect, color }) {
  const [collapsed, setCollapsed] = useState(false)
  const total = cards.reduce((s,c) => s+(c._folder_qty||c.qty||1), 0)
  return (
    <div className={styles.listGroup}>
      <button className={styles.groupHeader} onClick={() => setCollapsed(v => !v)}>
        <span className={styles.groupIcon} style={{ color: color||'var(--gold-dim)' }}>
          <TypeIcon type={groupName} size={13} style={{ verticalAlign:'middle' }} />
        </span>
        <span className={styles.groupName}>{groupName}</span>
        <span className={styles.groupCount}>{total}</span>
        <span className={styles.groupToggle}>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div className={styles.groupRows}>
          {cards.map(card => (
            <DeckListRow key={card.id} card={card}
              sfCard={sfMap[getScryfallKey(card)]}
              priceSource={priceSource} displayCurrency={displayCurrency}
              onClick={() => onSelect(card)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Card Grid (compact) ───────────────────────────────────────────────────────

function DeckCardGrid({ cards, sfMap, onSelect }) {
  return (
    <div className={styles.cardGrid}>
      {cards.map(card => {
        const sf  = sfMap[getScryfallKey(card)]
        const img = sf?.image_uris?.normal || sf?.card_faces?.[0]?.image_uris?.normal
        const qty = card._folder_qty || card.qty || 1
        return (
          <div key={card.id} className={styles.gridCard} onClick={() => onSelect(card)}>
            <div className={styles.gridImgWrap}>
              {img ? <img src={img} alt={card.name} className={styles.gridImg} loading="lazy" />
                   : <div className={styles.gridImgPlaceholder}>{card.name}</div>}
              {qty > 1 && <div className={styles.gridQty}>×{qty}</div>}
              {card.foil && <div className={styles.gridFoil}>✦</div>}
            </div>
            <div className={styles.gridInfo}>
              <div className={styles.gridName}>{card.name}</div>
              <div className={styles.gridSet}>{(card.set_code||'').toUpperCase()}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Commander Spellbook combos ────────────────────────────────────────────────

// Simple card image from Scryfall by name (cached per session)
const _comboImgCache = {}
function useComboCardImage(name) {
  const cached = Object.prototype.hasOwnProperty.call(_comboImgCache, name) ? _comboImgCache[name] : undefined
  const [img, setImg] = useState(cached || null)
  useEffect(() => {
    if (!name || Object.prototype.hasOwnProperty.call(_comboImgCache, name)) return
    _comboImgCache[name] = null // mark as in-flight
    fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const url = d?.image_uris?.normal || d?.card_faces?.[0]?.image_uris?.normal || null
        _comboImgCache[name] = url
        if (url) setImg(url)
      })
      .catch(() => { _comboImgCache[name] = null })
  }, [name])
  return img
}

function ComboCardThumb({ name, inDeck }) {
  const img = useComboCardImage(name)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, opacity: inDeck ? 1 : 0.45 }}>
      <div style={{ width: 56, height: 78, borderRadius: 4, overflow: 'hidden', border: `1px solid ${inDeck ? 'rgba(201,168,76,0.4)' : 'rgba(255,255,255,0.12)'}`, background: 'rgba(255,255,255,0.04)', flexShrink: 0 }}>
        {img ? <img src={img} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
              : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.52rem', color: 'var(--text-faint)', padding: 4, textAlign: 'center', lineHeight: 1.2 }}>{name}</div>}
      </div>
      <div style={{ fontSize: '0.6rem', color: inDeck ? 'var(--text-dim)' : '#e08878', textAlign: 'center', maxWidth: 60, lineHeight: 1.2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
        {inDeck ? name : `Missing: ${name}`}
      </div>
    </div>
  )
}

function ComboResultCard({ combo, highlight, deckCardNames }) {
  // Card names used in the combo
  const uses = (combo.uses || []).map(u => u.card?.name || u.template?.name || '').filter(Boolean)
  // Effects produced
  const results = (combo.produces || []).map(p => p.feature?.name || '').filter(Boolean)
  // Compute missing cards
  const deckSet = new Set(deckCardNames || [])
  const steps = combo.description || ''

  return (
    <div style={{
      background: highlight ? 'rgba(201,168,76,0.07)' : 'rgba(255,255,255,0.02)',
      border: `1px solid ${highlight ? 'rgba(201,168,76,0.3)' : 'rgba(255,255,255,0.07)'}`,
      borderRadius: 5, padding: '10px 14px',
    }}>
      {/* Card thumbnails */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {uses.map((name, i) => (
          <ComboCardThumb key={i} name={name} inDeck={!deckCardNames || deckSet.has(name)} />
        ))}
      </div>

      {/* Result badges */}
      {results.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: steps ? 8 : 0 }}>
          {results.slice(0, 5).map((r, i) => (
            <span key={i} style={{ fontSize: '0.66rem', background: 'rgba(100,100,160,0.2)', border: '1px solid rgba(100,100,160,0.3)', borderRadius: 3, padding: '1px 6px', color: 'var(--text-faint)' }}>{r}</span>
          ))}
        </div>
      )}

      {/* Steps / conditions — always visible */}
      {steps && (
        <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', lineHeight: 1.6, whiteSpace: 'pre-wrap', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 8 }}>
          {steps}
        </div>
      )}
    </div>
  )
}

function CombosPanel({ cards }) {
  const [included, setIncluded]     = useState([])
  const [almost, setAlmost]         = useState([])
  const [loading, setLoading]       = useState(false)
  const [fetched, setFetched]       = useState(false)
  const [open, setOpen]             = useState(false)

  const cardNames = cards.map(c => c.name)

  const fetchCombos = async () => {
    if (fetched) { setOpen(v => !v); return }
    setLoading(true)
    setOpen(true)
    try {
      // Commander Spellbook expects arrays of { card: "Name" } objects
      // We don't have a commander zone marker — send all cards in main
      const body = {
        commanders: [],
        main: cardNames.map(name => ({ card: name })),
      }
      const res = await fetch('https://backend.commanderspellbook.com/find-my-combos/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`API error ${res.status}`)
      const data = await res.json()
      const r = data.results || {}
      setIncluded(r.included || [])
      // almostIncluded = missing exactly 1 card; also grab ones needing different colors
      setAlmost([...(r.almostIncluded || []), ...(r.almostIncludedByAddingColors || [])])
      setFetched(true)
    } catch (e) {
      console.warn('[Combos]', e)
    }
    setLoading(false)
  }

  const total = included.length + almost.length

  return (
    <div style={{ marginBottom: 16 }}>
      <button
        onClick={fetchCombos}
        style={{
          background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
          borderRadius: 4, padding: '6px 16px', color: 'var(--text-dim)',
          fontFamily: 'var(--font-display)', fontSize: '0.72rem', letterSpacing: '0.06em',
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
          transition: 'all 0.15s',
        }}>
        {loading
          ? '⟳ Loading combos…'
          : fetched
            ? `${open ? '▾' : '▸'} Combos (${included.length} full · ${almost.length} partial)`
            : '⟳ Find Combos (Commander Spellbook)'}
      </button>

      {open && !loading && fetched && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {included.length > 0 ? (
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.68rem', color: 'var(--gold)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8 }}>
                ✓ Fully Included ({included.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {included.map((c, i) => <ComboResultCard key={i} combo={c} highlight deckCardNames={cardNames} />)}
              </div>
            </div>
          ) : (
            <div style={{ color: 'var(--text-faint)', fontSize: '0.82rem' }}>No complete combos found in this deck.</div>
          )}

          {almost.length > 0 && (
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.68rem', color: 'var(--text-dim)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8 }}>
                ⋯ Missing 1 Card ({almost.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {almost.slice(0, 20).map((c, i) => <ComboResultCard key={i} combo={c} highlight={false} deckCardNames={cardNames} />)}
              </div>
              {almost.length > 20 && (
                <div style={{ color: 'var(--text-faint)', fontSize: '0.78rem', marginTop: 6 }}>
                  + {almost.length - 20} more partial combos
                </div>
              )}
            </div>
          )}

          {total === 0 && (
            <div style={{ color: 'var(--text-faint)', fontSize: '0.82rem' }}>No combos found for this deck.</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main DeckBrowser ──────────────────────────────────────────────────────────

export default function DeckBrowser({ folder, onBack }) {
  const { price_source, display_currency, default_sort } = useSettings()
  const [cards, setCards]           = useState([])
  const [sfMap, setSfMap]           = useState({})
  const [loading, setLoading]       = useState(true)
  const [selected, setSelected]     = useState(null)
  const [viewMode, setViewMode]     = useState('list')
  const [groupBy, setGroupBy]       = useState('type')
  const [showStats, setShowStats]   = useState(true)
  const [bracketOverride, setBracketOverride] = useState(null)
  const [search, setSearch]     = useState('')
  const [sort, setSort]         = useState('cmc_asc')
  const [filters, setFilters]   = useState({ ...EMPTY_FILTERS })

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const { data } = await sb.from('folder_cards').select('qty, cards(*)').eq('folder_id', folder.id)
      if (data) {
        const cardList = data.map(row => ({ ...row.cards, _folder_qty: row.qty }))
        setCards(cardList)
        const map = await enrichCards(cardList, null)
        if (map) setSfMap({ ...map })
      }
      setLoading(false)
    }
    load()
  }, [folder.id])

  const { totalValue, totalQty } = useMemo(() => {
    let v=0, q=0
    for (const c of cards) {
      const p = getPrice(sfMap[getScryfallKey(c)], c.foil, { price_source })
      const qty = c._folder_qty || c.qty || 1
      if (p!=null) v += p*qty
      q += qty
    }
    return { totalValue:v, totalQty:q }
  }, [cards, sfMap, price_source])

  const bracketResult = useMemo(() => calcDeckBracket(cards.map(c => c.name)), [cards])

  const filtered = useMemo(
    () => applyFilterSort(cards, sfMap, search, sort, filters),
    [cards, sfMap, search, sort, filters]
  )

  // Build groups based on groupBy mode
  const { groups, groupOrder } = useMemo(() => {
    const g = {}
    const order = groupBy === 'category' ? CAT_ORDER : TYPE_ORDER

    for (const c of filtered) {
      const sf = sfMap[getScryfallKey(c)]
      const key = groupBy === 'category'
        ? getCardCategory(c, sf)
        : getCardType(sf?.type_line || '')
      if (!g[key]) g[key] = []
      g[key].push(c)
    }
    return { groups: g, groupOrder: order }
  }, [filtered, sfMap, groupBy])

  const selectedCard = selected ? cards.find(c => c.id === selected) : null
  const selectedSf   = selectedCard ? sfMap[getScryfallKey(selectedCard)] : null

  if (loading) return <EmptyState>Loading deck…</EmptyState>

  const VIEW_MODES = [
    { id:'list',   label:'≡ List' },
    { id:'stacks', label:'⊟ Stacks' },
    { id:'text',   label:'¶ Text' },
    { id:'grid',   label:'⊞ Grid' },
    { id:'table',  label:'⊞ Table' },
  ]

  return (
    <div className={styles.deckBrowser}>
      {/* Header */}
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={onBack}>← Back to Decks</button>
        <div className={styles.titleRow}>
          <h1 className={styles.deckName}>{folder.name}</h1>
          <div className={styles.headerMeta}>
            <span>{totalQty} cards</span>
            <span className={styles.deckValue}>{formatPrice(totalValue, price_source, display_currency)}</span>
          </div>
        </div>
      </div>

      {/* Stats toggle */}
      <button className={styles.statsToggle} onClick={() => setShowStats(v => !v)}>
        {showStats ? '▾ Hide Stats' : '▸ Show Stats'}
      </button>

      {showStats && <DeckStats cards={cards} sfMap={sfMap} bracketResult={bracketResult}
        bracketOverride={bracketOverride} onBracketOverride={setBracketOverride} />}

      {/* Combos */}
      <CombosPanel cards={cards} />

      {/* Controls */}
      <FilterBar search={search} setSearch={setSearch} sort={sort} setSort={setSort}
        filters={filters} setFilters={setFilters} />

      <div className={styles.controlBar}>
        <div className={styles.controlLeft}>
          <span className={styles.countInfo}>{filtered.length < cards.length
            ? `${filtered.length} of ${cards.length} cards`
            : `${cards.length} cards`}
          </span>
          {/* Group by */}
          <div className={styles.groupByToggle}>
            <button className={`${styles.groupByBtn} ${groupBy==='type' ? styles.groupByActive : ''}`}
              onClick={() => setGroupBy('type')}>By Type</button>
            <button className={`${styles.groupByBtn} ${groupBy==='category' ? styles.groupByActive : ''}`}
              onClick={() => setGroupBy('category')}>By Function</button>
          </div>
        </div>
        {/* View mode */}
        <div className={styles.viewToggle}>
          {VIEW_MODES.map(v => (
            <button key={v.id}
              className={`${styles.viewBtn} ${viewMode===v.id ? styles.viewActive : ''}`}
              onClick={() => setViewMode(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && <EmptyState>No cards match.</EmptyState>}

      {/* ── Views ── */}
      {viewMode === 'list' && filtered.length > 0 && (
        <div className={styles.deckList}>
          {groupOrder.filter(g => groups[g]?.length).map(g => (
            <DeckListGroup key={g} groupName={g} cards={groups[g]}
              sfMap={sfMap} priceSource={price_source} displayCurrency={display_currency}
              onSelect={c => setSelected(c.id)}
              color={groupBy==='category' ? CAT_COLORS[g] : undefined} />
          ))}
        </div>
      )}

      {viewMode === 'stacks' && filtered.length > 0 && (
        <StacksView groups={groups} groupOrder={groupOrder} sfMap={sfMap}
          onSelect={c => setSelected(c.id)} />
      )}

      {viewMode === 'text' && filtered.length > 0 && (
        <TextView groups={groups} groupOrder={groupOrder} sfMap={sfMap} />
      )}

      {viewMode === 'grid' && filtered.length > 0 && (
        <DeckCardGrid cards={filtered} sfMap={sfMap} onSelect={c => setSelected(c.id)} />
      )}

      {viewMode === 'table' && filtered.length > 0 && (
        <TableView cards={filtered} sfMap={sfMap}
          priceSource={price_source} displayCurrency={display_currency}
          onSelect={c => setSelected(c.id)} />
      )}

      {selectedCard && (
        <CardDetail card={selectedCard} sfCard={selectedSf}
          priceSource={price_source} displayCurrency={display_currency}
          onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
