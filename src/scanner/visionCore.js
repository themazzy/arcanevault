/**
 * visionCore.js — pure-JS vision primitives for the card scanner
 *
 * Replaces the vendored OpenCV.js build (~10 MB + WASM compile at startup).
 * The scanner only ever used a small imgproc subset — grayscale, Gaussian
 * blur, Canny, dilate, external contours, polygon approximation, minAreaRect,
 * perspective warp, and area resize — all reimplemented here on typed arrays.
 * No DOM, no canvas, no WASM: runs identically on the main thread, in a
 * worker, and under Node (tests).
 *
 * Behavioral notes (kept deliberately close to the OpenCV defaults the
 * scanner was tuned against):
 *  - grayscale uses BT.601 (cv.COLOR_RGBA2GRAY) — detection only; the hash
 *    pipeline's BT.709 conversion lives in hashCore and is unchanged
 *  - GaussianBlur with sigma 0 and ksize 3/5 uses OpenCV's fixed binomial
 *    kernels [1,2,1]/4 and [1,4,6,4,1]/16 with reflect-101 borders
 *  - Canny uses 3×3 Sobel, L1 gradient magnitude, OpenCV's tangent-based
 *    direction quantization for non-maximum suppression, and 8-connected
 *    hysteresis
 *  - areaResizeRGBA is the INTER_AREA equivalent (exact fractional pixel-area
 *    averaging) — it feeds the hash, and stays within the resize-kernel
 *    variance the hash pipeline already tolerates (seed uses Sharp mitchell)
 */

// ── Grayscale (detection) ────────────────────────────────────────────────────

export function rgbaToGrayU8(data, width, height) {
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114 + 0.5) | 0
  }
  return out
}

/**
 * Colorfulness channel: max pairwise channel difference per pixel. A neutral
 * black card border reads ~0 while an equally-DARK but colored background
 * (wood, red playmat) reads 20–60 — the card boundary appears in chroma even
 * when it is invisible in luminance. Used by detection pass 4.
 */
export function rgbaToChromaU8(data, width, height) {
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2]
    const rg = r > g ? r - g : g - r
    const gb = g > b ? g - b : b - g
    const rb = r > b ? r - b : b - r
    let m = rg > gb ? rg : gb
    if (rb > m) m = rb
    out[i] = m
  }
  return out
}

// ── Gaussian blur (ksize 3 or 5, sigma 0 → fixed binomial kernels) ──────────

// reflect-101 border indexing: -1 → 1, size → size-2
function reflect101(i, size) {
  if (i < 0) return -i
  if (i >= size) return 2 * size - i - 2
  return i
}

export function gaussianBlurGray(gray, width, height, ksize = 5) {
  const kernel = ksize === 3 ? [1, 2, 1] : [1, 4, 6, 4, 1]
  const kSum = ksize === 3 ? 4 : 16
  const r = ksize >> 1
  const tmp = new Float32Array(width * height)
  const out = new Uint8Array(width * height)

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -r; k <= r; k++) {
        sum += gray[row + reflect101(x + k, width)] * kernel[k + r]
      }
      tmp[row + x] = sum
    }
  }
  // Vertical pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let k = -r; k <= r; k++) {
        sum += tmp[reflect101(y + k, height) * width + x] * kernel[k + r]
      }
      out[y * width + x] = (sum / (kSum * kSum) + 0.5) | 0
    }
  }
  return out
}

// ── Canny edge detection ─────────────────────────────────────────────────────

const TG22 = 0.4142135623730951   // tan(22.5°)
const TG67 = 2.414213562373095    // tan(67.5°)

