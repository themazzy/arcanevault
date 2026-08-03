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
  COMMANDER_TEMPLATE,
  COMMANDER_DECK_SIZE,
  ROLE_ORDER,
  ROLE_DRAW,
  ROLE_LANDS,
  ROLE_SYNERGY,
  ROLE_WINCON,
} from '../src/lib/deckBuildAssistant'
import {
  EXPERIMENTAL_DEFAULTS,
  buildScoringContext,
  makeExperimentalComparatorFor,
  makeExperimentalExclude,
} from '../src/lib/buildAssistExperimental'
import { cardRoleTags, engineRoleCount, drawQuality } from '../src/lib/cardRoles'
import { recRank } from '../src/lib/deckBuildAssistant'
import { extractCommanderKeywords, extractTribe, synergyScore } from '../src/lib/commanderSynergy'
import { commanderNeeds, analyzeEngineCoverage, cardEnablers } from '../src/lib/engineEnablers'
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
const OFF = { multiRole: false, edhrecSynergy: false, commanderKw: false, deckAffinity: false, topEndCap: false, drawQuality: false, drawCurve: false }
const ARMS = [
  { id: 'shipped', label: 'shipped', cfg: null },
  { id: 'all', label: 'all signals', cfg: { ...EXPERIMENTAL_DEFAULTS } },
  { id: 'syn', label: 'EDHREC synergy only', cfg: { ...EXPERIMENTAL_DEFAULTS, ...OFF, edhrecSynergy: true } },
  { id: 'kw', label: 'keywords only', cfg: { ...EXPERIMENTAL_DEFAULTS, ...OFF, edhrecSynergy: false, commanderKw: true, deckAffinity: true } },
  { id: 'multi', label: 'multi-role only', cfg: { ...EXPERIMENTAL_DEFAULTS, ...OFF, multiRole: true } },
  { id: 'topend', label: 'top-end cap only', cfg: { ...EXPERIMENTAL_DEFAULTS, ...OFF, topEndCap: true } },
  { id: 'drawq', label: 'draw quality only', cfg: { ...EXPERIMENTAL_DEFAULTS, ...OFF, drawQuality: true } },
  { id: 'engine', label: 'all + engine pass', cfg: { ...EXPERIMENTAL_DEFAULTS }, enginePass: true },
]


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
    color_identity: meta.color_identity || [],
    oracle_text: meta.oracle_text || '',
    type_line: meta.type_line || '',
    cmc: meta.cmc ?? 0,
  }
}

