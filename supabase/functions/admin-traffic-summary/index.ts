// admin-traffic-summary — traffic stats for the /admin Traffic tab.
//
// Three independent sources, merged into one payload:
//   1. Cloudflare zone analytics (httpRequests1dGroups) — edge request volume,
//      already collecting since the domain was proxied. Includes bot noise.
//   2. Cloudflare Web Analytics (rumPageloadEventsAdaptiveGroups) — cookieless
//      beacon: real human page views incl. SPA navigations, referrers, countries.
//   3. First-party deck view counts (deck_view_stats / deck_view_daily) — how
//      many people actually opened each shared /d/<id> link.
//
// The Cloudflare API token can never reach the browser, which is the whole
// reason this function exists. It is an admin-only proxy: the caller is verified
// against admin_users exactly like the other admin-* functions.
//
// Every source degrades independently — a missing token, an unresolvable site
// tag, or a renamed GraphQL dimension blanks one card instead of the whole tab.
//
// Secrets: CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID. CF_RUM_SITE_TAG is optional
// and only needed for an account hosting more than one Web Analytics site.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fillDailySeries } from './dateSeries.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const CF_API_TOKEN = Deno.env.get('CF_API_TOKEN') ?? ''
const CF_ACCOUNT_ID = Deno.env.get('CF_ACCOUNT_ID') ?? ''
const CF_ZONE_ID = Deno.env.get('CF_ZONE_ID') ?? ''
// Optional, and only needed for an account with more than one Web Analytics
// site. Unset means "no siteTag filter", which returns the account's RUM data —
// correct whenever there is a single site. It CANNOT be discovered from the API:
// /rum/site_info/list answers 403 for any scoped token, because no account
// permission grants it (the full permission list has "Account Analytics" and no
// Web Analytics entry at all). Only the Global API Key reaches that endpoint,
// and that is not a credential worth handing an edge function for a site tag.
const CF_RUM_SITE_TAG = Deno.env.get('CF_RUM_SITE_TAG') ?? ''

const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'

// Cloudflare's analytics API is rate limited and this data is never real-time.
// Function instances are reused, so a module-scope cache absorbs admin page
// reloads without hitting the API again.
const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, { at: number; payload: Record<string, unknown> }>()

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

async function cfGraphql(query: string, variables: Record<string, unknown>) {
  const res = await fetch(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CF_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Cloudflare API returned ${res.status}`)
  if (body?.errors?.length) throw new Error(body.errors[0]?.message || 'Cloudflare GraphQL error')
  return body?.data
}

// ── 1. Zone analytics ────────────────────────────────────────────────────────

const ZONE_QUERY = `
query Zone($zoneTag: String!, $since: String!, $until: String!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1dGroups(
        limit: 60
        filter: { date_geq: $since, date_leq: $until }
        orderBy: [date_ASC]
      ) {
        dimensions { date }
        sum { requests pageViews bytes threats }
        uniq { uniques }
      }
    }
  }
}`

async function loadZone(since: string, until: string) {
  if (!CF_ZONE_ID) throw new Error('CF_ZONE_ID is not configured.')
  const data = await cfGraphql(ZONE_QUERY, { zoneTag: CF_ZONE_ID, since, until })
  const groups = data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? []
  const daily = groups.map((g: Record<string, any>) => ({
    date: g?.dimensions?.date ?? null,
    requests: g?.sum?.requests ?? 0,
    page_views: g?.sum?.pageViews ?? 0,
    bytes: g?.sum?.bytes ?? 0,
    threats: g?.sum?.threats ?? 0,
    uniques: g?.uniq?.uniques ?? 0,
  }))
  const filled = fillDailySeries(daily, {
    since,
    until,
    zero: { requests: 0, page_views: 0, bytes: 0, threats: 0, uniques: 0 },
  })

  const totals = filled.reduce(
    (acc: Record<string, number>, row: Record<string, number>) => ({
      requests: acc.requests + row.requests,
      page_views: acc.page_views + row.page_views,
      bytes: acc.bytes + row.bytes,
      threats: acc.threats + row.threats,
      // Uniques are per-day and cannot be summed into a period unique count;
      // the peak day is the honest headline here.
      peak_daily_uniques: Math.max(acc.peak_daily_uniques, row.uniques),
    }),
    { requests: 0, page_views: 0, bytes: 0, threats: 0, peak_daily_uniques: 0 }
  )
  return { daily: filled, totals }
}

// ── 2. Web Analytics (RUM beacon) ────────────────────────────────────────────

// The filter is inlined rather than passed as a GraphQL variable on purpose:
// a variable needs its input-object type named exactly right, and getting that
// name wrong fails the whole query. Inlining removes that failure mode.
// `since`/`until` are generated here and the site tag is format-checked, so
// nothing untrusted reaches the query string.
function rumQuery(
  { dimension, orderBy, limit, since, until, siteTag, withVisits }: {
    dimension: string
    orderBy: string
    limit: number
    since: string
    until: string
    siteTag: string
    withVisits: boolean
  },
) {
  const filter = [`datetime_geq: "${since}"`, `datetime_leq: "${until}"`]
  if (siteTag) filter.push(`siteTag: "${siteTag}"`)
  return `
