/**
 * hashCard.js — seed-side hash computation (pipeline v7)
 *
 * Computes all stored hashes from a perfect 500×700 RGBA card render. Used
 * by scripts/generate-card-hashes.js, harnesses, and tests. Pure JS.
 *
 * v7 unifies the seed and client resize: both use areaResizeRGBA (exact
 * INTER_AREA-equivalent) for the 32×32 step. Before v7 the seed used Sharp's
 * mitchell kernel — a systematic few-bit bias against every live scan.
 *
 * Stored per row:
 *   phash_hex       — art-crop luma pHash (as before)
 *   phash_hex2      — art-crop saturation pHash (as before)
 *   phash_full_hex  — whole-card luma pHash (new in v7): frames, borders,
 *                     name bar, and set symbol differ between printings and
 *                     across cards even when art doesn't
 */

import { CARD_W, CARD_H, ART_X, ART_Y, ART_W, ART_H } from './constants.js'
import { computeHashFromGray, rgbToGray32x32, rgbToSaturation32x32, hashToHex } from './hashCore.js'
import { areaResizeRGBA, bilinearCropResize } from './visionCore.js'

/**
 * @param {Uint8ClampedArray|Uint8Array} cardRGBA — 500×700×4 pixels
 * @returns {{ phash_hex, phash_hex2, phash_full_hex }}
 */
export function computeSeedHashes(cardRGBA) {
  if (cardRGBA.length !== CARD_W * CARD_H * 4) {
    throw new Error(`Expected ${CARD_W}×${CARD_H} RGBA card, got ${cardRGBA.length} bytes`)
  }
  // Art crop is an integer-aligned 1:1 region — the fast-copy path.
  const art = bilinearCropResize(cardRGBA, CARD_W, CARD_H, ART_X, ART_Y, ART_W, ART_H, ART_W, ART_H)
  const art32 = areaResizeRGBA(art, ART_W, ART_H, 32, 32)
  const full32 = areaResizeRGBA(cardRGBA, CARD_W, CARD_H, 32, 32)
  return {
    phash_hex: hashToHex(computeHashFromGray(rgbToGray32x32(art32, 4))),
    phash_hex2: hashToHex(computeHashFromGray(rgbToSaturation32x32(art32, 4))),
    phash_full_hex: hashToHex(computeHashFromGray(rgbToGray32x32(full32, 4))),
  }
}
