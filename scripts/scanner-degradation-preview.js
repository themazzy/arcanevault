/**
 * scanner-degradation-preview.js — render what the harnesses actually score
 *
 * The A/B harnesses (colour, gate, grid) never write an image to disk; the
 * degraded frames exist only as RGBA buffers on their way into a hash. This
 * dumps them so the simulation can be eyeballed against real captures — the
 * numbers are only worth what the degradation model is worth.
 *
 * Scenario definitions are imported, not copied, so this shows exactly what
 * was measured.
 *
 * Output: node_modules/.cache/scanner-harness/preview/
 *   <card>-<scenario>.png   full 500×700 frame per scenario
 *   <card>-sheet.png        labelled contact sheet
 *   <card>-art-sheet.png    the ART CROP only (38,66 424×248) — this is what
 *                           the primary hash actually sees, and it is the more
 *                           honest thing to judge
 *
 * Usage:
 *   node scripts/scanner-degradation-preview.js ["Card Name" ...]
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import {
  searchCards, fetchImageCached, mulberry32, CACHE_DIR,
  SURVIVABLE_SCENARIOS, SEVERE_SCENARIOS, WHITE_BALANCE_SCENARIOS,
} from './lib/scanner-harness-core.mjs'
import { CARD_W, CARD_H, ART_X, ART_Y, ART_W, ART_H } from '../src/scanner/constants.js'
import { bilinearCropResize } from '../src/scanner/visionCore.js'

const OUT_DIR = path.join(CACHE_DIR, 'preview')
const SCENARIOS = [
  ['original', rgba => rgba],
  ...SURVIVABLE_SCENARIOS,
  ...SEVERE_SCENARIOS,
  ...WHITE_BALANCE_SCENARIOS,
]

const CARD_NAMES = process.argv.slice(2).filter(a => !a.startsWith('--'))
const DEFAULT_CARDS = ['Sheltered by Ghosts', 'Forest', 'Overgrown Farmland']

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const toPng = (rgba, w, h) =>
  sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length), { raw: { width: w, height: h, channels: 4 } })
    .png()

/** Labelled grid contact sheet from [label, rgba] tiles. */
async function contactSheet(tiles, tileW, tileH, cols, outFile, heading) {
  const LABEL_H = 26
  const PAD = 8
  const cellW = tileW + PAD, cellH = tileH + LABEL_H + PAD
  const rows = Math.ceil(tiles.length / cols)
  const HEAD_H = 34
  const width = cols * cellW + PAD
  const height = rows * cellH + PAD + HEAD_H

  const composites = []
  for (let i = 0; i < tiles.length; i++) {
    const [label, rgba, srcW, srcH] = tiles[i]
    const col = i % cols, row = Math.floor(i / cols)
    const left = PAD + col * cellW
    const top = HEAD_H + PAD + row * cellH
    const resized = await toPng(rgba, srcW, srcH).resize(tileW, tileH, { fit: 'fill' }).toBuffer()
    composites.push({ input: resized, left, top })
    const svg = Buffer.from(
      `<svg width="${tileW}" height="${LABEL_H}"><text x="0" y="18" font-family="monospace" font-size="15" fill="#e8e8e8">${label}</text></svg>`)
    composites.push({ input: svg, left, top: top + tileH + 4 })
  }
  composites.push({
    input: Buffer.from(
      `<svg width="${width}" height="${HEAD_H}"><text x="${PAD}" y="23" font-family="monospace" font-size="18" fill="#ffffff">${heading}</text></svg>`),
    left: 0, top: 0,
  })

  await sharp({ create: { width, height, channels: 4, background: { r: 24, g: 24, b: 27, alpha: 1 } } })
    .composite(composites)
    .png()
    .toFile(outFile)
  return outFile
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const wanted = CARD_NAMES.length ? CARD_NAMES : DEFAULT_CARDS
  console.log(`Rendering degradation preview for: ${wanted.join(', ')}\n`)

  const written = []
  for (const name of wanted) {
    const found = await searchCards(`!"${name}" game:paper`, 1)
    if (!found.length) { console.warn(`  x no printing found for "${name}"`); continue }
    const card = found[0]
    const rgba = await fetchImageCached(card)
    console.log(`${card.name} [${card.set_code}]`)

    const cardTiles = []
    const artTiles = []
    for (const [label, degrade] of SCENARIOS) {
      // Same seed formula the gate harness uses, so these are the very frames
      // that scenario produced during scoring.
      const rng = mulberry32(card.scryfall_id.charCodeAt(0) * 7919 + label.length * 101)
      const out = degrade(rgba, rng)
      const file = path.join(OUT_DIR, `${slug(card.name)}-${slug(label)}.png`)
      await toPng(out, CARD_W, CARD_H).toFile(file)
      cardTiles.push([label, out, CARD_W, CARD_H])
      // The art crop is what computePHash256 hashes — judge the model on this.
      const art = bilinearCropResize(out, CARD_W, CARD_H, ART_X, ART_Y, ART_W, ART_H, ART_W, ART_H)
      artTiles.push([label, art, ART_W, ART_H])
      console.log(`  ${label}`)
    }

    written.push(await contactSheet(
      cardTiles, 200, 280, 6,
      path.join(OUT_DIR, `${slug(card.name)}-sheet.png`),
      `${card.name} [${card.set_code}] — full frame, simulated capture degradation`))
    written.push(await contactSheet(
      artTiles, 265, 155, 4,
      path.join(OUT_DIR, `${slug(card.name)}-art-sheet.png`),
      `${card.name} [${card.set_code}] — ART CROP (what the primary hash sees)`))
  }

  console.log(`\nWrote ${written.length} contact sheets to:\n  ${OUT_DIR}`)
  for (const f of written) console.log(`  ${path.basename(f)}`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
