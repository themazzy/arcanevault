import { ChevronDownIcon } from '../../icons'
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
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {deckCards.length === 0 && (
        <div style={{ color: 'var(--text-faint)', fontSize: '0.85rem', textAlign: 'center', paddingTop: 40 }}>
          Add cards to this deck first, then find combos.
        </div>
      )}
      {deckCards.length > 0 && !combosFetched && !combosLoading && (
        <div style={{ textAlign: 'center', paddingTop: 40 }}>
          <button onClick={onFetchCombos} style={{ background: 'rgba(201,168,76,0.12)', border: '1px solid rgba(201,168,76,0.35)', borderRadius: 4, color: 'var(--gold)', padding: '9px 22px', fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'var(--font-display)', letterSpacing: '0.05em' }}>
            Find Combos
          </button>
          <div style={{ fontSize: '0.73rem', color: 'var(--text-faint)', marginTop: 8 }}>via Commander Spellbook</div>
        </div>
      )}
      {combosLoading && (
        <div style={{ color: 'var(--text-faint)', textAlign: 'center', paddingTop: 40, fontSize: '0.85rem' }}>
          Checking Commander Spellbook...
        </div>
      )}
      {combosFetched && !combosLoading && (
        <>
          {combosIncluded.length > 0 ? (
            <div>
              <button className={styles.comboSectionHeader} onClick={() => onToggleSection('complete')}>
                <span className={`${styles.groupArrow}${!comboSectionsOpen.complete ? ' ' + styles.groupArrowCollapsed : ''}`} aria-hidden="true">
                  <ChevronDownIcon size={12} />
                </span>
                <span>Complete Combos</span>
                <span className={styles.comboSectionCount}>{combosIncluded.length}</span>
              </button>
              {comboSectionsOpen.complete && <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {combosIncluded.map((c, i) => (
                  <ComboResultCard key={i} combo={c} highlight deckCardNames={deckCards.map(dc => dc.name)} deckImages={deckImagesMap} onAddCard={name => onAddCard({ name })} onOpenDetail={onOpenDetail} />
                ))}
              </div>}
            </div>
          ) : (
            <div style={{ color: 'var(--text-faint)', fontSize: '0.82rem' }}>No complete combos found in this deck.</div>
          )}
          {combosAlmost.length > 0 && (
            <div>
              <button className={styles.comboSectionHeader} onClick={() => onToggleSection('incomplete')}>
                <span className={`${styles.groupArrow}${!comboSectionsOpen.incomplete ? ' ' + styles.groupArrowCollapsed : ''}`} aria-hidden="true">
                  <ChevronDownIcon size={12} />
                </span>
                <span>Incomplete Combos</span>
                <span className={styles.comboSectionCount}>{combosAlmost.length}</span>
              </button>
              {comboSectionsOpen.incomplete && <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {combosAlmost.slice(0, 20).map((c, i) => (
                  <ComboResultCard key={i} combo={c} highlight={false} deckCardNames={deckCards.map(dc => dc.name)} deckImages={deckImagesMap} onAddCard={name => onAddCard({ name })} onOpenDetail={onOpenDetail} />
                ))}
              </div>}
              {comboSectionsOpen.incomplete && combosAlmost.length > 20 && (
                <div style={{ color: 'var(--text-faint)', fontSize: '0.78rem' }}>+ {combosAlmost.length - 20} more incomplete combos</div>
              )}
            </div>
          )}
          <button onClick={onFetchCombos} style={{ alignSelf: 'flex-start', background: 'var(--s2)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 12px', color: 'var(--text-faint)', fontSize: '0.78rem', cursor: 'pointer' }}>
            Refresh
          </button>
        </>
      )}
    </div>
  )
}
