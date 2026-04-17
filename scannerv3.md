# Scanner v3 — Dark Card Fixes + Tracking Frame

## Overview

Two independent improvements:

1. **Dark card quality fixes** — tuning the detection and hash pipeline so cards with dark art (Swamp, Reanimate, Phyrexian cards, etc.) and black-bordered cards scan as reliably as others. No re-seed of `card_hashes` required for any of these.
2. **Tracking frame** — replace the static centered reticle with a dynamic SVG overlay that snaps its corners to the detected card outline at ~15 fps, matching the Manabox-style UX.

---

## Part 1 — Dark Card Pipeline Fixes

### Fix 1 (Highest impact): Smaller blur for dark-edge Canny pass
**File:** `src/scanner/ScannerEngine.js`  
**Problem:** All three detection passes share the same 5×5 Gaussian pre-blur. On dark cards the border gradient is already faint; a 5-pixel kernel smears it below the Canny threshold, causing all three passes to fail and the reticle fallback to trigger.  
**Fix:** Thread a `blurSize` parameter through `findBestQuad`. Pass 2 (the dark-card low-threshold pass) should use a 3×3 kernel instead of 5×5. Pass 1 and Pass 3 keep 5×5.

```js
// findBestQuad signature change
function findBestQuad(cv, gray, width, height, cannyLo = -1, cannyHi = -1, blurSize = 5)

// Pass 2 call in detectCardCorners
const darkResult = findBestQuad(cv, gray, width, height, 5, 40, 3)
```

---

### Fix 2: Tighten adaptive Canny thresholds so Pass 1 ≠ Pass 2 on bright backgrounds
**File:** `src/scanner/ScannerEngine.js`  
**Problem:** On a bright background (white table, good lighting), `median * 1.5` → `hi ≈ 225`. This blows past the faint dark-border edge and makes Pass 1 useless. Pass 2 becomes the only real detection path.  
**Fix:** Cap the adaptive hi and lower the ratio so the two passes remain distinct across all lighting conditions.

```js
// Before
lo = Math.max(10, Math.round(median * 0.5))
hi = Math.min(240, Math.round(median * 1.5))

// After
lo = Math.max(5,  Math.round(median * 0.33))
hi = Math.max(60, Math.min(220, Math.round(median * 1.33)))
```

---

### Fix 3: Replace global `equalizeHist` in Pass 3 with CLAHE
**File:** `src/scanner/ScannerEngine.js`  
**Problem:** Global histogram equalization maps dark card borders and dark backgrounds to similar values, making the border harder to find, not easier. This is the exact opposite of the desired effect for dark-card-on-dark-background scenes.  
**Fix:** Replace `cv.equalizeHist` with a local-contrast CLAHE pass (OpenCV.js `cv.createCLAHE`) before re-running `findBestQuad`. Use conservative `clipLimit=2.0` to avoid noise-edge artifacts.

```js
// Pass 3
const clahe = cv.createCLAHE(2.0, new cv.Size(8, 8))
const claheMat = new cv.Mat()
clahe.apply(gray, claheMat)
clahe.delete()
const result = findBestQuad(cv, claheMat, width, height, 5, 40, 3)
claheMat.delete()
return result
```

---

### Fix 4: Dark art hash fallback (client-side only, no re-seed)
**Files:** `src/scanner/hashCore.js`, `src/scanner/ScannerEngine.js`  
**Problem:** For predominantly dark art, `percentileCap(0.98)` is a no-op (the 98th percentile pixel is already dark). CLAHE must handle all the dynamic range expansion on its own, but at 32×32 with 4×4 tiles (64 pixels/tile) the histograms are noisy. Camera noise causes 10–18 bit hash variance between frames of the same dark card, pushing marginal matches above `MATCH_THRESHOLD = 122`.  
**Fix:** Add a `computeHashFromGrayDark` variant in `hashCore.js` that linearly stretches the dark range before calling the standard pipeline. Mirror the existing foil-fallback pattern in `ScannerEngine.js`: trigger the dark variant only when the art crop's mean brightness is below 80 and the standard distance exceeds `MATCH_THRESHOLD`.

```js
// hashCore.js — new export
export function computeHashFromGrayDark(grayU8) {
  const sorted = grayU8.slice().sort((a, b) => a - b)
  const p95 = sorted[Math.floor(grayU8.length * 0.95)]
  const scale = p95 > 10 ? Math.min(3.0, 200 / p95) : 1.0
  const stretched = new Uint8Array(1024)
  for (let i = 0; i < 1024; i++)
    stretched[i] = Math.min(255, Math.round(grayU8[i] * scale))
  return computeHashFromGray(stretched)
}

// ScannerEngine.js — after foil fallback in tryMatch()
if (c && c.distance > MATCH_THRESHOLD) {
  const artGray = rgbToGray32x32(artCrop.data, 4)
  const mean = artGray.reduce((s, v) => s + v, 0) / artGray.length
  if (mean < 80) {
    const darkHash = computeHashFromGrayDark(artGray)
    // ...findBestTwoWithStats, updateBest...
  }
}
```

**Note:** This is purely additive and does not touch stored hashes. The dark variant is only used client-side as a third fallback path.

---

## Part 2 — Tracking Frame (Manabox-style)

### What changes

- **Remove:** The static centered `.targetFrame` div with four corner `<span>` brackets.
- **Remove:** The `liveCorners` canvas overlay (`cornerOverlayRef`) and its associated settings toggle.
- **Add:** A single full-screen SVG overlay that replaces both. The SVG draws an animated quadrilateral whose four corners snap to the detected card outline.

