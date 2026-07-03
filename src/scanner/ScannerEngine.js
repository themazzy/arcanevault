/**
 * ScannerEngine — card detection / warp / hash pipeline
 *
 * Pure JS on typed arrays (visionCore + hashCore) — the vendored OpenCV.js
 * build (~10 MB download + WASM compile at startup) is gone. No DOM and no
 * canvas: every function takes and returns plain ImageData-shaped objects
 * ({ data, width, height }), so the whole pipeline runs identically on the
 * main thread, inside visionWorker, and under Node (tests).
 *
 * Detection strategy (unchanged from the OpenCV version, same tuning):
 *   Pass 1: adaptive Canny (thresholds from the median of the blurred frame)
 *   Pass 2: fixed lo=5/hi=40 + 3×3 blur — faint dark-card borders
 *   Pass 3: CLAHE(2.0, 8×8) contrast boost + pass-2 thresholds — dark card
 *           on dark background
 */

import {
  CARD_W,
  CARD_H,
  ART_H as SHARED_ART_H,
  ART_W as SHARED_ART_W,
  ART_X as SHARED_ART_X,
  ART_Y as SHARED_ART_Y,
} from './constants.js'
import {
  computeHashFromGray, computeHashFromGrayGlare, computeHashFromGrayDark,
  rgbToGray32x32, rgbToSaturation32x32, hashToHex as _hashToHex, applyCLAHE,
} from './hashCore.js'
import {
  rgbaToGrayU8, rgbaToChromaU8, gaussianBlurGray, canny, dilate3,
  findExternalContours, contourArea, arcLength, approxPolyDP, minAreaRectPoints,
  perspectiveTransform, warpPerspectiveRGBA, bilinearCropResize, areaResizeRGBA,
  rotate180RGBA, grayMedian,
} from './visionCore.js'

// ── Quad scoring ─────────────────────────────────────────────────────────────

function orderPoints(pts) {
  // Angle-based ordering: sort corners by their angle from centroid so
  // axis-aligned cards (where quadrant filtering puts two corners in one bucket)
  // are handled correctly. Angles: TL ≈ -3π/4, TR ≈ -π/4, BR ≈ π/4, BL ≈ 3π/4.
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4
  const sorted = pts.slice().sort((a, b) =>
    Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  )
  // atan2 order starting from ~-π: left-top, right-top, right-bottom, left-bottom
  // Rotate so TL is first: find the index of the top-left (min x+y sum)
  const tlIdx = sorted.reduce((mi, p, i, a) =>
    (p.x + p.y) < (a[mi].x + a[mi].y) ? i : mi, 0)
  const reordered = []
  for (let i = 0; i < 4; i++) reordered.push(sorted[(tlIdx + i) % 4])
  return reordered  // [TL, TR, BR, BL]
}

function polygonArea(pts) {
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    area += a.x * b.y - b.x * a.y
  }
  return Math.abs(area) / 2
}

function quadMetrics(pts) {
  const ordered = orderPoints(pts)
  const topW = Math.hypot(ordered[1].x - ordered[0].x, ordered[1].y - ordered[0].y)
  const botW = Math.hypot(ordered[2].x - ordered[3].x, ordered[2].y - ordered[3].y)
  const leftH = Math.hypot(ordered[3].x - ordered[0].x, ordered[3].y - ordered[0].y)
  const rightH = Math.hypot(ordered[2].x - ordered[1].x, ordered[2].y - ordered[1].y)
  const avgW = (topW + botW) / 2
  const avgH = (leftH + rightH) / 2
  const ratio = Math.min(avgW, avgH) / Math.max(avgW, avgH)
  const polyArea = polygonArea(ordered)
  const boundsW = Math.max(...ordered.map(p => p.x)) - Math.min(...ordered.map(p => p.x))
  const boundsH = Math.max(...ordered.map(p => p.y)) - Math.min(...ordered.map(p => p.y))
  const extent = polyArea / Math.max(1, boundsW * boundsH)
  const edgeBalance = Math.min(topW, botW) / Math.max(1, Math.max(topW, botW))
  const sideBalance = Math.min(leftH, rightH) / Math.max(1, Math.max(leftH, rightH))
  return { ordered, ratio, polyArea, extent, edgeBalance, sideBalance }
}

