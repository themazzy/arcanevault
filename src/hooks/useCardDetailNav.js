import { useCallback, useMemo, useState } from 'react'
import { getImageUri, scryfallImageAtSize } from '../lib/scryfall'

const EMPTY_ORDER = []

/**
 * Thumbnail data for the detail modal's side rails, which show a sliver of the
 * adjacent card. Returns null for a card with no image so the rail falls back
 * to a plain arrow rather than a broken tile.
 */
export function cardPeek(card, sfCard) {
  if (!card) return null
  const image = getImageUri(sfCard, 'small')
    || scryfallImageAtSize(card.image_uri || null, 'small')
    || null
  return { name: card.name || '', image }
}

function sameOrder(a, b) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Holds the browse order a grid is actually rendering, as a list of card keys.
 *
 * Keys, not card objects: several browsers rebuild their card array on every
 * render (Lists maps a `_folderName` onto each item), so comparing objects
 * would report a "new" order every render and the reporter → setState → render
 * cycle would never settle. Primitive keys compare by value, so an unchanged
 * order returns the previous array and the render stops there.
 *
 * Returns `[order, report]` — hand `report` to `CardBrowserContent`'s
 * `onVisibleOrder`, or call it yourself from a memo for hand-rolled grids.
 */
export function useVisibleOrder() {
  const [order, setOrder] = useState(EMPTY_ORDER)
  const report = useCallback(next => {
    setOrder(prev => (sameOrder(prev, next || EMPTY_ORDER) ? prev : (next || EMPTY_ORDER)))
  }, [])
  return [order, report]
}

/**
 * Turns an ordered key list plus the open card's key into the props CardDetail
 * needs for its Prev/Next stepper. `onSelectKey` receives the key to open.
 *
 * A card that isn't in the list (a combo suggestion, a card filtered out after
 * the modal opened) yields navIndex -1, which hides the stepper rather than
 * jumping somewhere arbitrary.
 *
 * `getPeek(key)` is optional — supply it (usually `cardPeek(card, sfCard)`) to
 * give the desktop side rails their preview thumbnail. Without it the rails
 * still work, they just show a bare arrow.
 */
export function useCardDetailNav(order, currentKey, onSelectKey, getPeek = null) {
  const navIndex = useMemo(() => {
    if (currentKey == null || !order?.length) return -1
    return order.indexOf(currentKey)
  }, [order, currentKey])

  const onNavigate = useCallback(delta => {
    if (navIndex < 0) return
    const nextKey = order[navIndex + delta]
    if (nextKey != null) onSelectKey(nextKey)
  }, [order, navIndex, onSelectKey])

  const navPrev = useMemo(
    () => (navIndex > 0 && getPeek ? getPeek(order[navIndex - 1]) : null),
    [getPeek, navIndex, order]
  )
  const navNext = useMemo(
    () => (navIndex >= 0 && getPeek ? getPeek(order[navIndex + 1]) : null),
    [getPeek, navIndex, order]
  )

  return { navIndex, navTotal: order?.length || 0, onNavigate, navPrev, navNext }
}
