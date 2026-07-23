import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { CloseIcon } from '../icons'
import styles from './ToastContext.module.css'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())

  const dismissToast = useCallback((id) => {
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
    setToasts(prev => prev.filter(toast => toast.id !== id))
  }, [])

  const showToast = useCallback((message, opts = {}) => {
    if (!message) return null
    const id = crypto.randomUUID()
    setToasts(prev => [...prev.slice(-2), {
      id,
      message,
      tone: opts.tone || 'success',
      actionLabel: opts.actionLabel || null,
      onAction: typeof opts.onAction === 'function' ? opts.onAction : null,
      placement: opts.placement || 'default',
    }])
    const timeout = window.setTimeout(() => dismissToast(id), opts.duration ?? 3200)
    timers.current.set(id, timeout)
    return id
  }, [dismissToast])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
  }, [])

  const value = useMemo(() => ({
    showToast,
    success: (message, opts) => showToast(message, { ...opts, tone: 'success' }),
    error: (message, opts) => showToast(message, { ...opts, tone: 'error' }),
    dismissToast,
  }), [showToast, dismissToast])

  const hasRaisedToast = toasts.some(toast => toast.placement === 'above-mobile-toolbar')

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className={`${styles.toastStack}${hasRaisedToast ? ` ${styles.toastStackRaised}` : ''}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`${styles.toast} ${
              toast.tone === 'error'
                ? styles.toastError
                : toast.tone === 'info'
                  ? styles.toastInfo
                  : styles.toastSuccess
            }${toast.actionLabel && toast.onAction ? ` ${styles.toastActionable}` : ''}`}
          >
            <span className={styles.toastDot} aria-hidden="true" />
            <span className={styles.toastMessage}>{toast.message}</span>
            {toast.actionLabel && toast.onAction && (
              <button
                type="button"
                className={styles.toastAction}
                onClick={() => {
                  dismissToast(toast.id)
                  Promise.resolve(toast.onAction()).catch(() => {})
                }}
              >
                {toast.actionLabel}
              </button>
            )}
            <button
              type="button"
              className={styles.toastDismiss}
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss notification"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
