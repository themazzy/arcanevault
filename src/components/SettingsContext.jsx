import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import { fetchScryfallBatch, sfGet, getMemoryMap, loadCacheFromIDB, getScryfallKey } from '../lib/scryfall'
import { getLocalCards, getAllLocalFolderCards } from '../lib/db'

const SETTINGS_KEY = 'arcanevault_settings'
const SETTINGS_MISSING_COLUMNS_KEY = 'arcanevault_missing_user_settings_columns'

const LIGHT_SURFACE_VARS = {
  '--s-card': 'rgba(255,252,246,0.78)',
  '--s-subtle': 'rgba(255,255,255,0.88)',
  '--s-medium': 'rgba(188,152,83,0.18)',
  '--s-border': 'rgba(102,74,26,0.14)',
  '--s-border2': 'rgba(102,74,26,0.26)',
  '--overlay': 'rgba(244,238,228,0.34)',
  '--s1': 'rgba(255,253,248,0.62)',
  '--s2': 'rgba(255,255,255,0.82)',
  '--s3': 'rgba(215,191,143,0.24)',
  '--s4': 'rgba(188,152,83,0.32)',
  '--nav-bg': 'rgba(255,251,245,0.94)',
  '--popup-bg': 'rgba(255,251,245,0.98)',
  '--ambient-1': 'rgba(232,183,79,0.19)',
  '--ambient-2': 'rgba(112,154,222,0.16)',
  '--glass-strong': 'rgba(255,252,247,0.96)',
  '--glass-medium': 'rgba(255,252,247,0.88)',
  '--glass-soft': 'rgba(255,252,247,0.78)',
  '--scrim-strong': 'rgba(238,231,220,0.9)',
  '--scrim-medium': 'rgba(238,231,220,0.74)',
  '--scrim-soft': 'rgba(238,231,220,0.52)',
}

const DARK_SURFACE_VARS = {
  '--s-card': 'rgba(255,255,255,0.025)',
  '--s-subtle': 'rgba(255,255,255,0.04)',
  '--s-medium': 'rgba(255,255,255,0.07)',
  '--s-border': 'rgba(255,255,255,0.07)',
  '--s-border2': 'rgba(255,255,255,0.12)',
  '--overlay': 'rgba(0,0,0,0.20)',
  '--s1': 'rgba(255,255,255,0.03)',
  '--s2': 'rgba(255,255,255,0.05)',
  '--s3': 'rgba(255,255,255,0.08)',
  '--s4': 'rgba(255,255,255,0.12)',
  '--nav-bg': 'rgba(8,6,16,0.94)',
  '--popup-bg': 'var(--bg3)',
  '--ambient-1': 'rgba(139,90,43,0.055)',
  '--ambient-2': 'rgba(80,60,120,0.075)',
  '--glass-strong': 'rgba(10,10,18,0.92)',
  '--glass-medium': 'rgba(10,8,20,0.82)',
  '--glass-soft': 'rgba(10,8,20,0.72)',
  '--scrim-strong': 'rgba(0,0,0,0.78)',
  '--scrim-medium': 'rgba(0,0,0,0.55)',
  '--scrim-soft': 'rgba(0,0,0,0.35)',
}

function createTheme({
  name,
  lore,
  mode,
  tier,
  bg,
  bg2,
  bg3,
  accent,
  accentDim,
  hi,
  green,
  red,
  text,
  textDim,
  textFaint,
  border,
  borderHi,
  glow,
  focus,
}) {
  return {
    name,
    lore,
    tier: tier || 'free',
    ...(mode ? { mode } : {}),
    preview: { bg, accent, hi, text },
    vars: {
      '--bg': bg,
      '--bg2': bg2,
      '--bg3': bg3,
      '--border': border,
      '--border-hi': borderHi,
      '--gold': accent,
      '--gold-dim': accentDim,
      '--purple': hi,
      '--green': green,
      '--red': red,
      '--text': text,
      '--text-dim': textDim,
      '--text-faint': textFaint,
      '--gold-glow': glow,
      '--input-focus': focus,
      ...(mode === 'light' ? LIGHT_SURFACE_VARS : DARK_SURFACE_VARS),
    },
  }
}

function createDarkTheme(config) {
  return createTheme({
    green: '#8ab87a',
    red: '#c46060',
    ...config,
  })
}

function createLightTheme(config) {
  return createTheme({
    mode: 'light',
    green: '#3a7848',
    red: '#a03030',
    ...config,
  })
}

