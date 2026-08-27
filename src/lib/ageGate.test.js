import { describe, expect, it } from 'vitest'
import {
  AGE_CONFIRMED_FIELD,
  GATE_ACTIVE_FROM,
  MINIMUM_AGE,
  ageConfirmationValue,
  isValidConfirmation,
  needsAgeConfirmation,
} from './ageGate'

const NEW_ACCOUNT = new Date(GATE_ACTIVE_FROM + 86400000).toISOString()
const OLD_ACCOUNT = new Date(GATE_ACTIVE_FROM - 86400000).toISOString()

const withConfirmation = value => ({
  created_at: NEW_ACCOUNT,
  user_metadata: { [AGE_CONFIRMED_FIELD]: value },
})

describe('needsAgeConfirmation', () => {
  it('asks a new account that has never confirmed', () => {
    expect(needsAgeConfirmation({ created_at: NEW_ACCOUNT, user_metadata: {} })).toBe(true)
    expect(needsAgeConfirmation({ created_at: NEW_ACCOUNT })).toBe(true)
  })

  it('never interrupts an account that predates the gate', () => {
    // Existing users are grandfathered rather than asked mid-use.
    expect(needsAgeConfirmation({ created_at: OLD_ACCOUNT, user_metadata: {} })).toBe(false)
    expect(needsAgeConfirmation({ created_at: OLD_ACCOUNT })).toBe(false)
  })

  it('does not lock anyone out when created_at is missing or unreadable', () => {
    // A data anomaly should not trap someone on the gate.
    expect(needsAgeConfirmation({ user_metadata: {} })).toBe(false)
    expect(needsAgeConfirmation({ created_at: 'nonsense' })).toBe(false)
    expect(needsAgeConfirmation({ created_at: null })).toBe(false)
  })

  it('does not ask again once a confirmation is recorded', () => {
    expect(needsAgeConfirmation(withConfirmation('2026-08-27T18:00:00.000Z'))).toBe(false)
  })

  it('never asks a signed-out visitor, so public pages stay public', () => {
    expect(needsAgeConfirmation(null)).toBe(false)
    expect(needsAgeConfirmation(undefined)).toBe(false)
  })

  it('re-asks a new account when the stored value is not a usable timestamp', () => {
    // A blank string or a stray boolean must not read as a confirmation.
    expect(needsAgeConfirmation(withConfirmation(''))).toBe(true)
    expect(needsAgeConfirmation(withConfirmation('   '))).toBe(true)
    expect(needsAgeConfirmation(withConfirmation(true))).toBe(true)
    expect(needsAgeConfirmation(withConfirmation('yes'))).toBe(true)
    expect(needsAgeConfirmation(withConfirmation(null))).toBe(true)
  })
})

describe('ageConfirmationValue', () => {
  it('records when the declaration was made, not just that it was', () => {
    const at = new Date('2026-08-27T18:30:00.000Z')
    expect(ageConfirmationValue(at)).toBe('2026-08-27T18:30:00.000Z')
  })

  it('produces a value the gate accepts', () => {
    expect(isValidConfirmation(ageConfirmationValue())).toBe(true)
    expect(needsAgeConfirmation(withConfirmation(ageConfirmationValue()))).toBe(false)
  })
})

describe('MINIMUM_AGE', () => {
  it('is the GDPR Art 8 default, the only value correct across the whole EU', () => {
    // Member states may lower it to 13, so the highest is the safe one; a
    // change here is a legal decision, not a tweak.
    expect(MINIMUM_AGE).toBe(16)
  })
})
