/**
 * ScannerEngine - OpenCV.js computer vision pipeline
 */

import {
  CARD_W,
  CARD_H,
  ART_H as SHARED_ART_H,
  ART_W as SHARED_ART_W,
  ART_X as SHARED_ART_X,
  ART_Y as SHARED_ART_Y,
} from './constants'
import {
  computeHashFromGray,
  computeHashFromGrayDark,
  computeHashFromGrayGlare,
  hashToHex as _hashToHex,
  preprocessArtTo32x32Gray,
  preprocessArtTo32x32Sat,
} from './hashCore'

// ── Reusable scratch canvases (avoids per-frame createElement overhead) ───────
let _cardCanvas = null, _cardCtx = null
let _artCanvas = null,  _artCtx = null
let _srcCanvas = null,  _srcCtx = null

function getCardCanvas() {
  if (!_cardCanvas) {
    _cardCanvas = document.createElement('canvas')
    _cardCanvas.width = CARD_W; _cardCanvas.height = CARD_H
    _cardCtx = _cardCanvas.getContext('2d', { willReadFrequently: true })
  }
  return { canvas: _cardCanvas, ctx: _cardCtx }
}

function getArtCanvas() {
  if (!_artCanvas) {
    _artCanvas = document.createElement('canvas')
    _artCanvas.width = SHARED_ART_W; _artCanvas.height = SHARED_ART_H
    _artCtx = _artCanvas.getContext('2d', { willReadFrequently: true })
  }
  return { canvas: _artCanvas, ctx: _artCtx }
}

function getSrcCanvas(w, h) {
  if (!_srcCanvas) {
    _srcCanvas = document.createElement('canvas')
    _srcCtx = _srcCanvas.getContext('2d', { willReadFrequently: true })
  }
  if (_srcCanvas.width !== w) _srcCanvas.width = w
  if (_srcCanvas.height !== h) _srcCanvas.height = h
  return { canvas: _srcCanvas, ctx: _srcCtx }
}

export function isOpenCVReady() {
  return typeof window !== 'undefined' &&
         typeof window.cv !== 'undefined' &&
         typeof window.cv.Mat !== 'undefined'
}

export function waitForOpenCV(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (isOpenCVReady()) return resolve()
    const start = Date.now()
    const check = setInterval(() => {
      if (isOpenCVReady()) {
        clearInterval(check)
        resolve()
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check)
        reject(new Error('OpenCV.js failed to load within timeout'))
      }
    }, 150)
  })
}

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

function approxToPoints(approx) {
  if (approx.rows !== 4) return null
  const pts = []
  for (let j = 0; j < 4; j++) {
    pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] })
  }
  return pts
}

function minAreaRectPoints(cv, cnt) {
  if (typeof cv.minAreaRect !== 'function' || !cv.RotatedRect?.points) return null
  try {
    const rect = cv.minAreaRect(cnt)
    const pts = cv.RotatedRect.points(rect)
    if (!pts || pts.length !== 4) return null
    return pts.map(p => ({ x: p.x, y: p.y }))
  } catch {
    return null
  }
}

// Find a card quad from a grayscale Mat using Canny + contour scoring.
// cannyLo/cannyHi: pass explicit values to override adaptive thresholds (used for dark-card retry).
// blurSize: kernel side length for pre-Canny Gaussian blur. Use 3 for faint dark-border edges.
function findBestQuad(cv, gray, width, height, cannyLo = -1, cannyHi = -1, blurSize = 5) {
  const blurred = new cv.Mat()
  const edges = new cv.Mat()
  const dilated = new cv.Mat()
  const contours = new cv.MatVector()
  const hier = new cv.Mat()

  try {
    cv.GaussianBlur(gray, blurred, new cv.Size(blurSize, blurSize), 0)

    let lo, hi
    if (cannyLo >= 0 && cannyHi >= 0) {
      lo = cannyLo; hi = cannyHi
    } else {
      const gdata = blurred.data
      const hist = new Int32Array(256)
      for (let i = 0; i < gdata.length; i++) hist[gdata[i]]++
      let cumul = 0, median = 127
      for (let v = 0; v < 256; v++) {
        cumul += hist[v]
        if (cumul >= gdata.length / 2) { median = v; break }
      }
      // Tighter ratio keeps Pass 1 distinct from Pass 2 across all lighting conditions.
      // On bright backgrounds median*1.5 → hi≈225 which misses faint dark-card borders.
      lo = Math.max(5,  Math.round(median * 0.33))
      hi = Math.max(60, Math.min(220, Math.round(median * 1.33)))
    }
    cv.Canny(blurred, edges, lo, hi)

    const kernel = cv.Mat.ones(3, 3, cv.CV_8U)
    cv.dilate(edges, dilated, kernel)
    kernel.delete()

    cv.findContours(dilated, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    const minArea = width * height * 0.05
    let bestCandidate = null

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i)
      const area = cv.contourArea(cnt)
      if (area < minArea) continue

      const peri = cv.arcLength(cnt, true)
      let candidate = null

      for (const epsilonFactor of [0.02, 0.035, 0.05]) {
        const approx = new cv.Mat()
        cv.approxPolyDP(cnt, approx, epsilonFactor * peri, true)
        const pts = approxToPoints(approx)
        approx.delete()
        if (!pts) continue
        const scored = scoreQuadCandidate(pts, minArea)
        if (scored && (!candidate || scored.score > candidate.score)) {
          candidate = scored
        }
      }

      if (!candidate) {
        const rectPts = minAreaRectPoints(cv, cnt)
        const scored = scoreQuadCandidate(rectPts, minArea)
        if (scored) candidate = scored
      }

      if (candidate && (!bestCandidate || candidate.score > bestCandidate.score)) {
        bestCandidate = candidate
      }
    }

    return bestCandidate?.pts ?? null
  } finally {
    blurred.delete()
    edges.delete()
    dilated.delete()
    contours.delete()
    hier.delete()
  }
}

