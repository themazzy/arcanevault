import {
  cardNameMatchKeys,
  defaultFoilForPrinting,
  normalizeCardName,
  normalizePrintKey,
} from './deckBuilderHelpers'

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

export function resolveCanonicalDeckCardName(requestedName, {
  metadata = null,
  printings = [],
} = {}) {
  const requested = String(requestedName || '').trim()
  const requestedKey = normalizeCardName(requested)
  if (!requestedKey) return ''

  for (const card of [metadata, ...(printings || [])]) {
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

export function rankOwnedPrintingCandidates(candidates, printings) {
  const { byId, byKey } = printMaps(printings)
  const resolvePrint = candidate => byId.get(candidate?.scryfall_id)
    || byKey.get(normalizePrintKey(candidate))
    || null

  return (candidates || [])
    .filter(candidate => (candidate?.binderQty || 0) > 0 || (candidate?.deckQty || 0) > 0)
    .map(candidate => {
      const placement = (candidate.binderQty || 0) > 0 ? 'binder' : 'deck'
      return {
        candidate,
        placement,
        printing: resolvePrint(candidate),
        quantity: placement === 'binder' ? candidate.binderQty : candidate.deckQty,
      }
    })
    .sort((a, b) => {
      if (a.placement !== b.placement) return a.placement === 'binder' ? -1 : 1
      const releaseDiff = releaseTimestamp(b.printing || b.candidate) - releaseTimestamp(a.printing || a.candidate)
      if (releaseDiff) return releaseDiff
      if (a.quantity !== b.quantity) return b.quantity - a.quantity
      if (!!a.candidate.foil !== !!b.candidate.foil) return Number(!!a.candidate.foil) - Number(!!b.candidate.foil)
      return stablePrintId(a.printing || a.candidate).localeCompare(stablePrintId(b.printing || b.candidate))
    })
}

export function selectPreferredDeckPrinting({
  printings = [],
  ownedCandidates = [],
  fallbackCard = null,
} = {}) {
  const orderedPrintings = [...printings].filter(Boolean).sort(compareNewest)
  const owned = rankOwnedPrintingCandidates(ownedCandidates, orderedPrintings)
    .find(entry => entry.printing)

  if (owned) {
    return {
      sfCard: owned.printing,
      foil: !!owned.candidate.foil,
      cardPrintId: owned.candidate.card_print_id || null,
      source: owned.placement === 'binder' ? 'owned-binder' : 'owned-deck',
    }
  }

  const automatic = orderedPrintings.find(printing => printing.lang === 'en')
    || (fallbackCard?.lang === 'en' ? fallbackCard : null)
    || fallbackCard
    || orderedPrintings[0]
    || null

  return automatic ? {
    sfCard: automatic,
    foil: defaultFoilForPrinting(automatic),
    cardPrintId: null,
    source: 'automatic',
  } : null
}
