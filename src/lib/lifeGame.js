// Life tracker game model — pure, no React, no storage, no network.
//
// Everything the tracker does to a game is a reducer action, so the whole model
// is unit-testable and the persistence layer has exactly one thing to serialize.
// The previous implementation spread this across 22 useState hooks in a 594-line
// component; a stale-closure bug in the log path and a reset that forgot to clear
// counters both came out of that.
//
// Rotation lives here as *data* (degrees per seat) because it describes where a
// person is sitting, not how wide the viewport is. The old CSS only applied
// rotation under 900px, which meant a tablet lying flat on the table showed every
// seat upright.

// ── Formats ────────────────────────────────────────────────────────────────────
// Keys are persisted in game_results.format and game_sessions.mode — Stats and
// the Profile bento read them back, so they must not be renamed.
export const LIFE_FORMATS = {
  commander:   { label: 'Commander',   life: 40, commander: true,  seats: 4 },
  standard:    { label: 'Standard',    life: 20, commander: false, seats: 2 },
  brawl:       { label: 'Brawl',       life: 25, commander: true,  seats: 2 },
  oathbreaker: { label: 'Oathbreaker', life: 20, commander: true,  seats: 2 },
  planechase:  { label: 'Planechase',  life: 20, commander: false, seats: 4 },
  custom:      { label: 'Custom',      life: 20, commander: false, seats: 4 },
}

export const FORMAT_ORDER = ['commander', 'standard', 'brawl', 'oathbreaker', 'planechase', 'custom']

export const MIN_LIFE = 1
export const MAX_LIFE = 999
export const MIN_SEATS = 2
export const MAX_SEATS = 6

// ── Player colors ──────────────────────────────────────────────────────────────
// Higher chroma than the previous pastel set, which read as six near-identical
// grey blobs across a table in dim light — the one thing a seat color has to do.
export const PLAYER_COLORS = [
  '#d94f4f', // red
  '#3d8fd9', // blue
  '#4fae63', // green
  '#e0b13c', // gold
  '#a25fd0', // purple
  '#e07a3c', // orange
]

export const DEFAULT_NAMES = ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6']

// ── Counters ───────────────────────────────────────────────────────────────────
export const COUNTER_DEFS = [
  { key: 'poison',     label: 'Poison',     short: 'PSN', lethalAt: 10 },
  { key: 'energy',     label: 'Energy',     short: 'NRG', lethalAt: null },
  { key: 'experience', label: 'Experience', short: 'XP',  lethalAt: null },
]

export const LETHAL_POISON = 10
export const LETHAL_CMD_DMG = 21

// ── Death flavour ──────────────────────────────────────────────────────────────
// Shown as one line under a dead player's life total. Deliberately not an overlay:
// the number still has to be readable when someone asks what you went out on.
// Card names keep their printed US spelling ("Gray Merchant"); prose does not.
export const DEATH_TEXTS = [
  'Split in half by Garruk',
  'Burned to a crisp by Chandra',
  'Devoured by the Eldrazi titans',
  'Turned to stone by a basilisk',
  'Banished to the Blind Eternities',
  'Exploded in a storm of instants',
  'Milled out with an empty library',
  'Wrathed off the battlefield',
  'Drained by a Gray Merchant',
  'Stampeded by an Overrun',
  'Bolted for the last three',
  'Sacrificed to Ashnod\'s Altar',
  'Caught in an infinite combo',
  'Poisoned by an Inkmoth swarm',
  'Compleated by the Phyrexians',
  'Swallowed by Emrakul\'s shadow',
  'Erased by a Cyclonic Rift',
  'Extorted into oblivion',
  'Trampled by an army of squirrels',
  'Dismembered for one black mana',
  'Struck down by Settle the Wreckage',
  'Undone by their own Thassa\'s Oracle',
  'Decked on the final draw step',
  'Crushed under Ulamog\'s tread',
  'Hexproof, but not lifeproof',
  'Doubled up by a Fireball',
  'Lost the coin flip that mattered',
  'Buried under a Craterhoof swing',
  'Reduced to ash by Blasphemous Act',
  'Left tapped out and defenceless',
  'Torched by a goblin horde',
  'Outlived by their own commander',
  'Wiped by a Damnation nobody saw',
  'Choked out under a Winter Orb',
  'Withered by a Sheoldred stare',
  'Ambushed the turn after a Fog',
  'Beaten down by 21 commander damage',
  'Fizzled holding a hand of lands',
  'Locked out by an Armageddon',
  'Sent to the Underworld by Athreos',
]

