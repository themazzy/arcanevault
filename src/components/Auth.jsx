import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { getPublicBaseUrl, getProdAppUrl } from '../lib/publicUrl'
import { isNativeApp, openNativeOAuth, NATIVE_AUTH_ERROR_EVENT } from '../lib/nativeAuth'
import { reconcileActiveUser } from '../lib/accountReset'
import {
  parseEmailOtpParams,
  isRecoveryRedirect,
  redeemEmailOtp,
  stripOtpParamsFromUrl,
} from '../lib/authRecovery'
import { applyTheme } from './SettingsContext'
import { fetchCardsByNames } from '../lib/deckBuilderApi'
import {
  CheckIcon,
  ChevronRightIcon,
  CollectionIcon,
  DiceIcon,
  LifeIcon,
  LightningIcon,
  ScannerIcon,
  ShareIcon,
  StatsIcon,
  TargetIcon,
  TradingIcon,
  TrophyIcon,
  WishlistsIcon,
} from '../icons'
import BRAND_MARK from '../icons/DeckLoom_logo.png'
import styles from './Auth.module.css'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)
const RECOVERY_PENDING_KEY = 'deckloom_password_recovery_pending'

function hasRecoveryRedirect() {
  if (typeof window === 'undefined') return false
  return isRecoveryRedirect(window.location)
}

function hasStoredPendingRecovery() {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(RECOVERY_PENDING_KEY) === '1'
}

function hasPendingRecovery(session = null) {
  return hasRecoveryRedirect() || (Boolean(session) && hasStoredPendingRecovery())
}

function markPendingRecovery() {
  if (typeof window !== 'undefined') window.localStorage.setItem(RECOVERY_PENDING_KEY, '1')
}

function clearPendingRecovery() {
  if (typeof window !== 'undefined') window.localStorage.removeItem(RECOVERY_PENDING_KEY)
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined)
  const [recoveryError, setRecoveryError] = useState('')
  const [authEvent, setAuthEvent] = useState(() => (
    hasRecoveryRedirect() ? 'PASSWORD_RECOVERY' : null
  ))

  useEffect(() => {
    let active = true
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, nextSession) => {
      const wipe = reconcileActiveUser(nextSession?.user?.id || null)
      const apply = () => {
        setSession(nextSession)
        if (event === 'PASSWORD_RECOVERY') markPendingRecovery()
        setAuthEvent(
          event === 'PASSWORD_RECOVERY' || hasPendingRecovery(nextSession)
            ? 'PASSWORD_RECOVERY'
            : event,
        )
      }
      if (wipe) wipe.then(() => { if (active) apply() })
      else apply()
    })

    ;(async () => {
      const otp = typeof window !== 'undefined' ? parseEmailOtpParams(window.location) : null
      if (otp?.tokenHash) {
        if (otp.type === 'recovery') markPendingRecovery()
        const { error } = await redeemEmailOtp(sb, otp)
        stripOtpParamsFromUrl()
        if (error && active) {
          setRecoveryError(error.message || 'This link is invalid or has expired. Request a new one.')
        }
      } else if (hasRecoveryRedirect()) {
        markPendingRecovery()
      }

      const { data: { session: currentSession } } = await sb.auth.getSession()
      if (!active) return
      const wipe = reconcileActiveUser(currentSession?.user?.id || null)
      if (wipe) await wipe
      if (!active) return
      setSession(currentSession)
      if (hasPendingRecovery(currentSession)) setAuthEvent('PASSWORD_RECOVERY')
    })()

    return () => { active = false; subscription.unsubscribe() }
  }, [])

  if (session === undefined) {
    return <div className={styles.loading}>Loading DeckLoom…</div>
  }

  return (
    <AuthContext.Provider value={{
      session,
      user: session?.user || null,
      authEvent,
      recoveryError,
      clearAuthEvent: () => {
        clearPendingRecovery()
        setAuthEvent(null)
        setRecoveryError('')
      },
    }}>
      {children}
    </AuthContext.Provider>
  )
}

const CARD_ART_NAMES = [
  "Atraxa, Praetors' Voice",
  'Doubling Season',
  'The One Ring',
  'Rhystic Study',
  'Smothering Tithe',
  'Ancient Copper Dragon',
  "Teferi's Protection",
  'Sol Ring',
]

const BUILD_ASSIST_PROOFS = [
  'Start with cards already available in your collection',
  'Tune suggestions by theme, budget, and target bracket',
  'Balance ramp, draw, interaction, protection, and mana',
  'Fill gaps, build a buy list, cut to 100, then playtest',
]

