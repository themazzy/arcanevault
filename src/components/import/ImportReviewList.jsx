import { Fragment, useEffect, useState } from 'react'
import { MATCH_NOTE_LABELS } from '../../lib/importFlow'
import {
  REVIEW_ISSUE,
  applyPrintingChoice,
  orderReviewRows,
  reviewFootnote,
  reviewRowIssue,
} from '../../lib/importReview'
import { AlertIcon, CheckIcon, WarningIcon } from '../../icons'
import ImportPrintingEditor from './ImportPrintingEditor'
import styles from './ImportReviewList.module.css'
import uiStyles from '../UI.module.css'

const BTN_SECONDARY = `${uiStyles.btn} ${uiStyles.sm} ${uiStyles.secondary}`

function formatSet(row) {
  const setCode = row.resolvedSetCode || row.setCode
  const collectorNumber = row.resolvedCollectorNumber || row.collectorNumber
  if (!setCode) return ''
  return `${String(setCode).toUpperCase()}${collectorNumber ? ` ${collectorNumber}` : ''}`
}

/**
 * The "did this resolve to the cards I meant?" list, shared by the collection
 * and builder imports.
 *
 * That question is identical on both sides — nothing about it depends on
 * whether the cards are owned — but the two had drifted into separate
 * implementations with different vocabulary, and only one of them had a way to
 * correct a row. What legitimately differs stays with the caller: the extra
 * per-row chips (`renderRowTags`), the demoted constants (`footnoteParts`) and
 * the status line, which each modal computes from its own state.
 */
export default function ImportReviewList({
  rows,
  status = null,
  footnoteParts = [],
  pageSize = 0,
  renderRowTags = null,
  onRowChange = null,
  editDisabled = false,
  editDisabledTitle,
}) {
  const [page, setPage] = useState(0)
  const [editingIndex, setEditingIndex] = useState(null)

  // A fresh parse starts at the top with nothing expanded.
  useEffect(() => { setPage(0); setEditingIndex(null) }, [rows])

  const ordered = orderReviewRows(rows)
  const paginated = pageSize > 0 && ordered.length > pageSize
  const pageCount = paginated ? Math.max(1, Math.ceil(ordered.length / pageSize)) : 1
  const safePage = Math.min(page, pageCount - 1)
  const start = paginated ? safePage * pageSize : 0
  const slice = paginated ? ordered.slice(start, start + pageSize) : ordered

  const footnote = reviewFootnote(footnoteParts)

  return (
    <>
      {status && (
        <p className={`${styles.status} ${styles[`status_${status.tone}`]}`}>{status.text}</p>
      )}

      {paginated && (
        <div className={styles.pager}>
          <button
            type="button"
            className={`${BTN_SECONDARY} ${styles.pagerBtn}`}
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={safePage === 0}
          >
            Previous
          </button>
          <span className={styles.pagerStatus}>
            {start + 1}–{Math.min(start + pageSize, ordered.length)} of {ordered.length}
          </span>
          <button
            type="button"
            className={`${BTN_SECONDARY} ${styles.pagerBtn}`}
            onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
            disabled={safePage >= pageCount - 1}
          >
            Next
          </button>
        </div>
      )}

      <div className={styles.list}>
        {slice.map(({ row, index }) => {
          const issue = reviewRowIssue(row)
          const setLabel = formatSet(row)
          return (
            <Fragment key={`${row.name}-${index}`}>
              <div className={`${styles.row} ${issue === REVIEW_ISSUE.MISSING ? styles.rowMissing : ''}`}>
                <span
                  className={styles.qty}
                  aria-label={issue === REVIEW_ISSUE.MISSING
                    ? 'Unresolved'
                    : issue ? MATCH_NOTE_LABELS[row.matchNote] : 'Matched'}
                >
                  {issue === REVIEW_ISSUE.MISSING
                    ? <AlertIcon size={12} className={`${styles.statusIcon} ${styles.statusIconMissing}`} />
                    : issue
                      ? <WarningIcon size={12} className={`${styles.statusIcon} ${styles.statusIconNote}`} />
                      : <CheckIcon size={12} className={`${styles.statusIcon} ${styles.statusIconMatched}`} />}
                  <span>{row.qty}×</span>
                </span>

                <span className={styles.name}>
                  {row.matchNote && <span className={styles.typedName}>{row.name} →</span>}
                  <span className={styles.nameText}>{row.resolvedName || row.name}</span>
                  {row.foil && <span className={styles.tagFoil}>Foil</span>}
                  {renderRowTags?.(row)}
                  {issue === REVIEW_ISSUE.MISSING && (
                    <span className={styles.tagMissing}>{row.reason || 'Not found'}</span>
                  )}
                  {row.matchNote && <span className={styles.tagNote}>{MATCH_NOTE_LABELS[row.matchNote]}</span>}
                </span>

                {setLabel && <span className={styles.set}>{setLabel}</span>}

                {onRowChange && (
                  <button
                    type="button"
                    className={`${BTN_SECONDARY} ${styles.editBtn}`}
                    onClick={() => setEditingIndex(editingIndex === index ? null : index)}
                    disabled={editDisabled}
                    title={editDisabled ? editDisabledTitle : undefined}
                    aria-expanded={editingIndex === index}
                  >
                    Edit
                  </button>
                )}
              </div>

              {onRowChange && editingIndex === index && (
                <ImportPrintingEditor
                  row={row}
                  onCancel={() => setEditingIndex(null)}
                  onApply={(printing, foil) => {
                    onRowChange(index, applyPrintingChoice(row, printing, foil))
                    setEditingIndex(null)
                  }}
                />
              )}
            </Fragment>
          )
        })}
      </div>

      {footnote && <p className={styles.footnote}>{footnote}</p>}
    </>
  )
}
