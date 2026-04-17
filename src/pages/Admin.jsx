import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Modal, SectionHeader, Select as UISelect } from '../components/UI'
import { useAuth } from '../components/Auth'
import { sb } from '../lib/supabase'
import { isCurrentUserAdmin } from '../lib/admin'
import styles from './Admin.module.css'

const STATUS_OPTIONS = ['pending', 'in_review', 'completed', 'rejected']

function formatDate(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString()
}

function formatAge(ts) {
  if (!ts) return '-'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.round(diff / 60000)}m`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h`
  return `${Math.round(diff / 86400000)}d`
}

function statusClass(status) {
  if (status === 'completed') return styles.badgeCompleted
  if (status === 'rejected') return styles.badgeRejected
  if (status === 'in_review') return styles.badgeReview
  return styles.badgePending
}

function eventLabel(type) {
  if (type === 'execution_started') return 'execution started'
  if (type === 'execution_completed') return 'execution completed'
  if (type === 'execution_failed') return 'execution failed'
  if (type === 'status_changed') return 'status changed'
  return 'requested'
}

function alertClass(severity) {
  if (severity === 'danger') return styles.alertDanger
  if (severity === 'warning') return styles.alertWarning
  if (severity === 'success') return styles.alertSuccess
  return styles.alertInfo
}

async function countRows(table, queryBuilder) {
  const query = queryBuilder(
    sb.from(table).select('*', { count: 'exact', head: true })
  )
  const { count, error } = await query
  if (error) throw error
  return count || 0
}

async function loadImpactSummary(request) {
  if (!request) return null
  const userId = request.user_id || null
  const userEmail = request.user_email || null

  const summary = {
    cards: 0,
    folders: 0,
    folder_cards: 0,
    deck_cards: 0,
    deck_allocations: 0,
    list_items: 0,
    game_results: 0,
    feedback: 0,
    feedback_attachments: 0,
  }

  if (userId) {
    summary.cards = await countRows('cards', q => q.eq('user_id', userId))
    summary.folders = await countRows('folders', q => q.eq('user_id', userId))
    summary.deck_cards = await countRows('deck_cards', q => q.eq('user_id', userId))
    summary.deck_allocations = await countRows('deck_allocations', q => q.eq('user_id', userId))
    summary.list_items = await countRows('list_items', q => q.eq('user_id', userId))
    summary.game_results = await countRows('game_results', q => q.eq('user_id', userId))
  }

  if (summary.folders > 0 && userId) {
    const { data: folderIds, error: folderErr } = await sb
      .from('folders')
      .select('id')
      .eq('user_id', userId)
    if (folderErr) throw folderErr
    const ids = (folderIds || []).map(row => row.id)
    if (ids.length) {
      summary.folder_cards = await countRows('folder_cards', q => q.in('folder_id', ids))
    }
  }

  if (userId && userEmail) {
    summary.feedback = await countRows('feedback', q => q.or(`user_id.eq.${userId},user_email.eq.${userEmail}`))
    summary.feedback_attachments = await countRows('feedback_attachments', q => q.or(`user_id.eq.${userId},user_email.eq.${userEmail}`))
  } else if (userId) {
    summary.feedback = await countRows('feedback', q => q.eq('user_id', userId))
    summary.feedback_attachments = await countRows('feedback_attachments', q => q.eq('user_id', userId))
  } else if (userEmail) {
    summary.feedback = await countRows('feedback', q => q.eq('user_email', userEmail))
    summary.feedback_attachments = await countRows('feedback_attachments', q => q.eq('user_email', userEmail))
  }

  return summary
}

