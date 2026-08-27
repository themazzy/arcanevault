import { Link } from 'react-router-dom'
import { SectionHeader } from '../components/UI'
import styles from './Legal.module.css'

export default function StorageNoticePage() {
  return (
    <div className={styles.page}>
      <SectionHeader title="Cookies and Local Storage" />
      <Link to="/" className={styles.backLink}>← Back to DeckLoom</Link>

      <div className={styles.hero}>
        <div className={styles.heroCard}>
          <div className={styles.eyebrow}>Cookies and Local Storage</div>
          <h1 className={styles.title}>What the browser stores for DeckLoom</h1>
          <p className={styles.lead}>
            DeckLoom currently relies on browser storage for session persistence, settings, and a local
            cache that keeps collection reads fast. The app uses no advertising cookies and no tracking
            cookies of any kind. It does use Cloudflare Web Analytics, which is cookieless and stores
            nothing on your device, and it uses local browser storage that you should know about.
          </p>
        </div>

        <div className={styles.navCard}>
          <div className={styles.navTitle}>Related Pages</div>
          <div className={styles.navList}>
            <Link to="/privacy" className={styles.navLink}>Privacy Policy</Link>
            <Link to="/delete-account" className={styles.navLink}>Delete Account</Link>
            <Link to="/legal" className={styles.navLink}>Back to Legal Hub</Link>
          </div>
        </div>
      </div>

      <div className={styles.content}>
        <section className={styles.section}>
          <h2>Current storage behavior</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Storage type</th>
                  <th>Used for</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Session persistence</td>
                  <td>Keeping you signed in between page loads</td>
                  <td>Handled through Supabase auth in the browser.</td>
                </tr>
                <tr>
                  <td>Local storage</td>
                  <td>Settings, display preferences, manual pricing overrides, some lightweight UI state</td>
                  <td>Used for immediate local reads before sync catches up.</td>
                </tr>
                <tr>
                  <td>IndexedDB</td>
                  <td>Primary local card, folder, cache, and sync data store</td>
                  <td>Core part of the app architecture so collection reads stay local and fast.</td>
                </tr>
                <tr>
                  <td>Temporary browser cache</td>
                  <td>Images, card assets, and network responses</td>
                  <td>Managed by normal browser caching behavior.</td>
                </tr>
                <tr>
                  <td>Traffic analytics</td>
                  <td>Aggregate visit counts, referring site, and country, so we can see how the site is used</td>
                  <td>Cloudflare Web Analytics. Cookieless: it sets no cookie, writes nothing to your device, and does not build a profile or follow you across sites.</td>
                </tr>
                <tr>
                  <td>Third-party sign-in cookies</td>
                  <td>If you sign in with Google or Discord, those providers may set their own cookies on their own domains during the OAuth handshake.</td>
                  <td>These cookies are controlled by Google or Discord and follow their own privacy and cookie policies, not DeckLoom&apos;s.</td>
                </tr>
                <tr>
                  <td>Payment provider cookies</td>
                  <td>If you start a premium checkout, Stripe may set its own cookies on its checkout pages to process the payment and prevent fraud.</td>
                  <td>These cookies are controlled by Stripe and follow Stripe&apos;s own privacy and cookie policies.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.section}>
          <h2>Cookie position</h2>
          <p>
            DeckLoom does not present a cookie banner because it uses no ad-tech and no analytics cookies.
            The traffic analytics we do use are cookieless and store nothing on your device, so there is
            nothing for you to consent to or opt out of at the storage level. Session persistence and
            similar browser storage still matter, which is why this notice exists.
          </p>
          <p>
            If the app later adds marketing pixels, cookie-based analytics, or other non-essential tracking
            storage, this page should be updated and a consent flow added before shipping those changes.
          </p>
        </section>

        <section className={styles.section}>
          <h2>What would trigger a popup later</h2>
          <ul className={styles.list}>
            <li>Analytics tools that are not strictly necessary to provide the service a user requested.</li>
            <li>Marketing or advertising tags, pixels, or third-party audience tracking.</li>
            <li>Non-essential preference storage used for optimization, experimentation, or profiling rather than core app operation.</li>
          </ul>
          <p>
            A consent utility scaffold is now present in <span className={styles.code}>src/lib/consent.js</span> so
            non-essential storage categories can be gated before those tools are introduced.
          </p>
        </section>

        <section className={styles.section}>
          <h2>How to clear local data</h2>
          <ul className={styles.list}>
            <li>Inside Settings, you can clear local metadata cache directly from the app.</li>
            <li>You can sign out to end your session.</li>
            <li>You can also clear site data using your browser&apos;s storage controls.</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Where to read more</h2>
          <p>
            For the broader data-handling explanation, read the{' '}
            <Link to="/privacy" className={styles.inlineLink}>Privacy Policy</Link>. Questions about
            browser storage or analytics can go to{' '}
            <a href="mailto:support@deckloom.app" className={styles.inlineLink}>support@deckloom.app</a>.
          </p>
        </section>
      </div>
    </div>
  )
}
