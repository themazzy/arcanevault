# Scanner V6 Plan

> Status: Draft execution plan. This document is intentionally detailed so a later coding session can execute it without re-researching the scanner.

## Goals

Scanner V6 should make card scanning more reliable, faster, and easier to maintain without changing the core user workflow.

Primary outcomes:

- Prevent duplicate/concurrent scan execution.
- Make multi-frame voting internally consistent.
- Improve full-art and borderless card corner detection.
- Make scanner startup more resilient offline and on native devices.
- Move toward a worker-based scan pipeline with safe fallback.
- Treat pHash mean-vs-median as a measured decision, not an assumption.
- Reject sideways cards instead of adding expensive 90/270-degree fallbacks.

## Current Context

Relevant files:

| File | Role |
| --- | --- |
| `src/scanner/CardScanner.jsx` | Scanner UI, camera capture, scan orchestration, stability voting, basket flow |
| `src/scanner/ScannerEngine.js` | OpenCV corner detection, perspective warp, art crop, pHash wrappers |
| `src/scanner/hashCore.js` | Core pHash math, DCT, CLAHE, color/special hash variants |
| `src/scanner/DatabaseService.js` | Hash DB startup, native SQLite, web IDB cache, Supabase sync, worker matching |
| `src/scanner/hashMatchWorker.js` | Worker-side hash matching |
| `src/scanner/constants.js` | Card/art geometry constants |
| `scripts/generate-card-hashes.js` | Seed script for Supabase `card_hashes` |

Recent scanner changes already made before this plan:

- Removed the visible scanner frame/reticle UI and its settings toggle.
- Removed the background corner-tracking loops that only supported the frame UI.
- Updated `ScannerEngine.js` candidate scoring to prefer larger, centered, card-shaped quads over smaller internal full-art rectangles.

Build state at the time of writing: `npm.cmd run build` passed after those changes.

## Design Decisions

Resolved decisions from planning:

1. Scope is full Scanner V6: correctness, speed, accuracy, maintainability, and worker pipeline.
2. pHash mean vs median remains a decision gate. Do not switch hash thresholding without benchmark data and a reseed plan.
3. Worker rewrite should be planned with feature detection and a current main-thread fallback.
4. 90-degree card handling should reject sideways cards instead of trying 90/270-degree fallbacks.
5. Format is hybrid: design rationale plus executable checklist.

Important constraint:

- IDB and Supabase hash data must stay compatible unless V6 explicitly increments versions and reseeds `card_hashes`.

## Phase 0: Baseline And Safety Harness

Goal: make later scanner changes measurable and reversible.

Tasks:

- Add lightweight scan telemetry in debug-only code paths:
  - total scan duration
  - capture duration
  - corner detection duration
  - warp/crop/hash duration
  - match duration
  - selected source: `corners`, `reticle`, `corners+rot180`, etc.
  - best distance and gap
- Keep telemetry off in normal UI unless `DEBUG` is true.
- Create a small manual test checklist in this file or a separate `scanner-test-cases.md`:
  - normal black-border card
  - full-art card
  - borderless card
  - dark card
  - foil/glare card
  - same card held upside down
  - card held sideways
  - web offline with partial cache
  - native startup with slow SQLite open
- Before major changes, record rough baseline behavior from a few real cards:
  - scan success/failure
  - average scan time
  - false match or duplicate add incidents

Acceptance criteria:

- Debug instrumentation does not alter scanner behavior.
- Production build succeeds.
- Baseline notes exist before larger algorithm changes.
- Manual test checklist exists at `scanner-test-cases.md`.

## Phase 1: Correctness Fixes

Goal: remove known race conditions and inconsistent acceptance logic before optimizing.

### 1.1 Use `scanningRef` As The Real Scan Lock

File: `src/scanner/CardScanner.jsx`

Problem:

- `handleScan()` currently guards on React state `scanning`, but React state updates are async.
- Two rapid calls can enter before `scanning` flips, allowing concurrent OpenCV/hash work.

Implementation:

- Change the early guard to use `scanningRef.current`.
- Set `scanningRef.current = true` before any async scan work.
- Preserve the final `finally` path that resets the ref.

Expected shape:

```js
if (!isReady || scanningRef.current || !mountedRef.current) return
scanningRef.current = true
setScanning(true)
```

Acceptance criteria:

