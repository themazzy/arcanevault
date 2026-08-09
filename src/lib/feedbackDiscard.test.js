import { describe, it, expect } from 'vitest'
import { getFeedbackDiscardModel } from './feedbackDiscard'

describe('getFeedbackDiscardModel', () => {
  it('lets an untouched form close with no prompt', () => {
    expect(getFeedbackDiscardModel().needsConfirm).toBe(false)
    expect(getFeedbackDiscardModel({ type: 'feature' }).needsConfirm).toBe(false)
  })

  it('names what is being thrown away', () => {
    expect(getFeedbackDiscardModel({ hasDescription: true }).message)
      .toBe("Discard your bug report? It hasn't been sent.")
    expect(getFeedbackDiscardModel({ type: 'feature', hasDescription: true }).message)
      .toBe("Discard your feature request? It hasn't been sent.")
  })

  it('guards an attached screenshot even with no text yet', () => {
    // Attaching the screenshot is the expensive half of a bug report.
    const model = getFeedbackDiscardModel({ hasScreenshot: true })
    expect(model.needsConfirm).toBe(true)
    expect(model.message).toMatch(/screenshot/i)
  })

  it('guards contact details entered on their own', () => {
    const model = getFeedbackDiscardModel({ hasContact: true })
    expect(model.needsConfirm).toBe(true)
    expect(model.message).toMatch(/what you've entered/i)
  })

  it('leads with the description when there is more than one thing to lose', () => {
    const model = getFeedbackDiscardModel({ hasDescription: true, hasScreenshot: true, hasContact: true })
    expect(model.message).toMatch(/bug report/)
  })

  it('offers to keep writing rather than to cancel', () => {
    const model = getFeedbackDiscardModel({ hasDescription: true })
    expect(model.keepLabel).toBe('Keep writing')
    expect(model.discardLabel).toBe('Discard')
    expect(model.discardVariant).toBe('danger')
  })
})
