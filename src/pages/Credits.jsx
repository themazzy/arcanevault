import { Link } from 'react-router-dom'
import { SectionHeader } from '../components/UI'
import styles from './Legal.module.css'

const sources = [
  ['Scryfall', 'Card data and imagery used throughout the collection, builder, and scanner flows.'],
  ['Supabase', 'Authentication, sync backend, database storage, and feedback attachment storage.'],
  ['Stripe', 'Payment processor for one-time premium theme purchases. Card details are handled directly by Stripe.'],
  ['Google (OAuth)', 'Optional identity provider when signing in with a Google account.'],
  ['Discord (OAuth)', 'Optional identity provider when signing in with a Discord account.'],
  ['GitHub Pages', 'Static hosting for the public DeckLoom web build.'],
  ['Cloudflare', 'DNS and network proxy in front of deckloom.app, including the worker that serves social link previews for shared decks.'],
  ['Frankfurter', 'Exchange-rate conversion for EUR and USD price displays.'],
  ['EDHREC', 'Feature-specific Commander recommendation integration where available.'],
  ['Moxfield', 'Deck import and related integration flows where available.'],
  ['MTGGoldfish', 'Linked or proxied feed and deck-related integrations where available.'],
]

export default function CreditsPage() {
  return (
    <div className={styles.page}>
      <SectionHeader title="Credits and Fan Content Notice" />
      <Link to="/" className={styles.backLink}>← Back to DeckLoom</Link>

      <div className={styles.hero}>
        <div className={styles.heroCard}>
          <div className={styles.eyebrow}>Credits and Attribution</div>
          <h1 className={styles.title}>Third-party sources and unofficial status</h1>
          <p className={styles.lead}>
            DeckLoom depends on third-party services and public card data sources. It is also an
            unofficial fan-made application and is not presented as an official Wizards product.
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
        <section className={styles.section}>
          <h2>Fan content notice</h2>
          <p>
            <strong>
              DeckLoom is unofficial Fan Content permitted under the Fan Content Policy. Not
              approved/endorsed by Wizards. Portions of the materials used are property of Wizards of
              the Coast. ©Wizards of the Coast LLC.
            </strong>
          </p>
          <p>
            DeckLoom is an unofficial fan project for Magic: The Gathering collectors and players.
            It is not endorsed by, affiliated with, sponsored by, or specifically approved by Wizards
            of the Coast or Hasbro. Magic: The Gathering and related names, characters, card names,
            symbols, and other marks are the property of Wizards of the Coast. This project exists to
            help users organize their own collections and deck information.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Service and data credits</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Used for</th>
                </tr>
              </thead>
              <tbody>
                {sources.map(([name, purpose]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.section}>
          <h2>Public links and marketplace notes</h2>
          <ul className={styles.list}>
            <li>Public deck and share links intentionally expose the content you choose to share.</li>
            <li>External marketplace or content links may send you to third-party sites with their own terms and privacy policies.</li>
            <li>Price data is informational and can be delayed, incomplete, or unavailable for some prints.</li>
          </ul>
        </section>
      </div>
    </div>
  )
}
