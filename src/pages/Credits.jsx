import { Link } from 'react-router-dom'
import { SectionHeader } from '../components/UI'
import styles from './Legal.module.css'

const sources = [
  ['Scryfall', 'Card data and imagery used throughout the collection, builder, and scanner flows.'],
  ['Supabase', 'Authentication, sync backend, database storage, and feedback attachment storage.'],
  ['Frankfurter', 'Exchange-rate conversion for EUR and USD price displays.'],
  ['EDHREC', 'Feature-specific Commander recommendation integration where available.'],
  ['Moxfield', 'Deck import and related integration flows where available.'],
  ['MTGGoldfish', 'Linked or proxied feed and deck-related integrations where available.'],
  ['CodeTabs Proxy', 'Used for RSS proxying in supported feed workflows.'],
]

export default function CreditsPage() {
  return (
    <div className={styles.page}>
      <SectionHeader title="Credits and Fan Content Notice" />
      <Link to="/" className={styles.backLink}>← Back to UntapHub</Link>

      <div className={styles.hero}>
        <div className={styles.heroCard}>
          <div className={styles.eyebrow}>Credits and Attribution</div>
          <h1 className={styles.title}>Third-party sources and unofficial status</h1>
          <p className={styles.lead}>
            UntapHub depends on third-party services and public card data sources. It is also an
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
            UntapHub is an unofficial fan project for Magic: The Gathering collectors and players.
            It is not endorsed by, affiliated with, sponsored by, or specifically approved by Wizards
            of the Coast or Hasbro.
          </p>
          <p>
            Magic: The Gathering and related names, characters, card names, symbols, and other marks are
            the property of Wizards of the Coast. This project exists to help users organize their own
            collections and deck information.
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
