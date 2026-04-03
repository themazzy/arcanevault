import { Children, isValidElement, useState, useRef, useEffect, useLayoutEffect } from 'react'
import styles from './UI.module.css'

function ChevronIcon({ open = false }) {
  return (
    <svg
      className={`${styles.chevronIcon}${open ? ` ${styles.chevronIconOpen}` : ''}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="2,3 5,6.5 8,3" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="3" y1="3" x2="11" y2="11" />
      <line x1="11" y1="3" x2="3" y2="11" />
    </svg>
  )
}

export function Button({
  children,
  variant = 'default',
  size = 'md',
  onClick,
  disabled,
  type = 'button',
  className = '',
  active = false,
  block = false,
  icon = false,
  style,
  ...props
}) {
  return (
    <button
      type={type}
      className={[
        styles.btn,
        styles[variant],
        styles[size],
        active ? styles.active : '',
        block ? styles.block : '',
        icon ? styles.iconOnly : '',
        className,
      ].filter(Boolean).join(' ')}
      onClick={onClick}
      disabled={disabled}
      style={style}
      {...props}
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

export function Select({ value, onChange, children, className = '', style, disabled = false, title = 'Select option' }) {
  const rawOptions = Children.toArray(children)
    .filter(child => isValidElement(child) && child.type === 'option')
    .map(child => ({
      value: child.props.value,
      label: child.props.children,
      disabled: !!child.props.disabled,
    }))

  const createOption = rawOptions.find(option => {
    const labelText = typeof option.label === 'string' ? option.label : ''
    return String(option.value) === 'new' || /create new/i.test(labelText)
  })

  const options = createOption
    ? [createOption, ...rawOptions.filter(option => option !== createOption)]
    : rawOptions

  const selected = options.find(option => String(option.value) === String(value)) || options[0] || null

  const handleSelect = (nextValue) => {
    if (!onChange) return
    onChange({
      target: { value: nextValue },
      currentTarget: { value: nextValue },
    })
  }

  return (
    <ResponsiveMenu
      title={title}
      align="left"
      wrapClassName={styles.selectWrap}
      panelClassName={styles.selectPanel}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={`${styles.select} ${open ? styles.selectOpen : ''} ${disabled ? styles.selectDisabled : ''} ${className}`}
          style={style}
          onClick={() => !disabled && toggle()}
          aria-haspopup="menu"
          aria-expanded={disabled ? false : open}
          disabled={disabled}
        >
          <span className={styles.selectLabel}>{selected?.label || ''}</span>
          <span className={styles.selectChevron}><ChevronIcon open={open} /></span>
        </button>
      )}
    >
      {({ close }) => (
        <div className={styles.responsiveMenuList}>
          {options.map(option => (
            <button
              key={String(option.value)}
              type="button"
              disabled={option.disabled}
              className={`${styles.responsiveMenuAction} ${String(option.value) === String(value) ? styles.responsiveMenuActionActive : ''} ${option.disabled ? styles.selectOptionDisabled : ''}`}
              onClick={() => {
                if (option.disabled) return
                handleSelect(option.value)
                close()
              }}
            >
              <span>{option.label}</span>
              <span className={styles.responsiveMenuCheck} aria-hidden="true">
                {String(option.value) === String(value) ? '✓' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </ResponsiveMenu>
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

export function Modal({ children, onClose, allowOverflow = true }) {
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
        className={`${styles.modal} ${allowOverflow ? styles.modalAllowOverflow : ''}`}
        style={modalHeight ? { height: `${modalHeight}px` } : undefined}
        onClick={e => e.stopPropagation()}
      >
        <button className={styles.closeBtn} onClick={onClose}>×</button>
        <div ref={modalContentRef} className={`${styles.modalContent} ${allowOverflow ? styles.modalContentAllowOverflow : ''}`}>
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

export function ResponsiveHeaderActions({ primary = null, children, menuLabel = 'More actions', mobileExtra = null }) {
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
        {mobileExtra ? <div className={styles.headerActionMobileExtra}>{mobileExtra}</div> : null}
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
  onOpenChange,
}) {
  const [rendered, setRendered] = useState(false)
  const [closing, setClosing] = useState(false)
  const [desktopPanelStyle, setDesktopPanelStyle] = useState(null)
  const ref = useRef(null)
  const panelRef = useRef(null)
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
    if (typeof window !== 'undefined' && window.innerWidth <= 640) return
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) closeMenu()
    }
    document.addEventListener('mousedown', close)
    return () => {
      document.removeEventListener('mousedown', close)
    }
  }, [rendered])

  useLayoutEffect(() => {
    if (!rendered) return

    const updateDesktopBounds = () => {
      if (typeof window === 'undefined') return
      if (window.innerWidth <= 640) {
        setDesktopPanelStyle(null)
        return
      }
      const panelEl = panelRef.current
      if (!panelEl) return
      const rect = panelEl.getBoundingClientRect()
      const bottomGap = 16
      const sideGap = 8
      const available = Math.max(180, Math.floor(window.innerHeight - rect.top - bottomGap))
      const nextStyle = { maxHeight: `${Math.min(360, available)}px` }

      if (align === 'left' && rect.right > window.innerWidth - sideGap) {
        nextStyle.left = 'auto'
        nextStyle.right = '0'
      } else if (align !== 'left' && rect.left < sideGap) {
        nextStyle.left = '0'
        nextStyle.right = 'auto'
      }

      setDesktopPanelStyle(nextStyle)
    }

    updateDesktopBounds()
    window.addEventListener('resize', updateDesktopBounds)
    window.addEventListener('scroll', updateDesktopBounds, true)

    return () => {
      window.removeEventListener('resize', updateDesktopBounds)
      window.removeEventListener('scroll', updateDesktopBounds, true)
    }
  }, [rendered, align])

  useEffect(() => () => clearCloseTimeout(), [])

  const toggleMenu = () => {
    if (rendered && !closing) closeMenu()
    else openMenu()
  }
  const open = rendered && !closing

  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

  const handleBackdropPointerDown = (e) => {
    e.preventDefault()
    e.stopPropagation()
    closeMenu()
  }

  return (
    <div ref={ref} className={`${styles.responsiveMenuWrap} ${open ? styles.responsiveMenuWrapOpen : ''} ${wrapClassName}`}>
      {trigger({ open, setOpen, toggle: toggleMenu, close: closeMenu })}
      {rendered && (
        <>
          <button
            type="button"
            className={`${styles.responsiveMenuBackdrop} ${closing ? styles.responsiveMenuBackdropClosing : ''}`}
            aria-label={`Close ${title}`}
            onMouseDown={handleBackdropPointerDown}
            onTouchStart={handleBackdropPointerDown}
            onClick={closeMenu}
          />
          <div
            ref={panelRef}
            className={`${styles.responsiveMenuPanel} ${align === 'left' ? styles.responsiveMenuPanelLeft : ''} ${closing ? styles.responsiveMenuPanelClosing : ''} ${panelClassName}`}
            style={desktopPanelStyle || undefined}
            onClick={e => e.stopPropagation()}
          >
            <div className={styles.responsiveMenuHeader}>
              <div className={styles.responsiveMenuHeaderTop}>
                <span className={styles.responsiveMenuTitle}>{title}</span>
                <button type="button" className={styles.responsiveMenuClose} onClick={closeMenu} aria-label={closeLabel}>
                  <CloseIcon />
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
