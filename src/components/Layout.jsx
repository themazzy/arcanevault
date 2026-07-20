import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import { maskEmailAddress, useSettings } from './SettingsContext'
import FeedbackModal from './FeedbackModal'
import FeedbackNudge from './FeedbackNudge'
import NotificationBell from './community/NotificationBell'
import ActivityStatusBadge from './ActivityStatusBadge'
import BRAND_MARK from '../icons/DeckLoom_logo.png'
import styles from './Layout.module.css'
import {
  HomeIcon, CollectionIcon, DecksIcon, BuilderIcon, BindersIcon,
  WishlistsIcon, TradingIcon, StatsIcon, LifeIcon, ScannerIcon,
  SettingsIcon, MenuIcon, CloseIcon, BugIcon, InfoIcon, PlayerIcon,
  ChevronDownIcon, ListViewIcon, TextViewIcon,
} from '../icons'

const TABS = [
  { to: '/', label: 'Home',         Icon: HomeIcon },
  { to: '/collection', label: 'My Collection', Icon: CollectionIcon },
  { to: '/decks', label: 'My Decks',    Icon: DecksIcon },
  { to: '/builder', label: 'Deck Builder', Icon: BuilderIcon },
  { to: '/binders', label: 'My Binders',     Icon: BindersIcon },
  { to: '/lists', label: 'Wishlists',   Icon: WishlistsIcon },
  { to: '/trading', label: 'Trading',     Icon: TradingIcon },
  { to: '/life', label: 'Life Tracker',        Icon: LifeIcon },
  { to: '/stats', label: 'Stats',       Icon: StatsIcon },
  { to: '/scanner', label: 'Scanner',    Icon: ScannerIcon },
]

const COLLECTION_NAV = TABS.filter(t => ['/collection', '/decks', '/binders', '/lists'].includes(t.to))
const DESKTOP_TABS = TABS.filter(t => !['/', '/collection', '/decks', '/binders', '/builder', '/scanner', '/trading', '/stats', '/lists'].includes(t.to))

