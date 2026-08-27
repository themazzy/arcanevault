// Age self-declaration, recorded once per account.
//
// The signup form's checkbox only covers the email path. The Google and Discord
// buttons sit above the Sign in / Create account tabs and serve both, so a click
// carries no signal about whether an account is being created — someone can
// reach a working account without the form ever rendering. Deep links and any
// future provider have the same property.
//
// So the declaration is a property of the *account*, checked after
// authentication, rather than a field on one form. The form still sets it at
// signup so those users are never asked twice.
//
// Stored in Supabase `user_metadata`, matching how `setup_completed` already
// gates the setup wizard. That field is writable by the user it belongs to,
// which is fine here: this is a statement someone makes about themselves, and
// there is nothing to gain by forging your own declaration. A timestamp rather
// than a boolean, so it is possible to say when the declaration was made.

// GDPR Art 8 sets 16 as the consent age unless a member state lowered it
// (13-16 across the EU). The applicable age is the *user's* country, not the
// operator's, so the highest value is the only one correct everywhere.
export const MINIMUM_AGE = 16

export const AGE_CONFIRMED_FIELD = 'age_confirmed_at'

// Accounts that existed before the gate shipped are treated as already
// declared, so nobody is interrupted mid-use by a question about an account
// they have had for months. Only accounts created from this moment on are
// asked. A deliberate trade: those older accounts never actually made the
// declaration, so this grandfathers them rather than evidencing them.
export const GATE_ACTIVE_FROM = Date.parse('2026-08-27T19:00:00.000Z')

/** The value written when someone confirms. Exported so signup and the gate agree. */
export function ageConfirmationValue(now = new Date()) {
  return now.toISOString()
}

/**
 * True when this account must be asked: no recorded declaration, and created
 * after the gate shipped. A signed-out visitor is never asked, so public pages
 * stay public.
 */
export function needsAgeConfirmation(user) {
  if (!user) return false
  if (isValidConfirmation(user?.user_metadata?.[AGE_CONFIRMED_FIELD])) return false

  // An account older than the gate is grandfathered. An unreadable or absent
  // created_at is treated the same way: that is a data anomaly, and locking
  // someone out of their account over it would be a worse failure than not
  // asking.
  const createdAt = Date.parse(user?.created_at ?? '')
  if (!Number.isFinite(createdAt)) return false
  return createdAt >= GATE_ACTIVE_FROM
}

/** Guards against a blank string, a stray boolean, or an unparseable date. */
export function isValidConfirmation(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  return Number.isFinite(Date.parse(value))
}
