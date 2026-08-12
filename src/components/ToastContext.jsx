import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { CloseIcon } from '../icons'
import styles from './ToastContext.module.css'

const ToastContext = createContext(null)

/**
 * House style for toast copy: one complete sentence, ending in a full stop.
 *
 * Applied centrally rather than left to 62 call sites, because half the
 * messages end in an interpolated runtime string — `Rename failed:
 * ${err.message}` — and whether *that* arrives punctuated depends on whoever
 * threw it. Postgres, fetch, and our own `new Error()` all differ, so a literal
 * "." in the template produces "…already exists.." about a third of the time.
 *
 * Idempotent: a message already ending in terminal punctuation is untouched, so
 * call sites that read as finished sentences in source stay that way.
 */
const TERMINAL_PUNCTUATION = /[.!?…:]$/

export function formatToastMessage(message) {
  const text = String(message ?? '').trimEnd()
  if (!text) return text
  return TERMINAL_PUNCTUATION.test(text) ? text : `${text}.`
}

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
    const text = formatToastMessage(message)
    if (!text) return null
    const id = crypto.randomUUID()
    setToasts(prev => [...prev.slice(-2), {
      id,
      message: text,
      tone: opts.tone || 'success',
      actionLabel: opts.actionLabel || null,
      onAction: typeof opts.onAction === 'function' ? opts.onAction : null,
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

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className={styles.toastStack}
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
