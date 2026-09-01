import { describe, expect, it } from 'vitest'
import { computeUserRates } from '../../supabase/functions/admin-traffic-summary/userMetrics.ts'

describe('computeUserRates', () => {
  it('measures activation against everyone who signed up', () => {
    // 26 of 38 accounts ever created something.
    expect(computeUserRates({ accounts: 38, activated: 26, returning: 18 }).activation_rate).toBe(68)
  })

  it('measures return rate against people who started, not all accounts', () => {
    // 18 of the 26 who started came back — 69%, not 47% of all accounts.
    // Someone who signed up and never opened anything has not churned from the
    // product; they never tried it. Folding them in would hide a good retention
    // number behind a marketing problem.
    const rates = computeUserRates({ accounts: 38, activated: 26, returning: 18 })
    expect(rates.return_rate).toBe(69)
    expect(rates.return_rate).not.toBe(47)
  })

  it('reports null rather than 0% when there is nothing to measure', () => {
    // On a fresh install "0% came back" reads as a product failure. The UI
    // renders null as an em dash instead.
    expect(computeUserRates({ accounts: 0, activated: 0, returning: 0 })).toEqual({
      activation_rate: null,
      return_rate: null,
    })
  })

  it('reports a null return rate while nobody has started yet', () => {
    const rates = computeUserRates({ accounts: 5, activated: 0, returning: 0 })
    expect(rates.activation_rate).toBe(0)
    expect(rates.return_rate).toBeNull()
  })

  it('handles a missing or malformed totals object', () => {
    for (const input of [null, undefined, {}, { accounts: 'x', activated: null }]) {
      expect(computeUserRates(input)).toEqual({ activation_rate: null, return_rate: null })
    }
  })

  it('rounds to whole percents', () => {
    expect(computeUserRates({ accounts: 3, activated: 1, returning: 0 }).activation_rate).toBe(33)
    expect(computeUserRates({ accounts: 3, activated: 2, returning: 0 }).activation_rate).toBe(67)
  })

  it('caps out at 100 when everyone activated and returned', () => {
    const rates = computeUserRates({ accounts: 4, activated: 4, returning: 4 })
    expect(rates).toEqual({ activation_rate: 100, return_rate: 100 })
  })
})
