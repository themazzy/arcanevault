import { useEffect, useState, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { isCurrentUserAdmin } from '../lib/admin'
import { maskEmailAddress, THEMES, PREMIUM_THEMES, useSettings } from '../components/SettingsContext'
import { useSetupWizard } from '../components/SetupWizard'
import { clearScryfallCache, PRICE_SOURCES, sfGet } from '../lib/scryfall'
import { deleteLocalFoldersAndPlacements, getDbStats, setMeta } from '../lib/db'
import { pruneUnplacedCards } from '../lib/collectionOwnership'
import { Button, SectionHeader, Select as UISelect } from '../components/UI'
import styles from './Settings.module.css'

const APP_VERSION = __APP_VERSION__
const CLEAR_BATCH_SIZE = 100

const CLEAR_TARGETS = [
  {
    key: 'binder',
    label: 'Binders',
    folderType: 'binder',
    placementTable: 'folder_cards',
    placementKey: 'folder_id',
    placementSelect: 'id,card_id',
    placementLabel: 'binder card placements',
  },
  {
    key: 'deck',
    label: 'Decks',
    folderType: 'deck',
    placementTable: 'deck_allocations',
    placementKey: 'deck_id',
    placementSelect: 'id,card_id',
    placementLabel: 'deck allocations',
  },
  {
    key: 'list',
    label: 'Wishlists',
    folderType: 'list',
    placementTable: 'list_items',
    placementKey: 'folder_id',
    placementSelect: 'id',
    placementLabel: 'wishlist items',
  },
]

function chunk(items, size = CLEAR_BATCH_SIZE) {
  const chunks = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

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

function getArchiveCardImage(card) {
  return card?.image_uris?.art_crop
    || card?.card_faces?.find(face => face?.image_uris)?.image_uris?.art_crop
    || card?.image_uris?.large
    || card?.image_uris?.normal
    || card?.image
    || ''
}

function toArchiveCard(card) {
  const image = getArchiveCardImage(card)
  if (!card?.id || !image) return null
  return {
    id: card.id,
    name: card.name,
    image,
  }
}

function ArchiveThemeControls({ settings, set }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const cards = Array.isArray(settings.archive_background_cards) ? settings.archive_background_cards : []

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      setError('')
      return
    }
    let cancelled = false
    setSearching(true)
    setError('')
    const timer = setTimeout(async () => {
      const data = await sfGet(`/cards/search?q=${encodeURIComponent(`${q} game:paper`)}&order=name&unique=art`)
      if (cancelled) return
      if (!data?.data) {
        setResults([])
        setError('No Scryfall results.')
      } else {
        setResults(data.data.map(toArchiveCard).filter(Boolean).slice(0, 10))
      }
      setSearching(false)
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const addCard = (card) => {
    if (!card || cards.some(item => item.id === card.id)) return
    set('archive_background_cards', [...cards, card].slice(0, 12))
    setQuery('')
    setResults([])
  }

  const removeCard = (id) => {
    set('archive_background_cards', cards.filter(card => card.id !== id))
  }

  const rerollCards = () => {
    set('archive_background_seed', Date.now())
  }

  return (
    <div className={styles.archiveControls}>
      <div className={styles.archiveModeRow}>
        {[
          { value: 'random', label: 'Random Cards' },
          { value: 'selected', label: 'Selected Cards' },
        ].map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={`${styles.archiveModeBtn}${settings.archive_background_mode === value ? ' ' + styles.archiveModeBtnActive : ''}`}
            onClick={() => set('archive_background_mode', value)}
          >
            {label}
          </button>
        ))}
      </div>

      {settings.archive_background_mode === 'random' && (
        <div className={styles.archiveRandomRow}>
          <button type="button" className={styles.archiveRerollBtn} onClick={rerollCards}>
            Reroll Cards
          </button>
        </div>
      )}

      {settings.archive_background_mode === 'selected' && (
        <div className={styles.archivePicker}>
          <div className={styles.archiveSearchWrap}>
            <input
              className={styles.input}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search Scryfall for background cards"
            />
            {searching && <div className={styles.archiveSearchState}>Searching...</div>}
            {!searching && error && <div className={styles.archiveSearchState}>{error}</div>}
            {!!results.length && (
              <div className={styles.archiveResults}>
                {results.map(card => (
                  <button
                    key={card.id}
                    type="button"
                    className={styles.archiveResult}
                    onClick={() => addCard(card)}
                    disabled={cards.some(item => item.id === card.id)}
                  >
                    <span className={styles.archiveResultThumb} style={{ backgroundImage: `url("${card.image}")` }} />
                    <span>{card.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={styles.archiveSelectedGrid}>
            {cards.map(card => (
              <div key={card.id} className={styles.archiveSelectedCard}>
                <div className={styles.archiveSelectedArt} style={{ backgroundImage: `url("${card.image}")` }} />
                <button type="button" className={styles.archiveRemoveBtn} onClick={() => removeCard(card.id)}>Remove</button>
              </div>
            ))}
            {cards.length === 0 && (
              <div className={styles.archiveEmpty}>Select at least one card, or switch back to random cards.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

async function getFunctionErrorMessage(error, fallback) {
  try {
    const response = error?.context
    if (response && typeof response.json === 'function') {
      const body = await response.clone().json()
      return body?.details || body?.error || error?.message || fallback
    }
  } catch {}
  return error?.message || fallback
}

function ThemePicker({ value, onChange, premium }) {
  return (
    <div className={styles.themeGrid}>
      {Object.entries(THEMES).map(([id, theme]) => {
        const active = value === id
        const isPremiumTheme = PREMIUM_THEMES.has(id)
        const isLocked = isPremiumTheme && !premium
        const { bg, accent, hi, text } = theme.preview
        const mutedText = `${text}88`
        return (
          <button
            key={id}
            className={`${styles.themeSwatch}${active ? ' ' + styles.themeSwatchActive : ''}${isLocked ? ' ' + styles.themeSwatchLocked : ''}`}
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
            onClick={() => !isLocked && onChange(id)}
            title={isLocked ? `${theme.name} — Unlock Premium to use` : theme.name}
          >
            <div className={styles.swatchPreview} style={{ background: bg }}>
              <div className={styles.swatchNav} style={{ borderColor: `${accent}30` }}>
                <div className={styles.swatchLogo} style={{ color: accent }}>UH</div>
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
              {isLocked && (
                <div className={styles.swatchLockOverlay}>
                  <span className={styles.swatchLockIcon}>🔒</span>
                </div>
              )}
            </div>
            <div className={styles.swatchLabel}>
              <div className={styles.swatchName}>
                {theme.name}
                {isPremiumTheme && (
                  <span className={`${styles.premiumStar}${isLocked ? ' ' + styles.premiumStarLocked : ''}`}>✦</span>
                )}
              </div>
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

function CacheStatus({ onClear }) {
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
              <span className={styles.cacheOk}>Available offline</span>
            </div>
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

async function fetchFoldersForClear(userId, folderType) {
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('folders')
      .select('id,name,type,user_id')
      .eq('user_id', userId)
      .eq('type', folderType)
      .order('id')
      .range(from, from + 999)

    if (error) throw error
    if (data?.length) rows.push(...data)
    if (!data || data.length < 1000) break
    from += 1000
  }
  return rows
}

async function fetchPlacementRows(target, folderIds) {
  const rows = []
  for (const ids of chunk(folderIds)) {
    let from = 0
    while (true) {
      const { data, error } = await sb.from(target.placementTable)
        .select(target.placementSelect)
        .in(target.placementKey, ids)
        .order('id')
        .range(from, from + 999)

      if (error) throw error
      if (data?.length) rows.push(...data)
      if (!data || data.length < 1000) break
      from += 1000
    }
  }
  return rows
}

async function clearFolderType(userId, target) {
  const folders = await fetchFoldersForClear(userId, target.folderType)
  const folderIds = folders.map(folder => folder.id)
  if (!folderIds.length) {
    return { folderCount: 0, placementCount: 0, orphanCount: 0 }
  }

  const placementRows = await fetchPlacementRows(target, folderIds)
  const affectedCardIds = placementRows.map(row => row.card_id).filter(Boolean)

  for (const ids of chunk(folderIds)) {
    const { error } = await sb.from(target.placementTable).delete().in(target.placementKey, ids)
    if (error) throw error
  }

  for (const ids of chunk(folderIds)) {
    const { error } = await sb.from('folders')
      .delete()
      .eq('user_id', userId)
      .in('id', ids)
    if (error) throw error
  }

  const orphanIds = affectedCardIds.length ? await pruneUnplacedCards(affectedCardIds) : []
  await deleteLocalFoldersAndPlacements(folderIds)
  await setMeta(`folder_cards_full_sync_${userId}`, 0)
  await setMeta(`folder_cards_delta_sync_${userId}`, null)

  return {
    folderCount: folderIds.length,
    placementCount: placementRows.length,
    orphanCount: orphanIds.length,
  }
}

function ClearCollectionData({ userId }) {
  const [targetKey, setTargetKey] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [busyKey, setBusyKey] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const target = CLEAR_TARGETS.find(item => item.key === targetKey) || null
  const isBusy = !!busyKey
  const canClear = target && confirmText === 'Confirm' && !isBusy && userId

  const startConfirm = (key) => {
    setTargetKey(key)
    setConfirmText('')
    setMessage('')
    setError('')
  }

  const handleClear = async () => {
    if (!canClear) return
    setBusyKey(target.key)
    setMessage('')
    setError('')
    try {
      const result = await clearFolderType(userId, target)
      const orphanText = target.key === 'list'
        ? ''
        : `, and deleted ${result.orphanCount.toLocaleString()} unplaced owned card${result.orphanCount === 1 ? '' : 's'}`
      setMessage(
        result.folderCount
          ? `Cleared ${result.folderCount.toLocaleString()} ${target.label.toLowerCase()}, ${result.placementCount.toLocaleString()} ${target.placementLabel}${orphanText}.`
          : `No ${target.label.toLowerCase()} found.`
      )
      setTargetKey('')
      setConfirmText('')
    } catch (err) {
      setError(err.message || `Could not clear ${target.label.toLowerCase()}.`)
    } finally {
      setBusyKey('')
    }
  }

  return (
    <div className={styles.dangerPanel}>
      <div className={styles.dangerIntro}>
        <div className={styles.dangerTitle}>Clear collection locations</div>
        <div className={styles.dangerText}>
          This permanently deletes the selected binders, decks, or wishlists and everything stored in those locations.
          Cards that are only in deleted binders or decks are removed from your collection.
        </div>
      </div>

      <div className={styles.clearButtons}>
        {CLEAR_TARGETS.map(item => (
          <Button
            key={item.key}
            variant="danger"
            size="sm"
            onClick={() => startConfirm(item.key)}
            disabled={!userId || isBusy}
          >
            {busyKey === item.key ? `Clearing ${item.label}...` : `Clear ${item.label}`}
          </Button>
        ))}
      </div>

      {target && (
        <div className={styles.confirmPanel}>
          <div className={styles.confirmWarning}>
            Type <strong>Confirm</strong> to permanently clear all {target.label.toLowerCase()}.
          </div>
          <div className={styles.confirmControls}>
            <input
              className={styles.input}
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder="Confirm"
              autoComplete="off"
              disabled={isBusy}
            />
            <Button variant="danger" size="sm" onClick={handleClear} disabled={!canClear}>
              {isBusy ? 'Working...' : `Delete ${target.label}`}
            </Button>
            <Button size="sm" onClick={() => startConfirm('')} disabled={isBusy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {message && <div className={styles.dangerSuccess}>{message}</div>}
      {error && <div className={styles.dangerError}>{error}</div>}
    </div>
  )
}

export default function SettingsPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const settings = useSettings()
  const { open: openWizard } = useSetupWizard()
  const [emailNew, setEmailNew] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [pwError, setPwError] = useState('')
  const [emailMsg, setEmailMsg] = useState('')
  const [emailError, setEmailError] = useState('')
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [checkoutError, setCheckoutError] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [tipsResetMsg, setTipsResetMsg] = useState('')

  // Nickname availability check
  const [nicknameStatus, setNicknameStatus] = useState('')
  const [nicknameError, setNicknameError]   = useState('')
  const nicknameTimer = useRef(null)
  const NICKNAME_RE = /^[a-zA-Z0-9_-]*$/

  useEffect(() => {
    isCurrentUserAdmin(user?.id).then(setIsAdmin)
  }, [user?.id])

  useEffect(() => {
    if (!location.hash) return
    const id = location.hash.slice(1)
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [location.hash])

  const handleNicknameChange = (val) => {
    setNicknameError('')
    if (val && !NICKNAME_RE.test(val)) {
      setNicknameError('Only letters, numbers, hyphens, and underscores are allowed.')
      return
    }
    set('nickname', val)
    clearTimeout(nicknameTimer.current)
    if (!val.trim()) { setNicknameStatus(''); return }
    // Already their own saved nickname — no need to check
    if (val.trim().toLowerCase() === (settings.nickname || '').toLowerCase()) {
      setNicknameStatus(''); return
    }
    setNicknameStatus('checking')
    nicknameTimer.current = setTimeout(async () => {
      const { data } = await sb.rpc('is_username_available', { p_username: val.trim() })
      setNicknameStatus(data ? 'available' : 'taken')
    }, 600)
  }

  const lastSyncAge = settings.lastSyncedAt
    ? formatAge(Date.now() - new Date(settings.lastSyncedAt).getTime())
    : null
  const syncStatusLabel = settings.syncState === 'syncing' ? 'Syncing'
    : settings.syncState === 'saved' ? 'Synced'
    : settings.syncState === 'error' ? 'Sync Error'
    : settings.syncState === 'pending' ? 'Pending'
    : 'Idle'

  const set = (key, value) => settings.save({ [key]: value })

  const handleManualSync = () => settings.syncNow()

  const isSyncing = settings.syncState === 'pending' || settings.syncState === 'syncing'

  const handleResetPageTips = async () => {
    setTipsResetMsg('')
    await set('page_tips_seen', {})
    setTipsResetMsg('Page tips will show again as you visit pages.')
    window.setTimeout(() => setTipsResetMsg(''), 3000)
  }

  const handleUnlockPremium = async () => {
    setCheckoutError('')
    if (!user) {
      setCheckoutError('Sign in before unlocking premium themes.')
      return
    }
    setCheckoutBusy(true)
    try {
      const { data, error } = await sb.functions.invoke('stripe-create-checkout', {
        body: {
          successUrl: `${window.location.origin}${import.meta.env.BASE_URL}settings?premium_checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${window.location.origin}${import.meta.env.BASE_URL}settings?premium_checkout=cancelled`,
        },
      })
      if (error) throw new Error(await getFunctionErrorMessage(error, 'Could not start Stripe Checkout.'))
      if (!data?.url) throw new Error('Stripe did not return a checkout URL.')
      window.location.assign(data.url)
    } catch (err) {
      setCheckoutError(err?.message || 'Could not start Stripe Checkout.')
      setCheckoutBusy(false)
    }
  }

  const handleChangePassword = async () => {
    setPwMsg('')
    setPwError('')
    if (!user?.email) {
      setPwError('No signed-in email is available for password reset.')
      return
    }
    const { error } = await sb.auth.resetPasswordForEmail(user.email, {
      redirectTo: 'https://deckloom.app/',
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      setEmailError('Enter a valid email address.')
      return
    }
    if (nextEmail.toLowerCase() === (user?.email || '').toLowerCase()) {
      setEmailError('That is already your current email address.')
      return
    }
    const { error } = await sb.auth.updateUser(
      { email: nextEmail },
      { emailRedirectTo: 'https://deckloom.app/' }
    )
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
        <div className={styles.sectionTitle}>Guided Help</div>
        <SettingRow label="Setup Wizard" description="Rerun the first-time setup to pick your theme, price market, and nickname.">
          <Button size="sm" onClick={openWizard}>Rerun Setup</Button>
        </SettingRow>
        <SettingRow label="Page Tips" description="Reset the one-time explanatory modals shown on each main page.">
          <div className={styles.inlineActionStack}>
            <Button size="sm" onClick={handleResetPageTips}>Reset Page Tips</Button>
            {tipsResetMsg && <span className={styles.inlineSuccess}>{tipsResetMsg}</span>}
          </div>
        </SettingRow>
      </div>

      {isAdmin && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Admin</div>
          <SettingRow
            label="Admin Console"
            description="Open the deletion-request review queue. Access is restricted to allowlisted admin users."
            onRowClick={() => navigate('/admin')}
          >
            <Button size="sm" onClick={() => navigate('/admin')}>Admin</Button>
          </SettingRow>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Appearance</div>

        <div className={styles.themeRow}>
          <div className={styles.themeLabel}>
            <div className={styles.rowTitle}>Colour Theme</div>
            <div className={styles.rowDesc}>Choose the colour palette for the entire app. Saved to your account and synced across devices.</div>
            {!settings.premium && (
              <div className={styles.themeSupportPrompt}>
                Premium themes are locked.
                <button type="button" onClick={handleUnlockPremium} disabled={checkoutBusy}>
                  {checkoutBusy ? 'Opening Stripe...' : 'Support to unlock'}
                </button>
              </div>
            )}
          </div>
          <ThemePicker value={settings.theme || 'shadow'} onChange={v => set('theme', v)} premium={settings.premium} />
        </div>

        {['archive_dark', 'archive_light'].includes(settings.theme || '') && (
          <SettingRow
            label="Archive Background"
            description="Use random Scryfall art or choose specific cards for the Arcane Archive background."
          >
            <ArchiveThemeControls settings={settings} set={set} />
          </SettingRow>
        )}

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
        <SettingRow label="Body Font" description="Serif feels more arcane; Sans-serif is cleaner and easier to read for long sessions.">
          <div className={styles.fontWeightOptions}>
            {[
              { value: 'serif', label: 'Serif' },
              { value: 'sans', label: 'Sans-serif' },
            ].map(({ value, label }) => (
              <button
                key={value}
                className={`${styles.fontOption} ${(settings.body_font ?? 'serif') === value ? styles.fontOptionActive : ''}`}
                style={{ fontFamily: value === 'sans' ? 'Inter, system-ui, sans-serif' : 'Crimson Pro, Georgia, serif' }}
                onClick={() => set('body_font', value)}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div
              className={styles.fontPreview}
              style={{ fontFamily: (settings.body_font ?? 'serif') === 'sans' ? 'Inter, system-ui, sans-serif' : 'Crimson Pro, Georgia, serif' }}
            >
              The quick brown fox jumps over the lazy dog. <em>Italics.</em>
            </div>
            <div
              className={styles.fontPreview}
              style={{
                fontFamily: (settings.body_font ?? 'serif') === 'sans' ? 'Inter, system-ui, sans-serif' : 'Cinzel, Georgia, serif',
                letterSpacing: (settings.body_font ?? 'serif') === 'sans' ? '0.02em' : '0.08em',
                fontSize: '0.8em',
                opacity: 0.7,
              }}
            >
              Section Header · Card Type · Label
            </div>
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
        <SettingRow label="Deckbuilder Grouping" description="Initial grouping mode for deckbuilder only. Decks, binders, and wishlists always start ungrouped.">
          <Select value={settings.default_grouping === 'none' ? 'none' : 'type'} onChange={v => set('default_grouping', v)}
            options={[
              ['type', 'Grouped by Type'],
              ['none', 'Ungrouped'],
            ]} />
        </SettingRow>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Local Cache</div>
        <div className={styles.cachePanelWrap}>
          <CacheStatus />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Collection Management</div>
        <ClearCollectionData userId={user?.id} />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Profile</div>
        <SettingRow label="Nickname" description="Your identity across the app — multiplayer lobbies, tournaments, and your public profile URL.">
          <div className={styles.usernameRow}>
            <input
              className={styles.input}
              type="text"
              placeholder="Your in-game name"
              value={settings.nickname ?? ''}
              onChange={e => handleNicknameChange(e.target.value)}
              maxLength={24}
            />
            {nicknameError                   && <span className={styles.usernameTaken}>{nicknameError}</span>}
            {!nicknameError && nicknameStatus === 'checking'  && <span className={styles.usernameHint}>Checking…</span>}
            {!nicknameError && nicknameStatus === 'available' && <span className={styles.usernameOk}>✓ Available</span>}
            {!nicknameError && nicknameStatus === 'taken'     && <span className={styles.usernameTaken}>Taken</span>}
          </div>
        </SettingRow>
        {settings.nickname && (
          <SettingRow label="Your Profile" description="View and customise your public profile page.">
            <Button size="sm" onClick={() => navigate(`/profile/${encodeURIComponent(settings.nickname)}`)}>
              View Profile
            </Button>
          </SettingRow>
        )}
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
          <div className={styles.accountSub}>This email is currently bound to your DeckLoom sign-in.</div>
        </div>
        <SettingRow
          label="Change Email"
          description="Send a confirmation email to switch your DeckLoom login to a new address."
        >
          <div className={styles.pwForm}>
            <input
              className={styles.input}
              type="email"
              placeholder="Enter a new email"
              autoComplete="email"
              value={emailNew}
              onChange={e => setEmailNew(e.target.value)}
              maxLength={254}
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
        <SettingRow label="Sign Out Everywhere" description="Ends this DeckLoom session on all devices where you are currently signed in.">
          <Button variant="danger" size="sm" onClick={() => sb.auth.signOut({ scope: 'global' })}>
            Sign Out All
          </Button>
        </SettingRow>
        <SettingRow
          label="Request Account Deletion"
          description="Opens the tracked deletion-request form for this account."
          onRowClick={() => navigate('/delete-account')}
        >
          <Button variant="danger" size="sm" onClick={() => navigate('/delete-account')}>
            Delete Request Form
          </Button>
        </SettingRow>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Legal & Privacy</div>
        <SettingRow
          label="Legal Hub"
          description="Open the overview page for privacy, browser storage, credits, and deletion."
          onRowClick={() => navigate('/legal')}
        >
          <Button size="sm" onClick={() => navigate('/legal')}>Open Legal Hub</Button>
        </SettingRow>
        <SettingRow
          label="Privacy Policy"
          description="Read what account, collection, feedback, and public sharing data are used for."
          onRowClick={() => navigate('/privacy')}
        >
          <Button size="sm" onClick={() => navigate('/privacy')}>Privacy Policy</Button>
        </SettingRow>
        <SettingRow
          label="Cookies & Local Storage"
          description="Review session persistence, local storage, IndexedDB, and cache behavior."
          onRowClick={() => navigate('/storage')}
        >
          <Button size="sm" onClick={() => navigate('/storage')}>Storage Notice</Button>
        </SettingRow>
        <SettingRow
          label="Credits & Fan Content Notice"
          description="Third-party services, source credits, and the unofficial Wizards disclaimer."
          onRowClick={() => navigate('/credits')}
        >
          <Button size="sm" onClick={() => navigate('/credits')}>Credits</Button>
        </SettingRow>
      </div>

      <div className={styles.section} id="support">
        <div className={styles.sectionTitle}>Support</div>
        <div className={styles.supportCard}>
          <div className={styles.supportEyebrow}>Keep DeckLoom growing</div>
          <div className={styles.supportTitle}>Unlock Premium Themes</div>
          <div className={styles.supportText}>
            Support development and unlock premium themes, including Obsidian Night, Crimson Court, Verdant Realm, and Arcane Archive. Each features atmospheric backgrounds, unique scrollbar and selection colours, and a distinct visual identity. One-time payment, yours forever.
          </div>

          {settings.premium ? (
            <div className={styles.premiumUnlocked}>
              <span className={styles.premiumUnlockedStar}>✦</span>
              <div>
                <div className={styles.premiumUnlockedTitle}>Premium Unlocked</div>
                <div className={styles.premiumUnlockedSub}>Obsidian Night · Crimson Court · Verdant Realm · Arcane Archive are available in the theme picker above.</div>
              </div>
            </div>
          ) : (
            <div className={styles.stripeWrap}>
              <button
                type="button"
                className={styles.stripeBtn}
                onClick={handleUnlockPremium}
                disabled={checkoutBusy}
              >
                <span className={styles.stripeBtnStar}>✦</span>
                {checkoutBusy ? 'Opening Stripe...' : 'Unlock Premium Themes — €3 or your choice'}
              </button>
              <div className={styles.stripeNote}>One-time · Secured by Stripe · No subscription</div>
              {checkoutError && <div className={styles.stripeError}>{checkoutError}</div>}
            </div>
          )}

          <div className={styles.premiumThemeRow}>
            {[
              { id: 'obsidian', accent: '#b08fff', bg: '#000000', name: 'Obsidian Night' },
              { id: 'crimson_court', accent: '#cc2244', bg: '#0d0103', name: 'Crimson Court' },
              { id: 'verdant_realm', accent: '#3dba74', bg: '#020d05', name: 'Verdant Realm' },
              { id: 'archive_dark', accent: '#d8b65f', bg: '#050509', name: 'Arcane Archive' },
            ].map(({ id, accent, bg, name }) => (
              <div
                key={id}
                className={`${styles.premiumThemePill}${settings.premium ? '' : ' ' + styles.premiumThemePillLocked}`}
                style={{ '--pill-accent': accent, '--pill-bg': bg }}
              >
                <span className={styles.premiumThemePillDot} style={{ background: accent }} />
                <span className={styles.premiumThemePillName}>{name}</span>
                {!settings.premium && <span className={styles.premiumThemePillLock}>🔒</span>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {isSyncing && <div className={styles.savingIndicator}>Saving...</div>}
    </div>
  )
}