export const THEMES = {
  shadow: createDarkTheme({
    name: 'Shadow',
    lore: 'The flagship — gold and violet against deep night',
    tier: 'free',
    bg: '#0a0a0f',
    bg2: '#0e0c1a',
    bg3: '#12101e',
    accent: '#c9a84c',
    accentDim: '#a08848',
    hi: '#8a6fc4',
    text: '#ddd0b8',
    textDim: '#a89878',
    textFaint: '#857868',
    border: 'rgba(180,140,60,0.20)',
    borderHi: 'rgba(201,168,76,0.50)',
    glow: '0 0 18px rgba(201,168,76,0.18)',
    focus: '0 0 0 3px rgba(201,168,76,0.12)',
  }),
  shadow_light: createLightTheme({
    name: 'Shadow Light',
    lore: 'Parchment, gilded leaf, and lavender shadow',
    tier: 'free',
    bg: '#f6f0df',
    bg2: '#ece4ce',
    bg3: '#ddd2b6',
    accent: '#9a7820',
    accentDim: '#765c14',
    hi: '#6e4fa3',
    text: '#1c1610',
    textDim: '#52442e',
    textFaint: '#8a7a5e',
    border: 'rgba(140,100,20,0.20)',
    borderHi: 'rgba(154,120,32,0.50)',
    glow: '0 0 18px rgba(154,120,32,0.18)',
    focus: '0 0 0 3px rgba(154,120,32,0.14)',
  }),
  azorius: createLightTheme({
    name: 'Azorius',
    lore: 'Marble halls, white linen, and law-deep blue',
    tier: 'guild',
    bg: '#f3f7fc',
    bg2: '#e3edf8',
    bg3: '#cfe0f1',
    accent: '#1f5fb8',
    accentDim: '#154a92',
    hi: '#6a98d4',
    text: '#0a1830',
    textDim: '#3e556e',
    textFaint: '#6f8194',
    border: 'rgba(20,80,160,0.18)',
    borderHi: 'rgba(31,95,184,0.50)',
    glow: '0 0 18px rgba(31,95,184,0.22)',
    focus: '0 0 0 3px rgba(31,95,184,0.16)',
  }),
  dimir: createDarkTheme({
    name: 'Dimir',
    lore: 'Black ink on midnight water — secrets you never saw',
    tier: 'guild',
    bg: '#04070d',
    bg2: '#080d1a',
    bg3: '#0e1628',
    accent: '#4781d8',
    accentDim: '#2d62b0',
    hi: '#7e96c2',
    text: '#cad8ee',
    textDim: '#7a8aa8',
    textFaint: '#525e78',
    border: 'rgba(50,90,170,0.20)',
    borderHi: 'rgba(71,129,216,0.55)',
    glow: '0 0 18px rgba(71,129,216,0.22)',
    focus: '0 0 0 3px rgba(71,129,216,0.14)',
  }),
  rakdos: createDarkTheme({
    name: 'Rakdos',
    lore: 'Jet black and arterial red — the carnival of slaughter',
    tier: 'guild',
    bg: '#06030a',
    bg2: '#0e0608',
    bg3: '#160a0c',
    accent: '#e02020',
    accentDim: '#a81818',
    hi: '#ff5c5c',
    text: '#efd0c8',
    textDim: '#b07a72',
    textFaint: '#80544c',
    border: 'rgba(220,30,30,0.22)',
    borderHi: 'rgba(224,32,32,0.55)',
    glow: '0 0 22px rgba(224,32,32,0.24)',
    focus: '0 0 0 3px rgba(224,32,32,0.16)',
  }),
  gruul: createDarkTheme({
    name: 'Gruul',
    lore: 'Ember red and savage green — the wild that breaks stone',
    tier: 'guild',
    bg: '#0a0805',
    bg2: '#110d07',
    bg3: '#18130a',
    accent: '#d44a1f',
    accentDim: '#a3380f',
    hi: '#6da630',
    text: '#e4d5b8',
    textDim: '#b09572',
    textFaint: '#826b50',
    border: 'rgba(190,80,30,0.22)',
    borderHi: 'rgba(212,74,31,0.55)',
    glow: '0 0 20px rgba(212,74,31,0.22)',
    focus: '0 0 0 3px rgba(212,74,31,0.14)',
  }),
  selesnya: createLightTheme({
    name: 'Selesnya',
    lore: 'Sun-bleached white and leaf-deep green — the conclave',
    tier: 'guild',
    bg: '#f5f9eb',
    bg2: '#e6efd4',
    bg3: '#d2e1ba',
    accent: '#2f8633',
    accentDim: '#1f6324',
    hi: '#b8b378',
    text: '#0c1c0a',
    textDim: '#44614a',
    textFaint: '#7a8e7a',
    border: 'rgba(40,110,40,0.22)',
    borderHi: 'rgba(47,134,51,0.50)',
    glow: '0 0 20px rgba(47,134,51,0.22)',
    focus: '0 0 0 3px rgba(47,134,51,0.16)',
  }),
  orzhov: createLightTheme({
    name: 'Orzhov',
    lore: 'Ivory cathedral, jet shadow, and tarnished gold',
    tier: 'guild',
    bg: '#f1ece2',
    bg2: '#e3dac6',
    bg3: '#d3c5a8',
    accent: '#8b6a18',
    accentDim: '#685010',
    hi: '#1a1a1a',
    text: '#0a0805',
    textDim: '#4a3e2a',
    textFaint: '#786a55',
    border: 'rgba(80,60,20,0.24)',
    borderHi: 'rgba(139,106,24,0.55)',
    glow: '0 0 20px rgba(139,106,24,0.22)',
    focus: '0 0 0 3px rgba(139,106,24,0.16)',
  }),
  izzet: createDarkTheme({
    name: 'Izzet',
    lore: 'Storm-glass blue and copper-fire red — pure invention',
    tier: 'guild',
    bg: '#040a14',
    bg2: '#08111e',
    bg3: '#0c1a2c',
    accent: '#2c8af2',
    accentDim: '#1c6cc6',
    hi: '#ed4f1c',
    text: '#d5e3f3',
    textDim: '#8aa0bc',
    textFaint: '#5e7088',
    border: 'rgba(40,135,240,0.22)',
    borderHi: 'rgba(44,138,242,0.55)',
    glow: '0 0 20px rgba(44,138,242,0.22)',
    focus: '0 0 0 3px rgba(44,138,242,0.14)',
  }),
  golgari: createDarkTheme({
    name: 'Golgari',
    lore: 'Black loam and spore-bright green — death made fertile',
    tier: 'guild',
    bg: '#050905',
    bg2: '#0a0f08',
    bg3: '#10180d',
    accent: '#549f2e',
    accentDim: '#3a721c',
    hi: '#5a4863',
    text: '#c4d2b5',
    textDim: '#7c8e72',
    textFaint: '#586655',
    border: 'rgba(70,140,40,0.22)',
    borderHi: 'rgba(84,159,46,0.55)',
    glow: '0 0 20px rgba(84,159,46,0.22)',
    focus: '0 0 0 3px rgba(84,159,46,0.14)',
  }),
  boros: createLightTheme({
    name: 'Boros',
    lore: 'White stone, battle red, and the gold of kept oaths',
    tier: 'guild',
    bg: '#f8f1ea',
    bg2: '#efe1d2',
    bg3: '#e3cfb8',
    accent: '#c52020',
    accentDim: '#971818',
    hi: '#d8a430',
    text: '#1a0805',
    textDim: '#5a352a',
    textFaint: '#8c6b54',
    border: 'rgba(190,30,30,0.22)',
    borderHi: 'rgba(197,32,32,0.55)',
    glow: '0 0 20px rgba(197,32,32,0.22)',
    focus: '0 0 0 3px rgba(197,32,32,0.16)',
  }),
  simic: createDarkTheme({
    name: 'Simic',
    lore: 'Sea-glass teal and bioluminescent green — the lab reef',
    tier: 'guild',
    bg: '#04111a',
    bg2: '#07182a',
    bg3: '#0a2230',
    accent: '#28b8b8',
    accentDim: '#18897e',
    hi: '#58cc62',
    text: '#cae5e1',
    textDim: '#80a89e',
    textFaint: '#5b7d76',
    border: 'rgba(40,184,184,0.22)',
    borderHi: 'rgba(40,184,184,0.55)',
    glow: '0 0 20px rgba(40,184,184,0.22)',
    focus: '0 0 0 3px rgba(40,184,184,0.14)',
  }),

  // ── Premium themes ──────────────────────────────────────────────────────────
  archive_dark: createDarkTheme({
    name: 'Arcane Archive',
    lore: 'Personal card art, dark glass, and gallery shadows',
    tier: 'archive',
    bg: '#050509',
    bg2: '#0a0b12',
    bg3: '#11131d',
    accent: '#d8b65f',
    accentDim: '#9f7d38',
    hi: '#7c8cff',
    text: '#efe5cf',
    textDim: '#b8a98a',
    textFaint: '#81745f',
    border: 'rgba(216,182,95,0.22)',
    borderHi: 'rgba(216,182,95,0.56)',
    glow: '0 0 30px rgba(216,182,95,0.24)',
    focus: '0 0 0 3px rgba(216,182,95,0.16)',
  }),
  archive_light: createLightTheme({
    name: 'Arcane Archive Light',
    lore: 'Personal card art, parchment light, and soft gallery haze',
    tier: 'archive',
    bg: '#f7f1e6',
    bg2: '#efe5d5',
    bg3: '#e3d4bc',
    accent: '#9a6418',
    accentDim: '#754b12',
    hi: '#5366c6',
    text: '#1f160d',
    textDim: '#5d4932',
    textFaint: '#927d63',
    border: 'rgba(117,75,18,0.18)',
    borderHi: 'rgba(154,100,24,0.46)',
    glow: '0 0 24px rgba(154,100,24,0.18)',
    focus: '0 0 0 3px rgba(154,100,24,0.14)',
  }),
}

