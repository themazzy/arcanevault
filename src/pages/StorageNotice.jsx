import { Link } from 'react-router-dom'
import { SectionHeader } from '../components/UI'
import styles from './Legal.module.css'

export default function StorageNoticePage() {
  return (
    <div className={styles.page}>
      <SectionHeader title="Cookies and Local Storage" />
      <Link to="/" className={styles.backLink}>← Back to ArcaneVault</Link>

      <div className={styles.hero}>
        <div className={styles.heroCard}>
          <div className={styles.eyebrow}>Cookies and Local Storage</div>
          <h1 className={styles.title}>What the browser stores for ArcaneVault</h1>
          <p className={styles.lead}>
            ArcaneVault currently relies on browser storage for session persistence, settings, cache, and
            offline-first behavior. At the time of writing, the app does not use advertising cookies or
            analytics trackers, but it does use local browser storage that you should know about.
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
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.section}>
          <h2>Cookie position</h2>
          <p>
            ArcaneVault does not currently present a cookie banner because the app is not using an ad-tech
            or analytics-cookie stack at this time. That said, session persistence and similar browser
            storage still matter, which is why this notice exists.
          </p>
          <p>
            If the app later adds analytics, marketing pixels, or non-essential tracking storage, this page
            should be updated and the consent flow should be revisited before shipping those changes.
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
            <Link to="/privacy" className={styles.inlineLink}>Privacy Policy</Link>.
          </p>
        </section>
      </div>
    </div>
  )
}
