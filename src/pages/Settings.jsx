import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { THEMES } from '../components/SettingsContext'
import { clearScryfallCache, clearAllScryfallCache, PRICE_SOURCES } from '../lib/scryfall'
import { getDbStats } from '../lib/db'
import { SectionHeader, Button } from '../components/UI'
import styles from './Settings.module.css'
import CacheDebug from '../components/CacheDebug'

function formatAge(ms) {
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`
  return `${Math.round(ms / 86400000)}d ago`
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SettingRow({ label, description, children, onRowClick }) {
  return (
    <div className={styles.row} onClick={onRowClick} style={onRowClick ? { cursor: 'pointer' } : undefined}>
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

// ── Theme picker ──────────────────────────────────────────────────────────────
function ThemePicker({ value, onChange }) {
  return (
    <div className={styles.themeGrid}>
      {Object.entries(THEMES).map(([id, theme]) => {
        const active = value === id
        const { bg, accent, hi, text } = theme.preview
        return (
          <button
            key={id}
            className={`${styles.themeSwatch}${active ? ' ' + styles.themeSwatchActive : ''}`}
            style={{ '--swatch-bg': bg, '--swatch-accent': accent, '--swatch-hi': hi }}
            onClick={() => onChange(id)}
            title={theme.name}
          >
            {/* Miniature app preview */}
            <div className={styles.swatchPreview} style={{ background: bg }}>
              {/* Nav bar */}
              <div className={styles.swatchNav} style={{ borderColor: `${accent}30` }}>
                <div className={styles.swatchLogo} style={{ color: accent }}>AV</div>
                <div className={styles.swatchNavDots}>
                  <div className={styles.swatchDot} style={{ background: accent }} />
                  <div className={styles.swatchDot} style={{ background: `${hi}88` }} />
                  <div className={styles.swatchDot} style={{ background: `${accent}44` }} />
                </div>
              </div>
              {/* Dot grid */}
              <div
                className={styles.swatchDotGrid}
                style={{
                  backgroundImage: `radial-gradient(circle, ${accent}18 1px, transparent 1px)`,
                  backgroundSize: '8px 8px',
                }}
              />
              {/* Mini cards */}
              <div className={styles.swatchCards}>
                {[0,1,2,3].map(i => (
                  <div
                    key={i}
                    className={styles.swatchCard}
                    style={{
                      background: `${bg}`,
                      borderColor: `${accent}28`,
                      borderTopColor: `${accent}60`,
                    }}
                  >
                    <div className={styles.swatchCardBar} style={{ background: `${accent}30` }} />
                    <div className={styles.swatchCardLine} style={{ background: `${text}28` }} />
                    <div className={styles.swatchCardLine} style={{ background: `${text}18`, width: '70%' }} />
                  </div>
                ))}
              </div>
              {/* Active indicator */}
              {active && (
                <div className={styles.swatchActiveCheck} style={{ color: accent }}>✓</div>
              )}
            </div>
            {/* Label */}
            <div className={styles.swatchLabel}>
              <div className={styles.swatchName} style={{ color: active ? accent : text }}>
                {theme.name}
              </div>
              <div className={styles.swatchLore} style={{ color: `${text}88` }}>
                {theme.lore}
              </div>
            </div>
            {/* Color bar */}
            <div className={styles.swatchColorBar}>
              <div style={{ flex: 2, background: accent, borderRadius: '2px 0 0 2px' }} />
              <div style={{ flex: 1, background: hi }} />
              <div style={{ flex: 1, background: `${text}60`, borderRadius: '0 2px 2px 0' }} />
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Cache status ──────────────────────────────────────────────────────────────
function CacheStatus({ ttlH, onClear }) {
  const [info, setInfo]     = useState(null)
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
    setInfo(null); setCleared(true)
    setTimeout(() => setCleared(false), 2500)
    onClear?.()
  }

  const ttlMs     = ttlH * 3600000
  const pct       = info ? Math.min(100, Math.round((info.ageMs / ttlMs) * 100)) : 0
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
  const { user }   = useAuth()
  const settings   = useSettings()
  const [pwNew, setPwNew]     = useState('')
  const [pwMsg, setPwMsg]     = useState('')
  const [pwError, setPwError] = useState('')
  const [saving, setSaving]   = useState(false)

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

      {/* ── Appearance / Theme ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Appearance</div>

        <div className={styles.themeRow}>
          <div className={styles.themeLabel}>
            <div className={styles.rowTitle}>Colour Theme</div>
            <div className={styles.rowDesc}>Choose the colour palette for the entire app. Saved to your account and synced across devices.</div>
          </div>
          <ThemePicker value={settings.theme || 'shadow'} onChange={v => set('theme', v)} />
        </div>

        {/* OLED mode — only meaningful on dark themes */}
        {THEMES[settings.theme || 'shadow']?.mode !== 'light' && (
          <SettingRow
            label="OLED Black Mode"
            description="Sets backgrounds to pure black so OLED pixels are fully off, saving power and deepening contrast."
            onRowClick={() => set('oled_mode', !settings.oled_mode)}
          >
            <Toggle value={!!settings.oled_mode} onChange={v => set('oled_mode', v)} />
          </SettingRow>
        )}
      </div>

      {/* ── Typography ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Typography</div>
        <SettingRow label="Font Weight" description="How thick the body text appears — increase if text looks too thin on your screen">
          <div className={styles.fontWeightOptions}>
            {[
              { value: 300, label: 'Thin' },
              { value: 400, label: 'Regular' },
              { value: 420, label: 'Medium' },
              { value: 500, label: 'Bold' },
            ].map(({ value, label }) => (
              <button
                key={value}
                className={`${styles.fontOption} ${settings.font_weight === value ? styles.fontOptionActive : ''}`}
                style={{ fontWeight: value }}
                onClick={() => set('font_weight', value)}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Font Size" description="Base text size used throughout the app">
          <div className={styles.fontWeightOptions}>
            {[
              { value: 14, label: 'Small' },
              { value: 16, label: 'Default' },
              { value: 18, label: 'Large' },
              { value: 20, label: 'X-Large' },
            ].map(({ value, label }) => (
              <button
                key={value}
                className={`${styles.fontOption} ${settings.font_size === value ? styles.fontOptionActive : ''}`}
                style={{ fontSize: value }}
                onClick={() => set('font_size', value)}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Preview">
          <div className={styles.fontPreview}>
            The quick brown fox jumps over the lazy dog. <em>Italics.</em>
          </div>
        </SettingRow>
      </div>

      {/* ── Prices ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Prices</div>

        <SettingRow label="Price Source" description="Marketplace and price type used throughout the app">
          {/* Mobile: select dropdown */}
          <select
            className={styles.priceSourceSelect}
            value={settings.price_source}
            onChange={e => set('price_source', e.target.value)}
          >
            {PRICE_SOURCES.map(src => (
              <option key={src.id} value={src.id}>{src.label}</option>
            ))}
          </select>
          {/* Desktop: radio buttons */}
          <div className={styles.priceSourceRadios}>
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

        <SettingRow label="Show Price on Cards" description="Display price label in the card grid"
          onRowClick={() => set('show_price', !settings.show_price)}>
          <Toggle value={settings.show_price} onChange={v => set('show_price', v)} />
        </SettingRow>
      </div>

      {/* ── Display ── */}
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

      {/* ── Cache ── */}
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

      {/* ── Profile ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Profile</div>
        <SettingRow label="Preferred Nickname" description="Auto-fills as your name when creating a game lobby">
          <input
            className={styles.input}
            type="text"
            placeholder="Your in-game name"
            value={settings.nickname ?? ''}
            onChange={e => set('nickname', e.target.value)}
            maxLength={24}
          />
        </SettingRow>
      </div>

      {/* ── Account ── */}
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
          {pwMsg   && <div className={styles.pwMsg}>{pwMsg}</div>}
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