export function canny(gray, width, height, lo, hi) {
  const size = width * height
  const gx = new Int16Array(size)
  const gy = new Int16Array(size)
  const mag = new Int32Array(size)

  // 3×3 Sobel with reflect-101 borders, L1 magnitude (OpenCV default)
  for (let y = 0; y < height; y++) {
    const ym = reflect101(y - 1, height) * width
    const y0 = y * width
    const yp = reflect101(y + 1, height) * width
    for (let x = 0; x < width; x++) {
      const xm = reflect101(x - 1, width)
      const xp = reflect101(x + 1, width)
      const a = gray[ym + xm], b = gray[ym + x], c = gray[ym + xp]
      const d = gray[y0 + xm],                  f = gray[y0 + xp]
      const g = gray[yp + xm], h2 = gray[yp + x], i2 = gray[yp + xp]
      const dx = (c + 2 * f + i2) - (a + 2 * d + g)
      const dy = (g + 2 * h2 + i2) - (a + 2 * b + c)
      const idx = y0 + x
      gx[idx] = dx
      gy[idx] = dy
      mag[idx] = Math.abs(dx) + Math.abs(dy)
    }
  }

  // Non-maximum suppression + double threshold.
  // 0 = suppressed, 1 = weak (≥ lo), 2 = strong (≥ hi)
  const map = new Uint8Array(size)
  for (let y = 1; y < height - 1; y++) {
    const row = y * width
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x
      const m = mag[idx]
      if (m < lo) continue
      const ax = Math.abs(gx[idx])
      const ay = Math.abs(gy[idx])
      let n1, n2
      if (ay < TG22 * ax) {          // ~horizontal gradient → vertical edge
        n1 = mag[idx - 1]; n2 = mag[idx + 1]
      } else if (ay > TG67 * ax) {   // ~vertical gradient → horizontal edge
        n1 = mag[idx - width]; n2 = mag[idx + width]
      } else if ((gx[idx] ^ gy[idx]) < 0) {  // opposite signs → 135° diagonal
        n1 = mag[idx - width + 1]; n2 = mag[idx + width - 1]
      } else {                                // same signs → 45° diagonal
        n1 = mag[idx - width - 1]; n2 = mag[idx + width + 1]
      }
      if (m > n1 && m >= n2) {
        map[idx] = m >= hi ? 2 : 1
      }
    }
  }

  // Hysteresis: promote weak pixels 8-connected to strong ones.
  const out = new Uint8Array(size)
  const stack = new Int32Array(size)
  let sp = 0
  for (let i = 0; i < size; i++) {
    if (map[i] === 2) { out[i] = 255; stack[sp++] = i }
  }
  while (sp > 0) {
    const idx = stack[--sp]
    const x = idx % width
    const y = (idx - x) / width
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const n = ny * width + nx
        if (map[n] === 1 && !out[n]) { out[n] = 255; stack[sp++] = n }
      }
    }
  }
  return out
}

// ── Dilate (3×3, binary) ─────────────────────────────────────────────────────

export function dilate3(bin, width, height) {
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(height - 1, y + 1)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(width - 1, x + 1)
      let v = 0
      for (let yy = y0; yy <= y1 && !v; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (bin[yy * width + xx]) { v = 255; break }
        }
      }
      out[y * width + x] = v
    }
  }
  return out
}

// ── External contours (Moore-neighbor boundary tracing) ─────────────────────
//
// Equivalent to findContours(RETR_EXTERNAL): only the outermost boundary of
// each 8-connected component. After tracing a boundary, the whole component
// is flood-filled as visited so interior structure never starts a contour.

// Clockwise neighbor ring starting East
const DX8 = [1, 1, 0, -1, -1, -1, 0, 1]
const DY8 = [0, 1, 1, 1, 0, -1, -1, -1]

function traceBoundary(bin, width, height, sx, sy) {
  const pts = [sx, sy]
  const fg = (x, y) => x >= 0 && y >= 0 && x < width && y < height && bin[y * width + x] !== 0

  // Start pixel is the topmost-leftmost of its component → its West neighbor
  // is background. bDir = direction from current pixel to its backtrack.
  const startBDir = 4  // West
  let cx = sx, cy = sy, bDir = startBDir
  const maxSteps = 4 * width * height

  for (let step = 0; step < maxSteps; step++) {
    // Scan clockwise from just after the backtrack; first foreground = next.
    let found = -1
    for (let i = 1; i <= 8; i++) {
      const d = (bDir + i) % 8
      if (fg(cx + DX8[d], cy + DY8[d])) { found = d; break }
    }
    if (found < 0) break   // isolated pixel

    // New backtrack: the (background) neighbor checked just before `found`,
    // expressed as a direction from the NEW pixel. Consecutive ring positions
    // are always 8-neighbors of each other, so this is well-defined.
    const prevD = (found + 7) % 8
    const bx = cx + DX8[prevD], by = cy + DY8[prevD]
    cx += DX8[found]; cy += DY8[found]
    let nb = -1
    for (let d = 0; d < 8; d++) {
      if (cx + DX8[d] === bx && cy + DY8[d] === by) { nb = d; break }
    }
    bDir = nb

    // Jacob's stopping criterion: back at the start with the same backtrack.
    if (cx === sx && cy === sy && bDir === startBDir) break
    pts.push(cx, cy)
  }
  return pts
}