- Rapid scan-button taps cannot start overlapping scans.
- Auto-scan timer cannot overlap with a manual scan.
- Build passes.

### 1.2 Fix Stable Vote Metadata

File: `src/scanner/CardScanner.jsx`

Problem:

- Stability voting counts by card id, but acceptance can use `gap`, `sameNameCluster`, `source`, or `variant` from a different observed frame.

Implementation:

- Store per-vote-bucket metadata:
  - `count`
  - `best`
  - `gap`
  - `sameNameCluster`
  - `source`
  - `variant`
  - optionally `candidateCount` and `totalCount`
- When choosing `stableVote`, use that bucket's metadata for `shouldAcceptMatch()`.
- Do not use global `bestObservedGap` to accept or reject a different voted card.

Acceptance criteria:

- The accepted card's distance/gap/source all come from the same vote bucket.
- Debug output, if shown, describes the accepted bucket rather than an unrelated best frame.
- Build passes.

### 1.3 Make Relaxed Stable Match Reachable Or Remove It

File: `src/scanner/CardScanner.jsx`

Problem:

- `MATCH_STRONG_THRESHOLD` accepts up to a looser distance, but only `result.status === 'found'` contributes votes.
- `scanSingleFrame()` marks found only at the stricter `MATCH_THRESHOLD`, so the relaxed branch is mostly unreachable.

Implementation options:

- Preferred: add "candidate vote" support for near matches.
  - Let `scanSingleFrame()` return best candidates even when status is `notfound`.
  - In multi-frame mode, add votes for candidates with distance <= `MATCH_STRONG_THRESHOLD`.
  - Only accept near matches after stability requirements are met and gap is good.
- Simpler fallback: remove the relaxed branch and keep only strict found votes.

Acceptance criteria:

- The code behavior matches the threshold names and comments.
- Near matches are either intentionally voted or the dead threshold is removed.
- No increase in false positives during manual test cases.

## Phase 2: Startup And Cache Resilience

Goal: make the scanner useful under flaky network/native startup conditions.

### 2.1 Prevent Native SQLite Timeout Races

File: `src/scanner/DatabaseService.js`

Problem:

- `_initSQLiteForStartup()` races `_initSQLite()` against a timeout.
- If timeout wins, `_initSQLite()` can still complete later and mutate `this._db`, causing mixed native/web state.

Implementation:

- Introduce a startup attempt token, e.g. `this._sqliteInitAttemptId`.
- `_initSQLite()` should either:
  - return a local connection object and let the caller commit it only if the attempt is current, or
  - check the active token before mutating `this._db`.
- On timeout, mark that attempt stale.
- Ensure late completion closes/discards its connection instead of mutating service state.

Acceptance criteria:

- A timed-out SQLite attempt cannot later switch the active DB under the service.
- Native fallback path is deterministic.
- Build passes.

### 2.2 Load Partial IDB Cache Before Network Fetch

File: `src/scanner/DatabaseService.js`

Problem:

- In web mode, partial cache can be ignored if network page 0 fails.
- A user with thousands of cached hashes can become unable to scan offline.

Implementation:

- Always load available cached IDB rows into memory first.
- Mark cache status as partial/incomplete if expected count or sync marker indicates missing rows.
- Start network sync afterward.
- Overlay fetched pages into memory and IDB as they arrive.
- If network fails, keep partial cache active and expose a non-fatal warning state.

Acceptance criteria:

- Scanner can match against partial cached hashes when offline.
- Startup status distinguishes "ready with partial cache" from "fully synced".
- No empty in-memory hash set if IDB has usable rows.

## Phase 3: Corner Detection And Orientation

Goal: improve card boundary detection without adding heavy new scan passes.

### 3.1 Validate Hybrid Quad Scoring

File: `src/scanner/ScannerEngine.js`

Current direction:

- Candidate scoring now prefers larger, centered, valid card-shaped quads.
- This is intended to reduce full-art/borderless cards selecting inner art rectangles.

Tasks:

- Test on full-art and borderless cards using `DEBUG` scan metadata.
- Tune weights only if real cards still pick inner rectangles.
- Watch for false positives from larger rectangular backgrounds.

Acceptance criteria:

- Full-art card crops include the physical card outline more often than before.
- Normal cards still detect reliably.
- Background rectangles do not consistently beat the card.

