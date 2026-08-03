// Solitaire simulation — independent ground truth for deck quality.
//
// Every other metric in this project is scored by the same classifiers that
// drive the signals: coverage is measured by the detectors the engine pass uses,
// draw quality by the rule that enforces it. Those measurements prove the
// signals FIRE, not that the decks are better. There is no external check
// anywhere, and that has been the biggest known weakness of the whole effort.
//
// This is the external check. It shuffles the deck and plays it out, and the
// only card properties it reads are mana value, "is this a land" and "does this
// tap for mana" — objective facts off the type line and mana cost, not verdicts
// from a regex ladder. Whether you can cast your commander by turn five is not a
// matter of opinion.
//
// Deliberately crude, and the limitations are load-bearing rather than
// incidental (see simulateGame). It answers "does this deck function" — can it
// hit land drops, deploy on curve, cast its commander — not "does this deck win".

// ── Deterministic RNG ─────────────────────────────────────────────────────────
// Seeded so a sweep is reproducible: an A/B where the arms got different shuffles
// would measure luck, not the decks.
export function makeRng(seed = 1) {
  let a = seed >>> 0
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffled(cards, rng) {
  const a = [...cards]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ── Card facts ────────────────────────────────────────────────────────────────
// Objective properties only. `isLand` and `cmc` come straight off the card;
// `manaValue` of a rock is the one judgement call and it is a coarse one.

export function isLand(card) {
  return String(card?.type_line || '').toLowerCase().includes('land')
}

/**
 * Lands this card puts straight onto the battlefield when it resolves.
 *
 * Ramp does NOT go through the land drop: Cultivate, Rampant Growth, Nature's
 * Lore, Skyshroud Claim and Solemn Simulacrum all fetch a land into play, so
 * lands in play can and routinely does exceed the turn number. Modelling only
 * one drop per turn understated mana development for every deck the assistant
 * builds -- the role template targets ~11 ramp.
 */
export function landsPutIntoPlay(card) {
  if (isLand(card)) return 0
  const o = String(card?.oracle_text || '').toLowerCase()
  // Basic land TYPES count as well as the word 'land': Skyshroud Claim reads
  // 'up to two Forest cards', and never says 'land' at all.
  const m = o.match(/(?:search your library for|put)[^.\n]{0,80}?\b(a|an|one|two|three|up to (?:one|two|three))\b[^.\n]{0,50}?\b(?:lands?|forests?|islands?|plains|swamps?|mountains?|wastes?)\b[^.\n]{0,60}?onto the battlefield/)
  if (!m) return 0
  const word = m[1].replace('up to ', '')
  return { a: 1, an: 1, one: 1, two: 2, three: 3 }[word] ?? 1
}

/**
 * Extra land drops this card grants while in play (Exploration, Azusa, Oracle of
 * Mul Daya). Another reason lands in play outrun the turn count.
 */
export function extraLandDrops(card) {
  const o = String(card?.oracle_text || '').toLowerCase()
  const m = o.match(/play (an|one|two|three) additional lands?/)
  if (!m) return 0
  return { an: 1, one: 1, two: 2, three: 3 }[m[1]] ?? 1
}

/** A nonland that taps for mana — counted as a mana source once it's in play. */
export function isManaRock(card) {
  if (isLand(card)) return false
  const o = String(card?.oracle_text || '').toLowerCase()
  return /\{t\}[^.\n]{0,40}\badd\b/.test(o)
}

// ── Colour ────────────────────────────────────────────────────────────────────
// Deliberately reimplemented here rather than imported from deckBuildAssistant.
// This module's whole value is being independent of the classifiers it checks;
// sharing code with them would let a bug agree with itself.

export const COLORS = ['W', 'U', 'B', 'R', 'G']
const BASIC_TYPE_COLOR = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' }

/** Colours a permanent can produce once in play. */
export function producedColors(card) {
  const t = String(card?.type_line || '').toLowerCase()
  const o = String(card?.oracle_text || '').toLowerCase()
  const out = new Set()
  for (const [sub, col] of Object.entries(BASIC_TYPE_COLOR)) if (t.includes(sub)) out.add(col)
  for (const clause of o.split(/[.\n;]/)) {
    if (!clause.includes('add')) continue
    if (/\bany (color|type)\b/.test(clause)) { COLORS.forEach(c => out.add(c)); continue }
    for (const c of COLORS) {
      if (new RegExp(`\{[^}]*${c.toLowerCase()}[^}]*\}`).test(clause)) out.add(c)
    }
  }
  return out
}

/**
 * Coloured pips a spell needs. Prefers the real mana cost; falls back to colour
 * identity (one pip per colour) when the cost wasn't exported, which understates
 * double-pip costs but still catches the case that matters — a card you simply
 * cannot produce the colours for.
 */
export function colorRequirements(card) {
  const req = {}
  const cost = String(card?.mana_cost || '')
  if (cost) {
    for (const sym of cost.match(/\{[^}]+\}/g) || []) {
      const inner = sym.slice(1, -1).toUpperCase()
      // Hybrid and Phyrexian pips are payable another way; they set no hard
      // requirement, so only strict single-colour symbols count.
      if (COLORS.includes(inner)) req[inner] = (req[inner] || 0) + 1
    }
    return req
  }
  for (const c of card?.color_identity || []) {
    const u = String(c).toUpperCase()
    if (COLORS.includes(u)) req[u] = 1
  }
  return req
}

/** Can the colours currently available pay this spell's coloured pips? */
export function colorsAvailable(req, sourcesByColor) {
  for (const [c, n] of Object.entries(req)) {
    if ((sourcesByColor[c] || 0) < n) return false
  }
  return true
}

// ── Opening hand ──────────────────────────────────────────────────────────────

/**
 * Commander mulligan: draw 7, and keep a hand with a workable land count. The
 * first mulligan is free; after that each keeps 7 but bottoms one card per
 * mulligan taken. Modelled as "keep the first hand in range, else the last".
 */
export const KEEP_MIN_LANDS = 2
export const KEEP_MAX_LANDS = 5

export function drawOpening(deck, rng, { maxMulligans = 3 } = {}) {
  let hand = []
  let mulligans = 0
  for (; mulligans <= maxMulligans; mulligans++) {
    hand = shuffled(deck, rng).slice(0, 7)
    const lands = hand.filter(isLand).length
    if (lands >= KEEP_MIN_LANDS && lands <= KEEP_MAX_LANDS) break
  }
  // London mulligan: keep 7, bottom one per mulligan taken.
  const kept = hand.slice(0, Math.max(1, 7 - Math.min(mulligans, maxMulligans)))
  return { hand: kept, mulligans: Math.min(mulligans, maxMulligans) }
}

// ── Game ──────────────────────────────────────────────────────────────────────

/**
 * Play the deck solitaire for `turns` turns.
 *
 * Known simplifications, all of which make this a floor rather than an estimate:
 *   • no opponents, so no interaction and no removal
 *   • one card drawn per turn; card-draw spells are NOT simulated, so decks with
 *     good card advantage are undersold
 *   • mana is a pool of (lands in play + resolved mana rocks); colours are
 *     ignored entirely, so a greedy 5-colour manabase looks as good as a clean
 *     one. Colour screw is what karstenColorRequirements already covers.
 *   • greedy casting: spend the turn's mana on the most expensive castable
 *     spells first, which is roughly what a player does but not always right.
 *
 * The point is comparison between arms on identical shuffles, where these
 * simplifications cancel — not an absolute prediction of a real game.
 */
export function simulateGame({ deck, commanderCmc = 4, commanderColors = {}, turns = 8, rng }) {
  const { hand: opening, mulligans } = drawOpening(deck, rng)
  const library = shuffled(deck, rng).filter(c => !opening.includes(c))
  const hand = [...opening]

  let landsInPlay = 0
  let rocks = 0
  let extraDrops = 0
  const sources = { W: 0, U: 0, B: 0, R: 0, G: 0 }
  const addSource = card => { for (const c of producedColors(card)) sources[c]++ }
  let colorStuckTurns = 0
  let commanderTurn = null
  const manaByTurn = []
  const landsByTurn = []
  const landsInHandByTurn = []
  let missedLandDrops = 0

  for (let turn = 1; turn <= turns; turn++) {
    // Draw for turn. The player on the play skips their first draw, but this is
    // solitaire with no opponents, so modelling the turn order buys nothing.
    const drawn = library.shift()
    if (drawn) hand.push(drawn)
    // Land drops — one, plus any granted by permanents already in play.
    let drops = 1 + extraDrops
    let madeADrop = false
    while (drops > 0) {
      const landIdx = hand.findIndex(isLand)
      if (landIdx < 0) break
      addSource(hand[landIdx])
      hand.splice(landIdx, 1)
      landsInPlay++
      madeADrop = true
      drops--
    }
    if (!madeADrop && turn <= 6) missedLandDrops++

    let mana = landsInPlay + rocks
    // Commander first once affordable — it is the deck's engine, and casting it
    // is the single most informative thing about whether the deck functions.
    if (commanderTurn == null && mana >= commanderCmc) {
      if (colorsAvailable(commanderColors, sources)) {
        commanderTurn = turn
        mana -= commanderCmc
      } else {
        // Enough mana, wrong colours — the failure mode a colourless pool can't
        // see, and the one a greedy five-colour manabase actually suffers.
        colorStuckTurns++
      }
    }
    // Then greedily deploy, most expensive first.
    const castable = hand
      .map((c, i) => ({ c, i, cmc: c?.cmc ?? 0 }))
      .filter(x => !isLand(x.c))
      .sort((a, b) => b.cmc - a.cmc)
    const spent = new Set()
    for (const x of castable) {
      if (x.cmc > mana) continue
      if (!colorsAvailable(colorRequirements(x.c), sources)) continue
      mana -= x.cmc
      spent.add(x.i)
      if (isManaRock(x.c)) { rocks++; addSource(x.c) }
      // Ramp that fetches lands into play, and permanents that grant extra drops.
      landsInPlay += landsPutIntoPlay(x.c)
      extraDrops += extraLandDrops(x.c)
    }
    for (const i of [...spent].sort((a, b) => b - a)) hand.splice(i, 1)

    manaByTurn.push(landsInPlay + rocks)
    landsByTurn.push(landsInPlay)
    // Flood is lands piling up in HAND — cards you drew that did nothing.
    // (Lands in PLAY is not a flood signal: ramp and extra-drop effects push it
    // past the turn count routinely, which is a good thing, not a symptom.)
    landsInHandByTurn.push(hand.filter(isLand).length)
  }

  return { mulligans, commanderTurn, manaByTurn, landsByTurn, landsInHandByTurn, missedLandDrops, colorStuckTurns, stuckInHand: hand.length }
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

/**
 * Run many games and summarise. Every figure here is a simulation output, not a
 * classifier verdict — this is the part that can contradict the rest of the
 * project rather than agree with it by construction.
 */
export function goldfishDeck({ deck = [], commanderCmc = 4, commanderColors = {}, games = 200, turns = 8, seed = 12345 } = {}) {
  if (!deck.length) return null
  const rng = makeRng(seed)
  let castByT5 = 0
  let neverCast = 0
  let screwed = 0
  let flooded = 0
  let mulliganed = 0
  let missedSum = 0
  let colorStuck = 0
  let commanderTurnSum = 0
  let commanderTurnN = 0
  const manaT5 = []
  const landsT4 = []

  for (let g = 0; g < games; g++) {
    const r = simulateGame({ deck, commanderCmc, commanderColors, turns, rng })
    if (r.mulligans > 0) mulliganed++
    missedSum += r.missedLandDrops
    if (r.colorStuckTurns > 0) colorStuck++
    if (r.commanderTurn == null) neverCast++
    else {
      commanderTurnSum += r.commanderTurn
      commanderTurnN++
      if (r.commanderTurn <= 5) castByT5++
    }
    const l4 = r.landsByTurn[3] ?? 0
    if (l4 < 3) screwed++
    // Dead lands in hand once every drop has been made.
    if ((r.landsInHandByTurn[5] ?? 0) >= 3) flooded++
    manaT5.push(r.manaByTurn[4] ?? 0)
    landsT4.push(l4)
  }

  const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1)
  return {
    games,
    commanderByT5Pct: (castByT5 / games) * 100,
    commanderNeverPct: (neverCast / games) * 100,
    avgCommanderTurn: commanderTurnN ? commanderTurnSum / commanderTurnN : null,
    avgManaT5: mean(manaT5),
    avgLandsT4: mean(landsT4),
    screwedPct: (screwed / games) * 100,
    floodedPct: (flooded / games) * 100,
    mulliganPct: (mulliganed / games) * 100,
    avgMissedLandDrops: missedSum / games,
    colorStuckPct: (colorStuck / games) * 100,
  }
}
