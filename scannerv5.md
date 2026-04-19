# Scanner v5 — Reliability Overhaul Plan

---

## ▶ HANDOFF STATUS (2026-04-19)

**Phase 1 is COMPLETE and shipping-ready.** `npx vite build` passes clean. No reseed needed for anything already merged.

### What's already done (Phase 1)

| Item | Where to verify |
|---|---|
| S1 — reticle fallback with source-gated acceptance | `CardScanner.jsx` `shouldAcceptMatch` now takes `source`; `scanSingleFrame` no longer has `cornersOnly` param; reticle branch always runs |
| A1 — 11 crop variants | `CardScanner.jsx` `PRIMARY_CROP_VARIANTS` |
| A2 — 90°/270° corner rotation | `ScannerEngine.js` exports `rotateCornersCW/CCW` + `rotateCard90CW/CCW`; wired in `scanSingleFrame` corners branch only |
| A4 — full linear-scan fallback | `DatabaseService.js` `findBestTwoFullScan`; wired at end of `scanSingleFrame` using `bestHashForFullScan` captured inside `updateBest` |
| B2 — blur gate | `ScannerEngine.js` `frameSharpness`; called right after `captureFrame` in `scanSingleFrame`; returns `{ status: 'blurry', sharpness }` |
| B3 — stability rework | Constants: `STABILITY_SAMPLES=5`, `SAMPLE_DELAY_MS=70`, `BLUR_THRESHOLD=25`, `MAX_FRAME_ATTEMPTS=10`; retry loop in `handleScan` skips blurry frames |
| B4 — desaturated-art guard | `DatabaseService.js` `popcountHash` + `COLOR_MIN_BITS=33`; applied in both `findBestTwoWithStats` and `findBestTwoFullScan` |
| B5 — dark cutoff 80→110 | `ScannerEngine.js` only (hashCore.js has no cutoff check) |
| S3 — auto-sync + manual button | `DatabaseService.js` `checkForUpdates()` + `getLastSyncTs()`; writes `scanner_last_sync_ts` meta key; `CardScanner.jsx` init effect auto-checks and fires background sync; "Card database" settings row with Refresh button |
| Cleanup | Deleted `scannerv4.md`, `cameraRestartTick` state, `computePHash256/Foil/Dark/Color` exports; pruned `scanner/index.js` to single `CardScanner` export; updated `CLAUDE.md` |

### Things the next agent should know

1. **Skipped piece of A2** (intentionally): for the reticle branch (no corners), rotating the 500×700 warped image 90° produces 700×500, which breaks `cropArtRegion`'s fixed-geometry assumption. The `rotateCard90CW/CCW` helpers are exported and tested but NOT wired into the reticle branch. Landscape cards are expected to be handled by corners. If the Phase 2 S2 (full-card hash) work is done, reticle landscape handling becomes less critical because the full-card hash will catch the card at any rotation. Decide during Phase 2 whether to also wire reticle-90° — probably not worth it.

2. **Full-scan fallback tracks `bestHashForFullScan`** — this is the hash of the best-scoring *variant attempt*, not necessarily the final best. It's captured in `updateBest` via new params `hashUsed`/`colorHashUsed`. Phase 2 S2 needs to plumb `fullHash` through here too (pass a 3rd param or bundle into an object).

3. **`shouldAcceptMatch` has a new `source` parameter.** Reticle-prefixed sources get stricter gating. Corner+rot90/rot270 do NOT get the reticle treatment (they start with `corners+`, not `reticle`). This is intentional.

4. **Build verified** with `npx vite build` after Phase 1. No test runner in project — CLAUDE.md notes "There is no test runner configured." Manual testing only.

5. **Phase 2 items below (Section 3) are UNTOUCHED.** Section 1 (reseed strategy) and Section 3 (B1/A3/S2) are the remaining work. Section 4 cleanup is already done.

### Phase 2 execution order (for next session)

Do these in one bundle — do NOT ship B1, A3, or S2 individually. They all change stored hash format and must reseed together.

1. **Schema migration** (Section 1) — add `phash_hex_full TEXT`, drop `hash_part_1..4`. Clients already read `phash_hex` exclusively so dropping BIGINT cols is safe.
2. **B1** — pure-JS blur+resize in `hashCore.js`. Replace `resizeArtTo32` (OpenCV) and the `sharp.blur()+resize()` in the seed script with identical JS. See Section 3/B1 for full code.
3. **A3** — 384-bit zigzag hash. Ripples through `hexToHash`/`hashToHex`/`hammingDistance`/`BAND_SPECS` (16→24 bands)/`rowToHash`/`popcountHash` (update COLOR_MIN_BITS to ~50). See Section 3/A3.
4. **S2** — full-card hash column. `computeAllHashes(artImageData, warpedCard = null)` extended to return `fullHash`; `findBestTwoWithStats(hash, colorHash, fullHash)` takes min of art/full distance; second `_bandIndexFull` unioned in `_getCandidates`. Also plumb `warped` through `tryMatch` in `CardScanner.jsx`. See Section 3/S2.
5. **Run seed**: `node scripts/generate-card-hashes.js --reseed`
6. **Bump** `CACHE_VERSION = 4 → 5` in `DatabaseService.js`
7. **Deploy client after reseed finishes** (otherwise v5 clients will 0-match against v4 DB rows).

