// Image resolution for the Build Assistant's card tiles.
//
// Split out of BuildAssistant.jsx so it can be unit-tested without pulling the
// wizard's whole data layer in — the same reason SpecificCardSearch lives in
// its own module.

import { getCardImageUri } from '../../lib/deckBuilderApi'

// Card image from the cached Scryfall art (cards.scryfall.io CDN). We never hit
// api.scryfall.com per tile — that endpoint is rate-limited and floods to 429.
// Falls back to the 'normal' size because card_prints-derived entries only store
// `normal` + `art_crop` (no `small`), which otherwise left owned tiles blank.
export function cardImageUrl(sfCard) {
  if (!sfCard) return null
  return getCardImageUri(sfCard, 'small') || getCardImageUri(sfCard, 'normal')
}

// The one resolution order for a tile's art: the resolved display printing
// first, then cached collection art, then a Scryfall/EDHREC fallback for
// unowned upgrades and owned cards whose cache entry has no image. These
// sources don't agree on a tier (card_prints rows carry only `normal`, cached
// entries carry `small`), so CardImg forces one — a grid of mixed tiers renders
// as a patchwork of resolutions.
//
// Call sites feed the result to BOTH the tile and previewHandlers, so the
// enlarged card is always the same printing the tile painted. Keeping that in
// one place is the point: when the two were resolved separately they drifted,
// and hovering an owned card whose cheapest English printing differed from the
// copy in the collection enlarged a different printing than the grid showed.
export function tileImage({ displayImg, sfCard, fallbackImg } = {}) {
  return displayImg || cardImageUrl(sfCard) || fallbackImg || null
}
