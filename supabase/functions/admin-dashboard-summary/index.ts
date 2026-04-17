import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function daysBetween(now: Date, input: string | null | undefined) {
  if (!input) return null
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return null
  return Math.floor((now.getTime() - date.getTime()) / 86400000)
}

async function countRows(adminClient: any, table: string, queryBuilder?: (query: any) => any) {
  let query = adminClient.from(table).select('*', { count: 'exact', head: true })
  if (queryBuilder) query = queryBuilder(query)
  const { count, error } = await query
  if (error) throw error
  return count || 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Supabase function environment is incomplete.' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'Missing authorization header.' }, 401)
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  try {
    const { data: actorData, error: actorError } = await userClient.auth.getUser()
    if (actorError || !actorData.user) {
      return json({ error: 'Could not verify the current admin user.' }, 401)
    }

    const actorUserId = actorData.user.id
    const { data: adminRow, error: adminError } = await adminClient
      .from('admin_users')
      .select('user_id')
      .eq('user_id', actorUserId)
      .eq('active', true)
      .maybeSingle()

    if (adminError || !adminRow) {
      return json({ error: 'Admin access required.' }, 403)
    }

    const now = new Date()
    const cutoff7 = new Date(now.getTime() - 7 * 86400000).toISOString()
    const cutoff30 = new Date(now.getTime() - 30 * 86400000).toISOString()

    const users: any[] = []
    let page = 1
    let totalUsers = 0

    while (true) {
      const { data, error } = await adminClient.auth.admin.listUsers({
        page,
        perPage: 200,
      })
      if (error) throw error
      const batch = data?.users || []
      users.push(...batch)
      totalUsers = data?.total ?? users.length
      if (batch.length < 200 || users.length >= totalUsers) break
      page += 1
    }

    const newUsers7d = users.filter(user => {
      const createdAt = user.created_at ? new Date(user.created_at).getTime() : 0
      return createdAt >= new Date(cutoff7).getTime()
    }).length

    const activeUsers30d = users.filter(user => {
      const lastSignInAt = user.last_sign_in_at ? new Date(user.last_sign_in_at).getTime() : 0
      return lastSignInAt >= new Date(cutoff30).getTime()
    }).length

    const recentSignups = users
      .slice()
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, 6)
      .map(user => ({
        id: user.id,
        email: user.email || 'unknown',
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at,
      }))

    const [
      cardsCount,
      foldersCount,
      feedbackCount,
      deletionPendingCount,
      settingsCount,
      gameResultsCount,
    ] = await Promise.all([
      countRows(adminClient, 'cards'),
      countRows(adminClient, 'folders'),
      countRows(adminClient, 'feedback'),
      countRows(adminClient, 'account_deletion_requests', q => q.eq('status', 'pending')),
      countRows(adminClient, 'user_settings'),
      countRows(adminClient, 'game_results'),
    ])

    const { data: foldersData, error: foldersError } = await adminClient
      .from('folders')
      .select('type')
    if (foldersError) throw foldersError

    const folderBreakdown = { binder: 0, deck: 0, list: 0, builder_deck: 0 }
    for (const row of foldersData || []) {
      if (row.type in folderBreakdown) {
        folderBreakdown[row.type as keyof typeof folderBreakdown] += 1
      }
    }

    const { data: feedbackRows, error: feedbackError } = await adminClient
      .from('feedback')
      .select('id, type, description, user_email, created_at')
      .order('created_at', { ascending: false })
      .limit(6)
    if (feedbackError) throw feedbackError

    let bugsCount = 0
    let featuresCount = 0
    for (const row of feedbackRows || []) {
      if (row.type === 'bug') bugsCount += 1
      if (row.type === 'feature') featuresCount += 1
    }

    const { data: feedbackAllTypes, error: feedbackAllTypesError } = await adminClient
      .from('feedback')
      .select('type')
    if (feedbackAllTypesError) throw feedbackAllTypesError
    for (const row of feedbackAllTypes || []) {
      if (row.type === 'bug') bugsCount += 0
      if (row.type === 'feature') featuresCount += 0
    }
    bugsCount = (feedbackAllTypes || []).filter((row: any) => row.type === 'bug').length
    featuresCount = (feedbackAllTypes || []).filter((row: any) => row.type === 'feature').length

    const { data: deletionRecent, error: deletionRecentError } = await adminClient
      .from('account_deletion_requests')
      .select('id, user_email, status, source, created_at')
      .order('created_at', { ascending: false })
      .limit(6)
    if (deletionRecentError) throw deletionRecentError

    const { data: latestPrice, error: latestPriceError } = await adminClient
      .from('card_prices')
      .select('snapshot_date, updated_at')
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latestPriceError) throw latestPriceError

    const priceAgeDays = daysBetween(now, latestPrice?.snapshot_date)
    const alerts = []

    if ((deletionPendingCount || 0) > 0) {
      alerts.push({
        severity: 'warning',
        title: 'Deletion queue needs review',
        message: `${deletionPendingCount} pending deletion request${deletionPendingCount === 1 ? '' : 's'} waiting for triage.`,
      })
    }

    if (priceAgeDays === null) {
      alerts.push({
        severity: 'danger',
        title: 'Price snapshots missing',
        message: 'No shared card price snapshot was found.',
      })
    } else if (priceAgeDays > 2) {
      alerts.push({
        severity: 'warning',
        title: 'Price data looks stale',
        message: `Latest shared card price snapshot is ${priceAgeDays} days old.`,
      })
    }

    if (settingsCount < totalUsers && totalUsers > 0) {
      alerts.push({
        severity: 'info',
        title: 'Some users have no synced settings row',
        message: `${totalUsers - settingsCount} account${totalUsers - settingsCount === 1 ? '' : 's'} do not yet have a user_settings row.`,
      })
    }

    if (!alerts.length) {
      alerts.push({
        severity: 'success',
        title: 'No immediate admin issues detected',
        message: 'Deletion queue, price freshness, and settings coverage look acceptable.',
      })
    }

    return json({
      ok: true,
      generated_at: now.toISOString(),
      overview: {
        total_users: totalUsers,
        active_users_30d: activeUsers30d,
        new_users_7d: newUsers7d,
        cards: cardsCount,
        folders: foldersCount,
        binders: folderBreakdown.binder,
        decks: folderBreakdown.deck + folderBreakdown.builder_deck,
        lists: folderBreakdown.list,
        feedback_total: feedbackCount,
        bug_reports: bugsCount,
        feature_requests: featuresCount,
        pending_deletion_requests: deletionPendingCount,
        settings_rows: settingsCount,
        game_results: gameResultsCount,
        latest_price_snapshot_date: latestPrice?.snapshot_date || null,
        latest_price_snapshot_age_days: priceAgeDays,
      },
      recent_signups: recentSignups,
      recent_feedback: feedbackRows || [],
      recent_deletion_requests: deletionRecent || [],
      alerts,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: 'Could not build admin dashboard summary.', details: message }, 500)
  }
})
