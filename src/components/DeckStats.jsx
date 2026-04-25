import { useState, useMemo, useEffect, useRef } from 'react'
import { sfGet, getPrice, formatPrice } from '../lib/scryfall'

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_ORDER = ['Commander', 'Creatures', 'Planeswalkers', 'Battles', 'Instants',
  'Sorceries', 'Artifacts', 'Enchantments', 'Lands', 'Other']

export const CAT_ORDER = ['Ramp', 'Mana Rock', 'Card Draw', 'Removal', 'Board Wipe',
  'Counterspell', 'Tutor', 'Burn', 'Tokens', 'Graveyard', 'Protection',
  'Extra Turns', 'Combo', 'Creature', 'Artifact', 'Enchantment',
  'Instant', 'Sorcery', 'Planeswalker', 'Land', 'Other']

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

const BRACKET_4_CARDS = new Set([
  "Thassa's Oracle", "Demonic Consultation", "Tainted Pact", "Underworld Breach",
  "Flash", "Ad Nauseam", "Hermit Druid", "Food Chain", "Earthcraft",
])
const BRACKET_3_CARDS = new Set([
  "Mana Crypt", "Mana Vault", "Grim Monolith", "Chrome Mox", "Mox Diamond", "Mox Opal", "Jeweled Lotus",
  "Demonic Tutor", "Vampiric Tutor", "Imperial Seal", "Mystical Tutor", "Enlightened Tutor",
  "Worldly Tutor", "Survival of the Fittest", "Diabolic Intent",
  "Rhystic Study", "Smothering Tithe", "Necropotence", "Dark Confidant", "Skullclamp",
  "Sensei's Divining Top", "Sylvan Library", "Wheel of Fortune", "Timetwister", "Time Spiral",
  "Mana Drain", "Force of Will", "Force of Negation", "Fierce Guardianship",
  "Cyclonic Rift", "Dockside Extortionist", "Hullbreacher", "Opposition Agent", "Protean Hulk",
  "Gaea's Cradle", "Blood Moon", "Stasis", "Winter Orb", "Back to Basics", "Trinisphere",
])
const BRACKET_2_CARDS = new Set(["Sol Ring", "Arcane Signet", "Commander's Sphere"])
const BRACKET_META = {
  1: { label: 'Casual',      color: '#6aaa6a', desc: 'Precon power level, no notable game-changers.' },
  2: { label: 'Focused',     color: '#5a9abb', desc: 'Some staples; plays fair but consistently.' },
  3: { label: 'Optimized',   color: '#c9a84c', desc: 'Tutors, fast mana, powerful synergies.' },
  4: { label: 'Competitive', color: '#cc5555', desc: 'Built to win as fast as possible (cEDH).' },
}

const LAND_SUBTYPE_COLOR = { forest: 'G', mountain: 'R', swamp: 'B', island: 'U', plains: 'W', wastes: 'C' }

const BAR_MAX_PX = 72

export const CAT_COLORS = {
  'Ramp': '#4a9a5a', 'Mana Rock': '#5a8a9a', 'Card Draw': '#5a70bb', 'Removal': '#cc5555',
  'Board Wipe': '#aa3333', 'Counterspell': '#4470cc', 'Tutor': '#9a5abb', 'Burn': '#e07020',
  'Tokens': '#6a9a4a', 'Graveyard': '#7a4a8a', 'Protection': '#aaaaaa',
  'Extra Turns': '#cc88aa', 'Combo': '#c9a84c', 'Creature': '#5a8a5a',
  'Artifact': '#8a8a9a', 'Enchantment': '#7a6aaa', 'Instant': '#5555bb',
  'Sorcery': '#9944aa', 'Planeswalker': '#cc7722', 'Land': '#6a7a5a', 'Other': '#666',
}

