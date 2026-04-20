import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SectionHeader } from '../components/UI'
import { useAuth } from '../components/Auth'
import { sb } from '../lib/supabase'
import styles from './Legal.module.css'

export default function DeleteAccountPage() {
  const { user } = useAuth()
  const [email, setEmail] = useState(user?.email || '')
  const [reason, setReason] = useState('')
  const [confirmChecked, setConfirmChecked] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const handleSubmit = async () => {
    setError('')
    setSuccess('')

    const normalizedEmail = (user?.email || email).trim().toLowerCase()
    if (!normalizedEmail) {
      setError('Enter the account email for the deletion request.')
      return
    }
    if (!confirmChecked) {
      setError('Confirm that you want to request deletion before submitting.')
      return
    }

    setSubmitting(true)
    const { error: insertError } = await sb.from('account_deletion_requests').insert({
      user_id: user?.id || null,
      user_email: normalizedEmail,
      request_reason: reason.trim() || null,
      source: user ? 'in_app_authenticated' : 'public_request_form',
      request_meta: {
        url: window.location.href,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        user_agent: navigator.userAgent,
      },
    })

    if (insertError) {
      setError('Could not submit the deletion request right now. Please try again.')
      setSubmitting(false)
      return
    }

    setSuccess('Deletion request submitted. Keep access to your email in case follow-up is needed to complete the request.')
    setReason('')
    setConfirmChecked(false)
    if (!user) setEmail('')
    setSubmitting(false)
  }

  return (
    <div className={styles.page}>
      <SectionHeader title="Delete Account" />
      <Link to="/" className={styles.backLink}>← Back to UntapHub</Link>

      <div className={styles.hero}>
        <div className={styles.heroCard}>
          <div className={styles.eyebrow}>Account Deletion</div>
          <h1 className={styles.title}>Request account and data deletion</h1>
          <p className={styles.lead}>
            Use this form to submit a tracked deletion request. If you are signed in, the request is tied
            to your current account id. If you are not signed in, you can still submit the email address
            of the account you want reviewed for deletion.
          </p>
        </div>

        <div className={styles.navCard}>
          <div className={styles.navTitle}>Related Pages</div>
          <div className={styles.navList}>
            <Link to="/privacy" className={styles.navLink}>Privacy Policy</Link>
            <Link to="/legal" className={styles.navLink}>Back to Legal Hub</Link>
          </div>
        </div>
      </div>

      <div className={styles.content}>
        <section className={styles.statusCard}>
          <h2 className={styles.statusTitle}>Current status</h2>
          <p>
            {user
              ? `Signed in as ${user.email}. This request will be linked to your current UntapHub account.`
              : 'You are not signed in. Submit the email address tied to the UntapHub account you want deleted.'}
          </p>
        </section>

        <section className={styles.requestCard}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="delete-email">Account email</label>
            <input
              id="delete-email"
              className={styles.input}
              type="email"
              value={user?.email || email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={!!user}
              placeholder="you@example.com"
            />
            <div className={styles.hint}>
              This should match the account email that owns the synced UntapHub data.
            </div>
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="delete-reason">Reason (optional)</label>
            <textarea
              id="delete-reason"
              className={styles.textarea}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="You can add context here if there is something specific to remove or investigate."
            />
          </div>

          <label className={styles.checkboxRow}>
            <input
              className={styles.checkbox}
              type="checkbox"
              checked={confirmChecked}
              onChange={(event) => setConfirmChecked(event.target.checked)}
            />
            <span>
              I understand this is a deletion request and may remove synced account data after review.
            </span>
          </label>

          <div className={styles.actionRow}>
            <button
              type="button"
              className={styles.submitBtn}
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? 'Submitting...' : 'Submit Deletion Request'}
            </button>
            {error ? <span className={styles.errorText}>{error}</span> : null}
            {success ? <span className={styles.successText}>{success}</span> : null}
          </div>
        </section>
      </div>
    </div>
  )
}
