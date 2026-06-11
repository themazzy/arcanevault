import { useState } from 'react'
import styles from './BracketPanel.module.css'

/**
 * Commander Bracket estimate for the deck builder left column.
 * Pure presentation — analysis comes from src/lib/commanderBracket.js.
 */
export default function BracketPanel({ analysis, combosFetched, combosLoading, onCheckCombos }) {
  const [open, setOpen] = useState(false)
  if (!analysis) return null

  const { bracket, label, reasons, gameChangers, massLandDenial, extraTurns, tutors, fastMana, twoCardCombos } = analysis

  const flagLists = [
    { title: 'Game Changers', items: gameChangers, max: bracket >= 4 ? null : 3 },
    { title: 'Mass land denial', items: massLandDenial },
    { title: 'Extra turns', items: extraTurns },
    { title: 'Two-card combos', items: twoCardCombos.map(c => `${c.names.join(' + ')}${c.early ? ' (fast)' : ''}`) },
  ].filter(group => group.items.length > 0)

  const softSignals = []
  if (tutors.length) softSignals.push(`${tutors.length} tutor${tutors.length === 1 ? '' : 's'}`)
  if (fastMana.length) softSignals.push(`fast mana ×${fastMana.length}`)

  return (
    <div className={styles.panel}>
      <button type="button" className={styles.header} onClick={() => setOpen(o => !o)}>
        <span className={styles.headerLabel}>Bracket estimate</span>
        <span className={`${styles.badge} ${styles[`badge${bracket}`] || ''}`}>
          {bracket} · {label}{bracket > 1 ? '+' : ''}
        </span>
        <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className={styles.body}>
          {reasons.length === 0 ? (
            <div className={styles.clean}>
              No Game Changers, mass land denial, extra turns, or detected two-card
              combos — fits Bracket 1–2 table expectations.
            </div>
          ) : (
            <ul className={styles.reasonList}>
              {reasons.map((r, i) => (
                <li key={i} className={styles.reason}>
                  <span className={styles.reasonLevel}>B{r.level}+</span> {r.reason}
                </li>
              ))}
            </ul>
          )}

          {flagLists.map(group => (
            <div key={group.title} className={styles.flagGroup}>
              <div className={styles.flagTitle}>
                {group.title}
                <span className={styles.flagCount}>
                  {group.items.length}{group.max ? ` / ${group.max}` : ''}
                </span>
              </div>
              <div className={styles.flagCards}>{group.items.join(' · ')}</div>
            </div>
          ))}

          {softSignals.length > 0 && (
            <div className={styles.soft}>
              Soft signals (no bracket impact): {softSignals.join(' · ')}
            </div>
          )}

          {!combosFetched && (
            <button
              type="button"
              className={styles.comboBtn}
              onClick={onCheckCombos}
              disabled={combosLoading}
            >
              {combosLoading ? 'Checking combos…' : 'Run combo check for a full estimate'}
            </button>
          )}

          <div className={styles.footnote}>
            Estimated minimum bracket from the official rules (Game Changers via
            Scryfall). Brackets are a pregame conversation tool — Bracket 5 (cEDH)
            is declared, not detected.
          </div>
        </div>
      )}
    </div>
  )
}