function floodFillVisited(bin, visited, width, height, sx, sy) {
  const stack = [sy * width + sx]
  visited[sy * width + sx] = 1
  while (stack.length) {
    const idx = stack.pop()
    const x = idx % width
    const y = (idx - x) / width
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d], ny = y + DY8[d]
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const n = ny * width + nx
      if (bin[n] && !visited[n]) { visited[n] = 1; stack.push(n) }
    }
  }
}

/** Returns an array of contours, each a flat [x0,y0,x1,y1,...] array. */
export function findExternalContours(bin, width, height) {
  const visited = new Uint8Array(width * height)
  const contours = []
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const idx = row + x
      if (!bin[idx] || visited[idx]) continue
      contours.push(traceBoundary(bin, width, height, x, y))
      floodFillVisited(bin, visited, width, height, x, y)
    }
  }
  return contours
}

// ── Contour measurements ─────────────────────────────────────────────────────

export function contourArea(pts) {
  const n = pts.length / 2
  let area = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]
  }
  return Math.abs(area) / 2
}

export function arcLength(pts) {
  const n = pts.length / 2
  let len = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    len += Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1])
  }
  return len
}

// ── approxPolyDP (closed, Douglas-Peucker) ───────────────────────────────────

function lineDist(pts, i, a, b) {
  const ax = pts[a * 2], ay = pts[a * 2 + 1]
  const bx = pts[b * 2], by = pts[b * 2 + 1]
  const px = pts[i * 2], py = pts[i * 2 + 1]
  const dx = bx - ax, dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return Math.hypot(px - ax, py - ay)
  return Math.abs(dx * (py - ay) - dy * (px - ax)) / len
}

// Simplify the arc pts[a..b] (indices increasing, endpoints kept); appends
// interior kept indices + endpoint b to `out` (assumes a already appended).
function dpArc(pts, a, b, eps, out) {
  if (b - a < 2) { if (b > a) out.push(b); return }
  let maxDist = 0, maxIdx = -1
  for (let i = a + 1; i < b; i++) {
    const d = lineDist(pts, i, a, b)
    if (d > maxDist) { maxDist = d; maxIdx = i }
  }
  if (maxDist > eps) {
    dpArc(pts, a, maxIdx, eps, out)
    dpArc(pts, maxIdx, b, eps, out)
  } else {
    out.push(b)
  }
}

/** Douglas-Peucker on a closed contour. Returns flat [x,y,...] polygon. */
export function approxPolyDP(pts, eps) {
  const n = pts.length / 2
  if (n < 3) return pts.slice()

  // Anchor the closed curve at point 0 and its farthest point, then simplify
  // both arcs independently (standard closed-curve DP splitting).
  let far = 0, farDist = -1
  const x0 = pts[0], y0 = pts[1]
  for (let i = 1; i < n; i++) {
    const d = (pts[i * 2] - x0) ** 2 + (pts[i * 2 + 1] - y0) ** 2
    if (d > farDist) { farDist = d; far = i }
  }
  if (far === 0) return [x0, y0]

  const keep = [0]
  dpArc(pts, 0, far, eps, keep)
  // Second arc: far → n-1 → (wrap) 0. Work on a reindexed view.
  const wrapped = []
  for (let i = far; i < n; i++) wrapped.push(pts[i * 2], pts[i * 2 + 1])
  wrapped.push(x0, y0)
  const keep2 = []
  dpArc(wrapped, 0, wrapped.length / 2 - 1, eps, keep2)

  const out = []
  for (const i of keep) out.push(pts[i * 2], pts[i * 2 + 1])
  for (const i of keep2) {
    if (i === 0 || i === wrapped.length / 2 - 1) continue  // endpoints already present
    out.push(wrapped[i * 2], wrapped[i * 2 + 1])
  }
  return out
}

// ── Convex hull + minimum-area rectangle ─────────────────────────────────────

