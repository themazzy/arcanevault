import { NavLink, useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import styles from './Layout.module.css'

const TABS = [
  { to: '/',         label: 'Collection' },
  { to: '/decks',    label: 'Decks' },
  { to: '/binders',  label: 'Binders' },
  { to: '/lists',    label: 'Wishlists' },
  { to: '/stats',    label: 'Stats' },
]

export default function Layout({ children }) {
  const { user } = useAuth()
  const navigate = useNavigate()

  const signOut = async () => {
    await sb.auth.signOut()
    navigate('/')
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.logo}>ARCANE<span>VAULT</span></div>
          <div className={styles.userBar}>
            <span className={styles.userName}>{user?.email}</span>
            <NavLink
              to="/settings"
              className={({ isActive }) => `${styles.settingsLink}${isActive ? ' ' + styles.settingsActive : ''}`}
              title="Settings"
            >
              ⚙
            </NavLink>
            <button className={styles.signOut} onClick={signOut}>Sign out</button>
          </div>
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
      <main className={styles.main}>
        {children}
      </main>
    </div>
  )
}
