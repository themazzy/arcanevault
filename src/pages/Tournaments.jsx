import { useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, Input, Select, Badge } from '../components/UI'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { sb } from '../lib/supabase'
import { getPublicAppUrl } from '../lib/publicUrl'
import {
  TOURNAMENT_FORMATS,
  TOURNAMENT_STRUCTURES,
  advanceTournament,
  computeStandings,
  createTournament,
  getCurrentRound,
  getDefaultRounds,
  getFormatById,
  getStructureById,
  isRoundComplete,
  recordDuelResult,
  recordPodResult,
  supportsStructure,
} from '../lib/tournament'
import styles from './Tournaments.module.css'

const STORAGE_KEY = 'av_tournaments_v1'
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateCode() {
  return Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
}

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { items: [], selectedId: null }
  } catch {
    return { items: [], selectedId: null }
  }
}

function saveStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

function participantFactory(seed = {}) {
  return {
    id: crypto.randomUUID(),
    name: seed.name || '',
    type: seed.type || 'guest',
    userId: seed.userId || null,
    slotId: seed.slotId || null,
  }
}

function makeParticipantList(count, baseName) {
  return Array.from({ length: count }, (_, index) => participantFactory({
    type: index === 0 ? 'app' : 'guest',
    name: index === 0 ? baseName : `Player ${index + 1}`,
  }))
}

function resizeParticipants(current, nextCount, baseName) {
  if (current.length === nextCount) return current
  if (current.length > nextCount) return current.slice(0, nextCount)
  const next = [...current]
  while (next.length < nextCount) {
    const index = next.length
    next.push(participantFactory({
      type: index === 0 ? 'app' : 'guest',
      name: index === 0 ? baseName : `Player ${index + 1}`,
    }))
  }
  return next
}

function summarizeStructure(id) {
  if (id === 'single_elimination') return 'Bracket until one winner remains.'
  if (id === 'round_robin') return 'Everyone plays everyone once.'
  return 'Standings-based rounds with rematch avoidance.'
}

function summarizeFormat(format) {
  return format.mode === 'pod'
    ? `Multiplayer pods${format.podSizes ? ` (${format.podSizes.join('/')} players)` : ''}`
    : 'Head-to-head matches'
}

function formatDate(value) {
  return new Date(value).toLocaleString()
}

function cloneTournament(value) {
  return JSON.parse(JSON.stringify(value))
}

function nextLocalId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function makeEditableMatch(kind, table, size) {
  return {
    id: nextLocalId('match'),
    table,
    kind,
    participants: Array.from({ length: size }, () => ''),
    result: null,
    completed: false,
  }
}

function applyManualAssignments(tournament, roundId, matchDrafts) {
  const next = cloneTournament(tournament)
  const round = next.rounds.find(entry => entry.id === roundId)
  if (!round) return tournament

  round.matches = matchDrafts.map((draft, index) => {
    const match = {
      ...draft,
      table: draft.kind === 'bye' ? index + 1 : index + 1,
      participants: draft.participants.filter(Boolean),
      result: null,
      completed: false,
    }
    if (match.kind === 'bye') {
      match.result = match.participants[0] ? { type: 'bye', winnerId: match.participants[0] } : null
      match.completed = !!match.participants[0]
      return match
    }
    return match
  })

  round.status = 'active'
  next.updatedAt = new Date().toISOString()
  return next
}

function SetupParticipantRow({ row, onChange, onRemove }) {
  return (
    <div className={styles.participantRow}>
      <Select value={row.type} onChange={e => onChange({ ...row, type: e.target.value })}>
        <option value="app">App player</option>
        <option value="guest">Guest</option>
      </Select>
      <Input
        value={row.name}
        onChange={e => onChange({ ...row, name: e.target.value })}
        placeholder={row.type === 'app' ? 'Player name or nickname' : 'Guest name'}
      />
      <button className={styles.removeBtn} onClick={() => onRemove(row.id)} aria-label="Remove player">
        x
      </button>
    </div>
  )
}

