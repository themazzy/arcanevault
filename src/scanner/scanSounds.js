/**
 * scanSounds — Web Audio API tones for card scan feedback.
 * No audio files, no network requests. Three price tiers:
 *   Tier 0 (< minThreshold): short low blip
 *   Tier 1 (minThreshold – highThreshold): two-tone soft chime
 *   Tier 2 (> highThreshold): bright ascending chime
 */

let _audioCtx = null

function getAudioCtx() {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  }
  // Resume if suspended (browser autoplay policy)
  if (_audioCtx.state === 'suspended') _audioCtx.resume()
  return _audioCtx
}

function playTone(ctx, { freq, type = 'sine', startTime, duration, gainPeak = 0.25 }) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.type = type
  osc.frequency.setValueAtTime(freq, startTime)
  gain.gain.setValueAtTime(0, startTime)
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.005)
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration)
  osc.start(startTime)
  osc.stop(startTime + duration + 0.01)
}

/**
 * Play a match sound based on the card's price value.
 * @param {number} priceValue — numeric price in the user's currency
 * @param {number} lowThreshold — below this: low blip (default 0.5)
 * @param {number} highThreshold — above this: bright chime (default 5)
 */
export function playMatchSound(priceValue, lowThreshold = 0.5, highThreshold = 5) {
  try {
    const ctx = getAudioCtx()
    const now = ctx.currentTime

    if (priceValue >= highThreshold) {
      // Tier 2: bright ascending two-note chime (valuable card)
      playTone(ctx, { freq: 880, type: 'sine', startTime: now,        duration: 0.18, gainPeak: 0.22 })
      playTone(ctx, { freq: 1320, type: 'sine', startTime: now + 0.12, duration: 0.22, gainPeak: 0.18 })
    } else if (priceValue >= lowThreshold) {
      // Tier 1: soft mid chime (normal card)
      playTone(ctx, { freq: 660, type: 'sine', startTime: now,        duration: 0.15, gainPeak: 0.18 })
      playTone(ctx, { freq: 880, type: 'sine', startTime: now + 0.10, duration: 0.18, gainPeak: 0.14 })
    } else {
      // Tier 0: quiet low blip (bulk / low-value card)
      playTone(ctx, { freq: 330, type: 'sine', startTime: now, duration: 0.10, gainPeak: 0.12 })
    }
  } catch {
    // Web Audio not available — silent fallback
  }
}
