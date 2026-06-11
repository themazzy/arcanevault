import { describe, it, expect, vi, afterEach } from 'vitest'
import { getProdAppUrl, getPublicAppUrl } from './publicUrl'

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

afterEach(() => vi.unstubAllGlobals())

describe('getPublicAppUrl (deck share links)', () => {
  // The og-deck edge function was removed: deck share links must be the
  // direct branded /d/<id> URL, never a *.supabase.co function URL.
  it('builds the direct /d/<id> URL from the current origin', () => {
    vi.stubGlobal('window', { location: { origin: 'https://deckloom.app' } })
    expect(getPublicAppUrl('/d/abc-123')).toBe('https://deckloom.app/d/abc-123')
  })

  it('never routes share links through a supabase functions URL', () => {
    vi.stubGlobal('window', { location: { origin: 'https://deckloom.app' } })
    expect(getPublicAppUrl('/d/abc-123')).not.toContain('functions/v1')
    expect(getPublicAppUrl('/d/abc-123')).not.toContain('og-deck')
  })
})
