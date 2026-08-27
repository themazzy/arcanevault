# Record of Processing Activities

**GDPR Article 30 register — DeckLoom**

Internal document. Not published on the site; produced to a supervisory authority on request.

| | |
|---|---|
| **Controller** | Jan Mazánek, private individual (not a registered company) |
| **Established in** | Bulgaria |
| **Contact** | support@deckloom.app |
| **Lead supervisory authority** | Commission for Personal Data Protection (Комисия за защита на личните данни), Sofia |
| **Data protection officer** | None appointed — not required under Art 37 (no large-scale monitoring or special-category processing) |
| **Last reviewed** | 2026-08-28 |

> **Why this register exists.** The Art 30(5) exemption for organisations under 250 people does not
> apply: it is lifted where processing is *not occasional*, and processing user data is continuous
> and intrinsic to the service.

---

## 1. Processing activities

### 1.1 Account and authentication

- **Purpose:** create and secure user accounts, sign-in, password recovery, email changes.
- **Legal basis:** Art 6(1)(b) — performance of a contract.
- **Data subjects:** registered users.
- **Personal data:** email address, user id, hashed credentials (held by Supabase Auth), session
  state, sign-in provider, account creation timestamp, age self-declaration timestamp.
- **Retention:** for the life of the account; erased on account deletion.

### 1.2 Collection, decks and wishlists

- **Purpose:** the core service — cataloguing owned cards, binders, decks, wishlists, allocations.
- **Legal basis:** Art 6(1)(b).
- **Data subjects:** registered users.
- **Personal data:** card holdings and quantities, folder and deck structures, wishlists, notes.
  Not personal data in itself, but attributable to an identified user.
- **Retention:** until deleted by the user, or on account deletion.

### 1.3 Settings and preferences

- **Purpose:** persist interface preferences across devices.
- **Legal basis:** Art 6(1)(b).
- **Personal data:** theme, price source, display options, nickname, profile configuration.
- **Retention:** life of the account.

### 1.4 Public profiles, trade posts and shared decks

- **Purpose:** publish content the user has chosen to make public.
- **Legal basis:** Art 6(1)(a) — consent, given by the act of publishing; withdrawn by unpublishing.
- **Personal data:** nickname, bio, showcased decks, "For Trade" binder contents, featured
  wishlists, join date, deck count.
- **Recipients:** the public internet, including search engines and social link crawlers.
- **Retention:** until the user unpublishes or deletes the account. Third-party caches (social
  preview caches, search indexes) may persist beyond that and are outside the controller's control.

### 1.5 Multiplayer games and tournaments

- **Purpose:** run shared life-tracker games and tournaments.
- **Legal basis:** Art 6(1)(b).
- **Personal data:** display name, chosen colour, deck name, life totals, game and tournament
  results, placement.
- **Recipients:** other participants in the same game or tournament.
- **Retention:** session records pruned after 14 days by scheduled job; game results retained for
  the user's statistics until account deletion.

### 1.6 Feedback and bug reports

- **Purpose:** investigate defects and feature requests.
- **Legal basis:** Art 6(1)(a) — consent, given by submitting.
- **Personal data:** free-text report, optional contact field, optional screenshot, browser and
  device details, recent console errors.
- **Retention:** as long as needed to review, respond and keep a minimal support record.

### 1.7 Traffic measurement

- **Purpose:** understand aggregate site usage.
- **Legal basis:** Art 6(1)(f) — legitimate interests (understanding whether and how the service is
  used, in order to maintain it). Balancing: data is aggregate, cookieless, assigns no persistent
  identifier and is not used to profile or target anyone.
- **Personal data:** none retained by the controller. Cloudflare Web Analytics processes IP
  addresses transiently to derive country and returns aggregates only.
- **Retention:** aggregates held by Cloudflare per their retention policy; nothing stored by the
  controller.

### 1.8 Shared deck view counts

- **Purpose:** show deck owners how often a public deck link has been opened.
- **Legal basis:** Art 6(1)(f) — legitimate interests.
- **Personal data:** none. A running total per deck and a per-day total. No IP address, account,
  device identifier or per-view timestamp is stored, so a view cannot be attributed to a person —
  including by the controller.
- **Retention:** daily rows pruned after 180 days by scheduled job; running totals retained.

