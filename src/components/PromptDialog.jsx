import { useEffect, useRef, useState } from 'react'
// Reuses the DeckBuilder confirm-dialog styles intentionally so prompt + confirm
// render identically. If this is ever needed outside of DeckBuilder, move the
// CSS classes into a shared module.
import styles from '../pages/DeckBuilder.module.css'

/**
 * Async string prompt rendered as a modal — replaces window.prompt.
 *
 * Usage:
 *   const [promptState, setPromptState] = useState(null)
 *   const promptAsync = (opts) => new Promise(resolve => setPromptState({ ...opts, resolve }))
 *   const handleResolve = (value) => { promptState?.resolve(value); setPromptState(null) }
 *
 *   {promptState && (
 *     <PromptDialog
 *       state={promptState}
 *       onCancel={() => handleResolve(null)}
 *       onSubmit={(v) => handleResolve(v)}
 *     />
 *   )}
 *
 * State shape:
 *   { title, placeholder?, initialValue?, submitLabel?, resolve }
 */
export default function PromptDialog({ state, onCancel, onSubmit }) {
  const [value, setValue] = useState(state.initialValue || '')
  const inputRef = useRef(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const submit = () => {
    const trimmed = String(value || '').trim()
    if (!trimmed) { onCancel(); return }
    onSubmit(trimmed)
  }
  return (
    <div className={styles.confirmOverlay} onClick={onCancel}>
      <div className={styles.confirmDialog} onClick={e => e.stopPropagation()}>
        <div className={styles.confirmMsg}>
          <p style={{ fontWeight: 600, marginBottom: 12 }}>{state.title}</p>
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={state.placeholder || ''}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); submit() }
              if (e.key === 'Escape') { e.preventDefault(); onCancel() }
            }}
            style={{
              width: '100%',
              padding: '8px 10px',
              background: 'var(--s2)',
              border: '1px solid var(--s-border2)',
              borderRadius: 4,
              color: 'var(--text)',
              fontSize: '0.9rem',
            }}
          />
        </div>
        <div className={styles.confirmActions}>
          <button className={styles.confirmCancel} onClick={onCancel}>Cancel</button>
          <button className={styles.confirmOk} onClick={submit}>{state.submitLabel || 'OK'}</button>
        </div>
      </div>
    </div>
  )
}
