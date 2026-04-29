import { SectionHeader } from '../components/UI'
import { InfoIcon, WarningIcon, StarIcon } from '../icons'
import styles from './Help.module.css'

const TOC = [
  { id: 'faq', label: 'Common Questions' },
  { id: 'overview', label: 'What DeckLoom Is For' },
  { id: 'home', label: 'Home Screen' },
  { id: 'collection-model', label: 'Collection, Binders, Decks, and Wishlists' },
  { id: 'scanner', label: 'Scanner' },
  { id: 'collection-browser', label: 'Collection Browser' },
  { id: 'binders', label: 'Binders' },
  { id: 'decks', label: 'Decks' },
  { id: 'deckbuilder', label: 'Deckbuilder' },
  { id: 'wishlists', label: 'Wishlists' },
  { id: 'search-filters', label: 'Search, Filters, Sorting, and Views' },
  { id: 'imports', label: 'Imports and Linked Deck Sources' },
  { id: 'stats-prices', label: 'Stats and Prices' },
  { id: 'life-tracker', label: 'Life Tracker' },
  { id: 'settings-sync', label: 'Settings and Sync' },
]

const FAQS = [
  {
    q: 'Is everything in the app part of my collection?',
    a: 'No. Your owned collection is represented by the cards you keep in Binders and owned Decks. Wishlists are separate, and Deckbuilder is a planning workspace.',
  },
  {
    q: 'Should I build in Deckbuilder or create a Deck first?',
    a: 'Build in Deckbuilder first if the list is still changing or if you do not own every card yet. Move into a real Deck once the list reflects cards you actually have.',
  },
  {
    q: 'Why are Wishlists separate?',
    a: 'Because wanted cards are not owned cards. Keeping them separate protects your collection totals, values, and deck ownership from getting mixed up.',
  },
  {
    q: 'Why do my cards show up on one device before another?',
    a: 'DeckLoom may open from saved local data first and then refresh in the background. If you want an immediate recheck, use manual sync in Settings.',
  },
  {
    q: 'Why is the scanner missing a card?',
    a: 'Strong glare, sleeves, dark lighting, and quick movement can all make scanning harder. Try softer light, hold the card still, and manually choose the printing if needed.',
  },
  {
    q: 'Why do prices differ from another website?',
    a: 'Different sites can use different markets, timing, and currencies. Check the price source selected in Settings before comparing values.',
  },
  {
    q: 'What if a deck import link fails?',
    a: 'Some links are private, expired, or blocked by the source site. If that happens, paste the deck list directly and continue from there.',
  },
]

function Callout({ kind = 'note', title, children }) {
  const Icon = kind === 'warning' ? WarningIcon : kind === 'tip' ? StarIcon : InfoIcon
  return (
    <aside className={`${styles.callout} ${styles[kind]}`}>
      <div className={styles.calloutHead}>
        <Icon size={16} />
        <strong>{title}</strong>
      </div>
      <div className={styles.calloutBody}>{children}</div>
    </aside>
  )
}

function ScreenshotPlaceholder({ label }) {
  return (
    <>
      {/* SCREENSHOT: {label} */}
      <div className={styles.screenshotPlaceholder}>
        <span>Screenshot Placeholder</span>
        <small>{label}</small>
      </div>
    </>
  )
}

function TocCard() {
  return (
    <aside className={styles.tocCard}>
      <div className={styles.tocTitle}>On This Page</div>
      <nav className={styles.tocNav}>
        {TOC.map(item => (
          <a key={item.id} href={`#${item.id}`} className={styles.tocLink}>
            {item.label}
          </a>
        ))}
      </nav>
    </aside>
  )
}