### 1.9 Account deletion requests

- **Purpose:** receive, process and evidence erasure requests.
- **Legal basis:** Art 6(1)(c) — legal obligation (Art 17), and Art 6(1)(f) for the audit trail.
- **Personal data:** account email, user id, request status, timestamps, handling notes.
- **Retention:** minimal record retained after erasure to evidence the request was received and
  handled.

### 1.10 Payments — **currently inactive**

- **Status:** switched off. `PAYMENTS_ENABLED` is `false`; no checkout can be started and no
  payment data is collected. Listed here so the register is complete if it is enabled.
- **Purpose (if enabled):** process one-time supporter contributions.
- **Legal basis (if enabled):** Art 6(1)(b), and Art 6(1)(c) for statutory retention of records.
- **Personal data (if enabled):** Stripe checkout session id, Stripe customer id, payment status.
  Card and billing details are handled by Stripe and never reach the controller's systems.

### 1.11 Card scanning

Listed for completeness because it involves a camera: **no personal data is processed by the
controller.** Camera frames are processed entirely on the user's device and matched against a
fingerprint file downloaded to that device. No image is transmitted to the controller or any third
party.

---

## 2. Categories of recipients

| Recipient | Role | Location |
|---|---|---|
| Supabase | Processor — database, auth, storage, edge functions | Data in `eu-north-1` (Stockholm, EEA). US-incorporated company. |
| Cloudflare | Processor — DNS, reverse proxy, Web Analytics, Workers | Global network |
| GitHub Pages | Processor — static site hosting | Global |
| Stripe | Processor — payments (**inactive**) | Global |
| Google, Discord | Independent controllers — OAuth identity providers, where the user chooses them | Global |
| Scryfall, Frankfurter, EDHREC, Commander Spellbook, Recommander | Third-party data sources | Global |

Requests to EDHREC are made directly from the user's browser, so EDHREC observes the user's IP
address. Commander Spellbook and Recommander are relayed server-side and do not.

---

## 3. Transfers outside the EEA

Account and collection data is stored in the EEA (Supabase `eu-north-1`, Stockholm). Supabase is
US-incorporated, so administrative access from outside the EEA is possible under its processor
terms.

Cloudflare routes all site traffic through its global network, so request metadata including IP
addresses is handled outside the EEA in transit. Stripe, Google, Discord and GitHub operate
outside the EEA.

**Safeguards relied on:** the EU Standard Contractual Clauses and EU–US Data Privacy Framework
certification where applicable, as set out in each provider's data processing agreement. Cloudflare's
DPA is incorporated into its Self-Serve Subscription Agreement; Supabase's and Stripe's are
incorporated into their standard terms.

---

## 4. Retention

| Data | Retention |
|---|---|
| Account, collection, decks, wishlists, settings | Life of the account; erased on deletion |
| Game sessions | Pruned after 14 days (scheduled job) |
| Game results | Life of the account |
| Deck view daily rows | Pruned after 180 days (scheduled job); running totals retained |
| Shared price snapshots | Today and yesterday only |
| Feedback and attachments | As long as needed to review, respond and keep a minimal record |
| Deletion requests | Minimal record retained to evidence handling |

---

## 5. General description of security measures

Described generally, as Art 30(1)(g) requires.

- **Access control:** Row Level Security on all user-owned tables, scoped to the authenticated
  user. Administrative functions are gated on membership of an `admin_users` table and run in
  server-side edge functions, never in the client.
- **Credential handling:** the service-role key and all third-party API credentials are held in
  server-side secret stores and are never present in the client bundle or the repository. API
  tokens are issued with least privilege — the analytics token carries read-only analytics scopes
  on a single account and zone.
- **Authentication:** Supabase Auth, with password strength checks on signup, OAuth via Google and
  Discord, and PKCE for the native application.
- **Transport:** TLS for all connections; the origin sits behind the Cloudflare proxy.
- **Data residency:** primary datastore in the EEA.
- **Backups and availability:** managed by Supabase under its standard service terms.
- **Personnel:** a single operator has administrative access. There are no employees or
  subcontractors with access to personal data.

---

## 6. Review

Review when a new processor is added, when a new category of personal data is processed, when
payments are enabled, or annually — whichever comes first.
