import { useState, useRef } from 'react'
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
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <button className={styles.closeBtn} onClick={onClose}>×</button>
        {children}
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

export function Badge({ children, variant = 'default' }) {
  return <span className={`${styles.badge} ${styles['badge_' + variant]}`}>{children}</span>
}