// Functional category classifier — works on raw (lowercased) oracle text + type line
export function getCardCategory(oracle = '', typeLine = '', keywords = []) {
  const o = oracle.toLowerCase()
  const t = typeLine.toLowerCase()

  if (/counter target (spell|creature spell|instant or sorcery|noncreature spell)/.test(o)) return 'Counterspell'
  if (/search your library for a?.*(basic )?land/.test(o))                                  return 'Ramp'
  if (t.includes('artifact') && /\{t\}.*add /.test(o))                                      return 'Mana Rock'
  if (!t.includes('land') && /add \{[wubrg2c]/.test(o))                                     return 'Ramp'
  if (/draw (two|three|four|\d+) cards|draw a card/.test(o))                                return 'Card Draw'
  if (/(destroy|exile) all (creatures|permanents|nonland)/.test(o))                         return 'Board Wipe'
  if (/search your library for a? ?(instant|sorcery|creature|artifact|enchantment|planeswalker)/.test(o) &&
      !o.includes('basic land'))                                                              return 'Tutor'
  if (/(exile|destroy) target (creature|permanent|artifact|enchantment|planeswalker)/.test(o)) return 'Removal'
  if (/deals? \d+ damage to (any target|target player|each opponent|each player)/.test(o))  return 'Burn'
  if (/create (a|one|two|three|four|\d+) .*token/.test(o))                                  return 'Tokens'
  if (/return.*from (your |a )?(graveyard|exile)/.test(o))                                  return 'Graveyard'
  if (/gains? hexproof|gains? indestructible|protection from/.test(o))                      return 'Protection'
  if (/take an? extra turn/.test(o))                                                         return 'Extra Turns'
  if (/infinite|win the game/.test(o))                                                       return 'Combo'

  if (t.includes('land'))         return 'Land'
  if (t.includes('creature'))     return 'Creature'
  if (t.includes('planeswalker')) return 'Planeswalker'
  if (t.includes('instant'))      return 'Instant'
  if (t.includes('sorcery'))      return 'Sorcery'
  if (t.includes('artifact'))     return 'Artifact'
  if (t.includes('enchantment'))  return 'Enchantment'
  return 'Other'
}

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

// Extract token type names from oracle text (returns deduplicated array)
function extractTokenNames(oracle) {
  if (!oracle) return []
  const names = new Set()

  // Named utility tokens (Treasure, Food, Clue, etc.)
  const namedRe = /\b(Treasure|Food|Clue|Blood|Powerstone|Junk|Map|Shard|Incubator|Gold)\s+tokens?/g
  let m
  while ((m = namedRe.exec(oracle)) !== null) names.add(m[1])

  // "create a X/Y [colors] [Subtype] creature/artifact creature token"
  const creatureRe = /create\s+(?:a\s+|an\s+|one\s+|two\s+|three\s+|four\s+|five\s+|six\s+|x\s+|\d+\s+)*(?:tapped\s+|attacking\s+)?(?:[+\-]?\d+\/[+\-]?\d+\s+)?(?:(?:white|blue|black|red|green|colorless|silver|gold)\s+)*(?:legendary\s+|snow\s+)?([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*)\s+(?:artifact\s+)?creature\s+tokens?/g
  while ((m = creatureRe.exec(oracle)) !== null) {
    const raw = m[1]?.trim()
    if (!raw || /^(A|An|The|X|Your|Their|Each|All|Another|That|This|Copy|Token)$/.test(raw)) continue
    const words = raw.split(/\s+/)
    const name = words[words.length - 1]
    if (name && name.length > 1) names.add(name)
  }

  // Role tokens
  const roleRe = /\b(Blessed|Cursed|Wicked|Monster|Royal|Sorcerer|Young Hero)\s+Role\s+token/g
  while ((m = roleRe.exec(oracle)) !== null) names.add(`${m[1]} Role`)

  return [...names]
}

// Detect special non-token game pieces referenced in oracle text
function extractExtras(oracle) {
  if (!oracle) return []
  const extras = new Set()
  const t = oracle.toLowerCase()
  if (/\bmonarch\b/.test(t)) extras.add('Monarch')
  if (/\binitiative\b/.test(t)) extras.add('The Initiative')
  if (/the ring tempts you/.test(t)) extras.add('The Ring')
  if (/venture into the dungeon/.test(t)) extras.add('Dungeon')
  if (/you get an? emblem/.test(t)) extras.add('Emblem')
  return [...extras]
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

function calcDeckBracket(cardNames) {
  const b4 = []; const b3 = []; const b2 = []
  for (const name of cardNames) {
    if (BRACKET_4_CARDS.has(name)) b4.push(name)
    else if (BRACKET_3_CARDS.has(name)) b3.push(name)
    else if (BRACKET_2_CARDS.has(name)) b2.push(name)
  }
  if (b4.length > 0 || b3.length >= 4) return { bracket: 4, gc: [...b4, ...b3.slice(0, 8)] }
  if (b3.length >= 2)                  return { bracket: 4, gc: b3.slice(0, 8) }
  if (b3.length === 1)                 return { bracket: 3, gc: b3 }
  if (b2.length >= 1)                  return { bracket: 2, gc: b2.slice(0, 5) }
  return { bracket: 1, gc: [] }
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

function InlineMana({ cost, size = 14 }) {
  if (!cost) return null
  const syms = [...cost.matchAll(/\{([^}]+)\}/g)].map(m => m[1])
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
      {syms.map((s, i) => (
        <img key={i}
          src={`https://svgs.scryfall.io/card-symbols/${s.replace(/\//g, '').toUpperCase()}.svg`}
          alt={`{${s}}`}
          style={{ width: size, height: size, verticalAlign: 'middle', display: 'inline-block', flexShrink: 0 }}
        />
      ))}
    </span>
  )
}

function BracketBadge({ bracket, autobracket, gameChangers, onOverride }) {
  const meta = BRACKET_META[bracket] || BRACKET_META[1]
  const [open, setOpen] = useState(false)
  const isOverridden = bracket !== autobracket
  const canOverride = typeof onOverride === 'function'

  return (
    <div style={{ position: 'relative', maxWidth: '100%' }}>
      <button
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'rgba(255,255,255,0.04)', border: `1px solid ${meta.color}55`,
          borderRadius: 4, padding: '7px 14px', cursor: canOverride ? 'pointer' : 'default',
          fontFamily: 'var(--font-display)', fontSize: '0.8rem', letterSpacing: '0.04em',
          color: meta.color, transition: 'background 0.15s',
          maxWidth: '100%',
          flexWrap: 'wrap',
          boxSizing: 'border-box',
        }}
        onClick={() => canOverride && setOpen(v => !v)}
      >
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 22, height: 22, borderRadius: '50%',
          background: meta.color,
          color: '#0a0a0f', fontWeight: 700, fontSize: '0.85rem',
          fontFamily: 'var(--font-display)', flexShrink: 0,
        }}>{bracket}</span>
        {meta.label}
        {isOverridden && <span style={{ fontSize: '0.6rem', opacity: 0.6 }}>✎</span>}
        <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>{open ? '▴' : '▾'}</span>
      </button>

      {open && canOverride && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 20,
          background: '#1a1620', border: '1px solid var(--border)',
          borderRadius: 5, padding: '14px 16px', width: 'min(320px, calc(100vw - 48px))',
          maxWidth: 'calc(100vw - 48px)', boxSizing: 'border-box',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          <p style={{ fontSize: '0.82rem', color: 'var(--text-dim)', margin: '0 0 10px', lineHeight: 1.5 }}>
            {meta.desc}
          </p>
          <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-faint)', marginBottom: 6 }}>
            Set bracket manually:
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[1, 2, 3, 4].map(n => {
              const m = BRACKET_META[n]
              return (
                <button key={n}
                  style={{
                    width: 34, height: 34, borderRadius: '50%',
                    border: `1px solid ${m.color}66`,
                    fontFamily: 'var(--font-display)', fontSize: '0.88rem', fontWeight: 700,
                    cursor: 'pointer', transition: 'all 0.15s',
                    color: n === bracket ? '#0a0a0f' : m.color,
                    background: n === bracket ? m.color : 'transparent',
                  }}
                  onClick={() => { onOverride?.(n); setOpen(false) }}
                >
                  {n}
                </button>
              )
            })}
            {isOverridden && (
              <button
                style={{
                  background: 'none', border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 4, padding: '4px 10px',
                  fontSize: '0.7rem', color: 'var(--text-faint)',
                  fontFamily: 'var(--font-display)', cursor: 'pointer',
                  transition: 'all 0.15s', alignSelf: 'center',
                }}
                onClick={() => { onOverride?.(null); setOpen(false) }}
              >
                Reset
              </button>
            )}
          </div>

          {gameChangers.length > 0 && (
            <>
              <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-faint)', marginTop: 10, marginBottom: 6 }}>
                Auto-detected game-changers:
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {gameChangers.map((n, i) => (
                  <li key={i} style={{ fontSize: '0.81rem', color: 'var(--text-dim)', padding: '2px 0' }}>
                    <span style={{ color: 'var(--gold-dim)' }}>• </span>{n}
                  </li>
                ))}
              </ul>
            </>
          )}
          {gameChangers.length === 0 && (
            <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', marginTop: 6 }}>
              No game-changing cards detected.
            </div>
          )}
        </div>
      )}
    </div>
  )
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
      <div style={{ fontSize: '0.67rem', textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--text-faint)', marginBottom: 6, fontFamily: 'var(--font-display)' }}>
        {title}
      </div>
      <div style={{ display: 'flex', height: 28, borderRadius: 4, overflow: 'hidden', gap: 1 }}>
        {entries.map(({ c, v }) => (
          <div key={c}
            style={{
              flex: v,
              background: COLOR_BG[c] || '#505068',
              minWidth: 20,
              cursor: 'pointer',
              opacity: selected && selected !== c ? 0.35 : 1,
              filter: selected === c ? 'brightness(1.3)' : 'none',
              transition: 'opacity 0.15s, filter 0.15s',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onClick={() => setSelected(s => s === c ? null : c)}
          >
            <img src={`https://svgs.scryfall.io/card-symbols/${c}.svg`} alt={c}
              style={{ width: 18, height: 18, opacity: 0.9 }} />
          </div>
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

function ManaCurveChart({ curve, avgCmc, curveMode, curveSegData, onModeChange }) {
  const maxVal = Math.max(1, ...Object.values(curve))
  const labels = ['0', '1', '2', '3', '4', '5', '6', '7+']
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
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 5, padding: '14px 14px 10px', minWidth: 0 }}>
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-faint)', fontFamily: 'var(--font-display)' }}>
          Mana Curve
        </span>
        {avgCmc && (
          <span style={{ fontSize: '0.7rem', color: 'var(--gold-dim)', fontFamily: 'var(--font-display)' }}>
            avg {avgCmc}
          </span>
        )}
        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 3, marginLeft: 'auto', flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 0 }}>
          {[['flat', '—'], ['color', 'Color'], ['type', 'Type']].map(([m, l]) => (
            <button key={m}
              style={{
                background: curveMode === m ? 'rgba(201,168,76,0.12)' : 'none',
                border: `1px solid ${curveMode === m ? 'rgba(201,168,76,0.35)' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: 3, padding: '2px 7px', fontSize: '0.6rem',
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
                  segs
                    ? <div
                        style={{ width: '100%', maxWidth: 24, height: barPx, background: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: '2px 2px 0 0', cursor: 'pointer' }}
                        onMouseEnter={e => showTooltip(e, label, count, segs)}
                      >
                        {segOrder.filter(k => (segs[k] || 0) > 0).map(k => (
                          <div key={k} style={{ flex: segs[k], background: CURVE_SEG_COLOR[k] }} />
                        ))}
                      </div>
                    : <div
                        style={{ width: '100%', maxWidth: 24, height: barPx, background: 'linear-gradient(180deg, var(--gold) 0%, rgba(201,168,76,0.45) 100%)', borderRadius: '2px 2px 0 0', transition: 'height 0.35s ease', cursor: 'pointer' }}
                        onMouseEnter={e => showTooltip(e, label, count, null)}
                      />
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 8, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {legendKeys.map(k => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.59rem', color: 'var(--text-faint)' }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: CURVE_SEG_COLOR[k], flexShrink: 0 }} />
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
    .sort((a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))
  const landCount = typeCounts['Lands'] || 0
  const maxVal = Math.max(1, ...entries.map(([, v]) => v))

  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 5, padding: '14px 14px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-faint)', fontFamily: 'var(--font-display)' }}>
          Card Types
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {entries.filter(([, v]) => v > 0).map(([type, count]) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <div style={{ flex: '0 1 clamp(68px, 28vw, 90px)', fontSize: '0.72rem', color: 'var(--text-dim)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
              <TypeIcon type={type} size={13} style={{ verticalAlign: 'middle' }} />
              {' '}{type}
            </div>
            <div style={{ flex: 1, height: 7, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(count / maxVal) * 100}%`, background: 'rgba(201,168,76,0.5)', borderRadius: 3, transition: 'width 0.4s ease', minWidth: 2 }} />
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', width: 22, textAlign: 'right', flexShrink: 0 }}>{count}</div>
          </div>
        ))}
        {landCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.7, minWidth: 0 }}>
            <div style={{ flex: '0 1 clamp(68px, 28vw, 90px)', fontSize: '0.72rem', color: 'var(--text-dim)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
              <TypeIcon type="Lands" size={13} style={{ verticalAlign: 'middle' }} />
              {' '}Lands
            </div>
            <div style={{ flex: 1, height: 7, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(landCount / Math.max(maxVal, landCount)) * 100}%`, background: 'var(--text-faint)', borderRadius: 3, transition: 'width 0.4s ease', minWidth: 2 }} />
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', width: 22, textAlign: 'right', flexShrink: 0 }}>{landCount}</div>
          </div>
        )}
      </div>
    </div>
  )
}

function CategoryBreakdown({ catCounts }) {
  const entries = CAT_ORDER
    .map(cat => ({ cat, count: catCounts[cat] || 0 }))
    .filter(e => e.count > 0)
  if (!entries.length) return null
  const maxVal = Math.max(1, ...entries.map(e => e.count))

  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 5, padding: '14px 14px 10px' }}>
      <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-faint)', fontFamily: 'var(--font-display)', marginBottom: 12 }}>
        Role Breakdown
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {entries.map(({ cat, count }) => (
          <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <div style={{ flex: '0 1 clamp(72px, 30vw, 100px)', fontSize: '0.72rem', color: CAT_COLORS[cat] || 'var(--text-dim)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cat}
            </div>
            <div style={{ flex: 1, height: 7, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(count / maxVal) * 100}%`, background: CAT_COLORS[cat] || 'rgba(201,168,76,0.5)', opacity: 0.7, borderRadius: 3, transition: 'width 0.4s ease', minWidth: 2 }} />
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', width: 22, textAlign: 'right', flexShrink: 0 }}>{count}</div>
          </div>
        ))}
      </div>
    </div>
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