### Reminders / gotchas for Phase 2

- `computeAllHashes` signature change affects existing call in `CardScanner.jsx` `tryMatch`. Pass the appropriate warped source (either `warped` from corners branch, or `reticle` from reticle branch) as the 2nd arg.
- The full-scan fallback's `bestHashForFullScan` needs to carry `fullHash` too so the fallback can retry with full-card distance.
- `COLOR_MIN_BITS` currently 33 (for 256-bit). Raise to ~50 when A3 expands to 384-bit, otherwise threshold becomes proportionally too low.
- `BAND_SPECS` currently 16 × 6-bit bands across 8 words. For A3 (12 words), the plan suggests 24 × 6-bit bands (two per word). Update `_addToIndex` and `_getCandidates` to iterate the new band count.
- `CACHE_VERSION` bump auto-wipes IDB cache — clients re-download full DB on next scanner open. Expect a one-time ~5MB re-download per user.
- Coordinate deploy window: ideally run reseed during low-traffic period, then push client within ~1 hour of reseed completion.

---



**Goal:** eliminate the "card refuses to scan" class of failures by fixing every root cause from Tiers S, A, B of the review. Proper fixes only — no workarounds. Reseed is accepted where needed.

**Outcome after v5:**
- Auto-scan recovers cards when corner detection fails.
- Borderless / showcase / full-art / token cards match reliably.
- Landscape-held cards match.
- LSH index can no longer silently drop the correct card.
- Hash DB stays fresh without manual intervention.
- Seed and scanner pipelines produce bit-identical pixel values.
- More discrimination bits per hash → fewer close-call rejections.

---

## 1. Reseed strategy

All reseed-requiring items are **bundled into one reseed cycle** so users download new hashes only once.

**Reseed-required items:** S2 (full-card hash column), A3 (384-bit hash), B1 (pure-JS blur+resize).

**Schema changes (single migration):**
```sql
ALTER TABLE card_hashes ADD COLUMN phash_hex_full TEXT;
-- Existing phash_hex / phash_hex2 stay TEXT; contents change from 64 → 96 chars.
-- hash_part_1..4 BIGINT columns are dropped — readers already use phash_hex exclusively
-- (BigInt precision loss is documented in CLAUDE.md). One less write per row in the seed script.
ALTER TABLE card_hashes DROP COLUMN hash_part_1;
ALTER TABLE card_hashes DROP COLUMN hash_part_2;
ALTER TABLE card_hashes DROP COLUMN hash_part_3;
ALTER TABLE card_hashes DROP COLUMN hash_part_4;
```

**Cache invalidation:** bump `CACHE_VERSION` in `DatabaseService.js` from `4` → `5`. Clients with v4 IDB cache will re-download on next start.

**Reseed run:**
```
node scripts/generate-card-hashes.js --reseed
```

Re-seeding ~30k non-digital prints at concurrency=20 takes ~30–60 minutes. Coordinate with a maintenance window (or keep both versions live with a column-name flip).

---

## 2. Client-only fixes (ship before reseed)

These can all merge and deploy immediately. They do not change stored hashes.

### S1 — Reticle fallback in auto-scan

**Problem:** auto-scan refuses to hash when corner detection fails.

**Root cause:** `CardScanner.jsx:1255` passes `cornersOnly: isAutoScan`; `CardScanner.jsx:1214` skips the entire reticle branch when `cornersOnly` is true.

**Proper fix:**
1. Remove the `cornersOnly` parameter from `scanSingleFrame` entirely. Reticle branch always runs.
2. Match results already carry a `source` string (`corners`, `corners+rot180`, `reticle`, `reticle+rot180`, etc.). Propagate it through `handleScan` into `shouldAcceptMatch`.
3. In `shouldAcceptMatch`, gate reticle-sourced matches more strictly:

```js
function shouldAcceptMatch({ best, gap, stableCount, sameNameCluster, source }) {
  const isReticle = !!source && source.startsWith('reticle')
  if (!best) return { accepted: false, reason: 'no best candidate' }

  // Reticle-sourced matches require decisive confidence to prevent false
  // positives on incidental objects in the reticle zone.
  if (isReticle) {
    if (stableCount >= STABILITY_REQUIRED && sameNameCluster && best.distance <= MATCH_THRESHOLD)
      return { accepted: true, reason: 'reticle stable same-name cluster' }
    if (stableCount >= 1 && best.distance <= MATCH_STRONG_SINGLE && gap >= MATCH_MIN_GAP)
      return { accepted: true, reason: 'reticle single strong frame' }
    return { accepted: false, reason: 'reticle requires decisive confidence' }
  }

  // Existing corner-sourced criteria below (unchanged).
  if (stableCount >= STABILITY_REQUIRED && best.distance <= MATCH_THRESHOLD && gap >= MATCH_MIN_GAP)
    return { accepted: true, reason: 'stable threshold match' }
  /* … existing rules … */
}
```

**Files:**
- `src/scanner/CardScanner.jsx` — remove `cornersOnly` plumbing, thread `source` into `shouldAcceptMatch`.

**Acceptance test:** hold a card against a cluttered background where corner detection misses; auto-scan should still match it when centered in the reticle.

