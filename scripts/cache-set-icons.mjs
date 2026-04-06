import fs from 'node:fs/promises'
import path from 'node:path'

const rootDir = process.cwd()
const outDir = path.join(rootDir, 'public', 'set-icons')
const srcManifestPath = path.join(rootDir, 'src', 'data', 'setIconManifest.json')
const publicManifestPath = path.join(outDir, 'index.json')

function iconFilename(code) {
  return `set-${String(code).toLowerCase()}.svg`
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'ArcaneVault/1.0 (set icon cache)',
      'Accept': 'application/json;q=0.9,*/*;q=0.8',
    },
  })
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return res.json()
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'ArcaneVault/1.0 (set icon cache)',
      'Accept': 'image/svg+xml,text/plain;q=0.9,*/*;q=0.8',
    },
  })
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  return res.text()
}

async function main() {
  await fs.mkdir(outDir, { recursive: true })
  const args = process.argv.slice(2).map(code => String(code || '').trim().toLowerCase()).filter(Boolean)
  const cacheAll = args.includes('--all')
  const requestedCodes = [...new Set(args.filter(code => code !== '--all'))]
  if (!cacheAll && !requestedCodes.length) {
    throw new Error('Pass one or more set codes, or use --all')
  }

  const data = await fetchJson('https://api.scryfall.com/sets')
  const allSets = new Map(
    (data?.data || [])
      .filter(set => set?.code && set?.icon_svg_uri)
      .map(set => [String(set.code).toLowerCase(), set])
  )

  const sets = cacheAll
    ? [...allSets.values()]
    : requestedCodes.map(code => allSets.get(code)).filter(Boolean)

  const missing = cacheAll ? [] : requestedCodes.filter(code => !allSets.has(code))
  if (missing.length) console.warn(`unknown set codes skipped: ${missing.join(', ')}`)

  let written = 0
  for (const set of sets) {
    const svg = await fetchText(set.icon_svg_uri)
    await fs.writeFile(path.join(outDir, iconFilename(set.code)), svg, 'utf8')
    written += 1
    console.log(`cached ${set.code.toLowerCase()} (${written}/${sets.length})`)
  }

  const existing = await fs.readdir(outDir).catch(() => [])
  const icons = existing
    .filter(name => name.toLowerCase().startsWith('set-') && name.toLowerCase().endsWith('.svg'))
    .map(name => {
      const code = name.slice(4, -4).toLowerCase()
      return [code, `set-icons/${name}`]
    })
    .sort((a, b) => a[0].localeCompare(b[0]))
  const manifestJson = JSON.stringify({ icons: Object.fromEntries(icons) }, null, 2)
  await fs.writeFile(publicManifestPath, manifestJson, 'utf8')
  await fs.mkdir(path.dirname(srcManifestPath), { recursive: true })
  await fs.writeFile(srcManifestPath, manifestJson, 'utf8')

  console.log(`cached ${written} set icons in ${outDir}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