function DuelMatchCard({ tournament, roundId, match, participants, onSave }) {
  const [a, b] = match.participants.map(id => participants.get(id))
  if (match.kind === 'bye') {
    return (
      <div className={styles.matchCard}>
        <div className={styles.matchHeader}>
          <span>Table {match.table}</span>
          <Badge>bye</Badge>
        </div>
        <div className={styles.byeRow}>{a?.name} advances automatically.</div>
      </div>
    )
  }

  const winnerId = match.result?.winnerId || null
  return (
    <div className={styles.matchCard}>
      <div className={styles.matchHeader}>
        <span>Table {match.table}</span>
        {match.completed && <Badge variant="deck">reported</Badge>}
      </div>
      <div className={styles.vsRow}>
        {[a, b].map(player => (
          <div key={player.id} className={styles.matchPlayer}>
            <div className={styles.matchName}>{player.name}</div>
            <Button
              size="sm"
              variant={winnerId === player.id ? 'green' : 'ghost'}
              onClick={() => onSave(recordDuelResult(tournament, roundId, match.id, { type: 'win', winnerId: player.id }))}
            >
              {player.name.split(' ')[0]} wins
            </Button>
          </div>
        ))}
      </div>
      <div className={styles.matchActions}>
        <Button
          size="sm"
          variant={match.result?.type === 'draw' ? 'purple' : 'ghost'}
          onClick={() => onSave(recordDuelResult(tournament, roundId, match.id, { type: 'draw' }))}
        >
          Draw
        </Button>
      </div>
    </div>
  )
}

