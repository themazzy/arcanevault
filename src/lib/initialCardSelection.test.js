import { describe, expect, it, vi } from 'vitest'
import { scheduleInitialCardSelection } from './initialCardSelection'

describe('scheduleInitialCardSelection', () => {
  it('defers the initial selection and preserves the card name', () => {
    const selectCard = vi.fn()
    let callback
    const cancel = scheduleInitialCardSelection('Black Lotus', selectCard, {
      schedule: fn => { callback = fn; return 7 },
      cancel: vi.fn(),
    })

    expect(selectCard).not.toHaveBeenCalled()
    callback()
    expect(selectCard).toHaveBeenCalledWith('Black Lotus')
    expect(typeof cancel).toBe('function')
  })

  it('cancels a pending selection on cleanup', () => {
    const cancelTimer = vi.fn()
    const cleanup = scheduleInitialCardSelection('Mox Pearl', vi.fn(), {
      schedule: () => 11,
      cancel: cancelTimer,
    })

    cleanup()
    expect(cancelTimer).toHaveBeenCalledWith(11)
  })

  it('does not schedule without an initial card name', () => {
    const schedule = vi.fn()
    const cleanup = scheduleInitialCardSelection('', vi.fn(), { schedule, cancel: vi.fn() })

    expect(schedule).not.toHaveBeenCalled()
    expect(typeof cleanup).toBe('function')
  })
})
