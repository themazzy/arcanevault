import { useState, useEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../components/Auth'
import { ResponsiveMenu } from '../components/UI'
import uiStyles from '../components/UI.module.css'
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
  const [claimArtUrl,   setClaimArtUrl]   = useState(null)
  const [deckOpen,      setDeckOpen]      = useState(false)
  const [showArtPicker, setShowArtPicker] = useState(false)
  const [artQuery,      setArtQuery]      = useState('')
  const [artResults,    setArtResults]    = useState([])
  const [artLoading,    setArtLoading]    = useState(false)
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

  // Realtime subscription + polling fallback
  useEffect(() => {
    if (!session) return
    const sid = session.id
    let active = true

    const reloadPlayers = async () => {
      const { data } = await sb.from('game_players')
        .select('*').eq('session_id', sid).order('slot_index')
      if (active && data) setSlots(data)
    }

    const reloadSession = async () => {
      const { data } = await sb.from('game_sessions')
        .select('status').eq('id', sid).single()
      if (active && data?.status === 'playing') setStatus('started')
    }

    const ch = sb.channel(`join:${sid}`)
      // payload.new only has primary key on UPDATE (default replica identity),
      // so just re-fetch the full list on any change.
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'game_players',
      }, reloadPlayers)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'game_sessions',
      }, payload => {
        // payload.new may only have id; fall back to explicit fetch
        if (payload.new?.status === 'playing') setStatus('started')
        else reloadSession()
      })
      .subscribe()

    // Poll every 3 s as fallback for realtime gaps
    const poll = setInterval(() => { reloadPlayers(); reloadSession() }, 3000)

    return () => { active = false; sb.removeChannel(ch); clearInterval(poll) }
  }, [session?.id])

  const openClaim = slot => {
    setClaimSlot(slot)
    setClaimName(slot.player_name)
    setClaimColor(slot.color)
    setClaimDeckId(null)
    setClaimDeckName(null)
    setClaimArtUrl(null)
    setStatus('claiming')
  }

  const artTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(artTimerRef.current), [])

  const searchArt = async (q) => {
    const term = q ?? artQuery
    if (!term.trim()) return
    setArtLoading(true)
    try {
      const r = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(term)}&unique=art&order=name`)
      const data = await r.json()
      setArtResults((data.data || []).filter(c => c.image_uris?.art_crop).slice(0, 20))
    } catch { setArtResults([]) }
    setArtLoading(false)
  }

  const handleArtQueryChange = (v) => {
    setArtQuery(v)
    clearTimeout(artTimerRef.current)
    if (v.trim().length < 2) { setArtResults([]); return }
    artTimerRef.current = setTimeout(() => searchArt(v), 350)
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
      art_crop_url: claimArtUrl || null,
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
            <ResponsiveMenu
              title="Select Deck"
              align="left"
              wrapClassName={styles.claimDeckWrap}
              trigger={({ open, toggle }) => (
              <button
                className={`${styles.claimDeckBtn} ${deckOpen ? styles.claimDeckBtnOpen : ''}`}
                onClick={() => setDeckOpen(v => !v)}>
                <span className={styles.claimDeckVal}>{claimDeckName || '— No deck —'}</span>
                <span>{deckOpen ? '▲' : '▼'}</span>
              </button>
              )}
            >
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
            </ResponsiveMenu>
          </>
        )}

        <label className={styles.claimLabel}>
          Background Art <span className={styles.claimOptional}>(optional)</span>
        </label>
        <div className={styles.artPickerWrap}>
          {claimArtUrl && (
            <div className={styles.artPreviewRow}>
              <img src={claimArtUrl} className={styles.artPreviewThumb} alt="bg art" />
              <button className={styles.artClearBtn} onClick={() => setClaimArtUrl(null)}>✕</button>
            </div>
          )}
          <button className={styles.artSearchToggle} onClick={() => setShowArtPicker(v => !v)}>
            {showArtPicker ? '▲ Hide search' : '🖼 Search card art'}
          </button>
          {showArtPicker && (
            <div className={styles.artSearchBox}>
              <div className={styles.artSearchRow}>
                <input
                  className={styles.artSearchInput}
                  placeholder="Card name…"
                  value={artQuery}
                  onChange={e => handleArtQueryChange(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { clearTimeout(artTimerRef.current); searchArt() } }}
                />
                {artLoading && <span style={{ alignSelf: 'center', color: 'var(--text-faint)', fontSize: '0.88rem' }}>…</span>}
              </div>
              {artResults.length > 0 && (
                <div className={styles.artGrid}>
                  {artResults.map(c => (
                    <button key={c.id} className={`${styles.artItem} ${claimArtUrl === c.image_uris.art_crop ? styles.artItemActive : ''}`}
                      onClick={() => { setClaimArtUrl(c.image_uris.art_crop); setShowArtPicker(false) }}>
                      <img src={c.image_uris.art_crop} alt={c.name} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

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
        <p className={styles.boxSub}>You need a DeckLoom account to join a lobby.</p>
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
