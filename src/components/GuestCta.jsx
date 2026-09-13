import { Link } from 'react-router-dom'
import { ScannerIcon, ChevronRightIcon } from '../icons'
import styles from './GuestCta.module.css'

/**
 * Sign-up pitch for the bottom of a public page.
 *
 * Every public route (/sets, /sets/:code, /profile/:username, /trade/:username,
 * /d/:id) is a landing surface for someone who has never seen DeckLoom, and
 * most of them said nothing about the product at all. The pitch leads on
 * uncapped scanning rather than on the feature the page happens to show: it is
 * the one claim the competing trackers meter, so it is the reason to switch.
 *
 * Renders nothing when a user is signed in — callers pass `show`, since they
 * already hold the auth state and the banner should never push page content
 * down for someone who is logged in.
 */
export default function GuestCta({ show = true }) {
  if (!show) return null

  return (
    <aside className={styles.cta}>
      <span className={styles.icon} aria-hidden="true"><ScannerIcon size={20} /></span>
      <div className={styles.copy}>
        <strong className={styles.title}>Track your own collection, free</strong>
        <p className={styles.body}>
          Scan as many cards as you like — matching runs on your device, so there is no scan cap
          and no subscription. Then build Commander decks and follow what your collection is worth.
        </p>
      </div>
      <Link to="/login" className={styles.action}>
        Create a free account <ChevronRightIcon size={14} />
      </Link>
    </aside>
  )
}
