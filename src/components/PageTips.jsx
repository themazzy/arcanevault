import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from './Auth'
import { useSettings } from './SettingsContext'
import { Button, Modal } from './UI'
import styles from './PageTips.module.css'

const SETUP_LOCAL_KEY = 'arcanevault_setup_done'

const TIPS = {
  home: {
    title: 'Home',
    intro: 'Your dashboard for quick lookup, collection highlights, recent activity, news, and rulebook access.',
    bullets: [
      'Search any card without leaving the dashboard.',
      'Review collection snapshots, valuable cards, and recently added cards.',
      'Jump into rules, news, and upcoming sets when you need context.',
    ],
    actions: [{ label: 'Search cards', to: '/' }],
  },
  collection: {
    title: 'Collection',
    intro: 'The full inventory view for every owned card across binders and collection decks.',
    bullets: [
      'Filter, sort, and select cards across your whole collection.',
      'Use folder badges to see where each copy lives.',
      'Bulk move selected copies into binders, decks, or lists.',
    ],
    actions: [{ label: 'Open binders', to: '/binders' }],
  },
  decks: {
    title: 'Decks',
    intro: 'Your owned decks: real collection decks made from exact owned card copies.',
    bullets: [
      'Open a deck to review its assigned cards and value.',
      'Transfer or delete safely without losing cards by accident.',
      'Use Deck Builder when you want to plan changes before assigning owned copies.',
    ],
    actions: [{ label: 'Open builder', to: '/builder' }],
  },
  binders: {
    title: 'Binders',
    intro: 'Binders organize owned cards by storage location, project, trade binder, or any structure you use in real life.',
    bullets: [
      'Create binders for boxes, albums, sets, or trade stock.',
      'Browse one binder at a time with the same card tools as Collection.',
      'Move cards between binders without changing deck allocations.',
    ],
    actions: [{ label: 'View collection', to: '/collection' }],
  },
  lists: {
    title: 'Wishlists',
    intro: 'Wishlists track cards you want later. They are separate from owned inventory.',
    bullets: [
      'Save upgrade targets, buy lists, and cards to trade for.',
      'Wishlist cards do not count toward collection value or owned copies.',
      'Bulk actions only move wishlist items between lists.',
    ],
    actions: [{ label: 'Open trading', to: '/trading' }],
  },
  builder: {
    title: 'Deck Builder',
    intro: 'A planning workspace for brewing, imports, stats, combos, and collection sync.',
    bullets: [
      'Build or import decklists before you own every card.',
      'Use stats and combo tools to tune the list.',
      'Make a collection deck when the build is ready to become real inventory.',
    ],
    actions: [{ label: 'Browse public decks', to: '/builder?tab=browser' }],
  },
  'deck-browser': {
    title: 'Deck Browser',
    intro: 'Browse public decks from the community and copy lists into your own Deck Builder.',
    bullets: [
      'Search and filter public decks by format.',
      'Open shared deck pages to inspect cards and stats.',
      'Copy a deck into your own builder to modify it privately.',
    ],
    actions: [{ label: 'My decks', to: '/builder' }],
  },
  trading: {
    title: 'Trading',
    intro: 'Compare both sides of a trade using live prices and exact owned copies.',
    bullets: [
      'Add cards you are giving and cards you are receiving.',
      'Custom prices help handle condition, cash, or negotiated values.',
      'Complete a trade to update local collection placement.',
    ],
    actions: [{ label: 'View trade log', to: '/trading?tab=log' }],
  },
  'trade-log': {
    title: 'Trade Log',
    intro: 'A record of completed trades for reviewing values, partners, notes, and outcomes.',
    bullets: [
      'Refresh to load recent trade history.',
      'Use notes to remember context for each completed trade.',
      'Return to Trading to compare and save a new trade.',
    ],
    actions: [{ label: 'New trade', to: '/trading' }],
  },
  stats: {
    title: 'Stats',
    intro: 'Collection analytics for value, rarity, color, formats, movers, sets, and milestones.',
    bullets: [
      'Review total value and profit or loss from purchase prices.',
      'Find top cards, set completion, and collection breakdowns.',
      'Use milestones to spot profile-worthy achievements.',
    ],
    actions: [{ label: 'Deck win rates', to: '/stats?tab=winrates' }],
  },
  'stats-winrates': {
    title: 'Deck Win Rates',
    intro: 'Game-result analytics grouped by deck, format, and placement.',
    bullets: [
      'Track wins, losses, and placement splits for each deck.',
      'Life Tracker game results feed this view.',
      'Use the leaderboard to compare real play performance.',
    ],
    actions: [{ label: 'Game history', to: '/stats?tab=history' }],
  },
  'stats-history': {
    title: 'Game History',
    intro: 'Your saved play history from local and shared Life Tracker sessions.',
    bullets: [
      'Edit placement or notes after a game.',
      'Delete entries that were logged by mistake.',
      'History powers profile stats and deck win-rate summaries.',
    ],
    actions: [{ label: 'Life Tracker', to: '/life' }],
  },
  life: {
    title: 'Life Tracker',
    intro: 'A multiplayer life counter with commander damage, counters, shared lobbies, and game logging.',
    bullets: [
      'Set player decks before the game so results can be saved.',
      'Host a shared lobby with a join code for other players.',
      'Finish games to feed Game History and Deck Win Rates.',
    ],
    actions: [{ label: 'View game history', to: '/stats?tab=history' }],
  },
  scanner: {
    title: 'Scanner',
    intro: 'Camera scanning helps identify cards and send them straight into a binder, deck, or wishlist.',
    bullets: [
      'Good lighting and a clear card border improve recognition.',
      'Use Add to Collection when the detected card is correct.',
      'Scanner still uses the same exact-print and destination rules as manual add.',
    ],
    actions: [{ label: 'Open collection', to: '/collection' }],
  },
  settings: {
    title: 'Settings',
    intro: 'Control appearance, accessibility, pricing, sync, profile, account, and support options.',
    bullets: [
      'Theme, text, and contrast changes apply across the app.',
      'Settings sync to your account after local changes.',
      'You can reset these page tips here whenever you want.',
    ],
    actions: [{ label: 'Support section', to: '/settings#support' }],
  },
}