// FNV-1a over the seat's death identity. A hash rather than Math.random because
// the reducer stays pure and the message has to survive both a re-render and a
// reload — the old implementation re-rolled it on every render behind an
// eslint-disable, so the flavour text flickered as you tapped.
function hashSeed(seed) {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash | 0)
}

/**
 * The flavour line for a dead seat, or null while they are alive. Keyed by the
 * player's death count so being brought back and killed again reads differently.
 */
export function deathTextFor(game, player) {
  if (!isPlayerDead(player)) return null
  const seed = `${game?.startedAt ?? 0}:${player.id}:${player.deaths ?? 0}`
  return DEATH_TEXTS[hashSeed(seed) % DEATH_TEXTS.length]
}

// ── Seat layouts ───────────────────────────────────────────────────────────────
// Two kinds, and the distinction is physical rather than cosmetic:
//   'table'    — the device lies in the middle of the table, so seats that face
//                it from the far side are rotated to face their player.
//   'handheld' — one person holds the device; every seat is upright.
// `areas` is a grid-template-areas value; `seats[i]` maps seat index i to an
// area name and a rotation in degrees. A player sitting to the LEFT of the device
// reads text whose top points left, which is rotate(-90deg).
export const SEAT_LAYOUTS = {
  2: [
    { id: '2-table',    label: 'Around the table', kind: 'table',
      cols: '1fr', rows: '1fr 1fr', areas: '"a" "b"',
      seats: [{ area: 'a', rotation: 180 }, { area: 'b', rotation: 0 }] },
    { id: '2-handheld', label: 'Held by one player', kind: 'handheld',
      cols: '1fr', rows: '1fr 1fr', areas: '"a" "b"',
      seats: [{ area: 'a', rotation: 0 }, { area: 'b', rotation: 0 }] },
  ],
  3: [
    { id: '3-table',    label: 'Around the table', kind: 'table',
      cols: '1fr 1fr', rows: '1fr 1fr', areas: '"a b" "c c"',
      seats: [{ area: 'a', rotation: 180 }, { area: 'b', rotation: 180 }, { area: 'c', rotation: 0 }] },
    { id: '3-handheld', label: 'Held by one player', kind: 'handheld',
      cols: '1fr', rows: '1fr 1fr 1fr', areas: '"a" "b" "c"',
      seats: [{ area: 'a', rotation: 0 }, { area: 'b', rotation: 0 }, { area: 'c', rotation: 0 }] },
  ],
  4: [
    { id: '4-table',    label: 'Around the table', kind: 'table',
      cols: '1fr 1fr', rows: '1fr 1fr', areas: '"a b" "c d"',
      seats: [{ area: 'a', rotation: 180 }, { area: 'b', rotation: 180 },
              { area: 'c', rotation: 0 },   { area: 'd', rotation: 0 }] },
    { id: '4-edges',    label: 'One per side', kind: 'table',
      cols: '1fr 1fr', rows: '1fr 1.4fr 1fr', areas: '"a a" "b c" "d d"',
      seats: [{ area: 'a', rotation: 180 }, { area: 'b', rotation: -90 },
              { area: 'c', rotation: 90 },  { area: 'd', rotation: 0 }] },
    { id: '4-handheld', label: 'Held by one player', kind: 'handheld',
      cols: '1fr 1fr', rows: '1fr 1fr', areas: '"a b" "c d"',
      seats: [{ area: 'a', rotation: 0 }, { area: 'b', rotation: 0 },
              { area: 'c', rotation: 0 }, { area: 'd', rotation: 0 }] },
  ],
  5: [
    { id: '5-table',    label: 'Around the table', kind: 'table',
      cols: 'repeat(6, 1fr)', rows: '1fr 1fr', areas: '"a a b b c c" "d d d e e e"',
      seats: [{ area: 'a', rotation: 180 }, { area: 'b', rotation: 180 }, { area: 'c', rotation: 180 },
              { area: 'd', rotation: 0 },   { area: 'e', rotation: 0 }] },
    { id: '5-handheld', label: 'Held by one player', kind: 'handheld',
      cols: '1fr 1fr', rows: '1fr 1fr 1fr', areas: '"a b" "c d" "e e"',
      seats: [{ area: 'a', rotation: 0 }, { area: 'b', rotation: 0 }, { area: 'c', rotation: 0 },
              { area: 'd', rotation: 0 }, { area: 'e', rotation: 0 }] },
  ],
  6: [
    { id: '6-table',    label: 'Around the table', kind: 'table',
      cols: 'repeat(3, 1fr)', rows: '1fr 1fr', areas: '"a b c" "d e f"',
      seats: [{ area: 'a', rotation: 180 }, { area: 'b', rotation: 180 }, { area: 'c', rotation: 180 },
              { area: 'd', rotation: 0 },   { area: 'e', rotation: 0 },   { area: 'f', rotation: 0 }] },
    { id: '6-handheld', label: 'Held by one player', kind: 'handheld',
      cols: '1fr 1fr', rows: '1fr 1fr 1fr', areas: '"a b" "c d" "e f"',
      seats: [{ area: 'a', rotation: 0 }, { area: 'b', rotation: 0 }, { area: 'c', rotation: 0 },
              { area: 'd', rotation: 0 }, { area: 'e', rotation: 0 }, { area: 'f', rotation: 0 }] },
  ],
}

