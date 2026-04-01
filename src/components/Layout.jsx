import { useState, useEffect } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import FeedbackModal from './FeedbackModal'
import styles from './Layout.module.css'

const TABS = [
  { to: '/', label: 'Home' },
  { to: '/collection', label: 'Collection' },
  { to: '/decks', label: 'Decks' },
  { to: '/builder', label: 'Builder' },
  { to: '/binders', label: 'Binders' },
  { to: '/lists', label: 'Wishlists' },
  { to: '/trading', label: 'Trading' },
  { to: '/stats', label: 'Stats' },
  { to: '/life', label: 'Life' },
  { to: '/tournaments', label: 'Tournaments' },
  { to: '/scanner', label: 'Scanner' },
]

export default function Layout({ children }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const isNative = Capacitor.isNativePlatform()
  const isScannerRoute = location.pathname === '/scanner'
  const [menuOpen, setMenuOpen] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    document.body.style.overflow = (menuOpen || isScannerRoute) ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [menuOpen, isScannerRoute])

  useEffect(() => {
    if (!isNative || !isScannerRoute) return

    const html = document.documentElement
    const body = document.body
    const root = document.getElementById('root')
    const prevHtmlBg = html.style.background
    const prevBodyBg = body.style.background
    const prevRootBg = root?.style.background ?? ''

    html.style.background = 'transparent'
    body.style.background = 'transparent'
    if (root) root.style.background = 'transparent'

    return () => {
      html.style.background = prevHtmlBg
      body.style.background = prevBodyBg
      if (root) root.style.background = prevRootBg
    }
  }, [isNative, isScannerRoute])

  const signOut = async () => {
    await sb.auth.signOut()
    navigate('/')
  }

  return (
    <div className={`${styles.app} ${isScannerRoute ? styles.appScanner : ''}`}>
      {!isScannerRoute && (
        <>
          <header className={styles.header}>
            <div className={styles.headerTop}>
              <div className={styles.logo}>ARCANE<span>VAULT</span></div>

              <div className={styles.userBar}>
                <span className={styles.userName}>{user?.email}</span>
                <button
                  className={styles.feedbackBtn}
                  onClick={() => setShowFeedback(true)}
                  title="Report a bug or request a feature"
                >
                  Bug
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

          {menuOpen && <div className={styles.mobileOverlay} onClick={() => setMenuOpen(false)} />}

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
                Bug / Feature Request
              </button>
              <button className={styles.mobileSignOut} onClick={signOut}>Sign out</button>
            </div>
          </div>
        </>
      )}

      <main className={`${styles.main} ${isScannerRoute ? styles.mainScanner : ''}`}>
        {children}
      </main>

      {showFeedback && !isScannerRoute && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </div>
  )
}
