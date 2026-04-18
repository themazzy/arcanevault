/**
 * Tracks whether the most recent pointer interaction was touch.
 * Set to true on touchstart, cleared on any real mouse pointermove.
 * Checked at event-handler call time so hybrid devices (touch + mouse)
 * correctly suppress hover previews when the user is touching.
 */
export let lastInputWasTouch = false

if (typeof window !== 'undefined') {
  window.addEventListener('touchstart', () => { lastInputWasTouch = true }, { passive: true })
  window.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') lastInputWasTouch = false
  }, { passive: true })
}
