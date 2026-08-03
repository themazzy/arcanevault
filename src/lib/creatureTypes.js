// Every Magic creature type, from Scryfall's /catalog/creature-types (339 as of
// 2026-08-03). A whitelist is required, not optional: deriving the tribe from
// sentence position alone read "land" off Lord Windgrace, "cast" off Sen
// Triplets, "equipped" off Halvar and "instant" off Kalamax — each of which then
// demanded 25 nonexistent tribal cards from the deck.
//
// Regenerate with: curl https://api.scryfall.com/catalog/creature-types
export const CREATURE_TYPES = new Set([
  "advisor", "aetherborn", "alien", "ally", "angel", "antelope", "ape", "archer", "archon",
  "armadillo", "army", "artificer", "assassin", "assembly-worker", "astartes", "atog",
  "aurochs", "automaton", "avatar", "azra", "badger", "balloon", "barbarian", "bard",
  "basilisk", "bat", "bear", "beast", "beaver", "beeble", "beholder", "berserker", "bird",
  "bison", "blinkmoth", "boar", "borg", "brainiac", "bringer", "brushwagg", "c'tan", "camarid",
  "camel", "capybara", "caribou", "carrier", "cat", "centaur", "chicken", "child", "chimera",
  "citizen", "cleric", "clown", "cockatrice", "construct", "coward", "coyote", "crab",
  "crocodile", "custodes", "cyberman", "cyclops", "dalek", "dauthi", "demigod", "demon",
  "deserter", "detective", "devil", "dinosaur", "djinn", "doctor", "dog", "dragon", "drake",
  "dreadnought", "drix", "drone", "druid", "dryad", "dwarf", "echidna", "efreet", "egg",
  "elder", "eldrazi", "elemental", "elephant", "elf", "elk", "employee", "eternal", "eye",
  "faerie", "ferret", "fish", "flagbearer", "fox", "fractal", "frog", "fungus", "gamer",
  "gamma", "gargoyle", "germ", "giant", "giraffe", "gith", "glimmer", "gnoll", "gnome", "goat",
  "goblin", "god", "golem", "gorgon", "graveborn", "gremlin", "griffin", "guest", "hag",
  "halfling", "hamster", "harpy", "head", "hedgehog", "hellion", "hero", "hippo", "hippogriff",
  "homarid", "homunculus", "horror", "horse", "human", "hydra", "hyena", "illusion", "imp",
  "incarnation", "inhuman", "inkling", "inquisitor", "insect", "jackal", "jellyfish",
  "juggernaut", "kangaroo", "kavu", "kirin", "kithkin", "klingon", "knight", "kobold", "kor",
  "kraken", "kree", "lamia", "lammasu", "leech", "lemur", "leviathan", "lhurgoyf", "licid",
  "lizard", "llama", "lobster", "manticore", "masticore", "mercenary", "merfolk", "metathran",
  "minion", "minotaur", "mite", "mole", "monger", "mongoose", "monk", "monkey", "moogle",
  "moonfolk", "mount", "mouse", "mutant", "myr", "mystic", "naga", "nautilus", "necron",
  "nephilim", "nightmare", "nightstalker", "ninja", "noble", "noggle", "nomad", "nymph",
  "octopus", "officer", "ogre", "ooze", "orb", "orc", "orgg", "otter", "ouphe", "ox", "oyster",
  "pangolin", "peasant", "pegasus", "pentavite", "performer", "pest", "phelddagrif", "phoenix",
  "phyrexian", "pilot", "pincher", "pirate", "plant", "platypus", "porcupine", "possum",
  "praetor", "primarch", "prism", "processor", "q", "qu", "rabbit", "raccoon", "ranger", "rat",
  "rebel", "reflection", "reveler", "rhino", "rigger", "robot", "rogue", "rukh", "sable",
  "salamander", "samurai", "sand", "saproling", "satyr", "scarecrow", "scientist", "scion",
  "scorpion", "scout", "sculpture", "seal", "serf", "serpent", "servo", "shade", "shaman",
  "shapeshifter", "shark", "sheep", "shi'ar", "siren", "skeleton", "skrull", "skunk", "slith",
  "sliver", "sloth", "slug", "snail", "snake", "soldier", "soltari", "sorcerer", "spawn",
  "specter", "spellshaper", "sphinx", "spider", "spike", "spirit", "splinter", "sponge", "spy",
  "squid", "squirrel", "starfish", "surrakar", "survivor", "symbiote", "synth", "teddy",
  "tentacle", "tetravite", "thalakos", "thopter", "thrull", "tiefling", "time lord", "tosk",
  "toy", "treefolk", "trilobite", "triskelavite", "troll", "turtle", "tyranid", "unicorn",
  "urzan", "utrom", "vampire", "varmint", "vedalken", "villain", "volver", "vulcan", "wall",
  "walrus", "warlock", "warrior", "weasel", "weird", "werewolf", "whale", "wizard", "wolf",
  "wolverine", "wombat", "worm", "wraith", "wurm", "yeti", "zombie", "zubera"
])
