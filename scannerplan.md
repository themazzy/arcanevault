# ArcaneVault Scanner — Performance & Accuracy Redesign Plan

> **Status**: Draft for review — no application code will be modified until explicit "GO".

---

## 1. Current State Analysis

### Files audited

| File | Lines | Role |
|---|---|---|
| `src/scanner/ScannerEngine.js` | 609 | OpenCV pipeline: detection, warp, crop, pHash256 |
| `src/scanner/DatabaseService.js` | 482 | Hash store: IDB cache, Supabase fetch, LSH band index, Hamming lookup |
| `src/scanner/CardScanner.jsx` | 883 | UI: camera, scan button, stability voting, OCR fallback, history |
| `src/scanner/constants.js` | 9 | Art crop geometry constants |
| `scripts/generate-card-hashes.js` | 291 | Seed script: downloads card images, computes pHash, uploads to Supabase |
| `src/lib/scanner.js` | 274 | Legacy Tesseract OCR + dHash (still used for OCR fallback) |

### Top 3 Performance Killers

#### 1. BigInt Hamming Distance — the hot loop bottleneck

`DatabaseService.popcount64()` uses a Brian Kernighan bit-counting loop on BigInt values. Each call does ~32 BigInt bitwise operations (XOR, AND, subtract). With 1500 LSH candidates × 4 hash parts = **6,000 popcount calls per scan**. BigInt operations are **10–100× slower** than equivalent Number/Uint32 operations in V8.

```
Current: ~6,000 × popcount64(BigInt) ≈ 192,000 BigInt ops per scan
Target:  Uint32Array[8] representation → native 32-bit bitops → ~10× speedup
```

This is the single biggest wall between "scan takes 300ms" and "scan takes 50ms" once candidates are identified.

#### 2. Main-Thread OpenCV Pipeline

`detectCardCorners()` runs the entire CV pipeline synchronously on the main thread:
- Allocates and deletes **8 OpenCV Mats** per call (src, gray, blurred, edges, dilated, contours, hier, kernel)
- Runs GaussianBlur + Canny + dilate + findContours on a **1920×1080** frame (2M pixels)
- Then `warpCard()` allocates 3 more Mats + a canvas round-trip
- Then `cropArtRegion()` creates another Mat + canvas
- Then `computePHash256()` creates 3 more Mats + canvas

Total: **~14 Mat allocations/deletions per frame**, all blocking the UI. On a mid-range Android phone, this freezes the thread for 80–200ms per frame.

#### 3. Hash Algorithm Mismatch Between Client and Seed Script

**Critical accuracy bug found.** The client pipeline has a `percentileCap(0.98)` glare-suppression step *between* grayscale conversion and CLAHE that the seed script does **not** have:

```
Client:  GaussianBlur → resize → BT.709 gray → percentileCap(0.98) → CLAHE → DCT
Seed:    sharp.blur(1.0) → resize → sharp.grayscale() → CLAHE → DCT
                                                    ^^^^ no percentileCap
```

This means live-scanned hashes differ from DB hashes, increasing Hamming distances across the board and degrading match accuracy. Additionally:

- `sharp`'s `.grayscale()` applies BT.601 weighting internally (0.2989R + 0.5870G + 0.1140B), while the client uses BT.709 (0.2126R + 0.7152G + 0.0722B). The difference is small but compounds.
- `sharp`'s `.blur(1.0)` uses a different Gaussian kernel size/shape than OpenCV's `GaussianBlur(5×5, σ=1.0)`.

These mismatches are likely adding **5–15 Hamming distance** to every comparison, directly eating into the threshold budget (112 out of 256 bits).

---

## 2. Proposed Changes

### Phase 1: Fix Hash Mismatch (Accuracy — highest priority)

**Goal**: Eliminate the systematic Hamming distance inflation caused by pipeline divergence.

