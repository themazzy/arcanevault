import { useCallback, useRef, useState } from 'react'

/**
 * Deck-name field for the guided build flow.
 *
 * Picking a commander fills the name in, and picking another replaces it — but
 * a name the user typed themselves is never overwritten. Telling those apart
 * needs memory of the last name this hook wrote, which is what `autoNameRef`
 * holds.
 *
 * The ordering inside `syncToCommander` is the whole point of extracting this.
 * A setState updater runs during the next render, not at call time, so an
 * updater that reads the ref directly sees the value written *after* the call.
 * The original inline version did exactly that: on the second and every later
 * pick it compared the previous auto-name against the new commander's, found
 * them different, concluded the user must have typed it, and kept it. A deck
 * rolled twice ended up named after the first commander while being built for
 * the second. Reading the ref into a local before reassigning it is the fix.
 */
export function useGuidedDeckName(initial = '') {
  const [name, setName] = useState(initial)
  const autoNameRef = useRef('')

  const syncToCommander = useCallback(commanderName => {
    const next = commanderName || ''
    const prevAuto = autoNameRef.current
    autoNameRef.current = next
    setName(prev => (prev.trim() && prev !== prevAuto ? prev : next))
  }, [])

  const reset = useCallback(() => {
    autoNameRef.current = ''
    setName('')
  }, [])

  return { name, setName, syncToCommander, reset }
}
