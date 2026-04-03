import { useState, useRef, useEffect } from 'react'
import styles from './UI.module.css'

export function Button({ children, variant = 'default', size = 'md', onClick, disabled, type = 'button', className = '' }) {
  return (
    <button
      type={type}
      className={`${styles.btn} ${styles[variant]} ${styles[size]} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export function Input({ value, onChange, placeholder, type = 'text', className = '' }) {
  return (
    <input
      type={type}
      className={`${styles.input} ${className}`}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  )
}

export function Select({ value, onChange, children, className = '' }) {
  return (
    <select className={`${styles.select} ${className}`} value={value} onChange={onChange}>
      {children}
    </select>
  )
}

export function ProgressBar({ value, label }) {
  return (
    <div className={styles.progressWrap}>
      <div className={styles.progressBar} style={{ width: `${value}%` }} />
      {label && <div className={styles.progressLabel}>{label}</div>}
    </div>
  )
}

export function ErrorBox({ children }) {
  if (!children) return null
  return <div className={styles.errorBox}>{children}</div>
}

export function EmptyState({ children }) {
  return <div className={styles.empty}>{children}</div>
}

export function DropZone({ onFile, title, subtitle }) {
  const [dragover, setDragover] = useState(false)
  const ref = useRef()
  return (
    <div
      className={`${styles.dropZone}${dragover ? ' ' + styles.dragover : ''}`}
      onClick={() => ref.current?.click()}
      onDragOver={e => { e.preventDefault(); setDragover(true) }}
      onDragLeave={() => setDragover(false)}
      onDrop={e => { e.preventDefault(); setDragover(false); onFile(e.dataTransfer.files[0]) }}
    >
      <div className={styles.dropIcon}>⬡</div>
      <div className={styles.dropTitle}>{title}</div>
      <div className={styles.dropSub} dangerouslySetInnerHTML={{ __html: subtitle }} />
      <input ref={ref} type="file" accept=".csv" style={{ display: 'none' }}
        onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
    </div>
  )
}

export function Modal({ children, onClose }) {
  const modalRef = useRef(null)
  const modalContentRef = useRef(null)
  const [modalHeight, setModalHeight] = useState(null)

  useEffect(() => {
    const modalEl = modalRef.current
    const contentEl = modalContentRef.current
    if (!modalEl || !contentEl) return

    let frame = 0
    const updateHeight = () => {
      const computed = window.getComputedStyle(modalEl)
      const paddingY =
        parseFloat(computed.paddingTop || '0') +
        parseFloat(computed.paddingBottom || '0') +
        parseFloat(computed.borderTopWidth || '0') +
        parseFloat(computed.borderBottomWidth || '0')
      setModalHeight(contentEl.offsetHeight + paddingY)
    }

    updateHeight()
    frame = window.requestAnimationFrame(updateHeight)

    const observer = new ResizeObserver(() => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(updateHeight)
    })

    observer.observe(contentEl)
    window.addEventListener('resize', updateHeight)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', updateHeight)
    }
  }, [children])

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        ref={modalRef}
        className={styles.modal}
        style={modalHeight ? { height: `${modalHeight}px` } : undefined}
        onClick={e => e.stopPropagation()}
      >
        <button className={styles.closeBtn} onClick={onClose}>×</button>
        <div ref={modalContentRef} className={styles.modalContent}>
          {children}
        </div>
      </div>
    </div>
  )
}

export function SectionHeader({ title, action }) {
  return (
    <div className={styles.sectionHeader}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {action}
    </div>
  )
}

export function ResponsiveHeaderActions({ primary = null, children, menuLabel = 'More actions' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className={styles.headerActionShell} ref={ref}>
      <div className={styles.headerActionDesktop}>
        {primary}
        {children}
      </div>

      <div className={styles.headerActionMobile}>
        {primary}
        <button
          className={styles.headerMenuBtn}
          onClick={() => setOpen(v => !v)}
          aria-label={menuLabel}
          aria-expanded={open}
        >
          <span />
          <span />
          <span />
        </button>
        {open && (
          <div className={styles.headerMenuPanel}>
            {children}
          </div>
        )}
      </div>
    </div>
  )
}

export function ResponsiveMenu({
  title = 'Menu',
  trigger,
  children,
  align = 'right',
  wrapClassName = '',
  panelClassName = '',
  closeLabel = 'Done',
}) {
  const [rendered, setRendered] = useState(false)
  const [closing, setClosing] = useState(false)
  const ref = useRef(null)
  const closeTimeoutRef = useRef(null)

  const clearCloseTimeout = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current)
      closeTimeoutRef.current = null
    }
  }

  const openMenu = () => {
    clearCloseTimeout()
    setClosing(false)
    setRendered(true)
  }

  const closeMenu = () => {
    if (!rendered || closing) return
    clearCloseTimeout()
    setClosing(true)
    closeTimeoutRef.current = setTimeout(() => {
      setRendered(false)
      setClosing(false)
      closeTimeoutRef.current = null
    }, 220)
  }

  const setOpen = (next) => {
    const current = rendered && !closing
    const nextValue = typeof next === 'function' ? next(current) : next
    if (nextValue) openMenu()
    else closeMenu()
  }

  useEffect(() => {
    if (!rendered) return
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) closeMenu()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('touchstart', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('touchstart', close)
    }
  }, [rendered])

  useEffect(() => () => clearCloseTimeout(), [])

  const toggleMenu = () => {
    if (rendered && !closing) closeMenu()
    else openMenu()
  }
  const open = rendered && !closing

  return (
    <div ref={ref} className={`${styles.responsiveMenuWrap} ${wrapClassName}`}>
      {trigger({ open, setOpen, toggle: toggleMenu, close: closeMenu })}
      {rendered && (
        <>
          <button
            type="button"
            className={`${styles.responsiveMenuBackdrop} ${closing ? styles.responsiveMenuBackdropClosing : ''}`}
            aria-label={`Close ${title}`}
            onClick={closeMenu}
          />
          <div
            className={`${styles.responsiveMenuPanel} ${align === 'left' ? styles.responsiveMenuPanelLeft : ''} ${closing ? styles.responsiveMenuPanelClosing : ''} ${panelClassName}`}
            onClick={e => e.stopPropagation()}
          >
            <div className={styles.responsiveMenuHeader}>
              <div className={styles.responsiveMenuHeaderTop}>
                <span className={styles.responsiveMenuTitle}>{title}</span>
                <button type="button" className={styles.responsiveMenuClose} onClick={closeMenu}>
                  {closeLabel}
                </button>
              </div>
            </div>
            <div className={styles.responsiveMenuBody}>
              {typeof children === 'function' ? children({ close: closeMenu }) : children}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function Badge({ children, variant = 'default' }) {
  return <span className={`${styles.badge} ${styles['badge_' + variant]}`}>{children}</span>
}
