import { describe, it, expect } from 'vitest'
import {
  gaussianBlurGray, canny, dilate3,
  findExternalContours, contourArea, arcLength, approxPolyDP, minAreaRectPoints,
  perspectiveTransform, warpPerspectiveRGBA, bilinearCropResize, areaResizeRGBA,
  rotate180RGBA, grayMedian,
} from './visionCore.js'
import { detectCardCorners } from './ScannerEngine.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeGray(w, h, fill = 0) {
  return new Uint8Array(w * h).fill(fill)
}

function makeRGBA(w, h, [r, g, b] = [0, 0, 0]) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255
  }
  return data
}

// Fill a convex quad (corners in order) using half-plane tests — an
// implementation independent of the warp code under test.
function fillQuadRGBA(data, w, h, corners, [r, g, b]) {
  const inside = (x, y) => {
    for (let i = 0; i < 4; i++) {
      const a = corners[i], c = corners[(i + 1) % 4]
      if ((c.x - a.x) * (y - a.y) - (c.y - a.y) * (x - a.x) < 0) return false
    }
    return true
  }
  const xs = corners.map(p => p.x), ys = corners.map(p => p.y)
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(h - 1, Math.ceil(Math.max(...ys))); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(w - 1, Math.ceil(Math.max(...xs))); x++) {
      if (inside(x + 0.5, y + 0.5)) {
        const p = (y * w + x) * 4
        data[p] = r; data[p + 1] = g; data[p + 2] = b
      }
    }
  }
}

function rotatedRectCorners(cx, cy, rw, rh, angleRad) {
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad)
  // Clockwise from TL so half-plane fill (cross ≥ 0) works.
  return [
    { x: -rw / 2, y: -rh / 2 }, { x: rw / 2, y: -rh / 2 },
    { x: rw / 2, y: rh / 2 }, { x: -rw / 2, y: rh / 2 },
  ].map(p => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos }))
}

// ── primitives ───────────────────────────────────────────────────────────────

describe('gaussianBlurGray', () => {
  it('keeps a uniform image uniform', () => {
    const out = gaussianBlurGray(makeGray(16, 16, 137), 16, 16, 5)
    expect(out.every(v => v === 137)).toBe(true)
  })

  it('spreads an impulse with binomial weights', () => {
    const img = makeGray(9, 9, 0)
    img[4 * 9 + 4] = 255
    const out = gaussianBlurGray(img, 9, 9, 5)
    // center weight for [1,4,6,4,1]/16 separable: (6/16)² × 255 ≈ 35.9
    expect(out[4 * 9 + 4]).toBeGreaterThanOrEqual(35)
    expect(out[4 * 9 + 4]).toBeLessThanOrEqual(37)
    expect(out[0]).toBe(0) // outside kernel radius
  })
})

describe('canny', () => {
  it('finds a vertical step edge and nothing else', () => {
    const w = 32, h = 32
    const img = makeGray(w, h, 0)
    for (let y = 0; y < h; y++) for (let x = 16; x < w; x++) img[y * w + x] = 200
    const edges = canny(img, w, h, 40, 120)
    let onEdge = 0, offEdge = 0
    for (let y = 4; y < h - 4; y++) {
      for (let x = 0; x < w; x++) {
        if (!edges[y * w + x]) continue
        if (Math.abs(x - 15.5) <= 1.5) onEdge++
        else offEdge++
      }
    }
    expect(onEdge).toBeGreaterThan(15)
    expect(offEdge).toBe(0)
  })

  it('returns no edges for a uniform image', () => {
    const edges = canny(makeGray(24, 24, 90), 24, 24, 30, 90)
    expect(edges.every(v => v === 0)).toBe(true)
  })
})

describe('dilate3', () => {
  it('grows a single pixel into a 3×3 block', () => {
    const img = makeGray(9, 9, 0)
    img[4 * 9 + 4] = 255
    const out = dilate3(img, 9, 9)
    let count = 0
    out.forEach(v => { if (v) count++ })
    expect(count).toBe(9)
    expect(out[3 * 9 + 3]).toBe(255)
    expect(out[2 * 9 + 2]).toBe(0)
  })
})

