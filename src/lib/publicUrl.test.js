import { describe, it, expect } from 'vitest'
import { getProdAppUrl } from './publicUrl'

// getPublicBaseUrl / getPublicAppUrl depend on import.meta.env at module-load
// time, so they're awkward to mock without a vitest env setup per file. The
// behaviour we most care about preserving — that email-flow URLs always hit
// production — lives in getProdAppUrl, which has no env dependency.

describe('getProdAppUrl', () => {
  it('always returns the prod origin regardless of build env', () => {
    expect(getProdAppUrl('/'))                .toBe('https://deckloom.app/')
    expect(getProdAppUrl('/reset-password'))  .toBe('https://deckloom.app/reset-password')
    expect(getProdAppUrl(''))                 .toBe('https://deckloom.app/')
  })

  it('normalises paths without a leading slash', () => {
    expect(getProdAppUrl('confirm')).toBe('https://deckloom.app/confirm')
  })

  it('preserves an explicit leading slash without doubling it', () => {
    expect(getProdAppUrl('/confirm')).toBe('https://deckloom.app/confirm')
  })
})
