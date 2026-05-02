import { Fragment, useState, useEffect, useLayoutEffect, useRef } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import { maskEmailAddress, useSettings } from './SettingsContext'
import FeedbackModal from './FeedbackModal'
import PageTips from './PageTips'
import BRAND_MARK from '../icons/DeckLoom_logo.png'
import styles from './Layout.module.css'
import {
  HomeIcon, CollectionIcon, DecksIcon, BuilderIcon, BindersIcon,
  WishlistsIcon, TradingIcon, StatsIcon, LifeIcon, ScannerIcon,
  SettingsIcon, MenuIcon, CloseIcon, BugIcon, InfoIcon, PlayerIcon,
  ChevronDownIcon, ListViewIcon,
} from '../icons'

const TABS = [
  { to: '/', label: 'Home',         Icon: HomeIcon },
  { to: '/collection', label: 'Collection', Icon: CollectionIcon },
  { to: '/decks', label: 'Decks',         Icon: DecksIcon },
  { to: '/builder', label: 'Deck Builder', Icon: BuilderIcon },
  { to: '/binders', label: 'Binders',     Icon: BindersIcon },
  { to: '/lists', label: 'Wishlists',   Icon: WishlistsIcon },
  { to: '/trading', label: 'Trading',     Icon: TradingIcon },
  { to: '/life', label: 'Life Tracker',        Icon: LifeIcon },
  { to: '/stats', label: 'Stats',       Icon: StatsIcon },
  { to: '/scanner', label: 'Scanner',    Icon: ScannerIcon },
]

