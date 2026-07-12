import { useCallback, useState } from 'react'
import { normalizeBoard } from '../lib/deckBuilderHelpers'

/**
 * Commander Spellbook combo lookup state for the right-panel "Combos" tab.
 *
 *   fetched, loading, included, almost  — result state
 *   sectionsOpen, toggleSection          — collapsed-state of the two result groups
 *   fetchCombos()                         — POSTs the current deck to Spellbook
 *
 * The hook stays passive (it does not auto-fire on deckCards change) — the
 * tab triggers the first fetch when the user opens it, and a Refresh button
 * triggers subsequent ones.
 *
 * Dev hits the Vite proxy with a spoofed Origin (CORS-restricted). Prod hits
 * a Supabase Edge Function that re-issues the request server-side.
 */
export function useCombosFetch({ commanderCard, deckCards, accessToken }) {
  const [included, setIncluded] = useState([])
  const [almost,   setAlmost]   = useState([])
  const [loading,  setLoading]  = useState(false)
  const [fetched,  setFetched]  = useState(false)
  const [sectionsOpen, setSectionsOpen] = useState({ complete: true, incomplete: true })

  const toggleSection = useCallback((section) => {
    setSectionsOpen(prev => ({ ...prev, [section]: !prev[section] }))
  }, [])

  // `deckOverride` lets a caller pass the exact deck to check (e.g. auto-fill's
  // just-populated list) instead of the `deckCards` prop, which hasn't
  // round-tripped through React state yet inside the same async handler.
  // Resolves to the parsed `{ included, almost }` so that flow can act on the
  // results immediately, not only via the state it also updates.
  const fetchCombos = useCallback(async (deckOverride) => {
    if (loading) return null
    const deck = deckOverride || deckCards
    setLoading(true)
    try {
      // Include EVERY commander (partners / backgrounds), not just the primary,
      // so partner-specific combos are found for both the bracket estimate and
      // the "combos you're close to" suggestions. Names come from the deck's
      // is_commander rows, plus the passed commanderCard and its partnerName —
      // BuildAssistant hands in a synthetic commander object, not deck rows.
      const cmdNames = new Set()
      for (const dc of deck || []) {
        if (dc?.is_commander && dc?.name) cmdNames.add(dc.name)
      }
      if (commanderCard?.name) cmdNames.add(commanderCard.name)
      if (commanderCard?.partnerName) cmdNames.add(commanderCard.partnerName)
      const body = {
        commanders: [...cmdNames].map(card => ({ card })),
        main: (deck || [])
          .filter(dc => !dc.is_commander && normalizeBoard(dc.board) === 'main')
          .map(dc => ({ card: dc.name })),
      }
      const isDev = import.meta.env.DEV
      const url = isDev
        ? '/api/combos/find-my-combos/'
        : `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/combo-proxy`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(isDev ? {} : {
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          }),
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`API ${res.status}`)
      const data = await res.json()
      const r = data.results || {}
      const inc = r.included || []
      const alm = [...(r.almostIncluded || []), ...(r.almostIncludedByAddingColors || [])]
      setIncluded(inc)
      setAlmost(alm)
      setFetched(true)
      setLoading(false)
      return { included: inc, almost: alm }
    } catch (e) {
      console.warn('[Combos]', e)
      setLoading(false)
      return null
    }
  }, [loading, commanderCard, deckCards, accessToken])

  return { fetched, loading, included, almost, sectionsOpen, toggleSection, fetchCombos }
}
