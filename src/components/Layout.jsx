import { useState, useEffect } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import FeedbackModal from './FeedbackModal'
import styles from './Layout.module.css'

const TABS = [
  { to: '/',            label: '⌂ Home' },
  { to: '/collection',  label: 'Collection' },
  { to: '/decks',       label: 'Decks' },
  { to: '/builder',     label: '⚔ Builder' },
  { to: '/binders',     label: 'Binders' },
  { to: '/lists',       label: 'Wishlists' },
  { to: '/stats',       label: 'Stats' },
  { to: '/life',        label: '♥ Life' },
  { to: '/tournaments', label: 'Tournaments' },
]

export default function Layout({ children }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [menuOpen,    setMenuOpen]    = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)

  // Close menu on navigation
  useEffect(() => { setMenuOpen(false) }, [location.pathname])

  // Prevent body scroll when menu is open
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [menuOpen])

  const signOut = async () => {
    await sb.auth.signOut()
    navigate('/')
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.logo}>ARCANE<span>VAULT</span></div>

          {/* Desktop user bar */}
          <div className={styles.userBar}>
            <span className={styles.userName}>{user?.email}</span>
            <button
              className={styles.feedbackBtn}
              onClick={() => setShowFeedback(true)}
              title="Report a bug or request a feature"
            >
              🐛
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

          {/* Mobile hamburger */}
          <button
            className={styles.hamburger}
            onClick={() => setMenuOpen(v => !v)}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          >
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>

        {/* Desktop nav tabs */}
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

      {/* Mobile overlay */}
      {menuOpen && <div className={styles.mobileOverlay} onClick={() => setMenuOpen(false)} />}

      {/* Mobile nav drawer */}
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
            ⚙ Settings
          </NavLink>
          <button
            className={styles.mobileNavLink}
            onClick={() => { setMenuOpen(false); setShowFeedback(true) }}
            style={{ background: 'none', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer' }}
          >
            🐛 Bug / Feature Request
          </button>
          <button className={styles.mobileSignOut} onClick={signOut}>Sign out</button>
        </div>
      </div>

      <main className={styles.main}>
        {children}
      </main>

      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </div>
  )
}