---

### A1 — Wider crop variants

**Problem:** small perspective-warp errors shift the art-crop window by more pixels than existing ±10 y-offset variants cover.

**Root cause:** `CardScanner.jsx:49–55` defines only 4 variants (center, ±10 y, one inset). No x-offset, no larger shifts.

**Proper fix:** expand to 11 variants ordered by estimated hit probability. `FAST_PRIMARY_VARIANTS` stays as the centered one only — happy path unchanged.

```js
const PRIMARY_CROP_VARIANTS = [
  { xOffset:   0, yOffset:   0 },                // center (fast path)
  { xOffset:   0, yOffset: -10 },
  { xOffset:   0, yOffset:  10 },
  { xOffset: -10, yOffset:   0 },
  { xOffset:  10, yOffset:   0 },
  { xOffset:   0, yOffset: -20 },
  { xOffset:   0, yOffset:  20 },
  { xOffset: -15, yOffset: -10 },
  { xOffset:  15, yOffset: -10 },
  { xOffset:   0, yOffset:   0, inset:  6 },
  { xOffset:   0, yOffset:   0, inset: 12 },
]
```

**Files:**
- `src/scanner/CardScanner.jsx:49–55` — replace the array.

**Acceptance test:** intentionally feed `warpCard` slightly off-center corners (simulate 10–15px perspective error); expanded variants should still recover a match.

---

### A2 — 90° rotation fallbacks

**Problem:** cards held landscape (tokens, split cards, user holding camera sideways) never match — only 180° rotation is covered.

**Root cause:** `rotateCard180` exists in `ScannerEngine.js:374`, but no 90°/270° handling.

**Proper fix:** rotate **corners** (not pixels) before `warpCard`. The perspective transform then produces an upright 500×700 card regardless of physical orientation. Cheaper than rotating the warped image and avoids dimension juggling.

Add to `ScannerEngine.js`:
```js
export function rotateCornersCW(pts)  { return [pts[3], pts[0], pts[1], pts[2]] }  // TL→TR→BR→BL cycled
export function rotateCornersCCW(pts) { return [pts[1], pts[2], pts[3], pts[0]] }
```

In `CardScanner.jsx` `scanSingleFrame`, after the existing corners + 180° passes, add:

```js
if (corners && shouldExpand()) {
  for (const [rotFn, label] of [[rotateCornersCW, 'corners+rot90'], [rotateCornersCCW, 'corners+rot270']]) {
    const rotatedCorners = rotFn(corners)
    const warpedRot = warpCard(imageData, rotatedCorners)
    if (warpedRot) {
      tryMatch(warpedRot, label, FAST_PRIMARY_VARIANTS)
      if (shouldExpand()) tryMatch(warpedRot, label, PRIMARY_CROP_VARIANTS.slice(1))
      if (!shouldExpand()) break
    }
  }
}
```

**For the reticle branch** (no corners available), rotate the warped output pixels instead — implement `rotateCard90CW` / `rotateCard90CCW` in pure JS similar to `rotateCard180`. Output dimensions swap (500×700 → 700×500); then re-warp into 500×700 via a scale fit. In practice, rotating pixels of a 500×700 ImageData to 700×500 and doing a fresh art crop at transposed coordinates `(ART_X, ART_Y)` after swapping is cleanest. Drop into `ScannerEngine.js`:

```js
export function rotateCard90CW(imageData) { /* transpose + column-reverse, new w×h = h×w */ }
export function rotateCard90CCW(imageData) { /* transpose + row-reverse */ }
```

…and in reticle branch, try both rotations' art crops when upright reticle pass fails.

**Files:**
- `src/scanner/ScannerEngine.js` — add four rotation helpers (2 corners, 2 pixels).
- `src/scanner/CardScanner.jsx:1197–1225` — extend corners branch and reticle branch.

**Acceptance test:** scan a token held sideways; a split card; commander card held upside-down at ~90°.

---

### A4 — Full linear-scan fallback

**Problem:** LSH band index drops cards with <2 band hits out of 16 (`DatabaseService.js:643`). A heavily distorted scan can miss the correct card even when true Hamming distance would be acceptable.

**Root cause:** LSH is a recall/speed tradeoff. No backup path when recall fails.

**Proper fix:** after all art-crop + rotation + reticle fallbacks fail (`bestObserved.distance > MATCH_THRESHOLD`), do one full linear scan over `_hashes`.

Add to `DatabaseService.js`:

```js
/** Skips LSH, iterates all hashes. ~80–150ms on a 30k DB. Use only as a last resort. */
findBestTwoFullScan(hash, colorHash = null) {
  if (!this._hashes.length) return { best: null, second: null, candidateCount: 0, totalCount: 0 }
  let best = null, second = null, bestDist = Infinity, secondDist = Infinity
  for (const card of this._hashes) {
    const lumaDist = hammingDistance(hash, card.hash)
    const d = (colorHash && card.hashColor && popcount(colorHash) >= 50)
      ? Math.round(0.65 * lumaDist + 0.35 * hammingDistance(colorHash, card.hashColor))
      : lumaDist
    if (d < bestDist) { second = best; secondDist = bestDist; best = card; bestDist = d }
    else if (d < secondDist) { second = card; secondDist = d }
  }
  return {
    best: best ? { ...best, distance: bestDist } : null,
    second: second ? { ...second, distance: secondDist } : null,
    candidateCount: this._hashes.length, totalCount: this._hashes.length,
  }
}
```