query Rum($accountTag: String!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rumPageloadEventsAdaptiveGroups(
        limit: ${limit}
        filter: { ${filter.join(', ')} }
        orderBy: [${orderBy}]
      ) {
        count
        dimensions { ${dimension} }
        ${withVisits ? 'sum { visits }' : ''}
      }
    }
  }
}`
}

async function loadRumGroup(opts: Parameters<typeof rumQuery>[0]) {
  const data = await cfGraphql(rumQuery(opts), { accountTag: CF_ACCOUNT_ID })
  return data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups ?? []
}

async function loadRum(since: string, until: string, sinceDate: string, untilDate: string) {
  if (!CF_ACCOUNT_ID) throw new Error('CF_ACCOUNT_ID is not configured.')

  // A malformed tag would land inside the query string; Cloudflare site tags
  // are hex, so anything else is rejected rather than interpolated.
  const siteTag = /^[a-zA-Z0-9]+$/.test(CF_RUM_SITE_TAG) ? CF_RUM_SITE_TAG : ''
  if (CF_RUM_SITE_TAG && !siteTag) {
    throw new Error('CF_RUM_SITE_TAG is not a valid site tag.')
  }
  const base = { since, until, siteTag }

  // Each breakdown is its own request so one unsupported dimension degrades a
  // single card rather than the entire beacon panel. Only the daily series asks
  // for `visits`, keeping the breakdowns to the fields most likely to exist.
  const [daily, paths, referrers, countries] = await Promise.allSettled([
    loadRumGroup({ ...base, dimension: 'date', orderBy: 'date_ASC', limit: 60, withVisits: true }),
    loadRumGroup({ ...base, dimension: 'requestPath', orderBy: 'count_DESC', limit: 15, withVisits: false }),
    loadRumGroup({ ...base, dimension: 'refererHost', orderBy: 'count_DESC', limit: 15, withVisits: false }),
    loadRumGroup({ ...base, dimension: 'countryName', orderBy: 'count_DESC', limit: 15, withVisits: false }),
  ])

  const rows = (r: PromiseSettledResult<any>) => (r.status === 'fulfilled' ? r.value : [])

  const dailyRows = rows(daily).map((g: Record<string, any>) => ({
    date: g?.dimensions?.date ?? null,
    page_views: g?.count ?? 0,
    visits: g?.sum?.visits ?? 0,
  }))

  const breakdown = (r: PromiseSettledResult<any>, key: string) =>
    rows(r).map((g: Record<string, any>) => ({
      label: g?.dimensions?.[key] ?? 'unknown',
      page_views: g?.count ?? 0,
    }))

  if (daily.status === 'rejected' && paths.status === 'rejected') {
    throw new Error(
      (daily.reason as Error)?.message ||
        'Web Analytics returned no data — is the beacon installed?',
    )
  }

  const filled = fillDailySeries(dailyRows, {
    since: sinceDate,
    until: untilDate,
    zero: { page_views: 0, visits: 0 },
  })

  return {
    daily: filled,
    totals: filled.reduce(
      (acc: Record<string, number>, row: Record<string, number>) => ({
        page_views: acc.page_views + row.page_views,
        visits: acc.visits + row.visits,
      }),
      { page_views: 0, visits: 0 },
    ),
    top_paths: breakdown(paths, 'requestPath'),
    top_referrers: breakdown(referrers, 'refererHost'),
    top_countries: breakdown(countries, 'countryName'),
  }
}

// ── 3. First-party deck views ────────────────────────────────────────────────

async function loadDeckViews(adminClient: any, since: string, until: string) {

  const { data: statsRows, error: statsError } = await adminClient
    .from('deck_view_stats')
    .select('deck_id, total_views, last_viewed_at')
    .order('total_views', { ascending: false })
    .limit(500)
  if (statsError) throw statsError

  const { data: dailyRows, error: dailyError } = await adminClient
    .from('deck_view_daily')
    .select('deck_id, view_date, views')
    .gte('view_date', since)
    .limit(10000)
  if (dailyError) throw dailyError

  const inRangeByDeck = new Map<string, number>()
  const byDate = new Map<string, number>()
  for (const row of dailyRows || []) {
    inRangeByDeck.set(row.deck_id, (inRangeByDeck.get(row.deck_id) || 0) + (row.views || 0))
    byDate.set(row.view_date, (byDate.get(row.view_date) || 0) + (row.views || 0))
  }

  const top = (statsRows || [])
    .map((row: Record<string, any>) => ({
      deck_id: row.deck_id,
      name: null as string | null,
      total_views: row.total_views || 0,
      range_views: inRangeByDeck.get(row.deck_id) || 0,
      last_viewed_at: row.last_viewed_at,
    }))
    .sort((a: any, b: any) => b.range_views - a.range_views || b.total_views - a.total_views)
    .slice(0, 15)

  if (top.length) {
    const { data: folders } = await adminClient
      .from('folders')
      .select('id, name')
      .in('id', top.map((t: any) => t.deck_id))
    const nameById = new Map((folders || []).map((f: any) => [f.id, f.name]))
    for (const row of top) row.name = nameById.get(row.deck_id) ?? null
  }

  return {
    total_views: (statsRows || []).reduce(
      (sum: number, r: Record<string, any>) => sum + (r.total_views || 0),
      0
    ),
    range_views: [...inRangeByDeck.values()].reduce((sum, v) => sum + v, 0),
    tracked_decks: (statsRows || []).length,
    daily: fillDailySeries(
      [...byDate.entries()].map(([date, views]) => ({ date, views })),
      { since, until, zero: { views: 0 } },
    ),
    top,
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Supabase function environment is incomplete.' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Missing authorization header.' }, 401)

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  try {
    const { data: actorData, error: actorError } = await userClient.auth.getUser()
    if (actorError || !actorData.user) {
      return json({ error: 'Could not verify the current admin user.' }, 401)
    }

    const { data: adminRow, error: adminError } = await adminClient
      .from('admin_users')
      .select('user_id')
      .eq('user_id', actorData.user.id)
      .eq('active', true)
      .maybeSingle()

    if (adminError || !adminRow) return json({ error: 'Admin access required.' }, 403)

    const body = await req.json().catch(() => ({}))
    const rangeDays = [7, 30, 60].includes(body?.range_days) ? body.range_days : 30
    const refresh = body?.refresh === true

    const cacheKey = `traffic:${rangeDays}`
    const cached = cache.get(cacheKey)
    if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return json({ ...cached.payload, cached: true })
    }

    const until = new Date()
    const since = new Date(until.getTime() - rangeDays * 86400000)
    const sinceDate = isoDate(since)
    const untilDate = isoDate(until)
    const noToken = () => Promise.reject(new Error('CF_API_TOKEN is not configured.'))

    const [zone, rum, decks] = await Promise.allSettled([
      CF_API_TOKEN ? loadZone(sinceDate, untilDate) : noToken(),
      CF_API_TOKEN
        ? loadRum(since.toISOString(), until.toISOString(), sinceDate, untilDate)
        : noToken(),
      loadDeckViews(adminClient, sinceDate, untilDate),
    ])

    const section = (r: PromiseSettledResult<any>) =>
      r.status === 'fulfilled'
        ? { available: true, error: null, ...r.value }
        : { available: false, error: (r.reason as Error)?.message || 'Unavailable.' }

    const payload = {
      generated_at: new Date().toISOString(),
      range_days: rangeDays,
      zone: section(zone),
      rum: section(rum),
      decks: section(decks),
      cached: false,
    }

    cache.set(cacheKey, { at: Date.now(), payload })
    return json(payload)
  } catch (err) {
    return json(
      { error: 'Traffic summary failed.', details: String((err as Error)?.message || err) },
      500
    )
  }
})