### 3.2 Reject Sideways Cards

Files:

- `src/scanner/ScannerEngine.js`
- `src/scanner/CardScanner.jsx`

Problem:

- Current aspect scoring uses `min/max`, so landscape quads can pass.
- A sideways card can warp into portrait and produce distorted art.

Implementation:

- Add orientation metadata to corner detection or quad metrics.
- Determine if the physical quad is portrait enough:
  - compare average vertical side length vs average horizontal edge length after ordering.
  - reject if `avgH <= avgW * portraitMargin`.
- Return a rejection reason such as `sideways` if practical.
- In manual scan, show existing "not found" behavior; optionally debug text can say "sideways".
- In auto-scan, do not attempt expensive 90/270 fallbacks.

Acceptance criteria:

- Sideways cards are rejected rather than mis-warped.
- Portrait cards at moderate perspective angles still pass.
- Upside-down portrait cards still work through the existing 180-degree fallback.

### 3.3 Conditional Detection Pass Order

File: `src/scanner/ScannerEngine.js`

Problem:

- `detectCardCorners()` can run adaptive, dark fixed threshold, then CLAHE.
- CLAHE is expensive, though it already only runs after earlier failures.

Implementation:

- Compute simple brightness/contrast/edge-energy metrics once from grayscale.
- Choose likely pass order:
  - bright/high contrast: adaptive first
  - dark/low contrast: fixed-low or CLAHE earlier
  - very low edge energy: skip some work and return null
- Preserve current passes as fallback until real testing proves a pass can be removed.

Acceptance criteria:

- No accuracy regression on dark cards.
- Average corner-detection time improves or remains stable.
- The code remains readable and debuggable.

## Phase 4: Scan Voting And Duplicate Control

Goal: reduce duplicate adds and false flips between similar cards.

### 4.1 Rework Stability Voting Around Buckets

File: `src/scanner/CardScanner.jsx`

Build on Phase 1.2:

- Store all metadata per candidate bucket.
- Prefer stable bucket over single-frame best unless single-frame best is very strong.
- Keep `sameNameCluster` logic scoped to the selected bucket.

Acceptance criteria:

- Debug output can explain why a candidate was accepted:
  - single strong frame
  - stable strict match
  - stable near match
  - same-name cluster

### 4.2 Reset Duplicate Suppression Based On Card Leave

File: `src/scanner/CardScanner.jsx`

Problem:

- Duplicate suppression currently relies on scan result/miss timing more than physical card departure.

Implementation:

- Track consecutive no-card or weak-card frames in auto-scan.
- Only clear the last accepted auto-scan signature after the card appears to have left the frame.
- Use corner detection presence or repeated notfound results as the leave signal.

Acceptance criteria:

- Auto-scan does not re-add the same stationary card.
- Auto-scan accepts the same card again after it is removed and reintroduced.

Implementation note:

- Implemented with consecutive auto-scan miss tracking. Duplicate suppression and cached corners reset after repeated no-match frames instead of immediately after a single miss.

## Phase 5: Hash Pipeline Decision Gate

Goal: decide mean vs median pHash with data before making a reseed-required change.

Important current fact:

- Documentation may say median threshold, but current implementation uses mean excluding DC.
- Runtime and seed currently share the implementation path closely enough that the scanner works.
- Switching to median requires a cache/version bump and full `card_hashes` reseed.

### 5.1 Benchmark Mean vs Median

Files:

- `src/scanner/hashCore.js`
- `scripts/generate-card-hashes.js`
- optional new script: `scripts/benchmark-scanner-hash.mjs`

Implementation:

- Add a local benchmark path that computes both mean-threshold and median-threshold hashes for a sample set.
- Use `npm run benchmark:scanner-hash -- <image-path-or-url> [...]` for local samples.
- Use controlled samples:
  - downloaded Scryfall art
  - simulated glare/brightness shifts
  - dark-card samples
  - full-art samples
  - same-art and similar-art printings
- Compare:
  - same-card Hamming distance under camera-like transforms
  - nearest wrong-card distance
  - gap between best and second
  - false positive risk

Acceptance criteria:

- A short benchmark report exists before any hash migration.
- Decision is explicit:
  - keep mean and update docs
  - switch to median and reseed
  - store both variants

### 5.2 If Keeping Mean

Tasks:

