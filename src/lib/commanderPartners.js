// Partner / background detection for the guided commander picker.
//
// A commander can share the command zone with a second card via several
// mechanics. We detect which one a chosen commander has from its oracle text /
// type line and build the Scryfall search that lists its LEGAL partners, so the
// picker can offer a filtered second-commander search bar.
//
// Mechanics covered:
//   • Partner              — pairs with any other card that has Partner
//   • Partner with [name]  — has Partner (so pairs with any Partner), and names
//                            a specific intended partner we pin to the top
//   • Friends forever      — pairs only with other Friends forever cards
//   • Choose a Background   — pairs with a Background (Enchantment — Background)
//   • Doctor's companion    — pairs with a Time Lord Doctor
//   • Doctor (Time Lord Doctor) — pairs with a card that has Doctor's companion
//   • Partner — [group]    — restricted partner; treated as generic Partner for
//                            the query (the group is rare and hard to filter on)
//
// Pure + framework-free so it can be unit-tested and shared.

// Combined oracle text across every face (MDFC/transform commanders keep the
// partner keyword on one face). Top-level text is included too.
function allOracle(card) {
  const parts = []
  if (card?.oracle_text) parts.push(card.oracle_text)
  for (const f of card?.card_faces || []) if (f?.oracle_text) parts.push(f.oracle_text)
  return parts.join('\n')
}

// Combined type line across faces.
function allTypes(card) {
  const parts = []
  if (card?.type_line) parts.push(card.type_line)
  for (const f of card?.card_faces || []) if (f?.type_line) parts.push(f.type_line)
  return parts.join(' // ')
}

/**
 * Detect the partner mechanic of a commander card.
 * @returns {{type: string, label: string, name?: string, group?: string} | null}
 *   null when the card has no partner-style ability.
 */
export function detectPartnerType(card) {
  if (!card) return null
  const text = allOracle(card)
  const types = allTypes(card)
  if (!text && !types) return null

  // Order matters: the specific mechanics are checked before generic "partner",
  // and "partner with" before the restricted "partner — group".
  if (/choose a background/i.test(text)) {
    return { type: 'choose-background', label: 'Choose a Background' }
  }
  if (/friends forever/i.test(text)) {
    return { type: 'friends-forever', label: 'Friends forever' }
  }
  if (/doctor's companion/i.test(text)) {
    return { type: 'doctor-companion', label: "Doctor's companion" }
  }
  if (/\btime lord doctor\b/i.test(types)) {
    return { type: 'doctor', label: 'Doctor' }
  }

  const withMatch = text.match(/partner with ([^\n(.]+)/i)
  if (withMatch) {
    const name = withMatch[1].trim()
    return { type: 'partner-with', name, label: `Partner with ${name}` }
  }

  // Restricted "Partner — Father & Son" style (em dash or hyphen).
  const groupMatch = text.match(/\bpartner\s*[—–-]\s*([^\n(.]+)/i)
  if (groupMatch) {
    const group = groupMatch[1].trim()
    return { type: 'partner-group', group, label: `Partner — ${group}` }
  }

  if (/\bpartner\b/i.test(text)) {
    return { type: 'partner', label: 'Partner' }
  }
  return null
}

// Escape a name for a quoted Scryfall term.
function q(str) {
  return String(str || '').replace(/"/g, '')
}

/**
 * Build the Scryfall search query listing legal partners for a commander.
 * @param {object} descriptor  result of detectPartnerType
 * @param {string} commanderName  excluded from results (a card can't partner itself)
 * @param {string} typed  optional name filter from the second search bar
 * @returns {string|null}  the `q` value, or null when there's nothing to search
 */
export function legalPartnerQuery(descriptor, commanderName, typed = '') {
  if (!descriptor) return null
  const parts = []
  switch (descriptor.type) {
    case 'choose-background':
      parts.push('type:background')
      break
    case 'friends-forever':
      parts.push('oracle:"friends forever"', 'is:commander')
      break
    case 'doctor-companion':
      parts.push('type:"time lord doctor"', 'is:commander')
      break
    case 'doctor':
      parts.push('oracle:"doctor\'s companion"', 'is:commander')
      break
    case 'partner-group':
    case 'partner-with':
    case 'partner':
    default:
      parts.push('is:partner', 'is:commander')
      break
  }
  // Format legality so a banned card is never offered.
  parts.push('legal:commander')
  if (commanderName) parts.push(`-!"${q(commanderName)}"`)
  const t = String(typed || '').trim()
  if (t) parts.push(`name:"${q(t)}"`)
  return parts.join(' ')
}

// Human-readable one-liner explaining the pairing for the picker header.
export function partnerHint(descriptor) {
  if (!descriptor) return ''
  switch (descriptor.type) {
    case 'choose-background': return 'Pick a Background to accompany this commander.'
    case 'friends-forever':   return 'Pair with another “Friends forever” commander.'
    case 'doctor-companion':  return 'Pair with a Time Lord Doctor.'
    case 'doctor':            return 'Pair with a commander that has “Doctor’s companion”.'
    case 'partner-with':      return `Suggested pairing: ${descriptor.name}. You can also pick any Partner.`
    case 'partner-group':     return 'Pair with a matching Partner commander.'
    case 'partner':           return 'Pair with any other Partner commander.'
    default:                  return ''
  }
}