| Change | File | Impact |
|---|---|---|
| Remove `percentileCap()` from client hash pipeline | `ScannerEngine.js:572` | Aligns client with seed script |
| OR: Add `percentileCap()` to seed script before CLAHE | `generate-card-hashes.js:141` | Aligns seed with client |
| Align grayscale formula in seed script to BT.709 | `generate-card-hashes.js:133-139` | Use explicit `0.2126R+0.7152G+0.0722B` instead of `sharp.grayscale()` |
| Align blur kernel in seed script | `generate-card-hashes.js:135` | Use `sharp.blur({ sigma: 1.0 })` with explicit 5×5 kernel, or switch client to match sharp's default |

**Decision needed**: Which direction to align?

- **Option A — Remove `percentileCap` from client**: Simpler, no re-seed required. But loses glare suppression for camera captures.
- **Option B — Add `percentileCap` to seed script + align grayscale/blur**: Better accuracy for real-world phone scans. **Requires full re-seed** (~30k+ cards, ~2 hours).
- **Option C — Rewrite seed script to use the exact same JS functions**: Extract `computePHash256`, `applyCLAHE`, `dct2d`, `percentileCap` into a shared module, use identical code in both client and seed. Use `sharp` only for image loading/resizing, then hand off raw pixel data to the shared hash functions. **Most reliable alignment.** Still requires re-seed.

**Recommendation**: Option C. The shared-code approach makes future drift impossible.

### Phase 2: Hamming Distance Speedup (Performance)

Replace BigInt hash representation with `Uint32Array[8]` for the in-memory hash store.

**Current** (`DatabaseService.js`):
```js
// Each hash = { p1: BigInt, p2: BigInt, p3: BigInt, p4: BigInt }
// popcount via Brian Kernighan loop on BigInt — ~32 iterations per 64-bit part
function popcount64(n) {
  let count = 0
  let val = BigInt.asUintN(64, n)
  while (val > 0n) { val &= val - 1n; count++ }
  return count
}
```

**Proposed**:
```js
// Each hash = Uint32Array(8)  — two 32-bit words per original 64-bit part
// popcount via lookup table on Uint32 — constant-time, no BigInt overhead
const POP_TABLE = new Uint8Array(65536)
for (let i = 0; i < 65536; i++) {
  let n = i; let c = 0
  while (n) { n &= n - 1; c++ }
  POP_TABLE[i] = c
}

function popcount32(n) {
  return POP_TABLE[n & 0xFFFF] + POP_TABLE[(n >>> 16) & 0xFFFF]
}

function hammingU32(a, b) {
  let d = 0
  for (let i = 0; i < 8; i++) d += popcount32((a[i] ^ b[i]) >>> 0)
  return d
}
```

**Expected speedup**: 10–30× for the Hamming distance hot loop. On 1500 candidates, this takes the lookup from ~15ms to <1ms.

The conversion happens at load time: `hexToHashParts` returns `Uint32Array(8)` instead of `{ p1, p2, p3, p4 }`. The band index keys shift to 32-bit operations. No changes to the DB schema or `phash_hex` storage format.

### Phase 3: Off-Main-Thread Processing (Performance + UX)

Move the CV + hash pipeline into a **Web Worker** so the UI thread stays responsive during scanning.

**Architecture**:
```
Main thread (CardScanner.jsx)
  → postMessage({ imageData, width, height }) to ScannerWorker
  ← onmessage({ best, second, gap, debug }) from ScannerWorker

ScannerWorker.js (new file)
  - Loads OpenCV.js inside the worker via importScripts()
  - Holds the hash database in worker memory
  - Runs: detectCardCorners → warp → crop → pHash → DB lookup
  - Returns match result to main thread
```

**Benefits**:
- Zero UI jank during scan — camera preview stays smooth
- Can run continuous background scanning instead of manual button press (future enhancement)
- Worker has its own memory space so large hash arrays don't fragment the main heap

**Constraints**:
- `ImageData` transfer uses structured clone (or `Transferable` for zero-copy)
- OpenCV.js loads via `importScripts()` in the worker — need to verify CDN script is worker-compatible
- Tesseract OCR fallback stays on main thread (it already uses its own worker internally)

