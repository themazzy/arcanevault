import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'

const SETTINGS_KEY = 'arcanevault_settings'

// ── Themes ────────────────────────────────────────────────────────────────────
export const THEMES = {
  shadow: {
    name: 'Shadow',
    lore: 'Swamp · Dimir · Orzhov',
    preview: { bg: '#0a0a0f', accent: '#c9a84c', hi: '#8a6fc4', text: '#ddd0b8' },
    vars: {
      '--bg':          '#0a0a0f',
      '--bg2':         '#0e0c1a',
      '--bg3':         '#12101e',
      '--border':      'rgba(180,140,60,0.20)',
      '--border-hi':   'rgba(201,168,76,0.50)',
      '--gold':        '#c9a84c',
      '--gold-dim':    '#a08848',
      '--purple':      '#8a6fc4',
      '--green':       '#8ab87a',
      '--red':         '#c46060',
      '--text':        '#ddd0b8',
      '--text-dim':    '#a89878',
      '--text-faint':  '#857868',
      '--gold-glow':   '0 0 18px rgba(201,168,76,0.18)',
      '--input-focus': '0 0 0 3px rgba(201,168,76,0.12)',
    },
  },
  abyssal: {
    name: 'Abyssal',
    lore: 'Ocean · Simic · Merfolk',
    preview: { bg: '#080e14', accent: '#4cc4c9', hi: '#4c78c4', text: '#c8dce0' },
    vars: {
      '--bg':          '#080e14',
      '--bg2':         '#0b1420',
      '--bg3':         '#0f1c2c',
      '--border':      'rgba(60,160,180,0.20)',
      '--border-hi':   'rgba(76,196,201,0.50)',
      '--gold':        '#4cc4c9',
      '--gold-dim':    '#3aa0a8',
      '--purple':      '#4c78c4',
      '--green':       '#7abf8a',
      '--red':         '#c46060',
      '--text':        '#c8dce0',
      '--text-dim':    '#7aa8b8',
      '--text-faint':  '#527888',
      '--gold-glow':   '0 0 18px rgba(76,196,201,0.18)',
      '--input-focus': '0 0 0 3px rgba(76,196,201,0.12)',
    },
  },
  ember: {
    name: 'Ember',
    lore: 'Volcano · Rakdos · Boros',
    preview: { bg: '#0f0605', accent: '#e87040', hi: '#c44040', text: '#e4c8b8' },
    vars: {
      '--bg':          '#0f0605',
      '--bg2':         '#180a06',
      '--bg3':         '#200e08',
      '--border':      'rgba(200,100,60,0.20)',
      '--border-hi':   'rgba(232,112,64,0.50)',
      '--gold':        '#e87040',
      '--gold-dim':    '#c05830',
      '--purple':      '#c44040',
      '--green':       '#8ab87a',
      '--red':         '#e04040',
      '--text':        '#e4c8b8',
      '--text-dim':    '#b08870',
      '--text-faint':  '#886050',
      '--gold-glow':   '0 0 18px rgba(232,112,64,0.18)',
      '--input-focus': '0 0 0 3px rgba(232,112,64,0.12)',
    },
  },
  grove: {
    name: 'Grove',
    lore: 'Ancient Forest · Selesnya · Elf',
    preview: { bg: '#050f08', accent: '#6abf7a', hi: '#4c8a6f', text: '#c4e0c8' },
    vars: {
      '--bg':          '#050f08',
      '--bg2':         '#081508',
      '--bg3':         '#0c1c0c',
      '--border':      'rgba(60,160,90,0.20)',
      '--border-hi':   'rgba(106,191,122,0.50)',
      '--gold':        '#6abf7a',
      '--gold-dim':    '#508f60',
      '--purple':      '#4c8a6f',
      '--green':       '#8abf7a',
      '--red':         '#c46060',
      '--text':        '#c4e0c8',
      '--text-dim':    '#7aa888',
      '--text-faint':  '#527858',
      '--gold-glow':   '0 0 18px rgba(106,191,122,0.18)',
      '--input-focus': '0 0 0 3px rgba(106,191,122,0.12)',
    },
  },
  void: {
    name: 'Void',
    lore: 'Aether · Dimir · Eldrazi',
    preview: { bg: '#08050f', accent: '#b46cc4', hi: '#6c4cc4', text: '#d8c8e8' },
    vars: {
      '--bg':          '#08050f',
      '--bg2':         '#0e0818',
      '--bg3':         '#140c20',
      '--border':      'rgba(140,80,180,0.20)',
      '--border-hi':   'rgba(180,108,196,0.50)',
      '--gold':        '#b46cc4',
      '--gold-dim':    '#8a50a0',
      '--purple':      '#6c4cc4',
      '--green':       '#8ab87a',
      '--red':         '#c46060',
      '--text':        '#d8c8e8',
      '--text-dim':    '#9880b8',
      '--text-faint':  '#705888',
      '--gold-glow':   '0 0 18px rgba(180,108,196,0.18)',
      '--input-focus': '0 0 0 3px rgba(180,108,196,0.12)',
    },
  },
  storm: {
    name: 'Storm',
    lore: 'Lightning · Izzet · Wizard',
    preview: { bg: '#060a14', accent: '#60a8e8', hi: '#4060c4', text: '#c8d8e8' },
    vars: {
      '--bg':          '#060a14',
      '--bg2':         '#0a1020',
      '--bg3':         '#0e1628',
      '--border':      'rgba(60,120,200,0.20)',
      '--border-hi':   'rgba(96,168,232,0.50)',
      '--gold':        '#60a8e8',
      '--gold-dim':    '#4880c0',
      '--purple':      '#4060c4',
      '--green':       '#8ab87a',
      '--red':         '#c46060',
      '--text':        '#c8d8e8',
      '--text-dim':    '#7898b8',
      '--text-faint':  '#507080',
      '--gold-glow':   '0 0 18px rgba(96,168,232,0.18)',
      '--input-focus': '0 0 0 3px rgba(96,168,232,0.12)',
    },
  },

  // ── Light themes ────────────────────────────────────────────────────────────
  parchment: {
    name: 'Parchment',
    lore: 'Plains · Vintage · Scroll',
    mode: 'light',
    preview: { bg: '#f5f0e2', accent: '#8c6020', hi: '#604890', text: '#1c1408' },
    vars: {
      '--bg':          '#f5f0e2',
      '--bg2':         '#ece6d4',
      '--bg3':         '#e4dcc8',
      '--border':      'rgba(100,70,20,0.20)',
      '--border-hi':   'rgba(140,96,32,0.50)',
      '--gold':        '#8c6020',
      '--gold-dim':    '#6a4818',
      '--purple':      '#604890',
      '--green':       '#3a7848',
      '--red':         '#a03030',
      '--text':        '#1c1408',
      '--text-dim':    '#5c4830',
      '--text-faint':  '#8c7858',
      '--gold-glow':   '0 0 18px rgba(140,96,32,0.22)',
      '--input-focus': '0 0 0 3px rgba(140,96,32,0.14)',
      '--s-card':      'rgba(0,0,0,0.04)',
      '--s-subtle':    'rgba(0,0,0,0.065)',
      '--s-medium':    'rgba(0,0,0,0.09)',
      '--s-border':    'rgba(0,0,0,0.10)',
      '--s-border2':   'rgba(0,0,0,0.18)',
      '--overlay':     'rgba(0,0,0,0.07)',
    },
  },

  daybreak: {
    name: 'Daybreak',
    lore: 'Island · Dawn · Azorius',
    mode: 'light',
    preview: { bg: '#f0f4f8', accent: '#2a5fa0', hi: '#4a6080', text: '#0a1422' },
    vars: {
      '--bg':          '#f0f4f8',
      '--bg2':         '#e4eaf4',
      '--bg3':         '#d8e0ef',
      '--border':      'rgba(30,70,150,0.16)',
      '--border-hi':   'rgba(42,95,160,0.45)',
      '--gold':        '#2a5fa0',
      '--gold-dim':    '#204880',
      '--purple':      '#4a6080',
      '--green':       '#2a7840',
      '--red':         '#a03030',
      '--text':        '#0a1422',
      '--text-dim':    '#3a4860',
      '--text-faint':  '#687090',
      '--gold-glow':   '0 0 18px rgba(42,95,160,0.20)',
      '--input-focus': '0 0 0 3px rgba(42,95,160,0.14)',
      '--s-card':      'rgba(0,0,0,0.04)',
      '--s-subtle':    'rgba(0,0,0,0.065)',
      '--s-medium':    'rgba(0,0,0,0.09)',
      '--s-border':    'rgba(0,0,0,0.10)',
      '--s-border2':   'rgba(0,0,0,0.18)',
      '--overlay':     'rgba(0,0,0,0.07)',
    },
  },

  bloom: {
    name: 'Bloom',
    lore: 'Forest · Spring · Selesnya',
    mode: 'light',
    preview: { bg: '#f9f0ee', accent: '#b04060', hi: '#406840', text: '#1a0810' },
    vars: {
      '--bg':          '#f9f0ee',
      '--bg2':         '#f0e4e0',
      '--bg3':         '#e8d8d4',
      '--border':      'rgba(150,40,70,0.18)',
      '--border-hi':   'rgba(176,64,96,0.45)',
      '--gold':        '#b04060',
      '--gold-dim':    '#8c3050',
      '--purple':      '#406840',
      '--green':       '#3a7848',
      '--red':         '#c03030',
      '--text':        '#1a0810',
      '--text-dim':    '#583040',
      '--text-faint':  '#885060',
      '--gold-glow':   '0 0 18px rgba(176,64,96,0.20)',
      '--input-focus': '0 0 0 3px rgba(176,64,96,0.14)',
      '--s-card':      'rgba(0,0,0,0.04)',
      '--s-subtle':    'rgba(0,0,0,0.065)',
      '--s-medium':    'rgba(0,0,0,0.09)',
      '--s-border':    'rgba(0,0,0,0.10)',
      '--s-border2':   'rgba(0,0,0,0.18)',
      '--overlay':     'rgba(0,0,0,0.07)',
    },
  },
}