export function layoutsFor(seatCount) {
  return SEAT_LAYOUTS[clampSeats(seatCount)] || SEAT_LAYOUTS[4]
}

export function findLayout(seatCount, layoutId) {
  const options = layoutsFor(seatCount)
  return options.find(l => l.id === layoutId) || options[0]
}

export function clampSeats(n) {
  const v = Math.round(Number(n) || 0)
  return Math.min(MAX_SEATS, Math.max(MIN_SEATS, v))
}

export function clampLife(n) {
  const v = Math.round(Number(n) || 0)
  return Math.min(MAX_LIFE, Math.max(MIN_LIFE, v))
}

export function startingLifeFor(format, customLife) {
  if (format === 'custom') return clampLife(customLife)
  return LIFE_FORMATS[format]?.life ?? 20
}

export function isCommanderFormat(format) {
  return !!LIFE_FORMATS[format]?.commander
}

// ── Player factory ─────────────────────────────────────────────────────────────
// `dmg` is keyed by the *dealing* player's id and holds a [commander1, commander2]
// pair, so partner damage is the same shape as regular damage rather than the
// parallel cmdDmg/cmdDmg2 objects the old model carried.
export function makePlayer(index, life, seed = {}) {
  return {
    id: index,
    name: seed.name || DEFAULT_NAMES[index] || `Player ${index + 1}`,
    color: seed.color || PLAYER_COLORS[index % PLAYER_COLORS.length],
    artUrl: seed.artUrl ?? null,
    deckId: seed.deckId ?? null,
    deckName: seed.deckName ?? null,
    userId: seed.userId ?? null,
    // Which lobby seat this player came from, in a shared game. Kept because seats
    // can be swapped mid-game, so array position is not a stable link back to the
    // game_players row.
    slotIndex: seed.slotIndex ?? null,
    life: Number.isFinite(seed.life) ? seed.life : life,
    hasPartner: seed.hasPartner ?? false,
    // Counts completed alive→dead transitions, so the flavour line changes if a
    // player is brought back and killed again.
    deaths: Number(seed.deaths) || 0,
    tax: normalizePair(seed.tax),
    dmg: normalizeDmg(seed.dmg),
    counters: {
      poison: 0, energy: 0, experience: 0,
      ...(seed.counters || {}),
    },
  }
}