describe('findExternalContours', () => {
  it('traces the boundary of a filled rectangle', () => {
    const w = 40, h = 30
    const img = makeGray(w, h, 0)
    for (let y = 5; y < 15; y++) for (let x = 5; x < 25; x++) img[y * w + x] = 255
    const contours = findExternalContours(img, w, h)
    expect(contours.length).toBe(1)
    // Boundary polygon of a filled 20×10 block spans 19×9 pixel centers.
    expect(contourArea(contours[0])).toBe(19 * 9)
    expect(arcLength(contours[0])).toBeGreaterThan(2 * (19 + 9) - 4)
  })

  it('reports only the external contour of a ring (hole ignored)', () => {
    const w = 40, h = 40
    const img = makeGray(w, h, 0)
    for (let y = 5; y < 30; y++) {
      for (let x = 5; x < 30; x++) {
        const border = y < 8 || y >= 27 || x < 8 || x >= 27
        if (border) img[y * w + x] = 255
      }
    }
    const contours = findExternalContours(img, w, h)
    expect(contours.length).toBe(1)
    expect(contourArea(contours[0])).toBe(24 * 24)
  })

  it('finds two separate blobs as two contours', () => {
    const w = 40, h = 20
    const img = makeGray(w, h, 0)
    for (let y = 4; y < 10; y++) for (let x = 4; x < 10; x++) img[y * w + x] = 255
    for (let y = 4; y < 10; y++) for (let x = 24; x < 34; x++) img[y * w + x] = 255
    expect(findExternalContours(img, w, h).length).toBe(2)
  })

  it('handles a single isolated pixel', () => {
    const img = makeGray(10, 10, 0)
    img[5 * 10 + 5] = 255
    const contours = findExternalContours(img, 10, 10)
    expect(contours.length).toBe(1)
    expect(contours[0]).toEqual([5, 5])
  })
})

describe('approxPolyDP', () => {
  it('reduces a dense rectangle boundary to 4 corners', () => {
    const pts = []
    for (let x = 0; x <= 30; x++) pts.push(x, 0)
    for (let y = 1; y <= 20; y++) pts.push(30, y)
    for (let x = 29; x >= 0; x--) pts.push(x, 20)
    for (let y = 19; y >= 1; y--) pts.push(0, y)
    const approx = approxPolyDP(pts, 2)
    expect(approx.length).toBe(8)
    const corners = new Set()
    for (let i = 0; i < 8; i += 2) corners.add(`${approx[i]},${approx[i + 1]}`)
    expect(corners).toEqual(new Set(['0,0', '30,0', '30,20', '0,20']))
  })
})

describe('minAreaRectPoints', () => {
  it('recovers a rotated rectangle', () => {
    const corners = rotatedRectCorners(50, 40, 60, 30, 0.4)
    const pts = []
    // corners + points along each edge
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4]
      for (let t = 0; t < 1; t += 0.1) {
        pts.push(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
      }
    }
    const rect = minAreaRectPoints(pts)
    expect(rect).toHaveLength(4)
    const area = Math.abs(
      rect.reduce((s, p, i) => {
        const q = rect[(i + 1) % 4]
        return s + p.x * q.y - q.x * p.y
      }, 0) / 2,
    )
    expect(area).toBeGreaterThan(60 * 30 * 0.95)
    expect(area).toBeLessThan(60 * 30 * 1.1)
  })
})

describe('perspectiveTransform / warpPerspectiveRGBA', () => {
  it('solves a homography that maps the given points exactly', () => {
    const src = [{ x: 10, y: 5 }, { x: 90, y: 12 }, { x: 84, y: 70 }, { x: 4, y: 66 }]
    const dst = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 140 }, { x: 0, y: 140 }]
    const H = perspectiveTransform(src, dst)
    for (let i = 0; i < 4; i++) {
      const w = H[6] * src[i].x + H[7] * src[i].y + H[8]
      const X = (H[0] * src[i].x + H[1] * src[i].y + H[2]) / w
      const Y = (H[3] * src[i].x + H[4] * src[i].y + H[5]) / w
      expect(X).toBeCloseTo(dst[i].x, 6)
      expect(Y).toBeCloseTo(dst[i].y, 6)
    }
  })

  it('warps a rotated quad back to an upright card with quadrant colors intact', () => {
    const w = 200, h = 160
    const frame = makeRGBA(w, h, [10, 10, 10])
    const quad = rotatedRectCorners(100, 80, 80, 112, 0.3) // TL,TR,BR,BL
    // Paint each quadrant of the card a distinct color using sub-quads.
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    const center = { x: 100, y: 80 }
    const top = mid(quad[0], quad[1]), right = mid(quad[1], quad[2])
    const bottom = mid(quad[2], quad[3]), left = mid(quad[3], quad[0])
    fillQuadRGBA(frame, w, h, [quad[0], top, center, left], [200, 0, 0])     // TL red
    fillQuadRGBA(frame, w, h, [top, quad[1], right, center], [0, 200, 0])    // TR green
    fillQuadRGBA(frame, w, h, [center, right, quad[2], bottom], [0, 0, 200]) // BR blue
    fillQuadRGBA(frame, w, h, [left, center, bottom, quad[3]], [200, 200, 0])// BL yellow

    const out = warpPerspectiveRGBA(frame, w, h, quad, 100, 140)
    const px = (x, y) => { const p = (y * 100 + x) * 4; return [out[p], out[p + 1], out[p + 2]] }
    expect(px(25, 35)[0]).toBeGreaterThan(150)  // TL → red
    expect(px(75, 35)[1]).toBeGreaterThan(150)  // TR → green
    expect(px(75, 105)[2]).toBeGreaterThan(150) // BR → blue
    const bl = px(25, 105)                       // BL → yellow
    expect(bl[0]).toBeGreaterThan(150)
    expect(bl[1]).toBeGreaterThan(150)
  })
})