// ── Defaults ──────────────────────────────────────────────────────────────────
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
}

// OLED overrides — pure black backgrounds so dark-theme pixels are fully off
const OLED_VARS = {
  '--bg':  '#000000',
  '--bg2': '#000000',
  '--bg3': '#000000',
  '--s1':  '#000000',
  '--s2':  '#000000',
  '--s3':  '#000000',
  '--s4':  '#000000',
}

// ── Persistence helpers ───────────────────────────────────────────────────────
function loadLocal() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return null
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch { return null }
}

function saveLocal(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {}
}

// Cache just the theme vars so index.html inline script can apply them
// before React boots (prevents flash of wrong theme on hard refresh).
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

// ── Apply theme CSS vars to :root ─────────────────────────────────────────────
export function applyTheme(themeId, oledMode) {
  const theme = THEMES[themeId] || THEMES.shadow
  const root = document.documentElement
  Object.entries(theme.vars).forEach(([key, value]) => {
    root.style.setProperty(key, value)
  })
  // Overlay OLED vars on dark themes — pure black so pixels are fully off
  if (oledMode && theme.mode !== 'light') {
    Object.entries(OLED_VARS).forEach(([key, value]) => {
      root.style.setProperty(key, value)
    })
  }
  // Set light-mode attribute so global CSS can override surface patterns
  if (theme.mode === 'light') {
    root.setAttribute('data-theme-mode', 'light')
  } else {
    root.removeAttribute('data-theme-mode')
  }
  // Set OLED attribute so global CSS can zero out hardcoded rgba backgrounds
  if (oledMode && theme.mode !== 'light') {
    root.setAttribute('data-oled', 'true')
  } else {
    root.removeAttribute('data-oled')
  }
  // Persist theme vars for instant application on next page load
  cacheThemeVars(themeId, oledMode)
}

