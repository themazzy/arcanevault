import { useEffect, useState, useRef, useContext, createContext } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { isCurrentUserAdmin } from '../lib/admin'
import { maskEmailAddress, THEMES, PREMIUM_THEMES, THEME_TIERS, useSettings, getActiveArchiveTiles, subscribeArchiveTiles } from '../components/SettingsContext'
import { getLocalFolders } from '../lib/db'
import { useSetupWizard } from '../components/SetupWizard'
import { clearScryfallCache, PRICE_SOURCES, sfGet } from '../lib/scryfall'
import { deleteLocalFoldersAndPlacements, getDbStats } from '../lib/db'
import { pruneUnplacedCards } from '../lib/collectionOwnership'
import { downloadCollectionBackup, restoreCollectionBackup, validateBackupFile, summarizeBackup } from '../lib/backup'
import { Button, SectionHeader, Select as UISelect } from '../components/UI'
import { SearchIcon, CloseIcon, CheckIcon } from '../icons'
import BRAND_MARK from '../icons/DeckLoom_logo.png'
import styles from './Settings.module.css'
import { useNow } from '../hooks/useNow'

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

// ── Section search keyword blobs ─────────────────────────────────────────────
// One constant per section, referenced both by its <SettingsSection keywords>
// prop and by SECTION_DEFS below (used only to detect a fully-empty search).
const KW_GUIDED_HELP = 'setup wizard rerun tutorial onboarding theme price market nickname page tips reset explanatory modals'
const KW_ADMIN = 'admin console deletion request review queue allowlisted'
const KW_APPEARANCE = 'colour theme color palette premium themes obsidian crimson court verdant realm archive dark light oled black mode pixels power contrast higher borders separation'
const KW_ACCESSIBILITY = 'body font serif sans-serif font weight thin regular medium bold font size small large text preview card name size compact default large reduced motion hover lifts transitions animation'
const KW_PRICES = 'price source marketplace price type cardmarket tcgplayer show price cards grid label'
const KW_COLLECTION = 'default sort name price quantity set recently added grid density cozy comfortable compact cards per row'
const KW_DECKBUILDER = 'deck builder default sort mana value color type rarity set price default grouping category type ungrouped'
const KW_CACHE = 'local cache card metadata scryfall clear cached storage'
const KW_COLLECTION_MGMT = 'clear collection locations binders decks wishlists delete permanently backup restore download export json file collection data safekeeping migration'
const KW_PROFILE = 'nickname in-game name identity multiplayer lobbies tournaments public profile url view profile'
const KW_APP = 'version installed app build keep screen awake wake lock dim sleep'
const KW_SYNC = 'sync status settings synced pending idle error sync now manual show settings sync errors failure message'
const KW_ACCOUNT = 'account signed in email change password reset sign out everywhere devices session delete request deletion form'
const KW_LEGAL = 'legal hub privacy policy cookies local storage indexeddb cache credits fan content notice wizards disclaimer third-party'
const KW_SUPPORT = 'support development unlock premium themes obsidian night crimson court verdant realm arcane archive stripe payment one-time'

const SECTION_DEFS = [
  ['Guided Help', KW_GUIDED_HELP],
  ['Admin', KW_ADMIN],
  ['Appearance', KW_APPEARANCE],
  ['Accessibility', KW_ACCESSIBILITY],
  ['Prices', KW_PRICES],
  ['Collection', KW_COLLECTION],
  ['Deck Builder', KW_DECKBUILDER],
  ['Local Cache', KW_CACHE],
  ['Collection Management', KW_COLLECTION_MGMT],
  ['Profile', KW_PROFILE],
  ['App', KW_APP],
  ['Settings Sync', KW_SYNC],
  ['Account', KW_ACCOUNT],
  ['Legal & Privacy', KW_LEGAL],
  ['Support', KW_SUPPORT],
]

