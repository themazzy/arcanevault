import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../components/Auth'
import { sb } from '../lib/supabase'
import styles from './JoinGame.module.css'

const PLAYER_COLORS = ['#c46060', '#6080c4', '#60a860', '#c4a040', '#9060c4', '#60b8c4']
const MODE_LABELS = {
  standard: 'Standard', commander: 'Commander', brawl: 'Brawl',
  oathbreaker: 'Oathbreaker', planechase: 'Planechase', custom: 'Custom',
}

export default function JoinGamePage() {
  const { code } = useParams()
  const { user }  = useAuth()

  const [session,       setSession]       = useState(null)
  const [slots,         setSlots]         = useState([])
  const [decks,         setDecks]         = useState([])
  const [status,        setStatus]        = useState('loading')
  // loading | lobby | claiming | waiting | started | notfound
  const [mySlotId,      setMySlotId]      = useState(null)
  const [claimSlot,     setClaimSlot]     = useState(null)
  const [claimName,     setClaimName]     = useState('')
  const [claimColor,    setClaimColor]    = useState(PLAYER_COLORS[0])
  const [claimDeckId,   setClaimDeckId]   = useState(null)
  const [claimDeckName, setClaimDeckName] = useState(null)
  const [deckOpen,      setDeckOpen]      = useState(false)
  const [submitting,    setSubmitting]    = useState(false)
  const deckRef = useRef(null)

  // Close deck dropdown on outside click
  useEffect(() => {
    if (!deckOpen) return
    const h = e => { if (!deckRef.current?.contains(e.target)) setDeckOpen(false) }
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [deckOpen])

  // Load session once on mount
  useEffect(() => {
    if (!code) { setStatus('notfound'); return }
    ;(async () => {
      const { data, error } = await sb
        .from('game_sessions')
        .select('*')
        .eq('code', code.toUpperCase())
        .single()
      if (error || !data) { setStatus('notfound'); return }
      if (data.status === 'playing') { setStatus('started'); return }
      if (data.status === 'ended')   { setStatus('notfound'); return }
      setSession(data)

      const { data: slotsData } = await sb
        .from('game_players')
        .select('*')
        .eq('session_id', data.id)
        .order('slot_index')
      setSlots(slotsData || [])
      setStatus('lobby')
    })()
  }, [code])

  // When user logs in, check if they already have a slot
  useEffect(() => {
    if (!user || !slots.length) return
    const mine = slots.find(s => s.user_id === user.id)
    if (mine) { setMySlotId(mine.id); setStatus('waiting') }
  }, [user, slots])

  // Load user's decks
  useEffect(() => {
    if (!user) return
    sb.from('folders').select('id,name,type')
      .eq('user_id', user.id)
      .in('type', ['deck', 'builder_deck'])
      .order('name')
      .then(({ data }) => setDecks(data || []))
  }, [user])

  // Realtime subscription
  useEffect(() => {
    if (!session) return
    const sid = session.id
    const ch = sb.channel(`join:${sid}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'game_players',
        filter: `session_id=eq.${sid}`,
      }, async () => {
        const { data } = await sb.from('game_players')
          .select('*').eq('session_id', sid).order('slot_index')
        if (data) setSlots(data)
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'game_sessions',
        filter: `id=eq.${sid}`,
      }, payload => {
        if (payload.new.status === 'playing') setStatus('started')
      })
      .subscribe()
    return () => sb.removeChannel(ch)
  }, [session?.id])

  const openClaim = slot => {
    setClaimSlot(slot)
    setClaimName(slot.player_name)
    setClaimColor(slot.color)
    setClaimDeckId(null)
    setClaimDeckName(null)
    setStatus('claiming')
  }

  const submitClaim = async () => {
    if (!user || !claimSlot) return
    setSubmitting(true)
    const { error } = await sb.from('game_players').update({
      user_id: user.id,
      player_name: claimName.trim() || claimSlot.player_name,
      color: claimColor,
      deck_id: claimDeckId,
      deck_name: claimDeckName,
      claimed_at: new Date().toISOString(),
    }).eq('id', claimSlot.id).is('user_id', null)

    if (error) {
      // Slot was taken by someone else — reload and go back to lobby
      const { data } = await sb.from('game_players')
        .select('*').eq('session_id', session.id).order('slot_index')
      if (data) setSlots(data)
      setStatus('lobby')
    } else {
      setMySlotId(claimSlot.id)
      setStatus('waiting')
    }
    setSubmitting(false)
    setClaimSlot(null)
  }

  // ── Screens ────────────────────────────────────────────────────────────────

  if (status === 'loading') return (
    <div className={styles.page}>
      <div className={styles.centerBox}>
        <div className={styles.spinner}>⟳</div>
        <p className={styles.loadingText}>Looking up lobby…</p>
      </div>
    </div>
  )

  if (status === 'notfound') return (
    <div className={styles.page}>
      <div className={styles.centerBox}>
        <div className={styles.bigIcon}>⚠</div>
        <h2 className={styles.boxTitle}>Lobby Not Found</h2>
        <p className={styles.boxSub}>
          The code <strong>{code?.toUpperCase()}</strong> didn't match any open lobby.
        </p>
        <Link to="/life" className={styles.backLink}>← Back to Life Tracker</Link>
      </div>
    </div>
  )

  if (status === 'started') return (
    <div className={styles.page}>
      <div className={styles.centerBox}>
        <div className={styles.bigIcon}>⚔</div>
        <h2 className={styles.boxTitle}>Game Has Started</h2>
        <p className={styles.boxSub}>The host started the game on the shared device.</p>
        <Link to="/life" className={styles.backLink}>← Life Tracker</Link>
      </div>
    </div>
  )

  if (status === 'waiting') return (
    <div className={styles.page}>
      <div className={styles.waitBox}>
        <div className={styles.waitIcon}>⏳</div>
        <h2 className={styles.boxTitle}>You're In!</h2>
        <p className={styles.boxSub}>Waiting for the host to start the game…</p>
        <div className={styles.waitSlots}>
          {slots.map(s => (
            <div key={s.id}
              className={`${styles.waitSlot} ${s.user_id ? styles.waitSlotFilled : ''} ${s.id === mySlotId ? styles.waitSlotMine : ''}`}
              style={{ '--pc': s.color }}>
              <span className={styles.waitSlotDot} style={{ background: s.color }} />
              <span className={styles.waitSlotName}>{s.player_name}</span>
              {s.deck_name && <span className={styles.waitSlotDeck}>{s.deck_name}</span>}
              <span className={styles.waitSlotStatus}>
                {s.user_id ? '✓' : '…'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  if (status === 'claiming') return (
    <div className={styles.page}>
      <div className={styles.claimBox}>
        <button className={styles.claimBack} onClick={() => setStatus('lobby')}>←</button>
        <h2 className={styles.claimTitle}>Join as Player {(claimSlot?.slot_index ?? 0) + 1}</h2>

        <label className={styles.claimLabel}>Your Name</label>
        <input className={styles.claimInput}
          value={claimName}
          onChange={e => setClaimName(e.target.value)}
          maxLength={24}
          autoFocus />

        <label className={styles.claimLabel}>Color</label>
        <div className={styles.claimColors}>
          {PLAYER_COLORS.map(c => (
            <button key={c}
              className={`${styles.claimColorDot} ${claimColor === c ? styles.claimColorActive : ''}`}
              style={{ background: c }}
              onClick={() => setClaimColor(c)} />
          ))}
        </div>

        {decks.length > 0 && (
          <>
            <label className={styles.claimLabel}>
              Deck <span className={styles.claimOptional}>(optional)</span>
            </label>
            <div className={styles.claimDeckWrap} ref={deckRef}>
              <button
                className={`${styles.claimDeckBtn} ${deckOpen ? styles.claimDeckBtnOpen : ''}`}
                onClick={() => setDeckOpen(v => !v)}>
                <span className={styles.claimDeckVal}>{claimDeckName || '— No deck —'}</span>
                <span>{deckOpen ? '▲' : '▼'}</span>
              </button>
              {deckOpen && (
                <div className={styles.claimDeckMenu}>
                  <button className={styles.claimDeckItem}
                    onClick={() => { setClaimDeckId(null); setClaimDeckName(null); setDeckOpen(false) }}>
                    — No deck —
                  </button>
                  {decks.map(d => (
                    <button key={d.id}
                      className={`${styles.claimDeckItem} ${claimDeckId === d.id ? styles.claimDeckItemActive : ''}`}
                      onClick={() => { setClaimDeckId(d.id); setClaimDeckName(d.name); setDeckOpen(false) }}>
                      <span>{d.name}</span>
                      {d.type === 'builder_deck' && <span className={styles.claimDeckBadge}>builder</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div className={styles.claimActions}>
          <button className={styles.claimCancelBtn} onClick={() => setStatus('lobby')}>Back</button>
          <button className={styles.claimConfirmBtn} onClick={submitClaim} disabled={submitting || !claimName.trim()}>
            {submitting ? 'Joining…' : 'Confirm →'}
          </button>
        </div>
      </div>
    </div>
  )

  // ── Lobby view (status === 'lobby') ────────────────────────────────────────
  if (!user) return (
    <div className={styles.page}>
      <div className={styles.centerBox}>
        <div className={styles.bigIcon}>🔐</div>
        <h2 className={styles.boxTitle}>Log In to Join</h2>
        <p className={styles.boxSub}>You need an ArcaneVault account to join a lobby.</p>
        <Link to="/login" className={styles.loginLink}>Log In →</Link>
      </div>
    </div>
  )

  return (
    <div className={styles.page}>
      <div className={styles.lobbyView}>
        <div className={styles.lobbyHeader}>
          <Link to="/life" className={styles.lobbyBack}>← Life Tracker</Link>
          <div className={styles.lobbyMeta}>
            <span className={styles.lobbyMetaMode}>{MODE_LABELS[session.mode] || session.mode}</span>
            <span className={styles.lobbyMetaPlayers}>{session.player_count} players</span>
          </div>
        </div>

        <div className={styles.lobbyHero}>
          <span className={styles.lobbyHeroGlyph}>♥</span>
          <h1 className={styles.lobbyTitle}>Pick Your Seat</h1>
          <p className={styles.lobbySub}>Tap an open seat to join the game</p>
        </div>

        <div className={styles.lobbySlots}>
          {slots.map(s => {
            const isMine  = s.user_id === user?.id
            const isTaken = s.user_id && !isMine
            const canClaim = !isTaken && !mySlotId
            return (
              <button key={s.id}
                className={`${styles.lobbySlot}
                  ${isTaken  ? styles.lobbySlotTaken  : ''}
                  ${isMine   ? styles.lobbySlotMine   : ''}
                  ${canClaim ? styles.lobbySlotOpen   : ''}`}
                style={{ '--pc': s.color }}
                onClick={() => canClaim && openClaim(s)}
                disabled={!canClaim}>
                <span className={styles.lobbySlotDot} style={{ background: s.color }} />
                <div className={styles.lobbySlotInfo}>
                  <div className={styles.lobbySlotName}>{s.player_name}</div>
                  <div className={styles.lobbySlotSub}>
                    {isMine   ? '✓ You'       :
                     isTaken  ? 'Taken'        :
                     s.deck_name ? `🃏 ${s.deck_name}` : 'Tap to claim'}
                  </div>
                </div>
                {canClaim && <span className={styles.lobbySlotArrow}>→</span>}
                {(isMine || isTaken) && <span className={styles.lobbySlotCheck}>✓</span>}
              </button>
            )
          })}
        </div>

        {mySlotId && (
          <p className={styles.lobbyWaiting}>
            ✓ You've joined! Waiting for the host to start…
          </p>
        )}
      </div>
    </div>
  )
}
