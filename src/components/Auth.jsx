import { createContext, useContext, useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import styles from './Auth.module.css'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    sb.auth.getSession().then(({ data: { session } }) => setSession(session))
    const { data: { subscription } } = sb.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) return (
    <div className={styles.loading}>Loading…</div>
  )

  return (
    <AuthContext.Provider value={{ session, user: session?.user || null }}>
      {children}
    </AuthContext.Provider>
  )
}

// ── Card art hook ──────────────────────────────────────────────────────────────
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
    ).then(results => {
      if (!cancelled) setArts(results.filter(Boolean))
    })
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return arts
}

// ── Constants ─────────────────────────────────────────────────────────────────
const BG_CARDS = [
  'Urborg, Tomb of Yawgmoth',
  'Emrakul, the Promised End',
  'Jace, the Mind Sculptor',
  'Liliana of the Veil',
  'Snapcaster Mage',
  'Force of Will',
]

const COLLECTION_CARDS = ['Lightning Bolt', 'Sol Ring', 'Mana Crypt', 'Force of Will', 'Cyclonic Rift', 'Rhystic Study']
const BUILDER_CARDS    = ["Atraxa, Praetors' Voice", 'Doubling Season', 'Demonic Tutor', 'The One Ring', 'Sylvan Library', 'Vampiric Tutor']

const FEATURES = [
  {
    icon: '◈',
    title: 'Collection Tracking',
    desc: 'Catalog every card you own. Search, filter, and value your full collection in seconds.',
  },
  {
    icon: '⚔',
    title: 'Deck Builder',
    desc: 'Plan Commander, Modern and more. EDHRec synergy recommendations and combo detection built in.',
  },
  {
    icon: '◉',
    title: 'Price Analytics',
    desc: 'Live EUR & USD market values across your entire collection with P&L tracking.',
  },
  {
    icon: '◎',
    title: 'Card Scanner',
    desc: 'Point your camera at any card. OCR and perceptual hashing identify it instantly.',
  },
]

// ── App screenshot mockup ──────────────────────────────────────────────────────
function AppMockup({ title, subtitle, cards, arts, urlSlug }) {
  return (
    <div className={styles.mockFrame}>
      <div className={styles.mockBar}>
        <div className={styles.mockDots}><span /><span /><span /></div>
        <div className={styles.mockUrl}>arcanevault.app / {urlSlug}</div>
      </div>
      <div className={styles.mockContent}>
        <div className={styles.mockHeader}>
          <span className={styles.mockTitle}>{title}</span>
          <span className={styles.mockMeta}>{subtitle}</span>
        </div>
        <div className={styles.mockGrid}>
          {cards.map((name, i) => (
            <div key={name} className={styles.mockCard}>
              {arts[i]
                ? <img src={arts[i]} alt="" className={styles.mockCardImg} loading="lazy" />
                : <div className={styles.mockCardPh} />
              }
              <div className={styles.mockCardName}>{name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Login page ─────────────────────────────────────────────────────────────────
export function LoginPage() {
  const [mode, setMode]       = useState('login')
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError]     = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)

  const bgArts         = useCardArts(BG_CARDS)
  const collectionArts = useCardArts(COLLECTION_CARDS)
  const builderArts    = useCardArts(BUILDER_CARDS)

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
    } else {
      const { error: err } = await sb.auth.signInWithPassword({ email, password })
      if (err) setError(err.message)
    }
    setLoading(false)
  }

  const switchMode = (m) => { setMode(m); setError(''); setSuccess('') }

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

      {/* ── Hero: tagline + form ── */}
      <section className={styles.hero}>
        <div className={styles.heroLeft}>
          <div className={styles.heroLogo}>ARCANE<span>VAULT</span></div>
          <h1 className={styles.tagline}>
            The vault for<br />every card you own.
          </h1>
          <p className={styles.taglineSub}>
            Track your collection, build powerful decks,<br />
            monitor prices, and scan cards with your camera.
          </p>

          <div className={styles.featurePills}>
            {FEATURES.map(f => (
              <span key={f.title} className={styles.pill}>
                <span className={styles.pillIcon}>{f.icon}</span>
                {f.title}
              </span>
            ))}
          </div>

          <div className={styles.storeBadges}>
            {/* Apple App Store */}
            <div className={styles.badge}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
              </svg>
              <div>
                <div className={styles.badgeLabel}>Download on the</div>
                <div className={styles.badgeStore}>App Store</div>
              </div>
            </div>

            {/* Google Play */}
            <div className={styles.badge}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M3 20.5v-17c0-.83.94-1.3 1.6-.8l14 8.5c.6.37.6 1.23 0 1.6l-14 8.5c-.66.5-1.6.03-1.6-.8z" />
              </svg>
              <div>
                <div className={styles.badgeLabel}>Get it on</div>
                <div className={styles.badgeStore}>Google Play</div>
              </div>
            </div>
          </div>
        </div>

        {/* Form */}
        <div className={styles.heroRight}>
          <div className={styles.formCard}>
            <div className={styles.formHeading}>
              {mode === 'login' ? 'Welcome back' : 'Join ArcaneVault'}
            </div>
            <div className={styles.formSub}>
              {mode === 'login' ? 'Sign in to your vault' : 'Start cataloguing your collection today'}
            </div>
            <div className={styles.tabs}>
              <button className={`${styles.tab}${mode === 'login' ? ' ' + styles.active : ''}`} onClick={() => switchMode('login')}>Sign In</button>
              <button className={`${styles.tab}${mode === 'register' ? ' ' + styles.active : ''}`} onClick={() => switchMode('register')}>Create Account</button>
            </div>
            <input
              className={styles.input}
              type="email"
              placeholder="Email address"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
              autoFocus
            />
            <input
              className={styles.input}
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
            />
            {mode === 'register' && (
              <input
                className={styles.input}
                type="password"
                placeholder="Confirm password"
                value={password2}
                onChange={e => setPassword2(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submit()}
              />
            )}
            <button
              className={styles.submit}
              onClick={submit}
              disabled={loading || !email || !password}
            >
              {loading ? '…' : mode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
            {error   && <div className={styles.error}>{error}</div>}
            {success && <div className={styles.success}>{success}</div>}
          </div>
        </div>
      </section>

      {/* ── Feature cards ── */}
      <section className={styles.features}>
        {FEATURES.map(f => (
          <div key={f.title} className={styles.featureCard}>
            <div className={styles.featureIcon}>{f.icon}</div>
            <div className={styles.featureTitle}>{f.title}</div>
            <div className={styles.featureDesc}>{f.desc}</div>
          </div>
        ))}
      </section>

      {/* ── App screenshots ── */}
      <section className={styles.screenshots}>
        <div className={styles.screenshotsLabel}>Everything in one place</div>
        <div className={styles.mockRow}>
          <AppMockup
            title="COLLECTION"
            subtitle="18,300 cards · €10,767"
            cards={COLLECTION_CARDS}
            arts={collectionArts}
            urlSlug="collection"
          />
          <AppMockup
            title="DECK BUILDER"
            subtitle="12 decks · Commander / EDH"
            cards={BUILDER_CARDS}
            arts={builderArts}
            urlSlug="builder"
          />
        </div>
      </section>

      {/* ── Footer CTA ── */}
      <footer className={styles.footerCta}>
        <div className={styles.footerLogo}>ARCANE<span>VAULT</span></div>
        <p className={styles.footerText}>Your Magic collection deserves a proper home.</p>
        <button
          className={styles.footerBtn}
          onClick={() => { switchMode('register'); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
        >
          Get Started Free
        </button>
      </footer>

    </div>
  )
}