function scoreQuadCandidate(pts, minArea) {
  if (!pts || pts.length !== 4) return null
  const metrics = quadMetrics(pts)
  if (!Number.isFinite(metrics.ratio) || metrics.polyArea < minArea) return null
  if (metrics.ratio < 0.55 || metrics.ratio > 0.84) return null
  if (metrics.extent < 0.58) return null

  const ratioScore = 1 - Math.min(1, Math.abs(metrics.ratio - 0.716) / 0.12)
  const areaScore = Math.min(1, metrics.polyArea / (minArea * 4))
  const shapeScore = (metrics.extent + metrics.edgeBalance + metrics.sideBalance) / 3
  const score = areaScore * 0.45 + ratioScore * 0.35 + shapeScore * 0.2

  return { pts: metrics.ordered, score, area: metrics.polyArea }
}

function flatToPoints(flat) {
  const pts = []
  for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] })
  return pts
}

// ── Card quad detection ──────────────────────────────────────────────────────

// Find a card quad from a grayscale buffer using Canny + contour scoring.
// cannyLo/cannyHi: pass explicit values to override adaptive thresholds (used for dark-card retry).
// blurSize: kernel side length for pre-Canny Gaussian blur. Use 3 for faint dark-border edges.
function findBestQuad(gray, width, height, cannyLo = -1, cannyHi = -1, blurSize = 5) {
  const blurred = gaussianBlurGray(gray, width, height, blurSize)

  let lo, hi
  if (cannyLo >= 0 && cannyHi >= 0) {
    lo = cannyLo; hi = cannyHi
  } else {
    // Tighter ratio keeps Pass 1 distinct from Pass 2 across all lighting conditions.
    // On bright backgrounds median*1.5 → hi≈225 which misses faint dark-card borders.
    const median = grayMedian(blurred)
    lo = Math.max(5,  Math.round(median * 0.33))
    hi = Math.max(60, Math.min(220, Math.round(median * 1.33)))
  }

  const edges = canny(blurred, width, height, lo, hi)
  const dilated = dilate3(edges, width, height)
  const contours = findExternalContours(dilated, width, height)

  const minArea = width * height * 0.05
  let bestCandidate = null

  for (const cnt of contours) {
    if (contourArea(cnt) < minArea) continue

    const peri = arcLength(cnt)
    let candidate = null

    for (const epsilonFactor of [0.02, 0.035, 0.05]) {
      const approx = approxPolyDP(cnt, epsilonFactor * peri)
      if (approx.length !== 8) continue
      const scored = scoreQuadCandidate(flatToPoints(approx), minArea)
      if (scored && (!candidate || scored.score > candidate.score)) {
        candidate = scored
      }
    }

    if (!candidate) {
      const rectPts = minAreaRectPoints(cnt)
      const scored = scoreQuadCandidate(rectPts, minArea)
      if (scored) candidate = scored
    }

    if (candidate && (!bestCandidate || candidate.score > bestCandidate.score)) {
      bestCandidate = candidate
    }
  }

  return bestCandidate?.pts ?? null
}

// detectCardCorners expects a pre-downscaled frame (caller uses GPU canvas.drawImage
// to halve the frame before passing here). Returns corners in frame coordinates —
// caller must scale back to full-frame coords.
// maxPasses 1 = adaptive-Canny only: the cheap probe the continuous auto-scan
// loop runs between full scans.
export function detectCardCorners(imageData, width, height, { maxPasses = 4 } = {}) {
  const gray = rgbaToGrayU8(imageData.data, width, height)

  // Pass 1: adaptive Canny
  const result = findBestQuad(gray, width, height)
  if (result || maxPasses < 2) return result

  // Pass 2: dark-card / low-contrast — fixed low thresholds + smaller blur.
  // 3×3 kernel preserves the faint border gradient that 5×5 smears below threshold.
  const darkResult = findBestQuad(gray, width, height, 5, 40, 3)
  if (darkResult || maxPasses < 3) return darkResult

  // Pass 3: local CLAHE contrast enhancement — better than global equalization for
  // dark-card-on-dark-background scenes where the border blends into the bg.
  const enhanced = applyCLAHE(gray, width, height, 8, 8, 2.0)
  const claheResult = findBestQuad(enhanced, width, height, 5, 40, 3)
  if (claheResult || maxPasses < 4) return claheResult

  // Pass 4: chroma gradient — a neutral black border on an equally-dark but
  // COLORED surface (wood, red playmat) has zero luminance edge; the card
  // boundary still exists as a color difference. Neutral-on-neutral
  // (black card on black cloth) remains undetectable by any channel.
  const chroma = rgbaToChromaU8(imageData.data, width, height)
  return findBestQuad(chroma, width, height, 5, 30, 3)
}

/**
 * Cheap usability check for an art crop: rejects black/blown-out or nearly
 * featureless crops before hashing. Sampled on a ~64×64 grid.
 */
