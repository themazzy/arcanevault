import { describe, it, expect, vi, afterEach } from 'vitest'
import { getProdAppUrl, getDeckShareUrl } from './publicUrl'
// Pure OG helpers used by the `og-deck` edge function. Imported here (rather
// than tested in supabase/) because vitest's include is scoped to src/**, but
// Vite still transforms the .ts import fine.
import {
  isCrawler,
  extractDeckId,
  escapeHtml,
  buildDescription,
  deckPublicUrl,
  renderOgHtml,
} from '../../supabase/functions/og-deck/og.ts'

// getPublicBaseUrl / getPublicAppUrl depend on import.meta.env at module-load
// time, so they're awkward to mock without a vitest env setup per file. The
// behaviour we most care about preserving — that email-flow URLs always hit
// production — lives in getProdAppUrl, which has no env dependency.

describe('getProdAppUrl', () => {
  it('always returns the prod origin regardless of build env', () => {
    expect(getProdAppUrl('/'))                .toBe('https://deckloom.app/')
    expect(getProdAppUrl('/reset-password'))  .toBe('https://deckloom.app/reset-password')
    expect(getProdAppUrl(''))                 .toBe('https://deckloom.app/')
  })

  it('normalises paths without a leading slash', () => {
    expect(getProdAppUrl('confirm')).toBe('https://deckloom.app/confirm')
  })

  it('preserves an explicit leading slash without doubling it', () => {
    expect(getProdAppUrl('/confirm')).toBe('https://deckloom.app/confirm')
  })
})

afterEach(() => vi.unstubAllEnvs())

describe('getDeckShareUrl', () => {
  it('points the share link at the og-deck edge function', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co')
    expect(getDeckShareUrl('abc-123')).toBe('https://proj.supabase.co/functions/v1/og-deck/abc-123')
  })
  it('trims a trailing slash on the supabase url', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co/')
    expect(getDeckShareUrl('abc')).toBe('https://proj.supabase.co/functions/v1/og-deck/abc')
  })
})

describe('isCrawler', () => {
  it('detects known social crawlers', () => {
    expect(isCrawler('facebookexternalhit/1.1')).toBe(true)
    expect(isCrawler('Mozilla/5.0 (compatible; Discordbot/2.0)')).toBe(true)
    expect(isCrawler('Twitterbot/1.0')).toBe(true)
    expect(isCrawler('WhatsApp/2.23')).toBe(true)
  })
  it('treats real browsers and empty UAs as non-crawlers (they get redirected)', () => {
    expect(isCrawler('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120')).toBe(false)
    expect(isCrawler('')).toBe(false)
    expect(isCrawler(null)).toBe(false)
    expect(isCrawler(undefined)).toBe(false)
  })
})

describe('extractDeckId', () => {
  it('reads the id from the path segment after og-deck', () => {
    expect(extractDeckId('https://x.supabase.co/functions/v1/og-deck/abc-123')).toBe('abc-123')
  })
  it('reads the id from a query param', () => {
    expect(extractDeckId('https://x.supabase.co/functions/v1/og-deck?id=abc-123')).toBe('abc-123')
  })
  it('returns null when no id is present', () => {
    expect(extractDeckId('https://x.supabase.co/functions/v1/og-deck')).toBeNull()
    expect(extractDeckId('https://x.supabase.co/functions/v1/og-deck/')).toBeNull()
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
    // canonical / og:url always point at the branded domain, not the function URL
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
})

describe('deckPublicUrl', () => {
  it('builds the branded human-facing URL', () => {
    expect(deckPublicUrl('abc')).toBe('https://deckloom.app/d/abc')
  })
})
