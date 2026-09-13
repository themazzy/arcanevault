/**
 * First-run "no scan limit" note.
 *
 * The note exists to advertise the one thing the scanner does that every
 * competing app meters. It deliberately does NOT live on the startup gate:
 * `startupCanContinue` flips as soon as the first pack chunk lands and a 400 ms
 * timer dismisses the modal after that, so on a warm IDB cache the gate is gone
 * before it can be read. These tests pin the conditions that hide it, because
 * a note that shows at the wrong moment is worse than no note.
 */

import { describe, it, expect } from 'vitest'
import { shouldShowScannerIntro } from './CardScanner.jsx'

const base = { introSeen: false, startupVisible: false, errorMsg: null, pendingCount: 0 }

describe('shouldShowScannerIntro', () => {
  it('shows on a first-ever scanner open with the camera up', () => {
    expect(shouldShowScannerIntro(base)).toBe(true)
  })

  it('stays hidden once the note has been dismissed before', () => {
    expect(shouldShowScannerIntro({ ...base, introSeen: true })).toBe(false)
  })

  it('does not overlap the startup gate', () => {
    expect(shouldShowScannerIntro({ ...base, startupVisible: true })).toBe(false)
  })

  it('yields to an error, which has the better claim on the space', () => {
    expect(shouldShowScannerIntro({ ...base, errorMsg: 'Camera unavailable' })).toBe(false)
  })

  it('stands down after the first scanned card, dismissed or not', () => {
    // The message is "scan as many as you like" — once they are scanning it has
    // already made its point, and the basket bar needs the room.
    expect(shouldShowScannerIntro({ ...base, pendingCount: 1 })).toBe(false)
  })

  it('treats a missing pendingCount as an empty basket', () => {
    expect(shouldShowScannerIntro({ ...base, pendingCount: undefined })).toBe(true)
  })
})