export default function HelpPage() {
  return (
    <div className={styles.page}>
      <SectionHeader title="Help" />

      <div className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>DeckLoom Guide</span>
          <h1 className={styles.title}>A full guide to using DeckLoom</h1>
          <p className={styles.lead}>
            This page explains how the app is organized, how to add and manage cards, how
            deck planning differs from owned decks, how wishlists stay separate from your
            collection, and how to use the app&apos;s major tools from scanner to multiplayer
            life tracking.
          </p>
          <section id="faq" className={styles.heroFaq}>
            <div className={styles.heroFaqHead}>
              <h2 className={styles.heroFaqTitle}>Common Questions</h2>
              <a href="#overview" className={styles.heroFaqLink}>Skip to full guide</a>
            </div>
            <div className={styles.faqList}>
              {FAQS.map(item => (
                <details key={item.q} className={styles.faqItem}>
                  <summary className={styles.faqSummary}>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </section>
        </div>
        <TocCard />
      </div>

      <div className={styles.content}>
        <section id="overview" className={styles.section}>
          <h2>What DeckLoom Is For</h2>
          <p>
            DeckLoom is a Magic: The Gathering collection app built around four main jobs:
            keeping track of the cards you own, organizing those cards into useful groups,
            planning decks, and helping you during games.
          </p>
          <p>
            If you only remember one thing, remember this: <strong>owned cards live in your
            Binders and Decks</strong>. Your <strong>Wishlists</strong> are separate because
            they represent cards you want, not cards you already own. Your
            <strong> Deckbuilder</strong> is a planning workspace where you can build first and
            then later match that plan to the cards in your collection.
          </p>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Main Job</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Home</td>
                  <td>Quick access to your app activity, value highlights, recent cards, and MTG updates.</td>
                </tr>
                <tr>
                  <td>Collection</td>
                  <td>Browse the cards you own through their Binder and Deck placements.</td>
                </tr>
                <tr>
                  <td>Binders</td>
                  <td>Organize owned cards by album, box, trade binder, set project, or any structure you prefer.</td>
                </tr>
                <tr>
                  <td>Decks</td>
                  <td>Track decks that are made from cards you actually own and assign.</td>
                </tr>
                <tr>
                  <td>Deckbuilder</td>
                  <td>Plan decks before every card is owned, imported, or assigned.</td>
                </tr>
                <tr>
                  <td>Wishlists</td>
                  <td>Keep wanted cards and upgrade targets separate from owned inventory.</td>
                </tr>
                <tr>
                  <td>Scanner</td>
                  <td>Add cards quickly from your camera feed.</td>
                </tr>
                <tr>
                  <td>Stats</td>
                  <td>Review collection value, top cards, deck value, and broader collection trends.</td>
                </tr>
                <tr>
                  <td>Life Tracker</td>
                  <td>Run multiplayer games with life totals, commander damage, counters, and shared join codes.</td>
                </tr>
              </tbody>
            </table>
          </div>

          <Callout kind="note" title="The most important ownership rule">
            DeckLoom treats your owned collection and your wanted cards as different things.
            If a card is on a Wishlist, that does not mean you own it. If a card is in Deckbuilder,
            that does not automatically mean it belongs to a real owned deck yet.
          </Callout>

          <Callout kind="tip" title="A clean way to use the app">
            Use Binders to mirror your real storage, use Deckbuilder to plan lists, turn finished
            builds into real Decks, and use Wishlists for every card you still need to buy, trade,
            or open.
          </Callout>
        </section>

        <section id="home" className={styles.section}>
          <h2>Home Screen</h2>
          <p>
            The Home screen is your dashboard. It is designed to bring together the parts of
            the app that most people check often: quick card lookup, snapshots of collection
            value, recently viewed cards, recently added cards, high-value cards and decks,
            and MTG news or upcoming set information.
          </p>
          <p>
            You can treat Home as a launch point rather than a storage area. Use it to jump
            into the part of the app you need next, whether that is scanning new cards, opening
            a binder, checking a deck&apos;s value, or looking at current activity.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>Useful on Home</h3>
              <ul className={styles.list}>
                <li>Quick card lookup</li>
                <li>Collection and deck value highlights</li>
                <li>Recently viewed cards</li>
                <li>Recently added cards</li>
                <li>Random card lookup and discovery</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>Good habits</h3>
              <ul className={styles.list}>
                <li>Use it to spot high-value changes</li>
                <li>Use it after scanning sessions to review what changed</li>
                <li>Use it before games to jump into a deck or Life Tracker quickly</li>
                <li>Use it to keep up with MTG updates without leaving the app</li>
              </ul>
            </article>
          </div>

          <ScreenshotPlaceholder label="Home screen with collection snapshot, recent cards, and deck highlights." />
        </section>

        <section id="collection-model" className={styles.section}>
          <h2>Collection, Binders, Decks, and Wishlists</h2>
          <p>
            This is the part of DeckLoom that matters most for keeping your data accurate.
            Your collection is not just every card name you have touched anywhere in the app.
            It represents the cards you own and have placed into your actual collection spaces.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>Collection</h3>
              <p>
                The Collection browser shows the cards you own as they exist in your Binders
                and owned Decks. This is the place to review ownership, quantities, locations,
                and overall value.
              </p>
            </article>
            <article className={styles.infoCard}>
              <h3>Binders</h3>
              <p>
                Binders are for owned cards. They are ideal for set projects, trade stock,
                color sections, commander staples, premium pages, or physical binder mirrors.
              </p>
            </article>
            <article className={styles.infoCard}>
              <h3>Decks</h3>
              <p>
                Decks represent real owned decks. They are for cards you actually have and
                want to treat as a playable deck inside your collection.
              </p>
            </article>
            <article className={styles.infoCard}>
              <h3>Wishlists</h3>
              <p>
                Wishlists are not owned inventory. They are for cards you want to remember,
                buy, upgrade into, or trade for later.
              </p>
            </article>
          </div>

          <Callout kind="note" title="How Deckbuilder fits into this">
            Deckbuilder is not the same as an owned Deck. Deckbuilder is where you design the
            list first. A normal Deck is where that plan becomes an owned deck built from cards
            you actually have.
          </Callout>

          <Callout kind="warning" title="Avoid mixing jobs">
            If you use Wishlists for owned cards or use Deckbuilder as if it were a real owned
            deck, your totals and your understanding of the app will get messy fast. Keep each
            area focused on its own job.
          </Callout>
        </section>

        <section id="scanner" className={styles.section}>
          <h2>Scanner</h2>
          <p>
            Scanner is the fastest way to add physical cards. It is designed for real-world
            use, which means you can scan, review, correct, and save without leaving the flow.
            It is especially useful when processing new purchases, opening product, or cataloging
            a pile of cards into a binder or deck.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>Best practices</h3>
              <ul className={styles.list}>
                <li>Scan one card at a time.</li>
                <li>Keep the card flat and inside the target area.</li>
                <li>Use soft, even light instead of bright direct glare.</li>
                <li>Remove or reduce sleeve glare when possible.</li>
                <li>Hold the card steady for a moment before moving away.</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>What you can review before saving</h3>
              <ul className={styles.list}>
                <li>Exact printing or set</li>
                <li>Quantity</li>
                <li>Foil status</li>
                <li>Condition</li>
                <li>Language</li>
                <li>Destination folder or deck</li>
              </ul>
            </article>
          </div>

          <p>
            If the first suggested match is not right, do not force it. Open the card or printing
            picker and choose the correct version manually. This is especially important for cards
            with many printings, similar art, or heavy foil glare.
          </p>

          <Callout kind="tip" title="Fast scanner workflow">
            Pick the destination you are filling before you start. For example, if you are loading
            a trade binder, send every good scan directly into that Binder as you go.
          </Callout>

          <Callout kind="warning" title="Scanner does not decide ownership for you">
            A successful scan still needs a destination. Save the card into a Binder, Deck, or
            Wishlist so it ends up in the right part of the app.
          </Callout>

          <ScreenshotPlaceholder label="Scanner view with card target, result feedback, and save controls." />
        </section>

        <section id="collection-browser" className={styles.section}>
          <h2>Collection Browser</h2>
          <p>
            Collection is where you browse your owned cards across the whole app. It is the
            best place to search across your entire inventory, review quantities, check value,
            and make broad cleanup moves after imports or scanning sessions.
          </p>
          <p>
            The Collection page is also where bulk work becomes practical. If you need to move
            many cards between storage areas, clean up duplicates, or remove selected copies,
            this is usually the right place to do it.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>What you can do here</h3>
              <ul className={styles.list}>
                <li>Search across owned inventory</li>
                <li>Sort by name, price, quantity, and other common views</li>
                <li>Filter by card details and collection details</li>
                <li>Select multiple cards at once</li>
                <li>Move, delete, or reorganize cards in bulk</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>Quantity behavior</h3>
              <p>
                When you have multiple copies of a card, DeckLoom lets you work with some
                copies without always selecting every copy. That makes partial moves and cleanup
                much easier.
              </p>
            </article>
          </div>

          <Callout kind="note" title="What you see here">
            Collection is for owned cards only. Wishlists stay out of collection totals so wanted
            cards do not inflate your inventory or value.
          </Callout>

          <ScreenshotPlaceholder label="Collection browser with search, filters, view controls, and bulk actions." />
        </section>

        <section id="binders" className={styles.section}>
          <h2>Binders</h2>
          <p>
            Binders are one of the strongest organizing tools in DeckLoom. They let you
            structure owned cards in a way that matches how you think about your collection
            in real life.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>Good Binder ideas</h3>
              <ul className={styles.list}>
                <li>Main collection</li>
                <li>Trade binder</li>
                <li>Commander staples</li>
                <li>Set completion project</li>
                <li>Foils or premium pages</li>
                <li>Color or faction sections</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>Why Binders matter</h3>
              <p>
                They keep your collection understandable. If your physical storage already has
                a structure, matching that structure in DeckLoom makes the app more useful
                every single day.
              </p>
            </article>
          </div>

          <p>
            Inside a Binder, you can browse cards in different views, sort them in different
            ways, and use selection tools for cleanup and moves. Binders are especially useful
            for separating cards you are actively trading from cards you are keeping.
          </p>

          <Callout kind="tip" title="Start simple">
            If you are unsure how to organize Binders, begin with just a few: one for your main
            collection, one for trades, and one for special projects. You can split things further later.
          </Callout>

          <ScreenshotPlaceholder label="Binder browser with card grid, grouping, and bulk actions." />
        </section>

        <section id="decks" className={styles.section}>
          <h2>Decks</h2>
          <p>
            Decks are for decks you actually own. Once a planned list becomes real and you want
            DeckLoom to treat it as an owned deck in your collection, this is where it belongs.
          </p>
          <p>
            A Deck is useful for more than just storing cards together. It also lets you review
            deck-specific value, browse the list cleanly, and use that deck in areas like Life Tracker.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>When to use a Deck</h3>
              <ul className={styles.list}>
                <li>You physically own the cards for the deck.</li>
                <li>You want the deck counted as part of your owned collection.</li>
                <li>You want to review the deck as a real playable list.</li>
                <li>You want to use the deck during multiplayer life tracking.</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>When not to use a Deck</h3>
              <ul className={styles.list}>
                <li>If you are still only brainstorming a list</li>
                <li>If you still need many of the cards</li>
                <li>If it is mainly a shopping plan or upgrade target</li>
              </ul>
            </article>
          </div>

          <Callout kind="note" title="Decks are different from Deckbuilder">
            A Deck is an owned deck. Deckbuilder is the workshop where the idea comes together
            before you fill that idea with real cards from your collection.
          </Callout>

          <ScreenshotPlaceholder label="Owned deck view with deck cards, value, and deck actions." />
        </section>

        <section id="deckbuilder" className={styles.section}>
          <h2>Deckbuilder</h2>
          <p>
            Deckbuilder is where you experiment. It is designed for building a list first,
            testing changes, importing ideas, and exploring recommendations before you worry
            about whether every card is already in your collection.
          </p>
          <p>
            This makes Deckbuilder the right place for brewing, tuning, planning upgrades,
            copying imported lists, and comparing versions of a deck concept.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>Deckbuilder is good for</h3>
              <ul className={styles.list}>
                <li>Brewing from scratch</li>
                <li>Importing deck lists from outside sources</li>
                <li>Trying commander upgrades</li>
                <li>Comparing price impact before buying cards</li>
                <li>Using recommendation tools and external inspiration</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>Typical workflow</h3>
              <ol className={styles.numberedList}>
                <li>Build or import the list in Deckbuilder.</li>
                <li>Refine the list until you like it.</li>
                <li>Use a Wishlist for missing cards.</li>
                <li>Turn the finished concept into a real Deck when it matches your owned cards.</li>
              </ol>
            </article>
          </div>

          <Callout kind="tip" title="Think of Deckbuilder as a laboratory">
            Build there first. It is much easier to change your mind in the planning stage than
            after you have treated the deck like a finished owned list.
          </Callout>

          <ScreenshotPlaceholder label="Deckbuilder screen with planned list, grouping controls, and external links." />
        </section>

        <section id="wishlists" className={styles.section}>
          <h2>Wishlists</h2>
          <p>
            Wishlists are where you store wanted cards, future upgrades, and reminder lists.
            They are intentionally separate from owned inventory so you can plan without confusing
            your collection totals.
          </p>
          <p>
            This makes Wishlists useful for buy lists, upgrade paths, missing pieces for a planned
            deck, and long-term cards you want to remember.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>Good Wishlist uses</h3>
              <ul className={styles.list}>
                <li>Commander upgrades</li>
                <li>Missing staples for a future deck</li>
                <li>Trade targets</li>
                <li>Cards to watch before buying</li>
                <li>Set chase cards</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>Why keep them separate</h3>
              <p>
                When wanted cards and owned cards live together, collection value and totals stop
                meaning what you think they mean. Wishlists solve that cleanly.
              </p>
            </article>
          </div>

          <Callout kind="note" title="Wishlists are not collection storage">
            A card on a Wishlist is not part of your owned collection and should not be used as a
            replacement for a Binder or owned Deck.
          </Callout>

          <ScreenshotPlaceholder label="Wishlist view showing wanted cards, selection controls, and list organization." />
        </section>

        <section id="search-filters" className={styles.section}>
          <h2>Search, Filters, Sorting, and Views</h2>
          <p>
            DeckLoom includes strong browsing tools because large collections become hard to
            use without them. Search, filters, sorting, grouping, and view modes work together
            to help you get to the cards you want quickly.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>Search and filters help with</h3>
              <ul className={styles.list}>
                <li>Finding cards by name or text</li>
                <li>Narrowing cards by color, set, rarity, type, and more</li>
                <li>Finding foil or non-foil copies</li>
                <li>Looking for cards in a price range</li>
                <li>Reviewing only cards in a specific location or category</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>Sorting and view controls help with</h3>
              <ul className={styles.list}>
                <li>Browsing by name or value</li>
                <li>Checking newest or oldest additions</li>
                <li>Switching between denser and more visual layouts</li>
                <li>Grouping cards in ways that make cleanup easier</li>
              </ul>
            </article>
          </div>

          <Callout kind="tip" title="Use filters instead of scrolling">
            If a page feels crowded, narrow it down first. A few good filters are usually faster
            than trying to visually scan hundreds or thousands of cards.
          </Callout>
        </section>

        <section id="imports" className={styles.section}>
          <h2>Imports and Linked Deck Sources</h2>
          <p>
            DeckLoom can help you bring lists in from outside sources so you do not have to
            rebuild every deck by hand. This is especially useful when you already keep lists on
            external deck sites or when someone shares a list with you.
          </p>
          <p>
            Imports are usually most useful in Deckbuilder first, because that lets you review
            and refine the list before deciding which parts belong in a real owned deck and which
            parts still belong on a Wishlist.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>Good uses for imports</h3>
              <ul className={styles.list}>
                <li>Starting a brew from an existing deck list</li>
                <li>Testing upgrades from another player&apos;s list</li>
                <li>Turning a saved online list into a local project</li>
                <li>Comparing a planned list against what you own</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>If an import link fails</h3>
              <p>
                Shared links can fail if they are private, expired, changed, or limited by the
                source site. In that case, paste the deck list directly instead.
              </p>
            </article>
          </div>

          <ScreenshotPlaceholder label="Import flow for deck lists from pasted text or linked deck sources." />
        </section>

        <section id="stats-prices" className={styles.section}>
          <h2>Stats and Prices</h2>
          <p>
            DeckLoom is not only for storage. It also helps you understand your collection.
            Stats pages and value-aware views make it easier to review high-value cards, top decks,
            price changes, and how your collection is distributed.
          </p>
          <p>
            Because different marketplaces can show different numbers, the app lets you choose a
            price source in Settings. Once chosen, that source should be used consistently across
            value displays throughout the app.
          </p>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Price Source</th>
                  <th>Typical Use</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Cardmarket - Trend</td>
                  <td>Useful if you usually think about prices from a European market point of view.</td>
                </tr>
                <tr>
                  <td>TCGPlayer - Market</td>
                  <td>Useful if you usually compare prices in the United States or Canada.</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>Stats are good for</h3>
              <ul className={styles.list}>
                <li>Checking top-value cards</li>
                <li>Reviewing deck value</li>
                <li>Spotting which parts of your collection matter most</li>
                <li>Seeing overall collection trends</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>Why values can differ elsewhere</h3>
              <p>
                Different sites use different marketplaces, different update timing, and sometimes
                different currency assumptions. Matching your chosen source is the best way to stay consistent.
              </p>
            </article>
          </div>

          <ScreenshotPlaceholder label="Stats or value page showing top cards, deck values, and collection insights." />
        </section>

        <section id="life-tracker" className={styles.section}>
          <h2>Life Tracker</h2>
          <p>
            Life Tracker is made for actual play. It supports multiplayer sessions, keeps important
            counters available, and works well for Commander and other formats where more than plain
            life totals matter.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>Core game tools</h3>
              <ul className={styles.list}>
                <li>Life totals</li>
                <li>Commander damage</li>
                <li>Poison counters</li>
                <li>Energy, experience, and radiation counters</li>
                <li>Dice roller and coin flip</li>
                <li>Game log</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>Shared session flow</h3>
              <ol className={styles.numberedList}>
                <li>One player creates the session.</li>
                <li>The app gives a join code.</li>
                <li>Other players join the session.</li>
                <li>Seats and names are set up.</li>
                <li>The host starts the game.</li>
              </ol>
            </article>
          </div>

          <p>
            If you use Decks in DeckLoom, Life Tracker becomes even more useful because you can
            connect games to the decks you actually play. This is one of the best reasons to keep
            owned decks properly organized in the app.
          </p>

          <Callout kind="tip" title="Best results for game history">
            End games through the normal finish flow instead of simply abandoning the session or
            resetting the screen in the middle of a match.
          </Callout>

          <ScreenshotPlaceholder label="Life Tracker lobby and in-game layout with players, counters, and controls." />
        </section>

        <section id="settings-sync" className={styles.section}>
          <h2>Settings and Sync</h2>
          <p>
            Settings let you tailor DeckLoom to how you play and browse. You can change
            appearance options, value behavior, display density, motion and accessibility
            preferences, nickname and profile details, and sync behavior.
          </p>
          <p>
            DeckLoom is also designed to feel quick when it opens. Because of that, it may
            show what it already has ready first and then quietly refresh in the background.
            That is normal. It is meant to help the app feel responsive instead of forcing you
            to wait every time you open a page.
          </p>

          <div className={styles.cardGrid}>
            <article className={styles.infoCard}>
              <h3>Important Settings areas</h3>
              <ul className={styles.list}>
                <li>Theme and display styling</li>
                <li>Accessibility options like font size and reduced motion</li>
                <li>Price source</li>
                <li>Grid density and browsing preferences</li>
                <li>Nickname and profile details</li>
                <li>Manual sync controls</li>
              </ul>
            </article>
            <article className={styles.infoCard}>
              <h3>When to use manual sync</h3>
              <ul className={styles.list}>
                <li>After updating something on another device</li>
                <li>When you want a fresh check right away</li>
                <li>If something looks delayed after opening the app</li>
              </ul>
            </article>
          </div>

          <Callout kind="note" title="Why something can look delayed">
            The app may briefly show saved local data before it finishes catching up. That does not
            usually mean anything is wrong. It means DeckLoom is opening quickly and then refreshing.
          </Callout>

          <Callout kind="tip" title="Choose a price source early">
            Pick your preferred price source before you spend too much time comparing values. That keeps
            your collection, deck, and stats pages aligned from the start.
          </Callout>
        </section>
      </div>
    </div>
  )
}
