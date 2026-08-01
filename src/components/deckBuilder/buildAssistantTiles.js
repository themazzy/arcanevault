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

/**
 * What a grid tile should paint in its art slot.
 *
 * The display printing resolves over the network, so painting the EDHREC or
 * collection art first and swapping to it on arrival made every tile visibly
 * flip to a different printing's artwork mid-load. `resolved: false` holds a
 * skeleton until the real answer lands, so each tile paints its art exactly
 * once.
 *
 * Returns `url` as well as the state so the caller can feed the SAME value to
 * the hover preview — while pending there is no url, and the preview correctly
 * stays inert rather than enlarging art the tile isn't showing.
 *
 * `preferOwned` flips the order for a card the user owns: the copy in their
 * collection is the printing Add will actually put in the deck, so it wins over
 * the cheapest-to-buy one. It's already cached too, so such a tile never waits
 * on the lookup — it can paint on the first render.
 *
 * @returns {{ state: 'pending'|'image'|'none', url: string|null }}
 */
export function tileArt({ displayImg, sfCard, fallbackImg, resolved = true, preferOwned = false } = {}) {
  if (preferOwned) {
    const owned = cardImageUrl(sfCard)
    if (owned) return { state: 'image', url: owned }
  }
  if (!resolved) return { state: 'pending', url: null }
  const url = tileImage({ displayImg, sfCard, fallbackImg })
  return url ? { state: 'image', url } : { state: 'none', url: null }
}
