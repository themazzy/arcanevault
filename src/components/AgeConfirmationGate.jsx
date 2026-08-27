import { useState } from 'react'
import { Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { AGE_CONFIRMED_FIELD, MINIMUM_AGE, ageConfirmationValue } from '../lib/ageGate'
import styles from './AgeConfirmationGate.module.css'

/**
 * Shown once, after authentication, to any account with no recorded age
 * declaration — which is every account created through Google or Discord, plus
 * everyone who signed up before the signup checkbox existed.
 *
 * Rendered *instead of* the app rather than over it. An overlay leaves the app
 * mounted underneath and reachable by keyboard, back button, or a deep link,
 * which would make the gate decorative.
 */
export default function AgeConfirmationGate({ user }) {
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    if (!confirmed) {
      setError(`Tick the box to confirm you are ${MINIMUM_AGE} or older.`)
      return
    }
    setBusy(true)
    setError('')
    const { error: updateError } = await sb.auth.updateUser({
      data: { [AGE_CONFIRMED_FIELD]: ageConfirmationValue() },
    })
    if (updateError) {
      // Staying on the gate is the correct failure mode: letting someone
      // through on a failed write would lose the declaration silently.
      setError(updateError.message || 'Could not save your confirmation. Please try again.')
      setBusy(false)
      return
    }
    // The local session carries stale metadata until it is refreshed, so the
    // gate would immediately re-render without this.
    await sb.auth.refreshSession()
  }

  return (
    <main className={styles.page}>
      <form className={styles.card} onSubmit={submit}>
        <div className={styles.eyebrow}>One quick confirmation</div>
        <h1 className={styles.title}>Before you continue</h1>
        <p className={styles.lead}>
          DeckLoom is not intended for people under {MINIMUM_AGE}. We ask everyone once, and you
          will not see this again.
        </p>

        <label className={styles.confirmRow}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={e => { setConfirmed(e.target.checked); setError('') }}
            disabled={busy}
          />
          <span>
            I am {MINIMUM_AGE} or older, I agree to the <Link to="/terms">Terms</Link>, and I
            acknowledge the <Link to="/privacy">Privacy Policy</Link>.
          </span>
        </label>

        {error && <div className={styles.error} role="alert">{error}</div>}

        <button className={styles.primary} type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Continue to DeckLoom'}
        </button>

        <p className={styles.footNote}>
          If that is not true of you, please{' '}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => sb.auth.signOut()}
          >sign out</button>. You can also{' '}
          <Link to="/delete-account">delete this account</Link>
          {user?.email ? <> ({user.email})</> : null}.
        </p>
      </form>
    </main>
  )
}
