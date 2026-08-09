import { sb } from './supabase'

// ── Payments kill switch ─────────────────────────────────────────────────────
// Donations are switched OFF until DeckLoom is registered to take payments with
// the Bulgarian authorities. While this is false no user may reach Stripe:
// startPremiumCheckout() refuses before the edge function is invoked, so there
// is no code path that can produce a Checkout URL, and every support surface
// reads the flag to render "coming soon" instead of a donate button.
//
// Flip to true (only) once the registration is in place — nothing else needs to
// change; the existing checkout + webhook entitlement flow is left intact.
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
