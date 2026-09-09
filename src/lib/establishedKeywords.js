// Keywords whose first printing predates ESTABLISHED_BEFORE.
//
// The "new mechanic" badge costs one Scryfall search per keyword, and a set
// carries 25-40 of them. That is what trips Scryfall's rate limit, and a
// rate-limited response arrives without CORS headers, so the browser reports it
// as a network failure and the page loses its badges.
//
// Almost none of those requests can change the answer: a keyword that already
// existed before the set was printed cannot be new to it. So the lookup is
// skipped for any keyword on this list when the set is newer than the cutoff,
// which on Star Trek skips 23 of 25 and asks about the 2 that could be new.
//
// This is a frozen list, and that is safe *in this direction only*. Going stale
// costs an extra lookup for a keyword that has since become established — never
// a wrong answer, because a keyword can only move from "new" to "established",
// never back. A list of *known* keywords used to decide novelty directly would
// have the opposite failure and is not what this is.
//
// Generated 2026-09-09 from our own card_prints (722 keywords, 522 established):
//
//   select kw, min(released_at)
//   from card_prints, unnest(keywords) as kw
//   where released_at is not null
//   group by kw;
//
// Regenerate by re-running that query; nothing depends on it being current.
export const ESTABLISHED_BEFORE = '2024-01-01'

