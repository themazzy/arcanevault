#!/usr/bin/env node

/**
 * Compare current mean-threshold scanner pHash against a median-threshold variant.
 *
 * This does not change runtime scanner behavior or card_hashes. It is a local
 * decision tool for Scanner V6 Phase 5.
 *
 * Usage:
 *   node scripts/benchmark-scanner-hash.mjs path/to/card1.jpg path/to/card2.jpg
 *   node scripts/benchmark-scanner-hash.mjs https://example.com/card.jpg
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import fetch from 'node-fetch'
import sharp from 'sharp'
import { ART_H, ART_W, ART_X, ART_Y, CARD_H, CARD_W } from '../src/scanner/constants.js'
import {
  computeHashFromGray,
  computeHashFromGrayMedian,
  hammingDistance,
  rgbToGray32x32,
} from '../src/scanner/hashCore.js'

const SOURCES = process.argv.slice(2).filter(arg => !arg.startsWith('--'))

const showHelp = process.argv.includes('--help')

if (!SOURCES.length || showHelp) {
  console.log(`Usage:
  node scripts/benchmark-scanner-hash.mjs <image-path-or-url> [...]

The script preprocesses each image with the seed-script card resize/art-crop path,
then compares same-source transform stability and cross-source separation for:
  - current mean threshold
  - benchmark-only median threshold`)
  process.exit(showHelp ? 0 : 1)
}

async function loadBuffer(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${source}`)
    return Buffer.from(await res.arrayBuffer())
  }
  return fs.readFile(source)
}

async function preprocessTo32Rgb(imageBuffer, transform = {}) {
  let pipeline = sharp(imageBuffer)
    .resize(CARD_W, CARD_H, { fit: 'fill', kernel: 'lanczos3' })
    .extract({ left: ART_X, top: ART_Y, width: ART_W, height: ART_H })
    .removeAlpha()

  if (transform.modulate) pipeline = pipeline.modulate(transform.modulate)
  if (transform.blur) pipeline = pipeline.blur(transform.blur)
  if (transform.sharpen) pipeline = pipeline.sharpen()

  const { data: artRaw, info: artInfo } = await pipeline
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { data } = await sharp(artRaw, {
    raw: { width: artInfo.width, height: artInfo.height, channels: artInfo.channels },
  })
    .blur(1.0)
    .resize(32, 32, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  return rgbToGray32x32(data, artInfo.channels)
}

function stats(values) {
  if (!values.length) return { min: 0, avg: 0, max: 0 }
  return {
    min: Math.min(...values),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    max: Math.max(...values),
  }
}

function fmtStats(label, value) {
  return `${label} min=${value.min.toFixed(1)} avg=${value.avg.toFixed(1)} max=${value.max.toFixed(1)}`
}

const transforms = [
  ['base', {}],
  ['bright', { modulate: { brightness: 1.18 } }],
  ['dim', { modulate: { brightness: 0.82 } }],
  ['lowSat', { modulate: { saturation: 0.72 } }],
  ['highSat', { modulate: { saturation: 1.25 } }],
  ['soft', { blur: 0.6 }],
  ['sharp', { sharpen: true }],
]

const rows = []

for (const source of SOURCES) {
  const buffer = await loadBuffer(source)
  const variants = []
  for (const [name, transform] of transforms) {
    const gray = await preprocessTo32Rgb(buffer, transform)
    variants.push({
      name,
      mean: computeHashFromGray(gray),
      median: computeHashFromGrayMedian(gray),
    })
  }
  rows.push({
    source,
    label: path.basename(source).slice(0, 48) || source.slice(0, 48),
    variants,
  })
}

console.log(`Scanner hash benchmark: ${rows.length} source image(s), ${transforms.length} transforms each`)
console.log('')

for (const row of rows) {
  const base = row.variants[0]
  const meanDistances = row.variants.slice(1).map(variant => hammingDistance(base.mean, variant.mean))
  const medianDistances = row.variants.slice(1).map(variant => hammingDistance(base.median, variant.median))
  console.log(row.label)
  console.log(`  same-card stability: ${fmtStats('mean', stats(meanDistances))}`)
  console.log(`  same-card stability: ${fmtStats('median', stats(medianDistances))}`)
}

if (rows.length > 1) {
  const meanCross = []
  const medianCross = []
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      meanCross.push(hammingDistance(rows[i].variants[0].mean, rows[j].variants[0].mean))
      medianCross.push(hammingDistance(rows[i].variants[0].median, rows[j].variants[0].median))
    }
  }
  console.log('')
  console.log(`cross-card separation: ${fmtStats('mean', stats(meanCross))}`)
  console.log(`cross-card separation: ${fmtStats('median', stats(medianCross))}`)
}

console.log('')
console.log('Interpretation:')
console.log('- Lower same-card distances are better stability.')
console.log('- Higher cross-card distances are better separation.')
console.log('- Do not switch runtime hashing until this is run on a representative card set.')
