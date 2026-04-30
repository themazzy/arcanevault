// check(statsShape, profileShape)
// statsShape:  { total_cards, unique_cards, foil_count, sets_count, color_distribution }
// profileShape: { collection_value, public_deck_count, game_stats: { wins, total } }

export const MILESTONES = [
  // ── Collection size ────────────────────────────────────────────────────────
  {
    id: 'first_card', label: 'First Card', icon: '🃏',
    req: '1 card', desc: 'Added your first card to the vault',
    check: (s) => (s?.total_cards ?? 0) >= 1,
  },
  {
    id: 'collector', label: 'Collector', icon: '📦',
    req: '100 cards', desc: 'Built a collection of 100 cards',
    check: (s) => (s?.total_cards ?? 0) >= 100,
  },
  {
    id: 'dedicated', label: 'Dedicated', icon: '⚔️',
    req: '500 cards', desc: 'Committed with 500 cards in the vault',
    check: (s) => (s?.total_cards ?? 0) >= 500,
  },
  {
    id: 'obsessed', label: 'Obsessed', icon: '🔮',
    req: '1,000 cards', desc: 'Reached the 1,000 card milestone',
    check: (s) => (s?.total_cards ?? 0) >= 1000,
  },
  {
    id: 'legendary', label: 'Legendary', icon: '👑',
    req: '5,000 cards', desc: 'An extraordinary vault of 5,000 cards',
    check: (s) => (s?.total_cards ?? 0) >= 5000,
  },
  {
    id: 'hoarder', label: 'Hoarder', icon: '🏛️',
    req: '10,000 cards', desc: 'A truly massive collection of 10,000 cards',
    check: (s) => (s?.total_cards ?? 0) >= 10000,
  },

  // ── Unique cards ───────────────────────────────────────────────────────────
  {
    id: 'unique_collector', label: 'Curator', icon: '🗂️',
    req: '500 unique prints', desc: 'Own 500 different card printings',
    check: (s) => (s?.unique_cards ?? 0) >= 500,
  },
  {
    id: 'completionist', label: 'Completionist', icon: '📚',
    req: '2,000 unique prints', desc: 'Own 2,000 different card printings',
    check: (s) => (s?.unique_cards ?? 0) >= 2000,
  },

  // ── Foils ──────────────────────────────────────────────────────────────────
  {
    id: 'first_foil', label: 'First Foil', icon: '✨',
    req: '1 foil', desc: 'Added your first foil card',
    check: (s) => (s?.foil_count ?? 0) >= 1,
  },
  {
    id: 'shiny_hunter', label: 'Shiny Hunter', icon: '💎',
    req: '50 foils', desc: 'Assembled a shimmer of 50 foil cards',
    check: (s) => (s?.foil_count ?? 0) >= 50,
  },
  {
    id: 'foil_fanatic', label: 'Foil Fanatic', icon: '🌟',
    req: '200 foils', desc: 'A dazzling stash of 200 foil cards',
    check: (s) => (s?.foil_count ?? 0) >= 200,
  },
  {
    id: 'shimmer', label: 'Shimmer', icon: '🪩',
    req: '500 foils', desc: 'The vault practically glows — 500 foils',
    check: (s) => (s?.foil_count ?? 0) >= 500,
  },

  // ── Sets ───────────────────────────────────────────────────────────────────
  {
    id: 'sets_explorer', label: 'Set Explorer', icon: '🗺️',
    req: '25 sets', desc: 'Own cards from 25 different sets',
    check: (s) => (s?.sets_count ?? 0) >= 25,
  },
  {
    id: 'globetrotter', label: 'Globetrotter', icon: '🌍',
    req: '100 sets', desc: 'Own cards from 100 different sets',
    check: (s) => (s?.sets_count ?? 0) >= 100,
  },

  // ── Colors ─────────────────────────────────────────────────────────────────
  {
    id: 'rainbow', label: 'Rainbow', icon: '🌈',
    req: 'All 5 colors', desc: 'Own at least one card of each color — WUBRG',
    check: (s) => {
      const d = s?.color_distribution || {}
      return ['W', 'U', 'B', 'R', 'G'].every(c => (d[c] ?? 0) >= 1)
    },
  },

  // ── Decks ──────────────────────────────────────────────────────────────────
  {
    id: 'deck_builder', label: 'Deck Builder', icon: '🏗️',
    req: '1 public deck', desc: 'Shared your first deck with the community',
    check: (_, p) => (p?.public_deck_count ?? 0) >= 1,
  },
  {
    id: 'architect', label: 'Architect', icon: '🗺️',
    req: '5 public decks', desc: 'Shared 5 decks with the community',
    check: (_, p) => (p?.public_deck_count ?? 0) >= 5,
  },
  {
    id: 'loremaster', label: 'Loremaster', icon: '📜',
    req: '10 public decks', desc: 'Shared 10 decks with the community',
    check: (_, p) => (p?.public_deck_count ?? 0) >= 10,
  },

  // ── Value ──────────────────────────────────────────────────────────────────
  {
    id: 'valuable', label: 'Valuable', icon: '💰',
    req: '€100 value', desc: 'Collection estimated value exceeds €100',
    check: (_, p) => (p?.collection_value ?? 0) >= 100,
  },
  {
    id: 'investor', label: 'Investor', icon: '📈',
    req: '€500 value', desc: 'Collection estimated value exceeds €500',
    check: (_, p) => (p?.collection_value ?? 0) >= 500,
  },
  {
    id: 'high_roller', label: 'High Roller', icon: '💸',
    req: '€1,000 value', desc: 'Collection estimated value exceeds €1,000',
    check: (_, p) => (p?.collection_value ?? 0) >= 1000,
  },
  {
    id: 'diamond_vault', label: 'Diamond Vault', icon: '🏆',
    req: '€5,000 value', desc: 'Collection estimated value exceeds €5,000',
    check: (_, p) => (p?.collection_value ?? 0) >= 5000,
  },

  // ── Games ──────────────────────────────────────────────────────────────────
  {
    id: 'first_win', label: 'First Win', icon: '🥇',
    req: '1 win', desc: 'Won your first tracked game',
    check: (_, p) => (p?.game_stats?.wins ?? 0) >= 1,
  },
  {
    id: 'champion', label: 'Champion', icon: '🏅',
    req: '10 wins', desc: 'Racked up 10 tracked wins',
    check: (_, p) => (p?.game_stats?.wins ?? 0) >= 10,
  },
  {
    id: 'veteran', label: 'Veteran', icon: '⚜️',
    req: '25 games', desc: 'Played 25 tracked games',
    check: (_, p) => (p?.game_stats?.total ?? 0) >= 25,
  },
]
