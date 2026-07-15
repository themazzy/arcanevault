import { useEffect, useState } from 'react'

function currentDpr() {
  return (typeof window !== 'undefined' && window.devicePixelRatio) || 1
}

// devicePixelRatio isn't static — it changes when the user zooms, and when a
// window is dragged between monitors of different densities. Anything picking an
// image tier from it has to re-render on that change, or a zoomed-in grid keeps
// rendering the tier it chose at the old ratio.
//
// There's no `resize`-style event for it; the standard trick is a resolution
// media query at the current value, which stops matching the moment it changes.
export function useDevicePixelRatio() {
  const [dpr, setDpr] = useState(currentDpr)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    let mq
    const sync = () => {
      const next = currentDpr()
      setDpr(next)
      mq?.removeEventListener('change', sync)
      // Re-arm at the new ratio: the query only fires on the way *out* of the
      // value it was created with.
      mq = window.matchMedia(`(resolution: ${next}dppx)`)
      mq.addEventListener('change', sync)
    }
    mq = window.matchMedia(`(resolution: ${currentDpr()}dppx)`)
    mq.addEventListener('change', sync)
    return () => mq?.removeEventListener('change', sync)
  }, [])

  return dpr
}
