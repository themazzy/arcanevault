import { useEffect, useRef, useState } from 'react'

// The running total of a burst of life changes — "−7" after a combat step, read
// as one action rather than seven.
//
// Derived from the life total itself rather than from the taps, so a change made
// anywhere surfaces the same way: a split-tap on the panel, a commander-damage
// step in the sheet, or a counter that kills. Both surfaces share this hook so
// they cannot drift apart.

// Long enough to look back up from the board and still find it, short enough not
// to sit on top of the life total.
export const DELTA_LINGER_MS = 2200

export default function useLifeDelta(life, lingerMs = DELTA_LINGER_MS) {
  const [delta, setDelta] = useState(0)
  const timer = useRef(null)
  const prev = useRef(life)

  useEffect(() => {
    const diff = life - prev.current
    prev.current = life
    if (diff === 0) return
    setDelta(current => current + diff)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setDelta(0), lingerMs)
  }, [life, lingerMs])

  useEffect(() => () => clearTimeout(timer.current), [])

  return delta
}