- Update comments in `hashCore.js`.
- Update `AGENTS.md` scanner hash algorithm notes.
- Update scanner planning docs if needed.

Acceptance criteria:

- Documentation accurately says mean excluding DC.
- No cache or DB migration required.

### 5.3 If Switching To Median

Tasks:

- Update `computeHashFromGray*` thresholding.
- Increment hash pipeline/cache version constants.
- Update seed script.
- Reseed `card_hashes`.
- Verify runtime reads `phash_hex TEXT` only; do not use JS numbers for hash parts.
- Rebuild local IDB cache.

Acceptance criteria:

- Seed and runtime produce matching hash semantics.
- Scanner still passes manual card set tests.
- Deployment includes a clear migration/reseed note.

## Phase 6: Speed Improvements Before Worker Rewrite

Goal: take low-risk wins before moving major work off-thread.

### 6.1 Reuse Native Capture Canvas

File: `src/scanner/CardScanner.jsx`

Problem:

- Native path creates a new canvas per capture.

Implementation:

- Add a native scratch canvas/ref similar to existing scratch canvases.
- Resize only when dimensions change.

Acceptance criteria:

- Native capture no longer allocates a canvas per scan frame.
- Build passes.

Implementation note:

- Implemented with a module-level native frame scratch canvas.

### 6.2 Reduce Foil/Dark Hash Attempts

File: `src/scanner/CardScanner.jsx`

Problem:

- Each crop variant can run standard, foil, and dark hash matching.

Implementation:

- Run standard hash first.
- Only try foil/dark if:
  - standard candidate is plausible, e.g. distance <= 150, or
  - glare/darkness metrics suggest that fallback is useful.
- Keep current behavior behind a debug/temporary flag if needed during validation.

Acceptance criteria:

- No visible accuracy drop in foil/dark manual tests.
- Average scan time improves on normal cards.

Implementation note:

- Implemented conservatively: foil/dark fallback matching runs only when the standard candidate is above the primary threshold but still plausible.

### 6.3 Cache Recent Quads In Auto-Scan

File: `src/scanner/CardScanner.jsx`

Problem:

- Auto-scan samples multiple frames and each can run full corner detection.

Implementation:

- Store last successful corner quad with timestamp.
- For the next 300-500 ms, try the cached quad first.
- If match is weak or crop is unusable, run full detection and refresh the cache.

Acceptance criteria:

- Auto-scan performs fewer full contour detections on a stationary card.
- Moving to a new card still refreshes quickly.
- No duplicate-add regression.

Implementation note:

- Implemented with a short-lived cached corner quad for auto-scan frames. Cache is invalidated after repeated misses or incompatible frame dimensions.

## Phase 7: Worker Pipeline With Fallback

Goal: move heavy frame processing off the main thread where browser/platform support allows it.

Design:

- Main thread owns:
  - camera preview
  - UI state
  - basket/add flow
  - settings
- Worker owns, when supported:
  - frame bitmap/canvas input
  - downscale
  - corner detection
  - warp
  - art crop variants
  - hash computation
  - hash matching

Fallback:

- If Worker + OffscreenCanvas + ImageBitmap path is unavailable or unstable, use current main-thread path.
- The fallback must stay tested because native Capacitor support may differ from desktop browsers.

Implementation steps:

1. Create a scanner worker module, e.g. `src/scanner/scanWorker.js`.
2. Define request/response protocol:
   - `init`
   - `loadHashes` or attach existing match worker/index
   - `scanFrame`
   - `cancel`
   - `debugStats`
3. Decide frame transfer format:
   - prefer `ImageBitmap` where available
   - fallback to `ImageData`
4. Port pure JS hash computation first.
5. Move matching into the same worker or coordinate with `hashMatchWorker.js`.
6. Move OpenCV only after verifying OpenCV.js can initialize reliably in the worker bundle.
7. Add feature detection and runtime fallback.

Acceptance criteria:

- UI remains responsive during scans on supported browsers.
- Unsupported platforms still scan through the existing main-thread fallback.
- Worker startup errors are visible in debug/status and do not silently break scanning.
- Build passes.

Implementation note:

- A feature-detected `scanWorker.js` now attempts off-main-thread OpenCV detection, warp, crop, rotation, and hash generation. Main thread still owns camera capture, vote orchestration, reticle fallback, and database matching. If worker OpenCV initialization fails, scanner falls back to the existing main-thread path.

