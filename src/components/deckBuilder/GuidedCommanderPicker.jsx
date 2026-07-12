import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckIcon } from '../../icons'
import { getLocalCards, getLocalCardPrints } from '../../lib/db'
import { getInstantCache, getScryfallKey, getImageUri } from '../../lib/scryfall'
import { searchCommanders, fetchCardsByScryfallIds, searchLegalPartners } from '../../lib/deckBuilderApi'
import { manaSymbolUrl } from '../../lib/deckBuilderHelpers'
import { detectPartnerType, partnerHint } from '../../lib/commanderPartners'
import styles from './GuidedCommanderPicker.module.css'

// Commander picker for guided deck creation: lists the user's OWNED commanders
// first (legendary creatures from their collection) and offers a Scryfall search
// to pick any legal commander. Selecting one calls onSelect(sfCard) — a full
// Scryfall card object, the same shape pickCommander() expects.

function isCommanderType(typeLine = '') {
  const t = typeLine.toLowerCase()
  return t.includes('legendary') && t.includes('creature')
}

// Pull a usable type line from a Scryfall card, including the front face of a
// double-faced card (commanders like Kenrith are single-faced, but partners /
// MDFCs can hide the legendary creature on face 0).
function typeLineOf(sf) {
  return sf?.type_line || sf?.card_faces?.[0]?.type_line || ''
}

// Rules text for the preview: a single-faced card's oracle_text, or both faces
// of a DFC joined (so a transforming/MDFC commander shows its whole text).
function oracleTextOf(sf) {
  if (sf?.oracle_text) return sf.oracle_text
  const faces = (sf?.card_faces || []).map(f => f?.oracle_text).filter(Boolean)
  return faces.join('\n//\n')
}

// Front-face mana cost (DFC top-level mana_cost is empty; the cost lives on the
// front face).
function manaCostOf(sf) {
  return sf?.mana_cost || sf?.card_faces?.[0]?.mana_cost || ''
}

// Power/toughness, front face first for a DFC creature. null when the card
// isn't a creature (no P/T on any face).
function ptOf(sf) {
  if (sf?.power != null && sf?.toughness != null) return `${sf.power}/${sf.toughness}`
  const face = (sf?.card_faces || []).find(f => f?.power != null && f?.toughness != null)
  return face ? `${face.power}/${face.toughness}` : null
}

// Split a string on {…} mana/tap tokens, rendering each token as its Scryfall
// symbol SVG and keeping the surrounding text. Shared by the mana cost and the
// symbols embedded in rules text so {T}/{G}/{W/U} render as MTG images, not text.
function withSymbols(text, keyPrefix) {
  return String(text || '').split(/(\{[^}]+\})/g).map((part, i) => {
    if (!part) return null
    if (/^\{[^}]+\}$/.test(part)) {
      return (
        <img key={`${keyPrefix}-${i}`} className={styles.sym} src={manaSymbolUrl(part)} alt={part} loading="lazy" />
      )
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>
  })
}

// Multi-line rules text with inline symbols, preserving line breaks.
function OracleText({ text }) {
  return (
    <div className={styles.previewOracle}>
      {String(text).split('\n').map((line, i) => (
        <div key={i} className={styles.oracleLine}>{line ? withSymbols(line, `l${i}`) : ' '}</div>
      ))}
    </div>
  )
}

// Preview card shown once a commander is picked: a legible (normal-size) image
// plus name, mana cost, type, P/T, and rules text with MTG symbols. When the
// selection is a minimal owned-fallback object (cold Scryfall cache) with no
// image / oracle text, we fetch the full card by id so the preview is complete.
function CommanderPreview({ sf }) {
  const [full, setFull] = useState(sf)
  useEffect(() => {
    setFull(sf)
    const needsFetch = sf?.id && (!getImageUri(sf, 'normal') || (!sf.oracle_text && !sf.card_faces?.length))
    if (!needsFetch) return
    let cancelled = false
    ;(async () => {
      const [card] = await fetchCardsByScryfallIds([sf.id]).catch(() => [])
      if (!cancelled && card) setFull(card)
    })()
    return () => { cancelled = true }
  }, [sf])

  const card = full || sf
  if (!card) return null
  const img = getImageUri(card, 'normal')
  const type = typeLineOf(card)
  const oracle = oracleTextOf(card)
  const cost = manaCostOf(card)
  const pt = ptOf(card)
  return (
    <div className={styles.preview}>
      {img
        ? <img src={img} alt={card.name} loading="lazy" className={styles.previewArt} />
        : <div className={styles.previewArtEmpty}>Loading…</div>}
      <div className={styles.previewInfo}>
        <div className={styles.previewName}>
          <span className={styles.previewNameText}>{card.name}</span>
          {cost ? <span className={styles.previewCost}>{withSymbols(cost, 'cost')}</span> : null}
        </div>
        {type && (
          <div className={styles.previewType}>
            <span>{type}</span>
            {pt && <span className={styles.previewPt}>{pt}</span>}
          </div>
        )}
        {oracle
          ? <OracleText text={oracle} />
          : <div className={styles.previewOracleEmpty}>Rules text loads when its card data is cached.</div>}
      </div>
    </div>
  )
}

