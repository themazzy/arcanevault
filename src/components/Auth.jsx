import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { getPublicBaseUrl, getProdAppUrl } from '../lib/publicUrl'
import { isNativeApp, openNativeOAuth } from '../lib/nativeAuth'
import { applyTheme } from './SettingsContext'
import { fetchCardsByNames } from '../lib/deckBuilderApi'
import BRAND_MARK from '../icons/DeckLoom_logo.png'
import styles from './Auth.module.css'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)
const RECOVERY_PENDING_KEY = 'deckloom_password_recovery_pending'

function hasRecoveryRedirectHash() {
  if (typeof window === 'undefined') return false
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
  return new URLSearchParams(hash).get('type') === 'recovery'
}

function hasStoredPendingRecovery() {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(RECOVERY_PENDING_KEY) === '1'
}

function hasPendingRecovery(session = null) {
  return hasRecoveryRedirectHash() || (Boolean(session) && hasStoredPendingRecovery())
}

function markPendingRecovery() {
  if (typeof window !== 'undefined') window.localStorage.setItem(RECOVERY_PENDING_KEY, '1')
}

function clearPendingRecovery() {
  if (typeof window !== 'undefined') window.localStorage.removeItem(RECOVERY_PENDING_KEY)
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined)
  const [authEvent, setAuthEvent] = useState(() => (
    hasRecoveryRedirectHash() ? 'PASSWORD_RECOVERY' : null
  ))

  useEffect(() => {
    const isRecoveryRedirect = hasRecoveryRedirectHash()
    if (isRecoveryRedirect) markPendingRecovery()
    sb.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (hasPendingRecovery(session)) setAuthEvent('PASSWORD_RECOVERY')
    })
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'PASSWORD_RECOVERY') markPendingRecovery()
      setAuthEvent(event === 'PASSWORD_RECOVERY' || hasPendingRecovery(s) ? 'PASSWORD_RECOVERY' : event)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) return (
    <div className={styles.loading}>Loading…</div>
  )

  return (
    <AuthContext.Provider value={{
      session,
      user: session?.user || null,
      authEvent,
      clearAuthEvent: () => {
        clearPendingRecovery()
        setAuthEvent(null)
      },
    }}>
      {children}
    </AuthContext.Provider>
  )
}

// Defer non-critical fetches until the browser is idle so they don't fight
// the LCP paint. Falls back to setTimeout in browsers without rIC.
function runWhenIdle(cb) {
  if (typeof window === 'undefined') return () => {}
  const ric = window.requestIdleCallback
  if (ric) {
    const handle = ric(cb, { timeout: 1500 })
    return () => window.cancelIdleCallback?.(handle)
  }
  const t = setTimeout(cb, 200)
  return () => clearTimeout(t)
}

// Single batched Scryfall fetch for every name needed by the login page.
// Returns a Map<name, scryfallCard> once resolved (empty before then).
function useCardLookup(allNames) {
  const [byName, setByName] = useState(() => new Map())
  useEffect(() => {
    let cancelled = false
    const unique = Array.from(new Set(allNames))
    const cancelIdle = runWhenIdle(() => {
      if (cancelled) return
      fetchCardsByNames(unique)
        .then(results => {
          if (cancelled) return
          setByName(new Map(results.map(c => [c.name, c])))
        })
        .catch(() => {})
    })
    return () => { cancelled = true; cancelIdle() }
  }, [allNames]) // eslint-disable-line react-hooks/exhaustive-deps
  return byName
}

function pickArts(byName, names) {
  return names
    .map(n => {
      const d = byName.get(n)
      return d?.image_uris?.art_crop || d?.card_faces?.[0]?.image_uris?.art_crop || null
    })
    .filter(Boolean)
}

function pickImages(byName, names) {
  return names
    .map(n => {
      const d = byName.get(n)
      const src = d?.image_uris?.small || d?.card_faces?.[0]?.image_uris?.small || null
      return src ? { name: d.name, src } : null
    })
    .filter(Boolean)
}

// ── Constants ─────────────────────────────────────────────────────────────
const BG_CARD_POOL = [
  'Urborg, Tomb of Yawgmoth',
  'Emrakul, the Promised End',
  'Jace, the Mind Sculptor',
  'Liliana of the Veil',
  'Snapcaster Mage',
  'Force of Will',
]

