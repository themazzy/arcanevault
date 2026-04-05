import { useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { maskEmailAddress, THEMES, useSettings } from '../components/SettingsContext'
import { clearScryfallCache, PRICE_SOURCES } from '../lib/scryfall'
import { getDbStats } from '../lib/db'
import { Button, SectionHeader, Select as UISelect } from '../components/UI'
import styles from './Settings.module.css'

const APP_VERSION = __APP_VERSION__

function formatAge(ms) {
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`
  return `${Math.round(ms / 86400000)}d ago`
}

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
    <UISelect className={styles.select} value={value} onChange={e => onChange(e.target.value)} title="Select setting">
      {options.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
    </UISelect>
  )
}

function Toggle({ value, onChange }) {
  return (
    <button
      type="button"
      className={`${styles.toggle}${value ? ' ' + styles.toggleOn : ''}`}
      aria-pressed={value}
      onClick={e => {
        e.stopPropagation()
        onChange(!value)
      }}
    >
      <span className={styles.toggleKnob} />
    </button>
  )
}

function ThemePicker({ value, onChange }) {
  return (
    <div className={styles.themeGrid}>
      {Object.entries(THEMES).map(([id, theme]) => {
        const active = value === id
        const { bg, accent, hi, text } = theme.preview
        const mutedText = `${text}88`
        return (
          <button
            key={id}
            className={`${styles.themeSwatch}${active ? ' ' + styles.themeSwatchActive : ''}`}
            style={{
              '--swatch-bg': bg,
              '--swatch-accent': accent,
              '--swatch-hi': hi,
              '--swatch-text': text,
              '--swatch-text-muted': mutedText,
              '--swatch-shell': bg,
              '--swatch-label-bg': `color-mix(in srgb, ${bg} 84%, #101010 16%)`,
              '--swatch-name-color': active ? accent : text,
            }}
            onClick={() => onChange(id)}
            title={theme.name}
          >
            <div className={styles.swatchPreview} style={{ background: bg }}>
              <div className={styles.swatchNav} style={{ borderColor: `${accent}30` }}>
                <div className={styles.swatchLogo} style={{ color: accent }}>AV</div>
                <div className={styles.swatchNavDots}>
                  <div className={styles.swatchDot} style={{ background: accent }} />
                  <div className={styles.swatchDot} style={{ background: `${hi}88` }} />
                  <div className={styles.swatchDot} style={{ background: `${accent}44` }} />
                </div>
              </div>
              <div
                className={styles.swatchDotGrid}
                style={{
                  backgroundImage: `radial-gradient(circle, ${accent}18 1px, transparent 1px)`,
                  backgroundSize: '8px 8px',
                }}
              />
              <div className={styles.swatchCards}>
                {[0, 1, 2, 3].map(i => (
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
              {active && <div className={styles.swatchActiveCheck} style={{ color: accent }}>✓</div>}
            </div>
            <div className={styles.swatchLabel}>
              <div className={styles.swatchName}>{theme.name}</div>
              <div className={styles.swatchLore}>{theme.lore}</div>
            </div>
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

function CacheStatus({ ttlH, onClear }) {
  const [info, setInfo] = useState(null)
  const [cleared, setCleared] = useState(false)

  const loadInfo = async () => {
    const stats = await getDbStats()
    if (!stats.sfUpdatedAt) {
      setInfo(null)
      return
    }
    setInfo({
      cardCount: stats.scryfall,
      ageMs: Date.now() - stats.sfUpdatedAt,
      ts: stats.sfUpdatedAt,
    })
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
          <div className={styles.cacheSummary}>
            <div className={styles.cacheSummaryMain}>
              <span className={styles.cacheSummaryCount}>{info.cardCount.toLocaleString()}</span>
              <span className={styles.cacheSummaryText}>card metadata entries stored locally</span>
            </div>
            <div className={styles.cacheSummarySub}>
              <span>Updated {formatAge(info.ageMs)}</span>
              <span className={isExpired ? styles.cacheExpired : styles.cacheOk}>
                {isExpired ? 'Expired' : `Refreshes in ${expiresIn}`}
              </span>
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
            <span>{isExpired ? 'Expired - missing metadata will refresh automatically' : `${ttlH}h local data TTL`}</span>
          </div>
        </>
      ) : (
        <div className={styles.cacheEmpty}>
          {cleared
            ? 'Cache cleared - card metadata will refresh automatically as you browse'
            : 'No local card metadata yet - it will be filled automatically as you browse'}
        </div>
      )}

      <div className={styles.cacheActions}>
        <Button
          variant={cleared ? 'green' : 'danger'}
          size="sm"
          onClick={handleClear}
          disabled={!info && !cleared}
        >
          {cleared ? 'Cleared' : 'Clear Local Metadata'}
        </Button>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const { user } = useAuth()
  const settings = useSettings()
  const [emailNew, setEmailNew] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [pwError, setPwError] = useState('')
  const [emailMsg, setEmailMsg] = useState('')
  const [emailError, setEmailError] = useState('')
  const [saving, setSaving] = useState(false)

  const lastSyncAge = settings.lastSyncedAt
    ? formatAge(Date.now() - new Date(settings.lastSyncedAt).getTime())
    : null
  const syncStatusLabel = settings.syncState === 'syncing' ? 'Syncing'
    : settings.syncState === 'saved' ? 'Synced'
    : settings.syncState === 'error' ? 'Sync Error'
    : settings.syncState === 'pending' ? 'Pending'
    : 'Idle'

  const set = async (key, value) => {
    setSaving(true)
    await settings.save({ [key]: value })
    setSaving(false)
  }

  const handleManualSync = async () => {
    setSaving(true)
    await settings.syncNow()
    setSaving(false)
  }

  const handleChangePassword = async () => {
    setPwMsg('')
    setPwError('')
    if (!user?.email) {
      setPwError('No signed-in email is available for password reset.')
      return
    }
    const { error } = await sb.auth.resetPasswordForEmail(user.email, {
      redirectTo: 'https://themazzy.github.io/arcanevault/',
    })
    if (error) setPwError(error.message)
    else setPwMsg('Password reset email sent. Check your inbox to continue.')
  }

  const handleChangeEmail = async () => {
    setEmailMsg('')
    setEmailError('')
    const nextEmail = emailNew.trim()
    if (!nextEmail) {
      setEmailError('Enter the new email address you want to use.')
      return
    }
    if (nextEmail.toLowerCase() === (user?.email || '').toLowerCase()) {
      setEmailError('That is already your current email address.')
      return
    }
    const { error } = await sb.auth.updateUser({ email: nextEmail })
    if (error) setEmailError(error.message)
    else {
      setEmailMsg('Email change requested. Check your inbox for the confirmation email.')
      setEmailNew('')
    }
  }

  return (
    <div className={styles.page}>
      <SectionHeader title="Settings" />

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Appearance</div>

        <div className={styles.themeRow}>
          <div className={styles.themeLabel}>
            <div className={styles.rowTitle}>Colour Theme</div>
            <div className={styles.rowDesc}>Choose the colour palette for the entire app. Saved to your account and synced across devices.</div>
          </div>
          <ThemePicker value={settings.theme || 'shadow'} onChange={v => set('theme', v)} />
        </div>

        {THEMES[settings.theme || 'shadow']?.mode !== 'light' && (
          <SettingRow
            label="OLED Black Mode"
            description="Sets backgrounds to pure black so OLED pixels are fully off, saving power and deepening contrast."
            onRowClick={() => set('oled_mode', !settings.oled_mode)}
          >
            <Toggle value={!!settings.oled_mode} onChange={v => set('oled_mode', v)} />
          </SettingRow>
        )}
        <SettingRow
          label="Higher Contrast"
          description="Strengthens text, borders, and separation without overriding OLED black backgrounds."
          onRowClick={() => set('higher_contrast', !settings.higher_contrast)}
        >
          <Toggle value={!!settings.higher_contrast} onChange={v => set('higher_contrast', v)} />
        </SettingRow>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Accessibility</div>
        <SettingRow label="Font Weight" description="How thick the body text appears - increase if text looks too thin on your screen">
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
        <SettingRow label="Text Preview">
          <div className={styles.fontPreview}>
            The quick brown fox jumps over the lazy dog. <em>Italics.</em>
          </div>
        </SettingRow>
        <SettingRow label="Card Name Size" description="Adjust card title size in grids, stacks, and list views.">
          <div className={styles.fontWeightOptions}>
            {[
              { value: 'compact', label: 'Compact' },
              { value: 'default', label: 'Default' },
              { value: 'large', label: 'Large' },
            ].map(({ value, label }) => (
              <button
                key={value}
                className={`${styles.fontOption} ${settings.card_name_size === value ? styles.fontOptionActive : ''}`}
                onClick={() => set('card_name_size', value)}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Card Name Preview">
          <div className={styles.cardNamePreviewCard}>
            <span
              className={styles.cardNamePreview}
              style={{
                fontSize:
                  settings.card_name_size === 'compact' ? '0.62rem'
                  : settings.card_name_size === 'large' ? '0.76rem'
                  : '0.68rem',
              }}
            >
              Atraxa, Praetors&apos; Voice
            </span>
            <span className={styles.cardNamePreviewMeta}>Foil showcase card title preview</span>
          </div>
        </SettingRow>
        <SettingRow
          label="Reduced Motion"
          description="Tones down hover lifts, transitions, and animation across the app."
          onRowClick={() => set('reduce_motion', !settings.reduce_motion)}
        >
          <Toggle value={!!settings.reduce_motion} onChange={v => set('reduce_motion', v)} />
        </SettingRow>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Prices</div>

        <SettingRow label="Price Source" description="Marketplace and price type used throughout the app">
          <UISelect
            className={styles.priceSourceSelect}
            value={settings.price_source}
            onChange={e => set('price_source', e.target.value)}
            title="Select price source"
          >
            {PRICE_SOURCES.map(src => (
              <option key={src.id} value={src.id}>{src.label}</option>
            ))}
          </UISelect>
          <div className={styles.priceSourceRadios}>
            {PRICE_SOURCES.map(src => (
              <label key={src.id} className={`${styles.priceSourceOption} ${settings.price_source === src.id ? styles.priceSourceOptionActive : ''}`}>
                <input
                  type="radio"
                  name="price_source"
                  value={src.id}
                  checked={settings.price_source === src.id}
                  onChange={() => set('price_source', src.id)}
                  className={styles.priceSourceRadio}
                />
                <div className={styles.priceSourceBody}>
                  <div className={styles.priceSourceLabel}>{src.label}</div>
                  <div className={styles.priceSourceDesc}>{src.description}</div>
                </div>
              </label>
            ))}
          </div>
        </SettingRow>

        <SettingRow
          label="Show Price on Cards"
          description="Display price label in the card grid"
          onRowClick={() => set('show_price', !settings.show_price)}
        >
          <Toggle value={settings.show_price} onChange={v => set('show_price', v)} />
        </SettingRow>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Display</div>
        <SettingRow label="Default Sort" description="How cards are sorted when opening the collection">
          <Select value={settings.default_sort} onChange={v => set('default_sort', v)}
            options={[
              ['name', 'Name'],
              ['price_desc', 'Price (high -> low)'],
              ['price_asc', 'Price (low -> high)'],
              ['qty', 'Quantity'],
              ['set', 'Set'],
              ['added', 'Recently Added'],
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
        <SettingRow label="Default Grouping" description="Initial grouping mode for deck-style card browsers.">
          <Select value={settings.default_grouping} onChange={v => set('default_grouping', v)}
            options={[
              ['type', 'By Type'],
              ['category', 'By Function'],
              ['none', 'Ungrouped'],
            ]} />
        </SettingRow>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Offline & Local Data</div>
        <SettingRow label="Local Metadata Duration" description="How long card metadata is kept locally before missing details are refreshed automatically">
          <Select value={String(settings.cache_ttl_h)} onChange={v => set('cache_ttl_h', parseInt(v))}
            options={[['12', '12 hours'], ['24', '24 hours (default)'], ['48', '48 hours'], ['168', '1 week']]} />
        </SettingRow>
        <div className={styles.cachePanelWrap}>
          <CacheStatus ttlH={settings.cache_ttl_h} />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Profile</div>
        <SettingRow label="Preferred Nickname" description="Used as your public in-app identity and auto-fills tournament and game lobby flows.">
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

      <div className={styles.section}>
        <div className={styles.sectionTitle}>App</div>
        <SettingRow label="Version" description="Installed app version for this build.">
          <span className={styles.appVersion}>v{APP_VERSION}</span>
        </SettingRow>
        <SettingRow
          label="Keep Screen Awake"
          description="Requests a wake lock so the screen does not dim or sleep while the app is open."
          onRowClick={() => set('keep_screen_awake', !settings.keep_screen_awake)}
        >
          <Toggle value={!!settings.keep_screen_awake} onChange={v => set('keep_screen_awake', v)} />
        </SettingRow>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Settings Sync</div>
        <SettingRow
          label="Sync Status"
          description={lastSyncAge ? `Last successful settings sync ${lastSyncAge}.` : 'No successful settings sync yet in this session.'}
        >
          <div className={styles.syncStatusWrap}>
            <span className={`${styles.syncStatus} ${styles[`syncStatus_${settings.syncState}`] || ''}`}>
              {syncStatusLabel}
            </span>
            <Button size="sm" onClick={handleManualSync} disabled={settings.syncState === 'syncing' || !user}>
              {settings.syncState === 'syncing' ? 'Syncing...' : 'Sync Settings Now'}
            </Button>
          </div>
        </SettingRow>
        <SettingRow
          label="Show Settings Sync Errors"
          description="Display the last settings sync failure message on this page."
          onRowClick={() => set('show_sync_errors', !settings.show_sync_errors)}
        >
          <Toggle value={!!settings.show_sync_errors} onChange={v => set('show_sync_errors', v)} />
        </SettingRow>
        {settings.show_sync_errors && settings.syncError && (
          <div className={styles.syncErrorBox}>{settings.syncError}</div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Account</div>
        <div className={styles.accountCard}>
          <div className={styles.accountEyebrow}>Signed in as</div>
          <div className={styles.accountEmail}>{maskEmailAddress(user?.email, true)}</div>
          <div className={styles.accountSub}>This email is currently bound to your Arcane Vault sign-in.</div>
        </div>
        <SettingRow
          label="Change Email"
          description="Send a confirmation email to switch your Arcane Vault login to a new address."
        >
          <div className={styles.pwForm}>
            <input
              className={styles.input}
              type="email"
              placeholder="Enter a new email"
              autoComplete="email"
              value={emailNew}
              onChange={e => setEmailNew(e.target.value)}
            />
            <Button size="sm" onClick={handleChangeEmail} disabled={!emailNew.trim()}>Send Change Email</Button>
          </div>
          {emailError && <div className={styles.pwError}>{emailError}</div>}
          {emailMsg && <div className={styles.pwMsg}>{emailMsg}</div>}
        </SettingRow>
        <SettingRow
          label="Change Password"
          description="Send a password reset email instead of changing your password directly in the app."
        >
          <div className={styles.pwForm}>
            <Button size="sm" onClick={handleChangePassword} disabled={!user?.email}>Send Reset Email</Button>
          </div>
          {pwError && <div className={styles.pwError}>{pwError}</div>}
          {pwMsg && <div className={styles.pwMsg}>{pwMsg}</div>}
        </SettingRow>
        <SettingRow label="Sign Out Everywhere" description="Ends this Arcane Vault session on all devices where you are currently signed in.">
          <Button variant="danger" size="sm" onClick={() => sb.auth.signOut({ scope: 'global' })}>
            Sign Out All
          </Button>
        </SettingRow>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Support</div>
        <div className={styles.supportCard}>
          <div className={styles.supportEyebrow}>Keep Arcane Vault growing</div>
          <div className={styles.supportTitle}>Support development</div>
          <div className={styles.supportText}>
            If the app is useful to you, this section can point people toward direct support options. Placeholder links are wired in for now and can be replaced later.
          </div>
          <div className={styles.supportGrid}>
            <button
              type="button"
              className={styles.supportBadge}
            >
              <span className={styles.supportBadgeIcon}>☕</span>
              <span className={styles.supportBadgeBody}>
                <span className={styles.supportBadgeLabel}>Buy Me a Coffee</span>
                <span className={styles.supportBadgeMeta}>Placeholder link</span>
              </span>
            </button>
            <button
              type="button"
              className={styles.supportBadge}
            >
              <span className={styles.supportBadgeIcon}>◎</span>
              <span className={styles.supportBadgeBody}>
                <span className={styles.supportBadgeLabel}>PayPal</span>
                <span className={styles.supportBadgeMeta}>Placeholder link</span>
              </span>
            </button>
            <button
              type="button"
              className={styles.supportBadge}
            >
              <span className={styles.supportBadgeIcon}>P</span>
              <span className={styles.supportBadgeBody}>
                <span className={styles.supportBadgeLabel}>Patreon</span>
                <span className={styles.supportBadgeMeta}>Placeholder link</span>
              </span>
            </button>
          </div>
        </div>
      </div>

      {saving && <div className={styles.savingIndicator}>Saving...</div>}
    </div>
  )
}