export function isUsableArtCrop(artCrop) {
  if (!artCrop?.data?.length) return false
  const { data, width, height } = artCrop
  const stepX = Math.max(1, Math.floor(width / 64))
  const stepY = Math.max(1, Math.floor(height / 64))
  let count = 0
  let sum = 0
  let edge = 0
  for (let y = stepY; y < height; y += stepY) {
    for (let x = stepX; x < width; x += stepX) {
      const idx = (y * width + x) * 4
      const left = (y * width + x - stepX) * 4
      const up = ((y - stepY) * width + x) * 4
      const g = 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]
      const gl = 0.2126 * data[left] + 0.7152 * data[left + 1] + 0.0722 * data[left + 2]
      const gu = 0.2126 * data[up] + 0.7152 * data[up + 1] + 0.0722 * data[up + 2]
      sum += g
      edge += Math.abs(g - gl) + Math.abs(g - gu)
      count++
    }
  }
  if (!count) return false
  const mean = sum / count
  const edgeEnergy = edge / (count * 2)
  return mean > 8 && mean < 248 && edgeEnergy > 1.2
}

// ── Crops and warps (all return { data, width, height }) ─────────────────────

// source: { data, width, height } full camera frame.
export function cropCardFromReticle(
  source,
  frameWidth,
  frameHeight,
  viewportWidth,
  viewportHeight,
  {
    reticleWidth = 280,
    reticleHeight = 392,
    centerYOffsetPx = -8,
    inset = 0,
  } = {},
) {
  const cropWidth = Math.max(80, reticleWidth - inset * 2)
  const cropHeight = Math.max(120, reticleHeight - inset * 2)
  const scale = Math.max(viewportWidth / frameWidth, viewportHeight / frameHeight)
  const displayedWidth = frameWidth * scale
  const displayedHeight = frameHeight * scale
  const overflowX = Math.max(0, (displayedWidth - viewportWidth) / 2)
  const overflowY = Math.max(0, (displayedHeight - viewportHeight) / 2)
  const viewportLeft = (viewportWidth - cropWidth) / 2
  const viewportTop = (viewportHeight - cropHeight) / 2 + centerYOffsetPx
  const sourceX = Math.max(0, Math.min(frameWidth - 1, (viewportLeft + overflowX) / scale))
  const sourceY = Math.max(0, Math.min(frameHeight - 1, (viewportTop + overflowY) / scale))
  const sourceW = Math.max(40, Math.min(frameWidth - sourceX, cropWidth / scale))
  const sourceH = Math.max(56, Math.min(frameHeight - sourceY, cropHeight / scale))

  const data = bilinearCropResize(
    source.data, frameWidth, frameHeight,
    sourceX, sourceY, sourceW, sourceH,
    CARD_W, CARD_H,
  )
  return { data, width: CARD_W, height: CARD_H }
}

export function warpCard(imageData, corners) {
  if (!corners || corners.length !== 4) return null
  const data = warpPerspectiveRGBA(
    imageData.data, imageData.width, imageData.height,
    corners, CARD_W, CARD_H,
  )
  if (!data) return null
  return { data, width: CARD_W, height: CARD_H }
}

export function cropArtRegion(cardImageData, { xOffset = 0, yOffset = 0, inset = 0 } = {}) {
  const width = Math.max(40, Math.min(CARD_W, SHARED_ART_W - inset * 2))
  const height = Math.max(40, Math.min(CARD_H, SHARED_ART_H - inset * 2))
  const baseX = SHARED_ART_X + Math.round((SHARED_ART_W - width) / 2)
  const baseY = SHARED_ART_Y + Math.round((SHARED_ART_H - height) / 2)
  const x = Math.max(0, Math.min(CARD_W - width, baseX + xOffset))
  const y = Math.max(0, Math.min(CARD_H - height, baseY + yOffset))
  const data = bilinearCropResize(
    cardImageData.data, CARD_W, CARD_H,
    x, y, width, height,
    SHARED_ART_W, SHARED_ART_H,
  )
  return { data, width: SHARED_ART_W, height: SHARED_ART_H }
}