## Phase 8: Optional Accuracy Expansion

These are not required for the first executable V6 but should remain design options.

### 8.1 Two-Stage Verifier

Candidate:

- After pHash top candidates, run a cheap verifier:
  - small color histogram
  - edge orientation histogram
  - ORB/AKAZE only if OpenCV.js build supports it

Acceptance criteria:

- Improves same-art/similar-art distinction without large latency.

### 8.2 Multiple Hashes Per Print

Candidate:

- Seed multiple hash variants per print:
  - current art crop
  - inset art crop
  - y-offset crops
  - color hash
  - possibly title/border hash

Trade-off:

- More storage and seed time, less runtime crop work, better robustness.

Acceptance criteria:

- Schema and cache versioning are documented before implementation.

## Phase 9: Documentation Cleanup

Goal: make scanner docs match current reality.

Tasks:

- Update `AGENTS.md` scanner pipeline notes after implementation decisions land.
- Normalize scanner comments that contain mojibake such as `â€”`, `â‰ˆ`, and `Ã—`.
- Update old planning docs only if they are actively referenced; otherwise leave them as historical.
- Document cache/hash version migration steps if pHash changes.

Acceptance criteria:

- Current scanner implementation and docs agree on:
  - hash thresholding method
  - crop geometry
  - corner detection passes
  - fallback behavior
  - cache invalidation requirements

## Phase 10: Dead Code And Maintenance Cleanup

Goal: remove scanner code that is no longer part of the active pipeline, after local search confirms it has no app imports.

Tasks:

- Remove unused scan-loop locals after the vote-bucket rewrite:
  - stale `bestObservedCandidates`
  - stale `bestObservedVariant`
  - stale `frameSummaries`
- Remove obsolete tracking-frame code after the frame UI removal:
  - `arcanevault_scanner_native_corner_tracking` setting reads/writes
  - tracking-only refs/state/helpers
  - unused tracking CSS classes
- Audit `src/scanner/index.js` barrel exports:
  - add current scanner APIs that are still meant to be public
  - remove exports that point to deleted helpers
  - confirm app code does not depend on stale legacy names
- Remove legacy single-variant hash wrapper exports from `ScannerEngine.js` only when all callers use `computeAllHashes()` or `hashCore.js` directly.
- Keep broad mojibake/comment normalization separate from behavioral changes unless the touched block is already being edited. Whole-file encoding cleanup should be its own commit because it creates noisy diffs.
- Search for dead scanner settings/localStorage keys and either remove them from runtime code or document them as harmless legacy client storage.

Acceptance criteria:

- `rg` shows no app references to removed scanner helpers.
- `npm.cmd run build` passes.
- Cleanup diffs are scoped to scanner files and the plan.
- No unrelated collection/page files are changed by cleanup.

## Suggested Execution Order

1. Phase 0: Baseline and debug telemetry.
2. Phase 1.1: `scanningRef` lock.
3. Phase 1.2 and 1.3: stable vote metadata and relaxed near-match logic.
4. Phase 2.2: partial IDB cache loading.
5. Phase 2.1: native SQLite timeout race.
6. Phase 3.1 and 3.2: validate hybrid quad scoring and reject sideways cards.
7. Phase 6: native canvas reuse, fewer fallback hashes, cached auto-scan quads.
8. Phase 5: pHash benchmark and decision.
9. Phase 7: worker pipeline with fallback.
10. Phase 8: optional verifier or multi-hash redesign.
11. Phase 9: documentation cleanup.
12. Phase 10: dead code and maintenance cleanup.

## Done Criteria For Scanner V6

Scanner V6 is done when:

- Production build passes.
- Manual scan and auto-scan cannot overlap.
- Stable voting uses metadata from the accepted candidate.
- Scanner can start with a partial IDB hash cache when network is unavailable.
- Native SQLite timeout cannot mutate DB state late.
- Full-art/borderless cards detect physical card bounds more reliably than before.
- Sideways cards are rejected rather than mis-warped.
- At least one measurable scan-speed improvement lands before worker work.
- Worker pipeline either ships with fallback or is explicitly deferred with blockers documented.
- pHash mean/median decision is documented with benchmark evidence.
- Current scanner docs match the implemented pipeline.
- Dead scanner helpers and stale exports are removed or explicitly retained with a reason.
