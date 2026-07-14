import { useMemo } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from '../../icons'
import { getWarningTargetIds, groupDeckWarnings } from '../../lib/deckWarningNavigation'
import styles from '../../pages/DeckBuilder.module.css'

export default function DeckWarningPanel({
  warnings,
  deckCards,
  open,
  onToggle,
  onRevealTarget,
  canHover = false,
  onShowTooltip,
  onMoveTooltip,
  onHideTooltip,
}) {
  const warningGroups = useMemo(() => groupDeckWarnings(warnings), [warnings])

  if (!warnings?.length) return null

  const errorCount = warnings.filter(warning => warning.level === 'error').length
  const summary = `${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`
  const details = warnings.map(warning => warning.summary || warning.text)
  const deckCardIdSet = new Set((deckCards || []).map(card => String(card.id)))
  const showTooltip = (x, y) => onShowTooltip?.({ summary, details, x, y })
  const hideTooltip = () => onHideTooltip?.()

  const toggleDetails = () => {
    hideTooltip()
    onToggle?.()
  }

  return (
    <div className={styles.warningPanel}>
      <div className={styles.warningPanelBar}>
        <button
          type="button"
          className={`${styles.warningSummaryBtn}${errorCount > 0 ? ' ' + styles.warningSummaryBtnError : ''}`}
          title={open ? 'Hide deck warnings' : 'Review deck warnings'}
          aria-label={`${summary}. ${open ? 'Hide' : 'Show'} warning details`}
          aria-expanded={open}
          aria-controls="deck-warning-details"
          onMouseEnter={canHover ? event => showTooltip(event.clientX, event.clientY) : undefined}
          onMouseMove={canHover ? event => onMoveTooltip?.({ x: event.clientX, y: event.clientY }) : undefined}
          onMouseLeave={canHover ? hideTooltip : undefined}
          onFocus={canHover ? event => {
            const rect = event.currentTarget.getBoundingClientRect()
            showTooltip(rect.left, rect.bottom)
          } : undefined}
          onBlur={canHover ? hideTooltip : undefined}
          onClick={toggleDetails}
        >
          <span className={styles.warningSummaryIcon} aria-hidden="true">!</span>
          <span className={styles.warningSummaryLabel}>{summary}</span>
        </button>
        <button
          type="button"
          className={styles.warningDetailsBtn}
          aria-expanded={open}
          aria-controls="deck-warning-details"
          onClick={toggleDetails}
        >
          <span>{open ? 'Hide issues' : 'Review issues'}</span>
          <ChevronDownIcon size={12} className={open ? styles.warningDetailsChevronOpen : undefined} />
        </button>
      </div>
      {open && (
        <div id="deck-warning-details" className={styles.warningDetails} role="region" aria-label="Deck warning details">
          {warningGroups.map(group => (
            <section key={group.id} className={styles.warningGroup}>
              <div className={styles.warningGroupTitle}>
                <span>{group.label}</span>
                <span className={styles.warningGroupCount}>{group.warnings.length}</span>
              </div>
              <div className={styles.warningList}>
                {group.warnings.map(warning => {
                  const targetId = getWarningTargetIds(warning).find(id => deckCardIdSet.has(id))
                  const content = (
                    <>
                      <span className={styles.warningItemText}>
                        <span className={styles.warningItemSummary}>{warning.summary || warning.text}</span>
                        {warning.detail && <span className={styles.warningItemDetail}>{warning.detail}</span>}
                      </span>
                      {targetId && <ChevronRightIcon size={13} className={styles.warningItemArrow} aria-hidden="true" />}
                    </>
                  )

                  return targetId ? (
                    <button
                      key={warning.key}
                      type="button"
                      className={`${styles.warningItem} ${styles.warningItemError} ${styles.warningItemAction}`}
                      onClick={() => onRevealTarget?.(targetId)}
                      title={`Go to ${(deckCards || []).find(card => String(card.id) === targetId)?.name || 'affected card'}`}
                    >
                      {content}
                    </button>
                  ) : (
                    <div key={warning.key} className={`${styles.warningItem} ${styles.warningItemError}`}>
                      {content}
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
