// Pure helper for LifeTracker.onLifeChange. Returns the log entry payload and
// the resolved new life for a player, or null when the id is stale.
// Extracted so the stale-player guard can be unit-tested without mounting
// the full LifeTracker component.
export function buildLifeChange(players, id, delta) {
  const player = (players || []).find(p => p.id === id)
  if (!player) return null
  const nextLife = player.life + delta
  return {
    nextLife,
    logEntry: {
      type: 'life',
      delta,
      total: nextLife,
      playerName: player.name,
      playerColor: player.color,
    },
  }
}