function KeywordFrequency({ kwCounts, cards }) {
  // Detect touch-only devices (no pointer hover capability)
  const isTouch = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches, [])

  // popover: { kw, top, left, alignRight } | null
  const [popover, setPopover] = useState(null)
  const closeTimer = useRef(null)

  const openPopover = (kw, e) => {
    clearTimeout(closeTimer.current)
    const rect = e.currentTarget.getBoundingClientRect()
    const viewW = window.innerWidth
    const left = rect.left
    const alignRight = left + 300 > viewW
    setPopover({ kw, top: rect.bottom + 6, left: alignRight ? rect.right : rect.left, alignRight })
  }

  const scheduleClose = () => {
    closeTimer.current = setTimeout(() => setPopover(null), 120)
  }

  // Close on scroll / resize
  useEffect(() => {
    const close = () => setPopover(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      clearTimeout(closeTimer.current)
    }
  }, [])

  const popoverCards = useMemo(
    () => popover ? cardsWithKeyword(cards, popover.kw) : [],
    [popover?.kw, cards]
  )

  if (!kwCounts.length) return null

  const pillHandlers = isTouch
    ? (kw) => ({ onClick: (e) => { popover?.kw === kw ? setPopover(null) : openPopover(kw, e) } })
    : (kw) => ({
        onMouseEnter: (e) => openPopover(kw, e),
        onMouseLeave: scheduleClose,
      })

  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 5, padding: '14px 14px 12px' }}>
      <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-faint)', fontFamily: 'var(--font-display)', marginBottom: 10 }}>
        Keywords
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 6px' }}>
        {kwCounts.map(([kw, count]) => {
          const active = popover?.kw === kw
          return (
            <button key={kw} {...pillHandlers(kw)} style={{
              background: active ? 'rgba(201,168,76,0.15)' : 'var(--s3)',
              border: `1px solid ${active ? 'rgba(201,168,76,0.45)' : 'var(--s-border2)'}`,
              borderRadius: 4, padding: '3px 9px', fontSize: '0.72rem',
              color: active ? 'var(--gold)' : 'var(--text-dim)',
              display: 'flex', alignItems: 'center', gap: 5,
              cursor: 'pointer', transition: 'all 0.12s',
            }}>
              {kw}
              <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.68rem', opacity: 0.7 }}>×{count}</span>
            </button>
          )
        })}
      </div>

      {/* Fixed-position popover with card images */}
      {popover && popoverCards.length > 0 && (
        <div
          onMouseEnter={() => !isTouch && clearTimeout(closeTimer.current)}
          onMouseLeave={() => !isTouch && scheduleClose()}
          style={{
            position: 'fixed',
            top: popover.top,
            ...(popover.alignRight ? { right: window.innerWidth - popover.left } : { left: popover.left }),
            zIndex: 9999,
            background: 'var(--bg2)',
            border: '1px solid var(--border-hi)',
            borderRadius: 7,
            padding: 10,
            boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
            display: 'flex', flexDirection: 'column', gap: 8,
            maxWidth: 'min(340px, 92vw)',
          }}
        >
          <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--text-faint)', fontFamily: 'var(--font-display)' }}>
            {popoverCards.reduce((s, c) => s + (c.qty || 1), 0)} card{popoverCards.reduce((s, c) => s + (c.qty || 1), 0) !== 1 ? 's' : ''} with {popover.kw}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {popoverCards.slice(0, 9).map((c, i) => (
              <div key={i} style={{ position: 'relative', flexShrink: 0 }}>
                {c.image_uri
                  ? <img src={c.image_uri} alt={c.name} title={c.name}
                      style={{ width: 64, height: 90, borderRadius: 4, objectFit: 'cover', display: 'block', border: '1px solid var(--s-border)' }} />
                  : <div style={{ width: 64, height: 90, borderRadius: 4, background: 'var(--s2)', border: '1px solid var(--s-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 4 }}>
                      <span style={{ fontSize: '0.58rem', color: 'var(--text-faint)', textAlign: 'center', lineHeight: 1.3 }}>{c.name}</span>
                    </div>
                }
                {c.qty > 1 && (
                  <span style={{ position: 'absolute', bottom: 3, right: 3, background: 'rgba(0,0,0,0.75)', color: '#fff', fontSize: '0.62rem', borderRadius: 3, padding: '1px 4px', fontFamily: 'var(--font-display)' }}>×{c.qty}</span>
                )}
              </div>
            ))}
            {popoverCards.length > 9 && (
              <div style={{ width: 64, height: 90, borderRadius: 4, background: 'var(--s2)', border: '1px solid var(--s-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)', fontFamily: 'var(--font-display)' }}>+{popoverCards.length - 9}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function PriceBreakdown({ totalPrice, avgPrice, priceByCategory, topCards, price_source }) {
  if (totalPrice <= 0) return null

  const catEntries = CAT_ORDER
    .map(cat => ({ cat, total: priceByCategory[cat] || 0 }))
    .filter(e => e.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)
  const maxCatPrice = Math.max(1, ...catEntries.map(e => e.total))

  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 5, padding: '14px 14px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-faint)', fontFamily: 'var(--font-display)' }}>
        Price
      </div>

      {/* Summary pills */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: '0.64rem', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Total</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.95rem', color: 'var(--green)' }}>{formatPrice(totalPrice, price_source)}</span>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: '0.64rem', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Avg / card</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.95rem', color: 'var(--text)' }}>{formatPrice(avgPrice, price_source)}</span>
        </div>
      </div>

      {/* Price by category bars */}
      {catEntries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {catEntries.map(({ cat, total }) => (
            <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <div style={{ flex: '0 1 clamp(72px, 30vw, 100px)', fontSize: '0.72rem', color: CAT_COLORS[cat] || 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cat}
              </div>
              <div style={{ flex: 1, height: 7, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
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
          <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-faint)', fontFamily: 'var(--font-display)' }}>Most Expensive</div>
          {topCards.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <div style={{ width: 28, height: 20, borderRadius: 3, overflow: 'hidden', flexShrink: 0, background: 'var(--s2)' }}>
                {c.image_uri && <img src={c.image_uri} alt={c.name} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center 15%' }} />}
              </div>
              <div style={{ flex: 1, fontSize: '0.75rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.name}{c.qty > 1 && <span style={{ color: 'var(--text-faint)', marginLeft: 4 }}>×{c.qty}</span>}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--green)', fontFamily: 'var(--font-display)', flexShrink: 0 }}>{formatPrice(c.total, price_source)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TokensExtras({ allItems, tokenImages }) {
  if (!allItems.length) return null
  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 5, padding: '14px 14px 12px' }}>
      <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-faint)', fontFamily: 'var(--font-display)', marginBottom: 10 }}>
        Tokens &amp; Extras
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
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
      </div>
    </div>
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
export default function DeckStats({ cards, bracketOverride, onBracketOverride, price_source }) {
  const [curveMode, setCurveMode] = useState('flat')
  const [tokenImages, setTokenImages] = useState({}) // name → img uri | null
  const fetchedRef = useRef(new Set())

  const bracketResult = useMemo(() => calcDeckBracket(cards.map(c => c.name)), [cards])

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
        prodMana[k] += 1
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
    const combinedOracle = cards.map(c => c.oracle_text || '').join('\n')
    const tokenNames = extractTokenNames(combinedOracle)
    const extras = extractExtras(combinedOracle)

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
        priceByCard.push({ name: c.name, price: p, qty, total: cardTotal, image_uri: c.image_uri })
      }
    }
    priceByCard.sort((a, b) => b.total - a.total)
    const topCards = priceByCard.slice(0, 5)
    const avgPrice = pricedCardCount > 0 ? totalPrice / pricedCardCount : 0

    return { curve, curveByColor, curveByType, costColors, costCards, prodMana, typeCounts, catCounts, totalCostPips, totalProdMana, nonLandCount, avgCmc, kwCounts, tokenNames, extras, totalPrice, avgPrice, priceByCategory, topCards }
  }, [cards])

  // Scryfall queries for non-token extras
  const EXTRA_QUERIES = {
    'Monarch':        't:conspiracy !"Monarch" game:paper',
    'The Initiative': '!"The Initiative" game:paper',
    'The Ring':       '!"The Ring" game:paper',
    'Dungeon':        't:dungeon game:paper',
    'Emblem':         't:emblem game:paper',
  }

  // Fetch token + extra images from Scryfall — newest paper printing
  useEffect(() => {
    const allItems = [...stats.tokenNames, ...stats.extras]
    const toFetch = allItems.filter(n => !fetchedRef.current.has(n))
    if (!toFetch.length) return
    toFetch.forEach(n => fetchedRef.current.add(n))

    let active = true
    ;(async () => {
      const results = {}
      for (const name of toFetch) {
        if (!active) break
        const rawQ = EXTRA_QUERIES[name] ?? `t:token !"${name}" game:paper`
        const q = encodeURIComponent(rawQ)
        const data = await sfGet(`/cards/search?q=${q}&order=released&dir=desc&unique=prints`)
        results[name] = data?.data?.[0]?.image_uris?.small ?? null
      }
      if (active) setTokenImages(prev => ({ ...prev, ...results }))
    })()

    return () => { active = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.tokenNames, stats.extras])

  const { curve, curveByColor, curveByType, costColors, costCards, prodMana, typeCounts, catCounts, totalCostPips, totalProdMana, nonLandCount, avgCmc, kwCounts, tokenNames, extras, totalPrice, avgPrice, priceByCategory, topCards } = stats
  const curveSegData = curveMode === 'color' ? curveByColor : curveByType
  const effectiveBracket = bracketOverride ?? bracketResult.bracket

  const hasOracleData = cards.some(c => c.oracle_text)

  return (
    <div style={{
      background: 'rgba(255,255,255,0.025)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '18px 20px',
      marginBottom: 18,
      display: 'flex', flexDirection: 'column', gap: 16,
      width: '100%',
      maxWidth: '100%',
      minWidth: 0,
      boxSizing: 'border-box',
      overflowX: 'clip',
    }}>
      {/* Pills row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <BracketBadge
          bracket={effectiveBracket}
          autobracket={bracketResult.bracket}
          gameChangers={bracketResult.gc}
          onOverride={onBracketOverride}
        />
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: '0.64rem', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Avg CMC</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.95rem', color: 'var(--text)' }}>{avgCmc}</span>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: '0.64rem', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Non-Land</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.95rem', color: 'var(--text)' }}>{nonLandCount}</span>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: '0.64rem', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Lands</span>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.95rem', color: 'var(--text)' }}>{typeCounts['Lands'] || 0}</span>
        </div>
      </div>

      {/* Stacked color bars */}
      {(totalCostPips > 0 || totalProdMana > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {totalCostPips > 0 && (
            <ColorStackBar colorCounts={costColors} totalPips={totalCostPips} title="Mana Cost" cardCounts={costCards} />
          )}
          {totalProdMana > 0 && (
            <ColorStackBar colorCounts={prodMana} totalPips={totalProdMana} title="Mana Production" />
          )}
        </div>
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
        <TypeBreakdown typeCounts={typeCounts} />
      </div>

      {/* Category breakdown + Keywords (only when oracle text is available) */}
      {hasOracleData && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 14, minWidth: 0 }}>
          <CategoryBreakdown catCounts={catCounts} />
          <KeywordFrequency kwCounts={kwCounts} cards={cards} />
        </div>
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
