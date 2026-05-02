import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
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
    icon: '⚔',
    title: 'Deck Builder',
    desc: 'Build decklists with recommendations, combo detection, collection sync, and collection-deck allocation workflows.',
    stat: 'Commander-focused deck workflow',
  },
  {
    icon: '◉',
    title: 'Profit and Loss',
    desc: 'Follow daily EUR and USD market values, compare deck totals, and watch how your collection changes over time.',
    stat: 'Daily market price tracking',
  },
  {
    icon: '◎',
    title: 'Card Scanner',
    desc: 'Use your camera to add cards quickly when typing every print by hand would slow you down.',
    stat: 'Fast camera card entry',
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
    icon: '✧',
    title: 'Sharing and Planning',
    desc: 'Share decks, compare ideas, and keep collection decks aligned with the cards you actually own.',
    stat: 'Shareable decks and collection sync',
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
      title: 'Scan or Search',
      desc: 'Use your phone camera to add cards quickly, or search by name, set, or collector number when you want a specific printing.',
      cards: collectionCards.slice(0, 3),
    },
    {
      number: '02',
      title: 'Organise Everything',
      desc: 'Sort cards into binders, assemble decks, and build wishlists. Move cards with bulk actions or import an entire collection from a Manabox CSV export.',
      cards: builderCards.slice(0, 3),
    },
    {
      number: '03',
      title: 'Track Profit and Loss',
      desc: 'Market prices update daily. Historical snapshots chart how your collection changes so you can follow value across cards and decks.',
      cards: collectionCards.slice(3, 6),
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
      if (password.length < 6)    { setError('Password must be at least 6 characters.'); setLoading(false); return }
      const { error: err } = await sb.auth.signUp({
        email, password,
        options: { emailRedirectTo: 'https://deckloom.app/' },
      })
      if (err) setError(err.message)
      else setSuccess('Account created! Check your email to confirm, then sign in.')
    } else if (mode === 'forgot') {
      if (!email) { setError('Enter your email address first.'); setLoading(false); return }
      const { error: err } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: 'https://deckloom.app/',
      })
      if (err) setError(err.message)
      else setSuccess('Password reset email sent. Check your inbox to continue.')
    } else if (mode === 'recovery') {
      if (password !== password2) { setError('Passwords do not match.'); setLoading(false); return }
      if (password.length < 6)    { setError('Password must be at least 6 characters.'); setLoading(false); return }
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
            Your Magic collection,<br />finally organised.
          </h1>
          <p className={styles.taglineSub}>
            Scan cards with your camera, build decks, track market values in EUR and USD,
            and monitor your profit and loss — all in one place.
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
              <span className={styles.heroStatNum}>Collection</span>
              <span className={styles.heroStatLabel}>Cards, binders, decks, and wishlists</span>
            </div>
            <div className={styles.heroStatDivider} />
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>EUR & USD</span>
              <span className={styles.heroStatLabel}>Live market prices</span>
            </div>
            <div className={styles.heroStatDivider} />
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>Decks</span>
              <span className={styles.heroStatLabel}>Builder, sharing, and collection sync</span>
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
          {steps.map((step, si) => (
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
                    {(si === 0 ? collectionArts : si === 1 ? builderArts : collectionArts.slice(3))[i]
                      ? <img
                          src={(si === 0 ? collectionArts : si === 1 ? builderArts : collectionArts)[i]}
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
          ))}
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
          <span className={styles.statsBarNum}>Search</span>
          <span className={styles.statsBarLabel}>Find exact printings and finishes</span>
        </div>
        <div className={styles.statsBarDot} />
        <div className={styles.statsBarItem}>
          <span className={styles.statsBarNum}>EUR & USD</span>
          <span className={styles.statsBarLabel}>Live prices, updated daily</span>
        </div>
        <div className={styles.statsBarDot} />
        <div className={styles.statsBarItem}>
          <span className={styles.statsBarNum}>Share</span>
          <span className={styles.statsBarLabel}>Show off decks and collection plans</span>
        </div>
        <div className={styles.statsBarDot} />
        <div className={styles.statsBarItem}>
          <span className={styles.statsBarNum}>Organise</span>
          <span className={styles.statsBarLabel}>Keep binders, decks, and wishlists in step</span>
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
