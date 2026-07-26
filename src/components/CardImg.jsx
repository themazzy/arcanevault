import { useState } from 'react'
import { resolveTileImage } from '../lib/scryfall'
import { useDevicePixelRatio } from '../hooks/useDevicePixelRatio'

// The one path every card image in the app resolves through: pick the Scryfall
// tier the element's *device* pixels actually need, prefer the WebP `grid`
// variant where one exists, and degrade to the JPEG if that undocumented tier
// 404s. See resolveTileImage/pickImageTier in lib/scryfall.js for the why.
//
// `width` is the CSS width the image renders at — not its intrinsic size, and
// not the wrapper's; the browser scales to device pixels, so this has to be the
// real painted width or the tier is wrong on retina/mobile.
//
// `forceTier` pins the tier instead of deriving it — for elements whose painted
// width lives in CSS and can't be measured here. Prefer passing a real `width`:
// tiles in one grid share a width and a pixel ratio, so they land on the same
// tier anyway, and a pinned tier can only be wrong on someone's display.
export default function CardImg({ url, width = 0, forceTier = null, alt = '', ...rest }) {
  const dpr = useDevicePixelRatio()
  // Keyed by the URL that failed rather than a boolean: preview elements keep a
  // single instance across many different cards, and a boolean would strand one
  // on the fallback tier for every card shown after the first 404.
  const [failedSrc, setFailedSrc] = useState(null)
  const { src, fallback } = resolveTileImage(url, width, dpr, forceTier)
  if (!src) return null
  const usingFallback = Boolean(fallback) && failedSrc === src
  return (
    <img
      src={usingFallback ? fallback : src}
      alt={alt}
      onError={fallback && !usingFallback ? () => setFailedSrc(src) : undefined}
      {...rest}
    />
  )
}
