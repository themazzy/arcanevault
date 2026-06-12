import { useEffect, useRef, useState } from 'react'
import { BRACKET_LABELS } from '../lib/commanderBracket'
import styles from './BracketBadge.module.css'

// Official 5-bracket system (Commander Brackets beta, Feb 2026 rules).
export const BRACKET_META = {
  1: { label: BRACKET_LABELS[1], color: '#6aaa6a', desc: 'Themed and experimental decks — winning is not the point.' },
  2: { label: BRACKET_LABELS[2], color: '#5a9abb', desc: 'Average modern precon power. No Game Changers, no mass land denial.' },
  3: { label: BRACKET_LABELS[3], color: '#c9a84c', desc: 'Tuned decks with up to three Game Changers; no fast two-card combos.' },
  4: { label: BRACKET_LABELS[4], color: '#e08a3c', desc: 'No deckbuilding restrictions — anything short of tournament play.' },
  5: { label: BRACKET_LABELS[5], color: '#cc5555', desc: 'Competitive EDH — a declared tournament intent, never auto-detected.' },
}

/**
 * Commander Bracket pill for the deck stats row. Click to expand the full
 * estimate: rule-by-rule reasons, flagged cards, soft signals, the combo
 * check, and a manual 1–5 override.
 *
 * @param {Object}   analysis     analyzeBracket() result
 * @param {number}   bracket      Effective bracket (override ?? estimated)
 * @param {boolean}  isOverridden Whether a manual override is active
 * @param {Function} onOverride   (n|null) => void — null resets to auto
 * @param {Object}   combos       Optional: { fetched, loading, onCheck }
 */
export default function BracketBadge({ analysis, bracket, isOverridden, onOverride, combos }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const meta = BRACKET_META[bracket] || BRACKET_META[1]
  const canOverride = typeof onOverride === 'function'

  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  if (!analysis) return null

  const flagGroups = [
    { title: 'Game Changers', items: analysis.gameChangers, cap: bracket >= 4 ? null : 3 },
    { title: 'Mass land denial', items: analysis.massLandDenial },
    { title: 'Extra turns', items: analysis.extraTurns },
    {
      title: 'Two-card combos',
      items: analysis.twoCardCombos.map(c => `${c.names.join(' + ')}${c.early ? ' (fast)' : ''}`),
    },
  ].filter(g => g.items.length > 0)

  const softSignals = []
  if (analysis.tutors.length) softSignals.push(`${analysis.tutors.length} tutor${analysis.tutors.length === 1 ? '' : 's'}`)
  if (analysis.fastMana.length) softSignals.push(`fast mana ×${analysis.fastMana.length}`)

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.pill}
        style={{ borderColor: `${meta.color}55`, color: meta.color }}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <span className={styles.pillNumber} style={{ background: meta.color }}>{bracket}</span>
        <span className={styles.pillLabel}>{meta.label}</span>
        {isOverridden
          ? <span className={styles.pillMark} title="Manually set">✎</span>
          : <span className={styles.pillMark}>est.</span>}
        <span className={styles.pillChevron}>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className={styles.popover}>
          <div className={styles.popHeader}>
            <span className={styles.popCircle} style={{ background: meta.color }}>{bracket}</span>
            <div>
              <div className={styles.popTitle} style={{ color: meta.color }}>
                Bracket {bracket} · {meta.label}
              </div>
              <div className={styles.popDesc}>{meta.desc}</div>
            </div>
          </div>

          <div className={styles.popSection}>
            <div className={styles.popSectionTitle}>
              Estimate{isOverridden ? ` — auto would be Bracket ${analysis.bracket}` : ''}
            </div>
            {analysis.reasons.length === 0 ? (
              <div className={styles.popClean}>
                No Game Changers, mass land denial, extra turns, or detected two-card
                combos — fits Bracket 1–2 expectations.
              </div>
            ) : (
              <ul className={styles.reasonList}>
                {analysis.reasons.map((r, i) => (
                  <li key={i}>
                    <span className={styles.reasonLevel}>B{r.level}+</span> {r.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {flagGroups.map(group => (
            <div key={group.title} className={styles.popSection}>
              <div className={styles.popSectionTitle}>
                {group.title}
                <span className={styles.flagCount}>{group.items.length}{group.cap ? ` / ${group.cap}` : ''}</span>
              </div>
              <div className={styles.flagCards}>{group.items.join(' · ')}</div>
            </div>
          ))}

          {softSignals.length > 0 && (
            <div className={styles.popSoft}>Soft signals (no bracket impact): {softSignals.join(' · ')}</div>
          )}

          {combos && !combos.fetched && (
            <button
              type="button"
              className={styles.comboBtn}
              onClick={combos.onCheck}
              disabled={combos.loading}
            >
              {combos.loading ? 'Checking combos…' : 'Run combo check for a full estimate'}
            </button>
          )}

          {canOverride && (
            <div className={styles.popSection}>
              <div className={styles.popSectionTitle}>Set manually</div>
              <div className={styles.overrideRow}>
                {[1, 2, 3, 4, 5].map(n => {
                  const m = BRACKET_META[n]
                  const active = n === bracket
                  return (
                    <button
                      key={n}
                      type="button"
                      className={styles.overrideBtn}
                      style={{
                        borderColor: `${m.color}66`,
                        color: active ? '#0a0a0f' : m.color,
                        background: active ? m.color : 'transparent',
                      }}
                      title={m.label}
                      onClick={() => { onOverride(n); setOpen(false) }}
                    >
                      {n}
                    </button>
                  )
                })}
                {isOverridden && (
                  <button type="button" className={styles.resetBtn} onClick={() => { onOverride(null); setOpen(false) }}>
                    Reset to auto
                  </button>
                )}
              </div>
            </div>
          )}

          <div className={styles.popFootnote}>
            Estimated minimum bracket from the official rules; Game Changers list
            is live from Scryfall. Brackets are a pregame conversation tool.
            {!analysis.combosChecked && combos ? ' Combo detection has not run yet.' : ''}
          </div>
        </div>
      )}
    </div>
  )
}