function convexHull(pts) {
  const n = pts.length / 2
  const idx = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => (pts[a * 2] - pts[b * 2]) || (pts[a * 2 + 1] - pts[b * 2 + 1]))
  const cross = (o, a, b) =>
    (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) -
    (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2])
  const hull = []
  for (const i of idx) {                      // lower
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop()
    hull.push(i)
  }
  const lower = hull.length + 1
  for (let k = idx.length - 2; k >= 0; k--) { // upper
    const i = idx[k]
    while (hull.length >= lower && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop()
    hull.push(i)
  }
  hull.pop()
  return hull.map(i => [pts[i * 2], pts[i * 2 + 1]])
}

/** Minimum-area bounding rectangle. Returns [{x,y}×4] or null. */
export function minAreaRectPoints(pts) {
  if (pts.length < 6) return null
  const hull = convexHull(pts)
  if (hull.length < 3) return null

  let best = null
  for (let e = 0; e < hull.length; e++) {
    const [ax, ay] = hull[e]
    const [bx, by] = hull[(e + 1) % hull.length]
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 1e-9) continue
    const ux = (bx - ax) / len, uy = (by - ay) / len   // edge direction
    const vx = -uy, vy = ux                            // perpendicular
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
    for (const [px, py] of hull) {
      const u = px * ux + py * uy
      const v = px * vx + py * vy
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const area = (maxU - minU) * (maxV - minV)
    if (!best || area < best.area) best = { area, ux, uy, vx, vy, minU, maxU, minV, maxV }
  }
  if (!best) return null
  const { ux, uy, vx, vy, minU, maxU, minV, maxV } = best
  const corner = (u, v) => ({ x: u * ux + v * vx, y: u * uy + v * vy })
  return [corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV)]
}

// ── Perspective transform + warp ─────────────────────────────────────────────

/**
 * Solve the 3×3 homography mapping src[i] → dst[i] (4 point pairs).
 * Returns row-major Float64Array(9) with h22 = 1.
 */
export function perspectiveTransform(src, dst) {
  // 8×8 linear system A·h = b
  const A = []
  const b = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: X, y: Y } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X)
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y)
  }
  // Gaussian elimination with partial pivoting
  for (let col = 0; col < 8; col++) {
    let pivot = col
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r
    }
    if (Math.abs(A[pivot][col]) < 1e-12) return null
    ;[A[col], A[pivot]] = [A[pivot], A[col]]
    ;[b[col], b[pivot]] = [b[pivot], b[col]]
    for (let r = col + 1; r < 8; r++) {
      const f = A[r][col] / A[col][col]
      for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c]
      b[r] -= f * b[col]
    }
  }
  const h = new Float64Array(9)
  for (let r = 7; r >= 0; r--) {
    let sum = b[r]
    for (let c = r + 1; c < 8; c++) sum -= A[r][c] * h[c]
    h[r] = sum / A[r][r]
  }
  h[8] = 1
  return h
}

/**
 * Perspective-warp an RGBA image. `corners` are the source quad [TL,TR,BR,BL];
 * output is dw×dh with the quad mapped onto the full output rect.
 * Bilinear sampling, black outside the source.
 */
export function warpPerspectiveRGBA(src, sw, sh, corners, dw, dh) {
  const dstRect = [
    { x: 0, y: 0 }, { x: dw, y: 0 }, { x: dw, y: dh }, { x: 0, y: dh },
  ]
  // Inverse mapping (dst → src) solved directly — no matrix inversion needed.
  const H = perspectiveTransform(dstRect, corners)
  if (!H) return null

  const out = new Uint8ClampedArray(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const w = H[6] * x + H[7] * y + H[8]
      const sx = (H[0] * x + H[1] * y + H[2]) / w
      const sy = (H[3] * x + H[4] * y + H[5]) / w
      const o = (y * dw + x) * 4
      bilinearSample(src, sw, sh, sx, sy, out, o)
    }
  }
  return out
}

