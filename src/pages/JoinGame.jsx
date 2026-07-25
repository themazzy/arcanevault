import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, ErrorBox, Select } from '../components/UI'
import { useAuth } from '../components/Auth'
import { CheckIcon, PlayerIcon, SyncIcon } from '../icons'
import { sb } from '../lib/supabase'
import { LIFE_FORMATS, PLAYER_COLORS } from '../lib/lifeGame'
import { loadDeckOptions } from '../lib/deckOptions'
import ArtPicker from '../components/lifeTracker/ArtPicker'
import styles from './JoinGame.module.css'

// Guest side of a shared game.
//
// Joining does not put a life tracker on your phone: life is tracked on the one
// device in the middle of the table. You join so the result of this game is saved
// against your deck, on your account. That is the whole feature, and this page now
// says so instead of parking guests on a "waiting for the host…" screen that never
// changed.
//
// This route is public and lives outside SettingsProvider, so nothing here may call
// useSettings.

const NO_DECK = '__none__'
const POLL_MS = 5000

export default function JoinGamePage() {
  const { code } = useParams()
  const { user } = useAuth()

  const [session, setSession] = useState(null)
  const [slots, setSlots] = useState([])
  const [status, setStatus] = useState('loading') // loading | notfound | roster
  const [claiming, setClaiming] = useState(null)  // the slot being filled in
  const [draftName, setDraftName] = useState('')
  const [draftColor, setDraftColor] = useState(PLAYER_COLORS[0])
  const [draftDeck, setDraftDeck] = useState(NO_DECK)
  const [draftArt, setDraftArt] = useState(null)
  const [showArt, setShowArt] = useState(false)
  const [decks, setDecks] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const codeUpper = code?.toUpperCase() || ''
  const mine = slots.find(s => s.user_id && s.user_id === user?.id) || null

  const load = useCallback(async () => {
    if (!codeUpper) { setStatus('notfound'); return }
    const { data, error: rpcError } = await sb.rpc('get_game_by_code', { p_code: codeUpper })
    if (rpcError || !data?.session) { setStatus('notfound'); return }
    setSession(data.session)
    setSlots(data.players || [])
    setStatus('roster')
  }, [codeUpper])

  useEffect(() => { load() }, [load])

  // Realtime plus a slow poll. The poll matters more here than on the host: an
  // anonymous visitor's realtime channel delivers nothing until they sign in.
  // `load` is stable for the lifetime of a code, so it can be a plain dependency.
  const sessionId = session?.id
  useEffect(() => {
    if (!sessionId) return
    const channel = sb.channel(`life-join:${sessionId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'game_players',
        filter: `session_id=eq.${sessionId}`,
      }, load)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'game_sessions',
      }, load)
      .subscribe()
    const poll = setInterval(load, POLL_MS)
    return () => { sb.removeChannel(channel); clearInterval(poll) }
  }, [sessionId, load])

  useEffect(() => {
    if (!user) return
    let active = true
    loadDeckOptions(user.id).then(options => { if (active) setDecks(options) })
    return () => { active = false }
  }, [user])

  const openClaim = (slot) => {
    setClaiming(slot)
    setDraftName(user?.email?.split('@')[0]?.slice(0, 24) || slot.player_name)
    setDraftColor(slot.color)
    setDraftDeck(NO_DECK)
    setDraftArt(null)
    setShowArt(false)
    setError('')
  }

  const submitClaim = async () => {
    if (!user || !claiming) return
    setBusy(true)
    setError('')
    const deck = draftDeck === NO_DECK ? null : decks.find(d => d.id === draftDeck)

    // `.is('user_id', null)` is the race guard: two people tapping the same open
    // seat at once means the second update matches no rows.
    const { data, error: updateError } = await sb.from('game_players').update({
      user_id: user.id,
      player_name: draftName.trim() || claiming.player_name,
      color: draftColor,
      deck_id: deck?.id || null,
      deck_name: deck?.name || null,
      art_crop_url: draftArt || null,
      claimed_at: new Date().toISOString(),
    }).eq('id', claiming.id).is('user_id', null).select('id')

    setBusy(false)
    if (updateError || !data?.length) {
      setError('Someone just took that seat. Pick another one.')
      setClaiming(null)
      load()
      return
    }
    setClaiming(null)
    load()
  }

  // Deck stays changeable after joining: people swap decks between claiming a seat
  // and actually shuffling up. The host re-reads the seats when saving the result.
  const changeDeck = async (deckId) => {
    if (!mine) return
    const deck = deckId === NO_DECK ? null : decks.find(d => d.id === deckId)
    setSlots(prev => prev.map(s => (
      s.id === mine.id ? { ...s, deck_id: deck?.id || null, deck_name: deck?.name || null } : s
    )))
    const { error: updateError } = await sb.from('game_players').update({
      deck_id: deck?.id || null,
      deck_name: deck?.name || null,
    }).eq('id', mine.id).eq('user_id', user.id)
    if (updateError) { setError('Could not save that deck. Try again.'); load() }
  }

  const leaveSeat = async () => {
    if (!mine) return
    setBusy(true)
    await sb.from('game_players').update({
      user_id: null, deck_id: null, deck_name: null, claimed_at: null,
    }).eq('id', mine.id).eq('user_id', user.id)
    setBusy(false)
    load()
  }

  // ── Shells ─────────────────────────────────────────────────────────────────
  if (status === 'loading') return (
    <Frame>
      <div className={styles.spinner}><SyncIcon size={20} /></div>
      <p className={styles.note}>Looking up the game…</p>
    </Frame>
  )

  if (status === 'notfound') return (
    <Frame title="No game with that code">
      <p className={styles.note}>
        <strong>{codeUpper}</strong> doesn't match an open game. Codes are six
        characters and are shown on the host's device.
      </p>
      <Link className={styles.link} to="/life">Open the life tracker</Link>
    </Frame>
  )

  if (session?.status === 'ended') return (
    <Frame title="That game has finished">
      <p className={styles.note}>
        If you had a seat, the result is already on your record.
      </p>
      <Link className={styles.link} to="/stats">See your past games</Link>
    </Frame>
  )

  if (!user) return (
    <Frame title="Sign in to join">
      <p className={styles.note}>
        A DeckLoom account is what the result gets saved to, so joining needs one.
      </p>
      <Link className={styles.link} to="/">Sign in</Link>
    </Frame>
  )

  const formatLabel = LIFE_FORMATS[session.mode]?.label || session.mode
  const started = session.status === 'playing'

  // ── Claim form ─────────────────────────────────────────────────────────────
  if (claiming) {
    if (showArt) return (
      <Frame title="Background art" eyebrow={`Seat ${claiming.slot_index + 1}`}>
        <ArtPicker value={draftArt} autoFocus
          onSelect={url => { setDraftArt(url); setShowArt(false) }} />
        <div className={styles.actions}>
          <Button variant="ghost" block onClick={() => setShowArt(false)}>Back</Button>
          {draftArt && (
            <Button variant="danger" block onClick={() => { setDraftArt(null); setShowArt(false) }}>
              Remove
            </Button>
          )}
        </div>
      </Frame>
    )

    return (
      <Frame title={`Take seat ${claiming.slot_index + 1}`} eyebrow={formatLabel}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="join-name">Your name</label>
          <input id="join-name" className={styles.input} value={draftName} maxLength={24}
            onChange={e => setDraftName(e.target.value)} autoFocus />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>Colour</span>
          <div className={styles.swatches}>
            {PLAYER_COLORS.map(color => (
              <button key={color} type="button" className={styles.swatch}
                style={{ '--sw': color }}
                data-active={draftColor === color ? 'true' : undefined}
                aria-label={`Colour ${color}`} aria-pressed={draftColor === color}
                onClick={() => setDraftColor(color)} />
            ))}
          </div>
        </div>

        {decks.length > 0 && (
          <div className={styles.field}>
            <span className={styles.label}>Deck</span>
            <Select value={draftDeck} onChange={e => setDraftDeck(e.target.value)} searchable
              title="Select your deck">
              <option value={NO_DECK}>— No deck —</option>
              {decks.map(deck => <option key={deck.id} value={deck.id}>{deck.label || deck.name}</option>)}
            </Select>
            <p className={styles.hint}>The win or loss saves to this deck. You can change it later.</p>
          </div>
        )}

        <div className={styles.field}>
          <span className={styles.label}>Background art</span>
          <div className={styles.artRow}>
            {draftArt && <img className={styles.artThumb} src={draftArt} alt="" />}
            <Button variant="secondary" onClick={() => setShowArt(true)}>
              {draftArt ? 'Change art' : 'Choose art'}
            </Button>
          </div>
          <p className={styles.hint}>Shows behind your life total on the host's device.</p>
        </div>

        <ErrorBox>{error}</ErrorBox>

        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => setClaiming(null)} disabled={busy}>Back</Button>
          <Button variant="primary" block onClick={submitClaim}
            disabled={busy || !draftName.trim()}>
            {busy ? 'Joining…' : 'Take this seat'}
          </Button>
        </div>
      </Frame>
    )
  }

  // ── Joined ─────────────────────────────────────────────────────────────────
  if (mine) return (
    <Frame title="You're in" eyebrow={`Game ${session.code}`}>
      <div className={styles.mine}>
        <span className={styles.mineSeat}>Seat {mine.slot_index + 1}</span>
        <span className={styles.mineName}>
          <span className={styles.dot} style={{ '--sw': mine.color }} />
          {mine.player_name}
        </span>
      </div>

      {decks.length > 0 ? (
        <div className={styles.field}>
          <span className={styles.label}>Your deck</span>
          <Select value={mine.deck_id || NO_DECK} onChange={e => changeDeck(e.target.value)}
            searchable title="Select your deck">
            <option value={NO_DECK}>— No deck —</option>
            {decks.map(deck => <option key={deck.id} value={deck.id}>{deck.label || deck.name}</option>)}
          </Select>
        </div>
      ) : (
        <p className={styles.note}>
          You have no decks yet, so this game saves without deck win rates.
        </p>
      )}

      <p className={styles.note}>
        {started
          ? 'The game is underway. Life is tracked on the host\'s device — your result saves to this deck when it ends.'
          : 'Life is tracked on the host\'s device. Your result saves to this deck when the game ends.'}
        {' '}You can change your deck right up until then, then put your phone away.
      </p>

      <div className={styles.roster}>
        {slots.map(slot => (
          <div key={slot.id} className={styles.slot}
            data-claimed={slot.user_id ? 'true' : undefined}
            data-mine={slot.id === mine.id ? 'true' : undefined}>
            <span className={styles.dot} style={{ '--sw': slot.color }} />
            <span className={styles.slotName}>{slot.player_name}</span>
            <span className={styles.slotMeta}>{slot.deck_name || (slot.user_id ? 'No deck' : 'Open')}</span>
            {slot.user_id && <CheckIcon size={13} />}
          </div>
        ))}
      </div>

      <ErrorBox>{error}</ErrorBox>

      <div className={styles.actions}>
        <Link className={styles.link} to="/life">Open my life tracker</Link>
        {!started && (
          <Button variant="ghost" onClick={leaveSeat} disabled={busy}>Leave the game</Button>
        )}
      </div>
    </Frame>
  )

  // ── Roster (not yet claimed) ───────────────────────────────────────────────
  return (
    <Frame title="Pick your seat" eyebrow={`${formatLabel} · Game ${session.code}`}>
      <p className={styles.note}>
        Life is tracked on the host's device. You're joining so this game's result
        saves to your deck.
      </p>

      {started && (
        <p className={styles.warn}>
          The game has already started. You can still take an open seat — the host
          picks up your deck when they save the result.
        </p>
      )}

      <div className={styles.roster}>
        {slots.map(slot => {
          const taken = !!slot.user_id
          return (
            <button key={slot.id} type="button" className={styles.slotBtn}
              data-claimed={taken ? 'true' : undefined}
              disabled={taken}
              onClick={() => openClaim(slot)}>
              <span className={styles.dot} style={{ '--sw': slot.color }} />
              <span className={styles.slotName}>{slot.player_name}</span>
              <span className={styles.slotMeta}>
                {taken ? (slot.deck_name || 'Taken') : 'Tap to take'}
              </span>
              {taken ? <CheckIcon size={13} /> : <PlayerIcon size={13} />}
            </button>
          )
        })}
      </div>

      <ErrorBox>{error}</ErrorBox>
      <Link className={styles.link} to="/life">Open my life tracker instead</Link>
    </Frame>
  )
}

function Frame({ title, eyebrow, children }) {
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
        {title && <h1 className={styles.title}>{title}</h1>}
        {children}
      </div>
    </div>
  )
}