// detectCardCorners expects a pre-downscaled imageData (caller uses GPU canvas.drawImage
// to halve the frame before passing here). Returns corners in imageData coordinates —
// caller must scale back to full-frame coords.
export function detectCardCorners(imageData, width, height) {
  if (!isOpenCVReady()) return null
  const cv = window.cv
  const src = cv.matFromImageData(imageData)
  const gray = new cv.Mat()

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)

    // Pass 1: adaptive Canny
    const result = findBestQuad(cv, gray, width, height)
    if (result) return result

    // Pass 2: dark-card / low-contrast — fixed low thresholds + smaller blur.
    // 3×3 kernel preserves the faint border gradient that 5×5 smears below threshold.
    const darkResult = findBestQuad(cv, gray, width, height, 5, 40, 3)
    if (darkResult) return darkResult

    // Pass 3: local CLAHE contrast enhancement — better than global equalizeHist for
    // dark-card-on-dark-background scenes where global equalization blends border into bg.
    const claheMat = new cv.Mat()
    try {
      const clahe = cv.createCLAHE(2.0, new cv.Size(8, 8))
      clahe.apply(gray, claheMat)
      clahe.delete()
      return findBestQuad(cv, claheMat, width, height, 5, 40, 3)
    } finally {
      claheMat.delete()
    }
  } finally {
    src.delete()
    gray.delete()
  }
}

// source: HTMLCanvasElement (preferred — no putImageData cost) or ImageData fallback.
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

  // Use canvas directly (GPU drawImage) when available; fall back to putImageData for ImageData input.
  let drawSource
  if (source instanceof HTMLCanvasElement) {
    drawSource = source
  } else {
    const { canvas: srcCanvas, ctx: srcCtx } = getSrcCanvas(frameWidth, frameHeight)
    srcCtx.putImageData(source, 0, 0)
    drawSource = srcCanvas
  }

  const { canvas: outCanvas, ctx: outCtx } = getCardCanvas()
  outCtx.drawImage(drawSource, sourceX, sourceY, sourceW, sourceH, 0, 0, CARD_W, CARD_H)

  return outCtx.getImageData(0, 0, CARD_W, CARD_H)
}

export function warpCard(imageData, corners) {
  if (!isOpenCVReady() || !corners || corners.length !== 4) return null
  const cv = window.cv
  const src = cv.matFromImageData(imageData)
  const dst = new cv.Mat()

  try {
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      corners[0].x, corners[0].y,
      corners[1].x, corners[1].y,
      corners[2].x, corners[2].y,
      corners[3].x, corners[3].y,
    ])
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0, CARD_W, 0, CARD_W, CARD_H, 0, CARD_H,
    ])
    const M = cv.getPerspectiveTransform(srcPts, dstPts)
    cv.warpPerspective(src, dst, M, new cv.Size(CARD_W, CARD_H))
    srcPts.delete()
    dstPts.delete()
    M.delete()

    const { canvas, ctx } = getCardCanvas()
    cv.imshow(canvas, dst)
    return ctx.getImageData(0, 0, CARD_W, CARD_H)
  } finally {
    src.delete()
    dst.delete()
  }
}

export function cropArtRegion(cardImageData, { xOffset = 0, yOffset = 0, inset = 0 } = {}) {
  if (!isOpenCVReady()) return null
  const cv = window.cv
  const src = cv.matFromImageData(cardImageData)
  const width = Math.max(40, Math.min(CARD_W, SHARED_ART_W - inset * 2))
  const height = Math.max(40, Math.min(CARD_H, SHARED_ART_H - inset * 2))
  const baseX = SHARED_ART_X + Math.round((SHARED_ART_W - width) / 2)
  const baseY = SHARED_ART_Y + Math.round((SHARED_ART_H - height) / 2)
  const x = Math.max(0, Math.min(CARD_W - width, baseX + xOffset))
  const y = Math.max(0, Math.min(CARD_H - height, baseY + yOffset))

  try {
    const rect = new cv.Rect(x, y, width, height)
    const roi = src.roi(rect)
    const { canvas, ctx } = getArtCanvas()
    cv.imshow(canvas, roi)
    roi.delete()
    return ctx.getImageData(0, 0, SHARED_ART_W, SHARED_ART_H)
  } finally {
    src.delete()
  }
}

