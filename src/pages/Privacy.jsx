import { Link } from 'react-router-dom'
import { SectionHeader } from '../components/UI'
import styles from './Legal.module.css'

export default function PrivacyPage() {
  return (
    <div className={styles.page}>
      <SectionHeader title="Privacy Policy" />
      <Link to="/" className={styles.backLink}>← Back to DeckLoom</Link>

      <div className={styles.hero}>
        <div className={styles.heroCard}>
          <div className={styles.eyebrow}>Privacy Policy</div>
          <h1 className={styles.title}>How DeckLoom handles your data</h1>
          <p className={styles.lead}>
            DeckLoom stores the information needed to sync your collection, preserve your settings,
            and support optional features like feedback reports and public sharing links. The app is
            built to keep most reads local and use Supabase as the sync backend.
          </p>
        </div>

        <div className={styles.navCard}>
          <div className={styles.navTitle}>Related Pages</div>
          <div className={styles.navList}>
            <Link to="/storage" className={styles.navLink}>Cookies and Local Storage</Link>
            <Link to="/credits" className={styles.navLink}>Credits and Fan Content Notice</Link>
            <Link to="/delete-account" className={styles.navLink}>Delete Account</Link>
            <Link to="/legal" className={styles.navLink}>Back to Legal Hub</Link>
          </div>
        </div>
      </div>

      <div className={styles.content}>
        <section className={styles.section}>
          <h2>Controller and privacy contact</h2>
          <p>
            DeckLoom is the app named in this policy and is the service these disclosures apply to.
            At the current stage of the project, privacy and account-data requests can be submitted through
            the in-app feedback form or through the public <Link to="/delete-account" className={styles.inlineLink}>Delete Account</Link>{' '}
            page.
          </p>
          <p>
            Until a dedicated privacy mailbox is published, those request paths are the official contact
            mechanisms for deletion, data-handling questions, and follow-up on personal-data requests.
          </p>
          <p><em>Last updated: 2026-06-11.</em></p>
        </section>

        <section className={styles.section}>
          <h2>Data we process</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Examples</th>
                  <th>Why it is used</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Account data</td>
                  <td>Email address, user id, auth session state</td>
                  <td>To sign you in, sync your account, send password or email-change flows, and secure access.</td>
                </tr>
                <tr>
                  <td>Collection data</td>
                  <td>Owned cards, folders, deck contents, allocations, wishlists, game results</td>
                  <td>To provide the core collection-tracking and deck-building features of the app.</td>
                </tr>
                <tr>
                  <td>Settings</td>
                  <td>Theme, price source, font size, grouping, nickname, motion preferences</td>
                  <td>To personalize the interface and keep your settings consistent across devices.</td>
                </tr>
                <tr>
                  <td>Feedback and diagnostics</td>
                  <td>Feedback text, optional contact field, optional screenshot, browser and device details</td>
                  <td>To investigate bug reports, understand feature requests, and reproduce issues.</td>
                </tr>
                <tr>
                  <td>Public sharing data</td>
                  <td>Shared folder or deck views reached through a share token or public deck link</td>
                  <td>To let you intentionally share selected content with others.</td>
                </tr>
                <tr>
                  <td>Payment data (premium only)</td>
                  <td>Stripe checkout session id, Stripe customer id, payment status</td>
                  <td>To process one-time premium theme purchases. Card numbers and billing details are handled by Stripe and never reach DeckLoom servers.</td>
                </tr>
                <tr>
                  <td>OAuth sign-in data</td>
                  <td>Email address and basic profile data shared by Google or Discord when you choose to sign in with them</td>
                  <td>To create or sign in to your DeckLoom account through a third-party identity provider.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.section}>
          <h2>How the app stores data</h2>
          <p>
            DeckLoom is designed IDB-first. In practice, that means IndexedDB on your device is the
            main local store for collection reads, while Supabase is used as the account system and sync
            backend. Settings are also written to local storage immediately and then synced to Supabase.
          </p>
          <p>
            For more detail on browser storage and session persistence, see the{' '}
            <Link to="/storage" className={styles.inlineLink}>Cookies and Local Storage</Link> page.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Why we process this data</h2>
          <ul className={styles.list}>
            <li>To provide the core collection, deck, wishlist, scanner, sync, and analytics features.</li>
            <li>To maintain account security and keep sessions working across refreshes and devices.</li>
            <li>To let you send feedback and optionally receive follow-up contact.</li>
            <li>To intentionally publish content when you create a public share link or deck view.</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Legal basis in plain language</h2>
          <ul className={styles.list}>
            <li>Core account, collection, sync, and deck features are processed because they are necessary to provide the service you asked to use.</li>
            <li>Security, abuse prevention, and basic operational logging are processed to keep the service working safely and reliably.</li>
            <li>Optional feedback submissions are processed because you choose to send them to the app operator.</li>
            <li>Public share links are processed because you intentionally choose to publish that content.</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Third-party processors and sources</h2>
          <ul className={styles.list}>
            <li>Supabase is used for authentication, sync storage, database storage, and file uploads tied to feedback attachments.</li>
            <li>Google and Discord act as identity providers when you choose to sign in with their accounts. Each receives the standard OAuth handshake data and applies its own privacy policy.</li>
            <li>Stripe is used as the payment processor for one-time premium theme purchases. Stripe collects and handles payment card details directly under its own privacy policy; DeckLoom only stores a checkout reference, customer id, and payment status.</li>
            <li>Scryfall is used for card metadata and imagery.</li>
            <li>Frankfurter is used for exchange-rate conversion in supported price displays.</li>
            <li>GitHub Pages hosts the static front-end build at the public site URL.</li>
            <li>Cloudflare provides DNS and acts as a network proxy in front of deckloom.app, which means site traffic (including IP addresses and request metadata) passes through Cloudflare&apos;s infrastructure. A Cloudflare worker also serves social link previews for publicly shared decks.</li>
            <li>Other external MTG services may be linked or queried for feature-specific integrations.</li>
          </ul>
          <p>
            The current source list and attribution notices are maintained on the{' '}
            <Link to="/credits" className={styles.inlineLink}>Credits and Fan Content Notice</Link> page.
          </p>
        </section>

        <section className={styles.section}>
          <h2>International data transfers</h2>
          <p>
            Some processors named above operate from servers outside the European Economic Area —
            in particular Supabase, Stripe, Google, Discord, GitHub, and Cloudflare. Where personal data is
            transferred outside the EEA or the UK, DeckLoom relies on the standard safeguards each
            processor provides (such as the EU Standard Contractual Clauses, EU-US Data Privacy
            Framework certifications where applicable, and the privacy commitments published on each
            provider&apos;s website).
          </p>
        </section>

        <section className={styles.section}>
          <h2>Automated decision-making and profiling</h2>
          <p>
            DeckLoom does not use automated decision-making that produces legal or similarly
            significant effects, and it does not perform behavioural profiling of users for
            advertising or scoring purposes. Search results, recommendations, and analytics
            inside the app are informational helpers, not automated decisions about you.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Children and minors</h2>
          <p>
            DeckLoom is not directed at children under 16. If you are under the age of digital
            consent that applies where you live, please do not create an account or send personal
            data through the feedback form without a parent or guardian. If a parent or guardian
            believes a minor has submitted personal data, use the{' '}
            <Link to="/delete-account" className={styles.inlineLink}>Delete Account</Link> page or
            the in-app feedback form so the account and related data can be removed.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Your rights under the GDPR and similar laws</h2>
          <p>
            Where applicable law (in particular the EU General Data Protection Regulation and the
            UK GDPR) grants you data-subject rights, you can exercise them through the in-app
            feedback form or the{' '}
            <Link to="/delete-account" className={styles.inlineLink}>Delete Account</Link> page.
            These rights include:
          </p>
          <ul className={styles.list}>
            <li>Right of access — request a copy of the personal data DeckLoom holds about you.</li>
            <li>Right to rectification — ask for inaccurate or incomplete personal data to be corrected.</li>
            <li>Right to erasure — ask for personal data to be deleted (subject to limited legal exceptions).</li>
            <li>Right to restriction — ask for processing of your personal data to be limited while a request is reviewed.</li>
            <li>Right to data portability — request a machine-readable export of the personal data you provided.</li>
            <li>Right to object — object to processing that relies on legitimate interests.</li>
            <li>Right to withdraw consent — where processing is based on your consent, you can withdraw it at any time without affecting prior lawful processing.</li>
            <li>Right to lodge a complaint — you can complain to your local data-protection supervisory authority if you believe your rights have been violated.</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Retention and deletion</h2>
          <p>
            Your synced collection and account-related records are kept until you remove them, close your
            account, or request deletion. Feedback submissions and deletion requests may be retained long
            enough to process the request, investigate abuse, or keep a minimal audit trail of the request.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Data type</th>
                  <th>Default retention approach</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Account and synced collection data</td>
                  <td>Retained while the account remains active, unless the user deletes individual content sooner or submits a deletion request.</td>
                </tr>
                <tr>
                  <td>Settings and local browser cache</td>
                  <td>Retained on the device until changed, cleared in-app, removed by browser storage controls, or replaced by newer values.</td>
                </tr>
                <tr>
                  <td>Feedback reports and attachments</td>
                  <td>Retained long enough to review, investigate, respond, and keep a minimal support record where needed.</td>
                </tr>
                <tr>
                  <td>Deletion requests</td>
                  <td>Retained long enough to process the request and preserve a minimal record that a request was received and handled.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            To request account or personal-data deletion, use the{' '}
            <Link to="/delete-account" className={styles.inlineLink}>Delete Account</Link> page.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Your controls</h2>
          <ul className={styles.list}>
            <li>You can change your email and request a password reset from Settings.</li>
            <li>You can clear local metadata cache inside the app.</li>
            <li>You can avoid public visibility by not creating share links or public deck links.</li>
            <li>You can request account deletion through the deletion-request flow.</li>
            <li>You can submit privacy questions through the in-app feedback form if you need clarification before requesting deletion.</li>
          </ul>
        </section>
      </div>
    </div>
  )
}
