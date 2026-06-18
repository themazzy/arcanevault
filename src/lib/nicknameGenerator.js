// Standin nickname generator — used by the Setup Wizard to pre-fill an editable
// default and to assign a fallback when a user finishes/skips setup without
// picking their own. Format: <Adjective><Noun><two digits>, e.g. "MysticGoblin47".
//
// The nickname doubles as the public profile username (see Profile.jsx), which is
// only constrained to be case-insensitively unique (is_username_available RPC).
// CamelCase keeps it URL-safe; words are kept short so the longest result stays
// within the 24-char nickname cap (max 10 + 10 + 2 = 22).

// MTG-flavoured adjectives (single word, ≤10 chars, capitalised).
export const ADJECTIVES = [
  'Arcane', 'Ancient', 'Azure', 'Crimson', 'Eternal', 'Feral', 'Gilded', 'Mystic',
  'Spectral', 'Verdant', 'Radiant', 'Savage', 'Cursed', 'Hallowed', 'Infernal',
  'Primal', 'Astral', 'Blighted', 'Celestial', 'Draconic', 'Ember', 'Frostbound',
  'Grim', 'Ironclad', 'Lunar', 'Molten', 'Necrotic', 'Obsidian', 'Phantom',
  'Runic', 'Stormborn', 'Thornclad', 'Umbral', 'Valiant', 'Withered', 'Wandering',
  'Boundless', 'Twilight', 'Vengeful', 'Undying',
]

// MTG-flavoured nouns (creatures / archetypes, single word, ≤10 chars, capitalised).
export const NOUNS = [
  'Goblin', 'Dragon', 'Sphinx', 'Phoenix', 'Hydra', 'Specter', 'Wraith', 'Golem',
  'Elemental', 'Angel', 'Demon', 'Vampire', 'Zombie', 'Merfolk', 'Knight', 'Wizard',
  'Druid', 'Shaman', 'Warden', 'Sentinel', 'Leviathan', 'Behemoth', 'Gargoyle',
  'Basilisk', 'Chimera', 'Griffin', 'Wyvern', 'Lich', 'Spellblade', 'Bloodmage',
  'Runemaster', 'Beast', 'Serpent', 'Treefolk', 'Horror', 'Avatar', 'Familiar',
  'Warlock', 'Champion', 'Conjurer', 'Oracle', 'Reaver', 'Saproling', 'Construct',
]

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)]
}

// Pure: build one candidate handle. `rng` defaults to Math.random but is
// injectable so the generator can be tested deterministically.
export function generateNickname(rng = Math.random) {
  const adj = pick(ADJECTIVES, rng)
  const noun = pick(NOUNS, rng)
  const d1 = Math.floor(rng() * 10)
  const d2 = Math.floor(rng() * 10)
  return `${adj}${noun}${d1}${d2}`
}

// Generate a handle that passes the availability predicate. `isAvailable` is an
// async fn (typically wrapping the is_username_available RPC) returning a boolean.
// Retries on collision; if availability can't be verified (predicate throws, e.g.
// offline) the current candidate is returned as a best-effort. After exhausting
// attempts, falls back to a candidate with extra digits to all-but-guarantee
// uniqueness rather than blocking setup.
export async function generateAvailableNickname(isAvailable, { attempts = 10, rng = Math.random } = {}) {
  for (let i = 0; i < attempts; i++) {
    const candidate = generateNickname(rng)
    if (typeof isAvailable !== 'function') return candidate
    try {
      if (await isAvailable(candidate)) return candidate
    } catch {
      return candidate // can't verify (offline) — use it rather than block setup
    }
  }
  const extra = Math.floor(rng() * 100).toString().padStart(2, '0')
  return `${generateNickname(rng)}${extra}`
}
