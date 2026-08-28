import { Link } from 'react-router-dom'
import styles from './PublicPageFooter.module.css'

/**
 * Legal links for the public routes — shared decks, profiles, trade posts,
 * game and tournament lobbies.
 *
 * These pages render outside `Layout`, so they have no nav, and their visitors
 * are typically not signed in and have no Settings page to look in. They are
 * also the visitors with the least context: their IP is handled by Cloudflare,
 * their visit is counted, and until this existed they had no route to the
 * privacy policy except guessing the URL.
 *
 * Deliberately quiet. It sits at the end of the page content rather than fixed
 * to the viewport, so it never competes with the deck or profile someone came
 * to look at.
 */
export default function PublicPageFooter() {
  return (
    <footer className={styles.footer}>
      <nav className={styles.links} aria-label="Legal">
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
        <Link to="/storage">Cookies &amp; Storage</Link>
        <Link to="/legal">Legal</Link>
      </nav>
      <div className={styles.brand}>
        <Link to="/">DeckLoom</Link> — an unofficial Magic: The Gathering collection tracker,
        not affiliated with Wizards of the Coast.
      </div>
    </footer>
  )
}
