// Functional card categorization for the deck builder and deck stats.
//
// `getCardCategory` returns the role a card plays in a deck (Ramp, Removal,
// Card Draw, …). It's a deterministic regex ladder: more-specific rules first,
// then a type-line fallback (Creature/Instant/…) for anything that doesn't
// match a functional role.
//
// Callers must lowercase nothing — the function lowercases internally so it
// can be called with either raw or pre-lowercased input.

// CAT_ORDER is the *display* order in deck-builder group headers. The matching
// priority is determined by the order of `if` checks inside `getCardCategory`.
export const CAT_ORDER = [
  'Ramp', 'Card Draw', 'Tutor', 'Cost Reduction',
  'Removal', 'Board Wipe', 'Counterspell', 'Burn',
  'Tokens', 'Anthem', '+1/+1 Counters', 'Evasion',
  'Sacrifice', 'Blink', 'Landfall', 'Lifegain', 'Copy', 'Doublers', 'Cheat',
  'Graveyard', 'Mill',
  'Drain', 'Discard', 'Stax',
  'Protection', 'Extra Turns', 'Combo',
  'Creature', 'Artifact', 'Enchantment', 'Instant', 'Sorcery', 'Planeswalker',
  'Land', 'Other',
]

// Categories produced by `getCardCategory`'s type-line fallback. A card pinned
// to one of these is just "the regex didn't find a role" — so it's safe to
// re-infer when the rules improve. Functional categories (Ramp, Burn, etc.)
// represent an intentional pick and must never be auto-overwritten.
export const TYPE_FALLBACK_CATEGORIES = new Set([
  'Creature', 'Artifact', 'Enchantment', 'Instant', 'Sorcery',
  'Planeswalker', 'Land', 'Other',
])

export function isTypeFallbackCategory(name) {
  return TYPE_FALLBACK_CATEGORIES.has(name)
}

export const CAT_COLORS = {
  'Ramp': '#4a9a5a',
  'Card Draw': '#5a70bb',
  'Tutor': '#9a5abb',
  'Cost Reduction': '#5aa0c0',
  'Removal': '#cc5555',
  'Board Wipe': '#aa3333',
  'Counterspell': '#4470cc',
  'Burn': '#e07020',
  'Tokens': '#6a9a4a',
  'Anthem': '#d4b85a',
  '+1/+1 Counters': '#6abb6a',
  'Evasion': '#a4d4e4',
  'Sacrifice': '#7a3a3a',
  'Blink': '#a4c4d4',
  'Landfall': '#8a7a4a',
  'Lifegain': '#d4a4a4',
  'Copy': '#bb88cc',
  'Doublers': '#cc77bb',
  'Cheat': '#cc8866',
  'Graveyard': '#7a4a8a',
  'Mill': '#4a4a8a',
  'Drain': '#8a3a5a',
  'Discard': '#5a3a6a',
  'Stax': '#7a7a7a',
  'Protection': '#aaaaaa',
  'Extra Turns': '#cc88aa',
  'Combo': '#c9a84c',
  'Creature': '#5a8a5a',
  'Artifact': '#8a8a9a',
  'Enchantment': '#7a6aaa',
  'Instant': '#5555bb',
  'Sorcery': '#9944aa',
  'Planeswalker': '#cc7722',
  'Land': '#6a7a5a',
  'Other': '#666',
}

