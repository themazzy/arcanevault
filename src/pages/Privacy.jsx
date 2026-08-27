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
            DeckLoom is an independently operated project, run by a private individual rather than a
            registered company. The operator is established in <strong>Bulgaria</strong> and is the data
            controller for the personal data described in this policy.
          </p>
          <p>
            <strong>Contact for all privacy and data-protection matters:</strong>{' '}
            <a href="mailto:support@deckloom.app" className={styles.inlineLink}>support@deckloom.app</a>
          </p>
          <p>
            Write to that address to exercise any of the rights listed further down — access, correction,
            deletion, export, restriction or objection — or to ask a question about this policy. It is
            monitored by the operator and reaches a person. You do not need an account to use it, and you
            can still use it after your account has been deleted.
          </p>
          <p>
            Two alternatives exist for convenience, not as replacements: the{' '}
            <Link to="/delete-account" className={styles.inlineLink}>Delete Account</Link> page submits a
            deletion request directly, and the in-app feedback form reaches the same operator.
          </p>
          <p><em>Last updated: 2026-08-27.</em></p>
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
                  <td>Public profile and trade post</td>
                  <td>Nickname, profile bio and layout, showcased decks, the contents of your &quot;For Trade&quot; binder and any wishlists you feature</td>
                  <td>To render your public profile and trade post pages, which are readable by anyone with the link and are only created when you opt in.</td>
                </tr>
                <tr>
                  <td>Multiplayer and tournament data</td>
                  <td>Display name, chosen colour, deck name, life totals, game and tournament results</td>
                  <td>To run shared life-tracker games and tournaments. Your display name and deck name are visible to the other participants in that game.</td>
                </tr>
                <tr>
                  <td>Traffic measurement</td>
                  <td>Aggregate page views, referring site and country. No cookie, no device storage, no identifier that singles you out</td>
                  <td>To understand how the site is used in aggregate. See &quot;Traffic measurement&quot; below.</td>
                </tr>
                <tr>
                  <td>Shared deck view counts</td>
                  <td>A running total per public deck, plus a per-day total. No record of who viewed it</td>
                  <td>To show deck owners how often their shared deck link has been opened.</td>
                </tr>
                <tr>
                  <td>Payment data (premium only)</td>
                  <td>Stripe checkout session id, Stripe customer id, payment status</td>
                  <td><strong>Not currently collected — supporter contributions are switched off, and no payment can be started.</strong> If they are enabled later, this is the payment data DeckLoom would hold. Card numbers and billing details are handled by Stripe and never reach DeckLoom servers.</td>
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
            <li>To intentionally publish content when you create a public share link, public profile, trade post, or deck view.</li>
            <li>To measure overall site traffic in aggregate, so the app can be maintained and improved.</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Legal basis in plain language</h2>
          <ul className={styles.list}>
            <li><strong>Performance of a contract</strong> (Article 6(1)(b)) — your account, collection, sync, decks, wishlists and premium purchase. Without this data the service you asked for cannot be provided.</li>
            <li><strong>Legitimate interests</strong> (Article 6(1)(f)) — security, abuse prevention, operational logging, aggregate traffic measurement, and shared-deck view counts. Our interest is keeping the service safe and understanding whether it is used at all; the data involved is aggregate or minimal, it is not used to profile you, and you can object at any time.</li>
            <li><strong>Consent</strong> (Article 6(1)(a)) — optional feedback you choose to send, and content you choose to publish through a share link, public profile or trade post. You can withdraw by deleting the content or asking us to remove it.</li>
            <li><strong>Legal obligation</strong> (Article 6(1)(c)) — retaining payment records where tax or accounting law requires it.</li>
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
            <li>Cloudflare provides DNS and acts as a network proxy in front of deckloom.app, which means site traffic (including IP addresses and request metadata) passes through Cloudflare&apos;s infrastructure. A Cloudflare worker also serves social link previews for publicly shared decks. We use Cloudflare Web Analytics to measure site traffic: it is cookieless, sets nothing on your device, and reports only aggregate figures such as page views, referring site, and country. It does not build a profile of you or track you across other sites.</li>
            <li>
              Deck-building features query third-party MTG data services to generate suggestions:
              EDHREC receives the commander&apos;s name (queried directly from your browser, so EDHREC
              sees standard request metadata such as your IP address), while Commander Spellbook
              (combo detection) and Recommander.cards (deck-aware recommendations) receive the list
              of card names in the deck being built — including decks you keep private. Only card
              names are sent, never your account identity, and the Spellbook and Recommander
              requests are relayed server-side so those services do not see your IP address.
            </li>
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
            <strong>Your account and collection data is stored in the European Union.</strong> The
            Supabase database, authentication records and file storage for DeckLoom run in Supabase&apos;s
            <code className={styles.code}>eu-north-1</code> region (Stockholm, Sweden). Supabase is a
            US-incorporated company, so administrative access from outside the EEA is possible under its
            processor terms, but the data itself resides in the EEA.
          </p>
          <p>
            Other processors do operate outside the EEA — in particular Stripe, Google, Discord, GitHub
            and Cloudflare. Cloudflare additionally routes all site traffic through its global network, so
            request metadata including your IP address may be handled outside the EEA in transit. Where
            personal data is transferred outside the EEA or the UK, DeckLoom relies on the safeguards each
            provider maintains — the EU Standard Contractual Clauses, EU-US Data Privacy Framework
            certification where applicable, and the commitments published in each provider&apos;s own data
            processing agreement.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Traffic measurement</h2>
          <p>
            DeckLoom uses Cloudflare Web Analytics to measure site traffic. It is cookieless: it sets no
            cookie, writes nothing to your device, and does not assign you an identifier that persists
            between visits or follows you to other websites. It reports aggregate figures only — page
            views, referring site, country, and page-load performance. There is no advertising network
            involved and no data is sold or shared for marketing.
          </p>
          <p>
            Separately, DeckLoom counts how many times each <em>publicly shared</em> deck page is opened.
            This is a plain per-deck running total plus a per-day total. No IP address, account,
            device identifier or timestamp of an individual visit is stored, so a view cannot be traced
            back to a person — including by us. Private decks are never counted.
          </p>
          <p>
            Both rely on legitimate interests. If you object to either, contact us using the channels in
            this policy.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Card scanning</h2>
          <p>
            The card scanner runs entirely on your device. Camera frames are processed locally in your
            browser and matched against a card-fingerprint file downloaded to your device. No photograph,
            camera frame, or image of your surroundings is ever uploaded to DeckLoom or to any third
            party. Only the identified card name is used, and only when you choose to add the card.
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
            UK GDPR) grants you data-subject rights, you can exercise them by emailing{' '}
            <a href="mailto:support@deckloom.app" className={styles.inlineLink}>support@deckloom.app</a>,
            or for deletion specifically through the{' '}
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
            <li>
              Right to lodge a complaint — you can complain to the data-protection supervisory authority
              in the EU or EEA country where you live, where you work, or where the alleged infringement
              took place. Because the operator is established in Bulgaria, the lead authority for DeckLoom
              is the Bulgarian <strong>Commission for Personal Data Protection</strong> (Комисия за защита
              на личните данни), Sofia. You are not required to use it — your own national authority is
              always an option, and the European Data Protection Board publishes the full list.
            </li>
          </ul>
          <p>
            We aim to respond to a data-subject request within one month of receiving it, as required by
            Article 12(3) GDPR. If a request is complex we may extend that period and will tell you why.
            Exercising these rights is free unless a request is manifestly unfounded or excessive.
          </p>
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
            <li>You can email <a href="mailto:support@deckloom.app" className={styles.inlineLink}>support@deckloom.app</a> with privacy questions if you need clarification before requesting deletion.</li>
          </ul>
        </section>
      </div>
    </div>
  )
}
