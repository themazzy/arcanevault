export const CARD_W = 500
export const CARD_H = 700

// Inner artwork crop, inset from the decorative frame and name bar.
export const ART_X = 38
export const ART_Y = 66
export const ART_W = 424
export const ART_H = 248

// Tile grid for the per-tile art hashes (G×G tiles over the art crop).
// 0 = tiles DISABLED. Measured by scripts/scanner-grid-harness.js (2026-07,
// 400 probes, 1050-card lookalike-heavy pool): every grid REDUCED the
// same-name wrong-art margin under capture degradation (p10: base 60.2,
// 2×2 59.5, 3×3 55.1, 4×4 51.7) — under corner-detection error and blur the
// correct card's tile distances inflate faster than its whole-art distance,
// while wrong-art distances stay put. The machinery (tileHash.js, pack format
// v3, matchCore tile blend) is kept dormant and tested; to revisit, set a
// grid here, bump HASH_PIPELINE_VERSION to 8 in generate-card-hashes.js, and
// reseed — the client already supports v8 packs.
export const TILE_GRID = 0