// ── Metrics ───────────────────────────────────────────────────────────────────
// Every metric is computed from the PICKED cards only, using the same pure
// classifiers the assistant uses, so the harness and the app agree on what a
// "draw spell" or a "two-job card" is.
function measure(picks, commanderCard, needs) {
  const kw = extractCommanderKeywords(commanderCard?.oracle_text || '', commanderCard?.type_line || '')
  const cards = picks.map(p => p.cand)
  const nonland = cards.filter(c => !String(c.type || c.type_line || '').toLowerCase().includes('land'))

  let synSum = 0, synNeg = 0
  let netDraw = 0, selection = 0, multi2 = 0, multi3 = 0
  let kwSum = 0, kwZero = 0, noText = 0
  let topEnd = 0, cmcSum = 0
  const drawCards = []

  for (const c of nonland) {
    const oracle = String(c.oracle || c.oracle_text || '')
    const type = String(c.type || c.type_line || '')
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
    const oracle = String(c.oracle || c.oracle_text || '')
    const type = String(c.type || c.type_line || '')
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
    cards.map(c => ({ name: c.name, oracle: String(c.oracle || c.oracle_text || ''), type: String(c.type || c.type_line || '') })),
    needs || [],
  )
  const covPct = coverage.length
    ? coverage.reduce((s2, c) => s2 + Math.min(1, c.have / (c.target || 1)), 0) / coverage.length * 100
    : NaN
  const covShort = coverage.reduce((s2, c) => s2 + c.short, 0)

  const n = nonland.length || 1
  return {
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

async function runCommander(name, metaCache) {
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

  const needs = commanderNeeds(
    extractCommanderKeywords(commanderCard.oracle_text, commanderCard.type_line),
    extractTribe(commanderCard.oracle_text, commanderCard.type_line),
    commanderCard.oracle_text,
    expected.scaled,
  )
  const recRows = await fetchRecommanderRows(name)
  const targetCmc = planTargetAvgCmc(edhrec, '')

  const results = {}
  // The pool is identical for every arm, so build it ONCE — the arms differ only
  // in how they rank it, which is the whole point of the comparison.
  const basePlan = await (async () => {
    const base = analyzeBuildPlan({
      commander: commanderCard,
      ownedCards: [],
      sfMap: {},
      currentDeckCards: [],
      template: COMMANDER_TEMPLATE,
      deckSize: COMMANDER_DECK_SIZE,
    })
    let plan = await enrichPlanWithEdhrec(base, async () => edhrec, metaFetch)
    if (recRows.length) plan = attachRecommenderUpgrades(plan, recRows)
    return plan
  })()

  const upgradesFor = role => selectUpgrades(
    role,
    recRows.length ? 'both' : 'edhrec',
    upgradePoolDepth(role.gap || 0),
  )
  const roles = basePlan.roles.map(r => ({ ...r, upgrades: upgradesFor(r) }))
  const landsRole = basePlan.roles.find(r => r.role === ROLE_LANDS)
  const landUpgrades = landsRole
    ? upgradesFor(landsRole).filter(u => (u.type || '').toLowerCase().includes('land'))
    : []
  const ctx = buildScoringContext({
    commanderOracle: commanderCard.oracle_text,
    commanderType: commanderCard.type_line,
    commanderCmc: commanderCard.cmc,
    deckTexts: [],
  })

  for (const arm of ARMS) {
    const cfg = arm.cfg

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
      nonbasicTarget: basePlan.roles.find(r => r.role === ROLE_LANDS)?.target || 37,
      currentNonbasicLands: 0,
      source: 'recommended',
      targetCmc,
      curveStatus: 'on',
      comparatorFor: cfg ? makeExperimentalComparatorFor({ ctx, cfg, targetCmc, curveStatus: 'on' }) : null,
      exclude: cfg
        ? makeExperimentalExclude({
            cfg,
            deckTopEnd: 0,
            drawRole: ROLE_DRAW,
            drawTarget: basePlan.roles.find(r => r.role === ROLE_DRAW)?.target || 0,
          })
        : undefined,
    })
    let finalPicks = picks
    if (arm.enginePass && needs.length) {
      // In-memory equivalent of runEnginePass: the harness has no deck rows to
      // add/remove, so it applies the same provider selection directly to the
      // pick list, swapping out the lowest-ranked non-provider filler.
      const asCard = c => ({ name: c.name, oracle: String(c.oracle || c.oracle_text || ''), type: String(c.type || c.type_line || '') })
      const cov = analyzeEngineCoverage(picks.map(p => asCard(p.cand)), needs)
      const inDeck = new Set(picks.map(p => (p.cand.name || '').toLowerCase()))
      const pool = []
      for (const spec of roles) for (const c of [...(spec.ownedCandidates || []), ...(spec.upgrades || [])]) pool.push(c)
      const swaps = []
      for (const need of cov.filter(c => c.short > 0).sort((a, b) => b.short - a.short)) {
        let taken = 0
        for (const c of pool) {
          if (taken >= need.short || swaps.length >= 6) break
          const k = (c.name || '').toLowerCase()
          if (inDeck.has(k)) continue
          if (!cardEnablers(String(c.oracle || ''), String(c.type || '')).has(need.enabler)) continue
          inDeck.add(k); swaps.push({ role: need.enabler, cand: c, owned: false }); taken++
        }
      }
      if (swaps.length) {
        const provider = new Set()
        for (const c of cov) for (const p of c.providers) provider.add(p.toLowerCase())
        const cuttable = picks
          .filter(p => !provider.has((p.cand.name || '').toLowerCase()))
          .slice(-swaps.length)
        const cutSet = new Set(cuttable.map(p => p.cand.name))
        finalPicks = [...picks.filter(p => !cutSet.has(p.cand.name)), ...swaps]
      }
    }
    results[arm.id] = measure(finalPicks, commanderCard, needs)
  }

  return {
    name,
    edhrecCards,
    recCount: recRows.length,
    hooks: [...extractCommanderKeywords(commanderCard.oracle_text, commanderCard.type_line)],
    needs,
    expected,
    results,
  }
}

// ── Reporting ─────────────────────────────────────────────────────────────────

const METRICS = [
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

  const metaCache = new Map() // shared across commanders — card meta is intrinsic
  const byTier = {}
  const errors = []

  for (const [tier, names] of Object.entries(tiers)) {
    byTier[tier] = []
    for (const name of names.slice(0, limit)) {
      let res
      try {
        res = await runCommander(name, metaCache)
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