export function rotateCard180(imageData) {
  return {
    data: rotate180RGBA(imageData.data),
    width: imageData.width,
    height: imageData.height,
  }
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Area-average resize to 32×32 (INTER_AREA equivalent) — no pre-blur
 * (area averaging low-passes inherently for large downscales).
 * Returns the raw RGBA byte array (length 4096). Called once per art crop;
 * all four hash variants reuse the result.
 */
function resizeArtTo32(artImageData) {
  return areaResizeRGBA(artImageData.data, artImageData.width, artImageData.height, 32, 32)
}

export function computePHash256(artImageData) {
  const rgba = resizeArtTo32(artImageData)
  return computeHashFromGray(rgbToGray32x32(rgba, 4))
}

/**
 * Variant of computePHash256 with aggressive glare suppression (percentileCap 0.92).
 * Used as a client-side fallback when the standard hash scores poorly on a given frame,
 * typically caused by foil specular reflections. Does not affect stored DB hashes.
 */
export function computePHash256Foil(artImageData) {
  const rgba = resizeArtTo32(artImageData)
  return computeHashFromGrayGlare(rgbToGray32x32(rgba, 4))
}

/**
 * Variant of computePHash256 for dark art. Stretches the low dynamic range before hashing.
 * Returns null when the art crop isn't dark (mean brightness ≥ 80) — caller skips in that case.
 * Does not affect stored DB hashes — client-side fallback only.
 */
export function computePHash256Dark(artImageData) {
  const rgba = resizeArtTo32(artImageData)
  const gray = rgbToGray32x32(rgba, 4)
  const mean = gray.reduce((s, v) => s + v, 0) / gray.length
  if (mean >= 80) return null  // not dark art — skip this fallback
  return computeHashFromGrayDark(gray)
}

/**
 * Compute a 256-bit perceptual hash of the HSV saturation channel of the art crop.
 * Captures color identity independently of luminance — helps distinguish cards with
 * similar art composition but different color palettes (e.g. land reprints).
 * Stored as phash_hex2 in the DB; used client-side for combined-distance re-ranking.
 */
export function computePHash256Color(artImageData) {
  const rgba = resizeArtTo32(artImageData)
  return computeHashFromGray(rgbToSaturation32x32(rgba, 4))
}

/**
 * Whole-card luma pHash (pipeline v7 second signal): frames, borders, name
 * bar, and set symbol differ between printings and across cards even when
 * art doesn't. Computed once per warped card orientation — it does not vary
 * with the art-crop variants. Matched against phash_full_hex in v2 packs;
 * a no-op cost against v1 packs (matchCore ignores it when the chunk has no
 * full hashes).
 */
export function computeFullCardHash(cardImageData) {
  const rgba = areaResizeRGBA(cardImageData.data, cardImageData.width, cardImageData.height, 32, 32)
  return computeHashFromGray(rgbToGray32x32(rgba, 4))
}

/**
 * Compute all four hash variants from a single art crop in one resize pass.
 * Returns { hash, foilHash, darkHash, colorHash } — caller uses whichever are non-null.
 */
export function computeAllHashes(artImageData) {
  const rgba = resizeArtTo32(artImageData)
  const gray = rgbToGray32x32(rgba, 4)
  const mean = gray.reduce((s, v) => s + v, 0) / gray.length
  return {
    hash:      computeHashFromGray(gray),
    foilHash:  computeHashFromGrayGlare(gray),
    darkHash:  mean < 80 ? computeHashFromGrayDark(gray) : null,
    colorHash: computeHashFromGray(rgbToSaturation32x32(rgba, 4)),
  }
}

export function hashToHex(hash) {
  return _hashToHex(hash)
}

// ── Collector-line strip (Phase 3 OCR) ──────────────────────────────────────
//
// Modern cards (M15 frame, 2014+) print `0123/0281 R` and `SET • EN` in the
// bottom-left. At 500×700 card scale the text is only ~17 px tall — useless
// for OCR — so the strip is warped DIRECTLY from the full-res camera frame
// via the same card↔frame homography, at 3× card scale.
//
// Region in card units (500×700), covering both info lines with margin.
// Starts at the card's left edge — OCR drops characters that touch the crop
// boundary, and detection corners sit a px or two outside the card anyway.
export const STRIP_X0 = 0
export const STRIP_Y0 = 638
export const STRIP_X1 = 330
export const STRIP_Y1 = 700
const STRIP_SCALE = 3
export const STRIP_W = (STRIP_X1 - STRIP_X0) * STRIP_SCALE
export const STRIP_H = (STRIP_Y1 - STRIP_Y0) * STRIP_SCALE

/**
 * OCR preprocessing: grayscale, invert when light-on-dark (the usual white
 * text on black border), then a robust 2–98 percentile contrast stretch.
 * Output stays RGBA so it feeds canvas/ImageData consumers directly.
 */
function preprocessStripForOcr(rgba, width, height) {
  const size = width * height
  const gray = new Float32Array(size)
  const hist = new Int32Array(256)
  for (let i = 0; i < size; i++) {
    const p = i * 4
    const g = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]
    gray[i] = g
    hist[g | 0]++
  }
  let sum = 0
  for (let v = 0; v < 256; v++) sum += hist[v] * v
  const mean = sum / size
  const invert = mean < 128   // light text on dark border → dark-on-light for OCR

  // 2–98 percentile stretch
  const loTarget = size * 0.02, hiTarget = size * 0.98
  let cumul = 0, lo = 0, hi = 255
  for (let v = 0; v < 256; v++) {
    cumul += hist[v]
    if (cumul >= loTarget) { lo = v; break }
  }
  cumul = 0
  for (let v = 0; v < 256; v++) {
    cumul += hist[v]
    if (cumul >= hiTarget) { hi = v; break }
  }
  const range = Math.max(1, hi - lo)

  const out = new Uint8ClampedArray(size * 4)
  for (let i = 0; i < size; i++) {
    let g = ((gray[i] - lo) / range) * 255
    g = g < 0 ? 0 : g > 255 ? 255 : g
    if (invert) g = 255 - g
    const p = i * 4
    out[p] = out[p + 1] = out[p + 2] = g
    out[p + 3] = 255
  }
  return { data: out, width, height }
}