export const ARCHIVE_THEMES = new Set(['archive_dark', 'archive_light'])
export const GUILD_THEMES = new Set(['azorius', 'dimir', 'rakdos', 'gruul', 'selesnya', 'orzhov', 'izzet', 'golgari', 'boros', 'simic'])
export const PREMIUM_THEMES = new Set([
  ...GUILD_THEMES,
  ...ARCHIVE_THEMES,
])

export const THEME_TIERS = [
  { id: 'free', label: 'Free', description: 'The flagship Shadow palette — dark and light.' },
  { id: 'guild', label: 'Guilds of Ravnica · Premium Pack', description: 'All ten guilds — each leaning hard into its dual color identity.' },
  { id: 'archive', label: 'Arcane Archive · Premium', description: 'Your own card art as a living background.' },
]

const DEFAULT_BENTO_CONFIG = {
  blocks: [
    { id: 'bio',        enabled: true  },
    { id: 'total',      enabled: true  },
    { id: 'unique',     enabled: true  },
    { id: 'since',      enabled: true  },
    { id: 'value',      enabled: false },
    { id: 'deck_count', enabled: true  },
    { id: 'crown',      enabled: false },
    { id: 'decks',      enabled: true  },
  ],
}

const DEFAULTS = {
  premium: false,
  price_source: 'cardmarket_trend',
  default_sort: 'name',
  grid_density: 'comfortable',
  show_price: true,
  cache_ttl_h: 24,
  binder_sort: 'name',
  deck_sort: 'name',
  list_sort: 'name',
  font_weight: 420,
  font_size: 16,
  body_font: 'serif',
  theme: 'shadow',
  oled_mode: false,
  nickname: '',
  anonymize_email: true,
  reduce_motion: false,
  higher_contrast: false,
  card_name_size: 'default',
  default_grouping: 'type',
  keep_screen_awake: false,
  show_sync_errors: false,
  page_tips_seen: {},
  archive_background_mode: 'random',
  archive_background_cards: [],
  archive_background_seed: 0,
  archive_background_locked: [],
  archive_background_collection_source: null,
  archive_background_blur: 7,
  archive_background_saturation: 0.86,
  archive_background_opacity: 0.16,
  // Profile
  profile_bio: '',
  profile_accent: '',
  profile_config: DEFAULT_BENTO_CONFIG,
}

