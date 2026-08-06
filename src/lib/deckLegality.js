import { offColorIdentity } from './deckCommanderRules'

// Number words Wizards uses in "A deck can have up to N cards named …".
// Printed limits top out at nine today (Nazgûl); the rest is cheap headroom so
// a future card doesn't need a code change.
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
}

const ANY_NUMBER_RE = /a deck can have any number of cards named/i
const UP_TO_RE = /a deck can have up to (\d+|[a-z]+) cards named/i
const ONLY_ONE_RE = /a deck can have only one card named/i

function copyLimitFromText(text) {
  const t = String(text || '')
  if (!t) return null
  // "any number of cards named X" (Relentless Rats, Dragon's Approach, …).
  if (ANY_NUMBER_RE.test(t)) return Infinity
  // "up to nine cards named Nazgûl", "up to seven cards named Seven Dwarves".
  const upTo = t.match(UP_TO_RE)
  if (upTo) {
    const raw = upTo[1].toLowerCase()
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw]
    if (n > 0) return n
  }
  if (ONLY_ONE_RE.test(t)) return 1
  return null
}

// How many copies of a card a deck may contain when its own rules text
// overrides the format's singleton/4-of rule. Accepts oracle text or a card
// object (double-faced cards keep their text on `card_faces`).
//
// Returns `Infinity` for "any number", a finite count for "up to N", and
// `null` when the card says nothing — callers apply the format default then.
export function getDeckCopyLimit(source) {
  if (!source) return null
  if (typeof source === 'string') return copyLimitFromText(source)
  const fromMain = copyLimitFromText(source.oracle_text)
  if (fromMain != null) return fromMain
  for (const face of Array.isArray(source.card_faces) ? source.card_faces : []) {
    const fromFace = copyLimitFromText(face?.oracle_text)
    if (fromFace != null) return fromFace
  }
  return null
}

// `rulebreakers` is an optional context from getCommanderRuleContext() carrying
// the commander's Rulebreaker exemptions (MBC). Omitting it applies the plain
// Commander color-identity rule, which is what every non-EDH caller wants.
export function getCardLegalityWarnings({
  card,
  formatId,
  formatLabel,
  isEDH = false,
  commanderColorIdentity = [],
  rulebreakers = null,
} = {}) {
  if (!card) return []

  const warnings = []
  const cardName = card.name || 'This card'
  const allowed = Array.isArray(commanderColorIdentity) ? commanderColorIdentity : []

  // A colorless commander with a Rulebreaker still restricts the deck, so the
  // check must run on an empty identity too whenever exemptions are in play.
  if (isEDH && (allowed.length > 0 || rulebreakers?.active)) {
    const outside = offColorIdentity(card, allowed, rulebreakers)
    if (outside.length) {
      warnings.push({
        reason: 'color_identity',
        text: `${cardName} is outside commander color identity (${outside.join('')}).`,
      })
    }
  }

  const legality = card.legalities?.[formatId]
  if (legality === 'not_legal' || legality === 'banned') {
    warnings.push({
      reason: 'format_legality',
      text: `${cardName} is ${legality.replace(/_/g, ' ')} in ${formatLabel || formatId || 'this format'}.`,
    })
  }

  return warnings
}