**Risk**: OpenCV.js may not work inside a Web Worker if it depends on DOM APIs (`document.createElement('canvas')`). Audit needed — if it does, we use `OffscreenCanvas` (supported in Chrome 69+, Firefox 105+, Safari 16.4+). The CV functions that create temporary canvases (`warpCard`, `cropArtRegion`) would need refactoring to use `OffscreenCanvas` or pass raw Mat data.

### Phase 4: Reduce Mat Allocation Churn (Performance)

Reuse OpenCV Mats across frames instead of allocating/deleting per call.

**Current**: `detectCardCorners` creates 8 Mats, deletes them in `finally`. Every frame = 8 alloc + 8 free.

**Proposed**: Pre-allocate a pool of Mats at scanner init time, reuse across frames:
```js
class MatPool {
  constructor() {
    this.gray = null
    this.blurred = null
    this.edges = null
    this.dilated = null
    // ... allocated on first use at the required dimensions
  }

  ensureSize(width, height) {
    // Only reallocate if dimensions changed
    if (!this.gray || this.gray.rows !== height || this.gray.cols !== width) {
      this.dispose()
      this.gray = new cv.Mat(height, width, cv.CV_8UC1)
      // ...
    }
  }

  dispose() {
    this.gray?.delete()
    // ...
  }
}
```

**Expected impact**: Eliminates ~14 Mat allocs per frame → saves 5–15ms on mobile GPUs where WebAssembly memory allocation is slow.

### Phase 5: Tighten Match Thresholds (Accuracy)

After Phase 1 fixes the hash mismatch, the current threshold constants will likely need recalibration:

```js
// Current (inflated to compensate for hash mismatch)
const MATCH_THRESHOLD = 112        // ~44% of 256 bits can differ
const MATCH_MIN_GAP = 12
const MATCH_STRONG_THRESHOLD = 124
const MATCH_STRONG_SINGLE = 96
```

With aligned hashes, correct matches should cluster at distances **30–60** instead of the current 70–110 range. Thresholds can be tightened to:

```js
// Projected post-fix (calibrate with real data)
const MATCH_THRESHOLD = 80         // ~31% bit error tolerance
const MATCH_MIN_GAP = 18           // Wider gap = fewer false positives
const MATCH_STRONG_THRESHOLD = 96
const MATCH_STRONG_SINGLE = 64
```

**Calibration method**: After Phase 1 re-seed, run a test set of 50+ known cards through the scanner, log distances, and set thresholds at the 95th percentile of correct-match distances with a safety margin.

---

## 3. What I'm NOT Proposing (and why)

| Approach | Why not |
|---|---|
| **ORB/SIFT feature matching** | Requires storing keypoint descriptors per card (~2KB each × 30k cards = 60MB). Doesn't fit the offline-first IDB model. pHash at 32 bytes/card is 1000× more compact and sufficient with correct alignment. |
| **Full WASM rewrite** | OpenCV.js already runs as WASM. The bottleneck isn't CV speed — it's BigInt math and hash mismatch. WASM for the DCT alone saves <2ms. Not worth the complexity. |
| **Continuous auto-scan (no button)** | Good future enhancement but not a prerequisite. Current manual scan is fine for accuracy work. Can be added after Phase 3 (worker) makes it viable. |
| **Multi-stage verification pipeline** | The existing stability voting (3 frames, 2 required) + OCR fallback already implements multi-stage verification. Improving the underlying hash accuracy (Phase 1) is more impactful than adding more stages. |
| **Neural network card classifier** | Would require a ~5–20MB model, inference runtime, training infrastructure. Massive scope expansion for marginal gains over a corrected pHash. |

---

## 4. UI/UX Improvements

### Reticle Feedback

- **During scan**: Animate reticle corners inward slightly (2px squeeze) to signal "processing"
- **On match**: Flash reticle green + brief haptic (already exists, keep it)
- **On failure**: Flash reticle red briefly + shake animation (200ms CSS transform)
- **Corner detection indicator**: When `detectCardCorners` finds a quad, tint the reticle border gold before the scan completes — gives the user feedback that the card is properly framed