export { DEFAULT_BENTO_CONFIG }

const OLED_VARS = {
  '--bg': '#000000',
  '--bg2': '#000000',
  '--bg3': '#000000',
  '--s1': '#000000',
  '--s2': '#000000',
  '--s3': '#000000',
  '--s4': '#000000',
}

const DARK_CONTRAST_VARS = {
  '--text': '#f4ecde',
  '--text-dim': '#e0d0b0',
  '--text-faint': '#c4b18e',
  '--border': 'rgba(201,168,76,0.38)',
  '--border-hi': 'rgba(201,168,76,0.72)',
  '--s-border': 'rgba(255,255,255,0.16)',
  '--s-border2': 'rgba(255,255,255,0.26)',
  '--overlay': 'rgba(0,0,0,0.28)',
}

const LIGHT_CONTRAST_VARS = {
  '--text': '#120d08',
  '--text-dim': '#24180f',
  '--text-faint': '#43311f',
  '--border': 'rgba(116,82,24,0.34)',
  '--border-hi': 'rgba(141,93,0,0.62)',
  '--s-border': 'rgba(102,74,26,0.22)',
  '--s-border2': 'rgba(102,74,26,0.32)',
  '--overlay': 'rgba(250,242,230,0.72)',
}

function getMissingSettingsColumn(error) {
  const message = error?.message || ''
  if (error?.code !== 'PGRST204') return ''
  const match = message.match(/'([^']+)' column of 'user_settings'/)
  return match?.[1] || ''
}

function loadMissingSettingsColumns() {
  try {
    const raw = localStorage.getItem(SETTINGS_MISSING_COLUMNS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean) : [])
  } catch {
    return new Set()
  }
}

const missingSettingsColumns = loadMissingSettingsColumns()

// One-time prune: these columns were added in the archive_theme_v2 migration; older clients
// may have cached them as "missing" before the migration ran. Drop them from the cache so
// the next save retries; if a column is still missing on the DB, it will be re-cached.
;(function pruneArchiveV2MissingCache() {
  const ARCHIVE_V2_COLUMNS = [
    'archive_background_seed',
    'archive_background_locked',
    'archive_background_collection_source',
    'archive_background_blur',
    'archive_background_saturation',
    'archive_background_opacity',
  ]
  let changed = false
  for (const col of ARCHIVE_V2_COLUMNS) {
    if (missingSettingsColumns.delete(col)) changed = true
  }
  if (changed) {
    try {
      localStorage.setItem(SETTINGS_MISSING_COLUMNS_KEY, JSON.stringify([...missingSettingsColumns]))
    } catch {}
  }
})()

function rememberMissingSettingsColumn(column) {
  if (!column || missingSettingsColumns.has(column)) return
  missingSettingsColumns.add(column)
  try {
    localStorage.setItem(SETTINGS_MISSING_COLUMNS_KEY, JSON.stringify([...missingSettingsColumns]))
  } catch {}
}

function omitKnownMissingSettingsColumns(payload) {
  const next = { ...payload }
  for (const column of missingSettingsColumns) {
    delete next[column]
  }
  return next
}

async function upsertSettingsWithSchemaFallback(payload) {
  const nextPayload = omitKnownMissingSettingsColumns(payload)
  const omittedColumns = []

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { error } = await sb
      .from('user_settings')
      .upsert(nextPayload, { onConflict: 'user_id' })

    const missingColumn = getMissingSettingsColumn(error)
    if (!missingColumn || !(missingColumn in nextPayload)) {
      return { error, omittedColumns }
    }

    delete nextPayload[missingColumn]
    rememberMissingSettingsColumn(missingColumn)
    omittedColumns.push(missingColumn)
  }

  return {
    error: new Error('Could not sync settings because too many columns are missing from the live user_settings schema.'),
    omittedColumns,
  }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return null
    return normalizeSettings({ ...DEFAULTS, ...JSON.parse(raw), premium: false })
  } catch {
    return null
  }
}

