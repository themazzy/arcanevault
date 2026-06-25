import { describe, it, expect, vi } from 'vitest'
import {
  parseEmailOtpParams,
  isRecoveryRedirect,
  redeemEmailOtp,
  stripOtpParamsFromUrl,
} from './authRecovery'

describe('parseEmailOtpParams', () => {
  it('parses a PKCE token_hash recovery link from the query string', () => {
    const loc = { search: '?token_hash=abc123&type=recovery', hash: '' }
    expect(parseEmailOtpParams(loc)).toEqual({ tokenHash: 'abc123', type: 'recovery' })
  })

  it('parses a signup confirmation token_hash link', () => {
    const loc = { search: '?token_hash=xyz&type=signup', hash: '' }
    expect(parseEmailOtpParams(loc)).toEqual({ tokenHash: 'xyz', type: 'signup' })
  })

  it('falls back to the hash for legacy implicit-flow links', () => {
    const loc = { search: '', hash: '#token_hash=hh&type=recovery' }
    expect(parseEmailOtpParams(loc)).toEqual({ tokenHash: 'hh', type: 'recovery' })
  })

  it('returns null when there is no token_hash', () => {
    expect(parseEmailOtpParams({ search: '?type=recovery', hash: '' })).toBeNull()
    expect(parseEmailOtpParams({ search: '?code=abc', hash: '' })).toBeNull()
    expect(parseEmailOtpParams({ search: '', hash: '' })).toBeNull()
  })
})

describe('isRecoveryRedirect', () => {
  it('detects recovery in the query string (PKCE token_hash link)', () => {
    expect(isRecoveryRedirect({ search: '?token_hash=abc&type=recovery', hash: '' })).toBe(true)
  })

  it('detects recovery in the hash (legacy implicit link)', () => {
    expect(isRecoveryRedirect({ search: '', hash: '#type=recovery' })).toBe(true)
  })

  it('is false for non-recovery links', () => {
    expect(isRecoveryRedirect({ search: '?type=signup', hash: '' })).toBe(false)
    expect(isRecoveryRedirect({ search: '?code=abc', hash: '' })).toBe(false)
    expect(isRecoveryRedirect({ search: '', hash: '' })).toBe(false)
  })
})

describe('redeemEmailOtp', () => {
  it('calls verifyOtp with token_hash + type (no code_verifier needed)', async () => {
    const verifyOtp = vi.fn().mockResolvedValue({ data: {}, error: null })
    const sb = { auth: { verifyOtp } }
    await redeemEmailOtp(sb, { tokenHash: 'tok', type: 'recovery' })
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: 'tok' })
  })
})

describe('stripOtpParamsFromUrl', () => {
  it('removes token_hash/token/type from the URL bar', () => {
    const replaceState = vi.fn()
    const win = {
      location: { href: 'https://deckloom.app/?token_hash=abc&type=recovery&foo=1' },
      history: { replaceState },
    }
    stripOtpParamsFromUrl(win)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?foo=1')
  })

  it('does nothing when there are no OTP params', () => {
    const replaceState = vi.fn()
    const win = {
      location: { href: 'https://deckloom.app/collection' },
      history: { replaceState },
    }
    stripOtpParamsFromUrl(win)
    expect(replaceState).not.toHaveBeenCalled()
  })
})
