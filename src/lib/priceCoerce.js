// Resolve a card's price for filtering/sorting:
//   1. Use the strict shared-price lookup when available.
//   2. Otherwise fall back to the user's recorded purchase_price, but only
//      when it parses to a finite number — otherwise return `fallbackEmpty`.
//
// History: this guard exists because `parseFloat('')` and `parseFloat(undefined)`
// return NaN (not null), so the previous `?? null` chain leaked NaN into the
// range filter (NaN compares false in both directions, surviving min/max
// checks) and into sort comparators (NaN-NaN is NaN, producing non-deterministic
// orderings per V8).
export function coercePriceWithFallback(strict, purchasePriceRaw, fallbackEmpty = null) {
  if (strict != null) return strict
  if (purchasePriceRaw == null || purchasePriceRaw === '') return fallbackEmpty
  const n = parseFloat(purchasePriceRaw)
  return Number.isFinite(n) ? n : fallbackEmpty
}