function normalizePair(pair) {
  if (!Array.isArray(pair)) return [0, 0]
  return [Number(pair[0]) || 0, Number(pair[1]) || 0]
}

function normalizeDmg(dmg) {
  const out = {}
  if (!dmg || typeof dmg !== 'object') return out
  for (const [from, pair] of Object.entries(dmg)) {
    const norm = normalizePair(pair)
    if (norm[0] || norm[1]) out[from] = norm
  }
  return out
}

// ── Death rules ────────────────────────────────────────────────────────────────
// Poison 10+ (infect/toxic), 21+ commander damage from any single commander —
// including a partner, which is why dmg pairs are checked element-wise.
export function isPlayerDead(player) {
  if (!player) return false
  if ((player.life ?? 0) <= 0) return true
  if ((player.counters?.poison ?? 0) >= LETHAL_POISON) return true
  return Object.values(player.dmg || {}).some(pair =>
    Array.isArray(pair) && pair.some(v => (v || 0) >= LETHAL_CMD_DMG))
}

export function totalCmdDmg(player, fromId) {
  const pair = player?.dmg?.[fromId]
  if (!Array.isArray(pair)) return 0
  return (pair[0] || 0) + (pair[1] || 0)
}

export function maxCmdDmg(player) {
  return Object.values(player?.dmg || {}).reduce((max, pair) => {
    if (!Array.isArray(pair)) return max
    return Math.max(max, pair[0] || 0, pair[1] || 0)
  }, 0)
}

// ── Game factory ───────────────────────────────────────────────────────────────
export const GAME_VERSION = 2

export function createGame({
  format = 'commander',
  customLife = 20,
  seatCount,
  layoutId = null,
  seeds = [],
  sessionId = null,
  startedAt = null,
} = {}) {
  const count = clampSeats(seatCount ?? LIFE_FORMATS[format]?.seats ?? 4)
  const life = startingLifeFor(format, customLife)
  const layout = findLayout(count, layoutId)
  return {
    version: GAME_VERSION,
    format,
    customLife: clampLife(customLife),
    startingLife: life,
    seatCount: count,
    layoutId: layout.id,
    sessionId,
    startedAt: startedAt ?? Date.now(),
    players: Array.from({ length: count }, (_, i) => makePlayer(i, life, seeds[i] || {})),
    log: [],
  }
}

// ── Log ────────────────────────────────────────────────────────────────────────
export const MAX_LOG = 150
// Consecutive taps on the same seat are one event, not eight. Anything longer
// than this gap reads as a separate thing that happened at the table.
export const LOG_MERGE_MS = 2600

function pushLog(log, entry) {
  const head = log[0]
  const mergeable =
    head &&
    head.kind === entry.kind &&
    head.playerId === entry.playerId &&
    head.fromId === entry.fromId &&
    head.counterKey === entry.counterKey &&
    entry.ts - head.ts < LOG_MERGE_MS
  if (mergeable) {
    const merged = { ...head, delta: head.delta + entry.delta, total: entry.total, ts: entry.ts }
    // A net-zero nudge (−3 then +3) leaves nothing worth reading.
    if (merged.delta === 0 && merged.kind !== 'reset') return log.slice(1)
    return [merged, ...log.slice(1)]
  }
  return [entry, ...log].slice(0, MAX_LOG)
}

// ── Reducer ────────────────────────────────────────────────────────────────────
export function gameReducer(state, action) {
  // 'hydrate' is the only action that is meaningful with no game in progress —
  // it both loads a game and, with game: null, clears one. It carries a state
  // that already has its death counts, so it skips the transition pass.
  if (!state || action.type === 'hydrate') {
    return action.type === 'hydrate' ? action.game : state
  }
  return settleDeaths(state, applyAction(state, action))
}

