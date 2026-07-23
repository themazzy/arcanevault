import { useEffect, useRef, useState } from 'react'
import { Input, Button, useModalKeys } from '../UI'
import { WarningIcon } from '../../icons'
import { getCardLegalityWarnings } from '../../lib/deckLegality'
import { formatPrice } from '../../lib/scryfall'
import styles from './BuildAssistant.module.css'

// Persistent "add a specific card" search — the manual escape hatch for cards
// the recommendation feed didn't surface. Sits above the per-step content so
// it's reachable on every step. Each result shows the deck category it will be
// filed under (→ Ramp / Removal / …) so the user knows where to find it after
// adding; off-color / illegal cards are flagged but still addable (the user
// confirms). Adds go through the same handler as tiles, so owned-vs-buy
// accounting and category persistence stay identical.
//
// Keyboard: ArrowUp/Down move a highlight through the results, Enter adds the
// highlighted card, Escape closes just the popover (it claims the modal stack
// via useModalKeys — otherwise the assistant Modal's capture-phase listener
// would route Escape to its leave flow), and Tab closes it while letting focus
// move on.
//
// `imageOf(card, size)` resolves a result's art URL — injected so this file
// stays free of the heavier API modules and easy to test.
export function SpecificCardSearch({ search, priceSource, onAdd, isAdded, categoryOf, commanderColorIdentity, makePreview, imageOf }) {
  const { query, results, loading, handleInput } = search
  const trimmed = (query || '').trim()
  // The results float over the panel (don't push it down) and behave like an
  // autocomplete popover: a click outside closes them, and focusing the search
  // bar reopens them.
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1) // keyboard highlight, -1 = none
  const wrapRef = useRef(null)
  const listRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDocDown = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('touchstart', onDocDown)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('touchstart', onDocDown)
    }
  }, [open])
  const showResults = open && trimmed.length > 0
  const shown = showResults ? results.slice(0, 8) : []

  // Escape-only stack claim: not a dialog, so no Tab trap and no focus steal.
  useModalKeys(wrapRef, {
    active: showResults,
    onClose: () => setOpen(false),
    trapTab: false,
    manageFocus: false,
  })

  // New results invalidate the highlight; don't carry it to a different list.
  useEffect(() => { setActiveIdx(-1) }, [query, open])

  // Keep the highlighted row in view while arrowing through an overflowing list.
  useEffect(() => {
    if (activeIdx < 0) return
    listRef.current?.children?.[activeIdx]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIdx])

  const onKeyDown = e => {
    if (e.key === 'Tab') { setOpen(false); return } // close, let focus move on
    if (!shown.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, shown.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, -1))
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault()
      const card = shown[activeIdx]
      if (card && !isAdded(card.name)) onAdd(card)
    }
  }

  return (
    <div className={styles.specSearch} ref={wrapRef}>
      <div className={styles.specSearchLabel}>Add a specific card</div>
      <Input
        value={query}
        onChange={e => { handleInput(e.target.value); setOpen(true) }}
        onClear={() => { handleInput(''); setOpen(false) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search a card by name…"
        clearable
        role="combobox"
        aria-expanded={showResults}
        aria-autocomplete="list"
      />
      {showResults && (
        <div className={styles.specResults} ref={listRef} role="listbox" aria-label="Card search results">
          {loading && results.length === 0
            ? <div className={styles.emptySmall}>Searching…</div>
            : shown.length === 0
              ? <div className={styles.emptySmall}>No cards found.</div>
              : shown.map((card, idx) => {
                  const cat = categoryOf(card)
                  const warnings = getCardLegalityWarnings({
                    card,
                    formatId: 'commander',
                    formatLabel: 'Commander',
                    isEDH: true,
                    commanderColorIdentity,
                  })
                  const added = isAdded(card.name)
                  const thumb = imageOf(card, 'small')
                  return (
                    <div
                      key={card.id}
                      role="option"
                      aria-selected={idx === activeIdx}
                      className={`${styles.specRow}${idx === activeIdx ? ' ' + styles.specRowActive : ''}`}
                    >
                      {/* Thumbnail + name are the hover target (hugs the content,
                          not the whole row) — hovering either enlarges to a floating
                          preview (desktop) or a tap-lightbox (touch). No name
                          tooltip; the preview is the only affordance. */}
                      <div
                        className={styles.specHover}
                        {...makePreview({ name: card.name, scryfall_id: card.id, img: imageOf(card, 'large') })}
                      >
                        {thumb && (
                          <img src={thumb} alt="" className={styles.specThumb} loading="lazy" />
                        )}
                        <span className={styles.specName}>{card.name}</span>
                      </div>
                      <div className={styles.specMeta}>
                        {warnings.length > 0 && (
                          <span className={styles.specWarn} title={warnings.map(w => w.text).join('\n')}>
                            <WarningIcon size={12} />
                          </span>
                        )}
                        {Object.hasOwn(card, 'display_price') && (
                          <span className={`${styles.specPrice}${card.display_price == null ? ` ${styles.specPriceEmpty}` : ''}`}>
                            {card.display_price == null ? 'No price' : formatPrice(card.display_price, priceSource)}
                            {card.display_finish && <small> · {card.display_finish}</small>}
                          </span>
                        )}
                        {!added && <span className={styles.specCat} title="Build role this card will be filed under">{cat}</span>}
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onAdd(card)}
                          disabled={added}
                        >
                          {added ? `Added to ${cat}` : 'Add'}
                        </Button>
                      </div>
                    </div>
                  )
                })}
        </div>
      )}
    </div>
  )
}
