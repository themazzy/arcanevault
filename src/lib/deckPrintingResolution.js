import {
  cardNameMatchKeys,
  defaultFoilForPrinting,
  normalizeCardName,
  normalizePrintKey,
  printingSupportsFoil,
  printingSupportsNonfoil,
} from './deckBuilderHelpers'
import { getPrice } from './scryfall'

function releaseTimestamp(card) {
  const value = Date.parse(card?.released_at || '')
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

function stablePrintId(card) {
  return String(card?.id || card?.scryfall_id || normalizePrintKey(card) || '')
}

function compareNewest(a, b) {
  const releaseDiff = releaseTimestamp(b) - releaseTimestamp(a)
  if (releaseDiff) return releaseDiff
  return stablePrintId(a).localeCompare(stablePrintId(b))
}

// Build Assistant chooses card names, never printings. Strip any incidental
// search/recommendation/owned-card identity before the request reaches a write
// path so every assistant add must run through the same automatic resolver.
export function toAutomaticDeckPrintingRequest(cardOrName) {
  const name = String(typeof cardOrName === 'string' ? cardOrName : cardOrName?.name || '').trim()
  return name ? { name } : null
}

export function toAutomaticDeckPrintingRequests(items) {
  return (items || []).map(toAutomaticDeckPrintingRequest).filter(Boolean)
}

/**
 * Art-series cards, tokens and emblems sit in `card_prints` next to real
 * printings and collide with real card names two ways: an Art Series
 * double-faced row is named "<Card> // <Card>" and aliases to the front face
 * (so it can win canonicalization outright), and a single-faced art card uses
 * the card's exact name (99 names currently collide).
 *
 * Type line is an exact discriminator — every 'Card' / 'Card // Card' row in
 * the catalogue is from an Art Series set, and no real card's type line starts
 * with "Token" or "Emblem". Mirrors `is_nonplayable_print_type()` in Postgres.
 *
 * Digital-only printings (Magic Online, Arena, Alchemy) are excluded for the
 * same reason: they carry no market price, so cheapest-first can never pick one,
 * but the unpriced fallback sorts by release date and would happily return an
 * MTGO promo you cannot buy in paper.
 *
 * Null-safe: ~158 rows have no type_line, and unknown is not evidence of an art
 * card, so they stay eligible.
 */
export function isPlayablePrinting(printing) {
  if (printing?.digital === true) return false
  const typeLine = printing?.type_line
  if (typeLine == null) return true
  const value = String(typeLine).trim()
  return value !== 'Card'
    && value !== 'Card // Card'
    && !value.startsWith('Token')
    && !value.startsWith('Emblem')
}

export function resolveCanonicalDeckCardName(requestedName, {
  metadata = null,
  printings = [],
} = {}) {
  const requested = String(requestedName || '').trim()
  const requestedKey = normalizeCardName(requested)
  if (!requestedKey) return ''

  // An Art Series "Birgi // Birgi" row aliases to "Birgi" exactly like the real
  // "Birgi // Harnfel" card does, so an unfiltered scan can canonicalize onto
  // the art card and strand every later lookup on a name only it has.
  for (const card of [metadata, ...(printings || [])].filter(c => !c || isPlayablePrinting(c))) {
    const canonical = String(card?.name || '').trim()
    if (!canonical) continue
    const aliases = new Set([
      ...cardNameMatchKeys(canonical),
      ...(card?.card_faces || []).map(face => normalizeCardName(face?.name)).filter(Boolean),
    ])
    if (aliases.has(requestedKey)) return canonical
  }
  return requested
}

function printMaps(printings) {
  const byId = new Map()
  const byKey = new Map()
  for (const printing of printings || []) {
    if (printing?.id) byId.set(printing.id, printing)
    const key = normalizePrintKey(printing)
    if (key && !byKey.has(key)) byKey.set(key, printing)
  }
  return { byId, byKey }
}

export function printingForOwnedCandidate(candidate, printings) {
  const { byId, byKey } = printMaps(printings)
  return byId.get(candidate?.scryfall_id)
    || byKey.get(normalizePrintKey(candidate))
    || null
}

/**
 * Ranked owned copies: binders before collection decks, cheapest first inside
 * each group.
 *
 * Placement outranks price because it is an availability rule, not a
 * preference — a collection-deck copy is already committed to another deck, so
 * it is only reached once the binders are out of copies.
 *
 * Unlike the unowned search there is no cross-finish comparison: an owned copy
 * is a physical card whose finish is a fact, so it is priced at its own finish.
 * Copies we can't price (no card_prices row, or no resolvable printing) sort
 * behind priced ones and keep the previous newest-first order among themselves.
 */
export function rankOwnedPrintingCandidates(candidates, printings, priceSource) {
  const { byId, byKey } = printMaps(printings)
  const resolvePrint = candidate => byId.get(candidate?.scryfall_id)
    || byKey.get(normalizePrintKey(candidate))
    || null

  return (candidates || [])
    .filter(candidate => (candidate?.binderQty || 0) > 0 || (candidate?.deckQty || 0) > 0)
    .map(candidate => {
      const placement = (candidate.binderQty || 0) > 0 ? 'binder' : 'deck'
      const printing = resolvePrint(candidate)
      return {
        candidate,
        placement,
        printing,
        price: printing
          ? getPrice(printing, !!candidate.foil, { price_source: priceSource })
          : null,
        quantity: placement === 'binder' ? candidate.binderQty : candidate.deckQty,
      }
    })
    .sort((a, b) => {
      if (a.placement !== b.placement) return a.placement === 'binder' ? -1 : 1
      if (a.price != null && b.price != null) {
        if (a.price !== b.price) return a.price - b.price
      } else if (a.price != null || b.price != null) {
        return a.price != null ? -1 : 1
      }
      const releaseDiff = releaseTimestamp(b.printing || b.candidate) - releaseTimestamp(a.printing || a.candidate)
      if (releaseDiff) return releaseDiff
      if (a.quantity !== b.quantity) return b.quantity - a.quantity
      if (!!a.candidate.foil !== !!b.candidate.foil) return Number(!!a.candidate.foil) - Number(!!b.candidate.foil)
      return stablePrintId(a.printing || a.candidate).localeCompare(stablePrintId(b.printing || b.candidate))
    })
}

// Two different questions, deliberately answered differently:
//
// For PRICING, a null lang counts as English — card_prints rows come back from
// the English-filtered query as `lang.eq.en,lang.is.null`, so an absent lang
// there means "English, not recorded", and excluding those rows would hide real
// printings from the cheapest-copy search.
//
// For IDENTITY (which card object represents the card when nothing is priced),
// null stays "unknown": a recommendation-metadata fallback that is *known* to be
// English is the better pick than a catalog row that merely might be.
function isEnglishForPricing(printing) {
  return !printing?.lang || printing.lang === 'en'
}

function isKnownEnglish(printing) {
  return printing?.lang === 'en'
}

// Non-foil first so it wins a price tie within the same printing.
const FINISH_CANDIDATES = [
  { foil: false, supported: printingSupportsNonfoil },
  { foil: true, supported: printingSupportsFoil },
]

/**
 * Cheapest *actually priced* printing across both finishes, in the user's
 * selected price source only. No cross-source fallback: prices live in our own
 * `card_prices` table as separate EUR and USD columns, and a min() that mixed
 * them would compare €1.20 against $1.50 and call the second one cheaper.
 *
 * Prices are best-effort (attachSharedPrices swallows its own failures), so an
 * unpriced card — or a whole price outage — simply returns null and lets the
 * caller fall back to the newest printing.
 *
 * `printings` must already be sorted newest-first: ties are resolved by the
 * first entry seen, which makes the newest printing win.
 */
export function cheapestPricedPrinting(printings, priceSource) {
  let best = null
  for (const printing of printings || []) {
    for (const finish of FINISH_CANDIDATES) {
      if (!finish.supported(printing)) continue
      const price = getPrice(printing, finish.foil, { price_source: priceSource })
      if (!(price > 0)) continue
      // Strict <: an equal price keeps the incumbent, so the newest printing
      // (and, within one printing, the non-foil finish) survives a tie.
      if (!best || price < best.price) best = { printing, foil: finish.foil, price }
    }
  }
  return best
}

export function selectPreferredDeckPrinting({
  printings = [],
  ownedCandidates = [],
  fallbackCard = null,
  priceSource = 'cardmarket_trend',
} = {}) {
  const orderedPrintings = [...printings].filter(Boolean).sort(compareNewest)
  const owned = rankOwnedPrintingCandidates(ownedCandidates, orderedPrintings, priceSource)
    .find(entry => entry.printing)

  if (owned) {
    return {
      sfCard: owned.printing,
      foil: !!owned.candidate.foil,
      cardPrintId: owned.candidate.card_print_id || null,
      source: owned.placement === 'binder' ? 'owned-binder' : 'owned-deck',
    }
  }

  // Unowned: buy the cheapest copy we can actually quote a price for. Restrict
  // to English unless the card has no English printing at all — the cheapest
  // print of a staple is frequently a foreign one, and silently putting a
  // Japanese card in a decklist (and on the buy list) is not what "cheapest"
  // is meant to deliver.
  //
  // Art cards and digital-only prints are dropped here rather than from
  // `orderedPrintings` above, so an owned one still hydrates its placement — a
  // collector can own an art card, but nothing should ever auto-pick one.
  //
  // Falls back to the unfiltered list when the filter empties it: an
  // Arena-exclusive card has no paper printing to prefer, and refusing to
  // resolve it at all would be worse than naming the only printing there is.
  const filtered = orderedPrintings.filter(isPlayablePrinting)
  const playable = filtered.length ? filtered : orderedPrintings
  const pricedEnglish = playable.filter(isEnglishForPricing)
  const pricePool = pricedEnglish.length ? pricedEnglish : playable
  const cheapest = cheapestPricedPrinting(pricePool, priceSource)
  if (cheapest) {
    return {
      sfCard: cheapest.printing,
      foil: cheapest.foil,
      cardPrintId: null,
      source: 'automatic-cheapest',
    }
  }

  // Nothing in the pool has a price — fall back to the newest printing. Walks
  // the playable list, not the raw one: an unpriced card whose only art-series
  // row is newer would otherwise land right back on the art card.
  const automatic = playable.find(isKnownEnglish)
    || (fallbackCard?.lang === 'en' ? fallbackCard : null)
    || fallbackCard
    || playable[0]
    || null

  return automatic ? {
    sfCard: automatic,
    foil: defaultFoilForPrinting(automatic),
    cardPrintId: null,
    source: 'automatic',
  } : null
}
