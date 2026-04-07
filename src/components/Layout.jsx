import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import { maskEmailAddress, useSettings } from './SettingsContext'
import FeedbackModal from './FeedbackModal'
import styles from './Layout.module.css'

const TABS = [
  { to: '/', label: 'Home' },
  { to: '/collection', label: 'Collection' },
  { to: '/decks', label: 'Decks' },
  { to: '/builder', label: 'Deckbuilder' },
  { to: '/binders', label: 'Binders' },
  { to: '/lists', label: 'Wishlists' },
  { to: '/trading', label: 'Trading' },
  { to: '/stats', label: 'Stats' },
  { to: '/life', label: 'Life' },
  { to: '/scanner', label: 'Scanner' },
]

export default function Layout({ children }) {
  const { user } = useAuth()
  const { keep_screen_awake } = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  const isNative = Capacitor.isNativePlatform()
  const isScannerRoute = location.pathname === '/scanner'
  const isNativeScannerRoute = isNative && isScannerRoute
  const [menuOpen, setMenuOpen] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)

  const backPressedRef = useRef(false)
  const backTimerRef = useRef(null)

  useEffect(() => {
    if (!isNative) return
    let listener
    const register = async () => {
      listener = await CapApp.addListener('backButton', async () => {
        if (menuOpen) { setMenuOpen(false); return }
        if (location.pathname !== '/') { navigate('/'); return }
        if (backPressedRef.current) {
          backPressedRef.current = false
          clearTimeout(backTimerRef.current)
          try {
            await CapApp.exitApp()
          } catch {
            await CapApp.minimizeApp().catch(() => {})
          }
          setTimeout(() => {
            CapApp.minimizeApp().catch(() => {})
          }, 150)
          return
        }
        backPressedRef.current = true
        clearTimeout(backTimerRef.current)
        backTimerRef.current = setTimeout(() => { backPressedRef.current = false }, 2000)
      })
    }
    register()
    return () => { listener?.remove(); clearTimeout(backTimerRef.current) }
  }, [isNative, menuOpen, location.pathname, navigate])

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    document.body.style.overflow = (menuOpen || isNativeScannerRoute) ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [menuOpen, isNativeScannerRoute])

  useLayoutEffect(() => {
    if (!isNativeScannerRoute) return
    const html = document.documentElement
    const body = document.body
    const root = document.getElementById('root')
    html.setAttribute('data-scanner', 'true')
    // Belt-and-suspenders: inline styles guarantee transparency even if
    // CSS rules are slow to evaluate or a re-render briefly invalidates them.
    for (const el of [html, body, root]) {
      if (!el) continue
      el.style.setProperty('background', 'transparent', 'important')
      el.style.setProperty('background-image', 'none', 'important')
    }
    return () => {
      html.removeAttribute('data-scanner')
      for (const el of [html, body, root]) {
        if (!el) continue
        el.style.removeProperty('background')
        el.style.removeProperty('background-image')
      }
    }
  }, [isNativeScannerRoute])

  useEffect(() => {
    if (!keep_screen_awake || !('wakeLock' in navigator)) return

    let released = false
    let wakeLock = null

    const requestWakeLock = async () => {
      if (released || document.visibilityState !== 'visible') return
      try {
        wakeLock = await navigator.wakeLock.request('screen')
        wakeLock?.addEventListener?.('release', () => {
          if (!released) wakeLock = null
        })
      } catch {}
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock()
    }

    requestWakeLock()
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      released = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      wakeLock?.release?.().catch(() => {})
    }
  }, [keep_screen_awake])

  const signOut = async () => {
    await sb.auth.signOut()
    navigate('/')
  }

  const displayEmail = maskEmailAddress(user?.email, true)

  return (
    <div className={`${styles.app} ${isNativeScannerRoute ? styles.appScanner : ''}`}>
      {!isNativeScannerRoute && (
        <>
          <header className={styles.header}>
            <div className={styles.headerTop}>
              <div className={styles.logo}>ARCANE<span>VAULT</span></div>

              <div className={styles.userBar}>
                <span className={styles.userName}>{displayEmail}</span>
                <button
                  className={styles.feedbackBtn}
                  onClick={() => setShowFeedback(true)}
                  title="Report a bug or request a feature"
                >
                  <span className={styles.feedbackIcon}>🐞</span>
                  <span>Bug</span>
                </button>
                <NavLink
                  to="/settings"
                  className={({ isActive }) => `${styles.settingsLink}${isActive ? ' ' + styles.settingsActive : ''}`}
                  title="Settings"
                >
                  ⚙
                </NavLink>
                <button className={styles.signOut} onClick={signOut}>Sign out</button>
              </div>

              <button
                className={styles.hamburger}
                onClick={() => setMenuOpen(v => !v)}
                aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              >
                {menuOpen ? '✕' : '☰'}
              </button>
            </div>

            <nav className={styles.tabs}>
              {TABS.map(t => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  end={t.to === '/'}
                  className={({ isActive }) => `${styles.tab}${isActive ? ' ' + styles.active : ''}`}
                >
                  {t.label}
                </NavLink>
              ))}
            </nav>
          </header>

          <div className={`${styles.mobileOverlay}${menuOpen ? ` ${styles.mobileOverlayOpen}` : ''}`} onClick={() => setMenuOpen(false)} />

          <div className={`${styles.mobileNav} ${menuOpen ? styles.mobileNavOpen : ''}`}>
            <div className={styles.mobileNavLogo}>ARCANE<span>VAULT</span></div>
            {TABS.map(t => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.to === '/'}
                className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                onClick={() => setMenuOpen(false)}
              >
                {t.label}
              </NavLink>
            ))}
            <div className={styles.mobileNavFooter}>
              <NavLink
                to="/settings"
                className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                onClick={() => setMenuOpen(false)}
              >
                Settings
              </NavLink>
              <button
                className={styles.mobileNavLink}
                onClick={() => { setMenuOpen(false); setShowFeedback(true) }}
                style={{ background: 'none', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer' }}
              >
                <span className={styles.mobileNavIcon}>🐞</span>
                <span>Bug / Feature Request</span>
              </button>
              <button className={styles.mobileSignOut} onClick={signOut}>Sign out</button>
            </div>
          </div>
        </>
      )}

      <main className={`${styles.main} ${isNativeScannerRoute ? styles.mainScanner : ''}`}>
        {children}
      </main>

      {showFeedback && !isNativeScannerRoute && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </div>
  )
}
