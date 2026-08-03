// Build Assistant A/B harness.
//
// Answers one question with a sample bigger than hand-building decks allows:
// does the experimental scoring (src/lib/buildAssistExperimental.js) produce
// better auto-filled Commander decks than the shipped ranking?
//
// Method: for each commander, build ONE candidate pool exactly the way the
// Build Assistant does (EDHREC page + recommander.cards picks + card metadata),
// then run planAutoFill over that identical pool once per arm. The pool is held
// fixed and the comparator is the only thing that varies, so any difference in
// the output decks is attributable to the ranking and nothing else.
//
// Deliberately NOT included: the user's owned collection. The shipped
// "Top recommendations" auto-fill is ownership-blind, and seeding the pool from
// one person's binders would make the measurement depend on what they happen to
// own and stop it being reproducible.
//
// Run: npm run harness:build-assist
// Env: HARNESS_COMMANDERS=name1,name2  (override the built-in list)
//      HARNESS_OUT=path                (report destination)
//      HARNESS_LIMIT=n                 (first n commanders only — smoke runs)
//      HARNESS_COLLECTION=path         (JSON export of a real binder pool -- switches
//                                       the sweep to the OWNED build path)
//      HARNESS_MAXADD=n                (override the engine pass add ceiling —
//                                       used to prove the cap is honoured: 1 gives
//                                       66% coverage on Muldrotha, 6 gives 100%)

import { it } from 'vitest'
import fs from 'fs'
import path from 'path'

import { fetchEdhrecCommander, fetchRecommendationMetadataByNames, fetchRecommenderRecs } from '../src/lib/deckBuilderApi'
import { fetchCardPrintsByOracleIds } from '../src/lib/cardPrints'
import {
  analyzeBuildPlan,
  enrichPlanWithEdhrec,
  attachRecommenderUpgrades,
  selectUpgrades,
  planAutoFill,
  planTargetAvgCmc,
  upgradePoolDepth,
  analyzeCut,
  coarseRole,
  planBasicLands,
  isBasicLandName,
  recommendedBasicCount,
  deriveRoleTemplate,
  applyTemplateAdjustments,
  bracketAdjustments,
  COMMANDER_TEMPLATE,
  COMMANDER_DECK_SIZE,
  ROLE_ORDER,
  ROLE_DRAW,
  ROLE_LANDS,
  ROLE_SYNERGY,
  ROLE_WINCON,
  ROLE_RAMP,
  ROLE_REMOVAL,
  ROLE_WIPE,
} from '../src/lib/deckBuildAssistant'
import {
  EXPERIMENTAL_DEFAULTS,
  buildScoringContext,
  makeExperimentalComparatorFor,
  makeExperimentalExclude,
  // Candidates come in two shapes: unowned suggestions carry `oracle`/`type`
  // directly, owned ones carry a full Scryfall entry on `sfCard`. Reading only
  // the first shape reported "100% of picks have no oracle text" on the binder
  // path and zeroed every text-derived metric.
  candidateOracle,
  candidateType,
} from '../src/lib/buildAssistExperimental'
import { cardRoleTags, engineRoleCount, drawQuality } from '../src/lib/cardRoles'
// Independent ground truth: simulation outputs, not classifier verdicts. This is
// the one family of metrics here that CAN contradict the rest rather than
// agreeing with it by construction.
import { goldfishDeck, colorRequirements, producedColors } from '../src/lib/goldfish'
import { recRank } from '../src/lib/deckBuildAssistant'
import { extractCommanderKeywords, extractTribe, synergyScore } from '../src/lib/commanderSynergy'
import { commanderNeeds, analyzeEngineCoverage, cardEnablers, deriveTypeFloors, isCardType, deriveTopEndAllowance } from '../src/lib/engineEnablers'
import { runEnginePass } from '../src/lib/buildAssistantPasses'

// ── Commander sample ──────────────────────────────────────────────────────────
// Three popularity tiers, because the central hypothesis is that keyword overlap
// earns its keep exactly where EDHREC inclusion data is thin. A result that only
// holds for obscure commanders is still a useful result — but it has to be
// visible as such, which means bucketing rather than averaging everything.
//
// Within each tier the list mixes text-rich commanders (several mechanical
// hooks) with sparse ones (one line of text), since a commander that names no
// hooks gives the keyword signal nothing to work with and should show ~no
// movement. Those are the control cases.
// Keyed by STRATEGY, not popularity. The first sweep bucketed by popularity and
// that turned out to be the wrong axis — every tier's EDHREC page carries
// 240-320 cardviews, so "obscure" commanders are not short of inclusion data.
// What actually varies is the archetype, and some archetypes are places the
// keyword vocabulary is expected to struggle: it has NO creature-type concept,
// so tribal synergy is invisible to it, and its artifact/enchantment/spellcast
// concepts match on TYPE, so they fire on a third of the pool indiscriminately.
// Those are included deliberately as the adversarial cases.
const COMMANDERS = {
  sacrifice:    ['Korvold, Fae-Cursed King', 'Teysa Karlov', 'Hei Bai, Spirit of Balance'],
  graveyard:    ['Meren of Clan Nel Toth', 'Muldrotha, the Gravetide', 'Alesha, Who Smiles at Death'],
  tokens:       ['Krenko, Mob Boss', 'Adeline, Resplendent Cathar', 'Rhys the Redeemed'],
  spellslinger: ['Talrand, Sky Summoner', 'Kalamax, the Stormsire', 'Zada, Hedron Grinder'],
  counters:     ["Atraxa, Praetors' Voice", 'Ghave, Guru of Spores', 'Marchesa, the Black Rose'],
  tribal:       ['Edgar Markov', 'The Ur-Dragon', "Gishath, Sun's Avatar", 'Sliver Overlord'],
  lands:        ['Lord Windgrace', 'Tatyova, Benthic Druid', 'Omnath, Locus of Rage'],
  enchantress:  ["Sythis, Harvest's Hand", 'Tuvasa the Sunlit'],
  artifacts:    ['Sydri, Galvanic Genius', 'Urza, Lord High Artificer', 'Breya, Etherium Shaper'],
  blink:        ['Brago, King Eternal', 'Roon of the Hidden Realm'],
  mill:         ['Bruvac the Grandiloquent', 'Phenax, God of Deception'],
  grouphug:     ['Phelddagrif', 'Kwain, Itinerant Meddler'],
  voltron:      ['Sram, Senior Edificer', 'Uril, the Miststalker', 'Halvar, God of Battle'],
  lifegain:     ['Oloro, Ageless Ascetic', 'Karlov of the Ghost Council'],
  wheels:       ['Nekusar, the Mindrazer', 'Tinybones, Trinket Thief'],
  stax:         ['Sen Triplets', 'Grand Arbiter Augustin IV'],
  bigmana:      ['Nikya of the Old Ways', 'Azusa, Lost but Seeking'],
  combo:        ['Thrasios, Triton Hero', 'Kinnan, Bonder Prodigy'],
  burn:         ['Kaervek the Merciless', 'Torbran, Thane of Red Fell'],
  vanilla:      ['Ruhan of the Fomori', 'Tromokratis', 'Halfdane'],
}