function getTipId(pathname, search) {
  const params = new URLSearchParams(search)
  if (pathname === '/') return 'home'
  if (pathname === '/collection') return 'collection'
  if (pathname === '/decks') return 'decks'
  if (pathname === '/binders') return 'binders'
  if (pathname === '/lists') return 'lists'
  if (pathname === '/builder') return params.get('tab') === 'browser' ? 'deck-browser' : 'builder'
  if (pathname === '/trading') return params.get('tab') === 'log' ? 'trade-log' : 'trading'
  if (pathname === '/stats') {
    if (params.get('tab') === 'winrates') return 'stats-winrates'
    if (params.get('tab') === 'history') return 'stats-history'
    return 'stats'
  }
  if (pathname === '/life') return 'life'
  if (pathname === '/scanner') return 'scanner'
  if (pathname === '/settings') return 'settings'
  return null
}

export default function PageTips() {
  const { user } = useAuth()
  const settings = useSettings()
  const location = useLocation()

  const tipId = useMemo(() => getTipId(location.pathname, location.search), [location.pathname, location.search])
  const tip = tipId ? TIPS[tipId] : null
  const setupDone = !!user?.user_metadata?.setup_completed || localStorage.getItem(SETUP_LOCAL_KEY) === '1'
  const seen = settings.page_tips_seen || {}

  if (!user || !settings.loaded || !setupDone || !tip || seen[tipId]) return null

  const dismiss = () => {
    settings.save({
      page_tips_seen: {
        ...seen,
        [tipId]: new Date().toISOString(),
      },
    })
  }

  return (
    <Modal onClose={dismiss} showClose={false} className={styles.tipModal}>
      <div className={styles.tip}>
        <div className={styles.header}>
          <div className={styles.eyebrow}>Page tip</div>
          <h2 className={styles.title}>{tip.title}</h2>
          <p className={styles.intro}>{tip.intro}</p>
        </div>
        <div className={styles.body}>
          <ul className={styles.bullets}>
            {tip.bullets.map(item => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div className={styles.footer}>
          <Button size="sm" onClick={dismiss} className={styles.closeAction}>Got it</Button>
        </div>
      </div>
    </Modal>
  )
}
