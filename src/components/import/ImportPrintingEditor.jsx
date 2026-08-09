import { useEffect, useRef, useState } from 'react'
import { fetchPaperPrintings } from '../../lib/deckBuilderApi'
import { printingHasFoil } from '../../lib/importReview'
import styles from './ImportReviewList.module.css'
import uiStyles from '../UI.module.css'

const BTN = `${uiStyles.btn} ${uiStyles.sm}`
const BTN_PRIMARY = `${BTN} ${uiStyles.primary}`
const BTN_SECONDARY = `${BTN} ${uiStyles.secondary}`

const printingImage = (printing) =>
  printing?.image_uris?.small || printing?.card_faces?.[0]?.image_uris?.small || null

/**
 * Inline "which printing is this?" picker, expanded under a review row.
 *
 * Owns its own fetch and selection so both import modals get it from one place
 * — the builder import had no way to correct a row at all, so a wrong printing
 * meant cancelling and re-pasting the whole list.
 */
export default function ImportPrintingEditor({ row, onApply, onCancel }) {
  const [printings, setPrintings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(row?.sfCard || null)
  const [foil, setFoil] = useState(!!row?.foil)
  // Reopening on another row while the first fetch is in flight must not let
  // the stale response win.
  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    let cancelled = false
    setLoading(true)
    setError('')
    setSelected(row?.sfCard || null)

    fetchPaperPrintings(row?.resolvedName || row?.name)
      .then(list => {
        if (cancelled || seq !== seqRef.current) return
        const best =
          list.find(p => p.id === row?.sfCard?.id) ||
          list.find(p =>
            p.set === (row?.resolvedSetCode || row?.setCode) &&
            p.collector_number === (row?.resolvedCollectorNumber || row?.collectorNumber)) ||
          row?.sfCard || list[0] || null
        setPrintings(list)
        setSelected(best)
        setFoil(!!row?.foil && printingHasFoil(best))
      })
      .catch(err => {
        if (cancelled || seq !== seqRef.current) return
        setError(err?.message || 'Could not load printings.')
      })
      .finally(() => {
        if (!cancelled && seq === seqRef.current) setLoading(false)
      })

    return () => { cancelled = true }
  }, [row])

  const canFoil = printingHasFoil(selected)

  return (
    <div className={styles.editPanel}>
      <div className={styles.editHeader}>
        <span>Choose printing</span>
        <div className={styles.editActions}>
          <button type="button" className={BTN_SECONDARY} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => onApply(selected, foil)}
            disabled={!selected}
          >
            Apply
          </button>
        </div>
      </div>

      {error && <div className={styles.editError}>{error}</div>}

      {loading ? (
        <div className={styles.editLoading}>Loading printings…</div>
      ) : printings.length === 0 && !error ? (
        <div className={styles.editLoading}>No paper printings found for this card.</div>
      ) : (
        <div className={styles.printingGrid}>
          {printings.map(printing => {
            const image = printingImage(printing)
            return (
              <button
                key={printing.id}
                type="button"
                className={`${styles.printingCard} ${selected?.id === printing.id ? styles.printingCardActive : ''}`}
                aria-pressed={selected?.id === printing.id}
                onClick={() => {
                  setSelected(printing)
                  if (!printingHasFoil(printing)) setFoil(false)
                }}
                title={`${printing.set_name || printing.set} ${printing.collector_number}`}
              >
                {image
                  ? <img src={image} alt={printing.name} className={styles.printingImage} loading="lazy" />
                  : <div className={styles.printingImageEmpty} />}
                <span className={styles.printingSet}>{printing.set?.toUpperCase()}</span>
                <span className={styles.printingMeta}>#{printing.collector_number}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className={styles.editBottom}>
        <button
          type="button"
          className={`${styles.foilSwitch} ${foil ? styles.foilSwitchOn : ''}`}
          onClick={() => canFoil && setFoil(value => !value)}
          disabled={!canFoil}
          aria-pressed={foil}
        >
          <span className={styles.foilSwitchText}>Foil</span>
          <span className={styles.foilSwitchTrack}>
            <span className={styles.foilSwitchKnob} />
          </span>
        </button>
        {!canFoil && !loading && <span className={styles.noFoilText}>No foil version for this printing</span>}
      </div>
    </div>
  )
}
