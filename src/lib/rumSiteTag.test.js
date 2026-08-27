import { describe, expect, it } from 'vitest'
import { pickSiteTag } from '../../supabase/functions/admin-traffic-summary/siteTag.ts'

const site = (tag, zoneName, rules) => ({
  site_tag: tag,
  auto_install: true,
  ruleset: { zone_name: zoneName, rules },
})

describe('pickSiteTag', () => {
  it('matches the site by zone name', () => {
    const sites = [site('tag-other', 'example.com'), site('tag-deckloom', 'deckloom.app')]
    expect(pickSiteTag(sites, 'deckloom.app')).toBe('tag-deckloom')
  })

  it('is case-insensitive on the host', () => {
    expect(pickSiteTag([site('t', 'DeckLoom.App')], 'deckloom.app')).toBe('t')
  })

  it('matches a rule host when zone_name is absent', () => {
    const sites = [site('t', undefined, [{ host: 'deckloom.app' }])]
    expect(pickSiteTag(sites, 'deckloom.app')).toBe('t')
  })

  it('treats a wildcard rule as covering the host and the apex', () => {
    const sites = [site('t', undefined, [{ host: '*.deckloom.app' }])]
    expect(pickSiteTag(sites, 'deckloom.app')).toBe('t')
    expect(pickSiteTag(sites, 'www.deckloom.app')).toBe('t')
  })

  it('prefers an exact match over a wildcard on another site', () => {
    const sites = [
      site('tag-wild', undefined, [{ host: '*' }]),
      site('tag-exact', 'deckloom.app'),
    ]
    expect(pickSiteTag(sites, 'deckloom.app')).toBe('tag-exact')
  })

  it('falls back to the only site when nothing matched by name', () => {
    // Cloudflare does not always populate zone_name on auto-installed sites,
    // and a single-site account is unambiguous.
    expect(pickSiteTag([site('t', undefined)], 'deckloom.app')).toBe('t')
  })

  it('refuses to guess between several unmatched sites', () => {
    const sites = [site('a', 'one.com'), site('b', 'two.com')]
    expect(pickSiteTag(sites, 'deckloom.app')).toBeNull()
  })

  it('ignores entries with no site_tag', () => {
    const sites = [{ ruleset: { zone_name: 'deckloom.app' } }, site('real', 'deckloom.app')]
    expect(pickSiteTag(sites, 'deckloom.app')).toBe('real')
  })

  it('returns null for an empty or malformed list', () => {
    expect(pickSiteTag([], 'deckloom.app')).toBeNull()
    expect(pickSiteTag(null, 'deckloom.app')).toBeNull()
    expect(pickSiteTag(undefined, 'deckloom.app')).toBeNull()
  })
})