// Bumps the death count for any seat that just crossed from alive to dead, which
// is what re-keys their flavour line. Runs once for every action rather than being
// duplicated into each case, so no future action can forget it.
function settleDeaths(prev, next) {
  if (prev === next) return next
  let changed = false
  const players = next.players.map(player => {
    const before = prev.players.find(p => p.id === player.id)
    if (!before || isPlayerDead(before) || !isPlayerDead(player)) return player
    changed = true
    return { ...player, deaths: (player.deaths ?? 0) + 1 }
  })
  return changed ? { ...next, players } : next
}

function applyAction(state, action) {
  switch (action.type) {

    case 'life': {
      const player = findPlayer(state, action.id)
      if (!player) return state
      const life = player.life + action.delta
      return {
        ...state,
        players: replacePlayer(state.players, action.id, { life }),
        log: pushLog(state.log, {
          ts: action.ts ?? Date.now(), kind: 'life', playerId: player.id,
          playerName: player.name, playerColor: player.color,
          delta: action.delta, total: life,
        }),
      }
    }

    case 'cmdDamage': {
      const player = findPlayer(state, action.id)
      if (!player) return state
      const slot = action.slot === 1 ? 1 : 0
      const pair = normalizePair(player.dmg[action.fromId])
      const next = Math.max(0, pair[slot] + action.delta)
      const applied = next - pair[slot]
      if (applied === 0) return state
      const nextPair = slot === 0 ? [next, pair[1]] : [pair[0], next]
      const dmg = { ...player.dmg }
      if (nextPair[0] || nextPair[1]) dmg[action.fromId] = nextPair
      else delete dmg[action.fromId]
      // Commander damage is damage: it moves life in the same step, so the two
      // can never disagree.
      const life = player.life - applied
      const source = findPlayer(state, action.fromId)
      return {
        ...state,
        players: replacePlayer(state.players, action.id, { dmg, life }),
        log: pushLog(state.log, {
          ts: action.ts ?? Date.now(), kind: 'cmdDamage', playerId: player.id,
          playerName: player.name, playerColor: player.color,
          fromId: action.fromId, fromName: source?.name ?? 'Commander',
          slot, delta: -applied, total: life,
        }),
      }
    }

    case 'counter': {
      const player = findPlayer(state, action.id)
      if (!player) return state
      const current = player.counters?.[action.key] ?? 0
      const value = Math.max(0, current + action.delta)
      if (value === current) return state
      return {
        ...state,
        players: replacePlayer(state.players, action.id, {
          counters: { ...player.counters, [action.key]: value },
        }),
        log: pushLog(state.log, {
          ts: action.ts ?? Date.now(), kind: 'counter', playerId: player.id,
          playerName: player.name, playerColor: player.color,
          counterKey: action.key, delta: value - current, total: value,
        }),
      }
    }

    case 'tax': {
      const player = findPlayer(state, action.id)
      if (!player) return state
      const slot = action.slot === 1 ? 1 : 0
      const pair = normalizePair(player.tax)
      const value = Math.max(0, pair[slot] + action.delta)
      const tax = slot === 0 ? [value, pair[1]] : [pair[0], value]
      return { ...state, players: replacePlayer(state.players, action.id, { tax }) }
    }

    // Identity edits (name, color, art, deck, partner) never touch the log —
    // they are not things that happened in the game.
    case 'patchPlayer': {
      const player = findPlayer(state, action.id)
      if (!player) return state
      const patch = { ...action.patch }
      if (typeof patch.name === 'string') {
        const trimmed = patch.name.trim()
        if (!trimmed) delete patch.name
        else patch.name = trimmed.slice(0, 24)
      }
      return { ...state, players: replacePlayer(state.players, action.id, patch) }
    }

    case 'setLayout':
      return { ...state, layoutId: findLayout(state.seatCount, action.layoutId).id }

    // Physically move two players around the table.
    //
    // This swaps POSITIONS in the array, never ids. Everything that has to follow a
    // player — commander damage (keyed by the dealing player's id), the log, deck
    // attribution, the lobby slot link — stays attached to the id, while the panel
    // they appear in comes from their array index. So the panels move and nothing
    // else does.
    case 'swapSeats': {
      const { a, b } = action
      if (a === b) return state
      if (!state.players[a] || !state.players[b]) return state
      const players = [...state.players]
      players[a] = state.players[b]
      players[b] = state.players[a]
      return { ...state, players }
    }

    // Same people, same decks, fresh totals — the "another game?" case.
    case 'reset': {
      const life = state.startingLife
      return {
        ...state,
        startedAt: action.ts ?? Date.now(),
        players: state.players.map(p => makePlayer(p.id, life, {
          name: p.name, color: p.color, artUrl: p.artUrl,
          deckId: p.deckId, deckName: p.deckName, userId: p.userId,
          hasPartner: p.hasPartner,
        })),
        log: [],
      }
    }

    default:
      return state
  }
}