### Behaviour

| State | Frame appearance |
|---|---|
| No card detected | Four small L-shaped corner brackets at a fixed default position (card-ratio center of frame), dimmed at 30% opacity. |
| Card detected | Four brackets animate to the detected card corners, full opacity gold. The connecting lines between brackets become visible as a thin border. |
| Match found (scan success) | All lines and corners flash green for ~400 ms, then return to gold. |
| Scanning in progress | Frame holds its last position; brackets dim slightly. |
| Any overlay open | Frame hidden. |

### Update rate

Corner detection already runs on every 3rd rAF frame (~10 fps). Increase the skip interval to every 2nd frame to hit ~15 fps, matching Manabox's responsiveness. The existing `scanningRef` guard is preserved so detection skips while a scan is running.

```js
// Current
if (frameCount % 3 !== 0) return

// New
if (frameCount % 2 !== 0) return
```

### Data flow

The corner detection loop currently computes `liveCardBounds` (a bounding box). Change it to emit `liveCorners` — the raw four screen-space corner points — instead. The SVG clips these directly; no bounding-box conversion needed.

```js
// New state shape
const [detectedCorners, setDetectedCorners] = useState(null) // [{x,y}×4] in screen px, or null
```

The coordinate mapping (small-frame → full video → screen with cover scale) already exists at lines 661–673. Keep it, but output the four points directly instead of reducing to `{cx, cy, w, h}`.

### SVG overlay structure

Replace the `<div className={styles.targetFrame}>` and the `<canvas ref={cornerOverlayRef}>` with a single `<svg>` sized to `100vw × 100vh` positioned absolutely:

```jsx
<svg className={styles.trackingOverlay} aria-hidden="true">
  <polygon
    className={`${styles.trackingPoly} ${matched ? styles.trackingPolyMatch : ''}`}
    points={polyPoints}
  />
  {cornerPoints.map((pt, i) => (
    <g key={i} transform={`translate(${pt.x},${pt.y}) rotate(${CORNER_ROTATIONS[i]})`}>
      <path d="M0,0 L14,0 M0,0 L0,14" className={styles.trackingCorner} />
    </g>
  ))}
</svg>
```

- `CORNER_ROTATIONS = [0, 90, 180, 270]` — each corner L-bracket rotated to its quadrant.
- `polyPoints` — SVG points string from the four detected corners; empty when no card detected.
- The polygon is transparent fill, only stroke.
- CSS transitions on the `<polygon>` and `<g>` elements handle the smooth interpolation.

### CSS

Remove `.targetFrame`, `.targetFrameAutoScan`, `.corner`, `.tl`, `.tr`, `.bl`, `.br`, `.targetLit`, `.targetPaused` from `CardScanner.module.css`.

Add:

```css
.trackingOverlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}

.trackingPoly {
  fill: none;
  stroke: rgba(201,168,76,0.55);
  stroke-width: 1.5;
  transition: all 0.08s ease-out;
}
.trackingPolyMatch {
  stroke: rgba(93,186,112,0.95);
  stroke-width: 2;
}

.trackingCorner {
  stroke: rgba(201,168,76,0.9);
  stroke-width: 2.5;
  stroke-linecap: round;
  fill: none;
  transition: all 0.08s ease-out;
}
```

SVG element position interpolation is handled via CSS `transition` on the `transform` attribute of each `<g>`. Because SVG transforms are applied as DOM attributes (not CSS `left`/`top`), the transition must be on `transform` explicitly:

```css
.trackingCornerGroup {
  transition: transform 0.08s ease-out;
}
```

For React, update the `transform` attribute each render — React applies it as an SVG presentation attribute, and CSS transitions pick it up.

### Settings panel changes

- Remove the "Live corner overlay" toggle (the new tracking frame replaces it for all users — it is always on).
- The `liveCorners` localStorage key and state can be removed.

### Native (Capacitor) handling

The current reticle is DOM-based and works on native. The new SVG overlay is also DOM-based so the same approach applies. Keep the existing `!isNative` guard only for the `<video>` and `<canvas>` elements — the SVG overlay renders on both platforms.

---

## Implementation Order

| Step | Task | Files |
|---|---|---|
| 1 | Fix 1 — `blurSize` param in `findBestQuad`, Pass 2 uses 3×3 | `ScannerEngine.js` |
| 2 | Fix 2 — Tighten adaptive Canny thresholds | `ScannerEngine.js` |
| 3 | Fix 3 — CLAHE in Pass 3 replacing `equalizeHist` | `ScannerEngine.js` |
| 4 | Fix 4 — `computeHashFromGrayDark` + dark fallback in tryMatch | `hashCore.js`, `ScannerEngine.js` |
| 5 | Tracking frame — change detection loop to emit corner points | `CardScanner.jsx` |
| 6 | Tracking frame — replace `.targetFrame` div + `cornerOverlayRef` canvas with SVG overlay | `CardScanner.jsx` |
| 7 | Tracking frame — update CSS: remove old reticle rules, add SVG styles | `CardScanner.module.css` |
| 8 | Tracking frame — remove `liveCorners` state, localStorage key, settings toggle | `CardScanner.jsx` |
| 9 | Smoke-test on web: dark card, light card, foil, no-card, match flash, native build | — |

Steps 1–4 are fully independent of Steps 5–8 and can be implemented in either order.
