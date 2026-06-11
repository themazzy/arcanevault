// Pure helpers for the deckloom-og Cloudflare Worker — kept separate from
// worker.js so they can be unit-tested by vitest (see src/lib/ogWorker.test.js)
// without a Workers runtime.

const PROD_ORIGIN = 'https://deckloom.app'

// Known link-unfurling crawlers that do NOT execute JavaScript and rely purely
// on the static <meta> tags we serve. Anything not matching is treated as a
// real browser and passed through to the SPA on GitHub Pages.
const BOT_UA = /facebookexternalhit|facebot|twitterbot|discordbot|slackbot|slack-imgproxy|telegrambot|whatsapp|linkedinbot|pinterest|redditbot|googlebot|bingbot|embedly|quora link preview|showyoubot|outbrain|vkshare|w3c_validator|applebot|skypeuripreview|nuzzel|bitlybot|flipboard|tumblr|google-structured-data-testing-tool|developers\.google\.com\/\+\/web\/snippet|mastodon|iframely/i

export function isCrawler(userAgent) {
  if (!userAgent) return false
  return BOT_UA.test(userAgent)
}

// Extract the deck id from a /d/<id> path. Returns null when no plausible id
// is present (e.g. a bare /d/ request).
export function extractDeckId(url) {
  const u = new URL(url)
  const parts = u.pathname.split('/').filter(Boolean)
  const idx = parts.indexOf('d')
  const id = idx >= 0 ? parts[idx + 1] : null
  return id ? decodeURIComponent(id) : null
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const FORMAT_LABELS = {
  commander: 'Commander',
  brawl: 'Brawl',
  standard: 'Standard',
  pioneer: 'Pioneer',
  modern: 'Modern',
  legacy: 'Legacy',
  vintage: 'Vintage',
  pauper: 'Pauper',
  historic: 'Historic',
  oathbreaker: 'Oathbreaker',
}

function formatLabel(id) {
  if (typeof id !== 'string' || !id) return null
  return FORMAT_LABELS[id] || (id.charAt(0).toUpperCase() + id.slice(1))
}

export function buildDescription(meta) {
  const parts = []
  if (meta.commander) parts.push(meta.commander)
  const fmt = formatLabel(meta.format)
  if (fmt) parts.push(fmt)
  const n = meta.total_cards ?? 0
  if (n > 0) parts.push(`${n} card${n === 1 ? '' : 's'}`)
  if (meta.creator) parts.push(`by ${meta.creator}`)
  parts.push('View this deck on DeckLoom.')
  return parts.join(' · ')
}

// The canonical, human-facing URL — with the worker this is also the URL the
// crawler is already on, so og:url simply confirms it.
export function deckPublicUrl(deckId) {
  return `${PROD_ORIGIN}/d/${encodeURIComponent(deckId)}`
}

// Full HTML document served to crawlers. Unlike the old og-deck edge function
// this is served AT the canonical /d/<id> URL itself, so there must be no
// meta-refresh or JS redirect here — it would loop. A misclassified human just
// sees a plain link into the app.
export function renderOgHtml(deckId, meta) {
  const canonical = deckPublicUrl(deckId)
  const title = meta?.name ? `${meta.name} — DeckLoom` : 'DeckLoom — MTG Collection Tracker'
  const description = meta
    ? buildDescription(meta)
    : 'Catalog cards, build decks, scan with your camera, organise binders and wishlists, and follow daily EUR & USD prices.'
  const image = meta?.art || `${PROD_ORIGIN}/apple-touch-icon.png`
  const largeImage = Boolean(meta?.art)

  const t = escapeHtml(title)
  const d = escapeHtml(description)
  const img = escapeHtml(image)
  const url = escapeHtml(canonical)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${t}</title>
<meta name="description" content="${d}" />
<link rel="canonical" href="${url}" />

<meta property="og:site_name" content="DeckLoom" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${t}" />
<meta property="og:description" content="${d}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${img}" />
${largeImage ? '<meta property="og:image:width" content="626" />\n<meta property="og:image:height" content="457" />' : ''}

<meta name="twitter:card" content="${largeImage ? 'summary_large_image' : 'summary'}" />
<meta name="twitter:title" content="${t}" />
<meta name="twitter:description" content="${d}" />
<meta name="twitter:image" content="${img}" />
</head>
<body>
<p><a href="${url}">View this deck on DeckLoom</a></p>
</body>
</html>`
}
