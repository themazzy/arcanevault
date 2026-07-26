import { describe, it, expect } from 'vitest'
import { changePrintingErrorMessage, DUPLICATE_PRINTING_MESSAGE } from './changePrinting'

describe('changePrintingErrorMessage', () => {
  it('passes the RPC\'s own refusal through untouched', () => {
    // The function raises this text itself with errcode 23505.
    expect(changePrintingErrorMessage({ code: '23505', message: DUPLICATE_PRINTING_MESSAGE }))
      .toBe(DUPLICATE_PRINTING_MESSAGE)
  })

  it('rewrites a raw Postgres unique violation', () => {
    const err = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "cards_unique_owned_print_idx"',
    }
    expect(changePrintingErrorMessage(err)).toBe(DUPLICATE_PRINTING_MESSAGE)
  })

  it('keeps unrelated errors legible', () => {
    expect(changePrintingErrorMessage({ message: 'Owned card not found.' })).toBe('Owned card not found.')
    expect(changePrintingErrorMessage(new Error('Failed to fetch'))).toBe('Failed to fetch')
  })

  it('falls back for empty or missing errors', () => {
    expect(changePrintingErrorMessage(null)).toBe('Could not save those changes.')
    expect(changePrintingErrorMessage({})).toBe('Could not save those changes.')
    expect(changePrintingErrorMessage({ message: '   ' })).toBe('Could not save those changes.')
  })
})
