// Commander Bracket analyzer — estimates a deck's minimum WotC bracket
// (the official 5-bracket system, current as of the Feb 9, 2026 beta update).
//
// Hard floors implemented (cross-checked against the official announcements
// and the major community calculators):
//   - Game Changers: 1–3 cards → Bracket 3+, 4+ cards → Bracket 4+
//   - Mass land denial → Bracket 4+
//   - Two-card infinite combos: fast (combined MV ≤ 6) → Bracket 4+,
//     otherwise → Bracket 3+
//   - Extra-turn spells: any → Bracket 2+, 3 or more → Bracket 3+
//   - Tutor restrictions were REMOVED from the official system (Oct 2025
//     update) — tutors and fast mana are reported as soft signals only.
//   - Bracket 5 (cEDH) is a tournament-intent declaration, never auto-assigned.
//
// The Game Changers list ships from Scryfall (`is:gamechanger`, 53 cards as of
// Feb 2026) so the analyzer stays current without code changes when WotC
// updates the list. Cached in localStorage for 7 days.

import { sfGet } from './scryfall'

const SF = 'https://api.scryfall.com'
const GC_CACHE_KEY = 'arcanevault_game_changers_v1'
const GC_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const BRACKET_LABELS = {
  1: 'Exhibition',
  2: 'Core',
  3: 'Upgraded',
  4: 'Optimized',
  5: 'cEDH',
}

// ── Oracle-text detectors ────────────────────────────────────────────────────
// Patterns derived from real Scryfall oracle text (Armageddon, Jokulhaups,
// Ruination, Sunder, Winter Orb, Stasis, Time Warp, …) — see the test file.

const MLD_PATTERNS = [
  /destroys? all [^.\n]*lands/i,          // Armageddon, Jokulhaups, Ruination, Impending Disaster
  /exiles? all [^.\n]*lands/i,
  /return all lands/i,                    // Sunder
  /sacrifices? all [^.\n]*lands/i,
  /lands don't untap during/i,
  /can't untap more than \w+ (?:land|permanent)/i, // Winter Orb, Static Orb
  /players? skip(?:s)? (?:their|your) untap step/i, // Stasis
]

export function isMassLandDenial(oracleText) {
  const text = oracleText || ''
  return MLD_PATTERNS.some(re => re.test(text))
}

const EXTRA_TURN_RE = /takes? (?:an|two|three|x) extra turns?/i

export function isExtraTurn(oracleText) {
  return EXTRA_TURN_RE.test(oracleText || '')
}

// Non-land tutor: searches the library for something other than (basic) lands.
// Land ramp (Cultivate, Rampant Growth, fetches) is not a power signal.
const TUTOR_RE = /search(?:es)? (?:your|their) library for /gi
const LAND_ONLY_RE = /^(?:up to \w+ )?(?:a |an |\w+ )?(?:basic |snow )*(?:land|plains|island|swamp|mountain|forest|gate|desert)\b/i

export function isNonlandTutor(oracleText) {
  const text = oracleText || ''
  TUTOR_RE.lastIndex = 0
  let m
  while ((m = TUTOR_RE.exec(text))) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60)
    if (!LAND_ONLY_RE.test(after)) return true
  }
  return false
}

// Fast mana that is NOT already on the Game Changers list (those are caught
// by the list itself). Soft signal only.
export const FAST_MANA_NAMES = new Set([
  'sol ring',
  'dark ritual',
  'cabal ritual',
  'lotus petal',
  'rite of flame',
  'pyretic ritual',
  'desperate ritual',
  'seething song',
  'simian spirit guide',
  'elvish spirit guide',
  'mox amber',
  'mox opal',
])

// ── Game Changers list ───────────────────────────────────────────────────────

// Set membership must match both full names and the front face of MDFCs
// ("Tergrid, God of Fright // Tergrid's Lantern" ↔ "Tergrid, God of Fright").
export function normalizeGameChangerNames(names) {
  const set = new Set()
  for (const raw of names || []) {
    const name = String(raw || '').trim().toLowerCase()
    if (!name) continue
    set.add(name)
    const front = name.split('//')[0].trim()
    if (front) set.add(front)
  }
  return set
}

