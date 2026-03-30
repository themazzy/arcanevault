import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'

const SETTINGS_KEY = 'arcanevault_settings'

const LIGHT_SURFACE_VARS = {
  '--s-card': 'rgba(0,0,0,0.04)',
  '--s-subtle': 'rgba(0,0,0,0.065)',
  '--s-medium': 'rgba(0,0,0,0.09)',
  '--s-border': 'rgba(0,0,0,0.10)',
  '--s-border2': 'rgba(0,0,0,0.18)',
  '--overlay': 'rgba(0,0,0,0.07)',
  '--s1': 'rgba(0,0,0,0.035)',
  '--s2': 'rgba(0,0,0,0.06)',
  '--s3': 'rgba(0,0,0,0.085)',
  '--s4': 'rgba(0,0,0,0.11)',
  '--nav-bg': 'rgba(255,255,255,0.88)',
  '--popup-bg': 'var(--bg2)',
  '--ambient-1': 'rgba(214,171,94,0.12)',
  '--ambient-2': 'rgba(122,150,205,0.10)',
  '--glass-strong': 'rgba(255,255,255,0.9)',
  '--glass-medium': 'rgba(255,255,255,0.82)',
  '--glass-soft': 'rgba(255,255,255,0.72)',
  '--scrim-strong': 'rgba(233,238,245,0.82)',
  '--scrim-medium': 'rgba(233,238,245,0.62)',
  '--scrim-soft': 'rgba(233,238,245,0.42)',
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
    lore: 'Original Arcane Vault gold and violet',
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
}

const DEFAULTS = {
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
  theme: 'shadow',
  oled_mode: false,
  nickname: '',
}

const OLED_VARS = {
  '--bg': '#000000',
  '--bg2': '#000000',
  '--bg3': '#000000',
  '--s1': '#000000',
  '--s2': '#000000',
  '--s3': '#000000',
  '--s4': '#000000',
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return null
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return null
  }
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

export function applyTheme(themeId, oledMode) {
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

  cacheThemeVars(themeId, oledMode)
}

const SettingsContext = createContext({ ...DEFAULTS, save: () => {}, loaded: false })
export const useSettings = () => useContext(SettingsContext)

export function SettingsProvider({ children }) {
  const { user } = useAuth()
  const [settings, setSettings] = useState(() => loadLocal() || DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const syncTimeout = useRef(null)

  useEffect(() => {
    if (!user) return
    sb.from('user_settings').select('*').eq('user_id', user.id).maybeSingle()
      .then(({ data }) => {
        if (data) {
          const { user_id, updated_at, ...rest } = data
          const merged = { ...DEFAULTS, ...rest }
          if (!Object.prototype.hasOwnProperty.call(rest, 'theme')) {
            const local = loadLocal()
            if (local?.theme) merged.theme = local.theme
          }
          setSettings(merged)
          saveLocal(merged)
        }
        setLoaded(true)
      })
  }, [user])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--user-font-weight', String(settings.font_weight ?? 420))
    root.style.setProperty('--user-font-size', `${settings.font_size ?? 16}px`)
  }, [settings.font_weight, settings.font_size])

  useEffect(() => {
    applyTheme(settings.theme, settings.oled_mode)
  }, [settings.theme, settings.oled_mode])

  const save = useCallback(async (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveLocal(next)

    if (!user) return

    clearTimeout(syncTimeout.current)
    syncTimeout.current = setTimeout(async () => {
      try {
        const {
          price_source, default_sort, grid_density, show_price, cache_ttl_h,
          binder_sort, deck_sort, list_sort, font_weight, font_size, theme, oled_mode, nickname,
        } = next
        const { error } = await sb.from('user_settings').upsert(
          {
            user_id: user.id,
            price_source, default_sort, grid_density, show_price, cache_ttl_h,
            binder_sort, deck_sort, list_sort, font_weight, font_size, theme, oled_mode, nickname,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        )
        if (error) console.error('[Settings] Supabase upsert failed:', error)
      } catch (err) {
        console.error('[Settings] Unexpected error syncing settings:', err)
      }
    }, 800)
  }, [settings, user])

  return (
    <SettingsContext.Provider value={{ ...settings, save, loaded }}>
      {children}
    </SettingsContext.Provider>
  )
}