// ── Context ───────────────────────────────────────────────────────────────────
const SettingsContext = createContext({ ...DEFAULTS, save: () => {}, loaded: false })
export const useSettings = () => useContext(SettingsContext)

export function SettingsProvider({ children }) {
  const { user } = useAuth()
  const [settings, setSettings] = useState(() => loadLocal() || DEFAULTS)
  const [loaded, setLoaded]     = useState(false)
  const syncTimeout             = useRef(null)

  // Pull from Supabase on mount — Supabase wins for cross-device sync
  useEffect(() => {
    if (!user) return
    sb.from('user_settings').select('*').eq('user_id', user.id).maybeSingle()
      .then(({ data }) => {
        if (data) {
          const { user_id, updated_at, ...rest } = data
          const merged = { ...DEFAULTS, ...rest }
          // If the DB row doesn't have a theme column yet, keep whatever
          // the user last set locally rather than resetting to the default.
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

  // Apply font settings
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--user-font-weight', String(settings.font_weight ?? 420))
    root.style.setProperty('--user-font-size', `${settings.font_size ?? 16}px`)
  }, [settings.font_weight, settings.font_size])

  // Apply theme CSS variables (re-run when theme or oled_mode changes)
  useEffect(() => {
    applyTheme(settings.theme, settings.oled_mode)
  }, [settings.theme, settings.oled_mode])

  const save = useCallback(async (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveLocal(next)

    if (!user) return   // not logged in — local save only

    clearTimeout(syncTimeout.current)
    syncTimeout.current = setTimeout(async () => {
      try {
        const {
          price_source, default_sort, grid_density, show_price, cache_ttl_h,
          binder_sort, deck_sort, list_sort, font_weight, font_size, theme, oled_mode,
        } = next
        const { error } = await sb.from('user_settings').upsert(
          {
            user_id: user.id,
            price_source, default_sort, grid_density, show_price, cache_ttl_h,
            binder_sort, deck_sort, list_sort, font_weight, font_size, theme, oled_mode,
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
