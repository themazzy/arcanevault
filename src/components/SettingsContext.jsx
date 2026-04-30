import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import { fetchScryfallBatch, sfGet } from '../lib/scryfall'

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
    lore: 'Original DeckLoom gold and violet',
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
  azorius: createLightTheme({
    name: 'Azorius',
    lore: 'Law magic, marble halls, cold dawn skies',
    bg: '#edf4fb',
    bg2: '#e0ebf7',
    bg3: '#d4e1f0',
    accent: '#3c78c2',
    accentDim: '#2d5d98',
    hi: '#9db7d9',
    text: '#102033',
    textDim: '#4f6278',
    textFaint: '#7c8ea6',
    border: 'rgba(42,92,150,0.18)',
    borderHi: 'rgba(60,120,194,0.44)',
    glow: '0 0 18px rgba(60,120,194,0.20)',
    focus: '0 0 0 3px rgba(60,120,194,0.14)',
  }),
  dimir: createDarkTheme({
    name: 'Dimir',
    lore: 'Midnight archives, secrets, and deep-water ink',
    bg: '#071019',
    bg2: '#0b1624',
    bg3: '#101d2e',
    accent: '#4e8ecf',
    accentDim: '#3b6e9f',
    hi: '#4e5fae',
    text: '#ccdae8',
    textDim: '#7f97b2',
    textFaint: '#5a6e84',
    border: 'rgba(60,110,180,0.20)',
    borderHi: 'rgba(78,142,207,0.48)',
    glow: '0 0 18px rgba(78,142,207,0.18)',
    focus: '0 0 0 3px rgba(78,142,207,0.12)',
  }),
  rakdos: createDarkTheme({
    name: 'Rakdos',
    lore: 'Infernal carnival, brass sparks, and blood velvet',
    bg: '#130708',
    bg2: '#1b0b0d',
    bg3: '#240f12',
    accent: '#d84d4d',
    accentDim: '#a83a3a',
    hi: '#f07b3f',
    text: '#ebcbc4',
    textDim: '#bd8b81',
    textFaint: '#91675e',
    border: 'rgba(190,70,70,0.20)',
    borderHi: 'rgba(216,77,77,0.48)',
    glow: '0 0 18px rgba(216,77,77,0.18)',
    focus: '0 0 0 3px rgba(216,77,77,0.12)',
  }),
  gruul: createDarkTheme({
    name: 'Gruul',
    lore: 'Ash, moss, and the riot of broken stone',
    bg: '#0d0b07',
    bg2: '#15110a',
    bg3: '#1e160d',
    accent: '#cf7c39',
    accentDim: '#9f5f2c',
    hi: '#6b8b3f',
    text: '#e2d3bc',
    textDim: '#af9976',
    textFaint: '#837056',
    border: 'rgba(170,100,50,0.20)',
    borderHi: 'rgba(207,124,57,0.48)',
    glow: '0 0 18px rgba(207,124,57,0.18)',
    focus: '0 0 0 3px rgba(207,124,57,0.12)',
  }),
  selesnya: createLightTheme({
    name: 'Selesnya',
    lore: 'Sunlit gardens, polished ivory, and living canopies',
    bg: '#f4f7ee',
    bg2: '#e8efde',
    bg3: '#dde7cf',
    accent: '#5f9f52',
    accentDim: '#497c3f',
    hi: '#c3b77e',
    text: '#182211',
    textDim: '#53654a',
    textFaint: '#819074',
    border: 'rgba(70,110,50,0.18)',
    borderHi: 'rgba(95,159,82,0.44)',
    glow: '0 0 18px rgba(95,159,82,0.20)',
    focus: '0 0 0 3px rgba(95,159,82,0.14)',
  }),
  orzhov: createLightTheme({
    name: 'Orzhov',
    lore: 'Cathedral gold, black silk, and ghostly ledgers',
    bg: '#f5f1e8',
    bg2: '#ebe3d5',
    bg3: '#e1d6c4',
    accent: '#b89548',
    accentDim: '#8d7238',
    hi: '#6b6179',
    text: '#18130f',
    textDim: '#5c4c3b',
    textFaint: '#8c7b68',
    border: 'rgba(110,85,40,0.18)',
    borderHi: 'rgba(184,149,72,0.44)',
    glow: '0 0 18px rgba(184,149,72,0.20)',
    focus: '0 0 0 3px rgba(184,149,72,0.14)',
  }),
  izzet: createDarkTheme({
    name: 'Izzet',
    lore: 'Charged coils, bright copper, and stormglass blue',
    bg: '#08101a',
    bg2: '#0c1724',
    bg3: '#102032',
    accent: '#4a9fe7',
    accentDim: '#377ab3',
    hi: '#de6238',
    text: '#d5e2ef',
    textDim: '#8ea3bb',
    textFaint: '#66788c',
    border: 'rgba(70,140,210,0.20)',
    borderHi: 'rgba(74,159,231,0.48)',
    glow: '0 0 18px rgba(74,159,231,0.18)',
    focus: '0 0 0 3px rgba(74,159,231,0.12)',
  }),
  golgari: createDarkTheme({
    name: 'Golgari',
    lore: 'Rot gardens, bioluminescent spores, and grave loam',
    bg: '#070d09',
    bg2: '#0c1510',
    bg3: '#111d15',
    accent: '#6ea046',
    accentDim: '#557c36',
    hi: '#7b5d9a',
    text: '#d2ddca',
    textDim: '#8fa082',
    textFaint: '#68745f',
    border: 'rgba(90,130,60,0.20)',
    borderHi: 'rgba(110,160,70,0.48)',
    glow: '0 0 18px rgba(110,160,70,0.18)',
    focus: '0 0 0 3px rgba(110,160,70,0.12)',
  }),
  boros: createLightTheme({
    name: 'Boros',
    lore: 'Battle banners, white stone, and furnace-bright steel',
    bg: '#f7f1ee',
    bg2: '#efe5df',
    bg3: '#e7d9d1',
    accent: '#d45d3f',
    accentDim: '#a84831',
    hi: '#c3aa67',
    text: '#21130f',
    textDim: '#6e4d43',
    textFaint: '#9a7568',
    border: 'rgba(160,70,50,0.18)',
    borderHi: 'rgba(212,93,63,0.44)',
    glow: '0 0 18px rgba(212,93,63,0.20)',
    focus: '0 0 0 3px rgba(212,93,63,0.14)',
  }),
  simic: createDarkTheme({
    name: 'Simic',
    lore: 'Laboratory reefs, sea-glass teal, and adaptive bloom',
    bg: '#061117',
    bg2: '#0a1820',
    bg3: '#0e2029',
    accent: '#44b8b0',
    accentDim: '#358c87',
    hi: '#6bc16f',
    text: '#cde5e1',
    textDim: '#81a79f',
    textFaint: '#5a7f79',
    border: 'rgba(50,140,150,0.20)',
    borderHi: 'rgba(68,184,176,0.48)',
    glow: '0 0 18px rgba(68,184,176,0.18)',
    focus: '0 0 0 3px rgba(68,184,176,0.12)',
  }),

  // ── Premium themes ──────────────────────────────────────────────────────────
  obsidian: createDarkTheme({
    name: 'Obsidian Night',
    lore: 'Pure void, electric violet, and distant nebulae',
    bg: '#000000',
    bg2: '#050508',
    bg3: '#0b0910',
    accent: '#b08fff',
    accentDim: '#8060d0',
    hi: '#60b0ff',
    text: '#e8e0f8',
    textDim: '#a098c8',
    textFaint: '#6a6090',
    border: 'rgba(160,128,255,0.18)',
    borderHi: 'rgba(176,143,255,0.52)',
    glow: '0 0 28px rgba(160,128,255,0.32)',
    focus: '0 0 0 3px rgba(160,128,255,0.18)',
  }),
  crimson_court: createDarkTheme({
    name: 'Crimson Court',
    lore: 'Blood velvet, vampire halls, and aged gold candlelight',
    bg: '#0d0103',
    bg2: '#160308',
    bg3: '#1e040b',
    accent: '#cc2244',
    accentDim: '#991833',
    hi: '#d4903a',
    text: '#f0d8d0',
    textDim: '#c09080',
    textFaint: '#906068',
    border: 'rgba(180,28,58,0.22)',
    borderHi: 'rgba(204,34,68,0.55)',
    glow: '0 0 28px rgba(200,30,60,0.34)',
    focus: '0 0 0 3px rgba(200,30,60,0.18)',
  }),
  verdant_realm: createDarkTheme({
    name: 'Verdant Realm',
    lore: 'Bioluminescent spores, forest void, and emerald heartwood',
    bg: '#020d05',
    bg2: '#071509',
    bg3: '#0e1e11',
    accent: '#3dba74',
    accentDim: '#2e9059',
    hi: '#7fd4a0',
    text: '#d8f0e0',
    textDim: '#88b898',
    textFaint: '#608070',
    border: 'rgba(50,170,100,0.20)',
    borderHi: 'rgba(61,186,116,0.50)',
    glow: '0 0 28px rgba(50,180,100,0.28)',
    focus: '0 0 0 3px rgba(50,180,100,0.14)',
  }),
  archive_dark: createDarkTheme({
    name: 'Arcane Archive',
    lore: 'Personal card art, dark glass, and gallery shadows',
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
export const PREMIUM_THEMES = new Set(['obsidian', 'crimson_court', 'verdant_realm', 'archive_dark', 'archive_light'])

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
    archive_background_mode: settings.archive_background_mode === 'selected' ? 'selected' : 'random',
    archive_background_cards: Array.isArray(settings.archive_background_cards)
      ? settings.archive_background_cards.filter(card => card && typeof card === 'object').slice(0, 12)
      : [],
    archive_background_seed: Number.isFinite(Number(settings.archive_background_seed))
      ? Number(settings.archive_background_seed)
      : 0,
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
let archiveRequestSeq = 0

async function getArchiveAmbientCards(options = {}) {
  const selected = Array.isArray(options.archive_background_cards) ? options.archive_background_cards : []
  if (options.archive_background_mode === 'selected' && selected.length) {
    const cached = selected.filter(card => card?.id && card?.image)
    if (cached.length >= Math.min(6, selected.length)) return cached.slice(0, 12)
    const cards = await fetchScryfallBatch(selected.filter(card => card?.id).map(card => ({ id: card.id })))
    return cards.map(normalizeArchiveCard).filter(Boolean).slice(0, 12)
  }

  // Seed is appended to bypass the browser's HTTP cache — without it, fetch reuses
  // the prior response for identical URLs and order=random returns the same cards.
  const seed = Number(options.archive_background_seed) || Date.now()
  const data = await sfGet(`/cards/search?q=${encodeURIComponent(ARCHIVE_RANDOM_QUERY)}&order=random&unique=art&_=${seed}`)
  return (data?.data || []).map(normalizeArchiveCard).filter(Boolean).slice(0, 12)
}

function renderArchiveAmbient(el, cards) {
  el.querySelectorAll('.av-archive-card').forEach(node => node.remove())
  const visible = cards.slice(0, 6)
  visible.forEach((card, index) => {
    const tile = document.createElement('div')
    tile.className = 'av-archive-card'
    tile.style.setProperty('--archive-card-image', `url("${card.image}")`)
    tile.style.setProperty('--archive-card-i', String(index))
    tile.setAttribute('aria-hidden', 'true')
    el.appendChild(tile)
  })
}

function clearArchiveAmbient(el) {
  el.querySelectorAll('.av-archive-card').forEach(node => node.remove())
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
    obsidian: 'radial-gradient(ellipse 52% 42% at 14% 18%, rgba(96,176,255,0.10) 0%, transparent 58%), radial-gradient(ellipse 46% 38% at 84% 78%, rgba(176,143,255,0.10) 0%, transparent 60%), linear-gradient(135deg, rgba(96,176,255,0.040), transparent 40%, rgba(176,143,255,0.030))',
    crimson_court: 'radial-gradient(ellipse 46% 56% at 8% 48%, rgba(200,34,68,0.13) 0%, transparent 50%), radial-gradient(ellipse 34% 50% at 88% 52%, rgba(212,144,58,0.11) 0%, transparent 52%), radial-gradient(circle at 50% 50%, rgba(255,210,150,0.030), transparent 38%)',
    verdant_realm: 'radial-gradient(ellipse 58% 42% at 24% 82%, rgba(61,186,116,0.13) 0%, transparent 58%), radial-gradient(ellipse 42% 36% at 76% 22%, rgba(176,220,120,0.08) 0%, transparent 56%), linear-gradient(160deg, rgba(61,186,116,0.030), transparent 46%, rgba(127,212,160,0.020))',
    archive_dark: 'linear-gradient(180deg, rgba(5,5,9,0.54), rgba(5,5,9,0.76))',
    archive_light: 'linear-gradient(180deg, rgba(247,241,230,0.42), rgba(247,241,230,0.66))',
  }

  el.style.background = gradients[themeId] || ''
  el.dataset.theme = themeId
  if (isArchive) updateArchiveAmbient(el, themeId, options)
  else clearArchiveAmbient(el)
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
      archive_background_mode: settings.archive_background_mode,
      archive_background_cards: settings.archive_background_cards,
      archive_background_seed: settings.archive_background_seed,
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
