import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
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
      <div className={styles.toastStack} role="status" aria-live="polite" aria-atomic="true">
        {toasts.map(toast => (
          <button
            key={toast.id}
            type="button"
            className={`${styles.toast} ${toast.tone === 'error' ? styles.toastError : styles.toastSuccess}`}
            onClick={() => dismissToast(toast.id)}
          >
            <span className={styles.toastDot} aria-hidden="true" />
            <span className={styles.toastMessage}>{toast.message}</span>
          </button>
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
