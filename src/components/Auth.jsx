import { createContext, useContext, useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import styles from './Auth.module.css'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined)
  const [authEvent, setAuthEvent] = useState(null)

  useEffect(() => {
    sb.auth.getSession().then(({ data: { session } }) => setSession(session))
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, s) => {
      setAuthEvent(event)
      setSession(s)
    })
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) return (
    <div className={styles.loading}>Loading…</div>
  )

  return (
    <AuthContext.Provider value={{ session, user: session?.user || null, authEvent, clearAuthEvent: () => setAuthEvent(null) }}>
      {children}
    </AuthContext.Provider>
  )
}

// ── Art crop hook ─────────────────────────────────────────────────────────
function useCardArts(cardNames) {
  const [arts, setArts] = useState([])
  useEffect(() => {
    let cancelled = false
    Promise.all(
      cardNames.map(name =>
        fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=json`)
          .then(r => r.json())
          .then(d => d.image_uris?.art_crop || d.card_faces?.[0]?.image_uris?.art_crop || null)
          .catch(() => null)
      )
    ).then(results => { if (!cancelled) setArts(results.filter(Boolean)) })
    return () => { cancelled = true }
  }, []) // eslint-disable-line
  return arts
}

// ── Full card image hook (normal format) ──────────────────────────────────
function useCardImages(cardNames) {
  const [images, setImages] = useState([])
  useEffect(() => {
    let cancelled = false
    Promise.all(
      cardNames.map(name =>
        fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=json`)
          .then(r => r.json())
          .then(d => ({
            name: d.name,
            src: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal || null,
          }))
          .catch(() => null)
      )
    ).then(results => { if (!cancelled) setImages(results.filter(r => r?.src)) })
    return () => { cancelled = true }
  }, []) // eslint-disable-line
  return images
}

// ── Constants ─────────────────────────────────────────────────────────────
const BG_CARDS = [
  'Urborg, Tomb of Yawgmoth',
  'Emrakul, the Promised End',
  'Jace, the Mind Sculptor',
  'Liliana of the Veil',
  'Snapcaster Mage',
  'Force of Will',
]

