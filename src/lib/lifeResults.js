// End-of-game persistence payloads for the life tracker.
//
// ⚠ This module is a contract, not an implementation detail. `game_results` rows
// are read by four other surfaces:
//   - src/pages/Stats.jsx           History tab + Win Rates tab
//   - src/lib/playgroupStats.js     leaderboard, over players_json[].{name,color,placement}
//   - src/components/deckBuilder/DeckWinrateMini.jsx   win = placement === 1
//   - src/pages/Profile.jsx         overall W/L and featured-deck W/L bento tiles
//
// The invariants they depend on:
//   1. placement 1 means a win. Nothing else does.
//   2. players_json is an ARRAY of objects carrying at least
//      { name, color, deckName, placement }.
//   3. One row per participating user per game, with deck_id, format,
//      player_count, played_at and user_id populated.
// Break any of these and those surfaces go silently empty rather than erroring.

/**
 * Turn a finishing order into a placement map.
 *
 * Players are tapped in the order they finished, winner first. Anyone not tapped
 * shares the next place — at a real table the last two players rarely have a
 * meaningful order, and forcing one produces made-up data.
 *
 * @param {Array<{id:number}>} players
 * @param {number[]} orderedIds seat ids in finishing order
 * @returns {Record<number, number>} seat id → placement (1-based)
 */
export function buildPlacements(players, orderedIds) {
  const placements = {}
  const seen = []
  for (const id of orderedIds || []) {
    if (players.some(p => p.id === id) && !seen.includes(id)) seen.push(id)
  }
  seen.forEach((id, i) => { placements[id] = i + 1 })
  const restPlace = seen.length + 1
  for (const p of players) {
    if (placements[p.id] == null) placements[p.id] = restPlace
  }
  return placements
}

/**
 * The players_json blob. Shared verbatim by tracked_games and every game_results
 * row so the whole table is reconstructable from any single row.
 */
export function serializeGamePlayers(players, placements) {
  return players.map(p => ({
    playerId: p.id,
    userId: p.userId || null,
    name: p.name,
    color: p.color,
    deckId: p.deckId || null,
    deckName: p.deckName || null,
    placement: placements[p.id] ?? null,
    finalLife: p.life,
  }))
}

const NO_DECK = 'No deck selected'

function hasDeck(player) {
  return !!(player.deckId || (player.deckName && player.deckName !== NO_DECK))
}

/**
 * Which seats get a game_results row.
 *
 * Shared games: every seat a real account claimed, so each guest's deck gets the
 * result on their own account — that is the entire reason the lobby exists.
 * Local games: seats with a deck attached, falling back to the first seat so a
 * quick untracked game still records something for the host.
 */
export function selectResultPlayers(players, { isShared }) {
  if (isShared) return players.filter(p => p.userId)
  const withDecks = players.filter(hasDeck)
  return withDecks.length > 0 ? withDecks : players.slice(0, 1)
}

/**
 * @param {object} args
 * @param {object} args.game     the reducer game state
 * @param {Record<number,number>} args.placements
 * @param {string} args.hostUserId
 * @param {number} args.endedAt
 */
export function buildTrackedGamePayload({ game, placements, hostUserId, endedAt }) {
  const startedAt = game.startedAt || endedAt
  return {
    source_session_id: game.sessionId || null,
    host_user_id: hostUserId,
    mode: game.format,
    custom_life: game.format === 'custom' ? game.startingLife : null,
    player_count: game.players.length,
    is_shared: !!game.sessionId,
    players_json: serializeGamePlayers(game.players, placements),
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
  }
}

/**
 * @param {object} args
 * @param {object} args.game
 * @param {Record<number,number>} args.placements
 * @param {string} args.hostUserId
 * @param {number} args.endedAt
 * @param {string} args.notes
 * @param {string|number} [args.trackedGameId]
 */
export function buildGameResultRows({ game, placements, hostUserId, endedAt, notes = '', trackedGameId = null }) {
  const isShared = !!game.sessionId
  const startedAtIso = new Date(game.startedAt || endedAt).toISOString()
  const endedAtIso = new Date(endedAt).toISOString()
  const playersJson = serializeGamePlayers(game.players, placements)
  const trimmedNotes = (notes || '').trim()

  return selectResultPlayers(game.players, { isShared }).map(p => {
    // In a shared game the note was typed by the host about the game; attaching
    // it to a guest's row would put someone else's words on their record.
    const ownsNotes = isShared ? p.userId === hostUserId : true
    const row = {
      session_id: game.sessionId || null,
      user_id: isShared ? p.userId : hostUserId,
      deck_id: p.deckId || null,
      deck_name: p.deckName || NO_DECK,
      format: game.format,
      player_count: game.players.length,
      placement: placements[p.id] ?? null,
      played_at: endedAtIso,
      player_name: p.name,
      player_color: p.color,
      final_life: p.life,
      game_started_at: startedAtIso,
      game_ended_at: endedAtIso,
      players_json: playersJson,
      notes: ownsNotes ? trimmedNotes : '',
    }
    if (trackedGameId != null) row.game_id = trackedGameId
    return row
  })
}

/**
 * Aggregate a user's own game_results rows into per-deck W/L, for the deck picker
 * badge. Rows only need { deck_id, placement }.
 */
export function buildDeckStatsMap(rows) {
  const map = {}
  for (const row of rows || []) {
    if (!row.deck_id) continue
    if (!map[row.deck_id]) map[row.deck_id] = { wins: 0, losses: 0, games: 0, win_pct: 0 }
    const stat = map[row.deck_id]
    stat.games++
    if (Number(row.placement) === 1) stat.wins++
    else stat.losses++
  }
  for (const stat of Object.values(map)) {
    stat.win_pct = stat.games > 0 ? Math.round((100 * stat.wins) / stat.games) : 0
  }
  return map
}