// Title-bar region (name-rescue OCR): the card name occupies the top bar on
// every frame era — unlike the collector line, this works on pre-2014 cards.
// Starts at the card edge: a tighter left crop clipped leading characters
// ("ath in the Family"); border ornament junk normalizes away downstream.
// x1 stops before the mana cost; trailing symbols are junk the fuzzy name
// match tolerates anyway.
export const TITLE_X0 = 0
export const TITLE_Y0 = 20
export const TITLE_X1 = 478
export const TITLE_Y1 = 70
const TITLE_SCALE = 2
export const TITLE_W = (TITLE_X1 - TITLE_X0) * TITLE_SCALE
export const TITLE_H = (TITLE_Y1 - TITLE_Y0) * TITLE_SCALE

/**
 * Warp a card-space rectangle straight out of the full-res frame.
 * `corners` are the card quad in frame coordinates [TL,TR,BR,BL].
 */
function extractCardRegionStrip(frame, corners, x0, y0, x1, y1, outW, outH) {
  if (!corners || corners.length !== 4) return null
  // Forward homography card → frame, then map the strip's card-space corners
  // into frame space and warp that sub-quad to the (oversampled) strip.
  const cardRect = [
    { x: 0, y: 0 }, { x: CARD_W, y: 0 }, { x: CARD_W, y: CARD_H }, { x: 0, y: CARD_H },
  ]
  const H = perspectiveTransform(cardRect, corners)
  if (!H) return null
  const map = (x, y) => {
    const w = H[6] * x + H[7] * y + H[8]
    return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w }
  }
  const subQuad = [map(x0, y0), map(x1, y0), map(x1, y1), map(x0, y1)]
  const data = warpPerspectiveRGBA(frame.data, frame.width, frame.height, subQuad, outW, outH)
  if (!data) return null
  return preprocessStripForOcr(data, outW, outH)
}

/** Collector-line strip from the full-res frame (printing auto-correct). */
export function extractCollectorStrip(frame, corners) {
  return extractCardRegionStrip(frame, corners, STRIP_X0, STRIP_Y0, STRIP_X1, STRIP_Y1, STRIP_W, STRIP_H)
}

/** Title-bar strip from the full-res frame (name-rescue OCR). */
export function extractTitleStrip(frame, corners) {
  return extractCardRegionStrip(frame, corners, TITLE_X0, TITLE_Y0, TITLE_X1, TITLE_Y1, TITLE_W, TITLE_H)
}

function extractCardStripFromCard(cardImageData, x0, y0, x1, y1, outW, outH) {
  if (!cardImageData) return null
  const data = bilinearCropResize(
    cardImageData.data, cardImageData.width, cardImageData.height,
    x0, y0, x1 - x0, y1 - y0, outW, outH,
  )
  return preprocessStripForOcr(data, outW, outH)
}

/**
 * Fallback strip sources for the reticle path: upscale regions of an
 * already-cropped 500×700 card. Lower quality than the frame-warp variants —
 * the card image itself was sampled at reticle resolution.
 */
export function extractCollectorStripFromCard(cardImageData) {
  return extractCardStripFromCard(cardImageData, STRIP_X0, STRIP_Y0, STRIP_X1, STRIP_Y1, STRIP_W, STRIP_H)
}

export function extractTitleStripFromCard(cardImageData) {
  return extractCardStripFromCard(cardImageData, TITLE_X0, TITLE_Y0, TITLE_X1, TITLE_Y1, TITLE_W, TITLE_H)
}
