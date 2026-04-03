/**
 * ScannerEngine - OpenCV.js computer vision pipeline
 */

import {
  ART_H as SHARED_ART_H,
  ART_W as SHARED_ART_W,
  ART_X as SHARED_ART_X,
  ART_Y as SHARED_ART_Y,
} from './constants'
import { computeHashFromGray, rgbToGray32x32, hashToHex as _hashToHex } from './hashCore'

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
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4
  const tl = pts.filter(p => p.x <= cx && p.y <= cy).sort((a, b) => a.x - b.x)[0]
  const tr = pts.filter(p => p.x > cx && p.y <= cy).sort((a, b) => b.x - a.x)[0]
  const br = pts.filter(p => p.x > cx && p.y > cy).sort((a, b) => b.x - a.x)[0]
  const bl = pts.filter(p => p.x <= cx && p.y > cy).sort((a, b) => a.x - b.x)[0]
  return [tl ?? pts[0], tr ?? pts[1], br ?? pts[2], bl ?? pts[3]]
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

// Find a card quad from a grayscale Mat using adaptive Canny + contour scoring.
function findBestQuad(cv, gray, width, height) {
  const blurred = new cv.Mat()
  const edges = new cv.Mat()
  const dilated = new cv.Mat()
  const contours = new cv.MatVector()
  const hier = new cv.Mat()

  try {
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)

    const gdata = blurred.data
    const hist = new Int32Array(256)
    for (let i = 0; i < gdata.length; i++) hist[gdata[i]]++
    let cumul = 0
    let median = 127
    for (let v = 0; v < 256; v++) {
      cumul += hist[v]
      if (cumul >= gdata.length / 2) { median = v; break }
    }
    const lo = Math.max(10, Math.round(median * 0.5))
    const hi = Math.min(240, Math.round(median * 1.5))
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

export function detectCardCorners(imageData, width, height) {
  if (!isOpenCVReady()) return null
  const cv = window.cv
  const src = cv.matFromImageData(imageData)
  const gray = new cv.Mat()

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)

    // Standard detection
    const result = findBestQuad(cv, gray, width, height)
    if (result) return result

    // Retry with histogram equalization — helps dark/low-contrast cards
    // (black borders on dark backgrounds, dimly lit scenes)
    const eqGray = new cv.Mat()
    try {
      cv.equalizeHist(gray, eqGray)
      return findBestQuad(cv, eqGray, width, height)
    } finally {
      eqGray.delete()
    }
  } finally {
    src.delete()
    gray.delete()
  }
}

const CARD_W = 500
const CARD_H = 700

export function cropCardFromReticle(
  imageData,
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

  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = frameWidth
  srcCanvas.height = frameHeight
  const srcCtx = srcCanvas.getContext('2d')
  srcCtx.putImageData(imageData, 0, 0)

  const outCanvas = document.createElement('canvas')
  outCanvas.width = CARD_W
  outCanvas.height = CARD_H
  const outCtx = outCanvas.getContext('2d')
  outCtx.drawImage(
    srcCanvas,
    sourceX, sourceY, sourceW, sourceH,
    0, 0, CARD_W, CARD_H,
  )

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

    const canvas = document.createElement('canvas')
    canvas.width = CARD_W
    canvas.height = CARD_H
    cv.imshow(canvas, dst)
    return canvas.getContext('2d').getImageData(0, 0, CARD_W, CARD_H)
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
    const canvas = document.createElement('canvas')
    canvas.width = SHARED_ART_W
    canvas.height = SHARED_ART_H
    cv.imshow(canvas, roi)
    roi.delete()
    return canvas.getContext('2d').getImageData(0, 0, SHARED_ART_W, SHARED_ART_H)
  } finally {
    src.delete()
  }
}

export function computePHash256(artImageData) {
  if (!isOpenCVReady()) throw new Error('OpenCV not ready')
  const cv = window.cv
  const src = cv.matFromImageData(artImageData)
  if (!src || src.empty()) throw new Error('matFromImageData failed')
  const blurred = new cv.Mat()
  const resized = new cv.Mat()

  try {
    cv.GaussianBlur(src, blurred, new cv.Size(5, 5), 1.0)
    cv.resize(blurred, resized, new cv.Size(32, 32), 0, 0, cv.INTER_LANCZOS4)
    if (resized.empty()) throw new Error('resize to 32x32 failed')

    const rgba = resized.data
    if (!rgba || rgba.length < 4096) throw new Error(`resized.data invalid (len=${rgba?.length})`)

    return computeHashFromGray(rgbToGray32x32(rgba, 4))
  } finally {
    src.delete()
    blurred.delete()
    resized.delete()
  }
}

export function hashToHex(hash) {
  return _hashToHex(hash)
}
