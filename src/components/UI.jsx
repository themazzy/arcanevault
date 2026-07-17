import { Children, isValidElement, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import styles from './UI.module.css'
import { CheckIcon, ChevronDownIcon, CloseIcon } from '../icons'

// Chevron with the open-state rotation the menus need. The glyph itself comes
// from the icon system — this only adds the rotate class.
function Chevron({ open = false }) {
  return (
    <ChevronDownIcon
      size={10}
      className={`${styles.chevronIcon}${open ? ` ${styles.chevronIconOpen}` : ''}`}
    />
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

  // While filtering, drop group headers and match options flat.
  const visible = (searchable && filter.trim())
    ? options.filter(o => !o.isGroup && String(o.label).toLowerCase().includes(filter.toLowerCase()))
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
        {visible.map((option, index) => option.isGroup ? (
          <div key={`group:${option.label}:${index}`} className={styles.selectGroupLabel}>{option.label}</div>
        ) : (
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
              {String(option.value) === String(value) ? <CheckIcon size={12} /> : null}
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

export function Select({ value, onChange, children, className = '', panelClassName = '', style, disabled = false, title = 'Select option', menuDirection = 'down', portal = false, searchable = false }) {
  // Flatten <option> and <optgroup> children. Groups become non-selectable
  // header rows ({ isGroup, label }) followed by their options.
  const rawOptions = []
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue
    if (child.type === 'option') {
      rawOptions.push({ value: child.props.value, label: child.props.children, disabled: !!child.props.disabled })
    } else if (child.type === 'optgroup') {
      const groupOptions = Children.toArray(child.props.children)
        .filter(c => isValidElement(c) && c.type === 'option')
      if (!groupOptions.length) continue
      rawOptions.push({ isGroup: true, label: child.props.label })
      for (const c of groupOptions) {
        rawOptions.push({ value: c.props.value, label: c.props.children, disabled: !!c.props.disabled })
      }
    }
  }

  const createOption = rawOptions.find(option => {
    if (option.isGroup) return false
    const labelText = typeof option.label === 'string' ? option.label : ''
    return String(option.value) === 'new' || /create new/i.test(labelText)
  })

  const options = createOption
    ? [createOption, ...rawOptions.filter(option => option !== createOption)]
    : rawOptions

  const selected = options.find(option => !option.isGroup && String(option.value) === String(value))
    || options.find(option => !option.isGroup)
    || null

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
      panelClassName={`${styles.selectPanel} ${panelClassName}`}
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
          <span className={styles.selectChevron}><Chevron open={open} /></span>
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

/**
 * Open-modal stack. Modals nest (a confirm dialog on top of a form modal), and
 * each puts a capture-phase keydown listener on `document`. Listeners on the
 * SAME node fire in registration order, so the OUTER modal — registered first —
 * would see Escape first and close, taking the inner one with it.
 * `e.stopPropagation()` cannot prevent this; it doesn't stop other listeners on
 * the same node. So the stack decides: only the topmost modal reacts to keys.
 */
const modalStack = []

export function Modal({
  children,
  onClose,
  allowOverflow = true,
  showClose = true,
  closeOnOverlay = true,
  closeOnEscape = true,
  className = '',
  contentClassName = '',
}) {
  const modalRef = useRef(null)
  const modalContentRef = useRef(null)
  const [modalHeight, setModalHeight] = useState(null)
  // Refs so the keyboard effect can run once (on mount) yet always see the
  // latest onClose/closeOnEscape — onClose is usually a fresh inline arrow.
  const onCloseRef = useRef(onClose)
  const closeOnEscapeRef = useRef(closeOnEscape)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
    closeOnEscapeRef.current = closeOnEscape
  }, [onClose, closeOnEscape])
  const handleOverlayClick = (e) => {
    if (e.target !== e.currentTarget) return
    if (!closeOnOverlay) return
    onClose?.()
  }

  // Keyboard + focus management: Escape closes, Tab is trapped within the
  // dialog, and focus is restored to the previously-focused element on close.
  useEffect(() => {
    const modalEl = modalRef.current
    if (!modalEl) return
    const prevActive = document.activeElement
    const focusables = () => Array.from(
      modalEl.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(el => el.offsetParent !== null || el === document.activeElement)

    // Claim the top of the stack for as long as this modal is mounted.
    const token = {}
    modalStack.push(token)
    const isTopmost = () => modalStack[modalStack.length - 1] === token

    // Move focus into the dialog without auto-selecting a control (least
    // surprising — lands on the container, Tab then enters the content).
    modalEl.focus({ preventScroll: true })

    const onKeyDown = (e) => {
      // A modal underneath an open one must ignore keys entirely — otherwise
      // Escape closes the whole stack and Tab is trapped by the wrong dialog.
      if (!isTopmost()) return
      if (e.key === 'Escape' && closeOnEscapeRef.current) {
        e.stopPropagation()
        onCloseRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (!items.length) { e.preventDefault(); modalEl.focus({ preventScroll: true }); return }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === modalEl)) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const i = modalStack.indexOf(token)
      if (i !== -1) modalStack.splice(i, 1)
      if (prevActive && typeof prevActive.focus === 'function') {
        prevActive.focus({ preventScroll: true })
      }
    }
  }, [])

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
      const nextHeight = contentEl.offsetHeight + paddingY
      setModalHeight(prev => (prev === nextHeight ? prev : nextHeight))
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
  }, [])

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`${styles.modal} ${allowOverflow ? styles.modalAllowOverflow : ''} ${className}`}
        style={modalHeight ? { height: `${modalHeight}px` } : undefined}
        onClick={e => e.stopPropagation()}
      >
        {showClose && (
          <button className={styles.closeBtn} onClick={e => { e.stopPropagation(); onClose?.() }}><CloseIcon size={13} /></button>
        )}
        <div ref={modalContentRef} className={`${styles.modalContent} ${allowOverflow ? styles.modalContentAllowOverflow : ''} ${contentClassName}`}>
          {children}
        </div>
      </div>
    </div>
  )
}