const SECONDARY_FEATURES = [
  { icon: DiceIcon, title: 'Deck playtester', body: 'Goldfish opening hands, mulligans, draws, and complete turns.' },
  { icon: LifeIcon, title: 'Multiplayer life tracker', body: 'Run Commander games on one device or connect players with join codes.' },
  { icon: StatsIcon, title: 'Stats and P&L', body: 'Follow collection value, price movement, and acquisition performance.' },
  { icon: TradingIcon, title: 'Trade tools', body: 'Compare both sides of a trade against cards you already own.' },
  { icon: WishlistsIcon, title: 'Wishlists', body: 'Track wanted printings and keep them separate from owned inventory.' },
  { icon: ShareIcon, title: 'Profiles and sharing', body: 'Share decks, collaborative lists, and your public collection profile.' },
  { icon: TrophyIcon, title: 'Play tools', body: 'Manage tournaments and keep the comprehensive MTG rules close.' },
]

function runWhenIdle(callback) {
  if (typeof window === 'undefined') return () => {}
  if (window.requestIdleCallback) {
    const handle = window.requestIdleCallback(callback, { timeout: 1200 })
    return () => window.cancelIdleCallback?.(handle)
  }
  const timeout = window.setTimeout(callback, 180)
  return () => window.clearTimeout(timeout)
}

function useCardArt(names) {
  const [cards, setCards] = useState([])

  useEffect(() => {
    let cancelled = false
    const cancelIdle = runWhenIdle(() => {
      fetchCardsByNames(names)
        .then((results) => {
          if (cancelled) return
          setCards(results.map((card) => ({
            name: card.name,
            artSrc: card.image_uris?.art_crop || card.card_faces?.[0]?.image_uris?.art_crop || null,
            cardSrc: card.image_uris?.normal
              || card.card_faces?.[0]?.image_uris?.normal
              || card.image_uris?.large
              || card.card_faces?.[0]?.image_uris?.large
              || card.image_uris?.small
              || card.card_faces?.[0]?.image_uris?.small
              || null,
          })).filter((card) => card.cardSrc || card.artSrc))
        })
        .catch(() => {})
    })

    return () => {
      cancelled = true
      cancelIdle()
    }
  }, [names])

  return cards
}

function Brand({ compact = false }) {
  return (
    <span className={`${styles.brand}${compact ? ` ${styles.brandCompact}` : ''}`}>
      <img src={BRAND_MARK} alt="" aria-hidden="true" />
      <span>Deck<span>Loom</span></span>
    </span>
  )
}

function CardArtFan({ cards }) {
  if (cards.length === 0) {
    return (
      <div className={`${styles.artFan} ${styles.artFanEmpty}`} aria-hidden="true">
        <img src={BRAND_MARK} alt="" />
        <span>Your commander. Your collection. Your deck.</span>
      </div>
    )
  }

  return (
    <div className={styles.artFan} aria-label="Magic cards">
      {cards.slice(0, 4).map((card, index) => (
        <figure key={card.name} style={{ '--art-index': index }}>
          <img src={card.cardSrc || card.artSrc} alt="" loading="lazy" />
        </figure>
      ))}
    </div>
  )
}

