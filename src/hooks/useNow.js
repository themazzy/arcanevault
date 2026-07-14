import { useSyncExternalStore } from 'react'

function createClockStore(intervalMs) {
  let currentTime = Date.now()
  let timer = null
  const listeners = new Set()

  const update = () => {
    const nextTime = Date.now()
    if (nextTime === currentTime) return
    currentTime = nextTime
    listeners.forEach(listener => listener())
  }

  return {
    getSnapshot: () => currentTime,
    subscribe(listener) {
      listeners.add(listener)
      update()
      if (timer === null) timer = setInterval(update, intervalMs)

      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }
    },
  }
}

const secondClock = createClockStore(1000)
const minuteClock = createClockStore(60000)

export function useNow(intervalMs = 1000) {
  const clock = intervalMs >= 60000 ? minuteClock : secondClock
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot)
}
