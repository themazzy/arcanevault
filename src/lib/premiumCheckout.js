import { sb } from './supabase'

// ── Payments kill switch ─────────────────────────────────────────────────────
// Contributions are switched OFF until DeckLoom is registered to take payments
// with the Bulgarian authorities. While this is false no user may reach Stripe:
// startPremiumCheckout() refuses before the edge function is invoked, so there
// is no code path that can produce a Checkout URL, and every support surface
// reads the flag to render "coming soon" instead of a contribute button.
//
// **This is treated as a sale, not a donation** (decided 2026-08-28). Calling it
// a donation would not change the tax treatment: the themes are unlocked *by*
// paying, so there is a direct link between payment and benefit, which makes it
// a supply of digital services whatever the button says. The Terms are written
// accordingly, including the withdrawal-right waiver.
//
// Flipping this to true is therefore not just a code change. Three things must
// be in place first, and none of them is enforced by anything here:
//
//   1. VAT registration — B2C digital services are taxed in the buyer's country.
//      Below the €10,000/year cross-border threshold (VAT Directive Art 59c)
//      Bulgarian rules may apply instead of OSS; confirm with an accountant.
//   2. A geographic address published on /terms and /privacy — required by the
//      e-Commerce Directive Art 5 and consumer law once a commercial service is
//      offered. Deliberately absent while payments are off.
//   3. The Terms' "not currently available" wording removed.
//
// Deliberately staying off until the user base makes that admin worth doing.
export const PAYMENTS_ENABLED = false

export const SUPPORT_COMING_SOON_TITLE = 'Supporter themes — coming soon'
export const SUPPORT_COMING_SOON_TEXT =
  'Donations are not open yet. Every product feature is free and always will be; ' +
  'once donations open you will be able to chip in and receive the cosmetic supporter ' +
  'themes as a thank-you.'
export const SUPPORT_COMING_SOON_SHORT = 'Supporter themes are coming soon.'

/**
 * Starts the one-time premium checkout.
 * Returns { ok, url } on success, or { ok: false, disabled?, error } otherwise.
 * Never contacts Stripe while PAYMENTS_ENABLED is false.
 */
export async function startPremiumCheckout({ user, successUrl, cancelUrl } = {}) {
  if (!PAYMENTS_ENABLED) {
    return { ok: false, disabled: true, error: SUPPORT_COMING_SOON_SHORT }
  }
  if (!user) {
    return { ok: false, error: 'Sign in before donating for supporter themes.' }
  }
  try {
    const { data, error } = await sb.functions.invoke('stripe-create-checkout', {
      body: { successUrl, cancelUrl },
    })
    if (error) throw new Error(await checkoutErrorMessage(error, 'Could not start Stripe Checkout.'))
    if (!data?.url) throw new Error('Stripe did not return a checkout URL.')
    return { ok: true, url: data.url }
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not start Stripe Checkout.' }
  }
}

async function checkoutErrorMessage(error, fallback) {
  try {
    const response = error?.context
    if (response && typeof response.json === 'function') {
      const body = await response.clone().json()
      return body?.details || body?.error || error?.message || fallback
    }
  } catch {}
  return error?.message || fallback
}
