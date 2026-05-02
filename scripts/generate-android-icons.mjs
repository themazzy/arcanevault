import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const src = resolve(root, 'src/icons/DeckLoom_logo.png')
const resDir = resolve(root, 'android/app/src/main/res')

const BG = { r: 5, g: 9, b: 29, alpha: 1 }

const densities = [
  { name: 'mdpi',    legacy: 48,  fg: 108 },
  { name: 'hdpi',    legacy: 72,  fg: 162 },
  { name: 'xhdpi',   legacy: 96,  fg: 216 },
  { name: 'xxhdpi',  legacy: 144, fg: 324 },
  { name: 'xxxhdpi', legacy: 192, fg: 432 },
]

async function ensureDir(p) { await mkdir(dirname(p), { recursive: true }) }

async function buildLegacy(size, outPath) {
  const inset = Math.round(size * 0.78)
  const logo = await sharp(src).resize(inset, inset, { fit: 'contain', background: { r:0,g:0,b:0,alpha:0 } }).toBuffer()
  await ensureDir(outPath)
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toFile(outPath)
}

async function buildRound(size, outPath) {
  const inset = Math.round(size * 0.74)
  const logo = await sharp(src).resize(inset, inset, { fit: 'contain', background: { r:0,g:0,b:0,alpha:0 } }).toBuffer()
  const r = size / 2
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`
  )
  const filled = await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toBuffer()
  await ensureDir(outPath)
  await sharp(filled)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toFile(outPath)
}

async function buildForeground(size, outPath) {
  // Adaptive icon foreground: 108dp canvas, safe zone ~66dp (≈61%).
  const inset = Math.round(size * 0.60)
  const logo = await sharp(src).resize(inset, inset, { fit: 'contain', background: { r:0,g:0,b:0,alpha:0 } }).toBuffer()
  await ensureDir(outPath)
  await sharp({ create: { width: size, height: size, channels: 4, background: { r:0,g:0,b:0,alpha:0 } } })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toFile(outPath)
}

for (const d of densities) {
  const dir = resolve(resDir, `mipmap-${d.name}`)
  await Promise.all([
    buildLegacy(d.legacy, resolve(dir, 'ic_launcher.png')),
    buildRound(d.legacy, resolve(dir, 'ic_launcher_round.png')),
    buildForeground(d.fg, resolve(dir, 'ic_launcher_foreground.png')),
  ])
  console.log(`mipmap-${d.name} done`)
}

// Web favicons / PWA icons too — use the same logo with bg
async function buildWeb() {
  const out = resolve(root, 'public')
  const sizes = [
    { name: 'android-chrome-192x192.png', size: 192, bg: BG },
    { name: 'android-chrome-512x512.png', size: 512, bg: BG },
    { name: 'apple-touch-icon.png',       size: 180, bg: BG },
    { name: 'favicon-32x32.png',          size: 32,  bg: BG },
    { name: 'favicon-16x16.png',          size: 16,  bg: BG },
  ]
  for (const s of sizes) {
    const inset = Math.round(s.size * 0.78)
    const logo = await sharp(src).resize(inset, inset, { fit: 'contain', background: { r:0,g:0,b:0,alpha:0 } }).toBuffer()
    await sharp({ create: { width: s.size, height: s.size, channels: 4, background: s.bg } })
      .composite([{ input: logo, gravity: 'center' }])
      .png()
      .toFile(resolve(out, s.name))
  }
  console.log('web icons done')
}
await buildWeb()