In `CardScanner.jsx` `scanSingleFrame`, add at the very end (after all reticle/rotation fallbacks):

```js
if (shouldExpand() && best && best.distance > MATCH_THRESHOLD) {
  // Last-resort linear scan using the primary (luma) hash of the best crop variant.
  // Uses the same art crop that produced bestObserved, not re-cropped.
  if (lastAttemptedHash) {
    const { best: fb, second: fs, candidateCount, totalCount } =
      databaseService.findBestTwoFullScan(lastAttemptedHash.hash, lastAttemptedHash.colorHash)
    updateBest(fb, fs, candidateCount, totalCount, bestVariant, `${bestSource}+fullscan`)
  }
}
```

`lastAttemptedHash` is captured inside `tryMatch` — store the hash+colorHash of the best-scoring variant so far so we don't recompute.

**Files:**
- `src/scanner/DatabaseService.js` — add `findBestTwoFullScan`, export `popcount` helper (or re-use internal 16-bit popcount).
- `src/scanner/CardScanner.jsx` — wire fallback at the end of `scanSingleFrame`.

**Acceptance test:** manually set `MATCH_THRESHOLD` temporarily low to force LSH drops; full scan should still recover.

---

### B2 — Motion/blur gate

**Problem:** auto-scan burns CPU on blurred frames and occasionally stability-votes on noise.

**Root cause:** no gate between `captureFrame` and hashing.

**Proper fix:** compute Laplacian variance on the small (640×360) grayscale frame before doing any OpenCV work. Skip frames below threshold.

Add to `ScannerEngine.js`:
```js
/** Laplacian-variance sharpness score on a grayscale Mat. Higher = sharper. Typical: 50 sharp, <20 blurry. */
export function frameSharpness(imageData) {
  if (!isOpenCVReady()) return Infinity  // fail-open: never block scans on missing CV
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
  } finally { src.delete(); gray.delete(); lap.delete(); mean.delete(); stddev.delete() }
}
```

In `CardScanner.jsx` `scanSingleFrame`, right after `captureFrame`:
```js
const sharpness = frameSharpness(smallImageData)
if (sharpness < BLUR_THRESHOLD) {
  return { status: 'blurry', stage: `sharpness ${sharpness.toFixed(0)}`, best: null, second: null, candidateCount: 0, totalCount: databaseService.cardCount }
}
```

**Threshold:** start at `BLUR_THRESHOLD = 25`. Tune on-device.

**In the retry loop:** if a frame is blurry, do not count it toward `STABILITY_SAMPLES`. Extend retries to `STABILITY_SAMPLES * 2` with early exit once decisive.

**Files:**
- `src/scanner/ScannerEngine.js` — add `frameSharpness`.
- `src/scanner/CardScanner.jsx` — gate + retry-loop accounting.

**Acceptance test:** intentionally shake the camera; scanner should log "blurry" and not advance stability counter.

---

### B3 — Stability voting timing

**Problem:** 3 samples × 40ms = 120ms window often lands entirely inside an autofocus hunt → all three frames blurry, no vote, rejection.

**Root cause:** `SAMPLE_DELAY_MS = 40` (`CardScanner.jsx:58`) is tuned for fast-through, not for AF-robust capture.

**Proper fix (combines with B2):**
- Raise `SAMPLE_DELAY_MS` to `70`.
- Extend `STABILITY_SAMPLES` max to `5` (was 3), but keep `STABILITY_REQUIRED = 2`. Early-exit on decisive still applies.
- Blurry frames (B2) don't count against sample budget — they're discarded and retried, up to 2× the sample count.

**Files:**
- `src/scanner/CardScanner.jsx:56–58` — constants.
- `src/scanner/CardScanner.jsx:1254–1276` — retry loop.

**Acceptance test:** scan a card while tapping the screen to force AF hunt; match rate should no longer collapse during focus transitions.

---

### B4 — Combined-distance guard for desaturated art

**Problem:** `0.65 * luma + 0.35 * color` weights color heavily. Cards with near-zero HSV saturation (many lands, grey-scale artifacts, certain planeswalkers) have uninformative color hashes — combining drags the correct card's distance up and makes gap-tests fail.

**Root cause:** `DatabaseService.js:593` unconditionally combines when `colorHash` is present.

**Proper fix:** skip color combine when the query's colorHash popcount is below ~50 (of 384 — scale for the new hash size from A3; pre-reseed this is ~33 of 256).

```js
findBestTwoWithStats(hash, colorHash = null) {
  // ...
  const useColor = colorHash && this._popcountAll(colorHash) >= COLOR_MIN_BITS
  for (const card of candidates) {
    const lumaDist = hammingDistance(hash, card.hash)
    const d = (useColor && card.hashColor)
      ? Math.round(0.65 * lumaDist + 0.35 * hammingDistance(colorHash, card.hashColor))
      : lumaDist
    // ...
  }
}
```

Where `COLOR_MIN_BITS` = 50 post-reseed (384-bit), 33 pre-reseed (256-bit). Define as a constant.