function normalizeSettings(settings) {
  const next = {
    ...settings,
    page_tips_seen: settings.page_tips_seen && typeof settings.page_tips_seen === 'object' && !Array.isArray(settings.page_tips_seen)
      ? settings.page_tips_seen
      : {},
    archive_background_mode: ['selected', 'collection', 'random'].includes(settings.archive_background_mode)
      ? settings.archive_background_mode
      : 'random',
    archive_background_cards: Array.isArray(settings.archive_background_cards)
      ? settings.archive_background_cards.filter(card => card && typeof card === 'object').slice(0, 12)
      : [],
    archive_background_seed: Number.isFinite(Number(settings.archive_background_seed))
      ? Number(settings.archive_background_seed)
      : 0,
    archive_background_locked: Array.isArray(settings.archive_background_locked)
      ? settings.archive_background_locked.filter(card => card && typeof card === 'object' && card.id).slice(0, 6)
      : [],
    archive_background_collection_source: settings.archive_background_collection_source && typeof settings.archive_background_collection_source === 'object'
      ? settings.archive_background_collection_source
      : null,
    archive_background_blur: Number.isFinite(Number(settings.archive_background_blur))
      ? Math.max(0, Math.min(40, Number(settings.archive_background_blur)))
      : 7,
    archive_background_saturation: Number.isFinite(Number(settings.archive_background_saturation))
      ? Math.max(0, Math.min(2, Number(settings.archive_background_saturation)))
      : 0.86,
    archive_background_opacity: Number.isFinite(Number(settings.archive_background_opacity))
      ? Math.max(0.02, Math.min(0.6, Number(settings.archive_background_opacity)))
      : 0.16,
  }
  if (!THEMES[next.theme]) {
    return { ...next, theme: 'shadow' }
  }
  if (!next.premium && PREMIUM_THEMES.has(next.theme)) {
    return { ...next, theme: 'shadow' }
  }
  return next
}

function saveLocal(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {}
}

function cacheThemeVars(themeId, oledMode) {
  try {
    const theme = THEMES[themeId] || THEMES.shadow
    localStorage.setItem('arcanevault_theme_cache', JSON.stringify({
      vars: theme.vars,
      mode: theme.mode || null,
      oled: !!(oledMode && theme.mode !== 'light'),
    }))
  } catch {}
}

function getArchiveImage(card) {
  return card?.image_uris?.art_crop
    || card?.card_faces?.find(face => face?.image_uris)?.image_uris?.art_crop
    || card?.image_uris?.large
    || card?.image_uris?.normal
    || ''
}

function normalizeArchiveCard(card) {
  const image = getArchiveImage(card)
  if (!card?.id || !image) return null
  return {
    id: card.id,
    name: card.name,
    image,
  }
}

const ARCHIVE_RANDOM_QUERY = 'game:paper -type:token -type:art -type:scheme -type:plane unique:art'
const ARCHIVE_TILE_COUNT = 6
let archiveRequestSeq = 0

// Module-level state so the Settings panel can observe what's currently rendered.
let _activeArchiveTiles = []
const _archiveListeners = new Set()
export function getActiveArchiveTiles() { return _activeArchiveTiles.slice() }
export function subscribeArchiveTiles(fn) {
  _archiveListeners.add(fn)
  return () => _archiveListeners.delete(fn)
}
function setActiveArchiveTiles(tiles) {
  _activeArchiveTiles = tiles
  _archiveListeners.forEach(fn => { try { fn(tiles) } catch {} })
}

async function fetchOneRandomCard() {
  // Each call to /cards/random returns one truly random card — six parallel calls = six independent rolls.
  const data = await sfGet(`/cards/random?q=${encodeURIComponent(ARCHIVE_RANDOM_QUERY)}`, { noCache: true })
  return normalizeArchiveCard(data)
}

async function getRandomArchiveCards(count, excludeIds = new Set()) {
  if (count <= 0) return []
  // Over-fetch a bit so we can drop duplicates / locked overlaps and still hit the target.
  const target = count + 2
  const results = await Promise.all(Array.from({ length: target }, fetchOneRandomCard))
  const out = []
  const seen = new Set(excludeIds)
  for (const card of results) {
    if (!card || seen.has(card.id)) continue
    seen.add(card.id)
    out.push(card)
    if (out.length >= count) break
  }
  return out
}

async function getCollectionArchiveCards(options, count) {
  const userId = options.userId
  if (!userId || count <= 0) return []
  await loadCacheFromIDB().catch(() => {})
  const sfMap = getMemoryMap() || {}
  const allCards = await getLocalCards(userId).catch(() => [])
  const source = options.archive_background_collection_source
  let pool = allCards
  if (source?.folderId) {
    const placements = await getAllLocalFolderCards([source.folderId]).catch(() => [])
    const ids = new Set(placements.map(p => p.card_id))
    pool = allCards.filter(c => ids.has(c.id))
  }
  // Shuffle, then map to art via sfMap (skip cards without art_crop in cache).
  const shuffled = pool.slice().sort(() => Math.random() - 0.5)
  const out = []
  const seen = new Set()
  for (const c of shuffled) {
    if (out.length >= count) break
    const key = getScryfallKey(c)
    const sf = sfMap[key]
    const image = sf?.image_uris?.art_crop
      || sf?.card_faces?.find(f => f?.image_uris)?.image_uris?.art_crop
    if (!image || seen.has(c.scryfall_id || key)) continue
    seen.add(c.scryfall_id || key)
    out.push({ id: c.scryfall_id || key, name: c.name, image })
  }
  return out
}

