import { describe, it, expect } from 'vitest'
// Pure OG helpers used by the deckloom-og Cloudflare Worker. Imported here
// (rather than tested in cloudflare/) because vitest's include is scoped to
// src/**, but Vite transforms the import fine.
import {
  isCrawler,
  extractDeckId,
  escapeHtml,
  buildDescription,
  deckPublicUrl,
  renderOgHtml,
} from '../../cloudflare/og-worker/og.js'

describe('isCrawler', () => {
  it('detects known social crawlers', () => {
    expect(isCrawler('facebookexternalhit/1.1')).toBe(true)
    expect(isCrawler('Mozilla/5.0 (compatible; Discordbot/2.0)')).toBe(true)
    expect(isCrawler('Twitterbot/1.0')).toBe(true)
    expect(isCrawler('WhatsApp/2.23')).toBe(true)
  })
  it('treats real browsers and empty UAs as non-crawlers (they pass through to the SPA)', () => {
    expect(isCrawler('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120')).toBe(false)
    expect(isCrawler('')).toBe(false)
    expect(isCrawler(null)).toBe(false)
    expect(isCrawler(undefined)).toBe(false)
  })
})

describe('extractDeckId', () => {
  it('reads the id from the /d/<id> path segment', () => {
    expect(extractDeckId('https://deckloom.app/d/abc-123')).toBe('abc-123')
    expect(extractDeckId('https://deckloom.app/d/abc-123?utm_source=x')).toBe('abc-123')
  })
  it('returns null when no id is present', () => {
    expect(extractDeckId('https://deckloom.app/d/')).toBeNull()
    expect(extractDeckId('https://deckloom.app/d')).toBeNull()
    expect(extractDeckId('https://deckloom.app/')).toBeNull()
  })
})

describe('escapeHtml', () => {
  it('escapes HTML-significant characters', () => {
    expect(escapeHtml(`<script>"x" & 'y'`)).toBe('&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;')
  })
})

describe('buildDescription', () => {
  it('includes commander, format, count and creator', () => {
    const d = buildDescription({ commander: 'Atraxa', format: 'commander', total_cards: 100, creator: 'Jan' })
    expect(d).toContain('Atraxa')
    expect(d).toContain('Commander')
    expect(d).toContain('100 cards')
    expect(d).toContain('by Jan')
  })
  it('omits the commander for non-commander decks and singularizes 1 card', () => {
    const d = buildDescription({ format: 'standard', total_cards: 1 })
    expect(d).toContain('Standard')
    expect(d).toContain('1 card')
    expect(d).not.toContain('1 cards')
  })
})

describe('renderOgHtml', () => {
  const meta = { name: 'Atraxa Superfriends', format: 'commander', commander: "Atraxa, Praetors' Voice", total_cards: 100, art: 'https://cards.scryfall.io/art_crop/x.jpg', creator: 'Jan' }

  it('uses deck-specific title, art image and large summary card', () => {
    const html = renderOgHtml('deck-1', meta)
    expect(html).toContain('<meta property="og:title" content="Atraxa Superfriends — DeckLoom" />')
    expect(html).toContain('<meta property="og:image" content="https://cards.scryfall.io/art_crop/x.jpg" />')
    expect(html).toContain('summary_large_image')
    expect(html).toContain('<meta property="og:url" content="https://deckloom.app/d/deck-1" />')
  })

  it('falls back to generic branding and a summary card when the deck is private/not found', () => {
    const html = renderOgHtml('deck-1', null)
    expect(html).toContain('DeckLoom — MTG Collection Tracker')
    expect(html).toContain('apple-touch-icon.png')
    expect(html).toContain('<meta name="twitter:card" content="summary" />')
    expect(html).not.toContain('summary_large_image')
  })

  it('escapes user-controlled deck names so they cannot break out of attributes', () => {
    const html = renderOgHtml('deck-1', { ...meta, name: '"><script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('contains no redirect — the HTML is served on the canonical URL itself', () => {
    // A meta-refresh or JS redirect here would loop, since the worker serves
    // this document at /d/<id> directly (unlike the old og-deck function).
    const html = renderOgHtml('deck-1', meta)
    expect(html).not.toContain('http-equiv="refresh"')
    expect(html).not.toContain('window.location')
  })
})

describe('deckPublicUrl', () => {
  it('builds the branded human-facing URL', () => {
    expect(deckPublicUrl('abc')).toBe('https://deckloom.app/d/abc')
  })
})