export function LoginPage({ forcedMode = null }) {
  const { user, clearAuthEvent, recoveryError } = useAuth()
  const [mode, setMode] = useState(forcedMode || 'login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)
  const formRef = useRef(null)
  const artNames = useMemo(() => CARD_ART_NAMES, [])
  const cardArt = useCardArt(artNames)

  useEffect(() => {
    if (forcedMode) setMode(forcedMode)
  }, [forcedMode])

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
    const hashParams = new URLSearchParams(hash)
    const queryParams = new URLSearchParams(window.location.search)
    const description = queryParams.get('error_description') || hashParams.get('error_description')
    if (description) setError(decodeURIComponent(description.replace(/\+/g, ' ')))
  }, [])

  useEffect(() => {
    const onPageShow = (event) => {
      if (event.persisted) setLoading(false)
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  useEffect(() => {
    if (recoveryError) setError(recoveryError)
  }, [recoveryError])

  useEffect(() => {
    const onNativeAuthError = (event) => {
      setError(event?.detail || 'Sign-in could not be completed. Please try again.')
      setLoading(false)
    }
    window.addEventListener(NATIVE_AUTH_ERROR_EVENT, onNativeAuthError)
    return () => window.removeEventListener(NATIVE_AUTH_ERROR_EVENT, onNativeAuthError)
  }, [])

  const submit = async () => {
    setError('')
    setSuccess('')
    setLoading(true)

    if (mode === 'register') {
      if (password !== password2) {
        setError('Passwords do not match.')
        setLoading(false)
        return
      }
      if (password.length < 8) {
        setError('Password must be at least 8 characters.')
        setLoading(false)
        return
      }
      const { error: nextError } = await sb.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: getProdAppUrl('/') },
      })
      if (nextError) setError(nextError.message)
      else setSuccess('Account created. Check your email to confirm, then sign in.')
    } else if (mode === 'forgot') {
      if (!email) {
        setError('Enter your email address first.')
        setLoading(false)
        return
      }
      const { error: nextError } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: getProdAppUrl('/'),
      })
      if (nextError) setError(nextError.message)
      else setSuccess('Password reset email sent. Check your inbox to continue.')
    } else if (mode === 'recovery') {
      if (password !== password2) {
        setError('Passwords do not match.')
        setLoading(false)
        return
      }
      if (password.length < 8) {
        setError('Password must be at least 8 characters.')
        setLoading(false)
        return
      }
      const { error: nextError } = await sb.auth.updateUser({ password })
      if (nextError) setError(nextError.message)
      else {
        await sb.auth.signOut({ scope: 'local' })
        clearAuthEvent?.()
        setSuccess('Password updated. Sign in with your new password to continue.')
      }
    } else {
      clearPendingRecovery()
      const { error: nextError } = await sb.auth.signInWithPassword({ email, password })
      if (nextError) setError(nextError.message)
    }
    setLoading(false)
  }

  const signInWithProvider = async (provider) => {
    setError('')
    setSuccess('')
    setLoading(true)
    try {
      if (isNativeApp()) {
        await openNativeOAuth(provider)
        return
      }
      const { error: nextError } = await sb.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${getPublicBaseUrl()}/` },
      })
      if (nextError) {
        setError(nextError.message)
        setLoading(false)
      }
    } catch (nextError) {
      setError(nextError?.message || 'Sign-in failed')
      setLoading(false)
    }
  }

  const switchMode = (nextMode) => {
    if (forcedMode === 'recovery') return
    setMode(nextMode)
    setError('')
    setSuccess('')
  }

  const showForm = (nextMode) => {
    switchMode(nextMode)
    window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      formRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' })
    })
  }

  const focusedAuth = mode === 'recovery' || mode === 'forgot'
  const formHeading = mode === 'recovery'
    ? 'Choose a new password'
    : mode === 'forgot'
      ? 'Reset your password'
      : mode === 'register'
        ? 'Join DeckLoom'
        : 'Welcome back'
  const formSubheading = mode === 'recovery'
    ? 'Use at least eight characters.'
    : mode === 'forgot'
      ? 'We will email you a secure recovery link.'
      : mode === 'register'
        ? 'Every feature is free. No paywalls—donations are optional.'
        : 'Sign in to continue to your collection.'

  const authForm = (
    <form
      className={styles.formCard}
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className={styles.formHeading}>
        <h2>{formHeading}</h2>
        <p>{formSubheading}</p>
      </div>

      {(mode === 'login' || mode === 'register') && (
        <>
          <div className={styles.providerButtons}>
            <button
              type="button"
              className={styles.googleButton}
              onClick={() => signInWithProvider('google')}
              disabled={loading}
              aria-label="Sign in with Google"
            >
              <img src="/brand/google-signin.svg" alt="" />
            </button>
            <button
              type="button"
              className={styles.discordButton}
              onClick={() => signInWithProvider('discord')}
              disabled={loading}
            >
              <img src="/brand/discord-symbol.svg" alt="" />
              Continue with Discord
            </button>
          </div>
          <div className={styles.divider}><span>or use email</span></div>
          <div className={styles.tabs} role="group" aria-label="Account action">
            <button
              className={mode === 'login' ? styles.active : ''}
              type="button"
              aria-pressed={mode === 'login'}
              onClick={() => switchMode('login')}
            >Sign in</button>
            <button
              className={mode === 'register' ? styles.active : ''}
              type="button"
              aria-pressed={mode === 'register'}
              onClick={() => switchMode('register')}
            >Create account</button>
          </div>
        </>
      )}

      {mode !== 'recovery' && (
        <label className={styles.field} htmlFor="auth-email">
          <span>Email address</span>
          <input
            id="auth-email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoFocus={focusedAuth}
            required
          />
        </label>
      )}

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
          className={styles.visuallyHidden}
        />
      )}

      {mode !== 'forgot' && (
        <label className={styles.field} htmlFor="auth-password">
          <span>{mode === 'recovery' ? 'New password' : 'Password'}</span>
          <input
            id="auth-password"
            name={mode === 'recovery' ? 'new-password' : 'password'}
            type="password"
            autoComplete={mode === 'recovery' || mode === 'register' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus={mode === 'recovery'}
            minLength={mode === 'register' || mode === 'recovery' ? 8 : undefined}
            required
          />
        </label>
      )}

      {(mode === 'register' || mode === 'recovery') && (
        <label className={styles.field} htmlFor="auth-confirm-password">
          <span>Confirm password</span>
          <input
            id="auth-confirm-password"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            value={password2}
            onChange={(event) => setPassword2(event.target.value)}
            minLength={8}
            required
          />
        </label>
      )}

      {(mode === 'register' || mode === 'recovery') && (
        <p className={styles.fieldHint}>Use at least eight characters.</p>
      )}

      <button
        className={styles.submit}
        type="submit"
        disabled={
          loading
          || (!email && mode === 'forgot')
          || (!password && mode !== 'forgot')
          || (mode !== 'recovery' && mode !== 'forgot' && !email)
          || ((mode === 'register' || mode === 'recovery') && !password2)
        }
      >
        {loading
          ? 'Please wait…'
          : mode === 'recovery'
            ? 'Update password'
            : mode === 'forgot'
              ? 'Send reset email'
              : mode === 'register'
                ? 'Create account'
                : 'Sign in'}
      </button>

      {error && <div className={styles.error} role="alert">{error}</div>}
      {success && <div className={styles.success} role="status">{success}</div>}

      {mode === 'login' && (
        <button className={styles.resetLink} onClick={() => switchMode('forgot')} type="button">
          Forgot your password?
        </button>
      )}
      {mode === 'forgot' && (
        <button className={styles.resetLink} onClick={() => switchMode('login')} type="button">
          Back to sign in
        </button>
      )}

      {mode === 'register' ? (
        <p className={styles.formLegal}>
          By creating an account, you agree to the <Link to="/terms">Terms</Link> and acknowledge the <Link to="/privacy">Privacy Policy</Link>.
        </p>
      ) : (
        <div className={styles.formLinks}>
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/delete-account">Delete account</Link>
        </div>
      )}
    </form>
  )

  if (focusedAuth) {
    return (
      <main className={`${styles.page} ${styles.focusedPage}`}>
        <a className={styles.focusedBrand} href="/" aria-label="DeckLoom home"><Brand /></a>
        <div className={styles.focusedForm}>{authForm}</div>
      </main>
    )
  }

  return (
    <div className={styles.page} id="top">
      <div className={styles.artBackdrop} aria-hidden="true">
        {cardArt.slice(0, 4).map((card, index) => (
          <img key={card.name} src={card.artSrc || card.cardSrc} alt="" style={{ '--backdrop-index': index }} />
        ))}
      </div>
      <header className={styles.siteHeader}>
        <div className={styles.headerInner}>
          <a className={styles.brandLink} href="#top" aria-label="DeckLoom home"><Brand /></a>
          <nav className={styles.nav} aria-label="Homepage">
            <a href="#build-assist">Build Assist</a>
            <a href="#core-tools">Scanner & collection</a>
            <a href="#more">More tools</a>
            <button type="button" onClick={() => showForm('login')}>Sign in</button>
          </nav>
        </div>
      </header>

      <main>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow}><LightningIcon size={15} /> Build Assist for Commander</div>
            <h1 id="hero-title">Build your next Commander deck. <span>Instantly—or card by card.</span></h1>
            <p className={styles.heroLead}>
              Auto-build a complete deck in seconds, or take the guided path and choose every card yourself. Your scanner, collection, and deck builder finally live in one app.
            </p>

            <div className={styles.buildChoices}>
              <div>
                <LightningIcon size={18} />
                <span><strong>Auto Build</strong><small>From commander to a balanced 100-card list.</small></span>
              </div>
              <div>
                <TargetIcon size={18} />
                <span><strong>Guided Build</strong><small>Pick every role with collection-aware suggestions.</small></span>
              </div>
            </div>

            <div className={styles.heroActions}>
              <button className={styles.primaryCta} type="button" onClick={() => showForm('register')}>
                Start building <ChevronRightIcon size={16} />
              </button>
              <a className={styles.secondaryCta} href="#build-assist">Explore Build Assist</a>
            </div>
            <p className={styles.heroNote}>Every feature is free · No paywalls · Donations are optional</p>
          </div>
          <aside className={styles.heroForm} aria-label="DeckLoom account">{authForm}</aside>
        </section>

        <section className={styles.buildAssist} id="build-assist" aria-labelledby="build-assist-title">
          <div className={styles.buildAssistCopy}>
            <div className={styles.sectionLabel}><LightningIcon size={14} /> DeckLoom's standout feature</div>
            <h2 id="build-assist-title">One commander. Two ways to reach 100 cards.</h2>
            <p className={styles.sectionLead}>
              Build Assist connects the deck you want to make with the cards you already own. Take the fast route or stay in control of every decision.
            </p>

            <div className={styles.modePair}>
              <article>
                <span className={styles.modeIcon}><LightningIcon size={21} /></span>
                <div><h3>Auto Build</h3><p>Set your commander, theme, bracket, and budget. DeckLoom assembles the complete list and balances the mana base.</p></div>
              </article>
              <article>
                <span className={styles.modeIcon}><TargetIcon size={21} /></span>
                <div><h3>Guided Build</h3><p>Work role by role, compare owned and recommended cards, and approve every addition yourself.</p></div>
              </article>
            </div>

            <div className={styles.proofList}>
              {BUILD_ASSIST_PROOFS.map((proof) => (
                <span key={proof}><CheckIcon size={15} /> {proof}</span>
              ))}
            </div>

            <button className={styles.textCta} type="button" onClick={() => showForm('register')}>
              Build your first deck <ChevronRightIcon size={15} />
            </button>
          </div>
          <CardArtFan cards={cardArt.slice(0, 4)} />
        </section>

        <section className={styles.coreTools} id="core-tools" aria-labelledby="core-tools-title">
          <div className={styles.sectionHeader}>
            <div className={styles.sectionLabel}>From cards on the table to cards in your deck</div>
            <h2 id="core-tools-title">Scan it. Organise it. Build with it.</h2>
          </div>
          <div className={styles.coreGrid}>
            <article className={styles.coreFeature}>
              <span className={styles.coreIcon}><ScannerIcon size={26} /></span>
              <h3>Card Scanner</h3>
              <p>Point your phone at a card and add the exact printing without typing collector numbers by hand. Review matches, adjust quantity, and move straight into your collection.</p>
              <ul>
                <li><CheckIcon size={14} /> Camera-based exact-print matching</li>
                <li><CheckIcon size={14} /> Batch scanning and manual search</li>
                <li><CheckIcon size={14} /> Built into the same collection workflow</li>
              </ul>
            </article>
            <article className={styles.coreFeature}>
              <span className={styles.coreIcon}><CollectionIcon size={26} /></span>
              <h3>Collection Management</h3>
              <p>Track every owned copy across binders and decks, separate wishlists from inventory, and understand what your collection is worth without rebuilding it elsewhere.</p>
              <ul>
                <li><CheckIcon size={14} /> Binders, collection decks, and wishlists</li>
                <li><CheckIcon size={14} /> Exact printings, finishes, quantities, and locations</li>
                <li><CheckIcon size={14} /> Pricing, value history, and profit & loss</li>
              </ul>
            </article>
          </div>
        </section>

        <section className={styles.moreTools} id="more" aria-labelledby="more-title">
          <div className={styles.moreIntro}>
            <div className={styles.sectionLabel}>More than a deck builder</div>
            <h2 id="more-title">The rest of your Magic toolkit, in the same place.</h2>
            <p>DeckLoom keeps the supporting tools close without making you maintain the same cards and decks across separate apps.</p>
          </div>
          <div className={styles.moreGrid}>
            {SECONDARY_FEATURES.map(({ icon: Icon, title, body }) => (
              <article key={title}>
                <Icon size={19} />
                <div><h3>{title}</h3><p>{body}</p></div>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.finalCta} aria-labelledby="final-cta-title">
          <img src={BRAND_MARK} alt="" aria-hidden="true" />
          <div>
            <div className={styles.sectionLabel}>All your cards. All your decks. One app.</div>
            <h2 id="final-cta-title">Start with a commander. Let DeckLoom handle the rest.</h2>
          </div>
          <button className={styles.primaryCta} type="button" onClick={() => showForm('register')}>
            Create account <ChevronRightIcon size={16} />
          </button>
        </section>
      </main>

      <footer className={styles.footer}>
        <Brand compact />
        <p>Deck building, scanning, collection management, and play tools for Magic: The Gathering.</p>
        <nav aria-label="Legal">
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/storage">Storage</Link>
          <Link to="/credits">Credits</Link>
        </nav>
      </footer>
    </div>
  )
}