const GALLERY_CARD_POOL = [
  'Yawgmoth, Thran Physician',
  'Elesh Norn, Grand Cenobite',
  'Ugin, the Spirit Dragon',
  'Kozilek, Butcher of Truth',
  'Griselbrand',
  'Avacyn, Angel of Hope',
  'The One Ring',
  'Ragavan, Nimble Pilferer',
  'Wrenn and Six',
  'Mox Diamond',
  'Bitterblossom',
  'Nicol Bolas, Planeswalker',
]

const COLLECTION_CARD_POOL = [
  'Lightning Bolt',
  'Sol Ring',
  'Mana Crypt',
  'Force of Will',
  'Cyclonic Rift',
  'Rhystic Study',
  'Smothering Tithe',
  'Ancient Copper Dragon',
  'Mana Vault',
  'Dockside Extortionist',
  'Sensei\'s Divining Top',
  'Swords to Plowshares',
]

const BUILDER_CARD_POOL = [
  "Atraxa, Praetors' Voice",
  'Doubling Season',
  'Demonic Tutor',
  'The One Ring',
  'Sylvan Library',
  'Vampiric Tutor',
  'Mana Drain',
  'Jeska\'s Will',
  'Cyclonic Rift',
  'Deflecting Swat',
  'Teferi\'s Protection',
  'Birds of Paradise',
]

function shuffleAndTake(cards, count) {
  const copy = [...cards]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, count)
}

const FEATURES = [
  {
    icon: '◈',
    title: 'Collection Tracking',
    desc: 'Catalog every card you own. Search and filter by name, set, colour, type, rarity or price so your full collection stays easy to navigate.',
    stat: 'Search by name, set, and print',
  },
  {
    icon: '◎',
    title: 'Card Scanner',
    desc: 'Add cards in seconds with your phone camera. Perceptual hashing matches the exact printing — no typing collector numbers by hand.',
    stat: 'Fast camera card entry',
  },
  {
    icon: '⚔',
    title: 'Deck Builder',
    desc: 'Build decklists with combo detection, format legality checks, commander colour identity warnings, and one-click sync from your owned cards.',
    stat: 'Commander-focused deck workflow',
  },
  {
    icon: '◐',
    title: 'Deck Playtester',
    desc: 'Goldfish any deck right in the browser — opening hands, mulligans, draws and shuffles — to stress-test new builds before sleeving up.',
    stat: 'In-app deck goldfish',
  },
  {
    icon: '◉',
    title: 'Pricing & P&L',
    desc: 'Live market values, daily snapshots, manual overrides, and per-deck totals so you can follow how your collection changes over time.',
    stat: 'Daily price tracking',
  },
  {
    icon: '⬡',
    title: 'Binder Organisation',
    desc: 'Group cards into named binders, decks, and wishlists. Bulk-import from Manabox CSV. View everything in grid or table view with full filtering.',
    stat: 'Binders, decks, and wishlists',
  },
  {
    icon: '✦',
    title: 'Wishlist Tracking',
    desc: 'Track exact printings and foil finishes you are hunting. See live market prices for every item on your list so you can buy at the right moment.',
    stat: 'Track any printing or foil',
  },
  {
    icon: '⇄',
    title: 'Trade Valuation',
    desc: 'Drop a want list against your collection to weigh trades, see two-way totals, and find the printings that match what someone is asking for.',
    stat: 'Match wants to what you own',
  },
  {
    icon: '◢',
    title: 'Collection Analytics',
    desc: 'Breakdowns by colour, type, mana value, rarity and set — plus value-over-time charts so you can see what your collection actually looks like.',
    stat: 'Charts and breakdowns',
  },
  {
    icon: '♥',
    title: 'Multiplayer Life Tracker',
    desc: 'Spin up a game on one device or share a join code across phones. Commander damage, poison, monarch, and a unified game log per match.',
    stat: 'Up to 6 players, any device',
  },
  {
    icon: '✧',
    title: 'Public Profiles & Shared Decks',
    desc: 'A bento-grid profile showcases your favourite decks, stats and bio. Share any deck via shortlink so friends can review the list.',
    stat: 'Personal profile URL',
  },
  {
    icon: '§',
    title: 'MTG Rulebook',
    desc: 'The comprehensive rules built in — searchable by category, section, or rule number so the answer is one tap away mid-game.',
    stat: 'Full searchable rules',
  },
]