async function getFunctionAuthHeaders() {
  const { data, error } = await sb.auth.getSession()
  const apiKey = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (error) return apiKey ? { apikey: apiKey } : {}
  const token = data.session?.access_token
  const headers = {}
  if (apiKey) headers.apikey = apiKey
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

export default function AdminPage() {
  const { user } = useAuth()
  const [isAdmin, setIsAdmin] = useState(null)
  const [dashboard, setDashboard] = useState(null)
  const [dashboardLoading, setDashboardLoading] = useState(true)
  const [usersDirectory, setUsersDirectory] = useState([])
  const [selectedUserDetail, setSelectedUserDetail] = useState(null)
  const [usersLoading, setUsersLoading] = useState(true)
  const [userSearch, setUserSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState(null)
  const [requests, setRequests] = useState([])
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [eventsLoading, setEventsLoading] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [impactSummary, setImpactSummary] = useState(null)
  const [impactLoading, setImpactLoading] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  const loadDashboard = async () => {
    setDashboardLoading(true)
    const headers = await getFunctionAuthHeaders()
    const { data, error: invokeError } = await sb.functions.invoke('admin-dashboard-summary', {
      body: {},
      headers,
    })
    if (invokeError || data?.error) {
      setDashboard(null)
      setDashboardLoading(false)
      return
    }
    setDashboard(data)
    setDashboardLoading(false)
  }

  const loadUsers = async ({ searchTerm = userSearch, nextSelectedUserId = selectedUserId } = {}) => {
    setUsersLoading(true)
    const headers = await getFunctionAuthHeaders()
    const { data, error: invokeError } = await sb.functions.invoke('admin-users-directory', {
      body: {
        search: searchTerm,
        selected_user_id: nextSelectedUserId,
      },
      headers,
    })

    if (invokeError || data?.error) {
      setUsersDirectory([])
      setSelectedUserDetail(null)
      setUsersLoading(false)
      return
    }

    const users = data?.users || []
    setUsersDirectory(users)

    const resolvedSelectedId =
      nextSelectedUserId && users.some(entry => entry.id === nextSelectedUserId)
        ? nextSelectedUserId
        : users[0]?.id || null

      if (resolvedSelectedId !== nextSelectedUserId) {
        const { data: fallbackData, error: fallbackError } = await sb.functions.invoke('admin-users-directory', {
          body: {
            search: searchTerm,
            selected_user_id: resolvedSelectedId,
          },
          headers,
        })

      if (!fallbackError && !fallbackData?.error) {
        setUsersDirectory(fallbackData?.users || users)
        setSelectedUserId(resolvedSelectedId)
        setSelectedUserDetail(fallbackData?.selected_user || null)
      } else {
        setSelectedUserId(resolvedSelectedId)
        setSelectedUserDetail(null)
      }
    } else {
      setSelectedUserId(resolvedSelectedId)
      setSelectedUserDetail(data?.selected_user || null)
    }

    setUsersLoading(false)
  }

  const loadRequests = async () => {
    if (!user?.id) return
    setLoading(true)
    setError('')
    const admin = await isCurrentUserAdmin(user.id)
    setIsAdmin(admin)
    if (!admin) {
      setRequests([])
      setDashboard(null)
      setLoading(false)
      setDashboardLoading(false)
      return
    }

    await loadDashboard()
    await loadUsers({ searchTerm: '', nextSelectedUserId: null })

    const { data, error: reqError } = await sb
      .from('account_deletion_requests')
      .select('*')
      .order('created_at', { ascending: false })

    if (reqError) {
      setError('Could not load deletion requests.')
      setLoading(false)
      return
    }

    setRequests(data || [])
    setSelectedId(prev => prev || data?.[0]?.id || null)
    setLoading(false)
  }

  const loadEvents = async (requestId) => {
    if (!requestId || !isAdmin) {
      setEvents([])
      return
    }
    setEventsLoading(true)
    const { data, error: eventsError } = await sb
      .from('account_deletion_request_events')
      .select('*')
      .eq('request_id', requestId)
      .order('created_at', { ascending: false })

    if (eventsError) {
      setEvents([])
      setEventsLoading(false)
      return
    }

    setEvents(data || [])
    setEventsLoading(false)
  }

  useEffect(() => {
    loadRequests()
  }, [user?.id])

  useEffect(() => {
    if (!isAdmin) return
    const timeout = window.setTimeout(() => {
      loadUsers()
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [userSearch])

  const filteredRequests = useMemo(() => {
    return requests.filter((request) => {
      if (statusFilter !== 'all' && request.status !== statusFilter) return false
      if (sourceFilter !== 'all' && request.source !== sourceFilter) return false
      if (search.trim()) {
        const haystack = `${request.user_email || ''} ${request.user_id || ''} ${request.request_reason || ''}`.toLowerCase()
        if (!haystack.includes(search.trim().toLowerCase())) return false
      }
      return true
    })
  }, [requests, search, sourceFilter, statusFilter])

  const selectedRequest = useMemo(
    () => filteredRequests.find(request => request.id === selectedId) || filteredRequests[0] || null,
    [filteredRequests, selectedId]
  )

  const queueSummary = useMemo(() => {
    const byStatus = {
      pending: 0,
      in_review: 0,
      completed: 0,
      rejected: 0,
    }
    requests.forEach((request) => {
      byStatus[request.status] = (byStatus[request.status] || 0) + 1
    })
    const oldestPending = requests
      .filter(request => request.status === 'pending')
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]

    return {
      ...byStatus,
      oldestPendingAge: oldestPending ? formatAge(oldestPending.created_at) : '-',
    }
  }, [requests])

  useEffect(() => {
    setNoteDraft(selectedRequest?.admin_notes || '')
    setConfirmText('')
    setConfirmOpen(false)
  }, [selectedRequest?.id])

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!selectedRequest || !isAdmin) {
        setImpactSummary(null)
        return
      }
      setImpactLoading(true)
      try {
        const summaryData = await loadImpactSummary(selectedRequest)
        if (!cancelled) setImpactSummary(summaryData)
      } catch {
        if (!cancelled) setImpactSummary(null)
      } finally {
        if (!cancelled) setImpactLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [selectedRequest, isAdmin])

  useEffect(() => {
    loadEvents(selectedRequest?.id)
  }, [selectedRequest?.id, isAdmin])

  const updateRequest = async ({
    status = selectedRequest?.status,
    notes = noteDraft,
    processedAt = undefined,
    executionResult = undefined,
  }) => {
    if (!selectedRequest || !user?.id) return
    setSaving(true)
    setError('')
    const payload = {
      status,
      admin_notes: notes || null,
      processed_by: user.id,
    }

    if (processedAt !== undefined) {
      payload.processed_at = processedAt
    } else if (status === 'completed' || status === 'rejected') {
      payload.processed_at = new Date().toISOString()
    } else {
      payload.processed_at = null
    }

    if (executionResult !== undefined) {
      payload.execution_result = executionResult
    }

    const { error: updateError } = await sb
      .from('account_deletion_requests')
      .update(payload)
      .eq('id', selectedRequest.id)

    if (updateError) {
      setError('Could not save admin changes for this request.')
      setSaving(false)
      return
    }

    if (status !== selectedRequest.status && user?.id) {
      await sb.from('account_deletion_request_events').insert({
        request_id: selectedRequest.id,
        event_type: 'status_changed',
        actor_user_id: user.id,
        message: `Changed request status from ${selectedRequest.status} to ${status}.`,
        details: {
          from_status: selectedRequest.status,
          to_status: status,
        },
      })
    }

    await loadRequests()
    await loadEvents(selectedRequest.id)
    setSaving(false)
  }

  const executeDeletion = async () => {
    if (!selectedRequest?.id) return
    setExecuting(true)
    setError('')
    const headers = await getFunctionAuthHeaders()
    const { data, error: invokeError } = await sb.functions.invoke('admin-delete-account', {
      body: { request_id: selectedRequest.id },
      headers,
    })

    if (invokeError || data?.error) {
      setError(data?.error || 'Deletion execution failed.')
      setExecuting(false)
      await loadRequests()
      await loadEvents(selectedRequest.id)
      return
    }

    setConfirmOpen(false)
    setConfirmText('')
    await loadRequests()
    await loadEvents(selectedRequest.id)
    setExecuting(false)
  }

  const canExecuteDeletion =
    !!selectedRequest &&
    !!selectedRequest.user_id &&
    selectedRequest.status !== 'completed' &&
    !executing

  const executionSummary = selectedRequest?.execution_result?.summary || null
  const overview = dashboard?.overview || null

  if (loading) {
    return (
      <div className={styles.page}>
        <SectionHeader title="Admin" />
        <div className={styles.emptyState}>Loading admin console...</div>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className={styles.page}>
        <SectionHeader title="Admin" />
        <div className={styles.accessBox}>
          <h2 className={styles.accessTitle}>Admin access required</h2>
          <p>
            This route is restricted to users listed in <code>admin_users</code>. After you run the migration,
            add your own Supabase auth user id to that table and set <code>active = true</code>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <SectionHeader title="Admin" />

      <div className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}>Admin Home</div>
          <h1 className={styles.title}>Operations overview and deletion queue</h1>
          <p className={styles.lead}>
            Monitor top-level app health, recent user activity, support volume, and deletion operations from one place.
          </p>
        </div>
        <div className={styles.heroActions}>
          <Button size="sm" onClick={loadRequests}>Refresh</Button>
        </div>
      </div>

      {error ? <div className={styles.errorBox}>{error}</div> : null}

      <div className={styles.sectionBlock}>
        <div className={styles.sectionTitleRow}>
          <div>
            <div className={styles.sectionTitle}>Overview</div>
            <div className={styles.panelSub}>
              {dashboard?.generated_at ? `Updated ${formatDate(dashboard.generated_at)}` : 'Loading dashboard metrics'}
            </div>
          </div>
        </div>

        {dashboardLoading || !overview ? (
          <div className={styles.emptyState}>Loading overview metrics...</div>
        ) : (
          <>
            <div className={styles.summaryGrid}>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Total Users</div>
                <div className={styles.summaryValue}>{overview.total_users}</div>
                <div className={styles.summaryMeta}>Auth accounts</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Active 30d</div>
                <div className={styles.summaryValue}>{overview.active_users_30d}</div>
                <div className={styles.summaryMeta}>Recent sign-ins</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>New 7d</div>
                <div className={styles.summaryValue}>{overview.new_users_7d}</div>
                <div className={styles.summaryMeta}>Fresh signups</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Pending Deletions</div>
                <div className={styles.summaryValue}>{overview.pending_deletion_requests}</div>
                <div className={styles.summaryMeta}>Needs triage</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Feedback</div>
                <div className={styles.summaryValue}>{overview.feedback_total}</div>
                <div className={styles.summaryMeta}>
                  {overview.bug_reports} bugs, {overview.feature_requests} features
                </div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Cards</div>
                <div className={styles.summaryValue}>{overview.cards}</div>
                <div className={styles.summaryMeta}>Owned card rows</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Binders</div>
                <div className={styles.summaryValue}>{overview.binders}</div>
                <div className={styles.summaryMeta}>Collection folders</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Decks</div>
                <div className={styles.summaryValue}>{overview.decks}</div>
                <div className={styles.summaryMeta}>Deck and builder folders</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Lists</div>
                <div className={styles.summaryValue}>{overview.lists}</div>
                <div className={styles.summaryMeta}>Wishlist folders</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Price Snapshot</div>
                <div className={styles.summaryValue}>
                  {overview.latest_price_snapshot_age_days == null ? 'missing' : `${overview.latest_price_snapshot_age_days}d`}
                </div>
                <div className={styles.summaryMeta}>
                  {overview.latest_price_snapshot_date ? `Latest ${overview.latest_price_snapshot_date}` : 'No shared prices yet'}
                </div>
              </div>
            </div>

            <div className={styles.overviewGrid}>
              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div>
                    <div className={styles.panelTitle}>Health Alerts</div>
                    <div className={styles.panelSub}>Recommended admin follow-up</div>
                  </div>
                </div>
                <div className={styles.stackBody}>
                  {(dashboard.alerts || []).map((alert, idx) => (
                    <div key={`${alert.title}-${idx}`} className={`${styles.alertCard} ${alertClass(alert.severity)}`}>
                      <div className={styles.alertTitle}>{alert.title}</div>
                      <div className={styles.alertMessage}>{alert.message}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div>
                    <div className={styles.panelTitle}>Recent Signups</div>
                    <div className={styles.panelSub}>Newest users entering the app</div>
                  </div>
                </div>
                <div className={styles.stackBody}>
                  {(dashboard.recent_signups || []).length ? dashboard.recent_signups.map((signup) => (
                    <div key={signup.id} className={styles.activityItem}>
                      <div className={styles.activityTitle}>{signup.email}</div>
                      <div className={styles.activityMeta}>Joined {formatDate(signup.created_at)}</div>
                      <div className={styles.activityMeta}>
                        Last sign-in {signup.last_sign_in_at ? formatDate(signup.last_sign_in_at) : 'never'}
                      </div>
                    </div>
                  )) : <div className={styles.emptyInline}>No recent signups found.</div>}
                </div>
              </div>

              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div>
                    <div className={styles.panelTitle}>Recent Feedback</div>
                    <div className={styles.panelSub}>Latest bug reports and feature requests</div>
                  </div>
                </div>
                <div className={styles.stackBody}>
                  {(dashboard.recent_feedback || []).length ? dashboard.recent_feedback.map((item) => (
                    <div key={item.id} className={styles.activityItem}>
                      <div className={styles.activityTop}>
                        <span className={styles.badge}>{item.type}</span>
                        <span className={styles.activityMeta}>{formatDate(item.created_at)}</span>
                      </div>
                      <div className={styles.activityTitle}>{item.user_email || 'Anonymous / unknown'}</div>
                      <div className={styles.activityExcerpt}>{item.description}</div>
                    </div>
                  )) : <div className={styles.emptyInline}>No feedback found.</div>}
                </div>
              </div>

              <div className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div>
                    <div className={styles.panelTitle}>Recent Deletion Requests</div>
                    <div className={styles.panelSub}>Newest privacy/compliance actions</div>
                  </div>
                </div>
                <div className={styles.stackBody}>
                  {(dashboard.recent_deletion_requests || []).length ? dashboard.recent_deletion_requests.map((item) => (
                    <div key={item.id} className={styles.activityItem}>
                      <div className={styles.activityTop}>
                        <span className={`${styles.badge} ${statusClass(item.status)}`}>{item.status.replace('_', ' ')}</span>
                        <span className={styles.activityMeta}>{formatDate(item.created_at)}</span>
                      </div>
                      <div className={styles.activityTitle}>{item.user_email}</div>
                      <div className={styles.activityMeta}>{item.source === 'in_app_authenticated' ? 'In-app request' : 'Public request form'}</div>
                    </div>
                  )) : <div className={styles.emptyInline}>No deletion requests found.</div>}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <div className={styles.sectionBlock}>
        <div className={styles.sectionTitleRow}>
          <div>
            <div className={styles.sectionTitle}>Deletion Queue</div>
            <div className={styles.panelSub}>Review, notes, and destructive execution</div>
          </div>
        </div>

        <div className={styles.summaryGrid}>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Pending</div>
            <div className={styles.summaryValue}>{queueSummary.pending}</div>
            <div className={styles.summaryMeta}>Needs triage</div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>In Review</div>
            <div className={styles.summaryValue}>{queueSummary.in_review}</div>
            <div className={styles.summaryMeta}>Active work</div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Completed</div>
            <div className={styles.summaryValue}>{queueSummary.completed}</div>
            <div className={styles.summaryMeta}>Closed requests</div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Rejected</div>
            <div className={styles.summaryValue}>{queueSummary.rejected}</div>
            <div className={styles.summaryMeta}>Declined requests</div>
          </div>
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Oldest Pending</div>
            <div className={styles.summaryValue}>{queueSummary.oldestPendingAge}</div>
            <div className={styles.summaryMeta}>Request age</div>
          </div>
        </div>

        <div className={styles.layout}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <div className={styles.panelTitle}>Request Queue</div>
                <div className={styles.panelSub}>{filteredRequests.length} visible requests</div>
              </div>
              <div className={styles.filters}>
                <UISelect value={statusFilter} onChange={e => setStatusFilter(e.target.value)} title="Status filter">
                  <option value="all">All statuses</option>
                  {STATUS_OPTIONS.map(status => <option key={status} value={status}>{status}</option>)}
                </UISelect>
                <UISelect value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} title="Source filter">
                  <option value="all">All sources</option>
                  <option value="in_app_authenticated">In-app</option>
                  <option value="public_request_form">Public form</option>
                </UISelect>
                <Input
                  className={styles.searchInput}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search email or reason"
                />
              </div>
            </div>
            <div className={styles.requestList}>
              {filteredRequests.length === 0 ? (
                <div className={styles.emptyState}>No deletion requests match the current filters.</div>
              ) : filteredRequests.map((request) => (
                <button
                  key={request.id}
                  type="button"
                  className={`${styles.requestItem}${selectedRequest?.id === request.id ? ` ${styles.requestItemActive}` : ''}`}
                  onClick={() => setSelectedId(request.id)}
                >
                  <div className={styles.requestTop}>
                    <div className={styles.requestEmail}>{request.user_email}</div>
                    <span className={`${styles.badge} ${statusClass(request.status)}`}>{request.status.replace('_', ' ')}</span>
                  </div>
                  <div className={styles.requestReason}>
                    {request.request_reason?.trim() || 'No reason supplied.'}
                  </div>
                  <div className={styles.requestMeta}>
                    <span className={styles.badge}>{request.source === 'in_app_authenticated' ? 'in app' : 'public form'}</span>
                    <span className={styles.badge}>{formatDate(request.created_at)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <div className={styles.panelTitle}>Request Details</div>
                <div className={styles.panelSub}>
                  {selectedRequest ? `Opened ${formatDate(selectedRequest.created_at)}` : 'Select a request'}
                </div>
              </div>
            </div>

            {!selectedRequest ? (
              <div className={styles.emptyState}>Select a deletion request to review its details.</div>
            ) : (
              <div className={styles.detailBody}>
                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Identifiers</div>
                  <div className={styles.metaGrid}>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Email</div>
                      <div className={styles.metaValue}>{selectedRequest.user_email}</div>
                    </div>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>User ID</div>
                      <div className={styles.metaValue}>{selectedRequest.user_id || 'No linked account id'}</div>
                    </div>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Created</div>
                      <div className={styles.metaValue}>{formatDate(selectedRequest.created_at)}</div>
                    </div>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Updated</div>
                      <div className={styles.metaValue}>{formatDate(selectedRequest.updated_at)}</div>
                    </div>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Processed</div>
                      <div className={styles.metaValue}>{formatDate(selectedRequest.processed_at)}</div>
                    </div>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Processed By</div>
                      <div className={styles.metaValue}>{selectedRequest.processed_by || '-'}</div>
                    </div>
                  </div>
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Request</div>
                  <div className={styles.metaGrid}>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Status</div>
                      <div className={styles.metaValue}>{selectedRequest.status}</div>
                    </div>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Source</div>
                      <div className={styles.metaValue}>{selectedRequest.source}</div>
                    </div>
                  </div>
                  <div className={styles.metaCard}>
                    <div className={styles.metaLabel}>Reason</div>
                    <div className={styles.metaValue}>{selectedRequest.request_reason || 'No reason supplied.'}</div>
                  </div>
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Data Impact Summary</div>
                  {impactLoading ? (
                    <div className={styles.hint}>Loading related row counts...</div>
                  ) : impactSummary ? (
                    <div className={styles.impactGrid}>
                      {Object.entries(impactSummary).map(([key, value]) => (
                        <div key={key} className={styles.impactCard}>
                          <div className={styles.impactLabel}>{key.replace('_', ' ')}</div>
                          <div className={styles.impactValue}>{value}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.hint}>Impact summary unavailable for this request.</div>
                  )}
                </div>

                {executionSummary ? (
                  <div className={styles.detailSection}>
                    <div className={styles.detailTitle}>Last Execution Result</div>
                    <div className={styles.impactGrid}>
                      {Object.entries(executionSummary).map(([key, value]) => (
                        <div key={key} className={styles.impactCard}>
                          <div className={styles.impactLabel}>{key.replaceAll('_', ' ')}</div>
                          <div className={styles.impactValue}>{typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Timeline</div>
                  {eventsLoading ? (
                    <div className={styles.hint}>Loading events...</div>
                  ) : events.length ? (
                    <div className={styles.timeline}>
                      {events.map(event => (
                        <div key={event.id} className={styles.timelineItem}>
                          <div className={styles.timelineTop}>
                            <span className={styles.badge}>{eventLabel(event.event_type)}</span>
                            <span className={styles.timelineTime}>{formatDate(event.created_at)}</span>
                          </div>
                          <div className={styles.timelineMessage}>{event.message}</div>
                          {event.details && Object.keys(event.details).length ? (
                            <pre className={styles.timelineDetails}>{JSON.stringify(event.details, null, 2)}</pre>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.hint}>No timeline events recorded yet.</div>
                  )}
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Admin Notes</div>
                  <textarea
                    className={styles.notesArea}
                    value={noteDraft}
                    onChange={e => setNoteDraft(e.target.value)}
                    placeholder="Write review notes, contact attempts, or handling details here."
                  />
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Actions</div>
                  <div className={styles.actionRow}>
                    <Button size="sm" onClick={() => updateRequest({ status: 'pending' })} disabled={saving || executing}>Mark Pending</Button>
                    <Button size="sm" onClick={() => updateRequest({ status: 'in_review' })} disabled={saving || executing}>Mark In Review</Button>
                    <Button variant="danger" size="sm" onClick={() => updateRequest({ status: 'rejected' })} disabled={saving || executing}>Reject</Button>
                    <Button variant="secondary" size="sm" onClick={() => updateRequest({ status: selectedRequest.status })} disabled={saving || executing}>Save Notes</Button>
                    <Button variant="danger" size="sm" onClick={() => setConfirmOpen(true)} disabled={!canExecuteDeletion}>
                      {executing ? 'Deleting...' : 'Execute Deletion'}
                    </Button>
                  </div>
                  <div className={styles.hint}>
                    Execute deletion only when the request is verified. This removes the auth user and relies on database
                    cascades to clean up linked collection data. Requests without a linked <code>user_id</code> cannot be
                    executed automatically.
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={styles.sectionBlock}>
        <div className={styles.sectionTitleRow}>
          <div>
            <div className={styles.sectionTitle}>Users</div>
            <div className={styles.panelSub}>Search accounts and inspect app-level footprint</div>
          </div>
        </div>

        <div className={styles.layout}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <div className={styles.panelTitle}>User Directory</div>
                <div className={styles.panelSub}>{usersDirectory.length} visible users</div>
              </div>
              <div className={styles.filters}>
                <Input
                  className={styles.searchInput}
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  placeholder="Search email or user id"
                />
              </div>
            </div>
            <div className={styles.requestList}>
              {usersLoading ? (
                <div className={styles.emptyState}>Loading users...</div>
              ) : usersDirectory.length === 0 ? (
                <div className={styles.emptyState}>No users matched the current search.</div>
              ) : usersDirectory.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`${styles.requestItem}${selectedUserId === entry.id ? ` ${styles.requestItemActive}` : ''}`}
                  onClick={() => loadUsers({ searchTerm: userSearch, nextSelectedUserId: entry.id })}
                >
                  <div className={styles.requestTop}>
                    <div className={styles.requestEmail}>{entry.nickname ? `${entry.nickname} · ${entry.email}` : entry.email}</div>
                    {entry.deletion_status ? (
                      <span className={`${styles.badge} ${statusClass(entry.deletion_status)}`}>{entry.deletion_status.replace('_', ' ')}</span>
                    ) : null}
                  </div>
                  <div className={styles.requestMeta}>
                    <span className={styles.badge}>{entry.has_settings ? 'settings row' : 'no settings row'}</span>
                    <span className={styles.badge}>joined {formatDate(entry.created_at)}</span>
                  </div>
                  <div className={styles.requestReason}>
                    Last sign-in {entry.last_sign_in_at ? formatDate(entry.last_sign_in_at) : 'never'}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <div className={styles.panelTitle}>User Detail</div>
                <div className={styles.panelSub}>
                  {selectedUserDetail ? `Selected ${selectedUserDetail.email}` : 'Select a user'}
                </div>
              </div>
            </div>

            {!selectedUserDetail ? (
              <div className={styles.emptyState}>Select a user to inspect their app footprint and recent activity.</div>
            ) : (
              <div className={styles.detailBody}>
                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Account</div>
                  <div className={styles.metaGrid}>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Email</div>
                      <div className={styles.metaValue}>{selectedUserDetail.email}</div>
                    </div>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>User ID</div>
                      <div className={styles.metaValue}>{selectedUserDetail.id}</div>
                    </div>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Joined</div>
                      <div className={styles.metaValue}>{formatDate(selectedUserDetail.created_at)}</div>
                    </div>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Last Sign-In</div>
                      <div className={styles.metaValue}>{selectedUserDetail.last_sign_in_at ? formatDate(selectedUserDetail.last_sign_in_at) : 'Never'}</div>
                    </div>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Nickname</div>
                      <div className={styles.metaValue}>{selectedUserDetail.settings?.nickname || '-'}</div>
                    </div>
                    <div className={styles.metaCard}>
                      <div className={styles.metaLabel}>Admin Access</div>
                      <div className={styles.metaValue}>
                        {selectedUserDetail.admin_membership?.active ? 'Active admin' : 'Standard user'}
                      </div>
                    </div>
                  </div>
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Collection Summary</div>
                  <div className={styles.impactGrid}>
                    {Object.entries(selectedUserDetail.stats || {}).map(([key, value]) => (
                      <div key={key} className={styles.impactCard}>
                        <div className={styles.impactLabel}>{key.replaceAll('_', ' ')}</div>
                        <div className={styles.impactValue}>{value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Settings</div>
                  {selectedUserDetail.settings ? (
                    <pre className={styles.timelineDetails}>{JSON.stringify(selectedUserDetail.settings, null, 2)}</pre>
                  ) : (
                    <div className={styles.hint}>This user has no synced `user_settings` row yet.</div>
                  )}
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Recent Folders</div>
                  {(selectedUserDetail.recent_folders || []).length ? (
                    <div className={styles.stackBodyCompact}>
                      {selectedUserDetail.recent_folders.map((folder) => (
                        <div key={folder.id} className={styles.activityItem}>
                          <div className={styles.activityTop}>
                            <span className={styles.badge}>{folder.type.replace('_', ' ')}</span>
                            <span className={styles.activityMeta}>{formatDate(folder.created_at)}</span>
                          </div>
                          <div className={styles.activityTitle}>{folder.name}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.hint}>No folders found for this user.</div>
                  )}
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Recent Feedback</div>
                  {(selectedUserDetail.recent_feedback || []).length ? (
                    <div className={styles.stackBodyCompact}>
                      {selectedUserDetail.recent_feedback.map((item) => (
                        <div key={item.id} className={styles.activityItem}>
                          <div className={styles.activityTop}>
                            <span className={styles.badge}>{item.type}</span>
                            <span className={styles.activityMeta}>{formatDate(item.created_at)}</span>
                          </div>
                          <div className={styles.activityExcerpt}>{item.description}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.hint}>No feedback found for this user.</div>
                  )}
                </div>

                <div className={styles.detailSection}>
                  <div className={styles.detailTitle}>Deletion Requests</div>
                  {(selectedUserDetail.deletion_requests || []).length ? (
                    <div className={styles.stackBodyCompact}>
                      {selectedUserDetail.deletion_requests.map((item) => (
                        <div key={item.id} className={styles.activityItem}>
                          <div className={styles.activityTop}>
                            <span className={`${styles.badge} ${statusClass(item.status)}`}>{item.status.replace('_', ' ')}</span>
                            <span className={styles.activityMeta}>{formatDate(item.created_at)}</span>
                          </div>
                          <div className={styles.activityMeta}>{item.source === 'in_app_authenticated' ? 'In-app request' : 'Public request form'}</div>
                          <div className={styles.activityExcerpt}>{item.request_reason || 'No reason supplied.'}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.hint}>No deletion requests found for this user.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {confirmOpen && selectedRequest ? (
        <Modal onClose={() => { if (!executing) setConfirmOpen(false) }}>
          <div className={styles.confirmBox}>
            <h3 className={styles.confirmTitle}>Confirm destructive deletion</h3>
            <p className={styles.confirmBody}>
              This will delete the auth user for <strong>{selectedRequest.user_email}</strong> and cascade their app
              data. Type <code>DELETE</code> to enable execution.
            </p>
            <Input
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder="Type DELETE"
              className={styles.confirmInput}
            />
            <div className={styles.actionRow}>
              <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={executing}>Cancel</Button>
              <Button
                variant="danger"
                onClick={executeDeletion}
                disabled={executing || confirmText !== 'DELETE'}
              >
                {executing ? 'Deleting...' : 'Delete Account'}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