describe('areaResizeRGBA', () => {
  it('computes exact block averages for integer downscales', () => {
    const src = makeRGBA(4, 4)
    const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]
    vals.forEach((v, i) => { src[i * 4] = v; src[i * 4 + 1] = v; src[i * 4 + 2] = v })
    const out = areaResizeRGBA(src, 4, 4, 2, 2)
    expect(out[0]).toBe(Math.round((10 + 20 + 50 + 60) / 4))
    expect(out[4]).toBe(Math.round((30 + 40 + 70 + 80) / 4))
    expect(out[8]).toBe(Math.round((90 + 100 + 130 + 140) / 4))
    expect(out[12]).toBe(Math.round((110 + 120 + 150 + 160) / 4))
  })

  it('averages fractional source regions', () => {
    const src = makeRGBA(3, 1)
    ;[30, 60, 90].forEach((v, i) => { src[i * 4] = v })
    const out = areaResizeRGBA(src, 3, 1, 2, 1)
    // dst 0 covers src [0, 1.5): full px0 + half px1 → (30 + 0.5·60)/1.5 = 40
    expect(out[0]).toBe(40)
    expect(out[4]).toBe(80)
  })
})

describe('bilinearCropResize', () => {
  it('uses the exact-copy fast path for 1:1 integer crops', () => {
    const src = makeRGBA(8, 8)
    for (let i = 0; i < 64; i++) src[i * 4] = i
    const out = bilinearCropResize(src, 8, 8, 2, 3, 4, 2, 4, 2)
    expect(out[0]).toBe(3 * 8 + 2)
    expect(out[(1 * 4 + 3) * 4]).toBe(4 * 8 + 5)
  })
})

describe('rotate180RGBA', () => {
  it('round-trips to identity and swaps corners', () => {
    const src = makeRGBA(4, 2)
    src[0] = 111  // top-left red channel
    const once = rotate180RGBA(src)
    expect(once[(2 * 4 - 1) * 4]).toBe(111)  // bottom-right
    expect(Array.from(rotate180RGBA(once))).toEqual(Array.from(src))
  })
})

describe('grayMedian', () => {
  it('returns the histogram median', () => {
    const img = new Uint8Array([10, 10, 10, 200, 200, 220])
    expect(grayMedian(img)).toBe(10)
    expect(grayMedian(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(4)
  })
})

// ── end-to-end detection (ScannerEngine on synthetic frames) ─────────────────

describe('detectCardCorners (synthetic frames)', () => {
  function expectCornersClose(found, truth, tol) {
    expect(found).toHaveLength(4)
    for (const t of truth) {
      const nearest = Math.min(...found.map(p => Math.hypot(p.x - t.x, p.y - t.y)))
      expect(nearest).toBeLessThan(tol)
    }
  }

  it('finds a bright card rotated on a dark background', () => {
    const w = 640, h = 360
    const frame = { data: makeRGBA(w, h, [25, 28, 30]), width: w, height: h }
    const truth = rotatedRectCorners(320, 180, 190, 265, 0.18) // card ratio ≈ 0.717
    fillQuadRGBA(frame.data, w, h, truth, [205, 200, 190])
    const corners = detectCardCorners(frame, w, h)
    expectCornersClose(corners, truth, 6)
  })

  it('finds a dark card on a dark background (fallback passes)', () => {
    const w = 640, h = 360
    const frame = { data: makeRGBA(w, h, [22, 22, 24]), width: w, height: h }
    const truth = rotatedRectCorners(320, 180, 200, 280, -0.1)
    fillQuadRGBA(frame.data, w, h, truth, [58, 55, 60])
    const corners = detectCardCorners(frame, w, h)
    // Dilation + low-contrast passes shift corners slightly outward — a few
    // px on the half-res detection frame is well within warp tolerance.
    expectCornersClose(corners, truth, 8)
  })

  it('finds a neutral-black card on an equally-dark COLORED background (chroma pass)', () => {
    const w = 640, h = 360
    // Dark brown "wood" background: luma ≈ 0.299·46 + 0.587·22 + 0.114·14 ≈ 28.3
    const frame = { data: makeRGBA(w, h, [46, 22, 14]), width: w, height: h }
    // Neutral black border with the SAME luma (28): invisible to passes 1–3.
    const truth = rotatedRectCorners(320, 180, 195, 272, 0.12)
    fillQuadRGBA(frame.data, w, h, truth, [28, 28, 28])
    const corners = detectCardCorners(frame, w, h)
    expectCornersClose(corners, truth, 8)
    // …and confirm the luma passes alone genuinely cannot see it.
    expect(detectCardCorners(frame, w, h, { maxPasses: 3 })).toBeNull()
  })

  it('returns null when no card-like quad exists', () => {
    const w = 320, h = 180
    const frame = { data: makeRGBA(w, h, [40, 40, 40]), width: w, height: h }
    // A blob with wildly wrong aspect ratio
    fillQuadRGBA(frame.data, w, h, rotatedRectCorners(160, 90, 260, 30, 0), [200, 200, 200])
    expect(detectCardCorners(frame, w, h)).toBeNull()
  })
})
