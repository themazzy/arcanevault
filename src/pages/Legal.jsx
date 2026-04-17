import { Link } from 'react-router-dom'
import { SectionHeader } from '../components/UI'
import styles from './Legal.module.css'

const legalLinks = [
  {
    to: '/privacy',
    title: 'Privacy Policy',
    body: 'What ArcaneVault stores, why it stores it, who processes it, and how to request deletion or export.',
  },
  {
    to: '/storage',
    title: 'Cookies and Local Storage',
    body: 'A plain-language explanation of browser storage, offline cache, and the fact that the app currently does not use ad-tracking cookies.',
  },
  {
    to: '/credits',
    title: 'Credits and Fan Content Notice',
    body: 'Third-party services, source attributions, and the unofficial fan-content disclaimer for Wizards properties.',
  },
  {
    to: '/delete-account',
    title: 'Delete Account',
    body: 'Submit an account or data deletion request whether you are signed in right now or not.',
  },
]

export default function LegalPage() {
  return (
    <div className={styles.page}>
      <SectionHeader title="Legal" />
      <Link to="/" className={styles.backLink}>← Back to ArcaneVault</Link>

      <div className={styles.hero}>
        <div className={styles.heroCard}>
          <div className={styles.eyebrow}>Legal and Privacy</div>
          <h1 className={styles.title}>Transparency for how ArcaneVault works</h1>
          <p className={styles.lead}>
            ArcaneVault is a personal collection tracker. These pages explain the app&apos;s privacy
            model, local storage behavior, third-party sources, and how to request account deletion.
            They are written to be readable by users first, not only by lawyers.
          </p>
        </div>

        <div className={styles.navCard}>
          <div className={styles.navTitle}>Jump To</div>
          <div className={styles.navList}>
            {legalLinks.map((item) => (
              <Link key={item.to} to={item.to} className={styles.navLink}>
                {item.title}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.content}>
        <section className={styles.section}>
          <h2>Included pages</h2>
          <div className={styles.cardGrid}>
            {legalLinks.map((item) => (
              <Link key={item.to} to={item.to} className={styles.cardLink}>
                <div className={styles.infoCard}>
                  <h3 className={styles.cardTitle}>{item.title}</h3>
                  <p>{item.body}</p>
                  <span className={styles.cardMeta}>Open page</span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <h2>What this covers today</h2>
          <ul className={styles.list}>
            <li>How account, settings, collection, feedback, and diagnostic data are handled.</li>
            <li>What browser storage is used for auth persistence, offline cache, and app preferences.</li>
            <li>Which external services power card data, sync, exchange rates, and related features.</li>
            <li>How to submit a deletion request in a way that is actually trackable.</li>
          </ul>
        </section>
      </div>
    </div>
  )
}