**Files:**
- `src/scanner/DatabaseService.js` — add helper + guard.

**Acceptance test:** scan a basic Wastes / grey-scale planeswalker; combined-distance rejection should not fire.

---

### B5 — Dark-hash cutoff too binary

**Problem:** dark-art fallback only runs when `mean < 80`. Cards in the 80–110 mean range (dusk, muted palettes) miss the fallback.

**Root cause:** hard cutoff in `ScannerEngine.js:440` and `hashCore.js:254` skip condition.

**Proper fix:** raise cutoff to 110. The dark fallback is only **used** when the primary match fails — no wasted work on well-lit cards.

```js
// hashCore.js
const mean = grayU8.reduce((s, v) => s + v, 0) / grayU8.length
if (mean >= 110) return null

// ScannerEngine.js computeAllHashes
darkHash: mean < 110 ? computeHashFromGrayDark(gray) : null,
```

**Files:**
- `src/scanner/hashCore.js:254`
- `src/scanner/ScannerEngine.js:441, 467`

**Acceptance test:** scan cards in the 80–110 brightness range; they should hit the dark-hash path when primary fails.

---

### S3 — Hash DB auto-sync + manual button

**Problem:** `DatabaseService.sync()` only runs when `cardCount === 0` (`CardScanner.jsx:653`). New Scryfall sets never reach users.

**Proper fix:**

1. **Auto-check on startup** — after the cache loads, fire a background delta check. If remote count exceeds local, trigger `sync()` without blocking the scanner.

   Add to `DatabaseService.js`:
   ```js
   async checkForUpdates() {
     if (!this._initialized || this._syncing) return { hasUpdates: false, delta: 0 }
     const remoteTotal = await this._fetchTotalCount().catch(() => 0)
     const localTotal  = this._hashes.length
     return { hasUpdates: remoteTotal > localTotal, delta: remoteTotal - localTotal, localTotal, remoteTotal }
   }
   ```

   In `CardScanner.jsx` init effect, after `setDbReady(true)`:
   ```js
   databaseService.checkForUpdates().then(({ hasUpdates, delta }) => {
     if (!hasUpdates || !mountedRef.current) return
     console.info(`[scanner] remote DB has ${delta} new hashes — syncing in background`)
     databaseService.sync(status => { if (mountedRef.current) setHashLoadInfo(status) }).catch(() => {})
   })
   ```

2. **Manual refresh button** — new row in settings overlay:
   ```jsx
   <div className={styles.settingsRow}>
     <div className={styles.settingsRowLabel}>
       <span className={styles.settingsRowTitle}>Card database</span>
       <span className={styles.settingsRowDesc}>
         {cardCount.toLocaleString()} cards loaded · Last synced {lastSyncTime}
       </span>
     </div>
     <button className={styles.settingsInlineBtn} onClick={handleManualSync} disabled={syncing}>
       {syncing ? 'Syncing…' : 'Refresh'}
     </button>
   </div>
   ```
   `lastSyncTime` comes from `getMeta('scanner_last_sync_ts')` (new key; write in `DatabaseService.sync()` on success).

**Files:**
- `src/scanner/DatabaseService.js` — add `checkForUpdates`, write `scanner_last_sync_ts`.
- `src/scanner/CardScanner.jsx` — init effect auto-check, settings row, state for syncing + lastSyncTime.
- `src/scanner/CardScanner.module.css` — no changes expected (reuse `settingsRow` / `settingsInlineBtn`).

**Acceptance test:** add a row to `card_hashes` remotely, reopen scanner — background sync picks it up. Manual button forces immediate sync at any time.

---

## 3. Reseed-required fixes (bundled)

All three items below flip to identical pixel/hash behavior and bump `CACHE_VERSION` to `5`. Implemented together.

### B1 — Pure-JS blur + resize (aligns seed & client)

**Problem:** seed uses `sharp.blur(1.0) + resize(kernel: 'lanczos3')` (6-tap), client uses `cv.GaussianBlur(5,5,σ=1) + resize(INTER_LANCZOS4)` (8-tap). Pixel values differ by small-but-nonzero amounts → noise floor on every match.

**Root cause:** different image libraries on each side, no library offers bit-identical kernels across both.

**Proper fix:** move blur + resize into pure JS in `hashCore.js`. Both seed and client call it. Single source of truth.

Add to `hashCore.js`:

```js
/**
 * 5×5 Gaussian blur (σ ≈ 1.0) on a planar grayscale buffer.
 * Separable convolution: horizontal pass then vertical pass.
 * Mirror-edge boundary handling to avoid darkening edges.
 */
export function gaussianBlur5(gray, width, height) {
  const K = [0.061, 0.242, 0.383, 0.242, 0.061]  // σ=1.0, normalized
  const tmp = new Float32Array(width * height)
  const out = new Uint8Array(width * height)
  // horizontal
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        const xk = Math.abs(x + k)
        const xi = xk >= width ? 2 * width - xk - 2 : xk
        acc += gray[row + xi] * K[k + 2]
      }
      tmp[row + x] = acc
    }
  }
  // vertical
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        const yk = Math.abs(y + k)
        const yi = yk >= height ? 2 * height - yk - 2 : yk
        acc += tmp[yi * width + x] * K[k + 2]
      }
      out[y * width + x] = Math.min(255, Math.max(0, Math.round(acc)))
    }
  }
  return out
}

/** Bilinear downsample to 32×32 from a Uint8 planar gray buffer. */
export function resizeTo32x32(gray, width, height) {
  const out = new Uint8Array(1024)
  const sx = width  / 32
  const sy = height / 32
  for (let y = 0; y < 32; y++) {
    const fy = (y + 0.5) * sy - 0.5
    const y0 = Math.max(0, Math.floor(fy))
    const y1 = Math.min(height - 1, y0 + 1)
    const ay = fy - y0
    for (let x = 0; x < 32; x++) {
      const fx = (x + 0.5) * sx - 0.5
      const x0 = Math.max(0, Math.floor(fx))
      const x1 = Math.min(width - 1, x0 + 1)
      const ax = fx - x0
      const p00 = gray[y0 * width + x0]
      const p10 = gray[y0 * width + x1]
      const p01 = gray[y1 * width + x0]
      const p11 = gray[y1 * width + x1]
      const top = p00 * (1 - ax) + p10 * ax
      const bot = p01 * (1 - ax) + p11 * ax
      out[y * 32 + x] = Math.round(top * (1 - ay) + bot * ay)
    }
  }
  return out
}

/**
 * Full pipeline from raw RGB(A) art pixels to 32×32 gray.
 * Shared by client (ScannerEngine) and seed script — identical values both sides.
 */
export function preprocessArtTo32x32Gray(rgba, width, height, channels = 4) {
  const gray = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const off = i * channels
    gray[i] = Math.round(0.299 * rgba[off] + 0.587 * rgba[off + 1] + 0.114 * rgba[off + 2])
  }
  const blurred = gaussianBlur5(gray, width, height)
  return resizeTo32x32(blurred, width, height)
}

/** Saturation-channel variant for color hash. Matches luma pipeline except for channel extraction. */
export function preprocessArtTo32x32Sat(rgba, width, height, channels = 4) {
  const sat = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const off = i * channels
    const r = rgba[off] / 255, g = rgba[off + 1] / 255, b = rgba[off + 2] / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    sat[i] = max === 0 ? 0 : Math.round((max - min) / max * 255)
  }
  const blurred = gaussianBlur5(sat, width, height)
  return resizeTo32x32(blurred, width, height)
}
```

**Client (`ScannerEngine.js`):** remove OpenCV blur + resize. `resizeArtTo32` becomes:
```js
function resizeArtTo32(artImageData) {
  return preprocessArtTo32x32Gray(artImageData.data, artImageData.width, artImageData.height, 4)
}
```
…and rewrite `computeAllHashes` to call `preprocessArtTo32x32Gray` + `preprocessArtTo32x32Sat` once each.

**Seed (`generate-card-hashes.js`):** Sharp keeps doing the `resize(500,700) + extract(art region)` — just stops at raw pixels. Then JS pipeline takes over:
```js
const { data: artRaw, info: artInfo } = await sharp(imageBuffer)
  .resize(CARD_W, CARD_H, { fit: 'fill' })
  .extract({ left: ART_X, top: ART_Y, width: ART_W, height: ART_H })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })

const gray = preprocessArtTo32x32Gray(artRaw, artInfo.width, artInfo.height, artInfo.channels)
const sat  = preprocessArtTo32x32Sat(artRaw, artInfo.width, artInfo.height, artInfo.channels)
const hash      = computeHashFromGray(gray)
const colorHash = computeHashFromGray(sat)
```

Both sides now execute bit-identical JS from raw pixels through hash.

**Files:**
- `src/scanner/hashCore.js` — add `gaussianBlur5`, `resizeTo32x32`, `preprocessArtTo32x32Gray`, `preprocessArtTo32x32Sat`.
- `src/scanner/ScannerEngine.js` — rewrite `resizeArtTo32`, update all `computePHash256*` callers (soon to be deleted — see cleanup item 5).
- `scripts/generate-card-hashes.js` — swap sharp blur+resize for JS preprocess helpers.

---

### A3 — 384-bit hash via zigzag coefficients

**Problem:** 256 bits of low-frequency DCT coefficients are not enough to separate visually similar cards; distances cluster within `MATCH_MIN_GAP`.

**Root cause:** `hashCore.js:203–205` picks only the top-left 16×16 DCT block.

**Proper fix:** pick the first 384 coefficients in **zigzag order** (classical JPEG ordering). This includes DC + broad low-frequency coverage plus enough mid-frequency diagonals to discriminate texture-heavy art, while still being stable across small pixel shifts.

Precompute zigzag indices at module load:
```js
const ZIGZAG_384 = buildZigzag(32, 32, 384)  // returns Uint16Array of length 384 with linear DCT indices

function buildZigzag(N, M, count) {
  const out = new Uint16Array(count)
  let i = 0, r = 0, c = 0, dir = 1
  while (i < count) {
    out[i++] = r * M + c
    if (dir === 1) {
      if (c === M - 1) { r++; dir = -1 }
      else if (r === 0) { c++; dir = -1 }
      else { r--; c++ }
    } else {
      if (r === N - 1) { c++; dir = 1 }
      else if (c === 0) { r++; dir = 1 }
      else { r++; c-- }
    }
  }
  return out
}
```

