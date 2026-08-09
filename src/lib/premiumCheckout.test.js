import { describe, it, expect, vi, beforeEach } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./supabase', () => ({ sb: { functions: { invoke } } }))

import { PAYMENTS_ENABLED, startPremiumCheckout, SUPPORT_COMING_SOON_SHORT } from './premiumCheckout'

describe('startPremiumCheckout', () => {
  beforeEach(() => { invoke.mockReset() })

  it('never contacts Stripe while payments are switched off', async () => {
    if (PAYMENTS_ENABLED) return // guard flipped back on: this case no longer applies
    const result = await startPremiumCheckout({
      user: { id: 'u1' },
      successUrl: 'https://deckloom.app/settings',
      cancelUrl: 'https://deckloom.app/settings',
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, disabled: true, error: SUPPORT_COMING_SOON_SHORT })
  })

  it('reports the checkout URL when payments are on', async () => {
    if (!PAYMENTS_ENABLED) return
    invoke.mockResolvedValue({ data: { url: 'https://checkout.stripe.com/x' }, error: null })
    const result = await startPremiumCheckout({ user: { id: 'u1' } })
    expect(result).toEqual({ ok: true, url: 'https://checkout.stripe.com/x' })
  })
})