const COLLECTION_NAV = TABS.filter(t => ['/collection', '/decks', '/binders'].includes(t.to))
const DESKTOP_TABS = TABS.filter(t => !['/', '/collection', '/decks', '/binders', '/builder', '/scanner', '/trading', '/stats'].includes(t.to))
const BUILDER_NAV = [
  { to: '/builder', label: 'Deck Builder', Icon: BuilderIcon, end: true },
  { to: '/builder?tab=browser', label: 'Deck Browser', Icon: ListViewIcon },
]
const TRADING_NAV = [
  { to: '/trading', label: 'Trading', Icon: TradingIcon, end: true },
  { to: '/trading?tab=log', label: 'Trade Log', Icon: ListViewIcon },
]
const STATS_NAV = [
  { to: '/stats', label: 'Stats', Icon: StatsIcon, end: true },
  { to: '/stats?tab=winrates', label: 'Deck Win Rates', Icon: DecksIcon },
  { to: '/stats?tab=history', label: 'Game History', Icon: ListViewIcon },
]

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
  const homeNav = [
    { to: '/', label: 'Home', Icon: HomeIcon, end: true },
    { to: '/rules', label: 'Rulebook', Icon: InfoIcon },
    { to: profilePath, label: 'Profile', Icon: PlayerIcon },
  ]
  const homeNavActive = location.pathname === '/' || location.pathname === '/rules' || location.pathname.startsWith('/profile/')
  const collectionNavActive = COLLECTION_NAV.some(t => (
    t.to === '/collection'
      ? location.pathname === t.to
      : location.pathname === t.to || location.pathname.startsWith(`${t.to}/`)
  ))
  const isTradeLogRoute = location.pathname === '/trading' && new URLSearchParams(location.search).get('tab') === 'log'
  const statsTab = location.pathname === '/stats' ? new URLSearchParams(location.search).get('tab') : null
  const isDeckBrowserRoute = location.pathname === '/builder' && new URLSearchParams(location.search).get('tab') === 'browser'
  const isDeckBuilderSection = location.pathname === '/builder' || /^\/builder\/[^/]+/.test(location.pathname)

  return (
    <div className={`${styles.app} ${isNativeScannerRoute ? styles.appScanner : ''}`}>
      {!isNativeScannerRoute && (
        <>
          <div className={`${styles.headerWrap}${scrolled ? ' ' + styles.scrolled : ''}`}>
            <header className={styles.header}>
              <div className={styles.logo}>
                <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
                <span className={styles.logoText}>Deck<span>Loom</span></span>
              </div>

              <nav className={styles.tabs}>
                <div
                  className={styles.navMenuWrap}
                >
                  <NavLink
                    to="/"
                    end
                    className={`${styles.tab} ${styles.navMenuButton}${homeNavActive ? ` ${styles.active}` : ''}`}
                    onClick={releaseMenuFocus}
                  >
                    <HomeIcon size={12} />
                    Home
                    <ChevronDownIcon size={10} className={styles.navMenuCaret} />
                  </NavLink>
                  <div className={styles.navSubmenu} role="menu">
                    {homeNav.map(t => (
                      <NavLink
                        key={`${t.label}-${t.to}`}
                        to={t.to}
                        end={t.end}
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
                    Collection
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
                <div className={styles.navMenuWrap}>
                  <NavLink
                    to="/builder"
                    end
                    className={`${styles.tab} ${styles.navMenuButton}${isDeckBuilderSection ? ` ${styles.active}` : ''}`}
                    onClick={releaseMenuFocus}
                  >
                    <BuilderIcon size={12} />
                    Deck Builder
                    <ChevronDownIcon size={10} className={styles.navMenuCaret} />
                  </NavLink>
                  <div className={styles.navSubmenu} role="menu">
                    {BUILDER_NAV.map(t => {
                      const isBuilderHome = t.to === '/builder'
                      const isActive = isBuilderHome
                        ? isDeckBuilderSection && !isDeckBrowserRoute
                        : isDeckBrowserRoute
                      return (
                        <NavLink
                          key={t.to}
                          to={t.to}
                          end={t.end}
                          role="menuitem"
                          className={`${styles.navSubmenuItem}${isActive ? ' ' + styles.navSubmenuItemActive : ''}`}
                          onClick={releaseMenuFocus}
                        >
                          <t.Icon size={14} />
                          {t.label}
                        </NavLink>
                      )
                    })}
                  </div>
                </div>
                <div className={styles.navMenuWrap}>
                  <NavLink
                    to="/trading"
                    end
                    className={`${styles.tab} ${styles.navMenuButton}${location.pathname.startsWith('/trading') ? ` ${styles.active}` : ''}`}
                    onClick={releaseMenuFocus}
                  >
                    <TradingIcon size={12} />
                    Trading
                    <ChevronDownIcon size={10} className={styles.navMenuCaret} />
                  </NavLink>
                  <div className={styles.navSubmenu} role="menu">
                    {TRADING_NAV.map(t => {
                      const isTradingHome = t.to === '/trading'
                      const isActive = location.pathname === '/trading' && (isTradingHome ? !isTradeLogRoute : isTradeLogRoute)
                      return (
                      <NavLink
                        key={t.to}
                        to={t.to}
                        end={t.end}
                        role="menuitem"
                        className={`${styles.navSubmenuItem}${isActive ? ' ' + styles.navSubmenuItemActive : ''}`}
                        onClick={releaseMenuFocus}
                      >
                        <t.Icon size={14} />
                        {t.label}
                      </NavLink>
                      )
                    })}
                  </div>
                </div>
                <div className={styles.navMenuWrap}>
                  <NavLink
                    to="/stats"
                    end
                    className={`${styles.tab} ${styles.navMenuButton}${location.pathname.startsWith('/stats') ? ` ${styles.active}` : ''}`}
                    onClick={releaseMenuFocus}
                  >
                    <StatsIcon size={12} />
                    Stats
                    <ChevronDownIcon size={10} className={styles.navMenuCaret} />
                  </NavLink>
                  <div className={styles.navSubmenu} role="menu">
                    {STATS_NAV.map(t => {
                      const tabParam = t.to.includes('?') ? new URLSearchParams(t.to.split('?')[1]).get('tab') : null
                      const isActive = location.pathname === '/stats' && (tabParam ? statsTab === tabParam : !statsTab)
                      return (
                        <NavLink
                          key={t.to}
                          to={t.to}
                          end={t.end}
                          role="menuitem"
                          className={`${styles.navSubmenuItem}${isActive ? ' ' + styles.navSubmenuItemActive : ''}`}
                          onClick={releaseMenuFocus}
                        >
                          <t.Icon size={14} />
                          {t.label}
                        </NavLink>
                      )
                    })}
                  </div>
                </div>
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

              <NavLink
                to="/scanner"
                className={({ isActive }) => `${styles.scanBtn}${isActive ? ' ' + styles.scanBtnActive : ''}`}
              >
                <ScannerIcon size={13} />Scan
              </NavLink>

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
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.navSubmenuItem}
                    onClick={e => { releaseMenuFocus(e); setShowFeedback(true) }}
                  >
                    <BugIcon size={14} />
                    Bug / Feature Request
                  </button>
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
            <div className={styles.mobileNavLogo}>
              <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
              <span className={styles.logoText}>Deck<span>Loom</span></span>
            </div>
            {TABS.map(t => (
              <Fragment key={t.to}>
                <NavLink
                  to={t.to}
                  end={t.to === '/'}
                  className={({ isActive }) => {
                    const tradingLogActive = t.to === '/trading' && location.search.includes('tab=log')
                    const statsSubActive = t.to === '/stats' && (statsTab === 'winrates' || statsTab === 'history')
                    const isDeckBuilderNav = t.to === '/builder'
                    const builderActive = isDeckBuilderNav && isDeckBuilderSection && !isDeckBrowserRoute
                    const active = isDeckBuilderNav
                      ? builderActive
                      : isActive && !tradingLogActive && !statsSubActive
                    return `${styles.mobileNavLink}${active ? ' ' + styles.mobileNavLinkActive : ''}`
                  }}
                  onClick={() => setMenuOpen(false)}
                >
                  <t.Icon size={17} />
                  {t.label}
                </NavLink>
                {t.to === '/builder' && (
                  <NavLink
                    to="/builder?tab=browser"
                    className={`${styles.mobileNavLink} ${styles.mobileNavSubLink}${isDeckBrowserRoute ? ' ' + styles.mobileNavLinkActive : ''}`}
                    onClick={() => setMenuOpen(false)}
                  >
                    <ListViewIcon size={15} />
                    Deck Browser
                  </NavLink>
                )}
                {t.to === '/trading' && (
                  <NavLink
                    to="/trading?tab=log"
                    className={`${styles.mobileNavLink} ${styles.mobileNavSubLink}${isTradeLogRoute ? ' ' + styles.mobileNavLinkActive : ''}`}
                    onClick={() => setMenuOpen(false)}
                  >
                    <ListViewIcon size={15} />
                    Trade Log
                  </NavLink>
                )}
                {t.to === '/stats' && (
                  <>
                    <NavLink
                      to="/stats?tab=winrates"
                      className={`${styles.mobileNavLink} ${styles.mobileNavSubLink}${location.pathname === '/stats' && statsTab === 'winrates' ? ' ' + styles.mobileNavLinkActive : ''}`}
                      onClick={() => setMenuOpen(false)}
                    >
                      <DecksIcon size={15} />
                      Deck Win Rates
                    </NavLink>
                    <NavLink
                      to="/stats?tab=history"
                      className={`${styles.mobileNavLink} ${styles.mobileNavSubLink}${location.pathname === '/stats' && statsTab === 'history' ? ' ' + styles.mobileNavLinkActive : ''}`}
                      onClick={() => setMenuOpen(false)}
                    >
                      <ListViewIcon size={15} />
                      Game History
                    </NavLink>
                  </>
                )}
              </Fragment>
            ))}
            <div className={styles.mobileNavFooter}>
              <NavLink
                to="/help"
                className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                onClick={() => setMenuOpen(false)}
              >
                <InfoIcon size={17} />
                Help
              </NavLink>
              <NavLink
                to="/settings"
                className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                onClick={() => setMenuOpen(false)}
              >
                <SettingsIcon size={17} />
                Settings
              </NavLink>
              {!premium && (
                <NavLink
                  to="/settings#support"
                  className={({ isActive }) => `${styles.mobileNavLink}${isActive ? ' ' + styles.mobileNavLinkActive : ''}`}
                  onClick={() => setMenuOpen(false)}
                >
                  <StatsIcon size={17} />
                  Support DeckLoom
                </NavLink>
              )}
              <button
                className={styles.mobileNavLink}
                onClick={() => { setMenuOpen(false); setShowFeedback(true) }}
                style={{ background: 'none', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer' }}
              >
                <span className={styles.mobileNavIcon}><BugIcon size={17} /></span>
                <span>Bug / Feature Request</span>
              </button>
              <button className={styles.mobileSignOut} onClick={signOut}>Sign out</button>
            </div>
          </div>
        </>
      )}

      <main ref={mainRef} className={`${styles.main} ${isNativeScannerRoute ? styles.mainScanner : ''} ${isDeckBuilderRoute ? styles.mainDeckBuilder : ''}`}>
        {children}
      </main>

      {!isNativeScannerRoute && <PageTips />}
      {showFeedback && !isNativeScannerRoute && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </div>
  )
}