/**
 * Laplacian-variance sharpness score on a grayscale version of the frame.
 * Higher = sharper. Typical: >50 sharp, <20 blurry. Returns Infinity if
 * OpenCV isn't ready (fail-open — never block scans on a missing gate).
 */
export function frameSharpness(imageData) {
  if (!isOpenCVReady()) return Infinity
  const cv = window.cv
  const src = cv.matFromImageData(imageData)
  const gray = new cv.Mat()
  const lap = new cv.Mat()
  const mean = new cv.Mat()
  const stddev = new cv.Mat()
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.Laplacian(gray, lap, cv.CV_64F)
    cv.meanStdDev(lap, mean, stddev)
    const sd = stddev.doubleAt(0, 0)
    return sd * sd
  } catch {
    return Infinity
  } finally {
    src.delete(); gray.delete(); lap.delete(); mean.delete(); stddev.delete()
  }
}

/**
 * Rotate the four detected corner points 90° clockwise relative to the card
 * frame. Cheaper than rotating warped pixels: `warpCard` still produces an
 * upright 500×700 output, but the card is interpreted as if held landscape.
 *
 * Corners are [TL, TR, BR, BL]. Rotating the source frame 90° CW means what
 * was TL becomes TR, TR→BR, BR→BL, BL→TL — i.e. shift by one slot.
 */
export function rotateCornersCW(pts) {
  if (!pts || pts.length !== 4) return null
  return [pts[3], pts[0], pts[1], pts[2]]
}

/** Counter-clockwise counterpart of rotateCornersCW. */
export function rotateCornersCCW(pts) {
  if (!pts || pts.length !== 4) return null
  return [pts[1], pts[2], pts[3], pts[0]]
}

/**
 * Rotate an ImageData 90° clockwise. Output dimensions are (height × width).
 * Used for the reticle fallback where no corners exist — we can't pre-rotate
 * corner coordinates, so we rotate the warped pixels instead.
 */
export function rotateCard90CW(imageData) {
  const { width: w, height: h, data } = imageData
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4
      const nx = h - 1 - y
      const ny = x
      const dst = (ny * h + nx) * 4
      out[dst]     = data[src]
      out[dst + 1] = data[src + 1]
      out[dst + 2] = data[src + 2]
      out[dst + 3] = data[src + 3]
    }
  }
  return new ImageData(out, h, w)
}

/** Counter-clockwise counterpart of rotateCard90CW. */
export function rotateCard90CCW(imageData) {
  const { width: w, height: h, data } = imageData
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4
      const nx = y
      const ny = w - 1 - x
      const dst = (ny * h + nx) * 4
      out[dst]     = data[src]
      out[dst + 1] = data[src + 1]
      out[dst + 2] = data[src + 2]
      out[dst + 3] = data[src + 3]
    }
  }
  return new ImageData(out, h, w)
}

/**
 * Rotate an ImageData 180° in pure JS (no OpenCV needed).
 * Used as a fallback for upside-down cards.
 */
export function rotateCard180(imageData) {
  const { width, height, data } = imageData
  const out = new Uint8ClampedArray(data.length)
  const total = width * height
  for (let i = 0; i < total; i++) {
    const src = (total - 1 - i) * 4
    const dst = i * 4
    out[dst]     = data[src]
    out[dst + 1] = data[src + 1]
    out[dst + 2] = data[src + 2]
    out[dst + 3] = data[src + 3]
  }
  return new ImageData(out, width, height)
}

/** Hashes the entire warped card. Used for borderless / full-art / token cards. */
export function computeFullCardHash(warpedCardImageData) {
  const gray = preprocessArtTo32x32Gray(
    warpedCardImageData.data,
    warpedCardImageData.width,
    warpedCardImageData.height,
    4
  )
  return computeHashFromGray(gray)
}

/**
 * Compute all hash variants from a single art crop using the shared pure-JS
 * preprocess pipeline so the client and seed script stay bit-identical.
 *
 * luma   (hash)      - primary match
 * glare  (foilHash)  - aggressive percentileCap(0.92) for blown highlights
 * dark   (darkHash)  - linear floor-stretch for dim art; null when mean >= 110
 * color  (colorHash) - saturation channel; used for re-ranking ties
 * full   (fullHash)  - full-card hash for non-standard layouts
 */
export function computeAllHashes(artImageData, warpedCard = null) {
  const gray = preprocessArtTo32x32Gray(
    artImageData.data,
    artImageData.width,
    artImageData.height,
    4
  )
  const mean = gray.reduce((s, v) => s + v, 0) / gray.length
  const sat = preprocessArtTo32x32Sat(
    artImageData.data,
    artImageData.width,
    artImageData.height,
    4
  )
  return {
    hash:      computeHashFromGray(gray),
    foilHash:  computeHashFromGrayGlare(gray),
    darkHash:  mean < 110 ? computeHashFromGrayDark(gray) : null,
    colorHash: computeHashFromGray(sat),
    fullHash:  warpedCard ? computeFullCardHash(warpedCard) : null,
  }
}

export function hashToHex(hash) {
  return _hashToHex(hash)
}