async function getArchiveAmbientCards(options = {}) {
  const mode = options.archive_background_mode || 'random'
  const lockedRaw = Array.isArray(options.archive_background_locked) ? options.archive_background_locked : []
  const locked = lockedRaw.filter(c => c?.id && c?.image).slice(0, ARCHIVE_TILE_COUNT)
  const lockedIds = new Set(locked.map(c => c.id))
  const need = Math.max(0, ARCHIVE_TILE_COUNT - locked.length)

  let fresh = []
  if (mode === 'selected') {
    const selected = Array.isArray(options.archive_background_cards) ? options.archive_background_cards : []
    const cached = selected.filter(card => card?.id && card?.image && !lockedIds.has(card.id))
    if (cached.length >= need) {
      fresh = cached.slice(0, need)
    } else if (selected.length) {
      const hydrated = await fetchScryfallBatch(selected.filter(c => c?.id).map(c => ({ id: c.id })))
      fresh = hydrated.map(normalizeArchiveCard).filter(Boolean).filter(c => !lockedIds.has(c.id)).slice(0, need)
    }
  } else if (mode === 'collection') {
    fresh = await getCollectionArchiveCards(options, need)
    fresh = fresh.filter(c => !lockedIds.has(c.id))
    // Fall back to random if collection didn't yield enough (e.g. empty collection).
    if (fresh.length < need) {
      const filler = await getRandomArchiveCards(need - fresh.length, new Set([...lockedIds, ...fresh.map(c => c.id)]))
      fresh = [...fresh, ...filler]
    }
  } else {
    fresh = await getRandomArchiveCards(need, lockedIds)
  }

  // Locked tiles first (preserve their slot order), then fresh fills remaining slots.
  return [...locked, ...fresh].slice(0, ARCHIVE_TILE_COUNT)
}

function ensureArchiveCanvas(el) {
  let canvas = el.querySelector('.av-archive-canvas')
  if (!canvas) {
    canvas = document.createElement('div')
    canvas.className = 'av-archive-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    el.appendChild(canvas)
  }
  return canvas
}

function renderArchiveAmbient(el, cards) {
  const visible = cards.slice(0, ARCHIVE_TILE_COUNT)
  const canvas = ensureArchiveCanvas(el)
  const oldTiles = Array.from(canvas.querySelectorAll('.av-archive-card'))
  const COLS = 3
  // Build new tiles into the canvas. Single filter:blur on canvas covers all of them at once.
  visible.forEach((card, index) => {
    const col = index % COLS
    const row = Math.floor(index / COLS)
    const tile = document.createElement('div')
    tile.className = 'av-archive-card av-archive-card-incoming'
    tile.style.setProperty('--archive-card-i', String(index))
    tile.style.left = `calc(100vw / ${COLS} * ${col})`
    tile.style.top = `${row * 50}vh`
    tile.dataset.cardId = card.id
    tile.setAttribute('aria-hidden', 'true')
    const art = document.createElement('div')
    art.className = 'av-archive-card-art'
    art.style.setProperty('--archive-card-image', `url("${card.image}")`)
    tile.appendChild(art)
    canvas.appendChild(tile)
  })
  // Force reflow so the incoming tiles transition in from opacity 0.
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight
  requestAnimationFrame(() => {
    el.querySelectorAll('.av-archive-card-incoming').forEach(t => t.classList.remove('av-archive-card-incoming'))
    oldTiles.forEach(t => { t.classList.add('av-archive-card-outgoing') })
    setTimeout(() => oldTiles.forEach(t => t.remove()), 800)
  })
  setActiveArchiveTiles(visible)
}

function clearArchiveAmbient(el) {
  const canvas = el.querySelector('.av-archive-canvas')
  if (canvas) canvas.remove()
  setActiveArchiveTiles([])
}

async function updateArchiveAmbient(el, themeId, options) {
  const seq = ++archiveRequestSeq
  const cards = await getArchiveAmbientCards(options)
  if (seq !== archiveRequestSeq || el.dataset.theme !== themeId) return
  renderArchiveAmbient(el, cards)
}

function injectPremiumAmbient(themeId, options = {}) {
  const isPremium = PREMIUM_THEMES.has(themeId)
  const isArchive = ARCHIVE_THEMES.has(themeId)
  let el = document.getElementById('av-premium-ambient')

  if (!isPremium) {
    if (el) {
      el.style.opacity = '0'
      setTimeout(() => el?.remove(), 1200)
    }
    return
  }

  if (!el) {
    el = document.createElement('div')
    el.id = 'av-premium-ambient'
    el.setAttribute('aria-hidden', 'true')
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:0;transition:opacity 1.2s ease,background 1.5s ease;opacity:0;overflow:hidden;'
    document.body.appendChild(el)
  }

  const gradients = {
    archive_dark: 'linear-gradient(180deg, rgba(5,5,9,0.54), rgba(5,5,9,0.76))',
    archive_light: 'linear-gradient(180deg, rgba(247,241,230,0.42), rgba(247,241,230,0.66))',
  }

  el.style.background = gradients[themeId] || ''
  const themeChanged = el.dataset.theme !== themeId
  el.dataset.theme = themeId
  if (isArchive) {
    // Only refetch when something that changes the *card pool* changed.
    // Locks and visual sliders should not trigger network calls.
    const sig = [
      options.archive_background_mode || 'random',
      Number(options.archive_background_seed) || 0,
      (options.archive_background_cards || []).length,
      options.archive_background_collection_source?.folderId || '',
    ].join('|')
    if (themeChanged || el.dataset.archiveSig !== sig) {
      el.dataset.archiveSig = sig
      updateArchiveAmbient(el, themeId, options)
    }
  } else {
    clearArchiveAmbient(el)
    delete el.dataset.archiveSig
  }
  requestAnimationFrame(() => { if (el) el.style.opacity = '1' })
}

