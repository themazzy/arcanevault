import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'

const SETTINGS_KEY = 'arcanevault_settings'

const DEFAULTS = {
  price_source: 'cardmarket_trend',
  display_currency: 'EUR',  // EUR | USD — for conversion
  default_sort: 'name',
  grid_density: 'comfortable',
  show_price: true,
  cache_ttl_h: 24,
}

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

const SettingsContext = createContext({ ...DEFAULTS, save: () => {}, loaded: false })
export const useSettings = () => useContext(SettingsContext)

export function SettingsProvider({ children }) {
  const { user } = useAuth()
  // Initialise from localStorage immediately — no flash of defaults
  const [settings, setSettings] = useState(() => loadLocal() || DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const syncTimeout = useRef(null)

  // On mount: pull from Supabase and merge (Supabase wins for cross-device sync)
  useEffect(() => {
    if (!user) return
    sb.from('user_settings').select('*').eq('user_id', user.id).maybeSingle()
      .then(({ data }) => {
        if (data) {
          const { user_id, updated_at, ...rest } = data
          const merged = { ...DEFAULTS, ...rest }
          setSettings(merged)
          saveLocal(merged)
        }
        setLoaded(true)
      })
  }, [user])

  const save = useCallback(async (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveLocal(next)  // Instant — localStorage always works

    // Debounce Supabase sync by 800ms to avoid hammering on toggle flicks
    clearTimeout(syncTimeout.current)
    syncTimeout.current = setTimeout(async () => {
      const { price_source, display_currency, default_sort, grid_density, show_price, cache_ttl_h } = next
      const { error } = await sb.from('user_settings').upsert(
        { user_id: user.id, price_source, display_currency, default_sort, grid_density, show_price, cache_ttl_h, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
      if (error) console.warn('Settings sync failed (table may not exist yet):', error.message)
    }, 800)
  }, [settings, user])

  return (
    <SettingsContext.Provider value={{ ...settings, save, loaded }}>
      {children}
    </SettingsContext.Provider>
  )
}
