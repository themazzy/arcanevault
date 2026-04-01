/**
 * ScannerEngine - OpenCV.js computer vision pipeline
 */

import {
  ART_H as SHARED_ART_H,
  ART_W as SHARED_ART_W,
  ART_X as SHARED_ART_X,
  ART_Y as SHARED_ART_Y,
} from './constants'

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

export function detectCardCorners(imageData, width, height) {
  if (!isOpenCVReady()) return null
  const cv = window.cv

  const src = cv.matFromImageData(imageData)
  const gray = new cv.Mat()
  const blurred = new cv.Mat()
  const edges = new cv.Mat()
  const dilated = new cv.Mat()
  const contours = new cv.MatVector()
  const hier = new cv.Mat()

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)

    const gdata = blurred.data
    const hist = new Int32Array(256)
    for (let i = 0; i < gdata.length; i++) hist[gdata[i]]++
    let cumul = 0
    let median = 127
    for (let v = 0; v < 256; v++) {
      cumul += hist[v]
      if (cumul >= gdata.length / 2) {
        median = v
        break
      }
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
    src.delete()
    gray.delete()
    blurred.delete()
    edges.delete()
    dilated.delete()
    contours.delete()
    hier.delete()
  }
}

const CARD_W = 500
const CARD_H = 700

function percentileCap(u8, percentile = 0.985) {
  const hist = new Int32Array(256)
  for (let i = 0; i < u8.length; i++) hist[u8[i]]++
  const target = Math.max(1, Math.floor(u8.length * percentile))
  let seen = 0
  let cap = 255
  for (let v = 0; v < 256; v++) {
    seen += hist[v]
    if (seen >= target) {
      cap = v
      break
    }
  }
  if (cap >= 250) return u8
  const out = new Uint8Array(u8.length)
  for (let i = 0; i < u8.length; i++) {
    const val = u8[i]
    out[i] = val > cap ? cap : val
  }
  return out
}

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

function buildNameStripCanvas(cardImageData, {
  x = 0.04,
  y = 0.028,
  width = 0.74,
  height = 0.11,
  mode = 'otsu',
  contrastBoost = 1,
} = {}) {
  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = CARD_W
  srcCanvas.height = CARD_H
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true })
  srcCtx.putImageData(cardImageData, 0, 0)

  const nx = Math.round(CARD_W * x)
  const ny = Math.round(CARD_H * y)
  const nw = Math.round(CARD_W * width)
  const nh = Math.round(CARD_H * height)

  const base = document.createElement('canvas')
  base.width = nw
  base.height = nh
  const baseCtx = base.getContext('2d', { willReadFrequently: true })
  baseCtx.drawImage(srcCanvas, nx, ny, nw, nh, 0, 0, nw, nh)

  const raw = baseCtx.getImageData(0, 0, nw, nh)
  const data = raw.data
  let meanBright = 0
  for (let i = 0; i < data.length; i += 4) {
    meanBright += (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
  }
  meanBright /= Math.max(1, data.length / 4)
  const darkBg = meanBright < 160

  const scale = Math.max(3, Math.min(8, Math.ceil(60 / Math.max(nh, 1))))
  const out = document.createElement('canvas')
  out.width = nw * scale
  out.height = nh * scale
  const outCtx = out.getContext('2d', { willReadFrequently: true })
  outCtx.drawImage(base, 0, 0, nw, nh, 0, 0, out.width, out.height)

  const img = outCtx.getImageData(0, 0, out.width, out.height)
  const px = img.data
  const gray = new Uint8Array(px.length >> 2)
  const hist = new Int32Array(256)
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]
    const g0 = px[i + 1]
    const b = px[i + 2]
    const baseGray = ((r * 299 + g0 * 587 + b * 114) / 1000) | 0
    const boosted = Math.max(0, Math.min(255, Math.round((baseGray - 128) * contrastBoost + 128)))
    const g = boosted
    gray[i >> 2] = g
    hist[g]++
  }

  const total = gray.length
  let sumAll = 0
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const sigma = wB * wF * (mB - mF) ** 2
    if (sigma > best) {
      best = sigma
      threshold = t
    }
  }

  for (let i = 0; i < px.length; i += 4) {
    let v = gray[i >> 2]
    if (mode === 'otsu') {
      v = gray[i >> 2] >= threshold ? 255 : 0
      if (darkBg) v = 255 - v
    } else if (mode === 'gray-invert' && darkBg) {
      v = 255 - v
    } else if (mode === 'soft-threshold') {
      const thresholded = gray[i >> 2] >= threshold ? 255 : 32
      v = darkBg ? 255 - thresholded : thresholded
    }
    px[i] = v
    px[i + 1] = v
    px[i + 2] = v
    px[i + 3] = 255
  }
  outCtx.putImageData(img, 0, 0)
  return out
}

