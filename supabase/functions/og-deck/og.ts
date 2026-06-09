// Pure helpers for the og-deck edge function — kept separate from index.ts so
// they can be unit-tested without a running Deno server.

const PROD_ORIGIN = 'https://deckloom.app'

// Known link-unfurling crawlers that do NOT execute JavaScript and rely purely
// on the static <meta> tags we serve. Anything not matching is treated as a
// real browser and redirected to the SPA.
const BOT_UA = /facebookexternalhit|facebot|twitterbot|discordbot|slackbot|slack-imgproxy|telegrambot|whatsapp|linkedinbot|pinterest|redditbot|googlebot|bingbot|embedly|quora link preview|showyoubot|outbrain|vkshare|w3c_validator|applebot|skypeuripreview|nuzzel|bitlybot|flipboard|tumblr|google-structured-data-testing-tool|developers\.google\.com\/\+\/web\/snippet|mastodon|iframely|whatsapp/i

export function isCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  return BOT_UA.test(userAgent)
}

// Extract the deck id from either a path segment (/functions/v1/og-deck/<id>)
// or a ?id= query param. Returns null when no plausible id is present.
export function extractDeckId(url: string): string | null {
  const u = new URL(url)
  const q = u.searchParams.get('id')
  if (q) return q.trim()
  const parts = u.pathname.split('/').filter(Boolean)
  const idx = parts.indexOf('og-deck')
  const last = idx >= 0 ? parts[idx + 1] : parts[parts.length - 1]
  return last && last !== 'og-deck' ? decodeURIComponent(last) : null
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const FORMAT_LABELS: Record<string, string> = {
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

function formatLabel(id: unknown): string | null {
  if (typeof id !== 'string' || !id) return null
  return FORMAT_LABELS[id] || (id.charAt(0).toUpperCase() + id.slice(1))
}

export interface DeckOgMeta {
  name?: string | null
  format?: string | null
  commander?: string | null
  total_cards?: number | null
  art?: string | null
  creator?: string | null
}

export function buildDescription(meta: DeckOgMeta): string {
  const parts: string[] = []
  if (meta.commander) parts.push(meta.commander)
  const fmt = formatLabel(meta.format)
  if (fmt) parts.push(fmt)
  const n = meta.total_cards ?? 0
  if (n > 0) parts.push(`${n} card${n === 1 ? '' : 's'}`)
  if (meta.creator) parts.push(`by ${meta.creator}`)
  parts.push('View this deck on DeckLoom.')
  return parts.join(' · ')
}

// The canonical, human-facing URL the preview should point at.
export function deckPublicUrl(deckId: string): string {
  return `${PROD_ORIGIN}/d/${encodeURIComponent(deckId)}`
}

// Full HTML document served to crawlers. Includes a meta-refresh + JS redirect
// as a belt-and-braces fallback in case a real browser ever lands here.
export function renderOgHtml(deckId: string, meta: DeckOgMeta | null): string {
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

<meta http-equiv="refresh" content="0; url=${url}" />
</head>
<body>
<p>Redirecting to <a href="${url}">${url}</a>…</p>
<script>window.location.replace(${JSON.stringify(canonical)});</script>
</body>
</html>`
}