Rewrite `computeHashFromGray` selection step:
```js
const coeffs = new Float64Array(384)
for (let i = 0; i < 384; i++) coeffs[i] = dct[ZIGZAG_384[i]]

let sum = 0
for (let i = 1; i < 384; i++) sum += coeffs[i]
const mean = sum / 383

const hash = new Uint32Array(12)        // 384 bits = 12 × 32
for (let i = 0; i < 384; i++) {
  if (coeffs[i] > mean) hash[i >>> 5] |= 1 << (i & 31)
}
return hash
```

**Ripple changes:**
- `hexToHash` / `hashToHex` — handle 96-char hex, 12 Uint32 words.
- `hammingDistance` — iterate 12 words.
- `BAND_SPECS` in `DatabaseService.js` — 24 bands × 6 bits across 12 words (two bands per word). Update `_getCandidates` accordingly.
- `rowToHash` — `new Uint32Array(12)`.
- `augmentWithParsed` — no change (wraps opaque hash).

**Files:**
- `src/scanner/hashCore.js` — build zigzag, rewrite `computeHashFromGray`, `computeHashFromGrayGlare`, `computeHashFromGrayDark`, update hex helpers + hammingDistance.
- `src/scanner/DatabaseService.js` — update `BAND_SPECS`, `rowToHash`.
- `scripts/generate-card-hashes.js` — emits 96-char hex automatically.

---

### S2 — Full-card hash column

**Problem:** fixed art-crop geometry (`ART_X=38, Y=66, W=424, H=248`) misses full-art, borderless, showcase, token, and retro-frame cards — their art is not in that box.

**Root cause:** single hash per card, computed from one fixed region.

**Proper fix:** store a **second hash of the entire warped 500×700 card**, downsampled to 32×32. At match time, compute both hashes on the scanned card and take the minimum distance. Standard-frame cards still rely on the art hash (cleaner signal); non-standard cards fall back to the full-card hash (captures frame, name area, mana pip colors, art extent).

**Seed side** — add to `computePHashHex`:
```js
// Existing art-crop pipeline (unchanged — uses ART_X/Y/W/H)
// ...art raw → gray → hash (phash_hex) + sat → colorHash (phash_hex2)

// NEW: full-card hash — hash the entire 500×700 warp, no extraction
const { data: fullRaw, info: fullInfo } = await sharp(imageBuffer)
  .resize(CARD_W, CARD_H, { fit: 'fill' })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })
const fullGray = preprocessArtTo32x32Gray(fullRaw, fullInfo.width, fullInfo.height, fullInfo.channels)
const fullHash = computeHashFromGray(fullGray)
const hex3     = hashToHex(fullHash)

return { hex, hex2, hex3 }  // hex3 = phash_hex_full
```

**Client side** — `ScannerEngine.js`:
```js
/** Hashes the entire warped card (no art extraction). Used for borderless / full-art / token cards. */
export function computeFullCardHash(warpedCardImageData) {
  const gray = preprocessArtTo32x32Gray(warpedCardImageData.data, CARD_W, CARD_H, 4)
  return computeHashFromGray(gray)
}
```

Rewrite `computeAllHashes` to accept an optional `warpedCard` second argument:
```js
export function computeAllHashes(artImageData, warpedCard = null) {
  const rgba = artImageData.data
  const gray = preprocessArtTo32x32Gray(rgba, artImageData.width, artImageData.height, 4)
  const mean = gray.reduce((s, v) => s + v, 0) / gray.length
  const sat  = preprocessArtTo32x32Sat(rgba, artImageData.width, artImageData.height, 4)
  return {
    hash:      computeHashFromGray(gray),
    foilHash:  computeHashFromGrayGlare(gray),
    darkHash:  mean < 110 ? computeHashFromGrayDark(gray) : null,
    colorHash: computeHashFromGray(sat),
    fullHash:  warpedCard ? computeFullCardHash(warpedCard) : null,
  }
}
```

**Matcher side** — `DatabaseService.js`:
- `rowToHash` now parses `phash_hex_full` into `hashFull`.
- `findBestTwoWithStats(hash, colorHash, fullHash)` computes two candidate distances per card — art-distance and full-distance — and picks the minimum:

```js
for (const card of candidates) {
  const artDist  = hammingDistance(hash, card.hash)
  const fullDist = (fullHash && card.hashFull) ? hammingDistance(fullHash, card.hashFull) : Infinity
  let d = Math.min(artDist, fullDist)
  if (useColor && card.hashColor) {
    d = Math.round(0.65 * d + 0.35 * hammingDistance(colorHash, card.hashColor))
  }
  // rank as before
}
```

**Band index:** build a second `_bandIndexFull` over `card.hashFull` so `_getCandidates` unions candidates matching either art or full-card bands. Cards with strong full-card signal still surface even if art LSH drops them.

