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
export function simulateGame({ deck, commanderCmc = 4, turns = 8, rng }) {
  const { hand: opening, mulligans } = drawOpening(deck, rng)
  const library = shuffled(deck, rng).filter(c => !opening.includes(c))
  const hand = [...opening]

  let landsInPlay = 0
  let rocks = 0
  let extraDrops = 0
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
      commanderTurn = turn
      mana -= commanderCmc
    }
    // Then greedily deploy, most expensive first.
    const castable = hand
      .map((c, i) => ({ c, i, cmc: c?.cmc ?? 0 }))
      .filter(x => !isLand(x.c))
      .sort((a, b) => b.cmc - a.cmc)
    const spent = new Set()
    for (const x of castable) {
      if (x.cmc > mana) continue
      mana -= x.cmc
      spent.add(x.i)
      if (isManaRock(x.c)) rocks++
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

  return { mulligans, commanderTurn, manaByTurn, landsByTurn, landsInHandByTurn, missedLandDrops, stuckInHand: hand.length }
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

/**
 * Run many games and summarise. Every figure here is a simulation output, not a
 * classifier verdict — this is the part that can contradict the rest of the
 * project rather than agree with it by construction.
 */
export function goldfishDeck({ deck = [], commanderCmc = 4, games = 200, turns = 8, seed = 12345 } = {}) {
  if (!deck.length) return null
  const rng = makeRng(seed)
  let castByT5 = 0
  let neverCast = 0
  let screwed = 0
  let flooded = 0
  let mulliganed = 0
  let missedSum = 0
  let commanderTurnSum = 0
  let commanderTurnN = 0
  const manaT5 = []
  const landsT4 = []

  for (let g = 0; g < games; g++) {
    const r = simulateGame({ deck, commanderCmc, turns, rng })
    if (r.mulligans > 0) mulliganed++
    missedSum += r.missedLandDrops
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
  }
}
