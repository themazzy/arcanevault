import { describe, it, expect } from 'vitest'
import { describePasswordProblem, evaluatePassword } from './passwordFeedback'

const weak = (message, reasons) => Object.assign(new Error(message), { code: 'weak_password', reasons })

describe('describePasswordProblem', () => {
  it('turns the raw character-set dump into a readable checklist', () => {
    const detail = describePasswordProblem(weak(
      'Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, ABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789.',
      ['characters'],
    ))
    expect(detail.requirements).toEqual([
      'One lowercase letter (a–z)',
      'One uppercase letter (A–Z)',
      'One number (0–9)',
    ])
    // The unbreakable alphabet runs must not survive into the rendered text.
    expect(detail.requirements.join(' ')).not.toContain('abcdefghij')
  })

  it('reports which rules the server requires, by id', () => {
    const detail = describePasswordProblem(weak(
      'Password should be at least 10 characters. Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, 0123456789.',
      ['length', 'characters'],
    ))
    expect(detail.ruleIds).toEqual(['lowercase', 'digit'])
    expect(detail.minLength).toBe(10)
  })

  it('detects the symbol set even though it contains commas', () => {
    const detail = describePasswordProblem(weak(
      'Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, 0123456789, !@#$%^&*()_+-=[]{};\':"|<>?,./`~.',
      ['characters'],
    ))
    expect(detail.requirements).toEqual([
      'One lowercase letter (a–z)',
      'One number (0–9)',
      'One symbol (for example ! ? @ #)',
    ])
  })

  it('reports the length the server asked for', () => {
    const detail = describePasswordProblem(weak('Password should be at least 10 characters.', ['length']))
    expect(detail.requirements).toEqual(['At least 10 characters'])
  })

  it('falls back to the configured minimum when only a reason code is given', () => {
    const detail = describePasswordProblem({ message: 'Weak password', reasons: ['length'] }, { minLength: 8 })
    expect(detail.requirements).toEqual(['At least 8 characters'])
  })

  it('combines length and character requirements', () => {
    const detail = describePasswordProblem(weak(
      'Password should be at least 8 characters. Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, 0123456789.',
      ['length', 'characters'],
    ))
    expect(detail.requirements).toEqual([
      'At least 8 characters',
      'One lowercase letter (a–z)',
      'One number (0–9)',
    ])
  })

  it('explains a breached password', () => {
    const detail = describePasswordProblem(weak(
      'Password is known to be weak and easy to guess, please choose a different one.',
      ['pwned'],
    ))
    expect(detail.requirements).toHaveLength(1)
    expect(detail.requirements[0]).toMatch(/data breach/)
  })

  it('returns null for unrelated auth errors so they render as plain text', () => {
    expect(describePasswordProblem(new Error('Invalid login credentials'))).toBeNull()
    expect(describePasswordProblem('')).toBeNull()
    expect(describePasswordProblem(null)).toBeNull()
  })
})

describe('evaluatePassword', () => {
  it('marks the length rule as required and the character rules as suggestions', () => {
    const { required, suggested, allRequiredMet } = evaluatePassword('abcdefgh')
    expect(required).toEqual([{ id: 'length', label: 'At least 8 characters', met: true }])
    expect(suggested.map((rule) => [rule.id, rule.met])).toEqual([
      ['lowercase', true],
      ['uppercase', false],
      ['digit', false],
      ['symbol', false],
    ])
    // Unmet suggestions must never block submission.
    expect(allRequiredMet).toBe(true)
  })

  it('fails the length rule below the minimum', () => {
    expect(evaluatePassword('abc').allRequiredMet).toBe(false)
    expect(evaluatePassword('abcdefg', { minLength: 10 }).required[0].met).toBe(false)
  })

  it('adds a match rule only when there is a confirmation field', () => {
    expect(evaluatePassword('abcdefgh').required.some((rule) => rule.id === 'match')).toBe(false)

    const mismatched = evaluatePassword('abcdefgh', { confirmation: 'abcdefgi' })
    expect(mismatched.required.at(-1)).toEqual({ id: 'match', label: 'Both passwords match', met: false })
    expect(mismatched.allRequiredMet).toBe(false)

    expect(evaluatePassword('abcdefgh', { confirmation: 'abcdefgh' }).allRequiredMet).toBe(true)
  })

  it('does not call two empty fields a match', () => {
    expect(evaluatePassword('', { confirmation: '' }).required.at(-1).met).toBe(false)
  })

  it('promotes server-required rules out of the suggestions and blocks on them', () => {
    const result = evaluatePassword('abcdefgh', { requiredRuleIds: ['uppercase', 'digit'] })
    expect(result.required.map((rule) => rule.id)).toEqual(['length', 'uppercase', 'digit'])
    expect(result.suggested.map((rule) => rule.id)).toEqual(['lowercase', 'symbol'])
    expect(result.allRequiredMet).toBe(false)
    expect(evaluatePassword('Abcdefg1', { requiredRuleIds: ['uppercase', 'digit'] }).allRequiredMet).toBe(true)
  })

  it('detects each character class', () => {
    const met = (pw) => evaluatePassword(pw).suggested.filter((rule) => rule.met).map((rule) => rule.id)
    expect(met('ABCDEFGH')).toEqual(['uppercase'])
    expect(met('12345678')).toEqual(['digit'])
    expect(met('!@#$%^&*')).toEqual(['symbol'])
    expect(met('Passw0rd!')).toEqual(['lowercase', 'uppercase', 'digit', 'symbol'])
  })

  it('survives a missing password', () => {
    expect(evaluatePassword(undefined).allRequiredMet).toBe(false)
  })
})