function formatAge(ms) {
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`
  return `${Math.round(ms / 86400000)}d ago`
}

// ── Settings search ─────────────────────────────────────────────────────────
// A single search box at the top of the page filters rows by label/description
// text. SectionSearchContext tells each row whether a query is active and
// whether its own section already matched on the section title/keywords (in
// which case every row in that section stays visible, since the user was
// clearly searching for the section itself, not one specific row).
const SectionSearchContext = createContext({ query: '', showAll: true })

export function matchesSearch(query, title, keywords = '') {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return title.toLowerCase().includes(q) || keywords.toLowerCase().includes(q)
}

function SettingsSection({ id, title, keywords = '', query = '', children }) {
  const q = query.trim().toLowerCase()
  if (q && !matchesSearch(q, title, keywords)) return null
  const showAll = !q || title.toLowerCase().includes(q)
  return (
    <SectionSearchContext.Provider value={{ query: q, showAll }}>
      <div className={styles.section} id={id}>
        <div className={styles.sectionTitle}>{title}</div>
        {children}
      </div>
    </SectionSearchContext.Provider>
  )
}

function SettingRow({ label, description, children, onRowClick }) {
  const { query, showAll } = useContext(SectionSearchContext)
  if (query && !showAll) {
    const haystack = `${label} ${description || ''}`.toLowerCase()
    if (!haystack.includes(query)) return null
  }
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
  const { user } = useAuth()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [activeTiles, setActiveTiles] = useState(() => getActiveArchiveTiles())
  const [folders, setFolders] = useState([])
  const cards = Array.isArray(settings.archive_background_cards) ? settings.archive_background_cards : []
  const lockedList = Array.isArray(settings.archive_background_locked) ? settings.archive_background_locked : []
  const lockedIds = new Set(lockedList.map(c => c.id))
  const source = settings.archive_background_collection_source || null

  useEffect(() => subscribeArchiveTiles(setActiveTiles), [])

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    getLocalFolders(user.id).then(rows => {
      if (cancelled) return
      setFolders(Array.isArray(rows) ? rows : [])
    }).catch(() => {})
    return () => { cancelled = true }
  }, [user?.id])

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
  const removeCard = (id) => set('archive_background_cards', cards.filter(card => card.id !== id))
  const rerollCards = () => set('archive_background_seed', Date.now())
  const toggleLock = (tile) => {
    if (!tile?.id) return
    if (lockedIds.has(tile.id)) {
      set('archive_background_locked', lockedList.filter(c => c.id !== tile.id))
    } else {
      set('archive_background_locked', [...lockedList, tile].slice(0, 6))
    }
  }
  const setSource = (next) => set('archive_background_collection_source', next)

  const folderGroups = [
    { type: 'binder', label: 'Binders' },
    { type: 'deck', label: 'Decks' },
    { type: 'list', label: 'Wishlists' },
  ]

  return (
    <div className={styles.archiveControls}>
      <div className={styles.archiveModeRow}>
        {[
          { value: 'random', label: 'Random' },
          { value: 'collection', label: 'My Collection' },
          { value: 'selected', label: 'Hand-Picked' },
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

      {settings.archive_background_mode === 'collection' && (
        <div className={styles.archiveCollectionRow}>
          <label className={styles.archiveSourceLabel}>Source</label>
          <UISelect
            className={styles.archiveSourceSelect}
            title="Background source"
            value={source?.folderId || 'all'}
            onChange={e => {
              const v = e.target.value
              if (v === 'all') setSource(null)
              else {
                const folder = folders.find(f => f.id === v)
                setSource({ type: folder?.type || 'binder', folderId: v })
              }
            }}
          >
            <option value="all">All owned cards</option>
            {folderGroups.map(g => {
              const list = folders.filter(f => f.type === g.type)
              if (!list.length) return null
              return (
                <optgroup key={g.type} label={g.label}>
                  {list.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </optgroup>
              )
            })}
          </UISelect>
        </div>
      )}

      {settings.archive_background_mode !== 'selected' && (
        <div className={styles.archiveRandomRow}>
          <button type="button" className={styles.archiveRerollBtn} onClick={rerollCards}>
            Reroll {lockedList.length > 0 ? `Unlocked (${6 - lockedList.length})` : 'Cards'}
          </button>
        </div>
      )}

      {(settings.archive_background_mode === 'random' || settings.archive_background_mode === 'collection') && activeTiles.length > 0 && (
        <div className={styles.archiveTileGrid}>
          {activeTiles.map((tile, i) => {
            const locked = lockedIds.has(tile.id)
            return (
              <button
                key={`${tile.id}-${i}`}
                type="button"
                className={`${styles.archiveTile}${locked ? ' ' + styles.archiveTileLocked : ''}`}
                onClick={() => toggleLock(tile)}
                title={`${tile.name} — click to ${locked ? 'unlock' : 'lock'}`}
              >
                <span className={styles.archiveTileArt} style={{ backgroundImage: `url("${tile.image}")` }} />
                <span className={styles.archiveTileLockBadge} aria-hidden="true">{locked ? '🔒' : '🔓'}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className={styles.archiveSliders}>
        <label className={styles.archiveSliderRow}>
          <span>Blur</span>
          <input
            type="range" min="0" max="20" step="0.5"
            value={settings.archive_background_blur ?? 7}
            onChange={e => set('archive_background_blur', Number(e.target.value))}
          />
          <span className={styles.archiveSliderValue}>{settings.archive_background_blur ?? 7}px</span>
        </label>
        <label className={styles.archiveSliderRow}>
          <span>Saturation</span>
          <input
            type="range" min="0" max="1.6" step="0.02"
            value={settings.archive_background_saturation ?? 0.86}
            onChange={e => set('archive_background_saturation', Number(e.target.value))}
          />
          <span className={styles.archiveSliderValue}>{Number(settings.archive_background_saturation ?? 0.86).toFixed(2)}</span>
        </label>
        <label className={styles.archiveSliderRow}>
          <span>Opacity</span>
          <input
            type="range" min="0.04" max="0.5" step="0.01"
            value={settings.archive_background_opacity ?? 0.16}
            onChange={e => set('archive_background_opacity', Number(e.target.value))}
          />
          <span className={styles.archiveSliderValue}>{Number(settings.archive_background_opacity ?? 0.16).toFixed(2)}</span>
        </label>
      </div>

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
  const grouped = THEME_TIERS.map(tier => ({
    ...tier,
    entries: Object.entries(THEMES).filter(([, theme]) => (theme.tier || 'free') === tier.id),
  })).filter(group => group.entries.length > 0)

  return (
    <div className={styles.themeGroups}>
      {grouped.map(group => (
        <div key={group.id} className={styles.themeGroup} data-tier={group.id}>
          <div className={styles.themeGroupHeader}>
            <div className={styles.themeGroupLabel}>
              {group.label}
              {group.id !== 'free' && <span className={styles.themeGroupBadge}>✦ Premium</span>}
            </div>
            <div className={styles.themeGroupDescription}>{group.description}</div>
          </div>
          <div className={styles.themeGrid}>
            {group.entries.map(([id, theme]) => {
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
                <div className={styles.swatchLogo} style={{ color: accent }}>
                  <img src={BRAND_MARK} alt="" className={styles.swatchLogoMark} />
                  <span>DL</span>
                </div>
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
              {active && <div className={styles.swatchActiveCheck} style={{ color: accent }}><CheckIcon size={12} /></div>}
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
        </div>
      ))}
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
              <span className={styles.cacheOk}>Cached locally</span>
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

function BackupRestore({ userId }) {
  const fileInputRef = useRef(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [downloadMsg, setDownloadMsg] = useState('')
  const [downloadError, setDownloadError] = useState('')

  const [pendingBackup, setPendingBackup] = useState(null)
  const [pendingFileName, setPendingFileName] = useState('')
  const [parseError, setParseError] = useState('')
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [restoreResult, setRestoreResult] = useState(null)
  const [restoreError, setRestoreError] = useState('')

  const handleDownload = async () => {
    setDownloadBusy(true)
    setDownloadMsg('')
    setDownloadError('')
    try {
      const counts = await downloadCollectionBackup(userId)
      setDownloadMsg(
        `Downloaded ${counts.folders.toLocaleString()} folders and ${counts.cards.toLocaleString()} owned cards.`
      )
    } catch (err) {
      setDownloadError(err?.message || 'Could not build backup.')
    } finally {
      setDownloadBusy(false)
    }
  }

  const handleFilePicked = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setParseError('')
    setRestoreResult(null)
    setRestoreError('')
    setPendingBackup(null)
    setPendingFileName(file.name)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const invalid = validateBackupFile(parsed)
      if (invalid) {
        setParseError(invalid)
        return
      }
      setPendingBackup(parsed)
    } catch {
      setParseError('Could not read that file as a DeckLoom backup (invalid JSON).')
    }
  }

  const handleConfirmRestore = async () => {
    if (!pendingBackup || !userId) return
    setRestoreBusy(true)
    setRestoreError('')
    try {
      const result = await restoreCollectionBackup(userId, pendingBackup)
      setRestoreResult(result)
      setPendingBackup(null)
      setPendingFileName('')
    } catch (err) {
      setRestoreError(err?.message || 'Restore failed partway through — some items above may already be in your account.')
    } finally {
      setRestoreBusy(false)
    }
  }

  const pendingSummary = pendingBackup ? summarizeBackup(pendingBackup) : null

  return (
    <div className={styles.backupPanel}>
      <div className={styles.backupIntro}>
        <div className={styles.backupTitle}>Download a backup</div>
        <div className={styles.backupText}>
          Saves every binder, deck, wishlist, and owned card to a single JSON file on your device — useful before
          clearing data above, switching accounts, or just for safekeeping.
        </div>
      </div>
      <div className={styles.backupButtons}>
        <Button size="sm" onClick={handleDownload} disabled={!userId || downloadBusy}>
          {downloadBusy ? 'Building backup...' : 'Download Backup (.json)'}
        </Button>
      </div>
      {downloadMsg && <div className={styles.backupSuccess}>{downloadMsg}</div>}
      {downloadError && <div className={styles.backupError}>{downloadError}</div>}

      <div className={styles.backupDivider} />

      <div className={styles.backupIntro}>
        <div className={styles.backupTitle}>Restore from a backup</div>
        <div className={styles.backupText}>
          Adds everything in the file to your account as new binders, decks, wishlists, and cards. This never
          deletes or overwrites anything currently in your collection — restoring the same file twice, or into an
          account that already has some of this data, will create duplicates.
        </div>
      </div>
      <div className={styles.backupButtons}>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFilePicked}
          style={{ display: 'none' }}
        />
        <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={!userId || restoreBusy}>
          Choose Backup File...
        </Button>
      </div>
      {parseError && <div className={styles.backupError}>{parseError}</div>}

      {pendingBackup && pendingSummary && (
        <div className={styles.backupConfirmPanel}>
          <div className={styles.backupConfirmText}>
            <strong>{pendingFileName}</strong> contains {pendingSummary.folders.toLocaleString()} folders,{' '}
            {pendingSummary.cards.toLocaleString()} owned cards, {pendingSummary.listItems.toLocaleString()} wishlist
            items, and {pendingSummary.deckCards.toLocaleString()} deck-builder cards. Restoring adds all of it to
            this account.
          </div>
          <div className={styles.backupWarning}>
            This action cannot be undone or reversed. Once restored, these items become part of your collection
            just like anything else you added yourself — removing them afterward means deleting them by hand.
          </div>
          <div className={styles.confirmControls}>
            <Button size="sm" onClick={handleConfirmRestore} disabled={restoreBusy}>
              {restoreBusy ? 'Restoring...' : 'Confirm Restore'}
            </Button>
            <Button size="sm" onClick={() => { setPendingBackup(null); setPendingFileName('') }} disabled={restoreBusy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {restoreResult && (
        <div className={styles.backupSuccess}>
          Restored {restoreResult.folders.toLocaleString()} folders, {restoreResult.cards.toLocaleString()} owned
          cards, {restoreResult.listItems.toLocaleString()} wishlist items, and {restoreResult.deckCards.toLocaleString()} deck-builder
          cards. Reload the app to see the restored data everywhere.
          <div className={styles.backupButtons} style={{ marginTop: 10 }}>
            <Button size="sm" onClick={() => window.location.reload()}>Reload App</Button>
          </div>
        </div>
      )}
      {restoreError && <div className={styles.backupError}>{restoreError}</div>}
    </div>
  )
}

export default function SettingsPage() {
  const now = useNow(60000)
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
  const [search, setSearch] = useState('')
  const noResults = !!search.trim() && !SECTION_DEFS.some(([title, kw]) => matchesSearch(search, title, kw))

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
    ? formatAge(now - new Date(settings.lastSyncedAt).getTime())
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

      <div className={styles.searchWrap}>
        <SearchIcon size={14} className={styles.searchIcon} />
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search settings..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button type="button" className={styles.searchClear} onClick={() => setSearch('')} aria-label="Clear search">
            <CloseIcon size={12} />
          </button>
        )}
      </div>
      {noResults && <div className={styles.noResults}>No settings match &quot;{search.trim()}&quot;.</div>}

      <SettingsSection title="Guided Help" keywords={KW_GUIDED_HELP} query={search}>
        <SettingRow label="Setup Wizard" description="Rerun the first-time setup to pick your theme, price market, and nickname.">
          <Button size="sm" onClick={openWizard}>Rerun Setup</Button>
        </SettingRow>
        <SettingRow label="Page Tips" description="Reset the one-time explanatory modals shown on each main page.">
          <div className={styles.inlineActionStack}>
            <Button size="sm" onClick={handleResetPageTips}>Reset Page Tips</Button>
            {tipsResetMsg && <span className={styles.inlineSuccess}>{tipsResetMsg}</span>}
          </div>
        </SettingRow>
      </SettingsSection>

      {isAdmin && (
        <SettingsSection title="Admin" keywords={KW_ADMIN} query={search}>
          <SettingRow
            label="Admin Console"
            description="Open the deletion-request review queue. Access is restricted to allowlisted admin users."
            onRowClick={() => navigate('/admin')}
          >
            <Button size="sm" onClick={() => navigate('/admin')}>Admin</Button>
          </SettingRow>
        </SettingsSection>
      )}

      <SettingsSection title="Appearance" keywords={KW_APPEARANCE} query={search}>
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
      </SettingsSection>

      <SettingsSection title="Accessibility" keywords={KW_ACCESSIBILITY} query={search}>
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
      </SettingsSection>

      <SettingsSection title="Prices" keywords={KW_PRICES} query={search}>
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
      </SettingsSection>

      <SettingsSection title="Collection" keywords={KW_COLLECTION} query={search}>
        <SettingRow label="Default Sort" description="Initial sort for the collection, binders, decks, and wishlists.">
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
      </SettingsSection>

      <SettingsSection title="Deck Builder" keywords={KW_DECKBUILDER} query={search}>
        <SettingRow label="Default Sort" description="Initial sort for cards inside the deck builder.">
          <Select value={settings.deckbuilder_sort || 'price_asc'} onChange={v => set('deckbuilder_sort', v)}
            options={[
              ['name', 'Name'],
              ['cmc_asc', 'Mana Value (low -> high)'],
              ['cmc_desc', 'Mana Value (high -> low)'],
              ['color', 'Color'],
              ['type', 'Type'],
              ['rarity_desc', 'Rarity (high -> low)'],
              ['rarity_asc', 'Rarity (low -> high)'],
              ['set', 'Set'],
              ['price_asc', 'Price (low -> high)'],
              ['price_desc', 'Price (high -> low)'],
            ]} />
        </SettingRow>
        <SettingRow label="Default Grouping" description="Initial grouping for the deck builder. Decks, binders, and wishlists always start ungrouped.">
          <Select value={['type', 'category', 'none'].includes(settings.default_grouping) ? settings.default_grouping : 'category'} onChange={v => set('default_grouping', v)}
            options={[
              ['category', 'Grouped by Category'],
              ['type', 'Grouped by Type'],
              ['none', 'Ungrouped'],
            ]} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Local Cache" keywords={KW_CACHE} query={search}>
        <div className={styles.cachePanelWrap}>
          <CacheStatus />
        </div>
      </SettingsSection>

      <SettingsSection title="Collection Management" keywords={KW_COLLECTION_MGMT} query={search}>
        <BackupRestore userId={user?.id} />
        <ClearCollectionData userId={user?.id} />
      </SettingsSection>

      <SettingsSection title="Profile" keywords={KW_PROFILE} query={search}>
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
      </SettingsSection>

      <SettingsSection title="App" keywords={KW_APP} query={search}>
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
      </SettingsSection>

      <SettingsSection title="Settings Sync" keywords={KW_SYNC} query={search}>
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
      </SettingsSection>

      <SettingsSection title="Account" keywords={KW_ACCOUNT} query={search}>
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
      </SettingsSection>

      <SettingsSection title="Legal & Privacy" keywords={KW_LEGAL} query={search}>
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
      </SettingsSection>

      <SettingsSection id="support" title="Support" keywords={KW_SUPPORT} query={search}>
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
              <div className={styles.stripeNote}>
                Digital content, delivered to your account immediately after payment. By purchasing
                you request immediate delivery and acknowledge losing the 14-day EU right of
                withdrawal once delivered. If the unlock doesn&apos;t work, we&apos;ll fix it or refund it —{' '}
                <Link to="/terms">Terms of Service</Link>.
              </div>
              {checkoutError && <div className={styles.stripeError}>{checkoutError}</div>}
            </div>
          )}

          <div className={styles.premiumThemeRow}>
            {[
              { id: 'archive_dark', accent: '#d8b65f', bg: '#050509', name: 'Arcane Archive' },
              { id: 'rakdos', accent: '#e02020', bg: '#06030a', name: 'Rakdos' },
              { id: 'azorius', accent: '#1f5fb8', bg: '#f3f7fc', name: 'Azorius' },
              { id: 'simic', accent: '#28b8b8', bg: '#04111a', name: 'Simic' },
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
      </SettingsSection>

      {isSyncing && <div className={styles.savingIndicator}>Saving...</div>}
    </div>
  )
}
