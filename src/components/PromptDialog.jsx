import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from './UI'
import styles from './PromptDialog.module.css'

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
    <Modal onClose={onCancel} allowOverflow={false} className={styles.modal}>
      <p className={styles.title}>{state.title}</p>
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        value={value}
        placeholder={state.placeholder || ''}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          // Enter submits. Escape is also handled globally by Modal, but keeping
          // it here means it fires the instant the field is focused.
          if (e.key === 'Enter') { e.preventDefault(); submit() }
          if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        }}
      />
      <div className={styles.actions}>
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={submit}>{state.submitLabel || 'OK'}</Button>
      </div>
    </Modal>
  )
}
