import {
  detectCardCorners,
  warpCard,
  cropArtRegion,
  computeAllHashes,
  rotateCard180,
  isOpenCVReady,
} from './ScannerEngine'

const OPENCV_URL = 'https://docs.opencv.org/4.8.0/opencv.js'
const MATCH_THRESHOLD = 122
const MATCH_MIN_GAP = 8
const MATCH_STRONG_THRESHOLD = 134
const PRIMARY_CROP_VARIANTS = [
  { xOffset: 0, yOffset: 0 },
  { xOffset: 0, yOffset: -10 },
  { xOffset: 0, yOffset: 10 },
  { xOffset: 0, yOffset: 0, inset: 6 },
]
const MARGINAL_CROP_VARIANTS = [
  { xOffset: -8, yOffset: 0 },
  { xOffset: 8, yOffset: 0 },
  { xOffset: -8, yOffset: -8 },
  { xOffset: 8, yOffset: -8 },
  { xOffset: -8, yOffset: 8 },
  { xOffset: 8, yOffset: 8 },
]
const FAST_PRIMARY_VARIANTS = [PRIMARY_CROP_VARIANTS[0]]

let openCvPromise = null

function waitForWorkerOpenCV(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (isOpenCVReady()) return resolve()
    const start = Date.now()
    const timer = setInterval(() => {
      if (isOpenCVReady()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        reject(new Error('OpenCV.js failed to initialize in worker'))
      }
    }, 100)
  })
}

async function ensureOpenCV() {
  if (isOpenCVReady()) return true
  if (!openCvPromise) {
    openCvPromise = (async () => {
      const response = await fetch(OPENCV_URL)
      if (!response.ok) throw new Error(`OpenCV worker fetch failed: HTTP ${response.status}`)
      const source = await response.text()
      ;(0, eval)(source)
      await waitForWorkerOpenCV()
      return true
    })()
  }
  return openCvPromise
}

function isUsableArtCrop(artCrop) {
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

function hashPayload(hashes) {
  return {
    hash: hashes.hash ? Array.from(hashes.hash) : null,
    foilHash: hashes.foilHash ? Array.from(hashes.foilHash) : null,
    darkHash: hashes.darkHash ? Array.from(hashes.darkHash) : null,
    colorHash: hashes.colorHash ? Array.from(hashes.colorHash) : null,
  }
}

function pushAttempts(attempts, cardImg, sourceLabel, variants) {
  for (const variant of variants) {
    const artCrop = cropArtRegion(cardImg, variant)
    if (!artCrop || !isUsableArtCrop(artCrop)) continue
    let hashes
    try { hashes = computeAllHashes(artCrop) } catch { continue }
    if (!hashes.hash) continue
    attempts.push({ sourceLabel, variant, ...hashPayload(hashes) })
  }
}

async function scanFrame(payload) {
  await ensureOpenCV()
  const { imageData, smallImageData, w, h, sw, sh, cachedCorners = null } = payload
  let corners = cachedCorners
  if (!corners) {
    const cornersSmall = detectCardCorners(smallImageData, sw, sh)
    const scaleX = w / sw
    const scaleY = h / sh
    corners = cornersSmall?.map(p => ({ x: p.x * scaleX, y: p.y * scaleY })) ?? null
  }

  const attempts = []
  if (corners) {
    const warped = warpCard(imageData, corners)
    if (warped) {
      pushAttempts(attempts, warped, 'corners', FAST_PRIMARY_VARIANTS)
      pushAttempts(attempts, warped, 'corners', PRIMARY_CROP_VARIANTS.slice(1))
      pushAttempts(attempts, warped, 'corners', MARGINAL_CROP_VARIANTS)

      const warped180 = rotateCard180(warped)
      pushAttempts(attempts, warped180, 'corners+rot180', FAST_PRIMARY_VARIANTS)
      pushAttempts(attempts, warped180, 'corners+rot180', PRIMARY_CROP_VARIANTS.slice(1))
      pushAttempts(attempts, warped180, 'corners+rot180', MARGINAL_CROP_VARIANTS)
    }
  }

  return {
    attempts,
    corners,
    hasCorners: !!corners,
    thresholds: {
      matchThreshold: MATCH_THRESHOLD,
      matchMinGap: MATCH_MIN_GAP,
      matchStrongThreshold: MATCH_STRONG_THRESHOLD,
    },
  }
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {}
  try {
    if (type === 'init') {
      await ensureOpenCV()
      self.postMessage({ id, ok: true, result: { ready: true } })
      return
    }
    if (type === 'scanFrame') {
      const result = await scanFrame(payload)
      self.postMessage({ id, ok: true, result })
      return
    }
    throw new Error(`Unknown scan worker message: ${type}`)
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) })
  }
}

