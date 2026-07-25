import { useRef } from 'react'
import { useModalKeys } from '../UI'
import { CloseIcon } from '../../icons'
import styles from './Sheet.module.css'

// Bottom sheet for everything the tracker opens over the table.
//
// Built on the SyncModal shell pattern (sticky header, internally scrolling body,
// a11y from useModalKeys) rather than UI.jsx's Modal, because Modal sets an
// explicit pixel height from measured content with max-height: none — tall content
// grows past the viewport and only the overlay scrolls, which loses the header.
// See project note: "Modal rework".
//
// Sheets are always rendered at page level, never inside a seat: a seat may carry
// transform: rotate(), and a transformed ancestor becomes the containing block for
// position: fixed, which would trap the sheet inside one panel.
export default function Sheet({
  title,
  subtitle,
  rotation = 0,
  onClose,
  footer,
  children,
  size = 'md',
}) {
  const ref = useRef(null)
  useModalKeys(ref, { onClose })

  // Only 180° is mirrored. A player on the left or right edge of the device gets
  // an upright sheet on purpose: a ±90° sheet would be as tall as the screen is
  // wide, so the controls would not fit.
  const flipped = rotation === 180

  return (
    <div
      className={styles.overlay}
      data-flip={flipped ? 'true' : undefined}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={ref}
        className={styles.sheet}
        data-size={size}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <h2 className={styles.title}>{title}</h2>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            <CloseIcon size={14} />
          </button>
        </header>

        <div className={styles.body}>{children}</div>

        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </div>
  )
}
