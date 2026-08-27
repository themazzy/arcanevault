# Personal Data Breach Response Plan

**GDPR Articles 33–34 — DeckLoom**

Internal runbook. Last reviewed 2026-08-28.

> **The clock is the hard part, not the paperwork.** You have **72 hours** from *becoming aware* of
> a breach to notify the supervisory authority. Awareness means having a reasonable degree of
> certainty that a security incident occurred and compromised personal data — not having finished
> investigating. This document exists so that the first two of those three days are not spent
> deciding what to do.

---

## 1. What counts as a personal data breach

Any breach of security leading to accidental or unlawful **destruction, loss, alteration,
unauthorised disclosure of, or access to** personal data. All three limbs count — it does not have
to be a leak:

- **Confidentiality** — someone saw data they shouldn't.
- **Integrity** — data was altered without authorisation.
- **Availability** — data was destroyed or lost, including permanently losing access to it.

### Realistic scenarios for this service

| Scenario | Type | Likely severity |
|---|---|---|
| Service-role key or an API token leaks (committed, pasted, logged) | Confidentiality | High — the service-role key bypasses RLS entirely |
| An RLS policy mistake exposes one user's rows to another | Confidentiality | High if it reaches production |
| A new table or RPC ships without RLS or with over-broad grants | Confidentiality | High |
| An RPC intended to be public-gated returns private deck or profile data | Confidentiality | Medium–high |
| Supabase or Cloudflare report an incident affecting the project | Depends | Depends — treat their notice as the awareness trigger |
| Admin account compromised | Confidentiality / Integrity | High |
| Destructive migration or accidental mass delete without recoverable backup | Availability | High |
| Feedback screenshot bucket made publicly listable | Confidentiality | Medium — screenshots may contain anything |

**Not a breach:** a user intentionally publishing their own profile, trade post or deck. That is
the feature working.

---

## 2. Who decides

Jan Mazánek, sole operator. There is no second person to escalate to, which makes writing the
decision down in advance more important, not less.

---

## 3. The procedure

### Step 0 — Note the time (immediately)

Write down the moment you became aware, in UTC. Every deadline runs from it. Do this before
investigating; reconstructing it afterwards is unreliable and the 72 hours do not pause.

### Step 1 — Contain (first, before analysis)

Stop the bleeding before understanding it fully.

- Rotate any exposed credential — Supabase service-role key, Cloudflare API token, Stripe key.
  Rotate first, work out the blast radius after.
- If an RLS policy or RPC is at fault, revoke the grant or disable the function rather than
  attempting a careful fix under time pressure.
- If an admin account is compromised, deactivate it in `admin_users` and force a session
  invalidation.

### Step 2 — Assess

Establish and write down:

- What happened, and when it started and stopped.
- Which categories of personal data were involved.
- How many people are affected, at least approximately.
- Whether the data was accessed by anyone, or merely exposed.
- Likely consequences for those people.

### Step 3 — Decide whether to notify the authority

**Notify unless the breach is unlikely to result in a risk to people's rights and freedoms.**

The default is to notify. "Unlikely to result in a risk" is a genuine exemption but a narrow one —
it fits a brief exposure of data that identifies nobody, or the loss of data that was strongly
encrypted with the key uncompromised. If you are weighing it up for more than a few minutes, notify.

**Where:** Commission for Personal Data Protection (Комисия за защита на личните данни), Sofia —
the lead authority, since the controller is established in Bulgaria. Check the CPDP site for the
current notification form and channel.

**Deadline:** 72 hours from awareness. If you cannot assemble everything in time, **notify anyway**
and say the information will follow — Art 33(4) explicitly allows notifying in phases. A late
complete notification is worse than a prompt incomplete one.

**What the notification must contain** (Art 33(3)):

1. The nature of the breach, including categories and approximate number of data subjects and
   records affected.
2. Name and contact details of the contact point — `support@deckloom.app`.
3. Likely consequences.
4. Measures taken or proposed, including any mitigation.

### Step 4 — Decide whether to tell affected users

Required when the breach is **likely to result in a *high* risk** to people (Art 34), without undue
delay.

For this service, that threshold is most plausibly met by exposure of email addresses combined with
any other account data, or by anything touching feedback screenshots — whose contents are unknown
and could include anything the user had on screen.

**Not required** if the data was unintelligible to the recipient (e.g. strongly encrypted), if you
have since ensured the high risk will not materialise, or if individual contact would take
disproportionate effort — in which case a public notice on the site serves instead.

Notification to users must be in **plain language** and cover items 2–4 above. A template is in §5.

### Step 5 — Record it, whether or not you notified

Art 33(5) requires documenting **every** breach — including ones you decided not to report, and
the reasoning for that decision. This is what a supervisory authority asks for first. Keep the
record in a durable place outside the affected system; add an entry to §6.

### Step 6 — Fix and follow up

Address the root cause, add a regression test where one is possible, and note anything that made
detection or containment slower than it should have been.

---

## 4. Contacts and references

| | |
|---|---|
| Controller / decision-maker | Jan Mazánek |
| Public contact point | support@deckloom.app |
| Supervisory authority | Commission for Personal Data Protection, Sofia (CPDP / КЗЛД) |
| Supabase | Support console; check status page and their DPA breach terms |
| Cloudflare | Support; check status page |
| Stripe | Support (only relevant once payments are enabled) |

---

## 5. User notification template

> **Subject: Security incident affecting your DeckLoom account**
>
> Hello,
>
> On [DATE] we discovered [PLAIN DESCRIPTION OF WHAT HAPPENED]. Your DeckLoom account was among
> those affected.
>
> **What was involved:** [CATEGORIES OF DATA]
> **What was not involved:** [E.G. PASSWORDS ARE NOT STORED IN READABLE FORM AND WERE NOT EXPOSED]
>
> **What we have done:** [CONTAINMENT AND FIX]
>
> **What you should do:** [CONCRETE STEPS, OR "no action is needed"]
>
> We reported this to the Bulgarian Commission for Personal Data Protection on [DATE].
>
> If you have questions, reply to this message or write to support@deckloom.app.
>
> — Jan Mazánek, DeckLoom

---

## 6. Breach register

Every incident assessed under this plan gets a row, including those judged not notifiable.

| Date noticed (UTC) | Summary | Data involved | People affected | Authority notified? | Users notified? | Reasoning | Resolved |
|---|---|---|---|---|---|---|---|
| — | No incidents recorded | — | — | — | — | — | — |