// eslint-disable-next-line no-unused-vars
export function getCardCategory(oracle = '', typeLine = '', keywords = []) {
  const o = (oracle || '').toLowerCase()
  const t = (typeLine || '').toLowerCase()

  // ── Lands always stay Land ────────────────────────────────────────────────
  // Lands with functional text (fetch lands, Field of the Dead, mana dorks
  // disguised as lands) should never leak into Ramp/Landfall/etc. Bucketing
  // them all as Land matches how players group decks visually.
  if (t.includes('land')) return 'Land'

  // ── Counterspell ──────────────────────────────────────────────────────────
  // Allow commas so type lists match (e.g. Swan Song: "counter target
  // enchantment, instant, or sorcery spell").
  if (/counter target [a-z', ]{0,60}(spell|ability)/.test(o)) return 'Counterspell'
  if (/counter (that|the next) (spell|ability)/.test(o)) return 'Counterspell'

  // ── Doublers (triggers, tokens, counters, draws — checked early so the
  // doubler wins over Tokens/+1/+1 Counters/Card Draw/Copy for cards whose
  // signature effect is the doubling itself)
  // Trigger doublers: Panharmonicon, Yarok, Twinflame Travelers
  if (/triggers? an additional time/.test(o)) return 'Doublers'
  if (/triggers? (one|two|three|\d+) more times?/.test(o)) return 'Doublers'
  // Token / counter doublers: Doubling Season, Parallel Lives, Anointed
  // Procession, Hardened Scales-adjacent "twice that many"
  if (/twice that many/.test(o)) return 'Doublers'
  // Strionic Resonator (copy a triggered ability is the same archetype)
  if (/copy target triggered ability/.test(o)) return 'Doublers'
  // Draw doublers: Teferi's Ageless Insight, Alhammarret's Archive
  if (/if you would draw [^.]{0,80}instead [a-z]+ two cards/.test(o)) return 'Doublers'
  // Damage doublers/triplers: City on Fire (MOM = triple), Furnace of Rath,
  // Dictate of the Twin Gods, Gisela. Matches "deals double damage",
  // "deals double that damage", and the triple variant.
  if (/deals? (double|triple) (that |the )?damage/.test(o)) return 'Doublers'

  // ── Copy (spell/permanent doubling) ───────────────────────────────────────
  // Optional quantifier between "copy" and "target" catches Display of Power
  // ("Copy any number of target instant and/or sorcery spells").
  if (/copy [a-z ]{0,40}target [a-z' /]{0,40}(spell|instant|sorcery|creature|permanent|activated ability|triggered ability)/.test(o)) return 'Copy'
  if (/copy target (spell|instant|sorcery|creature|permanent|activated ability|triggered ability)/.test(o)) return 'Copy'
  if (/token that's a copy of/.test(o)) return 'Copy'
  if (/(becomes|enters? the battlefield as) a copy of/.test(o)) return 'Copy'
  if (/copy that (spell|ability)/.test(o)) return 'Copy'

  // ── Board Wipe (check before single-target Removal) ───────────────────────
  if (/(destroy|exile) all [a-z ]{0,40}(creatures|permanents|nonland)/.test(o)) return 'Board Wipe'
  if (/(destroy|exile) each [a-z ]{0,40}(creature|permanent|nonland)/.test(o)) return 'Board Wipe'
  if (/all creatures get -[x\d]+\/-[x\d]+/.test(o)) return 'Board Wipe'
  if (/each creature gets -[x\d]+\/-[x\d]+/.test(o)) return 'Board Wipe'
  if (/deals? \d+ damage to each (creature|other creature)/.test(o)) return 'Board Wipe'
  // Mass bounce (Sunderflock-style "return all X to their owners' hands")
  if (/return all [a-z' -]{0,40}(creatures|permanents|nonland)[^.]{0,40}to (their|its) owner[s'’]+ hands?/.test(o)) return 'Board Wipe'
  // Mass sacrifice (Tragic Arrogance, Wave of Vitriol, Fraying Omnipotence):
  // "each player sacrifices all/half …". Edicts ("each player sacrifices a
  // creature") stay out — sacrificing one permanent is spot removal, not a wipe.
  if (/each player sacrifices (all|half)/.test(o)) return 'Board Wipe'
  // Choose-and-keep wipes (Cataclysm, Cataclysmic Gearhulk): each player picks
  // survivors, "then sacrifices the rest".
  if (/then sacrifices the rest/.test(o)) return 'Board Wipe'

  // ── Landfall (before Ramp/Tokens so Lotus Cobra, Avenger, etc. stay here) ─
  if (/landfall ?[—-]/.test(o)) return 'Landfall'
  if (/whenever a land [^.]{0,40}enters the battlefield under [a-z ]+control/.test(o)) return 'Landfall'

  // ── Ramp (land fetch first so "Forest card" stays Ramp, not Tutor) ────────
  if (/search your library for [a-z ,]{0,40}(basic |snow |basic snow )?(lands?|forests?|plains|islands?|swamps?|mountains?|wastes?)/.test(o)) return 'Ramp'
  if (/put (a|an|up to (one|two|three|four)) [a-z ]{0,40}(land|forest|island|plains|swamp|mountain|wastes?) cards? from your hand/.test(o)) return 'Ramp'
  // "Put all land cards onto the battlefield" (Cavalier of Thorns, Borderland
  // Ranger-likes that reveal-and-fetch from the library)
  if (/put (a|an|all|up to (one|two|three|four)|\d+) [a-z ]{0,40}(land|forest|island|plains|swamp|mountain|wastes?) cards? [a-z ]{0,30}onto the battlefield/.test(o)) return 'Ramp'
  // "If it's a land card, put it onto the battlefield" (Risen Reef, Courser
  // of Kruphix). Requires the explicit "if it's a land card" gating so we
  // don't accidentally catch Show and Tell's "artifact, creature, enchantment,
  // or land card from their hand" multi-type wording.
  if (/if it'?s a land card[^.]{0,80}onto the battlefield/.test(o)) return 'Ramp'
  if (/play (an additional|two additional|up to two additional|up to three additional) lands?/.test(o)) return 'Ramp'
  if (/create [a-z\d ]{0,40}treasure tokens?/.test(o)) return 'Ramp'
  if (/create [a-z\d ]{0,40}powerstone tokens?/.test(o)) return 'Ramp'

  // ── Tutor ─────────────────────────────────────────────────────────────────
  if (/search your library for (a|an|up to (one|two|three|four)) [a-z, ]{0,40}(card|instant|sorcery|creature|artifact|enchantment|planeswalker|legendary)/.test(o)) return 'Tutor'

  // ── Sacrifice (after Tutor so Birthing Pod / Diabolic Intent stay Tutor) ──
  if (/sacrifice (a|an|another|one|two|three|\d+|x|\{[a-z\d]+\}) [a-z ]{0,30}(creature|permanent|artifact|nontoken|token)/.test(o)) return 'Sacrifice'
  if (/whenever (a|an|another) (creature|nontoken creature|permanent|nonland permanent)[a-z' ]{0,40}dies/.test(o)) return 'Sacrifice'

  // ── Blink / Flicker (before Removal so Cloudshift isn't caught as exile) ──
  if (/exile (another )?target [a-z' ]{0,30}creature[^.]{0,80}return [^.]{0,40}to the battlefield/.test(o)) return 'Blink'

  // ── Ramp (mana rocks & dorks — formerly the "Mana Rock" bucket) ───────────
  // `adds?` covers imperative "Add {G}" (Sol Ring), triggered "that player
  // adds {U}" (High Tide reprints), and "adds an additional {U}" wording.
  // The [a-z ]{0,30} between adds and {…} permits "an additional" / "two
  // mana of any color" filler without leaking into unrelated wording.
  if (t.includes('artifact') && !t.includes('creature') &&
      /(\{t\}|tap)[^.]{0,80}adds? [a-z ]{0,30}(\{|one|two|three|x mana|an amount)/.test(o)) return 'Ramp'
  if (!t.includes('land') && /adds? [a-z ]{0,30}\{[wubrgc2]/.test(o)) return 'Ramp'
  if (!t.includes('land') && /adds? [a-z ]{0,30}(one|two|three|x|\d+) mana/.test(o)) return 'Ramp'

  // ── Cost Reduction ────────────────────────────────────────────────────────
  if (/costs? (\{[\dx]+\}|one|two|three|four|five|six|seven|x|\d+) less to cast/.test(o)) return 'Cost Reduction'

  // ── Card Draw (before Discard so Wheel-of-Fortune effects stay here) ──────
  if (/draws? (a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|that many|\d+)[ a-z]{0,20}cards?/.test(o)) return 'Card Draw'
  if (/draws? cards? equal to/.test(o)) return 'Card Draw'
  if (/exile the top [a-z ]{0,20}cards?[a-z ,.'’]{0,80}you may (play|cast)/.test(o)) return 'Card Draw'
  // "Put one of them into your hand" — Mascot, Brainstorm-adjacent selection
  if (/put [a-z' ]{0,40}into your hand/.test(o)) return 'Card Draw'

  // ── Discard ───────────────────────────────────────────────────────────────
  if (/(target (opponent|player)|each (opponent|player)|opponents?) discards?/.test(o)) return 'Discard'
  if (/discards? (their hand|the rest of (their|his|her) hand|all (the )?cards)/.test(o)) return 'Discard'

  // ── Drain (life loss, often paired with life gain) ────────────────────────
  if (/(each opponent|target (opponent|player)|opponents?) loses? [a-z\d ]{0,30}life/.test(o)) return 'Drain'
  if (/loses? [x\d]+ life[^.]{0,60}gains? [x\d]+ life/.test(o)) return 'Drain'

  // ── Removal (single target) ───────────────────────────────────────────────
  // Optional `x|N` prefix catches Curse of the Swine ("Exile X target creatures").
  // Plural noun forms catch the same X-target wording.
  if (/(exile|destroy) (x |\d+ )?target [a-z ]{0,40}(creatures?|permanents?|artifacts?|enchantments?|planeswalkers?|battles?|lands?)/.test(o)) return 'Removal'
  if (/return target [a-z' ]{0,40}(creature|permanent|artifact|enchantment|planeswalker|nonland) [a-z',' ]{0,60}to (its|their) owner[s'’]+ hand/.test(o)) return 'Removal'
  // Shuffle-into-library removal (Chaos Warp). Anchored to "owner of target …"
  // so it doesn't mis-fire on self-recursion clauses like Worldspine Wurm.
  if (/owner of target [a-z ]{0,40}(permanent|creature|artifact|enchantment|planeswalker|nonland) shuffles? it into/.test(o)) return 'Removal'
  // Allows variable damage ("equal to its power", "X", etc.) before OR after
  // the word "damage" (Scryfall uses both "deals N damage to X" and the rarer
  // "deals damage equal to … to X").
  if (/deals? [a-z\d' ]{0,30}damage [a-z\d' ]{0,40}to (any target|target creature|target creature or planeswalker)/.test(o)) return 'Removal'
  if (/target creature gets -\d+\/-\d+/.test(o)) return 'Removal'

  // ── Burn (player-only damage; allows variable amounts in either position) ─
  if (/deals? [a-z\d' ]{0,30}damage [a-z\d' ]{0,40}to (target player|target opponent|each opponent|each player)/.test(o)) return 'Burn'
  // Fireball / Comet Storm wording: "deals X damage divided … among any number
  // of targets". Targets include players, so this is Burn rather than Removal.
  // The interior allows commas/digits so "divided evenly, rounded down, among"
  // (Fireball) matches alongside the simpler "divided as you choose among".
  if (/deals? [a-z\d' ]{0,30}damage divided [a-z,'\d ]{0,40}among/.test(o)) return 'Burn'
  // Post-2024 fireball wording: "Choose any target, then choose another target
  // for each time this spell was kicked. [Card] deals X damage to each of them."
  if (/deals? [a-z\d' ]{0,30}damage to (each|any) of them/.test(o)) return 'Burn'

  // ── Lifegain (after Drain/Removal/Burn so attack/damage cards win) ────────
  if (/you gain [a-z\d ]{0,20}life/.test(o)) return 'Lifegain'
  if (/whenever you gain life/.test(o)) return 'Lifegain'

  // ── Tokens ────────────────────────────────────────────────────────────────
  if (/create (a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+)[^.]{0,80}tokens?/.test(o)) return 'Tokens'
  if (/\bpopulate\b/.test(o)) return 'Tokens'

  // ── Mill (before Graveyard; library → graveyard) ──────────────────────────
  if (/puts? (the top |an? )?(\w+ )?cards? (of [a-z' ]+library |from the top of [a-z' ]+library )?into [a-z' ]+graveyard/.test(o)) return 'Mill'
  if (/mills? (a|one|two|three|four|five|six|seven|eight|nine|ten|\d+|x) cards?/.test(o)) return 'Mill'

  // ── Graveyard (reanimation / recursion) ───────────────────────────────────
  if (/(put|return) [^.]{0,80}from [a-z' ]{0,30}graveyard [a-z ]{0,20}(onto|to) [a-z ]{0,20}(battlefield|hand)/.test(o)) return 'Graveyard'
  // "Play [card type] from your graveyard" (Muldrotha, Sun Titan-likes,
  // Crucible-of-Worlds-style recursion)
  if (/play [^.]{0,80}from [a-z' ]{0,30}graveyard/.test(o)) return 'Graveyard'
  // "Cast [card] from your graveyard" (Lurrus, Yawgmoth, escape, flashback-ish)
  if (/cast [^.]{0,80}from [a-z' ]{0,30}graveyard/.test(o)) return 'Graveyard'

  // ── Stax / taxes / restriction ────────────────────────────────────────────
  if (/costs? [^.]{0,30}more to cast/.test(o)) return 'Stax'
  if (/(don'?t|doesn'?t) untap/.test(o)) return 'Stax'
  if (/(can'?t|cannot) (be cast|cast|attack|block|activate|untap)/.test(o)) return 'Stax'
  if (/whenever (a player|an opponent) [^.]{0,100}unless (they|that player|its controller) pays?/.test(o)) return 'Stax'
  if (/(lands?|nonbasic lands?) [a-z ]{0,30}(are|become) [a-z ]{0,30}(basic|plains|island|swamp|mountain|forest|wastes?)/.test(o)) return 'Stax'
  if (/players? skip [a-z ]{0,30}(untap|draw|combat) step/.test(o)) return 'Stax'

  // ── Anthem (triggered mass buff — even "until end of turn") ───────────────
  // Balmor / Goldnight Commander / Hidetsugu and Kairi pump the whole board
  // on a trigger; the buff is short-lived but the card's role is "the anthem
  // engine". Differentiator vs Giant Growth is the `whenever` trigger plus a
  // collective subject ("creatures you control" / "other X creatures").
  if (!t.includes('instant') && !t.includes('sorcery') &&
      /whenever [^.]{0,120}(creatures you control|other [a-z ]{1,30}creatures|each (other )?creature)[^.]{0,30}get \+\d+\/\+\d+/.test(o)) return 'Anthem'

  // ── Anthem (static buff; combat tricks excluded same-sentence) ────────────
  // The negative lookahead is sentence-scoped via [^.]{0,30} so an unrelated
  // "until end of turn" later in the card text (e.g. on a separate activated
  // ability) doesn't disqualify a real static anthem like Incandescent Soulstoke.
  if (!t.includes('instant') && !t.includes('sorcery') &&
      /get \+\d+\/\+\d+(?![^.]{0,30}until end of turn)/.test(o)) return 'Anthem'

  // ── +1/+1 Counters ────────────────────────────────────────────────────────
  if (/\+1\/\+1 counter/.test(o)) return '+1/+1 Counters'
  if (/\bproliferate\b/.test(o)) return '+1/+1 Counters'

  // ── Protection (before Evasion so Whispersilk Cloak stays Protection) ─────
  if (/(gain|gains|have|has) [a-z, ]{0,40}(hexproof|indestructible|shroud)/.test(o)) return 'Protection'
  if (/protection from/.test(o)) return 'Protection'
  // Redirect / change-targets (Deflecting Swat, Bolt Bend, Misdirection,
  // Redirect). These rescue your own stuff by bouncing the spell elsewhere.
  if (/(choose new targets for|change the targets? of) target [a-z ]{0,30}(spell|ability)/.test(o)) return 'Protection'

  // ── Evasion (granted unblockable / shared flying / menace) ────────────────
  if (/can'?t be blocked/.test(o)) return 'Evasion'
  if (/(gain|gains|have|has) [a-z, ]{0,30}(flying|menace|skulk|shadow|horsemanship|fear|intimidate)/.test(o)) return 'Evasion'

  // ── Cheat into play (hand → battlefield, bypasses casting cost) ──────────
  // Sneak Attack, Through the Breach, Show and Tell, Quicksilver Amulet,
  // Elvish Piper. The non-land type alternation prevents the rule from
  // hijacking Sakura-Tribe-Scout-style land plays from hand (those still
  // resolve as Ramp earlier in the ladder).
  if (/put [a-z ,]{0,80}(creature|permanent|artifact|enchantment|planeswalker)[a-z ,]{0,80}cards? from [a-z' ]+hand onto the battlefield/.test(o)) return 'Cheat'
  // Cascade keyword (Maelstrom Wanderer, Bloodbraid Elf, Imoti, Apex
  // Devastator) — exile from library and cast for free is the same archetype.
  // Note: cards like Bituminous Blast still land in Removal earlier because
  // their primary effect (destroy creature) takes priority over the cascade
  // value-tag.
  if (/\bcascade\b/.test(o)) return 'Cheat'

  // ── Extra Turns ───────────────────────────────────────────────────────────
  // Quantifier is required. `takes?` covers both imperative "Take an extra
  // turn" (Time Warp) and third-person "Target player takes two extra turns"
  // (Time Stretch reprint, Beacon of Tomorrows, Karn's Temporal Sundering).
  if (/takes? (an?|another|this|one|two|three|four|five|\d+) extra turns?/.test(o)) return 'Extra Turns'

  // ── Combo / wincon ────────────────────────────────────────────────────────
  if (/\bwins? the game\b|you win the game/.test(o)) return 'Combo'
  // Permanent theft (Display of Power, Threaten, Memnarch, Vedalken Shackles).
  // Late in the ladder so destroy/exile/bounce removal wins first.
  if (/gains? control of (target|it|that|each)/.test(o)) return 'Combo'

  // ── Type-line fallback ────────────────────────────────────────────────────
  if (t.includes('land'))         return 'Land'
  if (t.includes('creature'))     return 'Creature'
  if (t.includes('planeswalker')) return 'Planeswalker'
  if (t.includes('instant'))      return 'Instant'
  if (t.includes('sorcery'))      return 'Sorcery'
  if (t.includes('artifact'))     return 'Artifact'
  if (t.includes('enchantment'))  return 'Enchantment'
  return 'Other'
}

// Adapter for callers that have a (card, sfCard) shape — extracts oracle/type
// from either the root Scryfall object or the front face of a DFC. Falls back
// to the card row's own type_line so deck rows with no enriched Scryfall entry
// yet still get a sensible type-fallback category.
export function getCardCategoryFromCard(card, sfCard) {
  const faceOracle = sfCard?.card_faces?.map(f => f.oracle_text || '').join('\n') || ''
  const oracle = sfCard?.oracle_text || faceOracle || ''
  const typeLine = sfCard?.type_line || sfCard?.card_faces?.[0]?.type_line || card?.type_line || ''
  const keywords = sfCard?.keywords || sfCard?.card_faces?.[0]?.keywords || []
  return getCardCategory(oracle, typeLine, keywords)
}