export function applyTheme(themeId, oledMode, options = {}) {
  const theme = THEMES[themeId] || THEMES.shadow
  const root = document.documentElement

  root.setAttribute('data-theme', themeId in THEMES ? themeId : 'shadow')

  Object.entries(theme.vars).forEach(([key, value]) => {
    root.style.setProperty(key, value)
  })

  if (oledMode && theme.mode !== 'light') {
    Object.entries(OLED_VARS).forEach(([key, value]) => {
      root.style.setProperty(key, value)
    })
  } else {
    Object.keys(OLED_VARS).forEach(key => root.style.removeProperty(key))
  }

  if (theme.mode === 'light') {
    root.setAttribute('data-theme-mode', 'light')
  } else {
    root.removeAttribute('data-theme-mode')
  }

  if (oledMode && theme.mode !== 'light') {
    root.setAttribute('data-oled', 'true')
  } else {
    root.removeAttribute('data-oled')
  }

  // Archive filter knobs — applied as CSS vars consumed by .av-archive-card.
  if (ARCHIVE_THEMES.has(themeId)) {
    if (Number.isFinite(options.archive_background_blur))
      root.style.setProperty('--archive-blur', `${options.archive_background_blur}px`)
    if (Number.isFinite(options.archive_background_saturation))
      root.style.setProperty('--archive-sat', String(options.archive_background_saturation))
    if (Number.isFinite(options.archive_background_opacity))
      root.style.setProperty('--archive-card-opacity', String(options.archive_background_opacity))
  } else {
    root.style.removeProperty('--archive-blur')
    root.style.removeProperty('--archive-sat')
    root.style.removeProperty('--archive-card-opacity')
  }

  injectPremiumAmbient(themeId, options)
  cacheThemeVars(themeId, oledMode)
}

export function maskEmailAddress(email, hidden) {
  if (!email || !hidden) return email || ''
  const [localPart, domainPart = ''] = email.split('@')
  if (!localPart || !domainPart) return email
  const visibleLocal = localPart.length <= 2
    ? `${localPart[0] || ''}*`
    : `${localPart.slice(0, 2)}${'*'.repeat(Math.max(2, localPart.length - 2))}`
  return `${visibleLocal}@${domainPart}`
}

const SettingsContext = createContext({
  ...DEFAULTS,
  premium: false,
  save: () => {},
  refresh: async () => ({ ok: false }),
  loaded: false,
  syncNow: async () => ({ ok: false }),
  syncState: 'idle',
  syncError: '',
  lastSyncedAt: null,
})
export const useSettings = () => useContext(SettingsContext)