const GALLERY_CARDS = [
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

const COLLECTION_CARDS = ['Lightning Bolt', 'Sol Ring', 'Mana Crypt', 'Force of Will', 'Cyclonic Rift', 'Rhystic Study']
const BUILDER_CARDS    = ["Atraxa, Praetors' Voice", 'Doubling Season', 'Demonic Tutor', 'The One Ring', 'Sylvan Library', 'Vampiric Tutor']

const FEATURES = [
  {
    icon: '◈',
    title: 'Collection Tracking',
    desc: 'Catalog every card you own. Search and filter by name, set, colour, type, rarity or price. Your complete inventory is always one search away.',
    stat: 'Search Scryfall print data',
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
    desc: 'Live EUR and USD market values, refreshed daily from Scryfall. Historical price snapshots reveal exactly how your collection grows over time.',
    stat: 'EUR & USD live pricing',
  },
  {
    icon: '◎',
    title: 'Card Scanner',
    desc: 'Point your camera at any card. OCR text recognition plus perceptual image hashing identify it instantly — no barcode, no typing required.',
    stat: 'Offline-capable scanner workflow',
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
]

const STEPS = [
  {
    number: '01',
    title: 'Scan or Search',
    desc: 'Use your phone camera to scan cards straight into your vault — or search Scryfall\'s database of 30,000+ cards by name, set, or collector number.',
    cards: COLLECTION_CARDS.slice(0, 3),
  },
  {
    number: '02',
    title: 'Organise Everything',
    desc: 'Sort cards into binders, assemble decks, and build wishlists. Move cards with bulk actions or import an entire collection from a Manabox CSV export.',
    cards: BUILDER_CARDS.slice(0, 3),
  },
  {
    number: '03',
    title: 'Track Profit and Loss',
    desc: 'Market prices update daily. Historical snapshots chart how your collection appreciates. Know your profit and loss on every card and every deck you own.',
    cards: COLLECTION_CARDS.slice(3, 6),
  },
]

// ── App panel (no browser chrome) ─────────────────────────────────────────
function AppPanel({ title, subtitle, icon, cards, arts }) {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitleRow}>
          <span className={styles.panelIcon}>{icon}</span>
          <span className={styles.panelTitle}>{title}</span>
        </div>
        <span className={styles.panelSub}>{subtitle}</span>
      </div>
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

  const bgArts         = useCardArts(BG_CARDS)
  const galleryImages  = useCardImages(GALLERY_CARDS)
  const collectionArts = useCardArts(COLLECTION_CARDS)
  const builderArts    = useCardArts(BUILDER_CARDS)

  useEffect(() => {
    if (forcedMode) setMode(forcedMode)
  }, [forcedMode])

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
        options: { emailRedirectTo: 'https://themazzy.github.io/arcanevault/' },
      })
      if (err) setError(err.message)
      else setSuccess('Account created! Check your email to confirm, then sign in.')
    } else if (mode === 'forgot') {
      if (!email) { setError('Enter your email address first.'); setLoading(false); return }
      const { error: err } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: 'https://themazzy.github.io/arcanevault/',
      })
      if (err) setError(err.message)
      else setSuccess('Password reset email sent. Check your inbox to continue.')
    } else if (mode === 'recovery') {
      if (password !== password2) { setError('Passwords do not match.'); setLoading(false); return }
      if (password.length < 6)    { setError('Password must be at least 6 characters.'); setLoading(false); return }
      const { error: err } = await sb.auth.updateUser({ password })
      if (err) setError(err.message)
      else {
        clearAuthEvent?.()
        setSuccess('Password updated. You can now continue with your new password.')
      }
    } else {
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
    <div className={styles.page}>

      {/* ── Cinematic art background ── */}
      <div className={styles.artBg}>
        {BG_CARDS.map((_, i) => (
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
          <div className={styles.heroLogo}>ARCANE<span>VAULT</span></div>
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
              <span className={styles.heroStatNum}>30K+</span>
              <span className={styles.heroStatLabel}>Scryfall-backed card search</span>
            </div>
            <div className={styles.heroStatDivider} />
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>EUR & USD</span>
              <span className={styles.heroStatLabel}>Live market prices</span>
            </div>
            <div className={styles.heroStatDivider} />
            <div className={styles.heroStat}>
              <span className={styles.heroStatNum}>Decks</span>
              <span className={styles.heroStatLabel}>Builder and collection sync</span>
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
                    : 'Join ArcaneVault'}
            </div>
            <div className={styles.formSub}>
              {mode === 'recovery'
                ? 'Choose a new password to complete the recovery link'
                : mode === 'forgot'
                  ? 'Enter your email and we will send you a recovery link'
                : mode === 'login'
                  ? 'Sign in to your vault'
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
            ArcaneVault brings together every tool a Magic: The Gathering player needs
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
          {STEPS.map((step, si) => (
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
            subtitle="Collection view with pricing and locations"
            cards={COLLECTION_CARDS}
            arts={collectionArts}
          />
          <AppPanel
            icon="⚔"
            title="DECK BUILDER"
            subtitle="Builder, sync, and collection deck flow"
            cards={BUILDER_CARDS}
            arts={builderArts}
          />
        </div>
      </section>

      {/* ── Stats bar ── */}
      <div className={styles.statsBar}>
        <div className={styles.statsBarItem}>
          <span className={styles.statsBarNum}>30,000+</span>
          <span className={styles.statsBarLabel}>Cards in Scryfall database</span>
        </div>
        <div className={styles.statsBarDot} />
        <div className={styles.statsBarItem}>
          <span className={styles.statsBarNum}>EUR & USD</span>
          <span className={styles.statsBarLabel}>Live prices, updated daily</span>
        </div>
        <div className={styles.statsBarDot} />
        <div className={styles.statsBarItem}>
          <span className={styles.statsBarNum}>Offline</span>
          <span className={styles.statsBarLabel}>Offline-capable scanner and local cache</span>
        </div>
        <div className={styles.statsBarDot} />
        <div className={styles.statsBarItem}>
          <span className={styles.statsBarNum}>Sync</span>
          <span className={styles.statsBarLabel}>Supabase-backed account data</span>
        </div>
      </div>

      {/* ── Footer CTA ── */}
      <footer className={styles.footerCta}>
        <div className={styles.footerLogo}>ARCANE<span>VAULT</span></div>
        <p className={styles.footerText}>Your Magic collection deserves a proper home.</p>
        <button
          className={styles.footerBtn}
          onClick={() => { switchMode('register'); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
        >
          Create Account
        </button>
        <p className={styles.footerSmall}>Works in your browser and keeps your collection tied to your account.</p>
      </footer>

    </div>
  )
}
