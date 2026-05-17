// Per-card contribution to the Stats 24h-change figure.
//
// We deliberately skip any card that currently has a manual price override:
// the user picked that price themselves, so the today-vs-yesterday "market
// move" doesn't apply to it.
//
// Known limitation: manual prices live in localStorage and have no history.
// If you set a manual price yesterday and clear it today, the card flips back
// into dayChange and you'll see a one-day phantom delta equal to
// (auto_today - auto_yesterday) — the auto price the snapshot remembers,
// not the manual one you actually had displayed yesterday. A real fix would
// require persisting a per-day manual_price snapshot; until then, accept the
// one-day phantom after clearing an override.
export function cardDayChange({ price, prevPrice, qty, hasManualPrice }) {
  if (hasManualPrice) return 0
  if (price == null || prevPrice == null) return 0
  return (price - prevPrice) * (qty || 0)
}