export function SettingsProvider({ children }) {
  const { user } = useAuth()
  const [settings, setSettings] = useState(() => loadLocal() || DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const [syncState, setSyncState] = useState('idle')
  const [syncError, setSyncError] = useState('')
  const [lastSyncedAt, setLastSyncedAt] = useState(null)
  const syncTimeout = useRef(null)
  const settingsRef = useRef(settings)

  const loadRemoteSettings = useCallback(async () => {
    if (!user) return { ok: false, skipped: true }
    const { data, error } = await sb.from('user_settings').select('*').eq('user_id', user.id).maybeSingle()
    if (error) {
      console.error('[Settings] Failed to load settings:', error)
      return { ok: false, error: error.message }
    }
    if (data) {
      const { user_id, updated_at, ...rest } = data
      let merged = { ...DEFAULTS, ...rest }
      if (!Object.prototype.hasOwnProperty.call(rest, 'theme')) {
        const local = loadLocal()
        if (local?.theme) merged.theme = local.theme
      }
      merged = normalizeSettings(merged)
      setSettings(merged)
      saveLocal(merged)
    }
    return { ok: true, data }
  }, [user])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => () => clearTimeout(syncTimeout.current), [])

  useEffect(() => {
    if (!user) {
      setLoaded(true)
      return
    }
    loadRemoteSettings()
      .then(() => {
        setLoaded(true)
      })
  }, [user, loadRemoteSettings])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--user-font-weight', user ? String(settings.font_weight ?? 420) : '420')
    root.style.setProperty('--user-font-size', user ? `${settings.font_size ?? 16}px` : '16px')
  }, [user, settings.font_weight, settings.font_size])

  useEffect(() => {
    const root = document.documentElement
    if (user && settings.body_font === 'sans') root.setAttribute('data-font', 'sans')
    else root.removeAttribute('data-font')
  }, [user, settings.body_font])

  useEffect(() => {
    const root = document.documentElement
    const sizes = {
      compact: { base: '0.62rem', tight: '0.56rem', list: '0.82rem' },
      default: { base: '0.68rem', tight: '0.60rem', list: '0.88rem' },
      large:   { base: '0.76rem', tight: '0.68rem', list: '0.96rem' },
    }
    const next = user ? (sizes[settings.card_name_size] || sizes.default) : sizes.default
    root.style.setProperty('--card-name-size', next.base)
    root.style.setProperty('--card-name-size-tight', next.tight)
    root.style.setProperty('--card-name-size-list', next.list)
  }, [user, settings.card_name_size])

  useEffect(() => {
    const themeId = user ? settings.theme : 'shadow'
    const oledMode = user ? settings.oled_mode : false
    applyTheme(themeId, oledMode, {
      userId: user?.id || null,
      archive_background_mode: settings.archive_background_mode,
      archive_background_cards: settings.archive_background_cards,
      archive_background_seed: settings.archive_background_seed,
      archive_background_locked: settings.archive_background_locked,
      archive_background_collection_source: settings.archive_background_collection_source,
      archive_background_blur: settings.archive_background_blur,
      archive_background_saturation: settings.archive_background_saturation,
      archive_background_opacity: settings.archive_background_opacity,
    })

    if (user && settings.higher_contrast) {
      const root = document.documentElement
      const theme = THEMES[settings.theme] || THEMES.shadow
      const contrastVars = theme.mode === 'light' ? LIGHT_CONTRAST_VARS : DARK_CONTRAST_VARS
      Object.entries(contrastVars).forEach(([key, value]) => {
        root.style.setProperty(key, value)
      })
    }
  }, [
    user,
    settings.theme,
    settings.oled_mode,
    settings.higher_contrast,
    settings.archive_background_mode,
    settings.archive_background_cards,
    settings.archive_background_seed,
    settings.archive_background_locked,
    settings.archive_background_collection_source,
    settings.archive_background_blur,
    settings.archive_background_saturation,
    settings.archive_background_opacity,
  ])

  useEffect(() => {
    const root = document.documentElement
    if (user && settings.reduce_motion) root.setAttribute('data-reduce-motion', 'true')
    else root.removeAttribute('data-reduce-motion')
  }, [user, settings.reduce_motion])

  useEffect(() => {
    const root = document.documentElement
    if (user && settings.higher_contrast) root.setAttribute('data-high-contrast', 'true')
    else root.removeAttribute('data-high-contrast')
  }, [user, settings.higher_contrast])

  // Detect Stripe Checkout success redirect. The webhook owns the entitlement;
  // this only refreshes local state after Stripe sends the user back.
  useEffect(() => {
    if (!user?.id) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('premium_checkout') !== 'success') return

    params.delete('premium_checkout')
    params.delete('session_id')
    const newSearch = params.toString()
    const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash
    window.history.replaceState({}, '', newUrl)

    let cancelled = false
    const refreshUntilUnlocked = async () => {
      for (let attempt = 0; attempt < 6 && !cancelled; attempt += 1) {
        const result = await loadRemoteSettings()
        if (result?.data?.premium) return
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    }
    refreshUntilUnlocked()
    return () => { cancelled = true }
  }, [user?.id, loadRemoteSettings])

  const performSync = useCallback(async (next) => {
    if (!user) return { ok: false, skipped: true }
    setSyncState('syncing')
    setSyncError('')
    try {
      const {
        price_source, default_sort, grid_density, show_price, cache_ttl_h,
        binder_sort, deck_sort, list_sort, font_weight, font_size, body_font, theme, oled_mode, nickname,
        anonymize_email, reduce_motion, higher_contrast, card_name_size, default_grouping,
        keep_screen_awake, show_sync_errors, page_tips_seen, archive_background_mode, archive_background_cards,
        profile_bio, profile_accent, profile_config,
      } = next
      const payload = {
        user_id: user.id,
        price_source, default_sort, grid_density, show_price, cache_ttl_h,
        binder_sort, deck_sort, list_sort, font_weight, font_size, body_font, theme, oled_mode, nickname,
        anonymize_email, reduce_motion, higher_contrast, card_name_size, default_grouping,
        keep_screen_awake, show_sync_errors, page_tips_seen, archive_background_mode, archive_background_cards,
        profile_bio, profile_accent, profile_config,
        updated_at: new Date().toISOString(),
      }
      const { error, omittedColumns } = await upsertSettingsWithSchemaFallback(payload)
      if (omittedColumns.length) {
        console.warn(`[Settings] Live user_settings schema is missing optional columns (${omittedColumns.join(', ')}); synced remaining settings only.`)
      }
      if (error) throw error
      setSyncState('saved')
      setLastSyncedAt(new Date().toISOString())
      return { ok: true }
    } catch (err) {
      const message = err?.message || 'Could not sync settings.'
      setSyncState('error')
      setSyncError(message)
      console.error('[Settings] Unexpected error syncing settings:', err)
      return { ok: false, error: message }
    }
  }, [user])

  const save = useCallback(async (patch) => {
    // Read from ref to merge against the latest settings — using the closed-over
    // `settings` here drops earlier patches when save() is called twice in the
    // same render before React has applied the first setSettings.
    const next = normalizeSettings({ ...settingsRef.current, ...patch })
    settingsRef.current = next
    setSettings(next)
    saveLocal(next)

    if (!user) return

    clearTimeout(syncTimeout.current)
    setSyncState('pending')
    syncTimeout.current = setTimeout(() => {
      performSync(settingsRef.current)
    }, 800)
  }, [user, performSync])

  const syncNow = useCallback(async () => {
    clearTimeout(syncTimeout.current)
    return performSync(settingsRef.current)
  }, [performSync])

  return (
    <SettingsContext.Provider value={{
      ...settings,
      save,
      refresh: loadRemoteSettings,
      loaded,
      syncNow,
      syncState,
      syncError,
      lastSyncedAt,
    }}>
      {children}
    </SettingsContext.Provider>
  )
}
