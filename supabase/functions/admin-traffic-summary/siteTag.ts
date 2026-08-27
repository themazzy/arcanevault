// Picking the Web Analytics site out of an account's RUM site list.
//
// Cloudflare keeps two different identifiers per site and they are easy to
// confuse: `site_token` is what goes in the JS snippet, `site_tag` is what the
// GraphQL analytics API filters on. Only `site_tag` is useful here — using the
// token silently returns an empty result set rather than an error.
//
// Kept as a pure function in its own file so it can be unit-tested without the
// Deno runtime or a live Cloudflare account.

export type RumSite = {
  site_tag?: string
  auto_install?: boolean
  ruleset?: {
    zone_name?: string
    rules?: Array<{ host?: string }>
  }
  rules?: Array<{ host?: string }>
}

function hostCandidates(site: RumSite): string[] {
  const out: string[] = []
  const push = (v?: string) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim().toLowerCase())
  }
  push(site?.ruleset?.zone_name)
  for (const rule of site?.ruleset?.rules || []) push(rule?.host)
  for (const rule of site?.rules || []) push(rule?.host)
  return out
}

/**
 * Returns the site_tag for `host`, or null when it cannot be determined.
 *
 * Matching is exact on the zone name or any rule host, with a wildcard rule
 * ("*.deckloom.app" / "*") treated as covering the host. When the account holds
 * exactly one site and nothing matched by name, that site is used — a
 * single-site account is unambiguous, and Cloudflare does not always populate
 * zone_name on automatically installed sites.
 */
export function pickSiteTag(sites: RumSite[] | null | undefined, host: string): string | null {
  const list = Array.isArray(sites) ? sites.filter(s => typeof s?.site_tag === 'string' && s.site_tag) : []
  if (!list.length) return null

  const target = String(host || '').trim().toLowerCase()
  if (!target) return list.length === 1 ? list[0].site_tag ?? null : null

  for (const site of list) {
    for (const candidate of hostCandidates(site)) {
      if (candidate === target) return site.site_tag ?? null
    }
  }

  for (const site of list) {
    for (const candidate of hostCandidates(site)) {
      if (candidate === '*') return site.site_tag ?? null
      if (candidate.startsWith('*.')) {
        const suffix = candidate.slice(1) // ".deckloom.app"
        if (target === candidate.slice(2) || target.endsWith(suffix)) return site.site_tag ?? null
      }
    }
  }

  return list.length === 1 ? list[0].site_tag ?? null : null
}
