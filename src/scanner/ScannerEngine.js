// src/scanner/ScannerEngine.js
// OpenCV.js is loaded globally via <script> in index.html.
// Check window.cv before calling any function here.

export function isOpenCVReady() {
  return (
    typeof window !== 'undefined' &&
    typeof window.cv !== 'undefined' &&
    window.cv.Mat !== undefined
  )
}

export function waitForOpenCV(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (isOpenCVReady()) return resolve()
    const start = Date.now()
    const check = setInterval(() => {
      if (isOpenCVReady()) {
        clearInterval(check)
        resolve()
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check)
        reject(new Error('OpenCV failed to load'))
      }
    }, 100)
  })
}

// Order 4 points: [topLeft, topRight, bottomRight, bottomLeft]
function orderPoints(pts) {
  const center = pts.reduce(
    (a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }),
    { x: 0, y: 0 }
  )
  const tl = pts.find(p => p.x <= center.x && p.y <= center.y) || pts[0]
  const tr = pts.find(p => p.x >  center.x && p.y <= center.y) || pts[1]
  const br = pts.find(p => p.x >  center.x && p.y >  center.y) || pts[2]
  const bl = pts.find(p => p.x <= center.x && p.y >  center.y) || pts[3]
  return [tl, tr, br, bl]
}

// Detect the best card-shaped quadrilateral in imageData.
// Returns array of 4 {x, y} points or null.
export function detectCardCorners(imageData, width, height) {
  if (!isOpenCVReady()) return null
  const cv = window.cv

  const src      = cv.matFromImageData(imageData)
  const gray     = new cv.Mat()
  const blurred  = new cv.Mat()
  const edges    = new cv.Mat()
  const dilated  = new cv.Mat()
  const contours  = new cv.MatVector()
  const hierarchy = new cv.Mat()

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)
    cv.Canny(blurred, edges, 40, 120)

    const kernel = cv.Mat.ones(3, 3, cv.CV_8U)
    cv.dilate(edges, dilated, kernel)
    kernel.delete()

    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    const minArea = width * height * 0.08  // card must cover at least 8% of frame
    let bestPts  = null
    let bestArea = 0

    for (let i = 0; i < contours.size(); i++) {
      const cnt  = contours.get(i)
      const area = cv.contourArea(cnt)
      if (area < minArea) continue

      const peri   = cv.arcLength(cnt, true)
      const approx = new cv.Mat()
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true)

      if (approx.rows === 4) {
        // Extract corners
        const pts = []
        for (let j = 0; j < 4; j++) {
          pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] })
        }
        // Check aspect ratio (MTG card = 0.716, allow landscape too)
        const ordered = orderPoints(pts)
        const w = Math.hypot(ordered[1].x - ordered[0].x, ordered[1].y - ordered[0].y)
        const h = Math.hypot(ordered[3].x - ordered[0].x, ordered[3].y - ordered[0].y)
        const ratio = Math.min(w, h) / Math.max(w, h)
        if (ratio >= 0.60 && ratio <= 0.80 && area > bestArea) {
          bestArea = area
          bestPts  = ordered
        }
      }
      approx.delete()
    }

    return bestPts
  } finally {
    src.delete()
    gray.delete()
    blurred.delete()
    edges.delete()
    dilated.delete()
    contours.delete()
    hierarchy.delete()
  }
}

// Warp detected card to a standard 500×700 canvas.
// Returns ImageData or null.
export function warpCard(imageData, corners) {
  if (!isOpenCVReady() || !corners) return null
  const cv = window.cv
  const W = 500, H = 700

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
      0, 0,
      W, 0,
      W, H,
      0, H,
    ])

    const M = cv.getPerspectiveTransform(srcPts, dstPts)
    cv.warpPerspective(src, dst, M, new cv.Size(W, H))
    srcPts.delete()
    dstPts.delete()
    M.delete()

    // Convert to ImageData
    const canvas = document.createElement('canvas')
    canvas.width  = W
    canvas.height = H
    cv.imshow(canvas, dst)
    return canvas.getContext('2d').getImageData(0, 0, W, H)
  } finally {
    src.delete()
    dst.delete()
  }
}

// Crop the art region from a 500×700 warped card image.
// Art box on a standard card: x=[25,475], y=[55,330]
export function cropArtRegion(cardImageData) {
  if (!isOpenCVReady()) return null
  const cv  = window.cv
  const src = cv.matFromImageData(cardImageData)

  try {
    const rect = new cv.Rect(25, 55, 450, 275)  // x, y, w, h
    const roi  = src.roi(rect)
    const canvas = document.createElement('canvas')
    canvas.width  = 450
    canvas.height = 275
    cv.imshow(canvas, roi)
    roi.delete()
    return canvas.getContext('2d').getImageData(0, 0, 450, 275)
  } finally {
    src.delete()
  }
}

// Compute 256-bit perceptual hash using DCT.
// Returns { p1, p2, p3, p4 } as BigInt (each 64 bits), or null on failure.
export function computePHash256(artImageData) {
  if (!isOpenCVReady()) return null
  const cv = window.cv

  const src     = cv.matFromImageData(artImageData)
  const gray    = new cv.Mat()
  const resized = new cv.Mat()
  const floated = new cv.Mat()
  const dctMat  = new cv.Mat()

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.resize(gray, resized, new cv.Size(32, 32), 0, 0, cv.INTER_AREA)
    resized.convertTo(floated, cv.CV_32F)
    cv.dct(floated, dctMat)

    // Extract top-left 16×16 (256 values)
    const dctRect = new cv.Rect(0, 0, 16, 16)
    const roi     = dctMat.roi(dctRect)
    const values  = Array.from(roi.data32F)  // 256 floats
    roi.delete()

    // Mean — skip DC component at index 0 for better discrimination
    const mean = values.slice(1).reduce((a, b) => a + b, 0) / 255

    // Pack into 4 × 64-bit BigInts
    const bits = values.map(v => v > mean ? 1 : 0)
    const pack = (start) => {
      let r = 0n
      for (let i = 0; i < 64; i++) {
        if (bits[start + i]) r |= (1n << BigInt(i))
      }
      return r
    }

    return {
      p1: pack(0),
      p2: pack(64),
      p3: pack(128),
      p4: pack(192),
    }
  } finally {
    src.delete()
    gray.delete()
    resized.delete()
    floated.delete()
    dctMat.delete()
  }
}

// Convert a hash {p1, p2, p3, p4} BigInts to a 64-char hex string.
export function hashToHex({ p1, p2, p3, p4 }) {
  return [p1, p2, p3, p4]
    .map(n => n.toString(16).padStart(16, '0'))
    .join('')
}
