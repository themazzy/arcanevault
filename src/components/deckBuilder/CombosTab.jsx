import { useMemo } from 'react'
import { ChevronDownIcon } from '../../icons'
import { normalizeBoard } from '../../lib/deckBuilderHelpers'
import { ComboResultCard } from './combos'
import styles from '../../pages/DeckBuilder.module.css'

/**
 * Combos tab in the right panel. Renders Commander Spellbook combo results
 * for the current deck. Empty / loading / loaded states are all here.
 */
export default function CombosTab({
  deckCards,
  combosFetched,
  combosLoading,
  combosIncluded,
  combosAlmost,
  comboSectionsOpen,
  onToggleSection,
  onFetchCombos,
  onAddCard,
  onOpenDetail,
  deckImagesMap,
}) {
  // Only commander + main-board cards are sent to Spellbook, so only those may
  // count as "in deck" on the combo thumbs — a combo piece parked on the side/
  // maybeboard must render as missing, otherwise an incomplete combo looks
  // complete with no hint of which card to add.
  const comboDeckNames = useMemo(
    () => deckCards.filter(dc => dc.is_commander || normalizeBoard(dc.board) === 'main').map(dc => dc.name),
    [deckCards],
  )
  return (
    <div className={`${styles.analysisTabPane} ${styles.comboTabPane}`}>
      {deckCards.length === 0 && (
        <div className={styles.comboState}>
          Add cards to this deck first, then find combos.
        </div>
      )}
      {deckCards.length > 0 && !combosFetched && !combosLoading && (
        <div className={styles.comboState}>
          <button type="button" className={styles.comboFetchBtn} onClick={() => onFetchCombos()}>
            Find Combos
          </button>
          <div className={styles.comboAttribution}>via Commander Spellbook</div>
        </div>
      )}
      {combosLoading && (
        <div className={styles.comboState}>
          Checking Commander Spellbook...
        </div>
      )}
      {combosFetched && !combosLoading && (
        <>
          {combosIncluded.length > 0 ? (
            <div>
              <button type="button" className={styles.comboSectionHeader} aria-expanded={comboSectionsOpen.complete} onClick={() => onToggleSection('complete')}>
                <span className={`${styles.groupArrow}${!comboSectionsOpen.complete ? ' ' + styles.groupArrowCollapsed : ''}`} aria-hidden="true">
                  <ChevronDownIcon size={12} />
                </span>
                <span>Complete Combos</span>
                <span className={styles.comboSectionCount}>{combosIncluded.length}</span>
              </button>
              {comboSectionsOpen.complete && <div className={styles.comboResultsList}>
                {combosIncluded.map((c, i) => (
                  <ComboResultCard key={i} combo={c} highlight deckCardNames={comboDeckNames} deckImages={deckImagesMap} onAddCard={name => onAddCard({ name })} onOpenDetail={onOpenDetail} />
                ))}
              </div>}
            </div>
          ) : (
            <div className={styles.comboMuted}>No complete combos found in this deck.</div>
          )}
          {combosAlmost.length > 0 && (
            <div>
              <button type="button" className={styles.comboSectionHeader} aria-expanded={comboSectionsOpen.incomplete} onClick={() => onToggleSection('incomplete')}>
                <span className={`${styles.groupArrow}${!comboSectionsOpen.incomplete ? ' ' + styles.groupArrowCollapsed : ''}`} aria-hidden="true">
                  <ChevronDownIcon size={12} />
                </span>
                <span>Incomplete Combos</span>
                <span className={styles.comboSectionCount}>{combosAlmost.length}</span>
              </button>
              {comboSectionsOpen.incomplete && <div className={styles.comboResultsList}>
                {combosAlmost.slice(0, 20).map((c, i) => (
                  <ComboResultCard key={i} combo={c} highlight={false} deckCardNames={comboDeckNames} deckImages={deckImagesMap} onAddCard={name => onAddCard({ name })} onOpenDetail={onOpenDetail} />
                ))}
              </div>}
              {comboSectionsOpen.incomplete && combosAlmost.length > 20 && (
                <div className={styles.comboMore}>+ {combosAlmost.length - 20} more incomplete combos</div>
              )}
            </div>
          )}
          <button type="button" className={styles.comboRefreshBtn} onClick={() => onFetchCombos()}>
            Refresh
          </button>
        </>
      )}
    </div>
  )
}
