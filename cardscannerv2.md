# ArcaneVault Card Scanner v2 — Improvement Plan

> **Purpose:** Reference document for future sessions. Compares ArcaneVault's scanner to ManaBox (the leading MTG card scanner), identifies gaps, and lists prioritised improvements with enough implementation detail to execute without re-research.

---

## Sources used for research

- [ManaBox Scanner FAQ](https://www.manabox.app/guides/scanner/faq/)
- [ManaBox Getting Started Guide](https://manabox.app/guides/scanner/getting-started/)
- [ManaBox Review 2026 — Lotus Scan](https://www.scanyourmtg.com/review/manabox/)
- [CardSlinger FAQ & Tips](https://cardslinger.shop/pages/faq-tips)
- [Thoughtseize — MTG card recognition with OpenCV](https://thoughtseize.io/2020/07/10/recognizing-magic-the-gathering-cards-with-cpp-and-opencv/)

---

## 1. Feature Comparison

### ManaBox Features

| Feature | Detail |
|---|---|
| Recognition method | Artwork-based image hash (not OCR) |
| Quick Mode | Auto-selects first matching version; no confirmation step between scans |
| Set locking | Lock one or more sets; scanner rejects non-matching results |
| Audio feedback | 3-tier price sounds: silent (<$1), soft chime ($1–10), loud chime (>$10) |
| Minimum price threshold | Optional: suppress price display below $1 |
| Foil preference | Checkbox to default new scans to foil |
| Version correction | Tap set icon or "normal" label in result bar to swap printing immediately |
| Language per card | Select language per card in basket |
| Condition tracking | NM / LP / MP / HP / DMG per card |
| Purchase price | Optional: record what you paid per card |
| "Already owned" indicator | Visual badge if the scanned card is already in your collection |
| "Already on a list" indicator | Badge if card is on a wishlist |
| "In a deck" indicator | Badge if card is allocated to a deck |
| Bulk basket editing | Long-press in basket → bulk-select → batch change qty/foil/language/condition |
| Export from scanner | Export basket directly to CSV / Moxfield / Archidekt without saving first |
| Double-tap to focus | Manual camera autofocus trigger |
| Background requirement | Requires white/light background for reliable border detection |
| Speed (with stand) | ~60 cards/minute (≈1 second per card) |
| Platform | iOS + Android (native) |

### ArcaneVault Current Scanner Features

| Feature | Detail |
|---|---|
| Recognition method | 256-bit pHash on art crop; OpenCV perspective warp |
| Detection pipeline | 3-pass Canny (adaptive → fixed → equaliseHist); no white-background requirement |
| Multi-variant crops | 4 offset/inset variants tried per frame |
| 180° rotation fallback | Catches cards held upside-down |
| Foil fallback pHash | `percentileCap(0.92)` glare suppression when standard hash distance is high |
| Stability voting | Up to 3 frames, 2 votes required |
| LSH band index | Fast DB lookup (sub-linear) |
| IDB hash cache | Warm starts skip hex parsing; background page sync |
| Auto-scan mode | Continuous scanning with 1800ms (match) / 600ms (miss) cooldown |
| Same-card dedup | Auto-scan skips re-adding the same card ID until detection gap |
| Manual scan button | Tap-to-scan for when auto-scan is off |
| Reticle fallback | Center-crop used when corner detection misses the card (manual only) |
| Set locking | Lock to one set code |
| Foil preference | Prefer-foil setting persisted to localStorage |
| Basket | Pending cards with qty, foil, language, printing picker |
| Printing picker | All printings via Scryfall, R/F prices shown |
| Language selector | Per card in basket and in basket overlay |
| Manual search | Type card name if scan fails; Scryfall search |
| Flash/torch toggle | Works on native; Web Torch API on browser |
| Price per card | Shown in basket bar |
| Total session value | Sum of basket shown above reticle |
| Add flow | Pick binder/deck/wishlist + create new folder inline |
| Haptics | `Haptics.impact` on match (Capacitor native) |
| Debug strip | Hamming distance, gap, source, votes shown on screen (`DEBUG=true`) |
| Platform | Web (PWA) + native (Capacitor) |

---

## 2. Gap Analysis

### ManaBox has, ArcaneVault does not

| Gap | Priority | Effort |
|---|---|---|
| Audio feedback (price-tier tones) | HIGH | Low |
| Turn off debug strip for production | HIGH | Trivial |
| Reduce auto-scan cooldowns | HIGH | Trivial |
| Condition tracking (NM/LP/MP/HP/DMG) | HIGH | Medium |
| Live corner preview overlay | MEDIUM | Medium |
| Minimum price display threshold | LOW | Trivial |
| Multiple set locking | LOW | Low |

### ArcaneVault has, ManaBox does not (our advantages to keep/highlight)

- No white-background requirement — works on dark surfaces, carpet, wood
- 180° rotation fallback — catches upside-down cards
- Foil-specific pHash — more robust on shiny cards than ManaBox (which struggles)
- In-session total value tracking
- Printing picker with per-printing price comparison (R vs F prices)
- Create new folder inline from scanner

---

## 3. Prioritised Implementation Plan

### Priority 1 — Quick wins, high return (do first)

---

#### 1.1 Disable debug strip in production

**File:** `src/scanner/CardScanner.jsx` line 41  
**Change:** `const DEBUG = true` → `const DEBUG = false`  
**Why:** The debug strip (`dist: X gap: Y`) is currently shipping to users. It leaks internal metrics and looks unfinished.

---

#### 1.2 Reduce auto-scan cooldowns

**File:** `src/scanner/CardScanner.jsx` auto-scan loop (~line 1134)  
**Current:** match=1800ms, miss=600ms  
**New:** match=1000ms, miss=350ms

ManaBox achieves ~1 second per card total. Our match cooldown alone is 1.8s, which is the dominant bottleneck in bulk scanning. The stability sampling (3×40ms=120ms max) plus OpenCV processing (~50–100ms) means we can safely cut cooldowns significantly.

```js
const cooldown = scanResult === 'found' ? 1000 : 350
```

**Also consider:** adding a `scanResult === 'duplicate'` state (same card, no add) with only a 200ms cooldown so the loop re-checks quickly for the next card without the full match delay.

---

#### 1.3 Audio feedback (price-tier tones)

**New file:** `src/scanner/scanSounds.js`

Use the Web Audio API to generate synthetic tones — no audio files needed, no network requests.

```js
// Three distinct tones:
// Tier 0 (< threshold1): short low beep
// Tier 1 (threshold1–threshold2): two-tone chime
// Tier 2 (> threshold2): bright ascending chime

export function playMatchSound(priceValue) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  // Tier logic: < €0.50 → low beep, €0.50–€5 → mid chime, > €5 → bright chime
  // Use OscillatorNode + GainNode with short envelope (attack 5ms, release 150ms)
}
```

**Integration in `CardScanner.jsx`:** Call `playMatchSound(latestPriceMeta?.value ?? 0)` immediately after `setScanResult('found')` in `handleScan`.

**Settings:** Add toggle `scan_sounds` (on/off) + optional minimum threshold (default €0.50) to the scanner settings overlay. Persist to localStorage.

---

### Priority 2 — Significant UX improvements

---

#### 2.1 Condition tracking per card

**Goal:** Each basket entry gets a condition field: `NM | LP | MP | HP | DMG`.

**Changes:**
- `addToPending()` in `CardScanner.jsx`: add `condition: 'NM'` to the entry object.
- Bottom bar latest card actions: add a compact condition pill/cycle button between the foil button and remove button.
  ```
  [−] [qty] [+]  [setIcon]  [lang]  [foil✦]  [NM▾]  [✕]
  ```
  Tapping cycles NM → LP → MP → HP → DMG → NM (no dropdown needed for speed).
- Basket overlay: same condition cycle button per row.
- `saveAllPending()` / `batchSaveCards()`: pass condition through to the `cards` upsert. Supabase `cards` table needs a `condition` column (check schema; add migration if missing).
- `loadPending()` / `savePending()`: condition already persists via JSON, no change needed.

**Deduplication note:** Update the basket dedup check in `addToPending` to also match on `condition` (so NM and LP copies of the same card are separate rows).

---

### Priority 3 — Bigger features, ship when ready

---

#### 3.1 Live corner detection preview

**Goal:** Show the detected card corners as an overlay on the camera feed, so users can see in real time whether the scanner has found the card outline.

**Why:** ManaBox and other apps show a green highlight when card edges are detected. This gives instant feedback without needing to scan — users adjust card position/lighting based on the outline snapping to edges.

**Implementation:**
- This requires running `detectCardCorners` continuously on idle frames (not just during scan).
- Add a lightweight background loop (using `requestAnimationFrame`) that runs corner detection on the small frame canvas when `isReady && !scanning`.
- Store detected corners in a `liveCorners` state (debounced at ~15fps to avoid thrash).
- Draw a `<canvas>` overlay (positioned absolutely over the video) that draws the quadrilateral formed by the 4 corners in green/gold.
- Pause the preview loop during actual scan to avoid contention.

**Performance note:** Corner detection on the 640×360 small frame is cheap. The overlay canvas should use `requestAnimationFrame` with a frame-skip (detect every other frame = ~15fps on 30fps camera).

**Tradeoff:** Adds continuous OpenCV CPU work. Profile on low-end Android. If it tanks performance, gate it behind a settings toggle.

---

### Priority 4 — Polish / smaller items

---

#### 4.1 Minimum price display threshold

Add a `scan_min_price` setting (default 0, i.e. show all). In the bottom bar price display:
```js
const showPrice = latestPriceMeta && latestPriceMeta.value >= scanMinPrice
```

---

#### 4.2 Multiple set locking

Currently only one set code is locked. Allow locking multiple sets (stored as a Set in state/localStorage). The lock badge shows the count: "3 sets locked". Tap to manage.

---

#### 4.3 Scan session statistics

Show in the settings panel or as a small counter: cards scanned this session, success rate %, avg scan time. Reset on scanner close.

```js
const sessionStats = useRef({ attempts: 0, hits: 0, totalMs: 0 })
```

---

## 4. Performance Analysis vs ManaBox

| Metric | ManaBox | ArcaneVault Current | ArcaneVault v2 Target |
|---|---|---|---|
| Cards/min (with stand) | ~60 | ~25–35 (estimated) | ~45–55 |
| Match cooldown | ~600ms (estimated) | 1800ms | 1000ms |
| Miss cooldown | ~300ms (estimated) | 600ms | 350ms |
| Background requirement | White/light only | None (edge detection) | None |
| Foil handling | Poor (known issue) | Foil fallback pHash | Keep + tune thresholds |
| Upside-down cards | Unknown | 180° fallback | Keep |
| Debug info shown | No | Yes (DEBUG=true) | No (DEBUG=false) |

**Bottleneck breakdown for a single auto-scan cycle:**
```
captureFrame():        ~10–20ms  (drawImage GPU + getImageData)
detectCardCorners():   ~30–60ms  (OpenCV on 640×360)
warpCard():            ~10–20ms
computePHash256():     ~5–10ms   (DCT on 32×32)
findBestTwoWithStats(): ~5–15ms  (LSH index)
Stability loop:        up to 3 frames × 40ms delay = 120ms
Total per scan:        ~80–250ms
+ Match cooldown:      1800ms → target 1000ms
─────────────────────────────────────────────
Cycle time:            ~1.9–2.0s → target ~1.1–1.2s
```

To approach ManaBox's ~1s/card we need: lower cooldowns (plan 1.2) + optionally reduce `STABILITY_SAMPLES` to 2 in auto-scan mode (at the cost of slightly more false positives — tune against real-world data).

---

## 5. Architecture Notes for Implementers

- **`CardScanner.jsx`** — Main UI + state. All scan settings, basket logic, and the auto-scan loop live here.
- **`ScannerEngine.js`** — OpenCV pipeline. `detectCardCorners`, `warpCard`, `cropArtRegion`, `cropCardFromReticle`, `rotateCard180`.
- **`hashCore.js`** — Pure-JS pHash. `computePHash256`, `computePHash256Foil`. Must stay in sync with `scripts/generate-card-hashes.js`.
- **`DatabaseService.js`** — pHash DB: SQLite (native) + Supabase (web) + LSH index + IDB cache.
- **`constants.js`** — Shared dimensions: `CARD_W=500, CARD_H=700, ART_X=38, ART_Y=66, ART_W=424, ART_H=248`.
- **`CardScanner.module.css`** — All scanner styles.

**Key constraints:**
- Never change the pHash algorithm without re-seeding `card_hashes` in Supabase and bumping IDB version.
- `MATCH_THRESHOLD=122`, `MATCH_STRONG_THRESHOLD=134` are tuned — don't change without benchmarking against a test card set.
- The `cornersOnly=true` flag in auto-scan prevents reticle fallback (avoids false positives from background objects). Keep this.
- `lastAutoScanIdRef` prevents the same card being re-added when it stays in frame across auto-scan cycles.

---

## 6. Suggested Implementation Order

1. `DEBUG = false` (5 min) — ship immediately
2. Reduce cooldowns (5 min) — ship immediately
3. Audio feedback (2–3 hrs) — scan sound module + settings toggle
4. Condition tracking (3–4 hrs) — basket entry + UI + DB column
5. Live corner preview (4–6 hrs) — rAF loop + overlay canvas (profile first)
6. Minimum price threshold (30 min) — settings + display filter
7. Multiple set locking (2 hrs) — Set in state/localStorage + badge UI
8. Scan session statistics (1 hr) — ref counter + settings panel display

**Total estimated effort:** ~18–24 hrs for full v2