export async function fetchGameChangerNames({ force = false } = {}) {
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(GC_CACHE_KEY) || 'null')
      if (cached?.names?.length && Date.now() - (cached.fetchedAt || 0) < GC_CACHE_TTL_MS) {
        return normalizeGameChangerNames(cached.names)
      }
    } catch { /* corrupt cache — refetch */ }
  }

  const names = []
  let url = `${SF}/cards/search?q=${encodeURIComponent('is:gamechanger')}&order=name`
  while (url) {
    const data = await sfGet(url)
    for (const card of data?.data || []) names.push(card.name)
    url = data?.has_more ? data.next_page : null
  }
  if (names.length) {
    try {
      localStorage.setItem(GC_CACHE_KEY, JSON.stringify({ names, fetchedAt: Date.now() }))
    } catch { /* storage full/unavailable — fine, just uncached */ }
  }
  return normalizeGameChangerNames(names)
}

// ── Analysis ─────────────────────────────────────────────────────────────────

function matchesGameChanger(cardName, gameChangerNames) {
  const name = String(cardName || '').trim().toLowerCase()
  if (!name) return false
  if (gameChangerNames.has(name)) return true
  const front = name.split('//')[0].trim()
  return gameChangerNames.has(front)
}

const FAST_COMBO_MV_MAX = 6

/**
 * @param {Object}   opts
 * @param {Array}    opts.cards          Normalized deck cards (main board incl.
 *                                       commander): { name, oracle_text, cmc, qty }
 * @param {Set}      opts.gameChangerNames  From fetchGameChangerNames()
 * @param {Array|null} opts.comboCardLists  Arrays of card names per detected
 *                                       combo (from Commander Spellbook), or
 *                                       null when the combo check hasn't run.
 */
export function analyzeBracket({ cards, gameChangerNames, comboCardLists = null }) {
  const seen = new Set()
  const unique = []
  for (const card of cards || []) {
    const key = String(card.name || '').toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(card)
  }

  const gameChangers = []
  const massLandDenial = []
  const extraTurns = []
  const tutors = []
  const fastMana = []
  const cmcByName = new Map()

  for (const card of unique) {
    const lower = card.name.toLowerCase()
    cmcByName.set(lower, card.cmc ?? 0)
    cmcByName.set(lower.split('//')[0].trim(), card.cmc ?? 0)
    if (matchesGameChanger(card.name, gameChangerNames)) gameChangers.push(card.name)
    if (isMassLandDenial(card.oracle_text)) massLandDenial.push(card.name)
    if (isExtraTurn(card.oracle_text)) extraTurns.push(card.name)
    if (isNonlandTutor(card.oracle_text)) tutors.push(card.name)
    if (FAST_MANA_NAMES.has(lower)) fastMana.push(card.name)
  }

  const twoCardCombos = (comboCardLists || [])
    .filter(names => (names || []).length === 2)
    .map(names => {
      const totalCmc = names.reduce((sum, n) => sum + (cmcByName.get(String(n).toLowerCase()) ?? 0), 0)
      return { names, totalCmc, early: totalCmc <= FAST_COMBO_MV_MAX }
    })

  let bracket = 1
  const reasons = []
  const floor = (level, reason) => {
    if (level > bracket) bracket = level
    reasons.push({ level, reason })
  }

  if (extraTurns.length >= 3) {
    floor(3, `${extraTurns.length} extra-turn spells`)
  } else if (extraTurns.length >= 1) {
    floor(2, `${extraTurns.length} extra-turn spell${extraTurns.length === 1 ? '' : 's'}`)
  }

  if (gameChangers.length >= 4) {
    floor(4, `${gameChangers.length} Game Changers (more than 3)`)
  } else if (gameChangers.length >= 1) {
    floor(3, `${gameChangers.length} Game Changer${gameChangers.length === 1 ? '' : 's'}`)
  }

  if (massLandDenial.length >= 1) {
    floor(4, `Mass land denial (${massLandDenial.join(', ')})`)
  }

  const earlyCombos = twoCardCombos.filter(c => c.early)
  if (earlyCombos.length >= 1) {
    floor(4, `Fast two-card combo (${earlyCombos[0].names.join(' + ')})`)
  } else if (twoCardCombos.length >= 1) {
    floor(3, `Two-card combo (${twoCardCombos[0].names.join(' + ')})`)
  }

  return {
    bracket,
    label: BRACKET_LABELS[bracket],
    reasons,
    gameChangers,
    massLandDenial,
    extraTurns,
    tutors,
    fastMana,
    twoCardCombos,
    combosChecked: comboCardLists !== null,
  }
}
