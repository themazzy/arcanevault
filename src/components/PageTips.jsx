import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
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
      'Feature a wishlist on your Trade Post to show others what you want.',
    ],
    actions: [{ label: 'Open trading', to: '/trading' }],
  },
  builder: {
    title: 'Deck Builder',
    intro: 'Plan decks manually, import a list, or start with Build Assist and a commander.',
    bullets: [
      'Build or import decklists before you own every card.',
      'Build Assist can auto build from your binders or guide every role and recommendation.',
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
    intro: 'Compare trades, publish a shareable Trade Post, and review proposals.',
    bullets: [
      'Compare both sides of a trade using live prices and exact owned copies.',
      'Open a public Trade Post listing your “For Trade” binder and featured wishlists.',
      'Receive and accept trade proposals from other players in the Proposals tab.',
    ],
    actions: [{ label: 'Your Trade Post', to: '/trading?tab=post' }],
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
  tournaments: {
    title: 'Tournaments',
    intro: 'Run duel or pod events end to end — pairings, results, and standings in one place.',
    bullets: [
      'Pick a format and a Single Elimination, Round Robin, or Swiss structure.',
      'Add players directly or share a join code so they add themselves.',
      'Record each round and let DeckLoom build the next one and update standings.',
    ],
    actions: [{ label: 'Open life tracker', to: '/life' }],
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
  'deck-builder': {
    title: 'Deck Builder',
    intro: 'The full deck editing workspace — board layout, imports, format checks, recommendations, and collection sync for one specific deck.',
    bullets: [
      'For Commander decks, Build Assist can auto fill open roles or let you choose every card.',
      'Binder-first picks, deck-aware recommendations, budget, bracket, and mana targets keep the build grounded.',
      'Review the buy gap, cut an overbuilt list to 100, then open the playtester.',
    ],
    actions: [{ label: 'Open Build Assist', intent: 'build-assist' }],
  },
  playtester: {
    title: 'Deck Playtester',
    intro: 'A solo goldfish for stress-testing a list before sleeving up — opening hands, mulligans, draws, and zone changes.',
    bullets: [
      'Shuffle and draw to evaluate opening-hand consistency.',
      'Move cards between hand, battlefield, and graveyard to play out turns.',
      'Reset whenever you want a fresh draw to compare lines.',
    ],
    actions: [{ label: 'Back to builder', to: '' }],
  },
  rules: {
    title: 'MTG Rulebook',
    intro: 'The official comprehensive rules embedded in the app — searchable by category, section, and rule number.',
    bullets: [
      'Look up a rule by number when you already know the reference.',
      'Search by keyword to find every mention of a mechanic.',
      'Browse categories for context around a topic during a game.',
    ],
    actions: [{ label: 'Back to home', to: '/' }],
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
  if (pathname.startsWith('/builder/')) {
    return pathname.endsWith('/playtest') ? 'playtester' : 'deck-builder'
  }
  if (pathname === '/trading') return params.get('tab') === 'log' ? 'trade-log' : 'trading'
  if (pathname === '/stats') {
    if (params.get('tab') === 'winrates') return 'stats-winrates'
    if (params.get('tab') === 'history') return 'stats-history'
    return 'stats'
  }
  if (pathname === '/life') return 'life'
  if (pathname === '/tournaments') return 'tournaments'
  if (pathname === '/scanner') return 'scanner'
  if (pathname === '/rules') return 'rules'
  if (pathname === '/settings') return 'settings'
  return null
}

export default function PageTips() {
  const { user } = useAuth()
  const settings = useSettings()
  const location = useLocation()
  const navigate = useNavigate()

  const tipId = useMemo(() => getTipId(location.pathname, location.search), [location.pathname, location.search])
  const tip = tipId ? TIPS[tipId] : null
  const guidedTipSuppressed = tipId === 'deck-builder'
    && Boolean(location.state?.guidedCommander || location.state?.suppressDeckBuilderTip)
  const setupDone = !!user?.user_metadata?.setup_completed || localStorage.getItem(SETUP_LOCAL_KEY) === '1'
  const seen = settings.page_tips_seen || {}

  if (!user || !settings.loaded || !setupDone || !tip || seen[tipId] || guidedTipSuppressed) return null

  const dismiss = () => {
    settings.save({
      page_tips_seen: {
        ...seen,
        [tipId]: new Date().toISOString(),
      },
    })
  }

  const runAction = (action) => {
    dismiss()
    if (action.intent === 'build-assist') {
      navigate(location.pathname, {
        replace: true,
        state: { ...(location.state || {}), openBuildAssistant: true },
      })
      return
    }

    let target = action.to
    if (!target && tipId === 'playtester') target = location.pathname.replace(/\/playtest$/, '')
    if (target) navigate(target)
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
          {(tip.actions || []).map(action => (
            <Button
              key={action.label}
              size="sm"
              variant="primary"
              onClick={() => runAction(action)}
              className={styles.tipAction}
            >
              {action.label}
            </Button>
          ))}
          <Button size="sm" onClick={dismiss} className={styles.closeAction}>Got it</Button>
        </div>
      </div>
    </Modal>
  )
}
