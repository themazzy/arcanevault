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

function errorResponse(message: string, status = 400, details?: unknown) {
  return json({ error: message, details: details ?? null }, status)
}

async function insertEvent(
  adminClient: any,
  requestId: string,
  eventType: 'execution_started' | 'execution_completed' | 'execution_failed',
  actorUserId: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  await adminClient.from('account_deletion_request_events').insert({
    request_id: requestId,
    event_type: eventType,
    actor_user_id: actorUserId,
    message,
    details,
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405)
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return errorResponse('Supabase function environment is incomplete.', 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return errorResponse('Missing authorization header.', 401)
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const body = await req.json().catch(() => null)

  try {
    const { data: actorData, error: actorError } = await userClient.auth.getUser()
    if (actorError || !actorData.user) {
      return errorResponse('Could not verify the current admin user.', 401, actorError?.message)
    }

    const actorUserId = actorData.user.id

    const { data: adminRow, error: adminError } = await adminClient
      .from('admin_users')
      .select('user_id')
      .eq('user_id', actorUserId)
      .eq('active', true)
      .maybeSingle()

    if (adminError || !adminRow) {
      return errorResponse('Admin access required.', 403, adminError?.message)
    }

    const requestId = typeof body?.request_id === 'string' ? body.request_id : ''
    if (!requestId) {
      return errorResponse('request_id is required.')
    }

    const { data: requestRow, error: requestError } = await adminClient
      .from('account_deletion_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle()

    if (requestError || !requestRow) {
      return errorResponse('Deletion request not found.', 404, requestError?.message)
    }

    if (requestRow.status === 'completed') {
      return errorResponse('This deletion request is already completed.', 409)
    }

    if (!requestRow.user_id) {
      return errorResponse('This request no longer has a linked auth user id and cannot be executed automatically.', 409)
    }

    const targetUserId = requestRow.user_id as string
    const targetEmail = requestRow.user_email as string
    const startedAt = new Date().toISOString()

    await adminClient
      .from('account_deletion_requests')
      .update({
        status: 'in_review',
        processed_by: actorUserId,
        processed_at: null,
        execution_result: {
          phase: 'started',
          started_at: startedAt,
        },
      })
      .eq('id', requestId)

    await insertEvent(
      adminClient,
      requestId,
      'execution_started',
      actorUserId,
      'Started destructive account deletion.',
      { target_user_id: targetUserId, target_email: targetEmail },
    )

    const summary = {
      deleted_feedback_attachments: 0,
      deleted_feedback: 0,
      deleted_auth_user: false,
    }

    if (targetEmail) {
      const { data: attachmentRows, error: attachmentSelectError } = await adminClient
        .from('feedback_attachments')
        .select('id')
        .or(`user_id.eq.${targetUserId},user_email.eq.${targetEmail}`)

      if (attachmentSelectError) throw attachmentSelectError
      const attachmentIds = (attachmentRows || []).map((row: { id: string }) => row.id)
      if (attachmentIds.length) {
        const { error: attachmentDeleteError } = await adminClient
          .from('feedback_attachments')
          .delete()
          .in('id', attachmentIds)
        if (attachmentDeleteError) throw attachmentDeleteError
        summary.deleted_feedback_attachments = attachmentIds.length
      }

      const { data: feedbackRows, error: feedbackSelectError } = await adminClient
        .from('feedback')
        .select('id')
        .or(`user_id.eq.${targetUserId},user_email.eq.${targetEmail}`)

      if (feedbackSelectError) throw feedbackSelectError
      const feedbackIds = (feedbackRows || []).map((row: { id: string }) => row.id)
      if (feedbackIds.length) {
        const { error: feedbackDeleteError } = await adminClient
          .from('feedback')
          .delete()
          .in('id', feedbackIds)
        if (feedbackDeleteError) throw feedbackDeleteError
        summary.deleted_feedback = feedbackIds.length
      }
    }

    const { error: deleteUserError } = await adminClient.auth.admin.deleteUser(targetUserId)
    if (deleteUserError) throw deleteUserError
    summary.deleted_auth_user = true

    const completedAt = new Date().toISOString()
    const executionResult = {
      phase: 'completed',
      started_at: startedAt,
      completed_at: completedAt,
      summary,
    }

    const { error: finalizeError } = await adminClient
      .from('account_deletion_requests')
      .update({
        status: 'completed',
        processed_by: actorUserId,
        processed_at: completedAt,
        execution_result: executionResult,
      })
      .eq('id', requestId)

    if (finalizeError) throw finalizeError

    await insertEvent(
      adminClient,
      requestId,
      'execution_completed',
      actorUserId,
      'Completed destructive account deletion.',
      executionResult,
    )

    return json({ ok: true, request_id: requestId, execution_result: executionResult })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    try {
      const requestId = typeof body?.request_id === 'string' ? body.request_id : ''
      const { data: actorData } = await userClient.auth.getUser()
      const actorUserId = actorData.user?.id

      if (requestId && actorUserId) {
        const failedAt = new Date().toISOString()
        const executionResult = {
          phase: 'failed',
          failed_at: failedAt,
          error: message,
        }

        await adminClient
          .from('account_deletion_requests')
          .update({
            status: 'in_review',
            processed_by: actorUserId,
            processed_at: null,
            execution_result: executionResult,
          })
          .eq('id', requestId)

        await insertEvent(
          adminClient,
          requestId,
          'execution_failed',
          actorUserId,
          'Deletion execution failed.',
          executionResult,
        )
      }
    } catch {
      // Best-effort failure logging only.
    }

    return errorResponse('Deletion execution failed.', 500, message)
  }
})
