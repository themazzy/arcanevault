import { useState } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import { Modal } from './UI'
import styles from './FeedbackModal.module.css'

export default function FeedbackModal({ onClose }) {
  const { user } = useAuth()
  const [type,        setType]        = useState('bug')
  const [description, setDescription] = useState('')
  const [contact,     setContact]     = useState('')
  const [submitting,  setSubmitting]  = useState(false)
  const [done,        setDone]        = useState(false)

  const handleSubmit = async () => {
    if (!description.trim()) return
    setSubmitting(true)
    try {
      await sb.from('feedback').insert({
        type,
        description: description.trim(),
        contact:     contact.trim() || null,
        user_id:     user?.id || null,
        user_email:  user?.email || null,
      })
      setDone(true)
    } catch (err) {
      console.error('feedback submit:', err)
    }
    setSubmitting(false)
  }

  if (done) return (
    <Modal onClose={onClose}>
      <div className={styles.doneWrap}>
        <div className={styles.doneIcon}>✓</div>
        <h2 className={styles.doneTitle}>Thanks!</h2>
        <p className={styles.doneSub}>Your feedback has been received. I'll review it shortly.</p>
        <button className={styles.doneBtn} onClick={onClose}>Close</button>
      </div>
    </Modal>
  )

  return (
    <Modal onClose={onClose}>
      <h2 className={styles.title}>
        {type === 'bug' ? '🐛 Report a Bug' : '✨ Request a Feature'}
      </h2>

      <div className={styles.typeRow}>
        <button
          className={`${styles.typeBtn} ${type === 'bug' ? styles.typeBtnActive : ''}`}
          onClick={() => setType('bug')}>
          🐛 Bug Report
        </button>
        <button
          className={`${styles.typeBtn} ${type === 'feature' ? styles.typeBtnActive : ''}`}
          onClick={() => setType('feature')}>
          ✨ Feature Request
        </button>
      </div>

      <label className={styles.label}>
        {type === 'bug' ? 'What went wrong?' : 'What would you like to see?'}
        <span className={styles.required}> *</span>
      </label>
      <textarea
        className={styles.textarea}
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder={
          type === 'bug'
            ? 'Describe what happened and how to reproduce it…'
            : 'Describe the feature and why it would be useful…'
        }
        rows={5}
        maxLength={2000}
      />
      <div className={styles.charCount}>{description.length}/2000</div>

      <label className={styles.label}>
        Discord or Email <span className={styles.optional}>(optional)</span>
      </label>
      <input
        className={styles.input}
        type="text"
        placeholder="your#1234 or you@email.com"
        value={contact}
        onChange={e => setContact(e.target.value)}
        maxLength={120}
      />
      <p className={styles.contactHint}>So I can follow up with you if needed.</p>

      <div className={styles.actions}>
        <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
        <button
          className={styles.submitBtn}
          onClick={handleSubmit}
          disabled={submitting || !description.trim()}>
          {submitting ? 'Sending…' : 'Send Feedback'}
        </button>
      </div>
    </Modal>
  )
}
