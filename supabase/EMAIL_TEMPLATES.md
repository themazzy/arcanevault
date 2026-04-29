# Supabase Auth Email Templates

These files are the repo source of truth for DeckLoom's Supabase auth emails.

Templates:

- `supabase/templates/confirmation.html`
- `supabase/templates/recovery.html`
- `supabase/templates/magic-link.html`
- `supabase/templates/invite.html`
- `supabase/templates/email-change.html`
- `supabase/templates/reauthentication.html`

## Hosted Supabase

In the Supabase Dashboard:

1. Open `Authentication`
2. Open `Email Templates`
3. Paste the matching file contents into the matching template

Suggested subjects:

- `Confirm your DeckLoom account`
- `Reset your DeckLoom password`
- `Your DeckLoom magic link`
- `You have been invited to DeckLoom`
- `Confirm your new DeckLoom email`
- `Confirm your DeckLoom reauthentication`

## Self-hosted / local Supabase

Use these files from `supabase/config.toml`:

```toml
[auth.email.template.confirmation]
subject = "Confirm your DeckLoom account"
content_path = "./supabase/templates/confirmation.html"

[auth.email.template.recovery]
subject = "Reset your DeckLoom password"
content_path = "./supabase/templates/recovery.html"

[auth.email.template.magic_link]
subject = "Your DeckLoom magic link"
content_path = "./supabase/templates/magic-link.html"

[auth.email.template.invite]
subject = "You have been invited to DeckLoom"
content_path = "./supabase/templates/invite.html"

[auth.email.template.email_change]
subject = "Confirm your new DeckLoom email"
content_path = "./supabase/templates/email-change.html"

[auth.email.template.reauthentication]
subject = "Confirm your DeckLoom reauthentication"
content_path = "./supabase/templates/reauthentication.html"
```

## Variables used

These templates currently use:

- `{{ .ConfirmationURL }}`
- `{{ .Token }}`

DeckLoom currently sends signup confirmation links back to:

- `https://themazzy.github.io/arcanevault/`

That redirect is set in [src/components/Auth.jsx](C:/Users/Jan/Desktop/arcanevault/arcanevault/src/components/Auth.jsx).