// Per-signal arms. The first sweep ran every signal at once, so the measured
// quality cost could not be attributed to any one of them. Each "only" arm
// isolates a single signal; `scoped` tests the proposed fix — keyword bonus
// confined to Synergy + Win Cons, leaving the functional roles on pure quality.
const OFF = { multiRole: false, commanderKw: false, deckAffinity: false, topEndCap: false, drawQuality: false, drawCurve: false }
const ARMS = [
  { id: 'shipped', label: 'shipped', cfg: null },
  { id: 'all', label: 'all signals', cfg: { ...EXPERIMENTAL_DEFAULTS } },
  { id: 'kw', label: 'keywords only', cfg: { ...EXPERIMENTAL_DEFAULTS, ...OFF, commanderKw: true, deckAffinity: true } },
  { id: 'multi', label: 'multi-role only', cfg: { ...EXPERIMENTAL_DEFAULTS, ...OFF, multiRole: true } },
  { id: 'topend', label: 'top-end cap only', cfg: { ...EXPERIMENTAL_DEFAULTS, ...OFF, topEndCap: true } },
  { id: 'drawq', label: 'draw quality only', cfg: { ...EXPERIMENTAL_DEFAULTS, ...OFF, drawQuality: true } },
  { id: 'engine', label: 'all + engine pass', cfg: { ...EXPERIMENTAL_DEFAULTS }, enginePass: true },
  { id: 'derived', label: '+ type floors', cfg: { ...EXPERIMENTAL_DEFAULTS }, enginePass: true },
]


// ── Owned collection (binder path) ────────────────────────────────────────────
// The ownership-blind path is what every sweep so far measured. The binder path
// -- "build the best deck from what I actually own" -- is the one this app is
// uniquely placed to do, and it had never been measured at all. It differs in a
// way that matters to several conclusions: most of a real collection is not on
// the commander's EDHREC page, so inclusion % is 0 for the bulk of the pool and
// every candidate ties. That is exactly the situation the keyword signal was
// built for and was never tested in.
function loadCollection(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
  const ownedCards = []
  const sfMap = {}
  for (const r of rows) {
    if (!r.scryfall_id || !r.name) continue
    ownedCards.push({ id: r.scryfall_id, scryfall_id: r.scryfall_id, name: r.name, qty: 1 })
    sfMap[r.scryfall_id] = {
      name: r.name,
      cmc: Number(r.cmc) || 0,
      mana_cost: r.mana_cost || '',
      type_line: r.type_line || '',
      oracle_text: r.oracle_text || '',
      color_identity: r.color_identity || [],
    }
  }
  return { ownedCards, sfMap }
}

// ── Pool construction ─────────────────────────────────────────────────────────

// Mirrors BuildAssistant's fetchUpgradeMeta.
//
// Chunked at 100 names with one retry, which the app does NOT do: measured
// against the live RPC, 250 names takes ~1.7s and intermittently blows the 3s
// anon statement timeout outright. The app is authenticated (8s) so it has more
// headroom, but the margin is thinner than it looks — and the failure is silent
// (fetchUpgradeMeta swallows it), which would zero out every text-based signal
// for a whole run and quietly corrupt a measurement.
const META_BATCH = 100

async function fetchMetaChunked(names) {
  const out = []
  for (let i = 0; i < names.length; i += META_BATCH) {
    const batch = names.slice(i, i + META_BATCH)
    let rows = null
    for (let attempt = 0; attempt < 2 && rows == null; attempt++) {
      try { rows = await fetchRecommendationMetadataByNames(batch) } catch {
        if (attempt === 1) process.stdout.write(`    ! metadata batch failed (${batch.length} names)\n`)
      }
    }
    if (rows) out.push(...rows)
  }
  return out
}

function makeMetaFetcher(cache) {
  return async (names) => {
    const missing = names.filter(n => !cache.has(n.toLowerCase()))
    if (missing.length) {
      const cards = await fetchMetaChunked(missing)
      for (const c of cards) {
        const requested = c.requested_name || c.name
        cache.set((requested || '').toLowerCase(), {
          name: requested,
          oracle_text: c.oracle_text || c.card_faces?.[0]?.oracle_text || '',
          type_line: c.type_line || c.card_faces?.[0]?.type_line || '',
          mana_cost: c.mana_cost || '',
          cmc: c.cmc ?? 0,
          color_identity: c.color_identity || [],
          image: null,
        })
      }
      for (const n of missing) if (!cache.has(n.toLowerCase())) cache.set(n.toLowerCase(), null)
    }
    return names.map(n => cache.get(n.toLowerCase())).filter(Boolean)
  }
}

// Recommander picks resolved to card_prints/oracle_cards rows, the same shape
// attachRecommenderUpgrades expects.
async function fetchRecommanderRows(commanderName) {
  let recs = []
  try { recs = await fetchRecommenderRecs(commanderName, [], null, { timeoutMs: 20000 }) } catch { return [] }
  if (!recs.length) return []
  let printMap = new Map()
  try { printMap = await fetchCardPrintsByOracleIds(recs.map(r => r.oracle_id)) } catch { return [] }
  const rows = []
  for (const r of recs) {
    const row = printMap.get(r.oracle_id)
    if (!row) continue
    rows.push({
      name: row.name || r.name,
      cmc: row.cmc ?? 0,
      type_line: row.type_line || '',
      oracle_text: row.oracle_text || '',
      colorIdentity: row.color_identity || [],
      image: null,
      score: r.score ?? 0,
    })
  }
  return rows
}

// The commander's own card, needed for color identity + the keyword hooks.
async function fetchCommanderCard(name, metaFetch) {
  const [meta] = await metaFetch([name])
  if (!meta) return null
  return {
    name: meta.name || name,
    mana_cost: meta.mana_cost || '',
    color_identity: meta.color_identity || [],
    oracle_text: meta.oracle_text || '',
    type_line: meta.type_line || '',
    cmc: meta.cmc ?? 0,
  }
}

// ── Colour self-sufficiency ───────────────────────────────────────────────────
// Every colour is bad at something -- red and white at card draw, blue at ramp --
// and the standard patch is colourless artifacts (Sol Ring, Mind Stone,
// Wayfarer's Bauble for mana; Skullclamp, Endless Atlas for cards). Nothing in
// the build system does this deliberately, so the question is whether it falls
// out of the data anyway: does the colourless share of a role go UP in the
// colours that are weak at it?
function candColorIdentity(c) {
  return (c?.sfCard?.color_identity || c?.colorIdentity || c?.color_identity || [])
    .map(x => String(x).toUpperCase())
}
function isColorless(c) {
  return candColorIdentity(c).length === 0
}

