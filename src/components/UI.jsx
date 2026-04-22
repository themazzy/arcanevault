import { Children, isValidElement, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
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

function SelectBody({ options, value, handleSelect, close, searchable }) {
  const [filter, setFilter] = useState('')
  const inputRef = useRef(null)
  useEffect(() => { if (searchable) inputRef.current?.focus() }, [searchable])

  const visible = (searchable && filter.trim())
    ? options.filter(o => String(o.label).toLowerCase().includes(filter.toLowerCase()))
    : options

  return (
    <>
      {searchable && (
        <input
          ref={inputRef}
          type="text"
          className={styles.selectSearch}
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter…"
          onClick={e => e.stopPropagation()}
        />
      )}
      <div className={styles.responsiveMenuList}>
        {visible.map(option => (
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
        {visible.length === 0 && (
          <div className={styles.selectSearchEmpty}>No matches</div>
        )}
      </div>
    </>
  )
}

export function Select({ value, onChange, children, className = '', style, disabled = false, title = 'Select option', menuDirection = 'down', portal = false, searchable = false }) {
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
      direction={menuDirection}
      wrapClassName={styles.selectWrap}
      panelClassName={styles.selectPanel}
      portal={portal}
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
        <SelectBody
          options={options}
          value={value}
          handleSelect={handleSelect}
          close={close}
          searchable={searchable}
        />
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

export function DropZone({ onFile, title, subtitle, onActivate, accept = '.csv' }) {
  const [dragover, setDragover] = useState(false)
  const ref = useRef()
  return (
    <div
      className={`${styles.dropZone}${dragover ? ' ' + styles.dragover : ''}`}
      onClick={() => onActivate ? onActivate() : ref.current?.click()}
      onDragOver={e => { e.preventDefault(); setDragover(true) }}
      onDragLeave={() => setDragover(false)}
      onDrop={e => { e.preventDefault(); setDragover(false); onFile(e.dataTransfer.files[0]) }}
    >
      <div className={styles.dropIcon}>⬡</div>
      <div className={styles.dropTitle}>{title}</div>
      <div className={styles.dropSub} dangerouslySetInnerHTML={{ __html: subtitle }} />
      <input ref={ref} type="file" accept={accept} style={{ display: 'none' }}
        onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
    </div>
  )
}

export function Modal({ children, onClose, allowOverflow = true }) {
  const modalRef = useRef(null)
  const modalContentRef = useRef(null)
  const [modalHeight, setModalHeight] = useState(null)
  const handleOverlayClick = (e) => {
    if (e.target !== e.currentTarget) return
    onClose?.()
  }

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
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div
        ref={modalRef}
        className={`${styles.modal} ${allowOverflow ? styles.modalAllowOverflow : ''}`}
        style={modalHeight ? { height: `${modalHeight}px` } : undefined}
        onClick={e => e.stopPropagation()}
      >
        <button className={styles.closeBtn} onClick={e => { e.stopPropagation(); onClose?.() }}>×</button>
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
  const [panelClosing, setPanelClosing] = useState(false)
  const panelTimerRef = useRef(null)
  const ref = useRef(null)

  const openPanel  = () => {
    clearTimeout(panelTimerRef.current)
    panelTimerRef.current = null
    setPanelClosing(false)
    setOpen(true)
  }
  const closePanel = () => {
    if (panelTimerRef.current) return
    setPanelClosing(true)
    panelTimerRef.current = setTimeout(() => {
      setOpen(false)
      setPanelClosing(false)
      panelTimerRef.current = null
    }, 150)
  }
  const togglePanel = () => { if (open && !panelClosing) closePanel(); else openPanel() }

  useEffect(() => () => clearTimeout(panelTimerRef.current), [])

  useEffect(() => {
    if (!open) return
    const handle = (e) => {
      if (ref.current && !ref.current.contains(e.target)) closePanel()
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
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
          onClick={togglePanel}
          aria-label={menuLabel}
          aria-expanded={open}
        >
          <span />
          <span />
          <span />
        </button>
        {(open || panelClosing) && (
          <div className={`${styles.headerMenuPanel}${panelClosing ? ` ${styles.headerMenuPanelClosing}` : ''}`}>
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
  direction = 'down',
  wrapClassName = '',
  panelClassName = '',
  closeLabel = 'Done',
  onOpenChange,
  portal = false,
}) {
  const [rendered, setRendered] = useState(false)
  const [closing, setClosing] = useState(false)
  const [desktopPanelStyle, setDesktopPanelStyle] = useState(null)
  const ref = useRef(null)
  const panelRef = useRef(null)
  const backdropRef = useRef(null)
  const closeTimeoutRef = useRef(null)
  const closeMenuRef = useRef(null)

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
      if (ref.current && !ref.current.contains(e.target) &&
          !(portal && panelRef.current && panelRef.current.contains(e.target))) {
        closeMenu()
      }
    }
    document.addEventListener('mousedown', close)
    return () => {
      document.removeEventListener('mousedown', close)
    }
  }, [rendered, portal])

  useLayoutEffect(() => {
    if (!rendered) return

    const updateDesktopBounds = () => {
      if (typeof window === 'undefined') return
      if (window.innerWidth <= 640) {
        setDesktopPanelStyle(portal ? { zIndex: 750 } : null)
        return
      }

      if (portal) {
        const wrapEl = ref.current
        if (!wrapEl) return
        const wrapRect = wrapEl.getBoundingClientRect()
        const bottomGap = 16
        const sideGap = 8
        const nextStyle = { position: 'fixed', zIndex: 750 }

        if (direction === 'up') {
          nextStyle.bottom = Math.floor(window.innerHeight - wrapRect.top + 6)
          nextStyle.maxHeight = `${Math.min(360, Math.max(180, Math.floor(wrapRect.top - bottomGap - 6)))}px`
        } else {
          nextStyle.top = Math.floor(wrapRect.bottom + 6)
          nextStyle.maxHeight = `${Math.min(360, Math.max(180, Math.floor(window.innerHeight - wrapRect.bottom - bottomGap - 6)))}px`
        }

        if (align === 'left') {
          nextStyle.left = Math.max(sideGap, Math.floor(wrapRect.left))
          nextStyle.right = 'auto'
        } else {
          nextStyle.right = Math.max(sideGap, Math.floor(window.innerWidth - wrapRect.right))
          nextStyle.left = 'auto'
        }

        setDesktopPanelStyle(nextStyle)
        return
      }

      const panelEl = panelRef.current
      if (!panelEl) return
      const rect = panelEl.getBoundingClientRect()
      const bottomGap = 16
      const topGap = 16
      const sideGap = 8
      const availableBelow = Math.max(180, Math.floor(window.innerHeight - rect.top - bottomGap))
      const availableAbove = Math.max(180, Math.floor(rect.bottom - topGap))
      const available = direction === 'up' ? availableAbove : availableBelow
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
  }, [rendered, align, direction, portal])

  useEffect(() => () => clearCloseTimeout(), [])

  // Keep a stable ref so the native touchstart handler never goes stale
  closeMenuRef.current = closeMenu

  // Attach touchstart as non-passive so preventDefault actually works,
  // preventing the synthetic click that would otherwise activate elements beneath
  useEffect(() => {
    const el = backdropRef.current
    if (!el) return
    const handler = (e) => {
      e.preventDefault()
      e.stopPropagation()
      closeMenuRef.current?.()
    }
    el.addEventListener('touchstart', handler, { passive: false })
    return () => el.removeEventListener('touchstart', handler, { passive: false })
  }, [rendered])

  const toggleMenu = () => {
    if (rendered && !closing) closeMenu()
    else openMenu()
  }
  const open = rendered && !closing

  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

  const handleBackdropPointerDown = (e) => {
    e.stopPropagation()
    closeMenu()
  }

  const panelMarkup = rendered && (
    <>
      <button
        ref={backdropRef}
        type="button"
        className={`${styles.responsiveMenuBackdrop} ${closing ? styles.responsiveMenuBackdropClosing : ''}`}
        aria-label={`Close ${title}`}
        onMouseDown={handleBackdropPointerDown}
        onClick={e => { e.stopPropagation(); closeMenu() }}
      />
      <div
        ref={panelRef}
        className={`${styles.responsiveMenuPanel} ${align === 'left' ? styles.responsiveMenuPanelLeft : ''} ${direction === 'up' ? styles.responsiveMenuPanelUp : ''} ${closing ? styles.responsiveMenuPanelClosing : ''} ${panelClassName}`}
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
  )

  return (
    <div ref={ref} className={`${styles.responsiveMenuWrap} ${open ? styles.responsiveMenuWrapOpen : ''} ${wrapClassName}`}>
      {trigger({ open, setOpen, toggle: toggleMenu, close: closeMenu })}
      {portal ? (rendered && createPortal(panelMarkup, document.body)) : panelMarkup}
    </div>
  )
}

export function Badge({ children, variant = 'default' }) {
  return <span className={`${styles.badge} ${styles['badge_' + variant]}`}>{children}</span>
}
