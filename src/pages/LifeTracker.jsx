import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Button } from '../components/UI'
import { useAuth } from '../components/Auth'
import { sb } from '../lib/supabase'
import styles from './LifeTracker.module.css'

// ── Constants ──────────────────────────────────────────────────────────────────
const SESSION_KEY = 'av_life_tracker'
const HISTORY_KEY = 'av_game_history'
const MAX_HISTORY = 50

const PLAYER_COLORS = ['#c46060', '#6080c4', '#60a860', '#c4a040', '#9060c4', '#60b8c4']
const PLAYER_NAMES  = ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6']
const DICE_TYPES    = [2, 4, 6, 8, 10, 12, 20, 100]

// ── Multiplayer lobby helpers ──────────────────────────────────────────────────
const CODE_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const generateCode = () =>
  Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')

const MODES = {
  standard:    { label: 'Standard',    life: 20, commander: false, poison: false, defaultPlayers: 2 },
  commander:   { label: 'Commander',   life: 40, commander: true,  poison: true,  defaultPlayers: 4 },
  brawl:       { label: 'Brawl',       life: 25, commander: true,  poison: false, defaultPlayers: 2 },
  oathbreaker: { label: 'Oathbreaker', life: 20, commander: true,  poison: false, defaultPlayers: 2 },
  planechase:  { label: 'Planechase',  life: 20, commander: false, poison: false, defaultPlayers: 4 },
  custom:      { label: 'Custom',      life: 20, commander: false, poison: false, defaultPlayers: 4 },
}

// ── Layout definitions ─────────────────────────────────────────────────────────
// cols = grid columns. rotations = { [playerIndex]: degrees } — applied on tablet/phone only
const LAYOUTS = {
  2: [
    { id: '2-portrait',  cols: 1, label: 'Portrait',     rotations: { 1: 180 } },
    { id: '2-landscape', cols: 2, label: 'Side by Side', rotations: {} },
  ],
  3: [
    { id: '3-2+1', cols: 2, label: '2 + 1', rotations: { 2: 180 } },
    { id: '3-row', cols: 3, label: 'Row',    rotations: {} },
  ],
  4: [
    { id: '4-2x2',   cols: 2, label: '2 × 2', rotations: { 2: 180, 3: 180 } },
    { id: '4-sides', cols: 2, label: 'Sides',  rotations: { 0: 90, 1: -90, 2: 90, 3: -90 } },
    { id: '4-row',   cols: 4, label: 'Row',    rotations: {} },
  ],
  5: [
    { id: '5-3+2', cols: 3, label: '3 + 2', rotations: { 3: 180, 4: 180 } },
    { id: '5-2+3', cols: 3, label: '2 + 3', rotations: { 2: 180, 3: 180, 4: 180 } },
  ],
  6: [
    { id: '6-3x2', cols: 3, label: '3 × 2', rotations: { 3: 180, 4: 180, 5: 180 } },
    { id: '6-2x3', cols: 2, label: '2 × 3', rotations: { 2: 180, 3: 180, 4: 180, 5: 180 } },
  ],
}

const defaultLayout = (count) => LAYOUTS[count]?.[0] ?? LAYOUTS[4][0]

// ── Persistence helpers ────────────────────────────────────────────────────────
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) } catch { return null }
}
function saveSession(s) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) } catch {}
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY) } catch {}
}
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [] } catch { return [] }
}
function saveHistory(h) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY))) } catch {}
}

// ── Player factory ─────────────────────────────────────────────────────────────
function makePlayer(i, life, seed = {}) {
  return {
    id: i,
    name: seed.name ?? PLAYER_NAMES[i],
    color: seed.color ?? PLAYER_COLORS[i],
    deckId: seed.deckId ?? null,
    deckName: seed.deckName ?? null,
    artCropUrl: seed.artCropUrl ?? null,
    life,
    poison: 0,
    cmdDmg: {},
  }
}

