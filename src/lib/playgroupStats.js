// Pure aggregations for the playgroup stats view (Stats → Win Rates tab).
// Operates on sanitized game_results rows: each row is one game from the
// recording user's perspective (row.placement / row.player_name = "you"),
// with row.players_json = [{ name, color, placement, deckName }] for the
// full table.

function norm(name) {
  return String(name || '').trim()
}

/**
 * Per-player leaderboard aggregated across every game's players_json.
 * A player "plays" a game if they appear in its standings; a "win" is
 * placement === 1. Returns rows sorted by win rate, then games, then name.
 * @returns {Array<{name, color, games, wins, winRate}>}
 */
export function computePlaygroupLeaderboard(rows) {
  const byName = new Map()
  for (const row of rows || []) {
    const players = Array.isArray(row?.players_json) ? row.players_json : []
    const seen = new Set() // guard against a name listed twice in one game
    for (const p of players) {
      const name = norm(p?.name)
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      if (!byName.has(name)) byName.set(name, { name, color: p?.color || null, games: 0, wins: 0 })
      const agg = byName.get(name)
      agg.games += 1
      if (Number(p?.placement) === 1) agg.wins += 1
      if (!agg.color && p?.color) agg.color = p.color
    }
  }
  return [...byName.values()]
    .map(a => ({ ...a, winRate: a.games > 0 ? (a.wins / a.games) * 100 : 0 }))
    .sort((a, b) => b.winRate - a.winRate || b.games - a.games || a.name.localeCompare(b.name))
}

/**
 * The recording user's win streaks, from their own placement per game.
 * current = trailing run of wins up to the most recent game; longest = max
 * run anywhere. A game counts only if it has a numeric placement.
 * @returns {{ current: number, longest: number, lastResult: 'win'|'loss'|null }}
 */
export function computeOwnerStreaks(rows) {
  const games = (rows || [])
    .filter(r => r?.placement != null && Number.isFinite(Number(r.placement)))
    .slice()
    .sort((a, b) => new Date(a.played_at || 0) - new Date(b.played_at || 0))
  if (!games.length) return { current: 0, longest: 0, lastResult: null }

  let longest = 0
  let run = 0
  for (const g of games) {
    if (Number(g.placement) === 1) { run += 1; longest = Math.max(longest, run) }
    else run = 0
  }
  // current = trailing run (run already reflects the tail after the loop)
  const lastWin = Number(games[games.length - 1].placement) === 1
  return { current: run, longest, lastResult: lastWin ? 'win' : 'loss' }
}