function findPlayer(state, id) {
  return state.players.find(p => p.id === id) || null
}

function replacePlayer(players, id, patch) {
  return players.map(p => (p.id === id ? { ...p, ...patch } : p))
}

// ── Migration ──────────────────────────────────────────────────────────────────
// Reads both the current shape and the pre-rewrite sessionStorage payload
// ({ screen, config, players:[{cmdDmg, cmdDmg2, cmdTax, cmdTax2, artCropUrl}] })
// so a game in progress survives the deploy that ships this file.
export function migrateGame(raw) {
  if (!raw || typeof raw !== 'object') return null

  if (raw.version === GAME_VERSION && Array.isArray(raw.players)) {
    return {
      ...raw,
      players: raw.players.map((p, i) => makePlayer(p.id ?? i, raw.startingLife ?? 20, p)),
      log: Array.isArray(raw.log) ? raw.log.slice(0, MAX_LOG) : [],
    }
  }

  const config = raw.config || raw
  const legacyPlayers = Array.isArray(raw.players) ? raw.players : null
  if (!legacyPlayers?.length) return null

  const format = LIFE_FORMATS[config.mode] ? config.mode : 'custom'
  const startingLife = format === 'custom'
    ? clampLife(config.customLife ?? legacyPlayers[0]?.life ?? 20)
    : startingLifeFor(format, config.customLife)
  const seatCount = clampSeats(config.playerCount ?? legacyPlayers.length)

  const seeds = legacyPlayers.slice(0, seatCount).map(p => ({
    name: p.name, color: p.color, artUrl: p.artCropUrl ?? p.artUrl ?? null,
    deckId: p.deckId, deckName: p.deckName, userId: p.userId,
    life: p.life, hasPartner: p.hasPartner,
    tax: [p.cmdTax ?? 0, p.cmdTax2 ?? 0],
    dmg: mergeLegacyDmg(p.cmdDmg, p.cmdDmg2),
    counters: p.counters,
  }))

  return {
    ...createGame({
      format, customLife: startingLife, seatCount,
      layoutId: legacyLayoutId(seatCount, config.layout),
      seeds, sessionId: raw.sessionId ?? null, startedAt: raw.startedAt ?? Date.now(),
    }),
    startingLife,
  }
}

function mergeLegacyDmg(cmdDmg, cmdDmg2) {
  const out = {}
  for (const [from, v] of Object.entries(cmdDmg || {})) {
    if (v) out[from] = [Number(v) || 0, 0]
  }
  for (const [from, v] of Object.entries(cmdDmg2 || {})) {
    if (!v) continue
    out[from] = [out[from]?.[0] || 0, Number(v) || 0]
  }
  return out
}

// The old layout ids ('4-2x2', '3-row', …) split on whether any seat was rotated.
function legacyLayoutId(seatCount, layout) {
  const options = layoutsFor(seatCount)
  const rotated = Object.values(layout?.rotations || {}).some(Boolean)
  return (rotated ? options.find(l => l.kind === 'table') : options.find(l => l.kind === 'handheld'))?.id
    ?? options[0].id
}