// ── Layout Picker ──────────────────────────────────────────────────────────────
function LayoutPicker({ playerCount, value, onChange }) {
  const options = LAYOUTS[playerCount]
  if (!options || options.length <= 1) return null
  return (
    <div className={styles.layoutPicker}>
      {options.map(opt => {
        const active = value?.id === opt.id
        return (
          <button key={opt.id}
            className={`${styles.layoutOpt} ${active ? styles.layoutOptActive : ''}`}
            onClick={() => onChange(opt)}>
            <div className={styles.layoutGrid} style={{ '--lcols': opt.cols }}>
              {Array.from({ length: playerCount }, (_, i) => {
                const rot = opt.rotations?.[i] || 0
                return (
                  <div key={i} className={`${styles.layoutSeat} ${
                    rot === 180 ? styles.layoutSeatFlip :
                    rot ===  90 ? styles.layoutSeat90  :
                    rot === -90 ? styles.layoutSeat90n : ''
                  }`} />
                )
              })}
            </div>
            <span className={styles.layoutOptLabel}>{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Custom Deck Dropdown ───────────────────────────────────────────────────────
function DeckDropdown({ value, valueName, options, onChange }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = e => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  return (
    <div className={styles.deckDrop} ref={wrapRef}>
      <button
        className={`${styles.deckDropBtn} ${open ? styles.deckDropBtnOpen : ''}`}
        onClick={() => setOpen(v => !v)}>
        <span className={styles.deckDropValue}>{valueName || '— No deck —'}</span>
        <span className={styles.deckDropArrow}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className={styles.deckDropMenu}>
          <button
            className={`${styles.deckDropItem} ${!value ? styles.deckDropItemActive : ''}`}
            onClick={() => { onChange(null, null); setOpen(false) }}>
            — No deck selected —
          </button>
          {options.map(d => (
            <button key={d.id}
              className={`${styles.deckDropItem} ${value === d.id ? styles.deckDropItemActive : ''}`}
              onClick={() => { onChange(d.id, d.name); setOpen(false) }}>
              <span>{d.name}</span>
              {d.type === 'builder_deck' && <span className={styles.deckDropTypeBadge}>builder</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Art Picker (page-level so transform:rotate doesn't break position:fixed) ──
function ArtPicker({ onSelect, onClear, onClose }) {
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)
  useEffect(() => inputRef.current?.focus(), [])

  const search = async () => {
    if (!query.trim()) return
    setLoading(true)
    try {
      const r = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=art&order=name`)
      const data = await r.json()
      setResults((data.data || []).filter(c => c.image_uris?.art_crop).slice(0, 20))
    } catch { setResults([]) }
    setLoading(false)
  }

  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 14, fontSize: '1rem' }}>
        Player Background Art
      </h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input ref={inputRef}
          value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="Search card name…"
          style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', color: 'var(--text)', fontSize: '0.88rem', outline: 'none' }}
        />
        <Button onClick={search} disabled={loading}>{loading ? '…' : 'Search'}</Button>
      </div>
      <button onClick={onClear}
        style={{ background: 'none', border: '1px solid rgba(200,70,60,0.3)', borderRadius: 3, padding: '4px 12px', color: '#e08878', fontSize: '0.76rem', cursor: 'pointer', marginBottom: 10 }}>
        Remove art background
      </button>
      {results.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: 8, maxHeight: 380, overflowY: 'auto' }}>
          {results.map(card => (
            <button key={card.id}
              onClick={() => onSelect(card.image_uris.art_crop)}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, padding: 0, cursor: 'pointer', overflow: 'hidden' }}
              title={card.name}>
              <img src={card.image_uris.art_crop} alt={card.name}
                style={{ width: '100%', display: 'block', aspectRatio: '4/3', objectFit: 'cover' }} />
              <div style={{ padding: '4px 6px', fontSize: '0.68rem', color: 'var(--text-dim)', background: 'rgba(0,0,0,0.6)', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {card.name}
              </div>
            </button>
          ))}
        </div>
      )}
      {!loading && results.length === 0 && query && (
        <p style={{ color: 'var(--text-faint)', fontSize: '0.85rem' }}>No results.</p>
      )}
    </Modal>
  )
}

// ── Commander Damage Overlay (page-level) ──────────────────────────────────────
function CmdDmgOverlay({ player, opponents, onCmdDmgChange, onClose }) {
  if (!player || !opponents?.length) return null
  return (
    <div className={styles.cmdOverlay} onClick={onClose}>
      <div className={styles.cmdOverlayPanel} onClick={e => e.stopPropagation()}>
        <div className={styles.cmdOverlayHead}>
          <div>
            <div className={styles.cmdOverlayTitle}>⚔ Commander Damage</div>
            <div className={styles.cmdOverlaySub} style={{ color: player.color }}>
              {player.name} received…
            </div>
          </div>
          <button className={styles.cmdOverlayClose} onClick={onClose}>×</button>
        </div>
        <div className={styles.cmdOverlayList}>
          {opponents.map(opp => {
            const dmg = player.cmdDmg?.[opp.id] || 0
            return (
              <div key={opp.id}
                className={`${styles.cmdOverlayRow} ${dmg >= 21 ? styles.cmdOverlayLethal : ''}`}
                style={{ '--opc': opp.color }}>
                <div className={styles.cmdOverlayOpp}>
                  <span className={styles.cmdOverlayDot} />
                  <span className={styles.cmdOverlayOppName}>{opp.name}</span>
                  {dmg >= 21 && <span className={styles.cmdLethalBadge}>LETHAL</span>}
                </div>
                <div className={styles.cmdOverlayCtrl}>
                  <button className={styles.cmdOverlayBtn}
                    onPointerDown={e => { e.preventDefault(); onCmdDmgChange(player.id, opp.id, -5) }}>−5</button>
                  <button className={styles.cmdOverlayBtn}
                    onPointerDown={e => { e.preventDefault(); onCmdDmgChange(player.id, opp.id, -1) }}>−</button>
                  <span className={`${styles.cmdOverlayVal} ${dmg >= 21 ? styles.cmdOverlayValLethal : ''}`}>
                    {dmg}
                  </span>
                  <button className={styles.cmdOverlayBtn}
                    onPointerDown={e => { e.preventDefault(); onCmdDmgChange(player.id, opp.id, +1) }}>+</button>
                  <button className={styles.cmdOverlayBtn}
                    onPointerDown={e => { e.preventDefault(); onCmdDmgChange(player.id, opp.id, +5) }}>+5</button>
                </div>
              </div>
            )
          })}
        </div>
        <p className={styles.cmdOverlayHint}>Changes also update life total · tap outside to close</p>
      </div>
    </div>
  )
}

// ── Dice Roller ────────────────────────────────────────────────────────────────
function DiceRoller({ onClose }) {
  const [dieType,  setDieType]  = useState(20)
  const [numDice,  setNumDice]  = useState(1)
  const [results,  setResults]  = useState([])
  const [dispVals, setDispVals] = useState([])
  const [rolling,  setRolling]  = useState(false)
  const frameRef = useRef(null)

  useEffect(() => () => clearTimeout(frameRef.current), [])

  const roll = () => {
    if (rolling) return
    setRolling(true)
    const finals = Array.from({ length: numDice }, () => Math.floor(Math.random() * dieType) + 1)
    let frame = 0
    const total = 18
    const animate = () => {
      frame++
      const vals = Array.from({ length: numDice }, () => Math.floor(Math.random() * dieType) + 1)
      setDispVals(vals)
      if (frame < total) {
        frameRef.current = setTimeout(animate, 25 + frame * 6)
      } else {
        setResults(finals)
        setDispVals(finals)
        setRolling(false)
      }
    }
    setDispVals(Array.from({ length: numDice }, () => Math.floor(Math.random() * dieType) + 1))
    frameRef.current = setTimeout(animate, 25)
  }

  const shown    = rolling ? dispVals : results
  const total    = results.reduce((s, v) => s + v, 0)
  // Highlight max/min only when rolling more than 3 dice and animation has settled
  const showHL   = numDice > 3 && !rolling && results.length > 0
  const maxVal   = showHL ? Math.max(...results) : null
  const minVal   = showHL && Math.min(...results) !== Math.max(...results) ? Math.min(...results) : null

  return (
    <div className={styles.diceOverlay} onClick={onClose}>
      <div className={styles.dicePanel} onClick={e => e.stopPropagation()}>
        <div className={styles.diceHead}>
          <span className={styles.diceTitle}>🎲 Dice Roller</span>
          <button className={styles.diceClose} onClick={onClose}>×</button>
        </div>

        <div className={styles.diceTypes}>
          {DICE_TYPES.map(d => (
            <button key={d}
              className={`${styles.diceTypeBtn} ${dieType === d ? styles.diceTypeBtnActive : ''}`}
              onClick={() => setDieType(d)}>
              d{d}
            </button>
          ))}
        </div>

        <div className={styles.diceCount}>
          <span className={styles.diceCountLabel}>Number of dice</span>
          <div className={styles.diceCountCtrl}>
            <button className={styles.diceCountBtn} onClick={() => setNumDice(n => Math.max(1, n - 1))}>−</button>
            <span className={styles.diceCountVal}>{numDice}</span>
            <button className={styles.diceCountBtn} onClick={() => setNumDice(n => Math.min(10, n + 1))}>+</button>
          </div>
        </div>

        <div className={styles.diceResults}>
          {shown.length > 0 ? (
            <>
              <div className={styles.diceResultRow}>
                {shown.map((v, i) => (
                  <div key={i}
                    className={[
                      styles.dieFace,
                      rolling ? styles.dieFaceRolling : styles.dieFaceSettled,
                      showHL && v === maxVal ? styles.dieFaceMax : '',
                      showHL && minVal !== null && v === minVal ? styles.dieFaceMin : '',
                    ].filter(Boolean).join(' ')}>
                    {v}
                  </div>
                ))}
              </div>
              {!rolling && numDice > 1 && (
                <div className={styles.diceTotal}>
                  Total: <strong>{total}</strong>
                </div>
              )}
            </>
          ) : (
            <div className={styles.dicePrompt}>Press Roll to see results</div>
          )}
        </div>

        <button className={styles.diceRollBtn} onClick={roll} disabled={rolling}>
          {rolling ? 'Rolling…' : `Roll ${numDice}d${dieType}`}
        </button>
      </div>
    </div>
  )
}

// ── Random Player Picker ───────────────────────────────────────────────────────
function RandomPicker({ players, onClose }) {
  const [picking, setPicking] = useState(false)
  const [current, setCurrent] = useState(null)
  const [winner,  setWinner]  = useState(null)
  const timerRef = useRef(null)

  useEffect(() => () => clearTimeout(timerRef.current), [])

  const pick = () => {
    if (picking || players.length === 0) return
    setPicking(true)
    setWinner(null)
    const duration  = 2400
    const startTime = Date.now()
    const step = () => {
      const elapsed  = Date.now() - startTime
      if (elapsed >= duration) {
        const chosen = players[Math.floor(Math.random() * players.length)]
        setCurrent(chosen)
        setWinner(chosen)
        setPicking(false)
        return
      }
      setCurrent(players[Math.floor(Math.random() * players.length)])
      const progress = elapsed / duration
      timerRef.current = setTimeout(step, 55 + progress * progress * 500)
    }
    step()
  }

  return (
    <div className={styles.pickerOverlay} onClick={onClose}>
      <div className={styles.pickerPanel} onClick={e => e.stopPropagation()}>
        <div className={styles.pickerHead}>
          <span className={styles.pickerTitle}>🎯 Random Player</span>
          <button className={styles.pickerClose} onClick={onClose}>×</button>
        </div>
        <div
          className={`${styles.pickerDisplay} ${winner ? styles.pickerDisplayWin : ''} ${picking ? styles.pickerDisplayPicking : ''}`}
          style={current ? { '--pc': current.color } : {}}>
          {current ? (
            <>
              <div className={styles.pickerDot} style={{ background: current.color }} />
              <div className={styles.pickerName} style={{ color: current.color }}>{current.name}</div>
              {winner && <div className={styles.pickerGoesFirst}>Goes First! 🎉</div>}
            </>
          ) : (
            <div className={styles.pickerEmpty}>Press Pick!</div>
          )}
        </div>
        <button className={styles.pickerBtn} onClick={pick} disabled={picking}>
          {picking ? '🎲 Picking…' : winner ? '🎲 Pick Again' : '🎲 Pick!'}
        </button>
      </div>
    </div>
  )
}

// ── Multiplayer Lobby Screen ───────────────────────────────────────────────────
function LobbyScreen({ session, gameConfig, onStart, onCancel }) {
  const [players,  setPlayers]  = useState([])
  const [starting, setStarting] = useState(false)
  const [copied,   setCopied]   = useState(false)
  const modeConf = MODES[gameConfig?.mode] || MODES.commander
  const life     = gameConfig?.customLife || modeConf.life
  const joinUrl  = `${window.location.origin}${import.meta.env.BASE_URL}join/${session.code}`

  useEffect(() => {
    let active = true
    const load = async () => {
      const { data } = await sb.from('game_players')
        .select('*').eq('session_id', session.id).order('slot_index')
      if (active && data) setPlayers(data)
    }
    load()
    // No filter on the subscription — filtered postgres_changes can silently
    // miss UPDATE events. Check session_id in the callback instead.
    const ch = sb.channel(`lobby-host:${session.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'game_players',
      }, payload => {
        const row = payload.new || payload.old
        if (row?.session_id === session.id) load()
      })
      .subscribe()
    return () => { active = false; sb.removeChannel(ch) }
  }, [session.id])

  const copyLink = () => {
    navigator.clipboard.writeText(joinUrl).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2200)
    })
  }

  const handleStart = async () => {
    setStarting(true)
    try {
      // Always do a fresh fetch right before start so we have the latest
      // player names/decks even if the realtime update arrived late.
      const { data: freshRows } = await sb.from('game_players')
        .select('*').eq('session_id', session.id).order('slot_index')
      const rows = freshRows || players

      await sb.from('game_sessions')
        .update({ status: 'playing', started_at: new Date().toISOString() })
        .eq('id', session.id)
      const gamePlayers = rows.map((lp, i) =>
        makePlayer(i, life, {
          name: lp.player_name, color: lp.color,
          deckId: lp.deck_id, deckName: lp.deck_name,
          artCropUrl: lp.art_crop_url,
        })
      )
      onStart({ gamePlayers, layout: gameConfig.layout })
    } catch { setStarting(false) }
  }

  const claimedCount = players.filter(p => p.user_id).length

  return (
    <div className={styles.lobbyScreen}>
      <div className={styles.lobbyHero}>
        <span className={styles.lobbyHeroGlyph}>⚔</span>
        <h1 className={styles.lobbyTitle}>Multiplayer Lobby</h1>
        <p className={styles.lobbySub}>
          {modeConf.label} · {gameConfig?.playerCount} players · {life} life
        </p>
      </div>

      {/* Join code block */}
      <div className={styles.lobbyCodeBlock}>
        <div className={styles.lobbyCodeLabel}>Join Code</div>
        <div className={styles.lobbyCode}>
          {session.code.split('').map((c, i) => (
            <span key={i} className={styles.lobbyCodeChar}>{c}</span>
          ))}
        </div>
        <button className={styles.lobbyCopyBtn} onClick={copyLink}>
          {copied ? '✓ Copied!' : '⎘ Copy Join Link'}
        </button>
        <div className={styles.lobbyJoinUrl}>{joinUrl}</div>
      </div>

      {/* Player slots */}
      <div className={styles.lobbySlots}>
        {players.map(p => (
          <div key={p.id}
            className={`${styles.lobbySlot} ${p.user_id ? styles.lobbySlotClaimed : styles.lobbySlotEmpty}`}
            style={{ '--pc': p.color }}>
            <div className={styles.lobbySlotNum}>{p.slot_index + 1}</div>
            <span className={styles.lobbySlotDot} style={{ background: p.color }} />
            <div className={styles.lobbySlotInfo}>
              <div className={styles.lobbySlotName}>{p.player_name}</div>
              <div className={styles.lobbySlotSub}>
                {p.deck_name ? `🃏 ${p.deck_name}`
                  : p.user_id ? 'No deck selected'
                  : 'Waiting to join…'}
              </div>
            </div>
            {p.user_id && <span className={styles.lobbySlotCheck}>✓</span>}
          </div>
        ))}
      </div>

      <p className={styles.lobbyCount}>
        {claimedCount} / {gameConfig?.playerCount} joined
      </p>

      <div className={styles.lobbyFooter}>
        <button className={styles.lobbyCancelBtn} onClick={onCancel}>
          ✕ Cancel Lobby
        </button>
        <button
          className={styles.lobbyStartBtn}
          onClick={handleStart}
          disabled={starting || claimedCount < 1}>
          {starting ? '…' : '⚔ Start Game'}
        </button>
      </div>

      <p className={styles.lobbyHint}>
        Share the code or link — other players open it on their own phone to pick their deck.
      </p>
    </div>
  )
}

// ── Pre-game: Player Config Row ────────────────────────────────────────────────
function PlayerConfig({ index, config, decks, history, onChange }) {
  const [editing, setEditing] = useState(false)
  const [nameVal, setNameVal] = useState(config.name)

  const deckStats = config.deckId ? (() => {
    const games = history.filter(g => g.players.some(p => p.deckId === config.deckId))
    const wins  = games.filter(g => g.players.find(p => p.deckId === config.deckId)?.placement === 1).length
    return { total: games.length, wins }
  })() : null

  return (
    <div className={styles.playerConfig} style={{ '--pc': config.color }}>
      <div className={styles.pcNum}>{index + 1}</div>
      <div className={styles.pcBody}>
        <div className={styles.pcTop}>
          {editing
            ? <input className={styles.pcNameInput}
                value={nameVal}
                onChange={e => setNameVal(e.target.value)}
                onBlur={() => { setEditing(false); onChange({ name: nameVal.trim() || config.name }) }}
                onKeyDown={e => e.key === 'Enter' && e.target.blur()}
                autoFocus />
            : <button className={styles.pcName} onClick={() => { setEditing(true); setNameVal(config.name) }}>
                {config.name} <span className={styles.pcEditHint}>✎</span>
              </button>
          }
          <div className={styles.pcColors}>
            {PLAYER_COLORS.map(c => (
              <button key={c}
                className={`${styles.pcColorDot} ${c === config.color ? styles.pcColorDotActive : ''}`}
                style={{ background: c }}
                onClick={() => onChange({ color: c })} />
            ))}
          </div>
        </div>
        {decks.length > 0 && (
          <div className={styles.pcDeckRow}>
            <DeckDropdown
              value={config.deckId}
              valueName={config.deckName}
              options={decks}
              onChange={(id, name) => onChange({ deckId: id, deckName: name })}
            />
            {deckStats && deckStats.total > 0 && (
              <span className={styles.pcDeckStats}>
                {deckStats.wins}W–{deckStats.total - deckStats.wins}L
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Pre-game: History entry ────────────────────────────────────────────────────
function HistoryEntry({ game }) {
  const sorted = [...game.players].sort((a, b) => a.placement - b.placement)
  const mins   = Math.round((game.duration || 0) / 60000)
  return (
    <div className={styles.histEntry}>
      <div className={styles.histEntryHead}>
        <span className={styles.histMode}>{MODES[game.mode]?.label || game.mode}</span>
        <span className={styles.histDate}>
          {new Date(game.endedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
        {mins > 0 && <span className={styles.histDur}>{mins} min</span>}
      </div>
      <div className={styles.histPlayers}>
        {sorted.map((p, i) => (
          <span key={i}
            className={`${styles.histPlayer} ${p.placement === 1 ? styles.histPlayerWin : ''}`}
            style={{ '--pc': p.color }}>
            {p.placement}. {p.name}{p.deckName ? ` · ${p.deckName}` : ''}
          </span>
        ))}
      </div>
      {game.notes && <p className={styles.histNotes}>{game.notes}</p>}
    </div>
  )
}

// ── Pre-game Setup Screen ──────────────────────────────────────────────────────
function PreGameSetup({ onStart, onCreateLobby, decks, history }) {
  const navigate = useNavigate()
  const [mode,        setMode]        = useState('commander')
  const [playerCount, setPlayerCount] = useState(MODES.commander.defaultPlayers)
  const [customLife,  setCustomLife]  = useState(40)
  const [layout,      setLayout]      = useState(() => defaultLayout(MODES.commander.defaultPlayers))
  const [configs, setConfigs] = useState(
    Array.from({ length: 6 }, (_, i) => ({
      name: PLAYER_NAMES[i], color: PLAYER_COLORS[i], deckId: null, deckName: null,
    }))
  )
  const [showHistory,  setShowHistory]  = useState(false)
  const [showJoinBox,  setShowJoinBox]  = useState(false)
  const [joinCode,     setJoinCode]     = useState('')
  const joinInputRef = useRef(null)

  const updateConfig = (i, patch) =>
    setConfigs(prev => prev.map((c, idx) => idx === i ? { ...c, ...patch } : c))

  const handleModeChange = (m) => {
    setMode(m)
    const defCount = MODES[m].defaultPlayers
    setPlayerCount(defCount)
    setLayout(defaultLayout(defCount))
  }

  const handleCountChange = (n) => {
    setPlayerCount(n)
    setLayout(defaultLayout(n))
  }

  const handleStart = () => {
    const life = mode === 'custom' ? customLife : MODES[mode].life
    const players = Array.from({ length: playerCount }, (_, i) => makePlayer(i, life, configs[i]))
    const finalLayout = layout || defaultLayout(playerCount)
    onStart({ playerCount, mode, customLife, players, startedAt: Date.now(), layout: finalLayout })
  }

  const handleCreateLobby = () => {
    const finalLayout = layout || defaultLayout(playerCount)
    onCreateLobby?.({ playerCount, mode, customLife, layout: finalLayout, playerConfigs: configs })
  }

  const handleToggleJoin = () => {
    setShowJoinBox(v => {
      if (!v) setTimeout(() => joinInputRef.current?.focus(), 50)
      return !v
    })
    setJoinCode('')
  }

  const handleJoin = () => {
    const code = joinCode.trim().toUpperCase()
    if (code.length < 4) return
    navigate(`/join/${code}`)
  }

  return (
    <div className={styles.setupScreen}>
      <div className={styles.setupHero}>
        <div className={styles.setupHeroGlyph}>♥</div>
        <h1 className={styles.setupTitle}>Life Tracker</h1>
        <p className={styles.setupSub}>Configure your game</p>
      </div>

      {/* Game mode */}
      <section className={styles.setupBlock}>
        <div className={styles.setupLabel}>Game Mode</div>
        <div className={styles.modeGrid}>
          {Object.entries(MODES).map(([key, conf]) => (
            <button key={key}
              className={`${styles.modeCard} ${mode === key ? styles.modeCardActive : ''}`}
              onClick={() => handleModeChange(key)}>
              <span className={styles.modeCardName}>{conf.label}</span>
              <span className={styles.modeCardLife}>{key === 'custom' ? '? life' : `${conf.life} life`}</span>
            </button>
          ))}
        </div>
        {mode === 'custom' && (
          <div className={styles.customLifeWrap}>
            <span className={styles.customLifeLabel}>Starting Life</span>
            <div className={styles.customLifePresets}>
              {[10, 20, 25, 30, 40, 50].map(v => (
                <button key={v}
                  className={`${styles.presetChip} ${customLife === v ? styles.presetChipActive : ''}`}
                  onClick={() => setCustomLife(v)}>{v}</button>
              ))}
              <input type="number" className={styles.customLifeInput}
                value={customLife}
                onChange={e => setCustomLife(Math.max(1, Math.min(999, Number(e.target.value))))}
                min={1} max={999} />
            </div>
          </div>
        )}
      </section>

      {/* Player count */}
      <section className={styles.setupBlock}>
        <div className={styles.setupLabel}>Players</div>
        <div className={styles.countRow}>
          {[2, 3, 4, 5, 6].map(n => (
            <button key={n}
              className={`${styles.countChip} ${playerCount === n ? styles.countChipActive : ''}`}
              onClick={() => handleCountChange(n)}>{n}</button>
          ))}
        </div>
      </section>

      {/* Layout picker */}
      <section className={styles.setupBlock}>
        <div className={styles.setupLabel}>Table Layout</div>
        <LayoutPicker
          playerCount={playerCount}
          value={layout}
          onChange={setLayout}
        />
        {(!LAYOUTS[playerCount] || LAYOUTS[playerCount].length <= 1) && (
          <p className={styles.layoutOnlyOne}>Only one layout available for {playerCount} players.</p>
        )}
      </section>

      {/* Player config */}
      <section className={styles.setupBlock}>
        <div className={styles.setupLabel}>Players</div>
        <div className={styles.playerConfigList}>
          {Array.from({ length: playerCount }, (_, i) => (
            <PlayerConfig key={i} index={i} config={configs[i]}
              decks={decks} history={history}
              onChange={patch => updateConfig(i, patch)} />
          ))}
        </div>
      </section>

      {/* History */}
      {history.length > 0 && (
        <section className={styles.setupBlock}>
          <button className={styles.histToggle} onClick={() => setShowHistory(v => !v)}>
            📜 Recent Games ({history.length}) {showHistory ? '▲' : '▼'}
          </button>
          {showHistory && (
            <div className={styles.histList}>
              {history.slice(0, 8).map(g => <HistoryEntry key={g.id} game={g} />)}
            </div>
          )}
        </section>
      )}

      <div className={styles.setupFooter}>
        <button className={styles.startBtn} onClick={handleStart}>⚔ Start Game</button>
        <div className={styles.lobbyRow}>
          <button className={styles.lobbyBtn} onClick={handleCreateLobby}>
            👥 Create Lobby
          </button>
          <button
            className={`${styles.lobbyBtn} ${showJoinBox ? styles.lobbyBtnActive : ''}`}
            onClick={handleToggleJoin}>
            🔑 Join Lobby
          </button>
        </div>
        {showJoinBox && (
          <div className={styles.joinBox}>
            <input
              ref={joinInputRef}
              className={styles.joinInput}
              placeholder="Enter code (e.g. AX7K2P)"
              value={joinCode}
              maxLength={8}
              onChange={e => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
            />
            <button
              className={styles.joinGoBtn}
              onClick={handleJoin}
              disabled={joinCode.trim().length < 4}>
              Join →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── End Game Dialog ────────────────────────────────────────────────────────────
function EndGameDialog({ players, onSave, onCancel }) {
  const count = players.length
  const [placements, setPlacements] = useState(() => {
    const sorted = [...players].sort((a, b) => b.life - a.life)
    return Object.fromEntries(sorted.map((p, i) => [p.id, i + 1]))
  })
  const [notes, setNotes] = useState('')

  const setPlacement = (playerId, placement) => {
    setPlacements(prev => {
      const conflict = Object.entries(prev).find(([id, pl]) => Number(id) !== playerId && pl === placement)
      const myOld = prev[playerId]
      const next  = { ...prev, [playerId]: placement }
      if (conflict) next[conflict[0]] = myOld
      return next
    })
  }

  const lbl = n => ['1st 🥇', '2nd 🥈', '3rd 🥉', '4th', '5th', '6th'][n - 1] || `${n}th`

  return (
    <div className={styles.endOverlay}>
      <div className={styles.endDialog}>
        <div className={styles.endHeader}>
          <div className={styles.endIcon}>🏆</div>
          <h2 className={styles.endTitle}>Game Over</h2>
          <p className={styles.endSub}>Set final standings and add notes</p>
        </div>
        <div className={styles.endPlayerList}>
          {players.map(p => (
            <div key={p.id} className={styles.endPlayerRow} style={{ '--pc': p.color }}>
              <div className={styles.endPlayerInfo}>
                <span className={styles.endPlayerDot} />
                <div>
                  <div className={styles.endPlayerName}>{p.name}</div>
                  {p.deckName && <div className={styles.endDeckName}>{p.deckName}</div>}
                </div>
                <span className={styles.endLifeBadge}>{p.life} ♥</span>
              </div>
              <div className={styles.endPlacements}>
                {Array.from({ length: count }, (_, i) => i + 1).map(n => (
                  <button key={n}
                    className={`${styles.endPlaceBtn} ${placements[p.id] === n ? styles.endPlaceBtnActive : ''} ${n === 1 ? styles.endPlaceFirst : ''}`}
                    onClick={() => setPlacement(p.id, n)}>
                    {lbl(n)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className={styles.endNotesWrap}>
          <label className={styles.endNotesLabel}>Post-game Notes</label>
          <textarea className={styles.endNotesArea}
            value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="What happened? What would you do differently next time?"
            rows={3} />
        </div>
        <div className={styles.endActions}>
          <button className={styles.endContinueBtn} onClick={onCancel}>← Continue Playing</button>
          <button className={styles.endSaveBtn} onClick={() => onSave({ placements, notes })}>
            💾 Save & New Game
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Player Panel ───────────────────────────────────────────────────────────────
function PlayerPanel({
  player, opponents,
  onLifeChange, onPoisonChange, onCmdDmgChange, onNameChange, onColorChange,
  onRequestArtPicker, onRequestCmdDmgOverlay,
  showCommander, showPoison, rotation = 0,
}) {
  const [editingName, setEditingName] = useState(false)
  const [nameInput,   setNameInput]   = useState(player.name)
  const [lastDelta,   setLastDelta]   = useState(null)
  const deltaTimerRef = useRef(null)
  const holdTimerRef  = useRef(null)
  const prevLife      = useRef(player.life)

  useEffect(() => {
    const d = player.life - prevLife.current
    if (d !== 0) {
      setLastDelta(d)
      clearTimeout(deltaTimerRef.current)
      deltaTimerRef.current = setTimeout(() => setLastDelta(null), 1600)
    }
    prevLife.current = player.life
  }, [player.life])

  useEffect(() => () => {
    clearTimeout(deltaTimerRef.current)
    clearTimeout(holdTimerRef.current)
  }, [])

  const handleLifeHoldStart = () => {
    if (!showCommander || !opponents.length || !onRequestCmdDmgOverlay) return
    holdTimerRef.current = setTimeout(() => onRequestCmdDmgOverlay(player.id), 550)
  }
  const handleLifeHoldEnd = () => clearTimeout(holdTimerRef.current)

  const adjust = delta => onLifeChange(player.id, delta)
  const handleNameSubmit = () => {
    setEditingName(false)
    onNameChange(player.id, nameInput.trim() || player.name)
  }

  const isDead = player.life <= 0 || player.poison >= 10

  return (
    <div
      className={`${styles.playerPanel} ${isDead ? styles.playerDead : ''} ${
        rotation === 180 ? styles.playerRotate180 :
        rotation ===  90 ? styles.playerRotate90  :
        rotation === -90 ? styles.playerRotate90n : ''
      }`}
      style={{
        '--player-color': player.color,
        ...(player.artCropUrl ? {
          backgroundImage: `linear-gradient(rgba(10,10,18,0.55) 0%, rgba(10,10,18,0.80) 100%), url(${player.artCropUrl})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
        } : {}),
      }}>

      {/* Color + art-picker row */}
      <div className={styles.colorRow}>
        {PLAYER_COLORS.map(c => (
          <button key={c}
            className={`${styles.colorDot} ${c === player.color ? styles.colorDotActive : ''}`}
            style={{ background: c }} onClick={() => onColorChange(player.id, c)} />
        ))}
        {/* ⚙ opens art picker */}
        <button onClick={() => onRequestArtPicker(player.id)} title="Set background art"
          className={styles.artPickerBtn}>
          ⚙
        </button>
      </div>

      {/* Name + deck badge */}
      <div className={styles.nameRow}>
        {editingName
          ? <input className={styles.nameInput}
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={e => e.key === 'Enter' && handleNameSubmit()}
              autoFocus />
          : <button className={styles.nameBtn}
              onClick={() => { setEditingName(true); setNameInput(player.name) }}>
              {player.name}
            </button>
        }
        {player.deckName && <span className={styles.panelDeckBadge}>{player.deckName}</span>}
      </div>

      {/* Life total */}
      <div className={styles.lifeArea}>
        <button className={styles.lifeBtn} onPointerDown={e => { e.preventDefault(); adjust(-1) }}>−</button>

        <div className={styles.lifeTotalWrap}
          onPointerDown={handleLifeHoldStart}
          onPointerUp={handleLifeHoldEnd}
          onPointerLeave={handleLifeHoldEnd}
          onContextMenu={e => { if (showCommander) e.preventDefault() }}
          title={showCommander && opponents.length ? 'Hold for commander damage' : undefined}>
          <span className={`${styles.lifeTotal} ${player.life <= 5 ? styles.lifeLow : ''} ${player.life <= 0 ? styles.lifeDead : ''}`}>
            {player.life}
          </span>
          {lastDelta != null && (
            <span key={`${lastDelta}-${Date.now()}`}
              className={`${styles.lifeDelta} ${lastDelta > 0 ? styles.lifeDeltaUp : styles.lifeDeltaDown}`}>
              {lastDelta > 0 ? `+${lastDelta}` : lastDelta}
            </span>
          )}
        </div>

        <button className={styles.lifeBtn} onPointerDown={e => { e.preventDefault(); adjust(+1) }}>+</button>
      </div>

      {/* Quick ±5/10 */}
      <div className={styles.quickRow}>
        <button className={styles.quickBtn} onPointerDown={e => { e.preventDefault(); adjust(-5) }}>−5</button>
        <button className={styles.quickBtn} onPointerDown={e => { e.preventDefault(); adjust(-10) }}>−10</button>
        <button className={styles.quickBtn} onPointerDown={e => { e.preventDefault(); adjust(+5) }}>+5</button>
        <button className={styles.quickBtn} onPointerDown={e => { e.preventDefault(); adjust(+10) }}>+10</button>
      </div>

      {/* Poison */}
      {showPoison && (
        <div className={styles.poisonRow}>
          <span className={styles.poisonLabel}>☠ Poison</span>
          <div className={styles.counterRow}>
            <button className={styles.counterBtn} onPointerDown={e => { e.preventDefault(); onPoisonChange(player.id, -1) }}>−</button>
            <span className={`${styles.counterVal} ${player.poison >= 10 ? styles.counterDead : ''}`}>{player.poison}</span>
            <button className={styles.counterBtn} onPointerDown={e => { e.preventDefault(); onPoisonChange(player.id, +1) }}>+</button>
          </div>
        </div>
      )}

      {/* Commander damage bar — display-only pills, tap to open overlay */}
      {showCommander && opponents.length > 0 && (
        <div className={styles.cmdBar} onClick={() => onRequestCmdDmgOverlay?.(player.id)}>
          <span className={styles.cmdBarIcon}>⚔</span>
          <div className={styles.cmdBadges}>
            {opponents.map(opp => {
              const dmg = player.cmdDmg?.[opp.id] || 0
              return (
                <div key={opp.id}
                  className={`${styles.cmdBadge} ${dmg > 0 ? styles.cmdBadgeHit : ''} ${dmg >= 21 ? styles.cmdBadgeLethal : ''}`}
                  style={{ '--opc': opp.color }}>
                  <span className={styles.cmdBadgeDot} title={opp.name} />
                  <span className={styles.cmdBadgeVal}>{dmg}</span>
                </div>
              )
            })}
          </div>
          <span className={styles.cmdBarHint}>hold life or tap</span>
        </div>
      )}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function LifeTrackerPage() {
  const { user } = useAuth()

  const [screen,       setScreen]       = useState('setup')
  const [gameConfig,   setGameConfig]   = useState(null)
  const [players,      setPlayers]      = useState([])
  const [startedAt,    setStartedAt]    = useState(null)
  const [showEndDialog,    setShowEndDialog]    = useState(false)
  const [artPickerPlayer,  setArtPickerPlayer]  = useState(null)
  const [cmdDmgPlayer,     setCmdDmgPlayer]     = useState(null)
  const [showDice,     setShowDice]     = useState(false)
  const [showPicker,   setShowPicker]   = useState(false)
  const [showGameMenu, setShowGameMenu] = useState(false)
  const [decks,        setDecks]        = useState([])
  const [history,      setHistory]      = useState(() => loadHistory())
  const [isFullscreen, setIsFullscreen] = useState(false)
  const gearMenuRef   = useRef(null)
  const gearMenuFsRef = useRef(null)
  const [session,     setSession]     = useState(null)
  const [lobbyConfig, setLobbyConfig] = useState(null)

  useEffect(() => {
    if (!showGameMenu) return
    const handler = e => {
      const inNormal = gearMenuRef.current?.contains(e.target)
      const inFs     = gearMenuFsRef.current?.contains(e.target)
      if (!inNormal && !inFs) setShowGameMenu(false)
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [showGameMenu])

  // Sync CSS isFullscreen state with the browser's native fullscreen state
  useEffect(() => {
    const handler = () => {
      const nativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement)
      setIsFullscreen(nativeFs)
    }
    document.addEventListener('fullscreenchange', handler)
    document.addEventListener('webkitfullscreenchange', handler)
    return () => {
      document.removeEventListener('fullscreenchange', handler)
      document.removeEventListener('webkitfullscreenchange', handler)
    }
  }, [])

  // Escape key exits CSS-only fullscreen (native fullscreen already handles Escape)
  useEffect(() => {
    if (!isFullscreen) return
    const handler = e => {
      if (e.key === 'Escape' && !document.fullscreenElement) setIsFullscreen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isFullscreen])

  const handleFullscreenToggle = useCallback(async () => {
    if (!isFullscreen) {
      try {
        const el = document.documentElement
        if (el.requestFullscreen) {
          await el.requestFullscreen()
          // isFullscreen will be set by the fullscreenchange listener
          return
        } else if (el.webkitRequestFullscreen) {
          el.webkitRequestFullscreen()
          return
        }
      } catch {}
      // Fallback: CSS-only (iOS Safari, embedded views)
      setIsFullscreen(true)
    } else {
      try {
        if (document.fullscreenElement && document.exitFullscreen) {
          await document.exitFullscreen()
          return
        } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
          document.webkitExitFullscreen()
          return
        }
      } catch {}
      setIsFullscreen(false)
    }
  }, [isFullscreen])

  const handleCreateLobby = useCallback(async (config) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode()
      const { data: sess, error } = await sb.from('game_sessions').insert({
        code,
        host_user_id: user.id,
        mode:         config.mode,
        custom_life:  config.customLife,
        player_count: config.playerCount,
        status:       'lobby',
      }).select().single()
      if (error?.code === '23505') continue   // code collision — retry
      if (error) { console.error('lobby create:', error); return }

      // Create all player slots
      const slots = Array.from({ length: config.playerCount }, (_, i) => ({
        session_id:  sess.id,
        slot_index:  i,
        player_name: config.playerConfigs[i]?.name  || PLAYER_NAMES[i],
        color:       config.playerConfigs[i]?.color || PLAYER_COLORS[i],
      }))
      await sb.from('game_players').insert(slots)

      // Host auto-claims slot 0
      const hc = config.playerConfigs[0]
      await sb.from('game_players').update({
        user_id:     user.id,
        player_name: hc.name,
        color:       hc.color,
        deck_id:     hc.deckId   || null,
        deck_name:   hc.deckName || null,
        claimed_at:  new Date().toISOString(),
      }).eq('session_id', sess.id).eq('slot_index', 0)

      setSession(sess)
      setLobbyConfig(config)
      setScreen('lobby')
      return
    }
  }, [user])

  const handleCancelLobby = useCallback(async () => {
    if (session) await sb.from('game_sessions').delete().eq('id', session.id)
    setSession(null)
    setLobbyConfig(null)
    setScreen('setup')
  }, [session])

  const handleLobbyStart = useCallback(({ gamePlayers, layout }) => {
    setPlayers(gamePlayers)
    setGameConfig({ ...lobbyConfig, layout })
    setStartedAt(Date.now())
    setScreen('playing')
    setSession(null)
    setLobbyConfig(null)
  }, [lobbyConfig])

  useEffect(() => {
    if (!user) return
    sb.from('folders')
      .select('id,name,type')
      .eq('user_id', user.id)
      .in('type', ['deck', 'builder_deck'])
      .order('name')
      .then(({ data }) => setDecks(
        (data || []).filter(d => d.type === 'deck' || d.type === 'builder_deck')
      ))
  }, [user])

  useEffect(() => {
    const saved = loadSession()
    if (saved?.screen === 'playing' && saved.players?.length) {
      setScreen('playing')
      setGameConfig(saved.config)
      setPlayers(saved.players)
      setStartedAt(saved.startedAt)
    }
  }, [])

  useEffect(() => {
    if (screen === 'playing') {
      saveSession({ screen, config: gameConfig, players, startedAt })
    }
  }, [screen, gameConfig, players, startedAt])

  const handleStart = (config) => {
    setGameConfig(config)
    setPlayers(config.players)
    setStartedAt(config.startedAt)
    setScreen('playing')
  }

  const handleNewGame = () => {
    clearSession()
    setScreen('setup')
    setGameConfig(null)
    setPlayers([])
    setShowEndDialog(false)
    setShowGameMenu(false)
  }

  const handleSaveGame = ({ placements, notes }) => {
    const endedAt = Date.now()
    const game = {
      id: endedAt, mode: gameConfig.mode, startedAt, endedAt,
      duration: endedAt - (startedAt || endedAt),
      notes,
      players: players.map(p => ({
        name: p.name, color: p.color,
        deckId: p.deckId, deckName: p.deckName,
        placement: placements[p.id], finalLife: p.life,
      })),
    }
    const newHistory = [game, ...history]
    setHistory(newHistory)
    saveHistory(newHistory)
    handleNewGame()
  }

  const resetGame = () => {
    if (!gameConfig) return
    const life = gameConfig.mode === 'custom' ? gameConfig.customLife : MODES[gameConfig.mode].life
    setPlayers(prev =>
      Array.from({ length: gameConfig.playerCount }, (_, i) => ({
        ...makePlayer(i, life, prev[i]),
        life, poison: 0, cmdDmg: {},
      }))
    )
    setShowGameMenu(false)
  }

  const onLifeChange   = (id, delta) => setPlayers(ps => ps.map(p => p.id === id ? { ...p, life: p.life + delta } : p))
  const onPoisonChange = (id, delta) => setPlayers(ps => ps.map(p => p.id === id ? { ...p, poison: Math.max(0, p.poison + delta) } : p))
  const onCmdDmgChange = (pid, fid, delta) => setPlayers(ps => ps.map(p => {
    if (p.id !== pid) return p
    const cur     = p.cmdDmg?.[fid] || 0
    const newVal  = Math.max(0, cur + delta)
    const applied = newVal - cur
    return { ...p, life: p.life - applied, cmdDmg: { ...p.cmdDmg, [fid]: newVal } }
  }))
  const onNameChange  = (id, name)  => setPlayers(ps => ps.map(p => p.id === id ? { ...p, name } : p))
  const onColorChange = (id, color) => setPlayers(ps => ps.map(p => p.id === id ? { ...p, color } : p))
  const onArtChange   = (id, url)   => setPlayers(ps => ps.map(p => p.id === id ? { ...p, artCropUrl: url } : p))

  if (screen === 'setup') {
    return (
      <div className={styles.page}>
        <PreGameSetup
          onStart={handleStart}
          onCreateLobby={handleCreateLobby}
          decks={decks}
          history={history}
        />
      </div>
    )
  }

  if (screen === 'lobby') {
    return (
      <div className={styles.page}>
        <LobbyScreen
          session={session}
          gameConfig={lobbyConfig}
          onStart={handleLobbyStart}
          onCancel={handleCancelLobby}
        />
      </div>
    )
  }

  const modeConf  = MODES[gameConfig?.mode] || MODES.commander
  const count     = players.length
  const layout    = gameConfig?.layout || defaultLayout(count)
  const getRotation = idx => layout.rotations?.[idx] || 0

  return (
    <div className={`${styles.page} ${isFullscreen ? styles.pageFullscreen : ''}`}>
      <div className={styles.topBar}>
        <div className={styles.topLeft}>
          <span className={styles.pageTitle}>♥ Life Tracker</span>
          <span className={styles.modeLabel}>{modeConf.label}</span>
        </div>
        <div className={styles.topRight}>
          <button
            className={styles.fullscreenBtn}
            onClick={handleFullscreenToggle}
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}>
            {isFullscreen ? '⊡' : '⛶'}
          </button>
          <div className={styles.gearWrap} ref={gearMenuRef}>
            <button
              className={`${styles.gearBtn} ${showGameMenu ? styles.gearBtnActive : ''}`}
              onClick={() => setShowGameMenu(v => !v)}
              title="Game options">
              ⚙
            </button>
            {showGameMenu && (
              <div className={styles.gearMenu}>
                <button className={styles.gearMenuItem} onClick={() => { setShowDice(true); setShowGameMenu(false) }}>
                  🎲 Dice Roller
                </button>
                <button className={styles.gearMenuItem} onClick={() => { setShowPicker(true); setShowGameMenu(false) }}>
                  🎯 Random Player
                </button>
                <div className={styles.gearMenuDiv} />
                <button className={styles.gearMenuItem} onClick={resetGame}>
                  ↺ Reset Totals
                </button>
                <button className={`${styles.gearMenuItem} ${styles.gearMenuItemDanger}`} onClick={handleNewGame}>
                  ✕ New Setup
                </button>
              </div>
            )}
          </div>
          <button className={styles.endBtn} onClick={() => setShowEndDialog(true)}>
            🏆 End Game
          </button>
        </div>
      </div>

      {/* Floating controls shown only in fullscreen — replaces topbar to reclaim space */}
      {isFullscreen && (
        <div className={styles.fsControls}>
          <button
            className={styles.fsExitBtn}
            onClick={handleFullscreenToggle}
            title="Exit fullscreen (Esc)">
            ⊡
          </button>
          <div className={styles.gearWrap} ref={gearMenuFsRef}>
            <button
              className={`${styles.gearBtn} ${showGameMenu ? styles.gearBtnActive : ''}`}
              onClick={() => setShowGameMenu(v => !v)}
              title="Game options">
              ⚙
            </button>
            {showGameMenu && (
              <div className={`${styles.gearMenu} ${styles.gearMenuFs}`}>
                <button className={styles.gearMenuItem} onClick={() => { setShowDice(true); setShowGameMenu(false) }}>
                  🎲 Dice Roller
                </button>
                <button className={styles.gearMenuItem} onClick={() => { setShowPicker(true); setShowGameMenu(false) }}>
                  🎯 Random Player
                </button>
                <div className={styles.gearMenuDiv} />
                <button className={styles.gearMenuItem} onClick={resetGame}>
                  ↺ Reset Totals
                </button>
                <button className={`${styles.gearMenuItem} ${styles.gearMenuItemDanger}`} onClick={handleNewGame}>
                  ✕ New Setup
                </button>
              </div>
            )}
          </div>
          <button className={styles.fsEndBtn} onClick={() => setShowEndDialog(true)}>
            🏆
          </button>
        </div>
      )}

      {/* Grid: columns driven by layout choice */}
      <div className={styles.grid} style={{ '--gcols': layout.cols }}>
        {players.map((player, idx) => {
          const rotation = getRotation(idx)
          return (
            <div key={player.id} className={styles.gridCell}>
              <PlayerPanel
                player={player}
                opponents={players.filter(p => p.id !== player.id)}
                onLifeChange={onLifeChange}
                onPoisonChange={onPoisonChange}
                onCmdDmgChange={onCmdDmgChange}
                onNameChange={onNameChange}
                onColorChange={onColorChange}
                onRequestArtPicker={setArtPickerPlayer}
                onRequestCmdDmgOverlay={modeConf.commander ? setCmdDmgPlayer : null}
                showCommander={modeConf.commander}
                showPoison={modeConf.poison}
                rotation={rotation}
              />
            </div>
          )
        })}
      </div>

      {artPickerPlayer !== null && (
        <ArtPicker
          onSelect={url => { onArtChange(artPickerPlayer, url); setArtPickerPlayer(null) }}
          onClear={() => { onArtChange(artPickerPlayer, null); setArtPickerPlayer(null) }}
          onClose={() => setArtPickerPlayer(null)} />
      )}

      {cmdDmgPlayer !== null && (
        <CmdDmgOverlay
          player={players.find(p => p.id === cmdDmgPlayer)}
          opponents={players.filter(p => p.id !== cmdDmgPlayer)}
          onCmdDmgChange={onCmdDmgChange}
          onClose={() => setCmdDmgPlayer(null)} />
      )}

      {showDice   && <DiceRoller onClose={() => setShowDice(false)} />}
      {showPicker && <RandomPicker players={players} onClose={() => setShowPicker(false)} />}
      {showEndDialog && (
        <EndGameDialog
          players={players}
          onSave={handleSaveGame}
          onCancel={() => setShowEndDialog(false)} />
      )}
    </div>
  )
}
