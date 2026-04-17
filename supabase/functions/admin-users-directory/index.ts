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

async function countRows(adminClient: any, table: string, queryBuilder?: (query: any) => any) {
  let query = adminClient.from(table).select('*', { count: 'exact', head: true })
  if (queryBuilder) query = queryBuilder(query)
  const { count, error } = await query
  if (error) throw error
  return count || 0
}

async function listAllUsers(adminClient: any) {
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

  return users
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

    const body = await req.json().catch(() => ({}))
    const search = typeof body?.search === 'string' ? body.search.trim().toLowerCase() : ''
    const selectedUserId = typeof body?.selected_user_id === 'string' ? body.selected_user_id : ''

    const allUsers = await listAllUsers(adminClient)
    const filteredUsers = allUsers
      .filter((user: any) => {
        if (!search) return true
        const email = String(user.email || '').toLowerCase()
        const id = String(user.id || '').toLowerCase()
        return email.includes(search) || id.includes(search)
      })
      .sort((a: any, b: any) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, 50)

    const userIds = filteredUsers.map((user: any) => user.id)

    let settingsRows: any[] = []
    let deletionRows: any[] = []
    if (userIds.length) {
      const [{ data: settingsData, error: settingsError }, { data: deletionData, error: deletionError }] = await Promise.all([
        adminClient.from('user_settings').select('user_id, nickname, updated_at').in('user_id', userIds),
        adminClient.from('account_deletion_requests').select('user_id, status, created_at').in('user_id', userIds),
      ])
      if (settingsError) throw settingsError
      if (deletionError) throw deletionError
      settingsRows = settingsData || []
      deletionRows = deletionData || []
    }

    const settingsMap = new Map(settingsRows.map((row: any) => [row.user_id, row]))
    const deletionMap = new Map<string, any>()
    for (const row of deletionRows) {
      const current = deletionMap.get(row.user_id)
      if (!current || new Date(row.created_at).getTime() > new Date(current.created_at).getTime()) {
        deletionMap.set(row.user_id, row)
      }
    }

    const users = filteredUsers.map((user: any) => {
      const settings = settingsMap.get(user.id)
      const deletion = deletionMap.get(user.id)
      return {
        id: user.id,
        email: user.email || 'unknown',
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at,
        nickname: settings?.nickname || '',
        has_settings: !!settings,
        settings_updated_at: settings?.updated_at || null,
        deletion_status: deletion?.status || null,
        deletion_requested_at: deletion?.created_at || null,
      }
    })

    let selectedUser = null

    if (selectedUserId) {
      const selectedAuthUser = allUsers.find((user: any) => user.id === selectedUserId)
      if (selectedAuthUser) {
        const userEmail = selectedAuthUser.email || null

        const [
          cardsCount,
          foldersCount,
          deckCardsCount,
          deckAllocationsCount,
          listItemsCount,
          gameResultsCount,
          settingsRow,
          folderRows,
          feedbackRows,
          deletionRequestRows,
          adminMembership,
        ] = await Promise.all([
          countRows(adminClient, 'cards', q => q.eq('user_id', selectedUserId)),
          countRows(adminClient, 'folders', q => q.eq('user_id', selectedUserId)),
          countRows(adminClient, 'deck_cards', q => q.eq('user_id', selectedUserId)),
          countRows(adminClient, 'deck_allocations', q => q.eq('user_id', selectedUserId)),
          countRows(adminClient, 'list_items', q => q.eq('user_id', selectedUserId)),
          countRows(adminClient, 'game_results', q => q.eq('user_id', selectedUserId)),
          adminClient.from('user_settings').select('*').eq('user_id', selectedUserId).maybeSingle(),
          adminClient.from('folders').select('id, type, name, created_at').eq('user_id', selectedUserId).order('created_at', { ascending: false }).limit(8),
          userEmail
            ? adminClient.from('feedback').select('id, type, description, created_at').or(`user_id.eq.${selectedUserId},user_email.eq.${userEmail}`).order('created_at', { ascending: false }).limit(6)
            : adminClient.from('feedback').select('id, type, description, created_at').eq('user_id', selectedUserId).order('created_at', { ascending: false }).limit(6),
          adminClient.from('account_deletion_requests').select('id, status, source, created_at, request_reason').eq('user_id', selectedUserId).order('created_at', { ascending: false }).limit(6),
          adminClient.from('admin_users').select('active, note, created_at').eq('user_id', selectedUserId).maybeSingle(),
        ])

        if (settingsRow.error) throw settingsRow.error
        if (folderRows.error) throw folderRows.error
        if (feedbackRows.error) throw feedbackRows.error
        if (deletionRequestRows.error) throw deletionRequestRows.error
        if (adminMembership.error && adminMembership.error.code !== 'PGRST116') throw adminMembership.error

        const folderBreakdown = { binder: 0, deck: 0, list: 0, builder_deck: 0 }
        for (const row of folderRows.data || []) {
          if (row.type in folderBreakdown) {
            folderBreakdown[row.type as keyof typeof folderBreakdown] += 1
          }
        }

        selectedUser = {
          id: selectedAuthUser.id,
          email: userEmail || 'unknown',
          created_at: selectedAuthUser.created_at,
          last_sign_in_at: selectedAuthUser.last_sign_in_at,
          app_metadata: selectedAuthUser.app_metadata || {},
          user_metadata: selectedAuthUser.user_metadata || {},
          stats: {
            cards: cardsCount,
            folders: foldersCount,
            binders: folderBreakdown.binder,
            decks: folderBreakdown.deck + folderBreakdown.builder_deck,
            lists: folderBreakdown.list,
            deck_cards: deckCardsCount,
            deck_allocations: deckAllocationsCount,
            list_items: listItemsCount,
            game_results: gameResultsCount,
            feedback_items: (feedbackRows.data || []).length,
          },
          settings: settingsRow.data || null,
          recent_folders: folderRows.data || [],
          recent_feedback: feedbackRows.data || [],
          deletion_requests: deletionRequestRows.data || [],
          admin_membership: adminMembership.data
            ? {
                active: !!adminMembership.data.active,
                note: adminMembership.data.note || '',
                created_at: adminMembership.data.created_at,
              }
            : null,
        }
      }
    }

    return json({
      ok: true,
      users,
      selected_user: selectedUser,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: 'Could not load admin user directory.', details: message }, 500)
  }
})