/**
 * Destructive-action confirm. Use instead of window.confirm() — the native
 * dialog can't be themed, blocks the event loop, and looks like a browser
 * warning rather than part of the app. Built on Modal, so it gets the focus
 * trap, Escape handling and scroll lock for free.
 */
export function ConfirmModal({
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  busy = false,
  onConfirm,
  onClose,
}) {
  return (
    <Modal onClose={onClose} allowOverflow={false} className={styles.confirmModal}>
      {/* title={null} for callers that only need a message */}
      {title && <h3 className={styles.confirmTitle}>{title}</h3>}
      {/* div, not p: `message` may be a node (e.g. split paragraphs), and a <p>
          inside a <p> is invalid and gets re-parented by the browser. */}
      {message && <div className={styles.confirmMessage}>{message}</div>}
      <div className={styles.confirmActions}>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>{cancelLabel}</Button>
        <Button variant={variant} size="sm" onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </Modal>
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

export function ResponsiveHeaderActions({ primary = null, children, menuLabel = 'More actions', mobileExtra = null, mobileToolbar = false }) {
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
  const mobileToolbarChildren = isValidElement(children) ? children.props.children : children

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
        {mobileExtra ? <div className={styles.headerActionMobileExtra}>{mobileExtra}</div> : null}
        {mobileToolbar ? (
          <div className={styles.headerFloatingToolbar} aria-label={menuLabel}>
            {primary}
            {mobileToolbarChildren}
          </div>
        ) : (
          <>
            {primary}
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
          </>
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
  forceSheet = false,
}) {
  const [rendered, setRendered] = useState(false)
  const [closing, setClosing] = useState(false)
  const [desktopPanelStyle, setDesktopPanelStyle] = useState(null)
  const ref = useRef(null)
  const panelRef = useRef(null)
  const backdropRef = useRef(null)

  const openMenu = useCallback(() => {
    setClosing(false)
    setRendered(true)
  }, [])

  const closeMenu = useCallback(() => {
    if (!rendered || closing) return
    setClosing(true)
  }, [rendered, closing])

  useEffect(() => {
    if (!closing) return
    const closeTimeout = setTimeout(() => {
      setRendered(false)
      setClosing(false)
    }, 220)
    return () => clearTimeout(closeTimeout)
  }, [closing])

  const setOpen = (next) => {
    const current = rendered && !closing
    const nextValue = typeof next === 'function' ? next(current) : next
    if (nextValue) openMenu()
    else closeMenu()
  }

  useEffect(() => {
    if (!rendered) return
    if (forceSheet || (typeof window !== 'undefined' && window.innerWidth <= 640)) return
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
  }, [rendered, portal, closeMenu])

  useLayoutEffect(() => {
    if (!rendered) return

    const updateDesktopBounds = () => {
      if (typeof window === 'undefined') return
      if (forceSheet || window.innerWidth <= 640) {
        setDesktopPanelStyle(portal ? { zIndex: 750 } : null)
        return
      }

      if (portal) {
        const wrapEl = ref.current
        if (!wrapEl) return
        const wrapRect = wrapEl.getBoundingClientRect()
        const bottomGap = 16
        const topGap = 16
        const sideGap = 8
        const nextStyle = { position: 'fixed', zIndex: 750 }
        const gap = 6
        const availableBelow = Math.floor(window.innerHeight - wrapRect.bottom - bottomGap - gap)
        const availableAbove = Math.floor(wrapRect.top - topGap - gap)
        const openUp = direction === 'up'
          ? availableAbove >= 180 || availableAbove >= availableBelow
          : availableBelow < 180 && availableAbove > availableBelow

        if (openUp) {
          nextStyle.bottom = Math.max(bottomGap, Math.floor(window.innerHeight - wrapRect.top + gap))
          nextStyle.top = 'auto'
          nextStyle.maxHeight = `${Math.min(360, Math.max(120, availableAbove))}px`
        } else {
          nextStyle.top = Math.min(
            Math.max(topGap, Math.floor(wrapRect.bottom + gap)),
            Math.max(topGap, window.innerHeight - bottomGap - 120)
          )
          nextStyle.bottom = 'auto'
          nextStyle.maxHeight = `${Math.min(360, Math.max(120, availableBelow))}px`
        }

        const panelWidth = Math.min(320, Math.max(180, window.innerWidth - (sideGap * 2)))
        const availableRight = window.innerWidth - wrapRect.left - sideGap
        const availableLeft = wrapRect.right - sideGap
        const openLeft = align === 'left'
          ? availableRight >= panelWidth || availableRight >= availableLeft
          : availableLeft < panelWidth && availableRight > availableLeft

        if (openLeft) {
          nextStyle.left = Math.min(
            Math.max(sideGap, Math.floor(wrapRect.left)),
            Math.max(sideGap, window.innerWidth - sideGap - panelWidth)
          )
          nextStyle.right = 'auto'
        } else {
          nextStyle.right = Math.min(
            Math.max(sideGap, Math.floor(window.innerWidth - wrapRect.right)),
            Math.max(sideGap, window.innerWidth - sideGap - panelWidth)
          )
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

  // Attach touchstart as non-passive so preventDefault actually works,
  // preventing the synthetic click that would otherwise activate elements beneath
  useEffect(() => {
    const el = backdropRef.current
    if (!el) return
    const handler = (e) => {
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
    }
    el.addEventListener('touchstart', handler, { passive: false })
    return () => el.removeEventListener('touchstart', handler, { passive: false })
  }, [rendered, closeMenu])

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
        className={`${styles.responsiveMenuBackdrop} ${forceSheet ? styles.responsiveMenuBackdropForceSheet : ''} ${closing ? styles.responsiveMenuBackdropClosing : ''}`}
        aria-label={`Close ${title}`}
        onMouseDown={handleBackdropPointerDown}
        onClick={e => { e.stopPropagation(); closeMenu() }}
      />
      <div
        ref={panelRef}
        className={`${styles.responsiveMenuPanel} ${align === 'left' ? styles.responsiveMenuPanelLeft : ''} ${direction === 'up' ? styles.responsiveMenuPanelUp : ''} ${forceSheet ? styles.responsiveMenuPanelForceSheet : ''} ${closing ? styles.responsiveMenuPanelClosing : ''} ${panelClassName}`}
        style={desktopPanelStyle || undefined}
        onClick={e => e.stopPropagation()}
      >
        <div className={styles.responsiveMenuHeader}>
          <div className={styles.responsiveMenuHeaderTop}>
            <span className={styles.responsiveMenuTitle}>{title}</span>
            <button type="button" className={styles.responsiveMenuClose} onClick={closeMenu} aria-label={closeLabel}>
              <CloseIcon size={14} />
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