export function createNameStripCanvases(cardImageData) {
  return [
    {
      label: 'otsu-wide',
      canvas: buildNameStripCanvas(cardImageData, {
        x: 0.04,
        y: 0.028,
        width: 0.74,
        height: 0.11,
        mode: 'otsu',
        contrastBoost: 1.1,
      }),
    },
    {
      label: 'gray-wide',
      canvas: buildNameStripCanvas(cardImageData, {
        x: 0.04,
        y: 0.028,
        width: 0.74,
        height: 0.11,
        mode: 'gray-invert',
        contrastBoost: 1.3,
      }),
    },
    {
      label: 'otsu-tight',
      canvas: buildNameStripCanvas(cardImageData, {
        x: 0.055,
        y: 0.03,
        width: 0.69,
        height: 0.095,
        mode: 'soft-threshold',
        contrastBoost: 1.15,
      }),
    },
  ]
}

export function createNameStripCanvas(cardImageData) {
  return createNameStripCanvases(cardImageData)[0]?.canvas ?? null
}

function dct2d(matrix, N) {
  const out = new Float64Array(N * N)
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      let sum = 0
      for (let x = 0; x < N; x++) {
        sum += matrix[y * N + x] * Math.cos((2 * x + 1) * u * Math.PI / (2 * N))
      }
      const cu = u === 0 ? 1 / Math.sqrt(2) : 1
      out[y * N + u] = (2 / N) * cu * sum / 2
    }
  }
  const tmp = out.slice()
  for (let x = 0; x < N; x++) {
    for (let v = 0; v < N; v++) {
      let sum = 0
      for (let y = 0; y < N; y++) {
        sum += tmp[y * N + x] * Math.cos((2 * y + 1) * v * Math.PI / (2 * N))
      }
      const cv2 = v === 0 ? 1 / Math.sqrt(2) : 1
      out[v * N + x] = (2 / N) * cv2 * sum / 2
    }
  }
  return out
}

function applyCLAHE(u8, width, height, tileGridX = 4, tileGridY = 4, clipLimit = 40.0) {
  const tileW = Math.floor(width / tileGridX)
  const tileH = Math.floor(height / tileGridY)
  const tileArea = tileW * tileH
  const clip = Math.max(1, Math.floor(clipLimit * tileArea / 256))

  const luts = []
  for (let ty = 0; ty < tileGridY; ty++) {
    for (let tx = 0; tx < tileGridX; tx++) {
      const hist = new Int32Array(256)
      for (let y = ty * tileH; y < (ty + 1) * tileH; y++) {
        for (let x = tx * tileW; x < (tx + 1) * tileW; x++) {
          hist[u8[y * width + x]]++
        }
      }

      let excess = 0
      for (let i = 0; i < 256; i++) {
        if (hist[i] > clip) {
          excess += hist[i] - clip
          hist[i] = clip
        }
      }
      const add = Math.floor(excess / 256)
      let rem = excess % 256
      const step = rem > 0 ? Math.floor(256 / rem) : 256
      for (let i = 0; i < 256; i++) {
        hist[i] += add
        if (rem > 0 && i % step === 0) {
          hist[i]++
          rem--
        }
      }

      const lut = new Uint8Array(256)
      let cdf = 0
      for (let i = 0; i < 256; i++) {
        cdf += hist[i]
        lut[i] = Math.min(255, Math.round(cdf * 255.0 / tileArea))
      }
      luts.push(lut)
    }
  }

  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = u8[y * width + x]
      const gx = (x + 0.5) / tileW - 0.5
      const gy = (y + 0.5) / tileH - 0.5
      const tx0 = Math.max(0, Math.min(tileGridX - 2, Math.floor(gx)))
      const ty0 = Math.max(0, Math.min(tileGridY - 2, Math.floor(gy)))
      const ax = Math.max(0, Math.min(1, gx - tx0))
      const ay = Math.max(0, Math.min(1, gy - ty0))
      out[y * width + x] = Math.round(
        luts[ty0 * tileGridX + tx0][v] * (1 - ax) * (1 - ay) +
        luts[ty0 * tileGridX + tx0 + 1][v] * ax * (1 - ay) +
        luts[(ty0 + 1) * tileGridX + tx0][v] * (1 - ax) * ay +
        luts[(ty0 + 1) * tileGridX + tx0 + 1][v] * ax * ay
      )
    }
  }
  return out
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
    const grayU8 = new Uint8Array(32 * 32)
    for (let i = 0; i < 32 * 32; i++) {
      grayU8[i] = Math.round(0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2])
    }

    const glareSuppressed = percentileCap(grayU8, 0.98)
    const eq8 = applyCLAHE(glareSuppressed, 32, 32)
    const pixels = new Float64Array(32 * 32)
    for (let i = 0; i < pixels.length; i++) pixels[i] = eq8[i]
    const dct = dct2d(pixels, 32)

    const coeffs = []
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        coeffs.push(dct[y * 32 + x])
      }
    }

    const mean = coeffs.slice(1).reduce((a, b) => a + b, 0) / 255
    const bits = coeffs.map(v => v > mean ? 1 : 0)

    const pack64 = (start) => {
      let r = 0n
      for (let i = 0; i < 64; i++) {
        if (bits[start + i]) r |= 1n << BigInt(i)
      }
      return r
    }

    return { p1: pack64(0), p2: pack64(64), p3: pack64(128), p4: pack64(192) }
  } finally {
    src.delete()
    blurred.delete()
    resized.delete()
  }
}

export function hashToHex({ p1, p2, p3, p4 }) {
  return [p1, p2, p3, p4]
    .map(n => n.toString(16).padStart(16, '0'))
    .join('')
}
