import { createPortal } from 'react-dom'
import styles from '../../pages/DeckBuilder.module.css'

export function FloatingPreview({ imageUris, x, y }) {
  if (!imageUris?.length) return null
  const width = imageUris.length > 1 ? 400 : 300
  const left = x > window.innerWidth - (width + 40) ? x - (width - 60) : x + 16
  const top  = Math.min(y - 30, window.innerHeight - 330)
  return (
    <div className={styles.floatingPreview} style={{ left, top }}>
      <div className={styles.floatingPreviewStack}>
        {imageUris.map((uri, index) => (
          <img key={`${uri}:${index}`} className={styles.floatingImg} src={uri} alt="" />
        ))}
      </div>
    </div>
  )
}

export function WarningTooltip({ tooltip }) {
  if (!tooltip) return null
  const left = Math.min(tooltip.x + 14, window.innerWidth - 320)
  const top = Math.min(tooltip.y + 14, window.innerHeight - 160)
  return createPortal(
    <div className={styles.warningTooltip} style={{ left, top }}>
      {tooltip.summary && <div className={styles.warningTooltipTitle}>{tooltip.summary}</div>}
      {Array.isArray(tooltip.details) ? (
        <ul className={styles.warningTooltipList}>
          {tooltip.details.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : (
        <div className={styles.warningTooltipBody}>{tooltip.detail}</div>
      )}
    </div>,
    document.body
  )
}