export function GuidedCommanderPicker({ userId, value, onSelect, partnerValue = null, onSelectPartner }) {
  const [owned, setOwned] = useState(null) // null = loading
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef(null)

  // The selected commander enriched with full Scryfall data (oracle/faces), so
  // both the preview and partner detection work even when `value` is a minimal
  // cold-cache object.
  const [fullCommander, setFullCommander] = useState(value)
  useEffect(() => {
    setFullCommander(value)
    const needsFetch = value?.id && (!value.oracle_text && !value.card_faces?.length)
    if (!needsFetch) return
    let cancelled = false
    ;(async () => {
      const [card] = await fetchCardsByScryfallIds([value.id]).catch(() => [])
      if (!cancelled && card) setFullCommander(card)
    })()
    return () => { cancelled = true }
  }, [value])

  const partnerDesc = useMemo(() => detectPartnerType(fullCommander), [fullCommander])
  const partnerActive = !!(partnerDesc && typeof onSelectPartner === 'function')

  // Partner search bar state (only used when the commander has a partner ability).
  const [pQuery, setPQuery] = useState('')
  const [pResults, setPResults] = useState([])
  const [pSearching, setPSearching] = useState(false)
  const pTimer = useRef(null)

  // Changing the primary commander invalidates a partner chosen for the old one
  // (different identity / mechanic), so clear it and reset the partner search.
  const primaryName = value?.name || ''
  useEffect(() => {
    if (typeof onSelectPartner === 'function' && partnerValue) onSelectPartner(null)
    setPQuery('')
    setPResults([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryName])

  // Load legal partners for the active mechanic, filtered by the partner search
  // box. Debounced; runs with an empty query too so options show immediately.
  useEffect(() => {
    if (!partnerActive) return
    if (pTimer.current) clearTimeout(pTimer.current)
    setPSearching(true)
    pTimer.current = setTimeout(async () => {
      try {
        const res = await searchLegalPartners(partnerDesc, fullCommander?.name || '', pQuery.trim())
        setPResults(res || [])
      } catch {
        setPResults([])
      } finally {
        setPSearching(false)
      }
    }, pQuery.trim() ? 300 : 0)
    return () => { if (pTimer.current) clearTimeout(pTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerActive, partnerDesc?.type, partnerDesc?.name, fullCommander?.name, pQuery])

  // Load owned commanders once. We resolve each owned card's type line from
  // card_prints (always present locally) rather than the Scryfall in-memory
  // cache, which may be cold on this page — that was the cause of the empty
  // list. The full Scryfall card is used when available (richer object for
  // pickCommander), otherwise we build a minimal commander object from the
  // print metadata; pickCommander re-resolves the printing by name anyway.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [cards, prints, cache] = await Promise.all([
          getLocalCards(userId),
          getLocalCardPrints().catch(() => []),
          getInstantCache().catch(() => null),
        ])
        const map = cache || {}
        const printById = new Map((prints || []).map(p => [p.id, p]))
        const printBySf = new Map((prints || []).filter(p => p.scryfall_id).map(p => [p.scryfall_id, p]))

        const seen = new Set()
        const list = []
        for (const c of cards || []) {
          const print =
            (c?.card_print_id && printById.get(c.card_print_id)) ||
            (c?.scryfall_id && printBySf.get(c.scryfall_id)) ||
            null
          const scryfallId = c?.scryfall_id || print?.scryfall_id
          if (!scryfallId) continue

          // Instant cache is keyed by `${set}-${collector}`, not scryfall_id.
          const sf = (print && map[getScryfallKey(print)]) || null
          const typeLine = typeLineOf(sf) || c?.type_line || print?.type_line || ''
          if (!isCommanderType(typeLine)) continue

          const name = sf?.name || c?.name || print?.name || ''
          const key = name.toLowerCase()
          if (!key || seen.has(key)) continue
          seen.add(key)

          // Prefer the full Scryfall object; fall back to a minimal one.
          list.push(sf || {
            id: scryfallId,
            name,
            type_line: typeLine,
            color_identity: print?.color_identity || c?.color_identity || [],
            set: print?.set_code || undefined,
            collector_number: print?.collector_number || undefined,
            mana_cost: print?.mana_cost || undefined,
            cmc: print?.cmc ?? undefined,
          })
        }
        list.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        if (!cancelled) setOwned(list)
      } catch {
        if (!cancelled) setOwned([])
      }
    })()
    return () => { cancelled = true }
  }, [userId])

  // Debounced Scryfall commander search.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const q = query.trim()
    if (q.length < 2) { setResults([]); setSearching(false); return }
    setSearching(true)
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await searchCommanders(q)
        setResults(res || [])
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [query])

  const selectedName = (value?.name || '').toLowerCase()
  const q = query.trim()

  // Filter owned by the query too, so typing narrows both lists.
  const filteredOwned = useMemo(() => {
    if (!owned) return null
    if (q.length < 1) return owned
    const lower = q.toLowerCase()
    return owned.filter(sf => (sf.name || '').toLowerCase().includes(lower))
  }, [owned, q])

  const renderItem = sf => {
    const selected = (sf.name || '').toLowerCase() === selectedName
    return (
      <button
        key={sf.id || sf.name}
        type="button"
        className={`${styles.item}${selected ? ' ' + styles.itemSelected : ''}`}
        onClick={() => onSelect(sf)}
      >
        <span className={styles.itemName}>{sf.name}</span>
        <span className={styles.itemMeta}>
          <span className={styles.itemType}>{typeLineOf(sf).replace(/^Legendary Creature — /, '')}</span>
          {selected && <CheckIcon size={13} />}
        </span>
      </button>
    )
  }

  const partnerName = (partnerValue?.name || '').toLowerCase()
  const suggestedName = partnerDesc?.type === 'partner-with' ? (partnerDesc.name || '').toLowerCase() : ''
  const renderPartnerItem = sf => {
    const selected = (sf.name || '').toLowerCase() === partnerName
    const suggested = (sf.name || '').toLowerCase() === suggestedName
    return (
      <button
        key={sf.id || sf.name}
        type="button"
        className={`${styles.item}${selected ? ' ' + styles.itemSelected : ''}`}
        onClick={() => onSelectPartner(sf)}
      >
        <span className={styles.itemName}>
          {sf.name}
          {suggested && <span className={styles.suggestedTag}>suggested</span>}
        </span>
        <span className={styles.itemMeta}>
          <span className={styles.itemType}>{typeLineOf(sf).replace(/^Legendary Creature — /, '').replace(/^Enchantment — /, '')}</span>
          {selected && <CheckIcon size={13} />}
        </span>
      </button>
    )
  }

  return (
    <div className={styles.picker}>
      <div className={styles.searchRow}>
        <input
          className={styles.search}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search commanders…"
          aria-label="Search commanders"
        />
        {partnerActive && (
          <input
            className={`${styles.search} ${styles.partnerSearch}`}
            value={pQuery}
            onChange={e => setPQuery(e.target.value)}
            placeholder={`Search ${partnerDesc.type === 'choose-background' ? 'backgrounds' : 'legal partners'}…`}
            aria-label="Search legal partners"
          />
        )}
      </div>

      {value && <CommanderPreview sf={fullCommander || value} />}

      {partnerActive && (
        <div className={styles.partnerPanel}>
          <div className={styles.partnerHead}>
            <span className={styles.partnerBadge}>{partnerDesc.label}</span>
            <span className={styles.partnerHint}>{partnerHint(partnerDesc)}</span>
          </div>
          {partnerValue ? (
            <div className={styles.partnerSelected}>
              <CommanderPreview sf={partnerValue} />
              <button
                type="button"
                className={styles.partnerRemove}
                onClick={() => onSelectPartner(null)}
              >
                Remove partner
              </button>
            </div>
          ) : (
            <div className={styles.partnerResults}>
              {pSearching && !pResults.length ? (
                <div className={styles.hint}>Finding partners…</div>
              ) : pResults.length === 0 ? (
                <div className={styles.hint}>No legal partners found.</div>
              ) : (
                <div className={styles.list}>{pResults.map(renderPartnerItem)}</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className={styles.scroll}>
        {/* Owned commanders */}
        <div className={styles.sectionLabel}>Your commanders</div>
        {filteredOwned === null ? (
          <div className={styles.hint}>Loading your collection…</div>
        ) : filteredOwned.length === 0 ? (
          <div className={styles.hint}>
            {owned?.length ? 'No owned commanders match.' : 'No commanders in your collection yet.'}
          </div>
        ) : (
          <div className={styles.list}>{filteredOwned.map(renderItem)}</div>
        )}

        {/* Scryfall search results (only the not-owned ones, to avoid dupes) */}
        {q.length >= 2 && (
          <>
            <div className={styles.sectionLabel}>All commanders</div>
            {searching ? (
              <div className={styles.hint}>Searching…</div>
            ) : results.length === 0 ? (
              <div className={styles.hint}>No matches.</div>
            ) : (
              <div className={styles.list}>
                {results
                  .filter(sf => !(owned || []).some(o => (o.name || '').toLowerCase() === (sf.name || '').toLowerCase()))
                  .map(renderItem)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
