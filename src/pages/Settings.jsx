import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { clearScryfallCache, clearAllScryfallCache, PRICE_SOURCES, getPriceSource } from '../lib/scryfall'
import { getDbStats } from '../lib/db'
import { SectionHeader, Button } from '../components/UI'
import styles from './Settings.module.css'
import CacheDebug from '../components/CacheDebug'

// ── Helpers ───────────────────────────────────────────────────────────────────
// Cache info now comes from IndexedDB via getDbStats()

function formatAge(ms) {
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`
  return `${Math.round(ms / 86400000)}d ago`
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SettingRow({ label, description, children }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowLabel}>
        <div className={styles.rowTitle}>{label}</div>
        {description && <div className={styles.rowDesc}>{description}</div>}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

function Select({ value, onChange, options }) {
  return (
    <select className={styles.select} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
    </select>
  )
}

function Toggle({ value, onChange }) {
  return (
    <button
      className={`${styles.toggle}${value ? ' ' + styles.toggleOn : ''}`}
      onClick={() => onChange(!value)}
    >
      <span className={styles.toggleKnob} />
    </button>
  )
}

function CacheStatus({ ttlH, onClear }) {
  const [info, setInfo] = useState(null)
  const [cleared, setCleared] = useState(false)

  const loadInfo = async () => {
    const stats = await getDbStats()
    if (!stats.sfUpdatedAt) { setInfo(null); return }
    setInfo({ cardCount: stats.scryfall, ageMs: Date.now() - stats.sfUpdatedAt, ts: stats.sfUpdatedAt, sizeKB: 0 })
  }

  useEffect(() => { loadInfo() }, [])
  useEffect(() => {
    const t = setInterval(loadInfo, 60000)
    return () => clearInterval(t)
  }, [])

  const handleClear = async () => {
    await clearScryfallCache()
    setInfo(null)
    setCleared(true)
    setTimeout(() => setCleared(false), 2500)
    onClear?.()
  }

  const ttlMs = ttlH * 3600000
  const pct = info ? Math.min(100, Math.round((info.ageMs / ttlMs) * 100)) : 0
  const isExpired = info ? info.ageMs > ttlMs : false
  const expiresIn = info && !isExpired
    ? formatAge(ttlMs - info.ageMs).replace(' ago', '')
    : null

  return (
    <div className={styles.cachePanel}>
      {info ? (
        <>
          <div className={styles.cacheStats}>
            <div className={styles.cacheStat}>
              <span className={styles.cacheStatVal}>{info.cardCount.toLocaleString()}</span>
              <span className={styles.cacheStatLabel}>cards cached</span>
            </div>
            <div className={styles.cacheDivider} />
            <div className={styles.cacheStat}>
              <span className={styles.cacheStatVal}>{info.sizeKB} KB</span>
              <span className={styles.cacheStatLabel}>stored size</span>
            </div>
            <div className={styles.cacheDivider} />
            <div className={styles.cacheStat}>
              <span className={styles.cacheStatVal}>{formatAge(info.ageMs)}</span>
              <span className={styles.cacheStatLabel}>last fetched</span>
            </div>
            <div className={styles.cacheDivider} />
            <div className={styles.cacheStat}>
              <span className={`${styles.cacheStatVal} ${isExpired ? styles.cacheExpired : styles.cacheOk}`}>
                {isExpired ? 'Expired' : `in ${expiresIn}`}
              </span>
              <span className={styles.cacheStatLabel}>expires</span>
            </div>
          </div>

          <div className={styles.cacheBarWrap}>
            <div
              className={`${styles.cacheBar} ${isExpired ? styles.cacheBarExpired : ''}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className={styles.cacheBarLabels}>
            <span>Fresh</span>
            <span>{isExpired ? 'Expired — will refresh on next visit' : `${ttlH}h TTL`}</span>
          </div>
        </>
      ) : (
        <div className={styles.cacheEmpty}>
          {cleared
            ? '✓ Cache cleared — prices will be fetched on next visit'
            : 'No cache — prices will be fetched on next collection visit'}
        </div>
      )}

      <div className={styles.cacheActions}>
        <Button
          variant={cleared ? 'green' : 'danger'}
          size="sm"
          onClick={handleClear}
          disabled={!info && !cleared}
        >
          {cleared ? '✓ Cleared' : 'Clear Prices'}
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => { clearAllScryfallCache(); setInfo(null); setCleared(true); setTimeout(() => setCleared(false), 2500); onClear?.() }}
          disabled={!info}
          style={{ marginLeft: 8 }}
        >
          Clear All (incl. images)
        </Button>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const { user } = useAuth()
  const settings = useSettings()
  const [pwNew, setPwNew] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [pwError, setPwError] = useState('')
  const [saving, setSaving] = useState(false)

  const set = async (key, value) => {
    setSaving(true)
    await settings.save({ [key]: value })
    setSaving(false)
  }

  const handleChangePassword = async () => {
    setPwMsg(''); setPwError('')
    if (pwNew.length < 6) { setPwError('New password must be at least 6 characters.'); return }
    const { error } = await sb.auth.updateUser({ password: pwNew })
    if (error) setPwError(error.message)
    else { setPwMsg('Password updated.'); setPwNew('') }
  }

  return (
    <div className={styles.page}>
      <SectionHeader title="Settings" />

      {/* Prices */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Prices</div>

        <SettingRow label="Price Source" description="Marketplace and price type used throughout the app">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 260 }}>
            {PRICE_SOURCES.map(src => (
              <label key={src.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="price_source"
                  value={src.id}
                  checked={settings.price_source === src.id}
                  onChange={() => set('price_source', src.id)}
                  style={{ marginTop: 3, accentColor: 'var(--gold)' }}
                />
                <div>
                  <div style={{ fontSize: '0.88rem', color: settings.price_source === src.id ? 'var(--gold)' : 'var(--text)' }}>
                    {src.label}
                  </div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-faint)', marginTop: 1 }}>{src.description}</div>
                </div>
              </label>
            ))}
          </div>
        </SettingRow>

        <SettingRow label="Show Price on Cards" description="Display price label in the card grid">
          <Toggle value={settings.show_price} onChange={v => set('show_price', v)} />
        </SettingRow>
      </div>

      {/* Display */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Display</div>
        <SettingRow label="Default Sort" description="How cards are sorted when opening the collection">
          <Select value={settings.default_sort} onChange={v => set('default_sort', v)}
            options={[
              ['name', 'Name'], ['price_desc', 'Price (high → low)'],
              ['price_asc', 'Price (low → high)'], ['qty', 'Quantity'],
              ['set', 'Set'], ['added', 'Recently Added'],
            ]} />
        </SettingRow>
        <SettingRow label="Grid Density" description="How many cards to show per row">
          <Select value={settings.grid_density} onChange={v => set('grid_density', v)}
            options={[
              ['cozy', 'Cozy (fewer, larger)'],
              ['comfortable', 'Comfortable (default)'],
              ['compact', 'Compact (more, smaller)'],
            ]} />
        </SettingRow>
      </div>

      {/* Cache */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Price Cache</div>
        <SettingRow label="Cache Duration" description="How long Scryfall prices are stored locally">
          <Select value={String(settings.cache_ttl_h)} onChange={v => set('cache_ttl_h', parseInt(v))}
            options={[['12', '12 hours'], ['24', '24 hours (default)'], ['48', '48 hours'], ['168', '1 week']]} />
        </SettingRow>
        <div className={styles.cachePanelWrap}>
          <CacheStatus ttlH={settings.cache_ttl_h} />
          <CacheDebug />
        </div>
      </div>

      {/* Account */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Account</div>
        <SettingRow label="Email">
          <span className={styles.email}>{user?.email}</span>
        </SettingRow>
        <SettingRow label="Change Password">
          <div className={styles.pwForm}>
            <input className={styles.input} type="password" placeholder="New password"
              value={pwNew} onChange={e => setPwNew(e.target.value)} />
            <Button size="sm" onClick={handleChangePassword} disabled={!pwNew}>Update</Button>
          </div>
          {pwError && <div className={styles.pwError}>{pwError}</div>}
          {pwMsg && <div className={styles.pwMsg}>{pwMsg}</div>}
        </SettingRow>
        <SettingRow label="Sign Out Everywhere" description="Signs out all sessions on all devices">
          <Button variant="danger" size="sm" onClick={() => sb.auth.signOut({ scope: 'global' })}>
            Sign Out All
          </Button>
        </SettingRow>
      </div>

      {saving && <div className={styles.savingIndicator}>Saving…</div>}
    </div>
  )
}