### Scan State Communication

Current debug panel is developer-only. For users, add a minimal status line below the reticle:
- "Position card in frame" (no corners detected)
- "Hold steady..." (corners detected, scanning)
- "Matched: [Card Name]" (success)
- "No match — try better lighting" (failure)

### Camera-to-WebView Bridge (Native)

The current `NATIVE_CAPTURE_SETTLE_MS = 120ms` delay before capture on native is a workaround for autofocus lag. Improvements:
- Use `CameraPreview.captureSample({ quality: 92 })` with **two rapid captures** (0ms and 60ms), pick the sharper one via `scoreFrameQuality` — already half-implemented, just needs the multi-capture wired in
- On web, the 1920×1080 capture resolution is good but consider 1280×720 for faster processing on low-end devices (the card only needs to fill ~40% of frame for the 5% minimum area filter)

---

## 5. Success Metrics

| Metric | Current (estimated) | Target | How to measure |
|---|---|---|---|
| **Correct match rate** (top-1, known cards) | ~70–80% | ≥ 92% | Test set of 50 cards, varied lighting |
| **False positive rate** | ~5–8% (inflated thresholds) | < 1% | Wrong card returned with "found" status |
| **Scan-to-result latency** (web, desktop) | ~400–600ms | < 250ms | `performance.now()` around `handleScan` |
| **Scan-to-result latency** (web, mobile) | ~600–1000ms | < 400ms | Same, on mid-range Android (Pixel 6a) |
| **UI thread block during scan** | 100% (all main thread) | < 5ms | Long task observer or manual timing |
| **Hash DB memory** (100k cards) | ~25MB (BigInt overhead) | ~12MB (Uint32Array) | `performance.memory` snapshot |
| **Time to first scan readiness** | 5–10s (full DB load) | < 3s (first page loaded = ready) | Already implemented, verify maintained |

---

## 6. Implementation Order & Dependencies

```
Phase 1 (Hash Alignment)          ← MUST be first — accuracy foundation
  ↓
Phase 5 (Threshold Calibration)   ← Depends on Phase 1 data
  ↓
Phase 2 (Uint32 Hamming)          ← Independent, pure performance
  ↓
Phase 4 (Mat Pool)                ← Independent, pure performance
  ↓
Phase 3 (Web Worker)              ← Largest refactor, benefits from stable API
```

Phases 2 and 4 can be done in parallel. Phase 3 is the riskiest (OpenCV.js + Worker compatibility) and should come last when the hash pipeline is stable.

---

## 7. Leaps in Logic / Assumptions

1. **The `percentileCap` mismatch is the primary accuracy drag.** I'm basing this on the fact that it's the only preprocessing step present in one pipeline but not the other. Confirmation requires running a side-by-side distance comparison with and without it on a sample of cards.

2. **BigInt is the Hamming distance bottleneck, not the band index.** The LSH band pruning already cuts candidates to ~1500. The remaining cost is dominated by popcount on those 1500. This assumption holds as long as the candidate set stays in this range — if threshold tightening (Phase 5) shrinks candidates further, the speedup is even larger.

3. **OpenCV.js can run inside a Web Worker.** The OpenCV.js build from the CDN may rely on DOM globals. If it does, Phase 3 either needs an `OffscreenCanvas` polyfill path or we scope it down to only moving the hash computation (post-warp) into a worker while keeping CV on the main thread.

4. **Phase 1 (hash alignment) will shift correct-match distances down by 10–20 points.** This is an educated guess based on the nature of the mismatches (percentileCap redistributes ~2% of pixel values, grayscale formula differs by small coefficients). The actual shift needs measurement.

5. **The current art crop ROI (`{x:38, y:66, w:424, h:248}` on a 500×700 card) is correct.** I'm not proposing to change the crop geometry. If accuracy remains low after Phase 1, the crop region should be validated against different card frame styles (standard, borderless, showcase, etc.).

---

**Awaiting your "GO" to begin implementation, starting with Phase 1.**