function bilinearSample(src, sw, sh, sx, sy, out, o) {
  const x0 = Math.floor(sx), y0 = Math.floor(sy)
  if (x0 < -1 || y0 < -1 || x0 >= sw || y0 >= sh) {
    out[o] = out[o + 1] = out[o + 2] = 0
    out[o + 3] = 255
    return
  }
  const fx = sx - x0, fy = sy - y0
  const x1 = x0 + 1, y1 = y0 + 1
  const cx0 = Math.min(sw - 1, Math.max(0, x0)), cx1 = Math.min(sw - 1, Math.max(0, x1))
  const cy0 = Math.min(sh - 1, Math.max(0, y0)), cy1 = Math.min(sh - 1, Math.max(0, y1))
  const p00 = (cy0 * sw + cx0) * 4, p10 = (cy0 * sw + cx1) * 4
  const p01 = (cy1 * sw + cx0) * 4, p11 = (cy1 * sw + cx1) * 4
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy)
  const w01 = (1 - fx) * fy, w11 = fx * fy
  for (let c = 0; c < 3; c++) {
    // `| 0` truncation after +0.5: Uint8ClampedArray assignment would
    // otherwise round the already-rounded value again (round-half-to-even).
    out[o + c] = (src[p00 + c] * w00 + src[p10 + c] * w10 + src[p01 + c] * w01 + src[p11 + c] * w11 + 0.5) | 0
  }
  out[o + 3] = 255
}

/**
 * Crop a source region and scale it to dw×dh with bilinear sampling —
 * the pure-JS equivalent of canvas drawImage(sx,sy,sw2,sh2 → 0,0,dw,dh).
 * Fast path: 1:1 region copy when no scaling is needed.
 */
export function bilinearCropResize(src, sw, sh, sx, sy, rw, rh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4)
  if (rw === dw && rh === dh && Number.isInteger(sx) && Number.isInteger(sy)) {
    for (let y = 0; y < dh; y++) {
      const srcOff = ((sy + y) * sw + sx) * 4
      out.set(src.subarray(srcOff, srcOff + dw * 4), y * dw * 4)
    }
    return out
  }
  const scaleX = rw / dw, scaleY = rh / dh
  for (let y = 0; y < dh; y++) {
    const fy = sy + (y + 0.5) * scaleY - 0.5
    for (let x = 0; x < dw; x++) {
      const fx = sx + (x + 0.5) * scaleX - 0.5
      bilinearSample(src, sw, sh, fx, fy, out, (y * dw + x) * 4)
    }
  }
  return out
}

/**
 * Area-average resize (INTER_AREA equivalent for downscaling): each output
 * pixel is the exact weighted average of the source rectangle it covers.
 */
export function areaResizeRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4)
  const scaleX = sw / dw, scaleY = sh / dh
  for (let j = 0; j < dh; j++) {
    const sy0 = j * scaleY, sy1 = (j + 1) * scaleY
    const iy0 = Math.floor(sy0), iy1 = Math.min(sh, Math.ceil(sy1))
    for (let i = 0; i < dw; i++) {
      const sx0 = i * scaleX, sx1 = (i + 1) * scaleX
      const ix0 = Math.floor(sx0), ix1 = Math.min(sw, Math.ceil(sx1))
      let r = 0, g = 0, b = 0, total = 0
      for (let y = iy0; y < iy1; y++) {
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0)
        const row = y * sw
        for (let x = ix0; x < ix1; x++) {
          const wx = Math.min(x + 1, sx1) - Math.max(x, sx0)
          const wgt = wx * wy
          const p = (row + x) * 4
          r += src[p] * wgt
          g += src[p + 1] * wgt
          b += src[p + 2] * wgt
          total += wgt
        }
      }
      const o = (j * dw + i) * 4
      out[o] = (r / total + 0.5) | 0
      out[o + 1] = (g / total + 0.5) | 0
      out[o + 2] = (b / total + 0.5) | 0
      out[o + 3] = 255
    }
  }
  return out
}

/** 180° rotation of an RGBA buffer (in a new buffer). */
export function rotate180RGBA(src) {
  const out = new Uint8ClampedArray(src.length)
  const n = src.length / 4
  for (let i = 0; i < n; i++) {
    const s = i * 4
    const d = (n - 1 - i) * 4
    out[d] = src[s]
    out[d + 1] = src[s + 1]
    out[d + 2] = src[s + 2]
    out[d + 3] = 255
  }
  return out
}

/** Median of a grayscale buffer via histogram (adaptive Canny thresholds). */
export function grayMedian(gray) {
  const hist = new Int32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const half = gray.length / 2
  let cumul = 0
  for (let v = 0; v < 256; v++) {
    cumul += hist[v]
    if (cumul >= half) return v
  }
  return 127
}
