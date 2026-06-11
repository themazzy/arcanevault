import { Link } from 'react-router-dom'
import { SectionHeader } from '../components/UI'
import styles from './Legal.module.css'

export default function TermsPage() {
  return (
    <div className={styles.page}>
      <SectionHeader title="Terms of Service" />
      <Link to="/" className={styles.backLink}>← Back to DeckLoom</Link>

      <div className={styles.hero}>
        <div className={styles.heroCard}>
          <div className={styles.eyebrow}>Terms of Service</div>
          <h1 className={styles.title}>The agreement for using DeckLoom</h1>
          <p className={styles.lead}>
            These terms explain what DeckLoom provides, what you agree to when you use it, and how
            optional premium purchases work. They are written to be readable by users first, not only
            by lawyers. By creating an account or using the app, you agree to these terms.
          </p>
        </div>

        <div className={styles.navCard}>
          <div className={styles.navTitle}>Related Pages</div>
          <div className={styles.navList}>
            <Link to="/privacy" className={styles.navLink}>Privacy Policy</Link>
            <Link to="/credits" className={styles.navLink}>Credits and Fan Content Notice</Link>
            <Link to="/delete-account" className={styles.navLink}>Delete Account</Link>
            <Link to="/legal" className={styles.navLink}>Back to Legal Hub</Link>
          </div>
        </div>
      </div>

      <div className={styles.content}>
        <section className={styles.section}>
          <h2>What DeckLoom is</h2>
          <p>
            DeckLoom is a personal Magic: The Gathering collection tracker: you can catalog owned
            cards, organize binders, decks, and wishlists, build and share decks, scan cards with your
            camera, follow market prices, track games, and manage tournaments. The core app is free to
            use. Optional premium themes are available as a one-time purchase.
          </p>
          <p>
            DeckLoom is an unofficial fan project and is not affiliated with Wizards of the Coast.
            See the <Link to="/credits" className={styles.inlineLink}>Credits and Fan Content Notice</Link>{' '}
            for the full attribution and fan-content disclosure.
          </p>
          <p><em>Last updated: 2026-06-11.</em></p>
        </section>

        <section className={styles.section}>
          <h2>Your account</h2>
          <ul className={styles.list}>
            <li>You need an account to sync collections across devices. Keep your sign-in credentials safe — actions taken through your account are treated as yours.</li>
            <li>Provide a working email address so password recovery and important account messages reach you.</li>
            <li>You can stop using the service at any time and request deletion through the{' '}
              <Link to="/delete-account" className={styles.inlineLink}>Delete Account</Link> page.</li>
            <li>DeckLoom is not directed at children under 16 (see the{' '}
              <Link to="/privacy" className={styles.inlineLink}>Privacy Policy</Link> for details).</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Acceptable use</h2>
          <p>Keep it reasonable. In particular, you agree not to:</p>
          <ul className={styles.list}>
            <li>Attack, overload, probe, or attempt to gain unauthorized access to the service or other users&apos; data.</li>
            <li>Use automated bulk scraping of the service or abuse rate-limited third-party data sources through the app.</li>
            <li>Publish unlawful, infringing, hateful, or deceptive content through public profiles, shared decks, nicknames, or feedback.</li>
            <li>Impersonate other people or misrepresent an affiliation with DeckLoom or Wizards of the Coast.</li>
            <li>Resell, sublicense, or commercially exploit the service or its data feeds.</li>
          </ul>
          <p>
            Accounts that violate these rules, abuse the service, or create legal risk may be suspended
            or terminated. Where reasonable, you will be warned first.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Your content</h2>
          <ul className={styles.list}>
            <li>Your collection data, deck lists, and profile content remain yours.</li>
            <li>You grant DeckLoom the technical permission needed to store, sync, and display that content back to you — and to others only when you intentionally share it (public decks, share links, public profiles).</li>
            <li>Public sharing is opt-in. Anything you make public can be seen, linked, and previewed by anyone with the URL. You can unshare at any time, though caches held by third parties (social preview caches, search engines) may take time to clear.</li>
            <li>You are responsible for having the rights to anything you upload (for example feedback screenshots).</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Premium themes (one-time purchase)</h2>
          <ul className={styles.list}>
            <li>Premium themes are a cosmetic, one-time purchase that changes the app&apos;s appearance. They add no gameplay data, card data, or functional advantage, and contain no Wizards of the Coast material.</li>
            <li>Payment is processed by Stripe. The price shown at checkout is the final amount. DeckLoom never sees your card details.</li>
            <li>Premium themes are digital content delivered immediately after payment: the unlock is applied to your account as soon as the payment is confirmed.</li>
            <li><strong>EU/EEA &amp; UK consumers — right of withdrawal:</strong> by completing the purchase you expressly request immediate delivery of the digital content and acknowledge that you thereby lose your 14-day right of withdrawal once the unlock is delivered.</li>
            <li>That said: if the unlock fails to apply, or something is genuinely broken with what you paid for, contact us through the in-app feedback form and we will fix it or refund the purchase. Your statutory rights regarding defective digital content remain unaffected.</li>
            <li>The unlock is tied to your DeckLoom account and is non-transferable. If your account is deleted, the unlock is deleted with it.</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Card data, prices, and third-party services</h2>
          <ul className={styles.list}>
            <li>Card data, imagery, and prices come from third-party sources (see{' '}
              <Link to="/credits" className={styles.inlineLink}>Credits</Link>). They can be delayed, incomplete, or wrong.</li>
            <li>Price and collection-value displays are informational only. They are <strong>not</strong> financial advice, an offer to buy or sell, or a guarantee of market value.</li>
            <li>External links (marketplaces, deck sites, feeds) lead to third-party services with their own terms and privacy policies.</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>Service provided “as is”</h2>
          <p>
            DeckLoom is provided <strong>“as is” and “as available”</strong>, without warranties of any
            kind, to the extent permitted by law. There is no guarantee of uninterrupted availability,
            error-free operation, or preservation of data. The app keeps a local copy of your
            collection on your device and syncs to the cloud, but you should still{' '}
            <strong>export your collection regularly</strong> (Settings → Export) if it would hurt to
            lose it. The service may change, add, or remove features over time; if the service is ever
            discontinued, reasonable notice and an export window will be provided.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Limitation of liability</h2>
          <p>
            To the maximum extent permitted by applicable law, DeckLoom&apos;s total liability for any
            claims arising out of or relating to the service is limited to the amount you paid for the
            service in the twelve months before the event giving rise to the claim (which is zero for
            free use). Nothing in these terms excludes or limits liability that cannot legally be
            excluded — including liability for intent or gross negligence, or your mandatory statutory
            rights as a consumer.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Changes to these terms</h2>
          <p>
            These terms may be updated as the service evolves. The “last updated” date above always
            reflects the current version. For material changes — especially anything affecting paid
            features — an in-app notice will be shown before or when the change takes effect.
            Continuing to use the service after a change means you accept the updated terms.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Governing law and disputes</h2>
          <p>
            These terms are governed by the laws of <strong>Bulgaria</strong>, where DeckLoom&apos;s
            operator is established. If you use DeckLoom as a consumer in the EU/EEA or the UK, you
            always keep the mandatory consumer protections of the country you live in, and you can
            bring disputes before your local courts and your local data-protection or
            consumer-protection authority. EU consumers can also use the European Commission&apos;s
            Online Dispute Resolution platform.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Contact</h2>
          <p>
            Questions about these terms can be sent through the in-app feedback form. Account and
            data requests go through the <Link to="/delete-account" className={styles.inlineLink}>Delete Account</Link>{' '}
            page or the channels described in the{' '}
            <Link to="/privacy" className={styles.inlineLink}>Privacy Policy</Link>.
          </p>
        </section>
      </div>
    </div>
  )
}
