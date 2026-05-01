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
    id: 'apprentice', label: 'Apprentice', icon: '🪶',
    req: '10 cards', desc: 'A modest beginning — 10 cards in the vault',
    check: (s) => (s?.total_cards ?? 0) >= 10,
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
  {
    id: 'archmage', label: 'Archmage', icon: '🧙',
    req: '25,000 cards', desc: 'A vault that rivals a library — 25,000 cards',
    check: (s) => (s?.total_cards ?? 0) >= 25000,
  },

  // ── Unique cards ───────────────────────────────────────────────────────────
  {
    id: 'print_seeker', label: 'Print Seeker', icon: '🔍',
    req: '100 unique prints', desc: 'Own 100 different card printings',
    check: (s) => (s?.unique_cards ?? 0) >= 100,
  },
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
  {
    id: 'chronicler', label: 'Chronicler', icon: '📖',
    req: '5,000 unique prints', desc: 'Own 5,000 different card printings',
    check: (s) => (s?.unique_cards ?? 0) >= 5000,
  },

  // ── Foils ──────────────────────────────────────────────────────────────────
  {
    id: 'first_foil', label: 'First Foil', icon: '✨',
    req: '1 foil', desc: 'Added your first foil card',
    check: (s) => (s?.foil_count ?? 0) >= 1,
  },
  {
    id: 'foil_dabbler', label: 'Foil Dabbler', icon: '🪞',
    req: '10 foils', desc: 'A small shimmer — 10 foil cards',
    check: (s) => (s?.foil_count ?? 0) >= 10,
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
  {
    id: 'mirror_vault', label: 'Mirror Vault', icon: '🔱',
    req: '1,000 foils', desc: 'A blinding hoard of 1,000 foil cards',
    check: (s) => (s?.foil_count ?? 0) >= 1000,
  },

  // ── Sets ───────────────────────────────────────────────────────────────────
  {
    id: 'set_dabbler', label: 'Set Dabbler', icon: '🧭',
    req: '5 sets', desc: 'Own cards from 5 different sets',
    check: (s) => (s?.sets_count ?? 0) >= 5,
  },
  {
    id: 'sets_explorer', label: 'Set Explorer', icon: '🗺️',
    req: '25 sets', desc: 'Own cards from 25 different sets',
    check: (s) => (s?.sets_count ?? 0) >= 25,
  },
  {
    id: 'set_scholar', label: 'Set Scholar', icon: '🎓',
    req: '50 sets', desc: 'Own cards from 50 different sets',
    check: (s) => (s?.sets_count ?? 0) >= 50,
  },
  {
    id: 'globetrotter', label: 'Globetrotter', icon: '🌍',
    req: '100 sets', desc: 'Own cards from 100 different sets',
    check: (s) => (s?.sets_count ?? 0) >= 100,
  },
  {
    id: 'omniscient', label: 'Omniscient', icon: '🪐',
    req: '250 sets', desc: 'Own cards from 250 different sets',
    check: (s) => (s?.sets_count ?? 0) >= 250,
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
  {
    id: 'mono_devotee', label: 'Mono Devotee', icon: '🕯️',
    req: '100 cards in one color', desc: '100+ cards sharing a single color identity',
    check: (s) => {
      const d = s?.color_distribution || {}
      return ['W', 'U', 'B', 'R', 'G'].some(c => (d[c] ?? 0) >= 100)
    },
  },
  {
    id: 'colorless_keeper', label: 'Colorless Keeper', icon: '⚙️',
    req: '25 colorless cards', desc: 'Own 25 cards with no color identity',
    check: (s) => (s?.color_distribution?.C ?? 0) >= 25,
  },
  {
    id: 'multicolor_master', label: 'Multicolor Master', icon: '🎨',
    req: '50 multicolor cards', desc: 'Own 50 cards with two or more colors',
    check: (s) => (s?.color_distribution?.M ?? 0) >= 50,
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
  {
    id: 'brewmaster', label: 'Brewmaster', icon: '⚗️',
    req: '25 public decks', desc: 'Shared 25 decks with the community',
    check: (_, p) => (p?.public_deck_count ?? 0) >= 25,
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
  {
    id: 'whale', label: 'Whale', icon: '🐋',
    req: '€10,000 value', desc: 'Collection estimated value exceeds €10,000',
    check: (_, p) => (p?.collection_value ?? 0) >= 10000,
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