export default function Layout({ children }) {
  const { user } = useAuth()
  const { keep_screen_awake, premium, nickname } = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  const isNative = Capacitor.isNativePlatform()
  const isScannerRoute = location.pathname === '/scanner'
  const isDeckBuilderRoute = /^\/builder\/[^/]+/.test(location.pathname)
  const isNativeScannerRoute = isNative && isScannerRoute
  const [menuOpen, setMenuOpen] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedbackType, setFeedbackType] = useState('bug')
  const openFeedback = (type = 'bug') => { setFeedbackType(type); setShowFeedback(true) }
  const [scrolled, setScrolled] = useState(false)

  const backPressedRef = useRef(false)
  const backTimerRef = useRef(null)
  const mainRef = useRef(null)

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

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const onScroll = () => setScrolled(el.scrollTop > 30)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (isNative) {
      document.documentElement.setAttribute('data-native', 'true')
      return () => document.documentElement.removeAttribute('data-native')
    }
  }, [isNative])

  const signOut = async () => {
    await sb.auth.signOut()
    navigate('/')
  }

  const releaseMenuFocus = e => {
    e.currentTarget.blur?.()
  }

  const displayEmail = maskEmailAddress(user?.email, true)
  const accountLabel = nickname || displayEmail || 'Account'
  const profilePath = nickname ? `/profile/${encodeURIComponent(nickname)}` : '/settings'
  const collectionNavActive = COLLECTION_NAV.some(t => (
    t.to === '/collection'
      ? location.pathname === t.to
      : location.pathname === t.to || location.pathname.startsWith(`${t.to}/`)
  ))
  const isDeckBrowserRoute = location.pathname === '/builder' && new URLSearchParams(location.search).get('tab') === 'browser'
  const isDeckBuilderSection = location.pathname === '/builder' || /^\/builder\/[^/]+/.test(location.pathname)

  const currentMobileGroup = (() => {
    const p = location.pathname
    if (p === '/collection' || p === '/decks' || p === '/binders' || p === '/lists') return 'collection'
    return null
  })()
  const [openMobileGroup, setOpenMobileGroup] = useState(currentMobileGroup)
  useEffect(() => { setOpenMobileGroup(currentMobileGroup) }, [currentMobileGroup])
  const toggleMobileGroup = key => setOpenMobileGroup(prev => prev === key ? null : key)
  const closeMobile = () => setMenuOpen(false)

  const mobileCollectionItems = [
    { to: '/collection', label: 'My Collection', Icon: CollectionIcon, end: true },
    { to: '/decks', label: 'My Decks', Icon: DecksIcon },
    { to: '/binders', label: 'My Binders', Icon: BindersIcon },
    { to: '/lists', label: 'Wishlists', Icon: WishlistsIcon },
  ]

  const renderMobileGroup = (key, label, Icon, items, isGroupActive) => {
    const isOpen = openMobileGroup === key
    return (
      <div key={key} className={styles.mobileNavGroup}>
        <button
          type="button"
          className={`${styles.mobileNavLink} ${styles.mobileNavGroupHeader}${isGroupActive ? ' ' + styles.mobileNavLinkActive : ''}`}
          onClick={() => toggleMobileGroup(key)}
          aria-expanded={isOpen}
        >
          <Icon size={17} />
          <span className={styles.mobileNavGroupLabel}>{label}</span>
          <ChevronDownIcon
            size={12}
            className={`${styles.mobileNavGroupCaret}${isOpen ? ' ' + styles.mobileNavGroupCaretOpen : ''}`}
          />
        </button>
        {isOpen && (
          <div className={styles.mobileNavGroupItems}>
            {items.map(it => (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end}
                className={({ isActive }) => `${styles.mobileNavLink} ${styles.mobileNavSubLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                onClick={closeMobile}
              >
                <it.Icon size={15} />
                {it.label}
              </NavLink>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`${styles.app} ${isNativeScannerRoute ? styles.appScanner : ''}`}>
      {!isNativeScannerRoute && (
        <>
          <div className={`${styles.headerWrap}${scrolled ? ' ' + styles.scrolled : ''}`}>
            <header className={styles.header}>
              <NavLink to="/" end className={styles.logo} aria-label="DeckLoom home">
                <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
                <span className={styles.logoText}>Deck<span>Loom</span></span>
              </NavLink>

              <nav className={styles.tabs}>
                <div
                  className={styles.navMenuWrap}
                >
                  <NavLink
                    to="/collection"
                    end
                    className={`${styles.tab} ${styles.navMenuButton}${collectionNavActive ? ` ${styles.active}` : ''}`}
                    onClick={releaseMenuFocus}
                  >
                    <CollectionIcon size={12} />
                    My Collection
                    <ChevronDownIcon size={10} className={styles.navMenuCaret} />
                  </NavLink>
                  <div className={styles.navSubmenu} role="menu">
                    {COLLECTION_NAV.map(t => (
                      <NavLink
                        key={t.to}
                        to={t.to}
                        end={t.to === '/collection'}
                        role="menuitem"
                        className={({ isActive }) => `${styles.navSubmenuItem}${isActive ? ' ' + styles.navSubmenuItemActive : ''}`}
                        onClick={releaseMenuFocus}
                      >
                        <t.Icon size={14} />
                        {t.label}
                      </NavLink>
                    ))}
                  </div>
                </div>
                <NavLink
                  to="/builder"
                  end
                  className={() => `${styles.tab}${isDeckBuilderSection && !isDeckBrowserRoute ? ' ' + styles.active : ''}`}
                >
                  <BuilderIcon size={12} />
                  Deck Builder
                </NavLink>
                <NavLink
                  to="/builder?tab=browser"
                  className={() => `${styles.tab}${isDeckBrowserRoute ? ' ' + styles.active : ''}`}
                >
                  <ListViewIcon size={12} />
                  Deck Browser
                </NavLink>
                <NavLink
                  to="/trading"
                  className={({ isActive }) => `${styles.tab}${isActive ? ' ' + styles.active : ''}`}
                >
                  <TradingIcon size={12} />
                  Trading
                </NavLink>
                {DESKTOP_TABS.filter(t => t.to !== '/').map(t => (
                  <NavLink
                    key={t.to}
                    to={t.to}
                    end={t.to === '/'}
                    className={({ isActive }) => {
                      return `${styles.tab}${isActive ? ' ' + styles.active : ''}`
                    }}
                  >
                    <t.Icon size={12} />
                    {t.label}
                  </NavLink>
                ))}
              </nav>

              <div className={styles.spacer} />

              <div className={styles.navUtilities}>
                <span className={styles.utilityDivider} aria-hidden="true" />
                {user && <span className={styles.bellSlot}><NotificationBell /></span>}

                <div
                  className={`${styles.userBar} ${styles.accountMenuWrap}`}
                >
                  <NavLink
                    to={profilePath}
                    className={styles.accountButton}
                    onClick={releaseMenuFocus}
                    title={accountLabel}
                  >
                    <PlayerIcon size={13} />
                    <span className={styles.userNameInner}>
                      <span className={styles.userNick}>{accountLabel}</span>
                      {premium && <span className={styles.supporterLabel}>supporter</span>}
                    </span>
                    <ChevronDownIcon size={10} className={styles.navMenuCaret} />
                  </NavLink>
                  <div className={`${styles.navSubmenu} ${styles.accountSubmenu}`} role="menu">
                  <NavLink
                    to={profilePath}
                    role="menuitem"
                    className={({ isActive }) => `${styles.navSubmenuItem}${isActive ? ' ' + styles.navSubmenuItemActive : ''}`}
                    onClick={releaseMenuFocus}
                  >
                    <PlayerIcon size={14} />
                    Profile
                  </NavLink>
                  <NavLink
                    to="/stats"
                    role="menuitem"
                    className={({ isActive }) => `${styles.navSubmenuItem}${isActive ? ' ' + styles.navSubmenuItemActive : ''}`}
                    onClick={releaseMenuFocus}
                  >
                    <StatsIcon size={14} />
                    Stats
                  </NavLink>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.navSubmenuItem}
                    onClick={e => { releaseMenuFocus(e); openFeedback('bug') }}
                  >
                    <BugIcon size={14} />
                    Bug / Feature Request
                  </button>
                  <NavLink
                    to="/rules"
                    role="menuitem"
                    className={({ isActive }) => `${styles.navSubmenuItem}${isActive ? ' ' + styles.navSubmenuItemActive : ''}`}
                    onClick={releaseMenuFocus}
                  >
                    <TextViewIcon size={14} />
                    Rulebook
                  </NavLink>
                  <NavLink
                    to="/help"
                    role="menuitem"
                    className={({ isActive }) => `${styles.navSubmenuItem}${isActive ? ' ' + styles.navSubmenuItemActive : ''}`}
                    onClick={releaseMenuFocus}
                  >
                    <InfoIcon size={14} />
                    Help
                  </NavLink>
                  {!premium && (
                    <NavLink
                      to="/settings#support"
                      role="menuitem"
                      className={({ isActive }) => `${styles.navSubmenuItem} ${styles.navSubmenuSupportItem}${isActive ? ' ' + styles.navSubmenuItemActive : ''}`}
                      onClick={releaseMenuFocus}
                    >
                      <StatsIcon size={14} />
                      Support DeckLoom
                    </NavLink>
                  )}
                  <NavLink
                    to="/settings"
                    role="menuitem"
                    className={({ isActive }) => `${styles.navSubmenuItem}${isActive ? ' ' + styles.navSubmenuItemActive : ''}`}
                    onClick={releaseMenuFocus}
                  >
                    <SettingsIcon size={14} />
                    Settings
                  </NavLink>
                  <button
                    type="button"
                    role="menuitem"
                    className={`${styles.navSubmenuItem} ${styles.accountSignOutItem}`}
                    onClick={e => { releaseMenuFocus(e); signOut() }}
                  >
                    <CloseIcon size={14} />
                    Sign out
                  </button>
                  </div>
                </div>
              </div>

              <button
                className={styles.hamburger}
                onClick={() => setMenuOpen(v => !v)}
                aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              >
                {menuOpen ? <CloseIcon size={20} /> : <MenuIcon size={22} />}
              </button>
            </header>
          </div>

          <div className={`${styles.mobileOverlay}${menuOpen ? ` ${styles.mobileOverlayOpen}` : ''}`} onClick={() => setMenuOpen(false)} />

          <div className={`${styles.mobileNav} ${menuOpen ? styles.mobileNavOpen : ''}`}>
            <NavLink to="/" end className={styles.mobileNavLogo} onClick={closeMobile} aria-label="DeckLoom home">
              <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
              <span className={styles.logoText}>Deck<span>Loom</span></span>
            </NavLink>
            {renderMobileGroup('collection', 'My Collection', CollectionIcon, mobileCollectionItems, currentMobileGroup === 'collection')}
            <NavLink
              to="/builder"
              end
              className={() => `${styles.mobileNavLink}${isDeckBuilderSection && !isDeckBrowserRoute ? ' ' + styles.mobileNavLinkActive : ''}`}
              onClick={closeMobile}
            >
              <BuilderIcon size={17} />
              Deck Builder
            </NavLink>
            <NavLink
              to="/builder?tab=browser"
              className={() => `${styles.mobileNavLink}${isDeckBrowserRoute ? ' ' + styles.mobileNavLinkActive : ''}`}
              onClick={closeMobile}
            >
              <ListViewIcon size={17} />
              Deck Browser
            </NavLink>
            <NavLink
              to="/trading"
              className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
              onClick={closeMobile}
            >
              <TradingIcon size={17} />
              Trading
            </NavLink>
            <NavLink
              to="/life"
              className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
              onClick={closeMobile}
            >
              <LifeIcon size={17} />
              Life Tracker
            </NavLink>
            <NavLink
              to="/scanner"
              className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
              onClick={closeMobile}
            >
              <ScannerIcon size={17} />
              Scanner
            </NavLink>
            <div className={styles.mobileNavFooter}>
              <NavLink
                to={profilePath}
                className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                onClick={closeMobile}
              >
                <PlayerIcon size={17} />
                Profile
              </NavLink>
              <NavLink
                to="/stats"
                className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                onClick={closeMobile}
              >
                <StatsIcon size={17} />
                Stats
              </NavLink>
              <button
                className={styles.mobileNavLink}
                onClick={() => { setMenuOpen(false); openFeedback('bug') }}
                style={{ background: 'none', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer' }}
              >
                <span className={styles.mobileNavIcon}><BugIcon size={17} /></span>
                <span>Bug / Feature Request</span>
              </button>
              <NavLink
                to="/rules"
                className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                onClick={closeMobile}
              >
                <TextViewIcon size={17} />
                Rulebook
              </NavLink>
              <NavLink
                to="/help"
                className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                onClick={closeMobile}
              >
                <InfoIcon size={17} />
                Help
              </NavLink>
              {!premium && (
                <NavLink
                  to="/settings#support"
                  className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                  onClick={closeMobile}
                >
                  <StatsIcon size={17} />
                  Support DeckLoom
                </NavLink>
              )}
              <NavLink
                to="/settings"
                className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                onClick={closeMobile}
              >
                <SettingsIcon size={17} />
                Settings
              </NavLink>
              <button className={styles.mobileSignOut} onClick={signOut}>Sign out</button>
            </div>
          </div>
        </>
      )}

      <main ref={mainRef} className={`${styles.main} ${isNativeScannerRoute ? styles.mainScanner : ''} ${isDeckBuilderRoute ? styles.mainDeckBuilder : ''}`}>
        {children}
      </main>

      {user && <ActivityStatusBadge />}
      {user && !showFeedback && !isNativeScannerRoute && (
        <FeedbackNudge onOpenFeedback={() => openFeedback('feature')} />
      )}
      {showFeedback && !isNativeScannerRoute && (
        <FeedbackModal initialType={feedbackType} onClose={() => setShowFeedback(false)} />
      )}
    </div>
  )
}