**`CardScanner.jsx` `tryMatch`:** pass the warped card alongside the art crop:
```js
const tryMatch = (cardImg, warpedForFull, sourceLabel, variants) => {
  for (const variant of variants) {
    const artCrop = cropArtRegion(cardImg, variant)
    if (!artCrop) continue
    const hashes = computeAllHashes(artCrop, warpedForFull)
    // ...
    databaseService.findBestTwoWithStats(hashes.hash, hashes.colorHash, hashes.fullHash)
  }
}
// callers pass `warped` (corners branch) or `reticle` (reticle branch) as warpedForFull.
```

**Files:**
- Schema migration (see section 1).
- `scripts/generate-card-hashes.js` — emit `phash_hex_full`.
- `src/scanner/ScannerEngine.js` — add `computeFullCardHash`, extend `computeAllHashes`.
- `src/scanner/DatabaseService.js` — parse `phash_hex_full`, build `_bandIndexFull`, extend `findBestTwoWithStats` and `findBestTwoFullScan` signatures, update `_getCandidates` to union both indices.
- `src/scanner/CardScanner.jsx` — plumb warped card through `tryMatch`.

**Acceptance test:** scan a borderless Chandra, an Arabian Nights basic, a showcase planeswalker, a creature token. All should match despite non-standard art layout.

---

## 4. Cleanup items (bundle with v5 PR)

No behavioral impact, but the review flagged them as leftovers. Including here so they land in the same commit range.

1. **Delete `scannerv4.md`** — items applied, file obsolete.
2. **Delete `cameraRestartTick` state** (`CardScanner.jsx:411, 731`) — setter never called, dead.
3. **Delete individual `computePHash256*` exports** (`ScannerEngine.js:416–453`) — all callers moved to `computeAllHashes`.
4. **Reduce `src/scanner/index.js`** — only `CardScanner` is imported externally. Drop the rest.
5. **Update `CLAUDE.md`** — scanner pipeline section still references `computePHash256` / `computePHash256Foil`. Replace with `computeAllHashes` + note the new 384-bit zigzag hash + full-card hash column.

---

## 5. Implementation order

**Phase 1 — client-only (merge as one PR, ship immediately):**
1. S1 — reticle in auto-scan with source-gated acceptance.
2. A1 — wider crop variants.
3. A2 — 90°/270° rotation fallbacks (corners + pixels).
4. A4 — full linear-scan fallback.
5. B2 — blur gate + sharpness function.
6. B3 — stability timing + sample budget rework.
7. B4 — desaturated-art combined-distance guard.
8. B5 — dark-hash cutoff raised to 110.
9. S3 — auto-check on startup + manual refresh button in settings.
10. Cleanup items 1–5.

**Phase 2 — reseed bundle (coordinate with maintenance window):**
11. Schema migration (add `phash_hex_full`, drop `hash_part_*`).
12. B1 — pure-JS blur+resize in `hashCore.js`; update seed + client to call it.
13. A3 — 384-bit zigzag hash in `hashCore.js`; update hex helpers, hammingDistance, BAND_SPECS.
14. S2 — full-card hash column, client + seed + matcher plumbing.
15. Run `node scripts/generate-card-hashes.js --reseed`.
16. Bump `CACHE_VERSION = 5` in `DatabaseService.js`.
17. Deploy. Clients transparently re-download on next scanner open.

---

## 6. Testing

**Unit-level:**
- `hashCore.js` — golden-master test: identical input pixels produce identical `phash_hex` pre- and post-B1 migration (against a frozen test image and expected hex).
- `gaussianBlur5` / `resizeTo32x32` — output matches seed-script output within 0 pixel error.
- `rotateCornersCW/CCW` / `rotateCard90CW/CCW` — round-trip four applications returns original.
- `ZIGZAG_384` — first 10 indices match expected JPEG zigzag sequence.

**Integration-level:**
- A set of 30 known-failing cards from real-world reports (collect during phase 1 rollout via `DEBUG=true` session logs). Each should match in v5.
- Borderless / showcase / token / split / token card set — at least one of each, should match after phase 2.
- Auto-scan with intentional blur; stability voting should still succeed after B2/B3.

**Field test checklist (post-deploy):**
- [ ] Sessions with session-stats match rate ≥ 90% across 50-card test piles (standard + mixed-layout).
- [ ] Borderless Secret Lair drop matches within 3 scans.
- [ ] Landscape-held token matches within 3 scans.
- [ ] Manual refresh button triggers sync and updates card count.
- [ ] Adding one new row to `card_hashes` triggers background sync on next open.

---

## 7. Risks

- **Reseed downtime** — during the ~30–60 min reseed, clients running mid-scan may see mixed old+new hashes if deployed before reseed completes. Mitigation: deploy client v5 changes only after reseed finishes, or gate client-side on `scanner_cache_version === 5` (which triggers full re-download).
- **Full-card hash over-matches on standard-frame cards** — many standard-frame commons look similar from afar. Mitigation: the matcher takes `min(artDist, fullDist)`, so full-card distance only wins when it's distinctly better. Monitor via session-stats after phase 2 ship.
- **Blur threshold miscalibration** — too strict → users can't scan steady cards; too loose → no-op. Mitigation: expose threshold in settings (hidden under "advanced"), default to 25, tune on device reports.
- **Linear fallback latency on slow devices** — 30k × 12-word Hamming = ~150ms on mid-tier Android. Visible pause. Mitigation: only fires on already-failing scans; acceptable since alternative was "no match at all."