// App panel
function AppPanel({ title, subtitle, icon, eyebrow, accent, metrics = [], highlights = [], cards, arts }) {
  return (
    <div className={`${styles.panel} ${accent === 'builder' ? styles.panelBuilder : styles.panelCollection}`}>
      <div className={styles.panelGlow} />
      <div className={styles.panelHeader}>
        <div className={styles.panelHeaderMain}>
          <div className={styles.panelTitleRow}>
            <span className={styles.panelIcon}>{icon}</span>
            <span className={styles.panelTitle}>{title}</span>
          </div>
          {eyebrow ? <span className={styles.panelEyebrow}>{eyebrow}</span> : null}
        </div>
        <span className={styles.panelSub}>{subtitle}</span>
      </div>
      {metrics.length ? (
        <div className={styles.panelMetrics}>
          {metrics.map(metric => (
            <div key={metric.label} className={styles.panelMetric}>
              <span className={styles.panelMetricValue}>{metric.value}</span>
              <span className={styles.panelMetricLabel}>{metric.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      {highlights.length ? (
        <div className={styles.panelHighlights}>
          {highlights.map(item => (
            <span key={item} className={styles.panelHighlight}>
              {item}
            </span>
          ))}
        </div>
      ) : null}
      <div className={styles.panelGrid}>
        {cards.map((name, i) => (
          <div key={name} className={styles.panelCard}>
            {arts[i]
              ? <img src={arts[i]} alt="" className={styles.panelCardImg} loading="lazy" />
              : <div className={styles.panelCardPh} />
            }
            <div className={styles.panelCardName}>{name}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Login page ─────────────────────────────────────────────────────────────
export function LoginPage({ forcedMode = null }) {
  const { user, clearAuthEvent } = useAuth()
  const [mode, setMode]         = useState(forcedMode || 'login')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError]       = useState('')
  const [success, setSuccess]   = useState('')
  const [loading, setLoading]   = useState(false)

  const bgCards = useMemo(() => shuffleAndTake(BG_CARD_POOL, 6), [])
  const galleryCards = useMemo(() => shuffleAndTake(GALLERY_CARD_POOL, 12), [])
  const collectionCards = useMemo(() => shuffleAndTake(COLLECTION_CARD_POOL, 6), [])
  const builderCards = useMemo(() => shuffleAndTake(BUILDER_CARD_POOL, 6), [])
  const steps = useMemo(() => ([
    {
      number: '01',
      title: 'Scan or Import',
      desc: 'Add cards in seconds with the phone camera, search by name and set, or bulk-import a whole collection from a Manabox CSV export.',
      cards: collectionCards.slice(0, 3),
      artsKey: 'collection0',
    },
    {
      number: '02',
      title: 'Organise & Build',
      desc: 'Sort cards into binders, wishlists, and decks. The deck builder ties straight back to your owned cards so you always know what you still need.',
      cards: builderCards.slice(0, 3),
      artsKey: 'builder0',
    },
    {
      number: '03',
      title: 'Test & Play',
      desc: 'Goldfish new builds in the in-app playtester, then track real games with the multiplayer life tracker — share a join code and play across phones.',
      cards: builderCards.slice(3, 6),
      artsKey: 'builder3',
    },
    {
      number: '04',
      title: 'Value & Share',
      desc: 'Watch daily market prices, gauge trades against your collection, and share decks or your public profile when you want to show what you have built.',
      cards: collectionCards.slice(3, 6),
      artsKey: 'collection3',
    },
  ]), [builderCards, collectionCards])

  const allCardNames = useMemo(
    () => [...bgCards, ...galleryCards, ...collectionCards, ...builderCards],
    [bgCards, galleryCards, collectionCards, builderCards],
  )
  const cardByName     = useCardLookup(allCardNames)
  const bgArts         = useMemo(() => pickArts(cardByName, bgCards), [cardByName, bgCards])
  const galleryImages  = useMemo(() => pickImages(cardByName, galleryCards), [cardByName, galleryCards])
  const collectionArts = useMemo(() => pickArts(cardByName, collectionCards), [cardByName, collectionCards])
  const builderArts    = useMemo(() => pickArts(cardByName, builderCards), [cardByName, builderCards])

  useEffect(() => {
    if (forcedMode) setMode(forcedMode)
  }, [forcedMode])

  // Login page is always rendered with the default shadow theme regardless of
  // the signed-in user's theme preference (e.g. during password recovery).
  useEffect(() => {
    const root = document.documentElement
    const force = () => {
      if (root.getAttribute('data-theme') !== 'shadow' || root.hasAttribute('data-oled')) {
        applyTheme('shadow', false)
      }
    }
    force()
    const observer = new MutationObserver(force)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-oled', 'data-theme-mode'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
    const params = new URLSearchParams(hash)
    const description = params.get('error_description')
    if (description) setError(decodeURIComponent(description.replace(/\+/g, ' ')))
  }, [])

  const submit = async () => {
    setError(''); setSuccess(''); setLoading(true)
    if (mode === 'register') {
      if (password !== password2) { setError('Passwords do not match.'); setLoading(false); return }
      if (password.length < 8)    { setError('Password must be at least 8 characters.'); setLoading(false); return }
      const { error: err } = await sb.auth.signUp({
        email, password,
        options: { emailRedirectTo: getProdAppUrl('/') },
      })
      if (err) setError(err.message)
      else setSuccess('Account created! Check your email to confirm, then sign in.')
    } else if (mode === 'forgot') {
      if (!email) { setError('Enter your email address first.'); setLoading(false); return }
      const { error: err } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: getProdAppUrl('/'),
      })
      if (err) setError(err.message)
      else setSuccess('Password reset email sent. Check your inbox to continue.')
    } else if (mode === 'recovery') {
      if (password !== password2) { setError('Passwords do not match.'); setLoading(false); return }
      if (password.length < 8)    { setError('Password must be at least 8 characters.'); setLoading(false); return }
      const { error: err } = await sb.auth.updateUser({ password })
      if (err) setError(err.message)
      else {
        await sb.auth.signOut({ scope: 'local' })
        clearAuthEvent?.()
        setSuccess('Password updated. Sign in with your new password to continue.')
      }
    } else {
      clearPendingRecovery()
      const { error: err } = await sb.auth.signInWithPassword({ email, password })
      if (err) setError(err.message)
    }
    setLoading(false)
  }

  const signInWithProvider = async (provider) => {
    setError(''); setSuccess(''); setLoading(true)
    try {
      if (isNativeApp()) {
        await openNativeOAuth(provider)
        // Session will arrive via the deep-link handler; keep loading state until auth state updates.
        return
      }
      const { error: err } = await sb.auth.signInWithOAuth({
        provider,
        options: { redirectTo: getPublicBaseUrl() + '/' },
      })
      if (err) { setError(err.message); setLoading(false) }
    } catch (err) {
      setError(err?.message || 'Sign-in failed')
      setLoading(false)
    }
  }

  const switchMode = (m) => {
    if (forcedMode === 'recovery') return
    setMode(m); setError(''); setSuccess('')
  }

  return (
    <main className={styles.page}>

      {/* ── Cinematic art background ── */}
      <div className={styles.artBg}>
        {bgCards.map((_, i) => (
          <div
            key={i}
            className={styles.artTile}
            style={bgArts[i] ? { backgroundImage: `url(${bgArts[i]})`, '--i': i } : { '--i': i }}
          />
        ))}
        <div className={styles.artOverlay} />
      </div>

      {/* ── Hero ── */}
      <section className={styles.hero}>
        <div className={styles.heroLeft}>
          <div className={styles.heroLogo}>
            <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" fetchpriority="high" decoding="async" />
            <span className={styles.logoText}>Deck<span>Loom</span></span>
          </div>
          <h1 className={styles.tagline}>
            All in one<br />Magic: The Gathering companion.
          </h1>
          <p className={styles.taglineSub}>
            Scan cards, organise your collection, build decks, and run multiplayer life totals —
            every tool a Magic player needs, in a single app.
          </p>

          <div className={styles.featurePills}>
            {FEATURES.map(f => (
              <span key={f.title} className={styles.pill}>
                <span className={styles.pillIcon}>{f.icon}</span>
                {f.title}
              </span>
            ))}
          </div>

          <div className={styles.heroStats}>
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>Scanner</span>
              <span className={styles.heroStatLabel}>Add cards with your camera</span>
            </div>
            <div className={styles.heroStatDivider} />
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>Collection</span>
              <span className={styles.heroStatLabel}>Binders, decks, wishlists, trades</span>
            </div>
            <div className={styles.heroStatDivider} />
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>Deck Builder</span>
              <span className={styles.heroStatLabel}>Build, playtest, share</span>
            </div>
            <div className={styles.heroStatDivider} />
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>Life Tracker</span>
              <span className={styles.heroStatLabel}>Multiplayer with join codes</span>
            </div>
          </div>
        </div>

        {/* ── Auth form ── */}
        <div className={styles.heroRight}>
          <form
            className={styles.formCard}
            onSubmit={e => {
              e.preventDefault()
              submit()
            }}
          >
            <div className={styles.formHeading}>
              {mode === 'recovery'
                ? 'Reset your password'
                : mode === 'forgot'
                  ? 'Forgot your password?'
                  : mode === 'login'
                    ? 'Welcome back'
                    : 'Join DeckLoom'}
            </div>
            <div className={styles.formSub}>
              {mode === 'recovery'
                ? 'Choose a new password to complete the recovery link'
                : mode === 'forgot'
                  ? 'Enter your email and we will send you a recovery link'
                : mode === 'login'
                  ? 'Sign in to DeckLoom'
                  : 'Start cataloguing your collection today'}
            </div>
            {(mode === 'login' || mode === 'register') && (
              <>
                <button
                  type="button"
                  className={`${styles.oauthBtn} ${styles.oauthGoogle}`}
                  onClick={() => signInWithProvider('google')}
                  disabled={loading}
                >
                  <svg className={styles.oauthIcon} viewBox="0 0 48 48" aria-hidden="true">
                    <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
                    <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
                    <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
                    <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
                  </svg>
                  Continue with Google
                </button>
                <button
                  type="button"
                  className={`${styles.oauthBtn} ${styles.oauthDiscord}`}
                  onClick={() => signInWithProvider('discord')}
                  disabled={loading}
                >
                  <svg className={styles.oauthIcon} viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3.2a.075.075 0 0 0-.079.037c-.34.6-.717 1.385-.98 2.003a18.27 18.27 0 0 0-5.482 0 12.51 12.51 0 0 0-.995-2.003.078.078 0 0 0-.079-.037A19.74 19.74 0 0 0 5.184 4.37a.07.07 0 0 0-.032.027C1.578 9.736.59 14.94 1.075 20.077a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.027.078.078 0 0 0 .084-.027c.462-.63.873-1.295 1.226-1.994a.076.076 0 0 0-.041-.105 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.075.075 0 0 1 .078-.01c3.927 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.128 12.299 12.299 0 0 1-1.873.891.077.077 0 0 0-.04.106c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.027.077.077 0 0 0 .032-.054c.5-5.94-.838-11.1-3.549-15.683a.06.06 0 0 0-.031-.028zM8.02 17.064c-1.183 0-2.157-1.085-2.157-2.418 0-1.334.956-2.42 2.157-2.42 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.974 0c-1.183 0-2.157-1.085-2.157-2.418 0-1.334.955-2.42 2.157-2.42 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                  </svg>
                  Continue with Discord
                </button>
                <div className={styles.oauthDivider}><span>or</span></div>
              </>
            )}
            {mode !== 'recovery' && mode !== 'forgot' && <div className={styles.tabs}>
              <button
                className={`${styles.tab}${mode === 'login' ? ' ' + styles.active : ''}`}
                type="button"
                onClick={() => switchMode('login')}
              >Sign In</button>
              <button
                className={`${styles.tab}${mode === 'register' ? ' ' + styles.active : ''}`}
                type="button"
                onClick={() => switchMode('register')}
              >Create Account</button>
            </div>}
            {mode !== 'recovery' && <input
              id="auth-email"
              name="email"
              className={styles.input}
              type="email"
              placeholder="Email address"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
              autoFocus={mode === 'login' || mode === 'register' || mode === 'forgot'}
            />}
            {mode === 'recovery' && (
              <input
                id="auth-recovery-email"
                name="email"
                type="email"
                autoComplete="username"
                value={user?.email || email}
                readOnly
                tabIndex={-1}
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  width: 1,
                  height: 1,
                  padding: 0,
                  margin: -1,
                  overflow: 'hidden',
                  clip: 'rect(0, 0, 0, 0)',
                  whiteSpace: 'nowrap',
                  border: 0,
                }}
              />
            )}
            {mode !== 'forgot' && <input
              id="auth-password"
              name={mode === 'recovery' ? 'new-password' : 'password'}
              className={styles.input}
              type="password"
              placeholder={mode === 'recovery' ? 'New password' : 'Password'}
              autoComplete={mode === 'recovery' || mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
              autoFocus={mode === 'recovery'}
            />}
            {(mode === 'register' || mode === 'recovery') && (
              <input
                id="auth-confirm-password"
                name="confirm-password"
                className={styles.input}
                type="password"
                placeholder={mode === 'recovery' ? 'Confirm new password' : 'Confirm password'}
                autoComplete="new-password"
                value={password2}
                onChange={e => setPassword2(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submit()}
              />
            )}
            <button
              className={styles.submit}
              type="submit"
              disabled={
                loading ||
                !email && mode === 'forgot' ||
                (!password && mode !== 'forgot') ||
                (mode !== 'recovery' && mode !== 'forgot' && !email) ||
                ((mode === 'register' || mode === 'recovery') && !password2)
              }
            >
              {loading
                ? '...'
                : mode === 'recovery'
                  ? 'Update Password'
                  : mode === 'forgot'
                    ? 'Send Reset Email'
                    : mode === 'login'
                      ? 'Sign In'
                      : 'Create Account'}
            </button>
            {error   && <div className={styles.error}>{error}</div>}
            {success && <div className={styles.success}>{success}</div>}

            {mode === 'login' && (
              <button
                className={styles.resetLink}
                onClick={() => switchMode('forgot')}
                type="button"
              >
                Forgot password?
              </button>
            )}
            {mode === 'forgot' && (
              <button
                className={styles.resetLink}
                onClick={() => switchMode('login')}
                type="button"
              >
                Back to sign in
              </button>
            )}
            <div className={styles.formNote}>
              {mode === 'recovery'
                ? 'Set a new password to finish the recovery flow.'
                : mode === 'forgot'
                  ? 'We will send the reset link to the email address above.'
                  : 'Use your account to keep your collection, decks, and settings in sync.'}
            </div>
            <div className={styles.legalLinks}>
              <Link className={styles.legalLink} to="/privacy">Privacy</Link>
              <Link className={styles.legalLink} to="/storage">Storage</Link>
              <Link className={styles.legalLink} to="/credits">Credits</Link>
              <Link className={styles.legalLink} to="/delete-account">Delete Account</Link>
            </div>
          </form>
        </div>
      </section>

      {/* ── Card gallery strip ── */}
      {galleryImages.length > 0 && (
        <div className={styles.galleryOuter}>
          <div className={styles.galleryStrip}>
            {/* Double the array for a seamless loop feel */}
            {[...galleryImages, ...galleryImages].map((img, i) => (
              <div
                key={i}
                className={styles.galleryCard}
                style={{ '--rot': `${((i % 5) - 2) * 2.2}deg`, '--delay': `${(i % galleryImages.length) * 0.07}s` }}
              >
                <img src={img.src} alt={img.name} className={styles.galleryCardImg} loading="lazy" />
              </div>
            ))}
          </div>
          <div className={styles.galleryFadeLeft} />
          <div className={styles.galleryFadeRight} />
        </div>
      )}

      {/* ── Feature grid ── */}
      <section className={styles.features}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionLabel}>Everything you need</div>
          <h2 className={styles.sectionTitle}>Built for serious collectors</h2>
          <p className={styles.sectionDesc}>
            DeckLoom brings together every tool a Magic: The Gathering player needs
            — from first scan to deck tournament-ready.
          </p>
        </div>
        <div className={styles.featureGrid}>
          {FEATURES.map(f => (
            <div key={f.title} className={styles.featureCard}>
              <div className={styles.featureIconWrap}>
                <span className={styles.featureIcon}>{f.icon}</span>
              </div>
              <div className={styles.featureTitle}>{f.title}</div>
              <div className={styles.featureDesc}>{f.desc}</div>
              <div className={styles.featureStat}>{f.stat}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section className={styles.howItWorks}>
        <div className={styles.sectionLabel} style={{ justifyContent: 'center' }}>How it works</div>
        <h2 className={styles.sectionTitle} style={{ textAlign: 'center' }}>From unboxed to organised in minutes</h2>
        <div className={styles.steps}>
          {steps.map(step => {
            const artsForStep = (
              step.artsKey === 'collection0' ? collectionArts.slice(0, 3)
              : step.artsKey === 'builder0' ? builderArts.slice(0, 3)
              : step.artsKey === 'builder3' ? builderArts.slice(3, 6)
              : collectionArts.slice(3, 6)
            )
            return (
              <div key={step.number} className={styles.step}>
                <div className={styles.stepNumber}>{step.number}</div>
                <div className={styles.stepContent}>
                  <div className={styles.stepTitle}>{step.title}</div>
                  <div className={styles.stepDesc}>{step.desc}</div>
                </div>
                <div className={styles.stepCards}>
                  {step.cards.map((name, i) => (
                    <div
                      key={name}
                      className={styles.stepCardPh}
                      style={{ '--si': i }}
                    >
                      {artsForStep[i]
                        ? <img
                            src={artsForStep[i]}
                            alt=""
                            className={styles.stepCardImg}
                            loading="lazy"
                          />
                        : null
                      }
                      <div className={styles.stepCardName}>{name}</div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ── App panels ── */}
      <section className={styles.screenshots}>
        <div className={styles.sectionLabel} style={{ justifyContent: 'center' }}>See it in action</div>
        <h2 className={styles.sectionTitle} style={{ textAlign: 'center' }}>Everything in one place</h2>
        <p className={styles.sectionDesc} style={{ textAlign: 'center', maxWidth: 520, margin: '0 auto 48px' }}>
          A clean, fast interface built for the way collectors actually work —
          binders, decks, wishlists and price tracking all within arm's reach.
        </p>
        <div className={styles.panelRow}>
          <AppPanel
            icon="◈"
            title="COLLECTION"
            eyebrow="Your owned inventory"
            subtitle="Collection view with pricing, locations, and print tracking"
            accent="collection"
            metrics={[
              { value: 'Binders', label: 'Track where cards live' },
              { value: 'Prices', label: 'Follow deck and card value' },
            ]}
            highlights={['Locations', 'Printings', 'Wishlists']}
            cards={collectionCards}
            arts={collectionArts}
          />
          <AppPanel
            icon="⚔"
            title="DECK BUILDER"
            eyebrow="Plan before you pull cards"
            subtitle="Builder, sync, sharing, and collection deck flow"
            accent="builder"
            metrics={[
              { value: 'Sync', label: 'Move owned copies into decks' },
              { value: 'Combos', label: 'Review lines and package ideas' },
            ]}
            highlights={['Recommendations', 'Collection Decks', 'Sharing']}
            cards={builderCards}
            arts={builderArts}
          />
        </div>
      </section>

      {/* ── Stats bar ── */}
      <div className={styles.statsBar}>
        <div className={styles.statsBarItem}>
          <span className={styles.statsBarNum}>Scan</span>
          <span className={styles.statsBarLabel}>Camera matches the exact printing</span>
        </div>
        <div className={styles.statsBarDot} />
        <div className={styles.statsBarItem}>
          <span className={styles.statsBarNum}>Prices</span>
          <span className={styles.statsBarLabel}>Market values, updated daily</span>
        </div>
        <div className={styles.statsBarDot} />
        <div className={styles.statsBarItem}>
          <span className={styles.statsBarNum}>Playtest</span>
          <span className={styles.statsBarLabel}>Goldfish decks in the browser</span>
        </div>
        <div className={styles.statsBarDot} />
        <div className={styles.statsBarItem}>
          <span className={styles.statsBarNum}>Multiplayer</span>
          <span className={styles.statsBarLabel}>Life tracker with shared join codes</span>
        </div>
      </div>

      {/* ── Footer CTA ── */}
      <footer className={styles.footerCta}>
        <div className={styles.footerLogo}>
          <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" fetchpriority="high" decoding="async" />
          <span className={styles.logoText}>Deck<span>Loom</span></span>
        </div>
        <p className={styles.footerText}>Your Magic collection deserves a proper home.</p>
        <button
          className={styles.footerBtn}
          onClick={() => { switchMode('register'); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
        >
          Create Account
        </button>
        <p className={styles.footerSmall}>Use one account to keep your collection, decks, and wishlists together.</p>
        <div className={styles.footerLegal}>
          <Link className={styles.footerLegalLink} to="/privacy">Privacy Policy</Link>
          <Link className={styles.footerLegalLink} to="/storage">Cookies and Local Storage</Link>
          <Link className={styles.footerLegalLink} to="/credits">Credits</Link>
        </div>
      </footer>

    </main>
  )
}
