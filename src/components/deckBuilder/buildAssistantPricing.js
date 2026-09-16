import { fetchDeckBuilderDisplayPrintings } from '../../lib/cardSearch'
import { getCardImageUri } from '../../lib/deckBuilderApi'

// Cache key for a display-printing lookup. The price source is part of it: the
// same card resolves to a different printing (and price) per currency.
export function displayPrintingKey(priceSource, name) {
  return `${priceSource}:${(name || '').toLowerCase()}`
}

// Resolve a batch of card names to their display printing (lowest-priced
// English across foil and non-foil) and write the result into the assistant's
// name-keyed cache.
//
// Both pricing effects in BuildAssistant funnel through here, because the rule
// below is easy to get wrong in one of them and the symptom is invisible:
//
// **This never takes a cancellation flag.** The cache is name-keyed and
// idempotent, so a batch that lands after the effect that started it was
// superseded is still correct — and dropping the write strands those names as
// permanently unresolved. The tile grid waits on exactly that state
// (`gridSettled`), so the whole step sits on skeletons forever. It is easy to
// hit: the effect re-runs whenever its name set changes identity (the
// recommander merge re-ranks the pool), the superseding run sees these keys
// still in flight so it fetches nothing and returns without starting a promise
// of its own, and then the abandoned batch frees the keys without writing.
// Nothing is left to re-trigger the effect.
//
// A failed batch marks its keys failed rather than retrying forever — under a
// hard budget cap that costs slots, which the result screen reports.
export async function resolveDisplayPrintings({
  names,
  priceSource,
  inFlight,
  setCheapest,
  setFailed,
}) {
  const missing = (names || []).filter(Boolean)
  if (!missing.length) return
  const keys = missing.map(n => displayPrintingKey(priceSource, n))
  for (const k of keys) inFlight.add(k)
  try {
    const displayPrints = await fetchDeckBuilderDisplayPrintings(missing, { priceSource })
    const displayByName = new Map(displayPrints.map(card => [card.requested_name.toLowerCase(), card]))
    // Functional update: the other effect writes this same map, and a snapshot
    // taken before the await would clobber whatever it landed.
    setCheapest(prev => {
      const next = new Map(prev)
      for (const n of missing) {
        const display = displayByName.get(n.toLowerCase())
        next.set(displayPrintingKey(priceSource, n), display
          ? {
              price: display.display_price,
              image: getCardImageUri(display, 'small'),
              finish: display.display_finish,
            }
          : { price: null, image: null, finish: null })
      }
      return next
    })
  } catch {
    // Cache stays untouched so a later run can retry, but the tiles must stop
    // waiting on art that isn't coming — they fall back to what they have.
    setFailed(prev => {
      const next = new Set(prev)
      for (const k of keys) next.add(k)
      return next
    })
  } finally {
    for (const k of keys) inFlight.delete(k)
  }
}
