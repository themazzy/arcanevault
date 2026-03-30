import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, Input } from '../components/UI'
import { useAuth } from '../components/Auth'
import { sb } from '../lib/supabase'
import { getCurrentRound, getFormatById } from '../lib/tournament'
import styles from './JoinTournament.module.css'

export default function JoinTournamentPage() {
  const { code } = useParams()
  const { user } = useAuth()

  const [session, setSession] = useState(null)
  const [slots, setSlots] = useState([])
  const [status, setStatus] = useState('loading')
  const [claimSlot, setClaimSlot] = useState(null)
  const [claimName, setClaimName] = useState('')
  const [activeState, setActiveState] = useState(null)

  useEffect(() => {
    if (!code) return
    ;(async () => {
      const { data } = await sb.from('tournament_sessions')
        .select('*')
        .eq('code', code.toUpperCase())
        .single()
      if (!data || data.status === 'cancelled') {
        setStatus('notfound')
        return
      }
      if (data.status === 'active' || data.status === 'completed') {
        setSession(data)
        setActiveState(data.state || null)
        setStatus('started')
        return
      }
      setSession(data)
      const { data: slotData } = await sb.from('tournament_players')
        .select('*')
        .eq('session_id', data.id)
        .order('slot_index')
      setSlots(slotData || [])
      setStatus('lobby')
    })()
  }, [code])

  useEffect(() => {
    if (!session) return
    let active = true

    const reload = async () => {
      const { data: slotData } = await sb.from('tournament_players')
        .select('*')
        .eq('session_id', session.id)
        .order('slot_index')
      const { data: freshSession } = await sb.from('tournament_sessions')
        .select('status,state')
        .eq('id', session.id)
        .single()
      if (!active) return
      if (slotData) setSlots(slotData)
      if (freshSession?.status === 'active' || freshSession?.status === 'completed') {
        setActiveState(freshSession.state || null)
        setStatus('started')
      }
    }

    const ch = sb.channel(`join-tournament:${session.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_players' }, reload)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tournament_sessions' }, reload)
      .subscribe()

    return () => {
      active = false
      sb.removeChannel(ch)
    }
  }, [session])

  const mySlot = user ? slots.find(slot => slot.user_id === user.id) : null

  const myAssignment = (() => {
    if (!user || !activeState) return null
    const round = getCurrentRound(activeState)
    if (!round) return null
    const me = activeState.participants?.find(player => player.userId === user.id)
    if (!me) return null
    const match = round.matches?.find(entry => entry.participants?.includes(me.id))
    if (!match) return null
    const names = match.participants
      .map(id => activeState.participants?.find(player => player.id === id)?.name)
      .filter(Boolean)
    return {
      round: round.number,
      table: match.table,
      kind: match.kind,
      names,
    }
  })()

  async function submitClaim() {
    if (!user || !claimSlot) return
    const { error } = await sb.from('tournament_players').update({
      user_id: user.id,
      display_name: claimName.trim() || claimSlot.display_name,
      claimed_at: new Date().toISOString(),
    }).eq('id', claimSlot.id).is('user_id', null)

    if (!error) {
      setClaimSlot(null)
      setClaimName('')
    }
  }

  if (status === 'loading') {
    return <div className={styles.page}><div className={styles.card}>Loading tournament lobby…</div></div>
  }

  if (status === 'notfound') {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.title}>Lobby not found</h1>
          <p className={styles.sub}>The code {code?.toUpperCase()} does not match an open tournament lobby.</p>
          <Link to="/tournaments" className={styles.backLink}>Back to tournaments</Link>
        </div>
      </div>
    )
  }

  if (status === 'started') {
    const fmt = getFormatById(activeState?.formatId || session?.format_id || 'commander')
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.title}>Tournament started</h1>
          <p className={styles.sub}>{session?.name} is now active.</p>
          {activeState && (
            <div className={styles.startedBox}>
              <div className={styles.startedRow}>Format: {fmt.label}</div>
              <div className={styles.startedRow}>Round: {getCurrentRound(activeState)?.number || activeState.rounds?.length || 1}</div>
              {myAssignment
                ? (
                  <>
                    <div className={styles.startedAssign}>
                      {myAssignment.kind === 'pod' ? `Pod ${myAssignment.table}` : `Table ${myAssignment.table}`}
                    </div>
                    <div className={styles.startedNames}>{myAssignment.names.join(' · ')}</div>
                  </>
                )
                : <div className={styles.startedNames}>You are not assigned to the current round.</div>}
            </div>
          )}
          <Link to="/tournaments" className={styles.backLink}>Back to tournaments</Link>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.kicker}>Join tournament</div>
        <h1 className={styles.title}>{session?.name}</h1>
        <p className={styles.sub}>Code {session?.code} · waiting for all app seats to be claimed.</p>

        <div className={styles.slotList}>
          {slots.map((slot, index) => {
            const claimable = slot.slot_kind === 'app' && !slot.user_id && !mySlot
            return (
              <div key={slot.id} className={styles.slotRow}>
                <div>
                  <div className={styles.slotName}>Seat {index + 1}: {slot.display_name || `Player ${index + 1}`}</div>
                  <div className={styles.slotMeta}>
                    {slot.slot_kind === 'guest'
                      ? 'Guest seat'
                      : slot.user_id
                        ? 'Claimed'
                        : 'Open app seat'}
                  </div>
                </div>
                {claimable && (
                  <Button size="sm" onClick={() => { setClaimSlot(slot); setClaimName(slot.display_name || '') }}>
                    Claim
                  </Button>
                )}
                {!claimable && slot.user_id === user?.id && <span className={styles.mine}>You</span>}
              </div>
            )
          })}
        </div>

        {claimSlot && (
          <div className={styles.claimBox}>
            <div className={styles.claimTitle}>Claim seat</div>
            <Input value={claimName} onChange={e => setClaimName(e.target.value)} placeholder="Your display name" />
            <div className={styles.claimActions}>
              <Button size="sm" onClick={submitClaim}>Join tournament</Button>
              <Button size="sm" variant="ghost" onClick={() => setClaimSlot(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