// ── Metrics ───────────────────────────────────────────────────────────────────
// Every metric is computed from the PICKED cards only, using the same pure
// classifiers the assistant uses, so the harness and the app agree on what a
// "draw spell" or a "two-job card" is.
function measure(picks, commanderCard, needs, landTarget = 37) {
  const kw = extractCommanderKeywords(commanderCard?.oracle_text || '', commanderCard?.type_line || '')
  const cards = picks.map(p => p.cand)
  const nonland = cards.filter(c => !candidateType(c).includes('land'))

  let synSum = 0, synNeg = 0
  let netDraw = 0, selection = 0, multi2 = 0, multi3 = 0
  let kwSum = 0, kwZero = 0, noText = 0
  let topEnd = 0, cmcSum = 0
  const drawCards = []

  for (const c of nonland) {
    const oracle = candidateOracle(c)
    const type = candidateType(c)
    if (!oracle) noText++
    const { roles, jobs, tags } = cardRoleTags(oracle, type)
    if (roles.has(ROLE_DRAW)) { netDraw++; drawCards.push(c) }
    else if (tags.has('selection')) selection++
    const n = engineRoleCount(jobs)
    if (n >= 2) multi2++
    if (n >= 3) multi3++

    synSum += (c.edhrecSynergy || 0)
    if ((c.edhrecSynergy || 0) < -0.02) synNeg++
    const syn = synergyScore(oracle, type, kw, null)
    kwSum += syn.score
    if (syn.score === 0) kwZero++

    const cmc = c.cmc ?? 0
    cmcSum += cmc
    if (cmc >= 6) topEnd++
  }

  // Per-role breakdown. The comparator is applied to EVERY role's pool, not
  // just Synergy — so the question this answers is whether buying theme in the
  // functional roles (Removal, Ramp, Protection…) costs card quality. `baseRank`
  // is the shipped recommendation strength of the cards actually picked: if it
  // drops in a functional role, the signal displaced staples for on-theme
  // filler, which would make the deck worse, not better.
  const perRole = {}
  for (const p of picks) {
    const c = p.cand
    const oracle = candidateOracle(c)
    const type = candidateType(c)
    const r = (perRole[p.role] ||= { n: 0, base: 0, kw: 0, names: new Set() })
    r.n++
    r.base += recRank(c)
    r.kw += synergyScore(oracle, type, kw).score
    r.names.add(c.name)
  }
  for (const r of Object.values(perRole)) {
    r.avgBase = r.base / (r.n || 1)
    r.avgKw = r.kw / (r.n || 1)
  }

  // Engine coverage: does the finished deck actually contain the enablers the
  // commander's own text says it needs?
  const coverage = analyzeEngineCoverage(
    cards.map(c => ({ name: c.name, oracle: candidateOracle(c), type: candidateType(c) })),
    needs || [],
  )
  const covPct = coverage.length
    ? coverage.reduce((s2, c) => s2 + Math.min(1, c.have / (c.target || 1)), 0) / coverage.length * 100
    : NaN
  const covShort = coverage.reduce((s2, c) => s2 + c.short, 0)

  // Novelty share: cards the crowd does NOT play for this commander. Recommander
  // picks and zero-inclusion cards are where the surprise comes from — wanted in
  // small numbers, a problem if they crowd out the strategy.
  let recPicks = 0, zeroIncl = 0
  for (const c of nonland) {
    if (c.source === 'recommander') recPicks++
    if (!(c.edhrecInclusion > 0)) zeroIncl++
  }

  // Goldfish the finished list — the only metrics here that are simulation
  // outputs rather than verdicts from the same classifiers that drive the
  // signals, so the only ones that can contradict the rest. Basics stand in for
  // the manabase the app adds on finish, so the simulated deck is real-sized.
  const landsPicked = cards.filter(c => candidateType(c).includes('land')).length
  const deckForBasics = cards.map(c => ({
    name: c.name,
    type_line: candidateType(c),
    mana_cost: c.sfCard?.mana_cost || c.mana_cost || '',
    cmc: c.cmc ?? 0,
    qty: 1,
  }))
  const basicPlan = planBasicLands({
    deckCards: deckForBasics,
    sfMap: {},
    colors: (commanderCard?.color_identity || []),
    landTarget,
  })
  const basics = []
  for (const [name, n] of Object.entries(basicPlan.counts || {})) {
    for (let i = 0; i < n; i++) basics.push({ name, cmc: 0, type_line: `Basic Land — ${name}` })
  }

  // Manabase quality, independent of any classifier: how much of it comes into
  // play tapped (a tempo cost paid every game) and how many colours the average
  // land can produce (what actually prevents colour screw).
  const allLands = [...cards.filter(c => candidateType(c).includes('land')), ...basics]
  const tapped = allLands.filter(c => {
    const o = (c.sfCard?.oracle_text || c.oracle_text || candidateOracle(c) || '').toLowerCase()
    return /enters (the battlefield )?tapped/.test(o) && !/unless|if you|you may pay/.test(o)
  }).length
  const colorSpread = allLands.length
    ? allLands.reduce((sum, c) => sum + producedColors({
        type_line: c.type_line || candidateType(c),
        oracle_text: c.sfCard?.oracle_text || c.oracle_text || candidateOracle(c) || '',
      }).size, 0) / allLands.length
    : 0
  const gf = goldfishDeck({
    deck: [
      ...cards.map(c => ({
        name: c.name, cmc: c.cmc ?? 0,
        mana_cost: c.sfCard?.mana_cost || c.mana_cost || '',
        color_identity: c.sfCard?.color_identity || c.colorIdentity || [],
        type_line: candidateType(c), oracle_text: candidateOracle(c),
      })),
      // Basics via the app's OWN planner (Karsten shortfall first, then
      // pip-weighted), not a round-robin over the commander's colours. Cycling
      // ignores pip demand entirely, so it manufactures colour screw the real
      // build would not have.
      ...basics,
    ],
    commanderCmc: commanderCard?.cmc ?? 4,
    // Colour requirement for the commander. Without this the simulation scored a
    // greedy five-colour manabase exactly as well as a clean two-colour one.
    commanderColors: colorRequirements({
      mana_cost: commanderCard?.mana_cost || '',
      color_identity: commanderCard?.color_identity || [],
    }),
    games: 200,
  })

  // Colourless share overall and per role.
  let colorless = 0
  const colorlessByRole = {}
  const countByRole = {}
  for (const p of picks) {
    const c = p.cand
    if (candidateType(c).includes('land')) continue
    countByRole[p.role] = (countByRole[p.role] || 0) + 1
    if (isColorless(c)) {
      colorless++
      colorlessByRole[p.role] = (colorlessByRole[p.role] || 0) + 1
    }
  }

  const typeCounts = {}
  for (const c of cards) {
    for (const ct of typesOf(candidateType(c))) {
      typeCounts[ct] = (typeCounts[ct] || 0) + 1
    }
  }

  const n = nonland.length || 1
  return {
    entersTappedPct: allLands.length ? (tapped / allLands.length) * 100 : NaN,
    fixingPerLand: colorSpread,
    colorlessPct: (colorless / (nonland.length || 1)) * 100,
    colorlessByRole,
    countByRole,
    gfColorStuck: gf?.colorStuckPct ?? NaN,
    gfCommanderT5: gf?.commanderByT5Pct ?? NaN,
    gfAvgCmdTurn: gf?.avgCommanderTurn ?? NaN,
    gfManaT5: gf?.avgManaT5 ?? NaN,
    gfScrewed: gf?.screwedPct ?? NaN,
    gfFlooded: gf?.floodedPct ?? NaN,
    gfMulligan: gf?.mulliganPct ?? NaN,
    recPct: (recPicks / (nonland.length || 1)) * 100,
    zeroInclPct: (zeroIncl / (nonland.length || 1)) * 100,
    typeCounts,
    coverage, covPct, covShort,
    perRole,
    picked: cards.length,
    nonland: nonland.length,
    netDraw,
    selection,
    multi2,
    multi3,
    topEnd,
    avgCmc: cmcSum / n,
    edhrecSyn: synSum / n,
    offPlan: synNeg,
    kwAvg: kwSum / n,
    kwZeroPct: (kwZero / n) * 100,
    noTextPct: (noText / n) * 100,
    drawExpensiveWeak: drawCards.filter(c => (c.cmc ?? 0) >= 4 && !drawQuality(String(c.oracle || '').toLowerCase()).burst).length,
    names: new Set(cards.map(c => c.name)),
  }
}

