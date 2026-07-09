# deckloom-og — Open Graph previews for shared deck links

Cloudflare Worker that serves rich link previews (deck name, format, commander,
card count, art image) to social crawlers hitting `https://deckloom.app/d/<id>`,
while real browsers pass straight through to the GitHub Pages SPA. The share
link stays the branded `deckloom.app` URL — no `*.supabase.co` anywhere.

Also hosts the **RSS proxy** at `deckloom.app/api/rss?feed=<url>` for the Home
page news section — allow-listed feeds only (`RSS_ALLOWED_FEEDS` in
`worker.js`), edge-cached 15 minutes, CORS `*` so dev/Capacitor work too.

Also hosts the **raw decklist endpoint** at
`deckloom.app/api/decklist/<deck-id>.txt` (`.txt` optional) — plain-text MTG
decklist lines (`1 Sol Ring`, with `// Sideboard` / `// Commander` sections,
maybeboard omitted) for third-party integrations like Tabletop Simulator deck
importers that can't run the SPA's JS. Backed by the public-gated
`get_deck_cards_for_view` RPC: private/unknown decks return **404**, malformed
ids **400**. CORS `*`, edge-cached 5 minutes. Pure helpers in `decklist.js`,
unit-tested by `src/lib/decklistWorker.test.js`.

And the **article thumbnail proxy** at `deckloom.app/api/og-image?url=<article-url>`
— MTGGoldfish and MTG Arena Zone's RSS feeds carry no image data at all, so the
Home page news section backfills their thumbnails by scraping `og:image` off
the article page itself. Host allow-listed (`OG_IMAGE_ALLOWED_HOSTS` in
`worker.js`), edge-cached 24 hours (article art never changes after publish).

## How it works

```
crawler  GET /d/<id>  → worker → get_deck_og_meta RPC → 200 OG HTML (real text/html)
browser  GET /d/<id>  → worker → fetch(request) → GitHub Pages SPA, unchanged
```

- Crawler detection is UA-based (`isCrawler` in `og.js`).
- `get_deck_og_meta(uuid)` is a SECURITY DEFINER RPC that returns **null for
  any non-public deck**, so private decks never leak metadata.
- Pass-through requests are byte-for-byte what GitHub Pages would serve
  directly; if the worker is removed, the site keeps working (just with
  generic previews).

## One-time deploy

```bash
cd cloudflare/og-worker
npx wrangler login
npx wrangler secret put SUPABASE_ANON_KEY   # paste the VITE_SUPABASE_ANON_KEY value
npx wrangler deploy
```

Then in the Cloudflare dashboard (dash.cloudflare.com → deckloom.app):

1. **DNS** → the `deckloom.app` A/CNAME records pointing at GitHub Pages must
   be set to **Proxied** (orange cloud). They are currently DNS-only, so the
   worker route never fires until this is flipped.
2. **SSL/TLS** → set encryption mode to **Full** (not Flexible — Flexible
   causes redirect loops with GitHub Pages, which already forces HTTPS).

## Verifying

```bash
# crawler view — expect 200 + og: tags
curl -s -A "Discordbot/2.0" https://deckloom.app/d/<some-public-deck-id> | grep "og:"

# human view — expect the normal SPA index.html via GitHub Pages
curl -s https://deckloom.app/d/<some-public-deck-id> | head -5
```

Facebook's [Sharing Debugger](https://developers.facebook.com/tools/debug/) and
Discord (paste the link in any channel) are the real-world checks. Note both
cache previews — use the debugger's "Scrape Again" after changes.

## Updating

Pure helpers live in `og.js` and are unit-tested by `src/lib/ogWorker.test.js`
(run `npm test`). After changing `og.js`/`worker.js`, redeploy with
`npx wrangler deploy`.