function PodMatchCard({ tournament, roundId, match, participants, onSave }) {
  const existing = Object.fromEntries((match.result?.placements || []).map(item => [item.participantId, String(item.placement)]))
  const [placements, setPlacements] = useState(existing)

  useEffect(() => {
    setPlacements(existing)
  }, [match.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const players = match.participants.map(id => participants.get(id)).filter(Boolean)
  const values = Object.values(placements).filter(Boolean)
  const unique = new Set(values)
  const valid = values.length === players.length && unique.size === values.length

  return (
    <div className={styles.matchCard}>
      <div className={styles.matchHeader}>
        <span>Pod {match.table}</span>
        {match.completed && <Badge variant="deck">reported</Badge>}
      </div>
      <div className={styles.podGrid}>
        {players.map(player => (
          <div key={player.id} className={styles.podPlayer}>
            <div className={styles.matchName}>{player.name}</div>
            <Select
              value={placements[player.id] || ''}
              onChange={e => setPlacements(prev => ({ ...prev, [player.id]: e.target.value }))}
            >
              <option value="">Place</option>
              {players.map((_, index) => (
                <option key={index + 1} value={index + 1}>
                  {index + 1}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </div>
      <div className={styles.matchActions}>
        <Button
          size="sm"
          disabled={!valid}
          onClick={() => {
            const payload = players.map(player => ({
              participantId: player.id,
              placement: Number(placements[player.id]),
            }))
            onSave(recordPodResult(tournament, roundId, match.id, payload))
          }}
        >
          Save pod result
        </Button>
      </div>
    </div>
  )
}

function LobbyScreen({ session, slots, onStart, onCancel }) {
  const joinUrl = getPublicAppUrl(`/join-tournament/${session.code}`)
  const openSlots = slots.filter(slot => slot.slot_kind === 'app' && !slot.user_id).length
  const readyToStart = openSlots === 0 && slots.length >= 2

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <div className={styles.sectionLabel}>Tournament lobby</div>
          <h2 className={styles.panelTitle}>{session.name}</h2>
        </div>
        <div className={styles.rosterActions}>
          <Button onClick={() => navigator.clipboard.writeText(joinUrl)}>Copy invite</Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel lobby</Button>
        </div>
      </div>

      <div className={styles.lobbyHero}>
        <div className={styles.codeBlock}>
          {session.code.split('').map((char, index) => <span key={index}>{char}</span>)}
        </div>
        <div className={styles.infoSub}>Invite link: {joinUrl}</div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Seat</th>
              <th>Type</th>
              <th>Name</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((slot, index) => (
              <tr key={slot.id}>
                <td>{index + 1}</td>
                <td>{slot.slot_kind === 'app' ? 'App' : 'Guest'}</td>
                <td>{slot.display_name || `Player ${index + 1}`}</td>
                <td>
                  {slot.slot_kind === 'guest'
                    ? 'Guest locked'
                    : slot.user_id
                      ? 'Joined'
                      : 'Waiting for join'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.footerActions}>
        <Button disabled={!readyToStart} onClick={onStart}>Start shared tournament</Button>
        {!readyToStart && <span className={styles.infoSub}>All app slots must be claimed before starting.</span>}
      </div>
    </div>
  )
}

function PairingEditor({ tournament, round, participants, onSave, onCancel }) {
  const [drafts, setDrafts] = useState(() =>
    round.matches.map(match => ({
      id: match.id,
      kind: match.kind,
      table: match.table,
      participants: [...match.participants],
    }))
  )

  const used = drafts.flatMap(match => match.participants).filter(Boolean)
  const duplicateIds = new Set(used.filter((id, index) => used.indexOf(id) !== index))
  const missingIds = tournament.participants
    .map(player => player.id)
    .filter(id => !used.includes(id))
  const incomplete = drafts.some(match => {
    if (match.kind === 'bye') return match.participants.length !== 1 || !match.participants[0]
    if (match.kind === 'duel') return match.participants.length !== 2 || match.participants.some(id => !id)
    return match.participants.length < 2 || match.participants.some(id => !id)
  })
  const valid = duplicateIds.size === 0 && missingIds.length === 0 && !incomplete

  const updateDraft = (id, updater) => setDrafts(prev => prev.map(match => match.id === id ? updater(match) : match))
  const addDraft = kind => {
    const size = kind === 'bye' ? 1 : kind === 'duel' ? 2 : Math.max(3, tournament.podSize || 4)
    setDrafts(prev => [...prev, makeEditableMatch(kind, prev.length + 1, size)])
  }
  const removeDraft = id => setDrafts(prev => prev.filter(match => match.id !== id))

  return (
    <div className={styles.editorWrap}>
      <div className={styles.panelHead}>
        <div>
          <div className={styles.sectionLabel}>Manual pairings</div>
          <h3 className={styles.panelTitle}>Edit round {round.number}</h3>
        </div>
        <div className={styles.rosterActions}>
          {tournament.mode === 'duel' && <Button size="sm" variant="ghost" onClick={() => addDraft('duel')}>Add table</Button>}
          {tournament.mode === 'pod' && <Button size="sm" variant="ghost" onClick={() => addDraft('pod')}>Add pod</Button>}
          <Button size="sm" variant="ghost" onClick={() => addDraft('bye')}>Add bye</Button>
          <Button size="sm" onClick={() => onSave(applyManualAssignments(tournament, round.id, drafts))} disabled={!valid}>
            Save assignments
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>

      {!valid && (
        <div className={styles.editorWarning}>
          {duplicateIds.size > 0 && <div>Each entrant can only appear once in the round.</div>}
          {missingIds.length > 0 && <div>Every entrant must be assigned to a table, pod, or bye.</div>}
          {incomplete && <div>Every table, pod, or bye must be fully assigned before saving.</div>}
        </div>
      )}

      <div className={styles.matchesGrid}>
        {drafts.map(match => (
          <div key={match.id} className={styles.matchCard}>
            <div className={styles.matchHeader}>
              <span>{match.kind === 'pod' ? `Pod ${match.table}` : match.kind === 'bye' ? 'Bye' : `Table ${match.table}`}</span>
              <div className={styles.rosterActions}>
                {tournament.mode === 'pod' && match.kind === 'pod' && (
                  <Select
                    value={match.participants.length}
                    onChange={e => updateDraft(match.id, prev => ({
                      ...prev,
                      participants: Array.from(
                        { length: Number(e.target.value) },
                        (_, i) => prev.participants[i] || ''
                      ),
                    }))}
                  >
                    <option value={3}>3 seats</option>
                    <option value={4}>4 seats</option>
                  </Select>
                )}
                {tournament.mode === 'duel' && (
                  <Select
                    value={match.kind}
                    onChange={e => updateDraft(match.id, prev => ({
                      ...prev,
                      kind: e.target.value,
                      participants: Array.from({ length: e.target.value === 'bye' ? 1 : 2 }, (_, i) => prev.participants[i] || ''),
                    }))}
                  >
                    <option value="duel">Table</option>
                    <option value="bye">Bye</option>
                  </Select>
                )}
                <Button size="sm" variant="ghost" onClick={() => removeDraft(match.id)}>Remove</Button>
              </div>
            </div>
            <div className={styles.editorSlots}>
              {match.participants.map((participantId, seatIndex) => (
                <Select
                  key={`${match.id}-${seatIndex}`}
                  value={participantId || ''}
                  onChange={e => updateDraft(match.id, prev => ({
                    ...prev,
                    participants: prev.participants.map((value, index) => index === seatIndex ? e.target.value : value),
                  }))}
                >
                  <option value="">Unassigned</option>
                  {tournament.participants.map(player => (
                    <option key={player.id} value={player.id}>
                      {participants.get(player.id)?.name || player.name}
                    </option>
                  ))}
                </Select>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function TournamentsPage() {
  const { user } = useAuth()
  const { nickname } = useSettings()
  const defaultName = nickname || user?.email?.split('@')[0] || 'Player 1'
  const [store, setStore] = useState(() => loadStore())
  const [showSetup, setShowSetup] = useState(() => !loadStore().items.some(item => item.status === 'active'))
  const [setupMode, setSetupMode] = useState(null)
  const [lobbySession, setLobbySession] = useState(null)
  const [lobbySlots, setLobbySlots] = useState([])
  const [editingRound, setEditingRound] = useState(false)
  const [form, setForm] = useState(() => ({
    name: '',
    formatId: 'commander',
    structureId: 'swiss',
    podSize: 4,
    matchFormat: 'bo3',
    participants: makeParticipantList(4, defaultName),
  }))

  useEffect(() => {
    saveStore(store)
  }, [store])

  useEffect(() => {
    if (!user) return
    const hosted = store.items.filter(item => item.sessionId)
    hosted.forEach(item => {
      sb.from('tournament_sessions').update({
        state: item,
        status: item.status === 'completed' ? 'completed' : 'active',
        updated_at: new Date().toISOString(),
      }).eq('id', item.sessionId).eq('host_user_id', user.id)
    })
  }, [store.items, user])

  useEffect(() => {
    if (!lobbySession) return
    let active = true

    const reload = async () => {
      const { data } = await sb.from('tournament_players')
        .select('*')
        .eq('session_id', lobbySession.id)
        .order('slot_index')
      if (active && data) setLobbySlots(data)
    }

    reload()
    const ch = sb.channel(`tournament-lobby:${lobbySession.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_players' }, reload)
      .subscribe()

    return () => {
      active = false
      sb.removeChannel(ch)
    }
  }, [lobbySession])

  const tournaments = useMemo(
    () => [...store.items].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
    [store.items]
  )

  const selectedTournament = useMemo(() => {
    return tournaments.find(item => item.id === store.selectedId)
      || tournaments.find(item => item.status === 'active')
      || tournaments[0]
      || null
  }, [tournaments, store.selectedId])

  const format = getFormatById(form.formatId)
  const structure = getStructureById(form.structureId)
  const compatibleStructures = TOURNAMENT_STRUCTURES.filter(item => item.modes.includes(format.mode))
  const entrantCount = form.participants.length
  const totalRounds = getDefaultRounds(form.structureId, entrantCount, format.mode)
  const scoringLabel = format.mode === 'pod'
    ? ((form.podSize === 3 ? [5, 2, 0] : [5, 3, 1, 0]).join('/'))
    : '3/1/0'

  function patchStore(nextItems, selectedId = store.selectedId) {
    setStore({ items: nextItems, selectedId })
  }

  function updateTournament(nextTournament) {
    const nextItems = store.items.map(item => (item.id === nextTournament.id ? nextTournament : item))
    patchStore(nextItems, nextTournament.id)
  }

  function deleteTournament(id) {
    const tournament = store.items.find(item => item.id === id)
    if (tournament?.sessionId && user) {
      sb.from('tournament_sessions').delete().eq('id', tournament.sessionId).eq('host_user_id', user.id)
    }
    const nextItems = store.items.filter(item => item.id !== id)
    const nextSelected = store.selectedId === id ? nextItems[0]?.id || null : store.selectedId
    patchStore(nextItems, nextSelected)
    if (!nextItems.some(item => item.status === 'active')) setShowSetup(true)
  }

  function handleCreate(localOnly = true, sessionInfo = null, playersOverride = null) {
    const cleanPlayers = (playersOverride || form.participants)
      .map((player, index) => ({ ...player, name: player.name.trim() || `Player ${index + 1}` }))
      .filter(player => player.name)

    if (!form.name.trim() || cleanPlayers.length < 2) return
    if (!supportsStructure(form.formatId, form.structureId)) return

    const tournament = createTournament({
      name: form.name,
      formatId: form.formatId,
      structureId: form.structureId,
      participants: cleanPlayers,
      podSize: format.mode === 'pod' ? form.podSize : 2,
      totalRounds,
      matchFormat: form.matchFormat,
      sessionId: sessionInfo?.id || null,
      joinCode: sessionInfo?.code || null,
    })

    patchStore([tournament, ...store.items], tournament.id)
    setShowSetup(false)
    setSetupMode(null)
    setLobbySession(null)
    setLobbySlots([])
    setForm(prev => ({
      ...prev,
      name: '',
      participants: makeParticipantList(getFormatById(prev.formatId).recommendedPlayers, defaultName),
    }))

    if (!localOnly && sessionInfo) {
      sb.from('tournament_sessions').update({
        status: 'active',
        state: tournament,
        updated_at: new Date().toISOString(),
      }).eq('id', sessionInfo.id)
    }
  }

  async function handleCreateLobby() {
    if (!user) return
    const cleanPlayers = form.participants
      .map((player, index) => ({ ...player, name: player.name.trim() || `Player ${index + 1}` }))
      .filter(player => player.name)
    if (!form.name.trim() || cleanPlayers.length < 2) return

    const code = generateCode()
    const { data: session, error } = await sb.from('tournament_sessions').insert({
      code,
      name: form.name.trim(),
      format_id: form.formatId,
      structure_id: form.structureId,
      mode: format.mode,
      pod_size: format.mode === 'pod' ? form.podSize : 2,
      match_format: form.matchFormat,
      total_rounds: totalRounds,
      status: 'waiting',
      host_user_id: user.id,
      updated_at: new Date().toISOString(),
    }).select().single()

    if (error || !session) return

    const rows = cleanPlayers.map((player, index) => ({
      session_id: session.id,
      slot_index: index,
      slot_kind: player.type,
      display_name: player.name,
      user_id: index === 0 && player.type === 'app' ? user.id : null,
      claimed_at: index === 0 && player.type === 'app' ? new Date().toISOString() : player.type === 'guest' ? new Date().toISOString() : null,
    }))
    await sb.from('tournament_players').insert(rows)

    const { data: freshSlots } = await sb.from('tournament_players')
      .select('*')
      .eq('session_id', session.id)
      .order('slot_index')

    setLobbySession(session)
    setLobbySlots(freshSlots || [])
    setShowSetup(false)
    setSetupMode(null)
  }

  async function handleCancelLobby() {
    if (!lobbySession || !user) return
    await sb.from('tournament_sessions').delete().eq('id', lobbySession.id).eq('host_user_id', user.id)
    setLobbySession(null)
    setLobbySlots([])
    setShowSetup(true)
    setSetupMode('shared')
  }

  async function handleStartLobby() {
    if (!lobbySession) return
    const { data: freshSlots } = await sb.from('tournament_players')
      .select('*')
      .eq('session_id', lobbySession.id)
      .order('slot_index')
    const slots = freshSlots || []
    const participants = slots.map(slot => ({
      id: crypto.randomUUID(),
      name: slot.display_name,
      type: slot.slot_kind,
      userId: slot.user_id || null,
      slotId: slot.id,
    }))
    handleCreate(false, lobbySession, participants)
  }

  const currentRound = selectedTournament ? getCurrentRound(selectedTournament) : null
  const standings = selectedTournament ? computeStandings(selectedTournament) : []
  const participantMap = useMemo(
    () => new Map((selectedTournament?.participants || []).map(player => [player.id, player])),
    [selectedTournament]
  )
  const canAdvance = selectedTournament && currentRound && isRoundComplete(currentRound) && selectedTournament.status !== 'completed'
  const canEditRound = !!currentRound && currentRound.matches.every(match => match.kind === 'bye' || !match.completed)
  const isCreating = showSetup || !!lobbySession

  useEffect(() => {
    setEditingRound(false)
  }, [selectedTournament?.id, currentRound?.id])

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div>
          <div className={styles.kicker}>Tournament Organizer</div>
          <h1 className={styles.title}>Run local or shared events with join codes</h1>
          <p className={styles.subtitle}>
            Build tournaments locally or open a shared Supabase-backed lobby so other ArcaneVault users can claim their seats before the event starts.
          </p>
        </div>
        <div className={styles.heroActions}>
          <Button onClick={() => { setShowSetup(true); setSetupMode(null); setLobbySession(null) }}>New tournament</Button>
          {isCreating && selectedTournament && (
            <Button size="sm" variant="ghost" onClick={() => { setShowSetup(false); setSetupMode(null); setLobbySession(null) }}>
              Back to current
            </Button>
          )}
        </div>
      </div>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sectionLabel}>Saved events</div>
          {tournaments.length === 0 && (
            <EmptyState>Create your first tournament to generate rounds and standings.</EmptyState>
          )}
          {tournaments.map(item => {
            const itemFormat = getFormatById(item.formatId)
            const itemStructure = getStructureById(item.structureId)
            const winner = item.winnerId ? item.participants.find(player => player.id === item.winnerId) : null
            return (
              <button
                key={item.id}
                className={`${styles.eventCard} ${selectedTournament?.id === item.id ? styles.eventCardActive : ''}`}
                onClick={() => patchStore(store.items, item.id)}
              >
                <div className={styles.eventTop}>
                  <div className={styles.eventName}>{item.name}</div>
                  <Badge variant={item.status === 'completed' ? 'foil' : 'default'}>
                    {item.status === 'completed' ? 'complete' : 'active'}
                  </Badge>
                </div>
                <div className={styles.eventMeta}>
                  {itemFormat.label} · {itemStructure.label}
                </div>
                <div className={styles.eventMeta}>
                  {item.participants.length} players · updated {formatDate(item.updatedAt)}
                </div>
                {item.joinCode && <div className={styles.eventWinner}>Code: {item.joinCode}</div>}
                {winner && <div className={styles.eventWinner}>Winner: {winner.name}</div>}
              </button>
            )
          })}
        </aside>

        <section className={styles.mainCol}>
          {showSetup && !setupMode && (
            <div className={styles.panel}>
              <div className={styles.panelHead}>
                <div>
                  <div className={styles.sectionLabel}>Step 1</div>
                  <h2 className={styles.panelTitle}>Choose tournament mode</h2>
                </div>
              </div>
              <div className={styles.choiceGrid}>
                <button className={styles.choiceCard} onClick={() => setSetupMode('local')}>
                  <div className={styles.choiceTitle}>Local tournament</div>
                  <div className={styles.choiceBody}>Run the whole event on this device with local entrants only.</div>
                </button>
                <button className={styles.choiceCard} onClick={() => setSetupMode('shared')}>
                  <div className={styles.choiceTitle}>Shared lobby</div>
                  <div className={styles.choiceBody}>Create a join code so ArcaneVault users can claim seats before the tournament starts.</div>
                </button>
              </div>
            </div>
          )}

          {showSetup && setupMode && (
            <div className={styles.panel}>
              <div className={styles.panelHead}>
                <div>
                  <div className={styles.sectionLabel}>Step 2</div>
                  <h2 className={styles.panelTitle}>Set the structure, format, and roster</h2>
                </div>
                <div className={styles.rosterActions}>
                  <Button size="sm" variant="ghost" onClick={() => setSetupMode(null)}>Back</Button>
                </div>
              </div>

              <div className={styles.formGrid}>
                <label className={styles.field}>
                  <span>Tournament name</span>
                  <Input
                    value={form.name}
                    onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="Friday Night Commander"
                  />
                </label>
              </div>

              <div className={styles.choiceGrid}>
                {TOURNAMENT_STRUCTURES.map(item => {
                  const enabled = compatibleStructures.some(entry => entry.id === item.id)
                  return (
                    <button
                      key={item.id}
                      className={`${styles.choiceCard} ${form.structureId === item.id ? styles.choiceCardActive : ''} ${!enabled ? styles.choiceCardDisabled : ''}`}
                      onClick={() => enabled && setForm(prev => ({ ...prev, structureId: item.id }))}
                    >
                      <div className={styles.choiceTitle}>{item.label}</div>
                      <div className={styles.choiceBody}>{summarizeStructure(item.id)}</div>
                    </button>
                  )
                })}
              </div>

              <div className={styles.choiceGrid}>
                {TOURNAMENT_FORMATS.map(item => (
                  <button
                    key={item.id}
                    className={`${styles.choiceCard} ${form.formatId === item.id ? styles.choiceCardActive : ''}`}
                    onClick={() => {
                      const nextCount = item.recommendedPlayers
                      setForm(prev => ({
                        ...prev,
                        formatId: item.id,
                        structureId: supportsStructure(item.id, prev.structureId) ? prev.structureId : 'swiss',
                        podSize: item.mode === 'pod' ? (item.podSizes?.[0] || 4) : 2,
                        matchFormat: item.mode === 'duel' ? prev.matchFormat : 'bo1',
                        participants: resizeParticipants(prev.participants, nextCount, defaultName),
                      }))
                    }}
                  >
                    <div className={styles.choiceTitle}>{item.label}</div>
                    <div className={styles.choiceBody}>{summarizeFormat(item)}</div>
                  </button>
                ))}
              </div>

              <div className={styles.formGrid}>
                <label className={styles.field}>
                  <span>Tournament entrants</span>
                  <Input
                    type="number"
                    value={entrantCount}
                    onChange={e => {
                      const nextCount = Math.max(2, Math.min(128, Number(e.target.value) || 2))
                      setForm(prev => ({
                        ...prev,
                        participants: resizeParticipants(prev.participants, nextCount, defaultName),
                      }))
                    }}
                    placeholder="8"
                  />
                </label>
                {format.mode === 'duel' && (
                  <label className={styles.field}>
                    <span>Match setting</span>
                    <Select value={form.matchFormat} onChange={e => setForm(prev => ({ ...prev, matchFormat: e.target.value }))}>
                      <option value="bo1">BO1</option>
                      <option value="bo3">BO3</option>
                    </Select>
                  </label>
                )}
                {format.mode === 'pod' && (
                  <label className={styles.field}>
                    <span>Preferred pod size</span>
                    <Select value={form.podSize} onChange={e => setForm(prev => ({ ...prev, podSize: Number(e.target.value) }))}>
                      {(format.podSizes || [4, 3]).map(size => (
                        <option key={size} value={size}>{size} players</option>
                      ))}
                    </Select>
                  </label>
                )}
                <div className={styles.infoCard}>
                  <div className={styles.infoLabel}>Default rounds</div>
                  <div className={styles.infoValue}>{totalRounds}</div>
                  <div className={styles.infoSub}>{structure.label} for {entrantCount} entrants</div>
                </div>
                <div className={styles.infoCard}>
                  <div className={styles.infoLabel}>Recommended players</div>
                  <div className={styles.infoValue}>{format.recommendedPlayers}</div>
                  <div className={styles.infoSub}>Applied automatically when format changes</div>
                </div>
                <div className={styles.infoCard}>
                  <div className={styles.infoLabel}>{format.mode === 'pod' ? 'Players per pod' : 'Players per match'}</div>
                  <div className={styles.infoValue}>{format.mode === 'pod' ? form.podSize : 2}</div>
                  <div className={styles.infoSub}>
                    {format.mode === 'pod' ? 'One game uses a single pod, not the whole tournament.' : 'Each match is head-to-head.'}
                  </div>
                </div>
                <div className={styles.infoCard}>
                  <div className={styles.infoLabel}>Scoring</div>
                  <div className={styles.infoValue}>{scoringLabel}</div>
                  <div className={styles.infoSub}>
                    {format.mode === 'pod' ? `Placements for ${form.podSize}-player pods` : 'Win / draw / loss'}
                  </div>
                </div>
              </div>

              <div className={styles.rosterHead}>
                <div className={styles.sectionLabel}>Roster</div>
                <div className={styles.rosterActions}>
                  <Button size="sm" variant="ghost" onClick={() => setForm(prev => ({ ...prev, participants: [...prev.participants, participantFactory()] }))}>
                    Add guest
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setForm(prev => ({
                      ...prev,
                      participants: [...prev.participants, participantFactory({ type: 'app', name: '' })],
                    }))}
                  >
                    Add app player
                  </Button>
                </div>
              </div>

              <div className={styles.participantList}>
                {form.participants.map(row => (
                  <SetupParticipantRow
                    key={row.id}
                    row={row}
                    onChange={nextRow => setForm(prev => ({
                      ...prev,
                      participants: prev.participants.map(player => player.id === nextRow.id ? nextRow : player),
                    }))}
                    onRemove={id => setForm(prev => ({
                      ...prev,
                      participants: prev.participants.filter(player => player.id !== id),
                    }))}
                  />
                ))}
              </div>

              <div className={styles.footerActions}>
                {setupMode === 'local' && (
                  <Button
                    disabled={!form.name.trim() || entrantCount < 2 || !supportsStructure(form.formatId, form.structureId)}
                    onClick={() => handleCreate(true)}
                  >
                    Start local tournament
                  </Button>
                )}
                {setupMode === 'shared' && (
                  <Button
                    disabled={!user || !form.name.trim() || entrantCount < 2}
                    onClick={handleCreateLobby}
                  >
                    Create shared lobby
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => { setShowSetup(false); setSetupMode(null) }}>Close setup</Button>
              </div>
            </div>
          )}

          {lobbySession && (
            <LobbyScreen
              session={lobbySession}
              slots={lobbySlots}
              onStart={handleStartLobby}
              onCancel={handleCancelLobby}
            />
          )}

          {!isCreating && selectedTournament && (
            <>
              <div className={styles.summaryGrid}>
                <div className={styles.summaryCard}>
                  <div className={styles.infoLabel}>Format</div>
                  <div className={styles.summaryValue}>{getFormatById(selectedTournament.formatId).label}</div>
                  <div className={styles.infoSub}>
                    {getStructureById(selectedTournament.structureId).label}
                    {selectedTournament.mode === 'duel' ? ` · ${selectedTournament.matchFormat?.toUpperCase?.() || 'BO1'}` : ''}
                  </div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.infoLabel}>Players</div>
                  <div className={styles.summaryValue}>{selectedTournament.participants.length}</div>
                  <div className={styles.infoSub}>
                    {selectedTournament.mode === 'pod' ? `Pods of ${selectedTournament.podSize}` : 'Head-to-head'}
                  </div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.infoLabel}>Round</div>
                  <div className={styles.summaryValue}>
                    {currentRound?.number || selectedTournament.rounds.length} / {selectedTournament.totalRounds}
                  </div>
                  <div className={styles.infoSub}>
                    {selectedTournament.joinCode ? `Shared code ${selectedTournament.joinCode}` : 'Local event'}
                  </div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.infoLabel}>Leader</div>
                  <div className={styles.summaryValue}>{standings[0]?.name || '-'}</div>
                  <div className={styles.infoSub}>{standings[0] ? `${standings[0].points} pts` : 'No results yet'}</div>
                </div>
              </div>

              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <div>
                    <div className={styles.sectionLabel}>Current round</div>
                    <h2 className={styles.panelTitle}>{selectedTournament.name}</h2>
                  </div>
                  <div className={styles.rosterActions}>
                    {canEditRound && (
                      <Button size="sm" variant="ghost" onClick={() => setEditingRound(v => !v)}>
                        {editingRound ? 'Close editor' : 'Edit pairings'}
                      </Button>
                    )}
                    {canAdvance && (
                      <Button onClick={() => updateTournament(advanceTournament(selectedTournament))}>
                        {selectedTournament.rounds.length >= selectedTournament.totalRounds || selectedTournament.structureId === 'single_elimination'
                          ? 'Finish / advance'
                          : 'Generate next round'}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => deleteTournament(selectedTournament.id)}>Delete</Button>
                  </div>
                </div>

                {editingRound && currentRound && (
                  <PairingEditor
                    tournament={selectedTournament}
                    round={currentRound}
                    participants={participantMap}
                    onSave={nextTournament => {
                      updateTournament(nextTournament)
                      setEditingRound(false)
                    }}
                    onCancel={() => setEditingRound(false)}
                  />
                )}

                {!currentRound && <EmptyState>No rounds available.</EmptyState>}
                {currentRound && (
                  <div className={styles.matchesGrid}>
                    {currentRound.matches.map(match => (
                      selectedTournament.mode === 'pod'
                        ? (
                          <PodMatchCard
                            key={match.id}
                            tournament={selectedTournament}
                            roundId={currentRound.id}
                            match={match}
                            participants={participantMap}
                            onSave={updateTournament}
                          />
                        )
                        : (
                          <DuelMatchCard
                            key={match.id}
                            tournament={selectedTournament}
                            roundId={currentRound.id}
                            match={match}
                            participants={participantMap}
                            onSave={updateTournament}
                          />
                        )
                    ))}
                  </div>
                )}
              </div>

              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <div>
                    <div className={styles.sectionLabel}>Standings</div>
                    <h2 className={styles.panelTitle}>Live table</h2>
                  </div>
                </div>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Player</th>
                        <th>Type</th>
                        <th>Pts</th>
                        <th>W</th>
                        <th>L</th>
                        <th>D</th>
                        <th>Byes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {standings.map(row => (
                        <tr key={row.participantId}>
                          <td>{row.rank}</td>
                          <td>{row.name}</td>
                          <td>{row.type === 'app' ? 'App' : 'Guest'}</td>
                          <td>{row.points}</td>
                          <td>{row.wins}</td>
                          <td>{row.losses}</td>
                          <td>{row.draws}</td>
                          <td>{row.byes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {!selectedTournament && !isCreating && (
            <EmptyState>No tournament selected.</EmptyState>
          )}
        </section>
      </div>
    </div>
  )
}