const ESTABLISHED_KEYWORDS = new Set([
  "A Thousand Souls Die Every Day", "Aberrant Tinkering", "Adamant", "Adapt", "Addendum",
  "Advanced Species", "Aegis of the Emperor", "Affinity", "Affirmative", "Afflict",
  "Afterlife", "Aftermath", "Alliance", "Allons-y!", "Allure of Slaanesh", "Amass", "Amplify",
  "Animate Chains", "Annihilator", "Arcane Life-support", "Architect of Deception",
  "Armour of Shrieking Souls", "Ascend", "Assemble", "Assist", "Atomic Transmutation",
  "Augment", "Avoidance", "Awaken", "Backup", "Bad Wolf", "Banding", "Bargain",
  "Basic landcycling", "Battalion", "Battle Cannon", "Battle Cry", "Bear Witness",
  "Benediction of the Omnissiah", "Berzerker", "Bestow", "Bio-Plasmic Scream",
  "Bio-plasmic Barrage", "Blade of Magnus", "Blitz", "Blood Chalice", "Bloodrush",
  "Bloodthirst", "Boast", "Body Thief", "Body-print", "Bolster", "Brand-new Sky",
  "Brave Heart", "Bring it Down!", "Brood Telepathy", "Bushido", "Buy Information", "Buyback",
  "Caan", "Call for Aid", "Cascade", "Casualty", "Celebration", "Ceremorphosis", "Chainsword",
  "Champion", "Changeling", "Channel", "Chapter Master", "Children of the Cult",
  "Choose a background", "Chroma", "Cipher", "Clash", "Cleave", "Cohort", "Command Protocols",
  "Command Section", "Commander ninjutsu", "Companion", "Compleated", "Concealed Position",
  "Confounding Clouds", "Conjure", "Connive", "Conspire", "Constellation", "Consume Anomaly",
  "Converge", "Convert", "Convoke", "Corrupted", "Coruscating Flames", "Council's dilemma",
  "Coven", "Craft", "Crash Landing", "Crew", "Crushing Teeth", "Cumulative upkeep",
  "Curse of the Walking Pox", "Cycling", "Daemon Sword", "Dash", "Daybound",
  "Deal with the Black Guardian", "Death Frenzy", "Deathtouch", "Decayed", "Defender",
  "Delirium", "Delve", "Demonstrate", "Descend", "Desertwalk", "Detain", "Dethrone",
  "Devastating Charge", "Devoid", "Devour", "Devour Intellect", "Devourer of Souls",
  "Devouring Monster", "Discover", "Disturb", "Doctor's companion", "Domain", "Double",
  "Double strike", "Double team", "Draft from a spellbook", "Drain Life", "Dredge",
  "Dynastic Advisor", "Dynastic Codes", "Dynastic Command Node", "Echo",
  "Echo of the First Murder", "Elite Troops", "Embalm", "Emerge", "Eminence", "Enchant",
  "Encore", "Endless Swarm", "Endurant", "Enlist", "Enmitic Exterminator", "Enrage",
  "Enthralling Performance", "Entwine", "Epic", "Equip", "Escalate", "Escape", "Eternalize",
  "Eternity Gate", "Evoke", "Evolve", "Exalted", "Executioner Round", "Exert", "Exile Cannon",
  "Exploit", "Explore", "Exterminate!", "Extort", "Fabricate", "Fabricator Claw Array",
  "Fading", "Fallen Warrior", "Family Gathering", "Family gathering", "Fast Healing",
  "Fateful hour", "Fateseal", "Fathomless descent", "Fear", "Feed", "Feeder Mandibles",
  "Ferocious", "Field Reprogramming", "Fight", "Fire of Tzeentch", "First strike", "Flanking",
  "Flash", "Flashback", "Flavor", "Flesh Flayer", "Flesh Hooks", "Flying", "Food",
  "For Mirrodin!", "Forecast", "Forestcycling", "Forestwalk", "Foretell", "Formidable",
  "Fortify", "Frenzied Metabolism", "Frenzied Rampage", "Friends", "Fuse", "Gatling Blaster",
  "Genestealer's Kiss", "Genomic Enhancement", "Gift of Chaos", "Glory of Battle",
  "Go to Sleep", "Goad", "Graft", "Grand Strategist", "Grandeur", "Grav-cannon", "Gravestorm",
  "Grenades!", "Guardian Protocols", "Harbinger of Despair", "Haste", "Haunt", "Heal",
  "Healing Tears", "Heavy Power Hammer", "Heavy Rock Cutter", "Hellbent", "Hero's Reward",
  "Heroic", "Hexproof", "Hexproof from", "Hidden agenda", "Hideaway", "Hire a Mercenary",
  "History", "History Teacher", "Hive Mind", "Homunculus Servant", "Horrific Symbiosis",
  "Horsemanship", "How Civil of You", "Hunt for Heresy", "Hyperfrag Round",
  "Hyperphase Threshers", "Hypertoxic Miasma", "I. AM. TALKING!", "Impossible Girl", "Imprint",
  "Improvise", "Incubate", "Indestructible", "Infect", "Ingest", "Inquisition Agents",
  "Inspired", "Intensity", "Intimidate", "Into the TARDIS", "Invasion Beams", "Investigate",
  "Islandcycling", "Islandwalk", "Jast", "Join forces", "Jolly Gutpipes", "Jump", "Jump-start",
  "Keen Sight", "Kicker", "Kinfall", "Kinship", "Landcycling", "Landfall", "Landship",
  "Landwalk", "Leading from the Front", "Learn", "Legacy", "Legendary landwalk", "Level Up",
  "Lieutenant", "Lifelink", "Living metal", "Living weapon", "Locus of Slaanesh",
  "Look to the Stars", "Lord of Chaos", "Lord of Torment", "Lord of the Pyrrhian Legions",
  "Loud Ruckus", "Madness", "Magecraft", "Make Them Pay", "Mama's Coming", "Manifest",
  "Mark of Chaos Ascendant", "Martyrdom", "Master Tactician", "Master of Machines",
  "Matter Absorption", "Medicus Ministorum", "Meet in Reverse", "Megamorph", "Meld", "Melee",
  "Menace", "Mentor", "Metalcraft", "Midnight Entity", "Mill", "Miracle", "Modular",
  "Mold Earth", "Mono Eminence", "Monstrosity", "Morbid", "More Than Meets the Eye", "Morph",
  "Mountaincycling", "Mountainwalk", "Multi-threat Eliminator", "Multikicker", "Mutate",
  "My Will Be Done", "Myriad", "Natural Recovery", "Natural Shelter", "Negative",
  "Neurotraumal Rod", "Nightbound", "Ninjutsu", "Nitro-9", "Offering", "Open an Attraction",
  "Outlast", "Overload", "Pack tactics", "Parade!", "Paradox", "Parallel Universe", "Parley",
  "Partner", "Partner with", "Peaceful Coexistence", "Persist", "Phaeron", "Phalanx Commander",
  "Phasing", "Pheromone Trail", "Plainscycling", "Plainswalk", "Plasma Incinerator",
  "Polymorphine", "Populate", "Praesidium Protectiva", "Pray for Protection",
  "Primarch of the Death Guard", "Prince of Chaos", "Prismatic Gallery", "Probing Telepathy",
  "Proclamator Hailer", "Project Image", "Proliferate", "Protection",
  "Protection Fighting Style", "Protector", "Prototype", "Provoke", "Prowess", "Prowl",
  "Psychic Abomination", "Psychic Stimulus", "Radiance", "Raid", "Rally", "Rampage",
  "Rapacious Hunger", "Rapid Regeneration", "Rapid-fire Battle Cannon", "Ravenous", "Reach",
  "Read Ahead", "Rebound", "Reconfigure", "Recover", "Regenerate", "Reinforce",
  "Relentless March", "Renown", "Repair Barge", "Replicate", "Retrace",
  "Reverberating Summons", "Revolt", "Riot", "Ripple", "Rites of Banishment", "Rogue Trader",
  "Role token", "Roll to Visit Your Attractions", "Rosarius", "Rot Fly", "Ruinous Ascension",
  "Rulebreaker", "Sanctified Rules of Combat", "Sarcophagus", "Scavenge", "Scavenge the Dead",
  "Science Teacher", "Scorching Ray", "Scry", "Sec", "Secret council", "Secrets of the Soul",
  "Seek", "Sell Contraband", "Shadow", "Share Intelligence", "Shieldwall",
  "Shrieking Gargoyles", "Shroud", "Sigil of Corruption", "Skilled Outrider", "Skulk",
  "Skyswarm", "Sleight of Hand", "Slivercycling", "Sonic Blaster", "Sonic Booster",
  "Sorcerous Elixir", "Sorcerous Inspiration", "Soulbond", "Soulshift", "Spawn Termagants",
  "Spear of the Void Dragon", "Specialize", "Spectacle", "Spell mastery", "Spiritual Leader",
  "Splice", "Split second", "Spoilers", "Spore Chimney", "Squad", "Stall for Time", "Storm",
  "Stowage", "Strategic Coordinator", "Strike a Deal", "Strive", "Subterranean Assault",
  "Summary Execution", "Sunburst", "Support", "Suppressing Fire", "Surge", "Surveil",
  "Suspend", "Swampcycling", "Swampwalk", "Sweep", "Symphony of Pain", "Synapse Creature",
  "Synaptic Disintegrator", "Targeting Relay", "Team TARDIS", "Temporal Foresight",
  "Tempting offer", "Terror from the Deep", "Thay", "The Betrayer", "The Last Centurion",
  "The Most Important Punch in History", "The Seven-fold Chant", "The Will of the Hive Mind",
  "Three Autostubs", "Threshold", "Time Lord's Prerogative", "Time Travel", "Timey-Wimey",
  "Titanic", "Toxic", "Training", "Trample", "Transdimensional Scout", "Transform",
  "Translocation Protocols", "Transmute", "Treasure", "Tribute", "Triple", "Typecycling",
  "Ultima Founding", "Ultimate Sacrifice", "Umbra armor", "Undaunted", "Underdog",
  "Undergrowth", "Undying", "Unearth", "Unearthly Power", "Unleash", "Unquestionable Wisdom",
  "Vanguard Species", "Vanishing", "Veil of Time", "Venture into the dungeon", "Vigilance",
  "Vivid", "Void Shields", "Ward", "Warp Blast", "Warp Vortex", "Water Always Wins",
  "Will of the Planeswalkers", "Will of the council", "Wind Walk", "Wither", "Wizardcycling",
  "Woman Who Walked the Earth", "Wraith Form", "Xenos Cunning"
])

/**
 * Whether a keyword's novelty still has to be asked of Scryfall.
 *
 * A set released on or before the cutoff is not covered by the list — its own
 * printing may be the first — so those are always looked up.
 */
export function needsNoveltyLookup(keyword, releasedAt) {
  if (!releasedAt || releasedAt <= ESTABLISHED_BEFORE) return true
  return !ESTABLISHED_KEYWORDS.has(keyword)
}

/** Exposed for tests and diagnostics. */
export function isEstablishedKeyword(keyword) {
  return ESTABLISHED_KEYWORDS.has(keyword)
}
