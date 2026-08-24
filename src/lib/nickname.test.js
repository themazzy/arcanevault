import { describe, it, expect } from 'vitest'
import {
  NICKNAME_MAX_LENGTH, validateNickname, isSameNickname, isNicknameAvailable,
  checkNicknameForSave, isNicknameTakenError,
} from './nickname'

describe('validateNickname', () => {
  it('accepts a URL-safe handle and hands back the trimmed value', () => {
    expect(validateNickname('Mystic_Goblin-47')).toEqual({ ok: true, value: 'Mystic_Goblin-47', error: '' })
    expect(validateNickname('Jan\n').value).toBe('Jan')
  })

  it('rejects characters that would not survive a profile URL', () => {
    for (const bad of ['Jan Mazanek', 'jan@home', 'jan/deck', 'jän', 'jan?x=1']) {
      expect(validateNickname(bad).ok).toBe(false)
    }
  })

  it('trims around a handle but rejects a space inside one', () => {
    expect(validateNickname('  Jane  ')).toEqual({ ok: true, value: 'Jane', error: '' })
    expect(validateNickname('Ja ne').ok).toBe(false)
  })

  it('rejects a handle longer than the field cap', () => {
    expect(validateNickname('a'.repeat(NICKNAME_MAX_LENGTH)).ok).toBe(true)
    expect(validateNickname('a'.repeat(NICKNAME_MAX_LENGTH + 1)).ok).toBe(false)
  })

  it('allows a blank nickname only where one is optional', () => {
    // Settings: a user may clear it.
    expect(validateNickname('').ok).toBe(true)
    expect(validateNickname('   ').ok).toBe(true)
    // Profile: the nickname is the address of the page being edited.
    expect(validateNickname('', { required: true }).ok).toBe(false)
    expect(validateNickname('   ', { required: true }).ok).toBe(false)
  })
})

describe('isSameNickname', () => {
  it('treats case and surrounding space as the same handle', () => {
    expect(isSameNickname('Jan', 'jan')).toBe(true)
    expect(isSameNickname(' Jan ', 'JAN')).toBe(true)
  })

  it('separates genuinely different handles, and tolerates absent ones', () => {
    expect(isSameNickname('Jan', 'Jane')).toBe(false)
    expect(isSameNickname('Jan', null)).toBe(false)
    expect(isSameNickname(undefined, undefined)).toBe(true)
  })
})

describe('isNicknameAvailable', () => {
  const clientAnswering = (result, calls = []) => ({
    rpc: async (name, args) => { calls.push([name, args]); return result },
  })

  it('asks is_username_available with the trimmed handle', async () => {
    const calls = []
    expect(await isNicknameAvailable('  Jan  ', { client: clientAnswering({ data: true }, calls) })).toBe(true)
    expect(calls).toEqual([['is_username_available', { p_username: 'Jan' }]])
  })

  it('reports a taken handle as unavailable', async () => {
    expect(await isNicknameAvailable('Jan', { client: clientAnswering({ data: false }) })).toBe(false)
  })

  it('throws when the lookup fails, so a caller cannot read it as "taken"', async () => {
    const failing = clientAnswering({ data: null, error: { message: 'timeout' } })
    await expect(isNicknameAvailable('Jan', { client: failing })).rejects.toBeTruthy()
  })
})

describe('checkNicknameForSave', () => {
  const clientAnswering = (result, calls = []) => ({
    rpc: async (name, args) => { calls.push([name, args]); return result },
  })

  it('refuses a blank handle without asking the server', async () => {
    const calls = []
    const res = await checkNicknameForSave('  ', { current: 'Jan', client: clientAnswering({ data: true }, calls) })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('invalid')
    expect(calls).toEqual([])
  })

  it('refuses an illegal handle without asking the server', async () => {
    const calls = []
    const res = await checkNicknameForSave('jan mazanek', { current: 'Jan', client: clientAnswering({ data: true }, calls) })
    expect(res.reason).toBe('invalid')
    expect(calls).toEqual([])
  })

  it('skips the round trip when the handle is unchanged, re-casing included', async () => {
    const calls = []
    const res = await checkNicknameForSave('JAN', { current: 'jan', client: clientAnswering({ data: false }, calls) })
    expect(res).toEqual({ ok: true, value: 'JAN', changed: false })
    expect(calls).toEqual([])
  })

  it('reports a taken handle as taken, not as invalid', async () => {
    const res = await checkNicknameForSave('Jane', { current: 'Jan', client: clientAnswering({ data: false }) })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('taken')
  })

  it('separates an unreachable check from a rejected name', async () => {
    const failing = { rpc: async () => ({ data: null, error: { message: 'timeout' } }) }
    const res = await checkNicknameForSave('Jane', { current: 'Jan', client: failing })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('unreachable')
  })

  it('passes a free, changed handle through as changed', async () => {
    const res = await checkNicknameForSave(' Jane ', { current: 'Jan', client: clientAnswering({ data: true }) })
    expect(res).toEqual({ ok: true, value: 'Jane', changed: true })
  })
})

describe('isNicknameTakenError', () => {
  it('recognises only the unique-violation code', () => {
    expect(isNicknameTakenError({ code: '23505' })).toBe(true)
    expect(isNicknameTakenError({ code: '23503' })).toBe(false)
    expect(isNicknameTakenError(null)).toBe(false)
  })
})