// ── Card type balance (step 0: is there a defect?) ────────────────────────────
// COMMANDER_TEMPLATE is entirely functional — Ramp, Draw, Removal — and says
// nothing about card TYPES. A Ramp slot can be filled by a mana rock, a mana
// dork or a land and nothing notices, so creature count is purely emergent.
// This measures whether that emergent distribution matches what real decks run.
//
// A card counts toward EVERY type it has: an Artifact Creature is a creature
// when you're asking "do I have enough bodies" and an artifact when you're
// asking "do I have enough artifacts".
// Basic land for each colour, for the manabase the app adds on finish.
const BASIC_BY_COLOR = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' }

const CARD_TYPES = ['creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'planeswalker']

function typesOf(typeLine = '') {
  const t = String(typeLine).toLowerCase()
  if (t.includes('land')) return []           // lands are the manabase, not the spell mix
  return CARD_TYPES.filter(ct => t.includes(ct))
}

// Expected count of each type in an average deck for this commander, scaled for
// EDHREC page coverage — same method as deriveEnablerTargets.
function expectedTypeCounts(edhrec, metaByName) {
  const totals = {}
  let covered = 0
  const seen = new Set()
  for (const cat of edhrec?.categories || []) {
    for (const cv of cat.cards || []) {
      const key = (cv.name || '').toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      const pot = cv.potentialDecks || 0
      if (!pot) continue
      const meta = metaByName.get(key)
      const type = meta?.type_line || cv.type || ''
      if (!type) continue
      const incl = Math.min(1, (cv.inclusion || 0) / pot)
      covered += incl
      for (const ct of typesOf(type)) totals[ct] = (totals[ct] || 0) + incl
    }
  }
  if (covered < 25) return {}
  const scale = 99 / covered
  const out = {}
  for (const [k, v] of Object.entries(totals)) out[k] = Math.round(v * scale * 10) / 10
  return out
}

// ── Target calibration ────────────────────────────────────────────────────────
// The engine targets in engineEnablers.js (sacOutlet 6, selfMill 4, …) are
// guesses. This derives them instead: the expected number of each enabler in an
// AVERAGE deck for this commander is the inclusion-weighted sum over every card
// on its EDHREC page. Crowd data is trustworthy for this specific question in a
// way it isn't for mana curve — a deck missing its outlets doesn't function, so
// it doesn't survive to be uploaded.
//
// Uses the FULL page (no metadata cap): accuracy matters more here than
// mirroring the app's runtime behaviour, and the tail is cheap to resolve.
function expectedEnablerCounts(edhrec, metaByName) {
  const totals = {}
  let deckCovered = 0
  const seen = new Set()
  for (const cat of edhrec?.categories || []) {
    for (const cv of cat.cards || []) {
      const key = (cv.name || '').toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      const pot = cv.potentialDecks || 0
      if (!pot) continue
      const incl = Math.min(1, (cv.inclusion || 0) / pot)
      deckCovered += incl
      const meta = metaByName.get(key)
      if (!meta) continue
      for (const e of cardEnablers(meta.oracle_text || '', meta.type_line || '')) {
        totals[e] = (totals[e] || 0) + incl
      }
    }
  }
  // An EDHREC page lists 240-320 cards but their inclusion sums to only ~46-64
  // of a 99-card deck: the rest of every real deck is long-tail cards the page
  // never shows. Scaling by that coverage turns "expected count among the cards
  // EDHREC lists" into "expected count in the whole deck". Conservative — the
  // unlisted tail is idiosyncratic and probably enabler-poor, so this is an
  // upper bound on the true figure.
  const coverage = deckCovered > 0 ? deckCovered / 99 : 1
  const scaled = {}
  for (const [k, v] of Object.entries(totals)) scaled[k] = v / coverage
  return { raw: totals, scaled, coverage, deckCovered }
}

// ── One commander, all arms ───────────────────────────────────────────────────

async function runCommander(name, metaCache, collection = null) {
  const metaFetch = makeMetaFetcher(metaCache)
  const commanderCard = await fetchCommanderCard(name, metaFetch)
  if (!commanderCard) return { name, error: 'commander metadata not found' }

  const edhrec = await fetchEdhrecCommander(name, 'commander', {})
  if (!edhrec?.categories?.length) return { name, error: 'no EDHREC page' }
  const edhrecCards = edhrec.categories.reduce((s, c) => s + (c.cards?.length || 0), 0)

  // Full-page metadata for calibration (the arms still use the app's cap).
  const allNames = []
  {
    const seen = new Set()
    for (const cat of edhrec.categories || []) for (const cv of cat.cards || []) {
      const k = (cv.name || '').toLowerCase()
      if (k && !seen.has(k)) { seen.add(k); allNames.push(cv.name) }
    }
  }
  await metaFetch(allNames)
  const expected = expectedEnablerCounts(edhrec, metaCache)
  const expectedTypes = expectedTypeCounts(edhrec, metaCache)
  // Derived per-commander role shape (see deriveRoleTemplate). Lands stay on the
  // fixed template — Karsten math beats crowd averages — so the nonland budget
  // is deckSize - 1 - landTarget.
  const pageCards = []
  {
    const seen = new Set()
    for (const cat of edhrec.categories || []) for (const cv of cat.cards || []) {
      const k = (cv.name || '').toLowerCase()
      if (!k || seen.has(k)) continue
      seen.add(k)
      const meta = metaCache.get(k)
      const pot = cv.potentialDecks || 0
      if (!pot || !meta?.oracle_text) continue
      pageCards.push({
        inclusionPct: (cv.inclusion || 0) / pot,
        oracle: meta.oracle_text,
        type: meta.type_line || cv.type || '',
        // Needed by deriveTopEndAllowance; omitting it made every commander
        // return the floor, which looked like "nobody wants big spells".
        cmc: meta.cmc ?? cv.cmc ?? 0,
      })
    }
  }
  const landTarget = COMMANDER_TEMPLATE[ROLE_LANDS].ideal
  const derived = deriveRoleTemplate(pageCards, COMMANDER_DECK_SIZE - 1 - landTarget)
  const typeFloors = deriveTypeFloors(pageCards, COMMANDER_DECK_SIZE - 1)
  const topEndAllowance = deriveTopEndAllowance(pageCards, 6, COMMANDER_DECK_SIZE - 1)

  const arm0TypeFloors = typeFloors
  const needs = commanderNeeds(
    extractCommanderKeywords(commanderCard.oracle_text, commanderCard.type_line),
    extractTribe(commanderCard.oracle_text, commanderCard.type_line),
    commanderCard.oracle_text,
    expected.scaled,
    arm0TypeFloors,
  )
  const recRows = await fetchRecommanderRows(name)
  const targetCmc = planTargetAvgCmc(edhrec, '')

  const results = {}
  // The candidate POOL is identical for every arm; only the ranking differs. The
  // derived-template arm is the exception — it changes the role quotas, which
  // changes the plan itself, so that arm builds its own.
  const makeBasePlan = async (arm) => {
    const template = (arm.derivedTemplate && Object.keys(derived).length)
      ? { ...derived, [ROLE_LANDS]: COMMANDER_TEMPLATE[ROLE_LANDS] }
      : COMMANDER_TEMPLATE
    const base = analyzeBuildPlan({
      commander: commanderCard,
      ownedCards: collection?.ownedCards || [],
      sfMap: collection?.sfMap || {},
      currentDeckCards: [],
      template,
      deckSize: COMMANDER_DECK_SIZE,
    })
    let plan = await enrichPlanWithEdhrec(base, async () => edhrec, metaFetch)
    if (recRows.length) plan = attachRecommenderUpgrades(plan, recRows)
    return plan
  }

  const upgradesFor = role => selectUpgrades(
    role,
    recRows.length ? 'both' : 'edhrec',
    upgradePoolDepth(role.gap || 0),
  )
  const ctx = buildScoringContext({
    commanderOracle: commanderCard.oracle_text,
    commanderType: commanderCard.type_line,
    commanderCmc: commanderCard.cmc,
    deckTexts: [],
  })

  for (const arm of ARMS) {
    const cfg = arm.cfg
    const basePlan = await makeBasePlan(arm)
    const roles = basePlan.roles.map(r => ({ ...r, upgrades: upgradesFor(r) }))
    const landsRole = basePlan.roles.find(r => r.role === ROLE_LANDS)
    const landUpgrades = landsRole
      ? upgradesFor(landsRole).filter(u => (u.type || '').toLowerCase().includes('land'))
      : []
    // Owned nonbasic lands, fixers first — mirrors the app's landCandidates.
    // Omitting this left every measured manabase 100% basics (0% entering
    // tapped, 1.00 colours per land), which no real build produces and which
    // manufactured most of the colour screw the simulation was reporting.
    const landCandidates = (landsRole?.ownedCandidates || [])
      .filter(c => !isBasicLandName(c.name))
      .map(c => {
        const colors = producedColors({
          type_line: candidateType(c),
          oracle_text: candidateOracle(c),
        })
        const matching = [...colors].filter(x => (commanderCard.color_identity || []).includes(x))
        return { cand: c, score: matching.length, size: colors.size }
      })
      .sort((a, b) => (b.score - a.score) || (b.size - a.size) || a.cand.name.localeCompare(b.cand.name))
      .map(x => x.cand)

    const picks = planAutoFill({
      roles,
      landUpgrades,
      liveCounts: new Map(ROLE_ORDER.map(r => [r, 0])),
      totalCards: 1, // commander only
      deckSize: COMMANDER_DECK_SIZE,
      // Reserve the land slots. Zeroing them (as this used to) makes every arm
      // build 99 SPELLS where a real deck has ~62, which silently inflates every
      // absolute count by ~1.6x — fine for arm-vs-arm comparison, fatal when
      // comparing against real-deck figures during calibration.
      landsTarget: basePlan.roles.find(r => r.role === ROLE_LANDS)?.target || 37,
      currentLands: 0,
      currentNonbasicLands: 0,
      landCandidates,
      // The app aims for a basic/nonbasic split rather than filling every land
      // slot with nonbasics; recommendedBasicCount scales it by colour count.
      nonbasicTarget: Math.max(0, (basePlan.roles.find(r => r.role === ROLE_LANDS)?.target || 37)
        - recommendedBasicCount((commanderCard.color_identity || []).length)),
      source: collection ? 'owned' : 'recommended',
      targetCmc,
      curveStatus: 'on',
      comparatorFor: cfg ? makeExperimentalComparatorFor({ ctx, cfg, targetCmc, curveStatus: 'on' }) : null,
      exclude: cfg
        ? makeExperimentalExclude({
            cfg,
            deckTopEnd: 0,
            drawRole: ROLE_DRAW,
            drawTarget: basePlan.roles.find(r => r.role === ROLE_DRAW)?.target || 0,
            topEndAllowance,
            nonlandBudget: COMMANDER_DECK_SIZE - 1 - (basePlan.roles.find(r => r.role === ROLE_LANDS)?.target || 37),
          })
        : undefined,
    })
    let finalPicks = picks
    if (arm.enginePass && needs.length) {
      // Calls the REAL runEnginePass rather than approximating it. The previous
      // in-memory approximation ignored the budget gate, cut the last picks
      // instead of the worst-ranked, and hardcoded its own add ceiling — so its
      // ~99% coverage was an upper bound rather than a measurement. Feeding the
      // shipped pass synthetic deck rows and in-memory add/remove callbacks
      // measures what users will actually get.
      const rowOf = (p, i) => ({
        id: `r${i}`, name: p.cand.name, qty: 1,
        type_line: candidateType(p.cand),
        oracle_text: candidateOracle(p.cand),
        cmc: p.cand.cmc ?? 0,
      })
      const rows = picks.map(rowOf)
      const byId = new Map(rows.map((r, i) => [r.id, picks[i]]))
      const byName = new Map()
      for (const spec of roles) for (const c of [...(spec.ownedCandidates || []), ...(spec.upgrades || [])]) {
        const k = (c.name || '').toLowerCase()
        if (!byName.has(k)) byName.set(k, c)
      }
      // Include the basics the app adds on finish. Without them `populated` is
      // only ~63 cards, analyzeCut sees the deck as UNDER 100 and cuts nothing,
      // so the pass's additions made the deck oversized -- which diluted the
      // manabase and showed up in goldfishing as a mana-screw regression that
      // was entirely an artifact of this harness, not of the pass.
      const basicsNeeded = Math.max(0, COMMANDER_DECK_SIZE - 1 - rows.length)
      const populated = [
        { id: 'cmd', name: commanderCard.name, qty: 1, is_commander: true, type_line: commanderCard.type_line },
        ...rows,
        ...Array.from({ length: basicsNeeded }, (_, i) => ({
          id: `b${i}`, name: 'Forest', qty: 1, type_line: 'Basic Land — Forest', oracle_text: '', cmc: 0,
        })),
      ]
      const cov = analyzeEngineCoverage(
        picks.map(p => ({ name: p.cand.name, oracle: candidateOracle(p.cand), type: candidateType(p.cand) })),
        needs,
      )
      const ranked = [...byName.values()].sort((a, b) => (b.edhrecInclusion || 0) - (a.edhrecInclusion || 0))
      let addedRows = []
      const pass = await runEnginePass({
        populated,
        fillIds: rows.map(r => r.id),
        coverage: cov,
        providersFor: enabler => {
          const need = cov.find(n => n.enabler === enabler)
          if (need?.cardType) return ranked.filter(c => isCardType(String(c.type || ''), need.cardType))
          return ranked.filter(c => cardEnablers(String(c.oracle || ''), String(c.type || '')).has(enabler))
        },
        deckSize: COMMANDER_DECK_SIZE,
        isLandRow: d => String(d?.type_line || '').toLowerCase().includes('land'),
        isManaRow: d => /\{t\}[^.\n]{0,40}\badd\b/.test(String(d?.oracle_text || '').toLowerCase()),
        // The app routes this through the full auto-fill gate; the harness used
        // to pass everything, so the engine pass added expensive enablers
        // straight through the top-end cap and goldfishing blamed the pass for a
        // castability drop that was really this divergence.
        passesBudget: name => {
          const c = byName.get(String(name).toLowerCase())
          if (!c || !cfg) return true
          return !makeExperimentalExclude({
            cfg,
            deckTopEnd: picks.filter(p => (p.cand?.cmc ?? 0) >= (cfg.topEndThreshold ?? 6)).length,
            nonlandBudget: COMMANDER_DECK_SIZE - 1 - landTarget,
          })(c, { role: ROLE_SYNERGY, picks: [] })
        },
        analyzeCutFn: args => analyzeCut({
          plan: basePlan, sfMap: {}, cutMode: 'balanced',
          roleOf: dc => coarseRole(dc, dc),
          inclusionOf: name => byName.get(String(name).toLowerCase())?.edhrecInclusion ?? 0,
          ...args,
        }),
        addCards: async items => {
          addedRows = items.map((it, i) => ({ id: `e${i}`, name: it.name, qty: 1 }))
          return { rows: addedRows }
        },
        removeCards: async ids => ids,
        maxAdd: Number(process.env.HARNESS_MAXADD) || 12,
      })
      if (pass.added) {
        const cutSet = new Set(pass.cutIds)
        const kept = rows.filter(r => !cutSet.has(r.id)).map(r => byId.get(r.id))
        const addedPicks = pass.engineRows.map(r => {
          const cand = byName.get((r.name || '').toLowerCase()) || { name: r.name, cmc: 0 }
          return { role: ROLE_SYNERGY, cand, owned: false }
        })
        finalPicks = [...kept, ...addedPicks]
      }
    }
    results[arm.id] = measure(finalPicks, commanderCard, needs, basePlan.roles.find(r => r.role === ROLE_LANDS)?.target || 37)
  }

  return {
    name,
    edhrecCards,
    recCount: recRows.length,
    colorIdentity: commanderCard.color_identity || [],
    topEndAllowance,
    hooks: [...extractCommanderKeywords(commanderCard.oracle_text, commanderCard.type_line)],
    needs,
    expected,
    expectedTypes,
    results,
  }
}

// ── Reporting ─────────────────────────────────────────────────────────────────

const METRICS = [
  // ── Independent (simulation, not classifier) ──
  ['gfColorStuck', 'GF: colour screwed %', 'down'],
  ['colorlessPct', '% colourless picks', null],
  ['entersTappedPct', 'lands entering tapped %', 'down'],
  ['fixingPerLand', 'colours per land', 'up'],
  ['gfCommanderT5', 'GF: commander by T5 %', 'up'],
  ['gfAvgCmdTurn', 'GF: avg commander turn', 'down'],
  ['gfManaT5', 'GF: mana on turn 5', 'up'],
  ['gfScrewed', 'GF: mana screwed %', 'down'],
  ['gfFlooded', 'GF: flooded %', 'down'],
  ['gfMulligan', 'GF: mulligan %', 'down'],
  ['recPct', '% from recommander', null],
  ['zeroInclPct', '% crowd never plays', null],
  ['covPct', 'engine coverage %', 'up'],
  ['covShort', 'enablers missing', 'down'],
  ['edhrecSyn', 'avg EDHREC synergy', 'up'],
  ['offPlan', 'off-plan cards (neg syn)', 'down'],
  ['netDraw', 'net card advantage', 'up'],
  ['selection', 'selection-only in draw', 'down'],
  ['multi2', '2+ job cards', 'up'],
  ['topEnd', 'cards at 6+ MV', 'down'],
  ['avgCmc', 'avg mana value', null],
  ['kwAvg', 'avg commander hooks', 'up'],
  ['kwZeroPct', '% hitting no hook', 'down'],
  ['noTextPct', '% with no oracle text', 'down'],
  ['drawExpensiveWeak', 'weak expensive draw', 'down'],
]

function mean(rows, arm, key) {
  const vals = rows.map(r => r.results?.[arm]?.[key]).filter(Number.isFinite) // NaN is typeof number
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN
}

function fmt(v) { return Number.isFinite(v) ? v.toFixed(2) : '—' }
function pad(s, n) { return String(s).padEnd(n) }

function tierTable(label, rows, out) {
  if (!rows.length) return
  out.push('')
  out.push(`── ${label} (${rows.length} commanders) ${'─'.repeat(Math.max(0, 50 - label.length))}`)
  out.push(pad('metric', 26) + ARMS.map(a => pad(a.label, 20)).join(''))
  for (const [key, label2, better] of METRICS) {
    const base = mean(rows, 'shipped', key)
    const cells = ARMS.map(a => {
      const v = mean(rows, a.id, key)
      if (a.id === 'shipped') return pad(fmt(v), 20)
      const d = v - base
      const arrow = !better || Math.abs(d) < 0.005 ? ' ' : ((d > 0) === (better === 'up') ? '+' : '!')
      return pad(`${fmt(v)} (${d >= 0 ? '+' : ''}${fmt(d)})${arrow}`, 20)
    })
    out.push(pad(label2, 26) + cells.join(''))
  }
  // How far each arm's decklist moves from the shipped one.
  out.push(pad('cards changed vs shipped', 26) + ARMS.map(a => {
    if (a.id === 'shipped') return pad('—', 20)
    const vals = rows.map(r => {
      const s = r.results?.shipped?.names, t = r.results?.[a.id]?.names
      if (!s || !t) return NaN
      return [...t].filter(x => !s.has(x)).length
    }).filter(Number.isFinite)
    return pad(vals.length ? (vals.reduce((x, y) => x + y, 0) / vals.length).toFixed(1) : '—', 20)
  }).join(''))
}

it('build assistant A/B sweep', async () => {
  const override = process.env.HARNESS_COMMANDERS
  // Semicolon-separated, not comma: almost every legendary creature has a comma
  // in its name ("Korvold, Fae-Cursed King"), so splitting on comma silently
  // turns one commander into two unresolvable halves.
  const tiers = override
    ? { custom: override.split(';').map(s => s.trim()).filter(Boolean) }
    : COMMANDERS
  const limit = Number(process.env.HARNESS_LIMIT) || Infinity

  const collectionFile = process.env.HARNESS_COLLECTION
  const collection = collectionFile ? loadCollection(collectionFile) : null
  if (collection) {
    process.stdout.write(`  binder pool: ${collection.ownedCards.length} distinct cards
`)
  }

  const metaCache = new Map() // shared across commanders — card meta is intrinsic
  const byTier = {}
  const errors = []

  for (const [tier, names] of Object.entries(tiers)) {
    byTier[tier] = []
    for (const name of names.slice(0, limit)) {
      let res
      try {
        res = await runCommander(name, metaCache, collection)
      } catch (e) {
        res = { name, error: e?.message || String(e) }
      }
      if (res.error) { errors.push(`${name}: ${res.error}`); continue }
      byTier[tier].push(res)
      process.stdout.write(`  ${tier}/${name}: ok (edhrec ${res.edhrecCards}, rec ${res.recCount})\n`)
    }
  }

  const out = []
  out.push('BUILD ASSISTANT A/B HARNESS')
  out.push(new Date().toISOString())
  out.push('')
  out.push('Identical candidate pool per commander; only the ranking differs.')
  out.push('Arrows: + = moved the way the signal intends, ! = moved against it.')
  out.push('')
  out.push('ARMS')
  for (const a of ARMS) {
    const c = a.cfg
    out.push(`  ${pad(a.label, 22)} ` + (c
      ? `multiRole=${c.multiRole} kw=${c.commanderKw} topEnd=${c.topEndCap} drawQ=${c.drawQuality} kwRoles=${c.keywordRoles ? c.keywordRoles.length : 'all'}`
      : 'baseline'))
  }

  // Per-role effect: does buying commander theme cost card quality in the
  // functional roles? Reported for the experimental arm against shipped.
  function roleTable(rows, out) {
    out.push('')
    out.push('── PER-ROLE: experimental vs shipped ' + '─'.repeat(30))
    out.push(pad('role', 24) + pad('picks', 8) + pad('avg base rank', 18) + pad('avg hooks', 16) + 'cards changed')
    for (const role of ROLE_ORDER) {
      const cells = ['shipped', 'all'].map(arm => rows.map(r => r.results?.[arm]?.perRole?.[role]).filter(Boolean))
      const [sh, ex] = cells
      if (!sh.length && !ex.length) continue
      const avg = (arr, k) => (arr.length ? arr.reduce((a, b) => a + b[k], 0) / arr.length : NaN)
      const changed = rows.map(r => {
        const s = r.results?.shipped?.perRole?.[role]?.names
        const t = r.results?.all?.perRole?.[role]?.names
        if (!s || !t) return NaN
        return [...t].filter(x => !s.has(x)).length
      }).filter(Number.isFinite)
      const dBase = avg(ex, 'avgBase') - avg(sh, 'avgBase')
      out.push(
        pad(role, 24) +
        pad(`${fmt(avg(sh, 'n'))}→${fmt(avg(ex, 'n'))}`, 8) +
        pad(`${fmt(avg(sh, 'avgBase'))}→${fmt(avg(ex, 'avgBase'))} (${dBase >= 0 ? '+' : ''}${fmt(dBase)})`, 18) +
        pad(`${fmt(avg(sh, 'avgKw'))}→${fmt(avg(ex, 'avgKw'))}`, 16) +
        (changed.length ? (changed.reduce((a, b) => a + b, 0) / changed.length).toFixed(1) : '—'),
      )
    }
  }

  const all = Object.values(byTier).flat()
  tierTable('ALL COMMANDERS', all, out)
  roleTable(all, out)
  for (const [tier, rows] of Object.entries(byTier)) tierTable(tier.toUpperCase(), rows, out)

  // Bucketing by popularity turned out to be the wrong axis: every tier's
  // EDHREC page carries ~240-320 cardviews, so "obscure" commanders are not
  // actually short of inclusion data. What DOES vary is how much rules text the
  // commander has — and old/obscure legends tend to have almost none, which
  // confounds the popularity tiers. Bucketing by hook count separates the two.
  const byHooks = {
    'HOOKS 0-1 (sparse commander text)': all.filter(r => r.hooks.length <= 1),
    'HOOKS 2-3 (typical)': all.filter(r => r.hooks.length >= 2 && r.hooks.length <= 3),
    'HOOKS 4+ (text-rich)': all.filter(r => r.hooks.length >= 4),
  }
  for (const [label, rows] of Object.entries(byHooks)) tierTable(label, rows, out)

  out.push('')
  out.push("COLOURLESS SUPPORT — does the build patch a colour's weaknesses?")
  out.push("(colourless share of a role, split by whether the deck has the colour that is GOOD at it)")
  out.push(pad('role', 24) + pad('split', 22) + pad('n', 5) + pad('colourless %', 14) + 'avg cards')
  const WEAKNESS = [
    [ROLE_DRAW, 'U', 'blue'],
    [ROLE_DRAW, 'G', 'green'],
    [ROLE_RAMP, 'G', 'green'],
    [ROLE_REMOVAL, 'W', 'white'],
    [ROLE_WIPE, 'W', 'white'],
  ]
  for (const [role, color, label] of WEAKNESS) {
    for (const has of [true, false]) {
      const rows2 = all.filter(r => (r.colorIdentity || []).includes(color) === has)
      if (!rows2.length) continue
      const tot = rows2.reduce((a, r) => a + (r.results?.shipped?.countByRole?.[role] || 0), 0)
      const cl = rows2.reduce((a, r) => a + (r.results?.shipped?.colorlessByRole?.[role] || 0), 0)
      out.push(
        pad(role, 24) + pad(`${has ? 'has' : 'no'} ${label}`, 22) + pad(rows2.length, 5) +
        pad(tot ? ((cl / tot) * 100).toFixed(1) + '%' : '—', 14) +
        (tot / rows2.length).toFixed(1),
      )
    }
  }

  out.push("")
  out.push("TOP-END ALLOWANCE — what real decks run at 6+ MV (flat cap was 4 for everyone)")
  {
    const rows2 = all.filter(r => r.topEndAllowance != null)
      .map(r => ({ n: r.name.split(",")[0], v: r.topEndAllowance }))
      .sort((a, b) => b.v - a.v)
    out.push("  highest:  " + rows2.slice(0, 6).map(x => `${x.n} ${x.v}`).join(" · "))
    out.push("  lowest:   " + rows2.slice(-6).map(x => `${x.n} ${x.v}`).join(" · "))
    const over = rows2.filter(x => x.v > 4).length
    out.push(`  ${over} of ${rows2.length} commanders want MORE than the flat cap of 4`)
  }

  out.push('')
  out.push('NOVELTY SHARE (cards the crowd never plays for this commander) — shipped arm')
  {
    const vals = all.map(r => ({ n: r.name, v: r.results?.shipped?.recPct ?? 0 })).sort((a, b) => b.v - a.v)
    const nums = vals.map(v => v.v)
    const mean = nums.reduce((a, b) => a + b, 0) / (nums.length || 1)
    const med = [...nums].sort((a, b) => a - b)[Math.floor(nums.length / 2)]
    out.push(`  mean ${mean.toFixed(1)}%   median ${med.toFixed(1)}%   min ${nums[nums.length - 1].toFixed(1)}%   max ${nums[0].toFixed(1)}%`)
    out.push('  highest:  ' + vals.slice(0, 6).map(v => `${v.n.split(',')[0]} ${v.v.toFixed(0)}%`).join(' · '))
    out.push('  lowest:   ' + vals.slice(-4).map(v => `${v.n.split(',')[0]} ${v.v.toFixed(0)}%`).join(' · '))
  }

  out.push('')
  out.push('CARD TYPE BALANCE — shipped auto-fill vs an average real deck')
  out.push(pad('type', 14) + pad('real deck', 12) + pad('shipped', 12) + pad('diff', 10) + pad('derived tmpl', 14) + pad('diff', 10) + 'worst (shipped)')
  for (const ct of CARD_TYPES) {
    const rows2 = all.filter(r => r.expectedTypes?.[ct] != null)
    if (!rows2.length) continue
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length
    const exp = avg(rows2.map(r => r.expectedTypes[ct]))
    const ship = avg(rows2.map(r => r.results?.shipped?.typeCounts?.[ct] || 0))
    const der = avg(rows2.map(r => r.results?.derived?.typeCounts?.[ct] || 0))
    const sign = v => (v >= 0 ? '+' : '') + v.toFixed(1)
    const diffs = rows2.map(r => ({ n: r.name, d: (r.results?.shipped?.typeCounts?.[ct] || 0) - r.expectedTypes[ct] }))
    diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    out.push(
      pad(ct, 14) + pad(exp.toFixed(1), 12) + pad(ship.toFixed(1), 12) + pad(sign(ship - exp), 10) +
      pad(der.toFixed(1), 14) + pad(sign(der - exp), 10) +
      `${diffs[0].n.slice(0, 22)} (${sign(diffs[0].d)})`,
    )
  }

  out.push('')
  out.push('TARGET CALIBRATION — what an AVERAGE EDHREC deck actually runs')
  out.push('(avg deck = inclusion-weighted, scaled for EDHREC page coverage; both decks now ~62 spells)')
  out.push(pad('commander', 30) + pad('enabler', 18) + pad('guessed', 9) + pad('avg deck', 10) + 'shipped fill')
  const calib = {}
  for (const r of all) {
    for (const need of r.needs || []) {
      const exp = r.expected?.scaled?.[need.enabler]
      if (exp == null) continue
      const got = (r.results?.shipped?.coverage || []).find(c => c.enabler === need.enabler)?.have
      ;(calib[need.enabler] ||= []).push(exp)
      out.push(
        pad(r.name.slice(0, 28), 30) + pad(need.enabler, 18) +
        pad(need.target, 9) + pad(exp.toFixed(1), 10) + (got ?? '—'),
      )
    }
  }
  out.push('')
  out.push('PROPOSED TARGETS (median of the average-deck counts)')
  out.push(pad('enabler', 18) + pad('guessed', 9) + pad('median', 9) + pad('min', 8) + pad('max', 8) + 'n')
  for (const [enabler, vals] of Object.entries(calib)) {
    const sorted = [...vals].sort((a, b) => a - b)
    const mid = sorted[Math.floor(sorted.length / 2)]
    const guessed = all.flatMap(r => r.needs || []).find(n => n.enabler === enabler)?.target
    out.push(
      pad(enabler, 18) + pad(guessed ?? '—', 9) + pad(mid.toFixed(1), 9) +
      pad(sorted[0].toFixed(1), 8) + pad(sorted[sorted.length - 1].toFixed(1), 8) + vals.length,
    )
  }

  out.push('')
  out.push('ENGINE COVERAGE GAP IN THE SHIPPED BUILD (step 0 — is there a problem to fix?)')
  out.push(pad('commander', 30) + pad('need', 20) + pad('target', 8) + pad('shipped has', 12) + 'providers')
  for (const r of all) {
    for (const cov of r.results?.shipped?.coverage || []) {
      out.push(
        pad(r.name.slice(0, 28), 30) + pad(cov.label, 20) + pad(cov.target, 8) +
        pad(cov.have + (cov.short ? '  SHORT ' + cov.short : ''), 12) +
        (cov.providers.slice(0, 3).join(', ') || '—'),
      )
    }
  }

  out.push('')
  out.push('PER-COMMANDER (hooks · edhrec pool · rec picks · cards changed by exp)')
  for (const r of all) {
    const changed = [...(r.results.all?.names || [])].filter(x => !r.results.shipped?.names?.has(x)).length
    out.push(`  ${pad(r.name, 32)} hooks=${pad(r.hooks.length, 3)} edhrec=${pad(r.edhrecCards, 5)} rec=${pad(r.recCount, 4)} changed=${changed}`)
  }
  if (errors.length) {
    out.push('')
    out.push('SKIPPED')
    for (const e of errors) out.push('  ' + e)
  }

  const dest = process.env.HARNESS_OUT || path.join(process.cwd(), 'harness-build-assist.txt')
  fs.writeFileSync(dest, out.join('\n'))
  process.stdout.write(`\nreport → ${dest}\n`)
})
