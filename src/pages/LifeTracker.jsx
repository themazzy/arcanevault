import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Button } from '../components/UI'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { sb } from '../lib/supabase'
import styles from './LifeTracker.module.css'

// ── Constants ──────────────────────────────────────────────────────────────────
const SESSION_KEY = 'av_life_tracker'
const HISTORY_KEY = 'av_game_history'
const MAX_HISTORY = 50

const PLAYER_COLORS = ['#c46060', '#6080c4', '#60a860', '#c4a040', '#9060c4', '#60b8c4']
const PLAYER_NAMES  = ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6']
const DICE_TYPES    = [2, 4, 6, 8, 10, 12, 20, 100]

const COUNTERS = []

const DEATH_TEXTS = [
  'Split in half by Garruk',
  'Burned to a crisp by Chandra',
  'Devoured by the Eldrazi Titans',
  'Turned to stone by a Basilisk',
  'Banished to the Blind Eternities',
  'Wrapped in webs by Ishkanah',
  'Swallowed whole by a Leviathan',
  'Crushed beneath Darksteel Colossus',
  'Phyrexian Compleatified',
  'Targeted by 3 Lightning Bolts',
  'Mill\'d out of existence',
  'Exiled by Teferi himself',
  'Caught in a Wrath of God',
  'Trampled by 50 angry Saprolings',
  'Struck by Bolt… and Bolt… and Bolt',
  'Gored by a bear with trample',
  'Forgot to pay Echo',
  'Misread the stack and lost',
  'Decked themselves with cantrips',
  'Hit for 21 commander damage',
  'Sacrificed to a Demon by their own hand',
  'Consumed by Emrakul\'s tentacles',
  'Lost a mana duel to a Llanowar Elf',
  'Ran headfirst into a Storm count of 20',
  'Napping during the draw step',
  'Mauled by a 0/1 Thopter token',
  'Tapped out at exactly the wrong moment',
  'Topdecked a land — needed gas',
  'Detonated by Goblin Grenade',
  'Infected by 10 poison',
  'Torn apart by an angry Elder Dragon',
  'Mulliganned into the shadow realm',
  'Killed by their own Earthquake',
  'Died waiting for a counterspell',
  'Obliterated — the real kind, no rebuild',
  'Annihilated by Ulamog',
  'Never resolved that crucial spell',
  'Mana-screwed into the void',
  'Eaten alive by a Wurm',
  'Executed by Teysa\'s spirit tokens',
  'Drained dry by a Vampire',
  'Petrified by a Gorgon\'s gaze',
  'Dissolved by Red Sun\'s Zenith',
  'Zombified and then killed again',
  'Bogged down in infinite combo purgatory',
  'Hit by a Fireball, a Fireball, and another Fireball',
  'Stifled their own crucial trigger',
  'Dissolved by corrupted black mana',
  'Converted into a Food token',
  'Claimed by The Abyss',
  'Returned to hand — permanently',
  'Flung as a last desperate act',
  'Crypt Incursion\'d at instant speed',
  'Died to their own Howling Mine draw',
  'Exploded in a storm of instants',
]

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
    { id: '4-2x2', cols: 2, label: '2 × 2', rotations: { 0: 180, 1: 180 } },
    { id: '4-row', cols: 4, label: 'Row',    rotations: {} },
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
    userId: seed.userId ?? null,
    life,
    hasPartner: seed.hasPartner ?? false,
    counters: seed.counters ?? {},
    cmdDmg: {},
    cmdDmg2: {},
  }
}

function migratePlayer(p) {
  return {
    ...p,
    hasPartner: p.hasPartner ?? false,
    counters: p.counters ?? {},
    cmdDmg2:  p.cmdDmg2  ?? {},
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

// ── Unified Game Log Overlay ───────────────────────────────────────────────────
function GameLogOverlay({ events, onClose }) {
  const now = Date.now()
  const fmtTime = (ts) => {
    const s = Math.floor((now - ts) / 1000)
    if (s < 5)  return 'just now'
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    return `${Math.floor(m / 60)}h ago`
  }
  const fmtDelta = (d) => d > 0 ? `+${d}` : `${d}`

  return (
    <div className={styles.cmdOverlay} onClick={onClose}>
      <div className={styles.cmdOverlayPanel} onClick={e => e.stopPropagation()}>
        <div className={styles.cmdOverlayHead}>
          <div>
            <div className={styles.cmdOverlayTitle}>📜 Game Log</div>
            <div className={styles.cmdOverlaySub}>All events this game</div>
          </div>
          <button className={styles.cmdOverlayClose} onClick={onClose}>×</button>
        </div>
        {(!events || events.length === 0) ? (
          <p className={styles.histEvtEmpty}>No events recorded yet this game.</p>
        ) : (
          <div className={styles.histEvtList}>
            {events.map((ev, i) => {
              const ct = ev.type === 'counter' ? COUNTERS.find(c => c.key === ev.key) : null
              return (
                <div key={i} className={styles.histEvtRow}>
                  <span className={styles.histEvtIcon}>
                    {ev.type === 'life'    ? '♥'
                     : ev.type === 'cmdDmg' ? '⚔'
                     : ct?.icon || '○'}
                  </span>
                  <div className={styles.histEvtDesc}>
                    <span className={styles.histEvtPlayer} style={{ color: ev.playerColor }}>
                      {ev.playerName}
                    </span>
                    {' '}
                    {ev.type === 'life' && (
                      <span>
                        <span className={ev.delta > 0 ? styles.histEvtPos : styles.histEvtNeg}>
                          {fmtDelta(ev.delta)}
                        </span>
                        {' '}life → <strong>{ev.total}</strong>
                      </span>
                    )}
                    {ev.type === 'cmdDmg' && (
                      <span>
                        <span className={styles.histEvtNeg}>{fmtDelta(ev.delta)}</span>
                        {' '}from <em>{ev.fromName}</em> → <strong>{ev.total}</strong> life
                      </span>
                    )}
                    {ev.type === 'counter' && (
                      <span>
                        <span className={ev.delta > 0 ? styles.histEvtPos : styles.histEvtNeg}>
                          {fmtDelta(ev.delta)}
                        </span>
                        {' '}{ct?.label || ev.key} → <strong>{ev.total}</strong>
                      </span>
                    )}
                  </div>
                  <span className={styles.histEvtTime}>{fmtTime(ev.ts)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Commander Damage Overlay (page-level) ──────────────────────────────────────
function CmdDmgOverlay({ player, opponents, onCmdDmgChange, onClose }) {
  if (!player || !opponents?.length) return null

  function CtrlRow({ dmg, isLethal, pid, oid, isPartner2 }) {
    const call = (d) => onCmdDmgChange(pid, oid, d, isPartner2)
    return (
      <div className={styles.cmdOverlayCtrl}>
        <button className={styles.cmdOverlayBtn} onPointerDown={e => { e.preventDefault(); call(-5) }}>−5</button>
        <button className={styles.cmdOverlayBtn} onPointerDown={e => { e.preventDefault(); call(-1) }}>−</button>
        <span className={`${styles.cmdOverlayVal} ${isLethal ? styles.cmdOverlayValLethal : ''}`}>{dmg}</span>
        <button className={styles.cmdOverlayBtn} onPointerDown={e => { e.preventDefault(); call(+1) }}>+</button>
        <button className={styles.cmdOverlayBtn} onPointerDown={e => { e.preventDefault(); call(+5) }}>+5</button>
      </div>
    )
  }

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
            const dmg   = player.cmdDmg?.[opp.id]  || 0
            const dmg2  = player.cmdDmg2?.[opp.id] || 0
            const l1    = dmg >= 21
            const l2    = opp.hasPartner && dmg2 >= 21
            return (
              <div key={opp.id}
                className={`${styles.cmdOverlayRow} ${(l1 || l2) ? styles.cmdOverlayLethal : ''}`}
                style={{ '--opc': opp.color }}>
                <div className={styles.cmdOverlayOpp}>
                  <span className={styles.cmdOverlayDot} />
                  <span className={styles.cmdOverlayOppName}>{opp.name}</span>
                  {(l1 || l2) && <span className={styles.cmdLethalBadge}>LETHAL</span>}
                  {opp.hasPartner && <span className={styles.cmdPartnerBadge}>partner</span>}
                </div>
                {opp.hasPartner ? (
                  <>
                    <div className={styles.cmdOverlayDmgRow}>
                      <span className={styles.cmdPartnerLabel}>①</span>
                      <CtrlRow dmg={dmg} isLethal={l1} pid={player.id} oid={opp.id} isPartner2={false} />
                    </div>
                    <div className={styles.cmdOverlayDmgRow}>
                      <span className={styles.cmdPartnerLabel}>②</span>
                      <CtrlRow dmg={dmg2} isLethal={l2} pid={player.id} oid={opp.id} isPartner2={true} />
                    </div>
                  </>
                ) : (
                  <CtrlRow dmg={dmg} isLethal={l1} pid={player.id} oid={opp.id} isPartner2={false} />
                )}
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

// ── Seat Layout Grid — tap-to-swap interactive seating arrangement ─────────────
function SeatLayoutGrid({ players, layout, onSwap }) {
  const [selected, setSelected] = useState(null)

  const handleClick = (idx) => {
    if (selected === null) {
      setSelected(idx)
    } else if (selected === idx) {
      setSelected(null)
    } else {
      onSwap(selected, idx)
      setSelected(null)
    }
  }

  return (
    <div className={styles.seatLayoutWrap}>
      <p className={styles.seatHint}>
        {selected !== null ? `Seat ${selected + 1} selected — tap another to swap` : 'Tap a seat, then another to swap'}
      </p>
      <div className={styles.seatLayoutGrid} style={{ '--gcols': layout?.cols ?? 2 }}>
        {players.map((p, idx) => {
          const rot = layout?.rotations?.[idx] || 0
          const isSel = selected === idx
          return (
            <div key={idx} className={styles.seatCell} onClick={() => handleClick(idx)}>
              <div
                className={`${styles.seatPanel} ${isSel ? styles.seatPanelSel : ''} ${p.claimed === false ? styles.seatPanelEmpty : ''}`}
                style={{ '--pc': p.color || 'rgba(255,255,255,0.2)', transform: `rotate(${rot}deg)` }}>
                <span className={styles.seatIdx}>{idx + 1}</span>
                <span className={styles.seatDot} style={{ background: p.color || 'rgba(255,255,255,0.3)' }} />
                <span className={styles.seatName}>{p.name || `Player ${idx + 1}`}</span>
                {p.deckName && <span className={styles.seatDeck}>{p.deckName}</span>}
                {p.claimed !== undefined && (
                  <span className={p.claimed ? styles.seatClaimed : styles.seatWaiting}>
                    {p.claimed ? '✓' : '…'}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Multiplayer Lobby Screen ───────────────────────────────────────────────────
function LobbyScreen({ session, gameConfig, onStart, onCancel }) {
  const [players,   setPlayers]   = useState([])
  const [seatOrder, setSeatOrder] = useState([])   // display order (indices into players[])
  const [starting,  setStarting]  = useState(false)
  const [copied,    setCopied]    = useState(false)
  const modeConf = MODES[gameConfig?.mode] || MODES.commander
  const life     = gameConfig?.customLife || modeConf.life
  const joinUrl  = `${window.location.origin}${import.meta.env.BASE_URL}join/${session.code}`

  useEffect(() => {
    let active = true
    const load = async () => {
      const { data } = await sb.from('game_players')
        .select('*').eq('session_id', session.id).order('slot_index')
      if (active && data) {
        setPlayers(data)
        setSeatOrder(prev => prev.length === data.length ? prev : data.map((_, i) => i))
      }
    }
    load()

    const ch = sb.channel(`lobby-host:${session.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_players' }, () => load())
      .subscribe()
    const poll = setInterval(load, 3000)

    return () => { active = false; sb.removeChannel(ch); clearInterval(poll) }
  }, [session.id])

  const swapSeats = (i, j) => {
    setSeatOrder(prev => {
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const copyLink = () => {
    navigator.clipboard.writeText(joinUrl).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2200)
    })
  }

  const handleStart = async () => {
    setStarting(true)
    try {
      const { data: freshRows } = await sb.from('game_players')
        .select('*').eq('session_id', session.id).order('slot_index')
      const rows = freshRows || players
      // Apply seat order so physical seating matches panel positions
      const ordered = seatOrder.length === rows.length
        ? seatOrder.map(i => rows[i])
        : rows

      await sb.from('game_sessions')
        .update({ status: 'playing', started_at: new Date().toISOString() })
        .eq('id', session.id)

      const gamePlayers = ordered.map((lp, i) =>
        makePlayer(i, life, {
          name: lp.player_name, color: lp.color,
          deckId: lp.deck_id, deckName: lp.deck_name,
          artCropUrl: lp.art_crop_url, userId: lp.user_id,
        })
      )
      onStart({ gamePlayers, layout: gameConfig.layout, sessionId: session.id })
    } catch { setStarting(false) }
  }

  const claimedCount = players.filter(p => p.user_id).length
  const orderedPlayers = seatOrder.length === players.length
    ? seatOrder.map(i => players[i])
    : players

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

      {/* Seat layout grid — tap to swap */}
      <SeatLayoutGrid
        players={orderedPlayers.map(p => ({
          name:     p.player_name,
          color:    p.color,
          deckName: p.deck_name,
          claimed:  !!p.user_id,
        }))}
        layout={gameConfig?.layout || defaultLayout(orderedPlayers.length)}
        onSwap={swapSeats}
      />

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
        Tap two seats to swap their positions.
      </p>
    </div>
  )
}

// ── Host Setup Screen (claim slot 0 after creating a shared lobby) ─────────────
function HostSetupScreen({ session, config, decks, onSubmit, onCancel, nickname }) {
  const { user } = useAuth()
  const init = config?.playerConfigs?.[0] || {}
  const [name,        setName]        = useState(init.name || nickname || PLAYER_NAMES[0])
  const [color,       setColor]       = useState(init.color || PLAYER_COLORS[0])
  const [deckId,      setDeckId]      = useState(init.deckId   || null)
  const [deckName,    setDeckName]    = useState(init.deckName || null)
  const [artUrl,      setArtUrl]      = useState(null)
  const [artOpen,     setArtOpen]     = useState(false)
  const [artQuery,    setArtQuery]    = useState('')
  const [artResults,  setArtResults]  = useState([])
  const [artLoading,  setArtLoading]  = useState(false)
  const [submitting,  setSubmitting]  = useState(false)

  const searchArt = async () => {
    if (!artQuery.trim()) return
    setArtLoading(true)
    try {
      const r = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(artQuery)}&unique=art&order=name`)
      const data = await r.json()
      setArtResults((data.data || []).filter(c => c.image_uris?.art_crop).slice(0, 20))
    } catch { setArtResults([]) }
    setArtLoading(false)
  }

  const handleSubmit = async () => {
    if (!user) return
    setSubmitting(true)
    try {
      await sb.from('game_players').update({
        user_id:      user.id,
        player_name:  name.trim() || PLAYER_NAMES[0],
        color,
        deck_id:      deckId   || null,
        deck_name:    deckName || null,
        art_crop_url: artUrl   || null,
        claimed_at:   new Date().toISOString(),
      }).eq('session_id', session.id).eq('slot_index', 0)
      onSubmit()
    } catch { setSubmitting(false) }
  }

  return (
    <div className={styles.setupScreen}>
      <div className={styles.setupHero}>
        <div className={styles.setupHeroGlyph}>⚔</div>
        <h1 className={styles.setupTitle}>Your Setup</h1>
        <p className={styles.setupSub}>Configure your slot before others join</p>
      </div>

      <div className={styles.setupBlock}>
        <div className={styles.setupLabel}>Your Name</div>
        <input className={styles.hostInput}
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={24}
          autoFocus />
      </div>

      <div className={styles.setupBlock}>
        <div className={styles.setupLabel}>Color</div>
        <div className={styles.hostColorRow}>
          {PLAYER_COLORS.map(c => (
            <button key={c}
              className={`${styles.hostColorDot} ${color === c ? styles.hostColorDotActive : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)} />
          ))}
        </div>
      </div>

      {decks.length > 0 && (
        <div className={styles.setupBlock}>
          <div className={styles.setupLabel}>Deck <span className={styles.hostOptional}>(optional)</span></div>
          <DeckDropdown
            value={deckId}
            valueName={deckName}
            options={decks}
            onChange={(id, n) => { setDeckId(id); setDeckName(n) }}
          />
        </div>
      )}

      <div className={styles.setupBlock}>
        <div className={styles.setupLabel}>Background Art <span className={styles.hostOptional}>(optional)</span></div>
        {artUrl && (
          <div className={styles.hostArtPreviewRow}>
            <img src={artUrl} className={styles.hostArtThumb} alt="bg art" />
            <button className={styles.hostArtClear} onClick={() => setArtUrl(null)}>✕</button>
          </div>
        )}
        <button className={styles.hostArtToggle} onClick={() => setArtOpen(v => !v)}>
          {artOpen ? '▲ Hide search' : '🖼 Search card art'}
        </button>
        {artOpen && (
          <div className={styles.hostArtBox}>
            <div className={styles.hostArtRow}>
              <input className={styles.hostArtInput}
                placeholder="Card name…"
                value={artQuery}
                onChange={e => setArtQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && searchArt()} />
              <button className={styles.hostArtBtn} onClick={searchArt} disabled={artLoading}>
                {artLoading ? '…' : '→'}
              </button>
            </div>
            {artResults.length > 0 && (
              <div className={styles.hostArtGrid}>
                {artResults.map(c => (
                  <button key={c.id}
                    className={`${styles.hostArtItem} ${artUrl === c.image_uris.art_crop ? styles.hostArtItemActive : ''}`}
                    onClick={() => { setArtUrl(c.image_uris.art_crop); setArtOpen(false) }}>
                    <img src={c.image_uris.art_crop} alt={c.name} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.hostFooter}>
        <button className={styles.hostCancelBtn} onClick={onCancel}>✕ Cancel</button>
        <button className={styles.hostSubmitBtn} onClick={handleSubmit} disabled={submitting || !name.trim()}>
          {submitting ? 'Saving…' : 'Continue to Lobby →'}
        </button>
      </div>
    </div>
  )
}

// ── Pre-game: Player Config Row ────────────────────────────────────────────────
function PlayerConfig({ index, config, decks, deckStatsMap, onChange }) {
  const [editing, setEditing] = useState(false)
  const [nameVal, setNameVal] = useState(config.name)

  const deckStats = config.deckId ? deckStatsMap?.[config.deckId] : null

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
            {deckStats && deckStats.games > 0 && (
              <span className={styles.pcDeckStats}>
                {deckStats.wins}W–{deckStats.losses}L ({deckStats.win_pct}%)
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
function PreGameSetup({ onStart, onCreateLobby, decks, history, deckStatsMap, nickname }) {
  const navigate = useNavigate()
  const [mode,        setMode]        = useState('commander')
  const [playerCount, setPlayerCount] = useState(MODES.commander.defaultPlayers)
  const [customLife,  setCustomLife]  = useState(40)
  const [layout,      setLayout]      = useState(() => defaultLayout(MODES.commander.defaultPlayers))
  const [configs, setConfigs] = useState(
    Array.from({ length: 6 }, (_, i) => ({
      name: i === 0 && nickname ? nickname : PLAYER_NAMES[i],
      color: PLAYER_COLORS[i], deckId: null, deckName: null,
    }))
  )
  const [showHistory,  setShowHistory]  = useState(false)
  const [showJoinBox,  setShowJoinBox]  = useState(false)
  const [joinCode,     setJoinCode]     = useState('')
  const joinInputRef = useRef(null)

  const updateConfig = (i, patch) =>
    setConfigs(prev => prev.map((c, idx) => idx === i ? { ...c, ...patch } : c))

  const swapConfigs = (i, j) => {
    setConfigs(prev => {
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

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

      {/* Layout + Seating combined */}
      <section className={styles.setupBlock}>
        <div className={styles.setupLabel}>Table Layout &amp; Seating</div>
        <LayoutPicker
          playerCount={playerCount}
          value={layout}
          onChange={setLayout}
        />
        <SeatLayoutGrid
          players={Array.from({ length: playerCount }, (_, i) => ({
            name: configs[i]?.name || PLAYER_NAMES[i],
            color: configs[i]?.color || PLAYER_COLORS[i],
            deckName: configs[i]?.deckName || null,
          }))}
          layout={layout || defaultLayout(playerCount)}
          onSwap={swapConfigs}
        />
      </section>

      {/* Player config */}
      <section className={styles.setupBlock}>
        <div className={styles.setupLabel}>Players</div>
        <div className={styles.playerConfigList}>
          {Array.from({ length: playerCount }, (_, i) => (
            <PlayerConfig key={i} index={i} config={configs[i]}
              decks={i === 0 ? decks : []} deckStatsMap={deckStatsMap}
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
  onLifeChange, onCounterChange, onCmdDmgChange, onNameChange, onColorChange,
  onRequestArtPicker, onRequestCmdDmgOverlay, onTogglePartner,
  showCommander, rotation = 0,
}) {
  const [editingName,        setEditingName]        = useState(false)
  const [nameInput,          setNameInput]          = useState(player.name)
  const [showPlayerSettings, setShowPlayerSettings] = useState(false)
  const [displayDelta,       setDisplayDelta]       = useState(null)
  const [deltaFading,        setDeltaFading]        = useState(false)
  const [deathText,          setDeathText]          = useState(null)

  const accumRef            = useRef(0)
  const deltaTimerRef       = useRef(null)
  const fadeTimerRef        = useRef(null)
  const holdTimerRef        = useRef(null)
  const prevLife            = useRef(player.life)

  useEffect(() => {
    const d = player.life - prevLife.current
    if (d !== 0) {
      accumRef.current += d
      setDisplayDelta(accumRef.current)
      setDeltaFading(false)
      clearTimeout(deltaTimerRef.current)
      clearTimeout(fadeTimerRef.current)
      // After 1 s of no further changes, begin the fade-out
      deltaTimerRef.current = setTimeout(() => {
        setDeltaFading(true)
        fadeTimerRef.current = setTimeout(() => {
          setDisplayDelta(null)
          setDeltaFading(false)
          accumRef.current = 0
        }, 1600)
      }, 1000)
    }
    prevLife.current = player.life
  }, [player.life])

  useEffect(() => () => {
    clearTimeout(deltaTimerRef.current)
    clearTimeout(fadeTimerRef.current)
  }, [])

  const isDead = player.life <= 0

  useEffect(() => {
    if (isDead && !deathText) {
      setDeathText(DEATH_TEXTS[Math.floor(Math.random() * DEATH_TEXTS.length)])
    } else if (!isDead) {
      setDeathText(null)
    }
  }, [isDead]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const isLow  = !isDead && player.life <= 10 && player.life > 5
  const isCrit = !isDead && player.life <= 5  && player.life > 0

  return (
    <div
      className={[
        styles.playerPanel,
        isDead  ? styles.playerDead     : '',
        isLow   ? styles.playerLifeLow  : '',
        isCrit  ? styles.playerLifeCrit : '',
        rotation === 180 ? styles.playerRotate180 :
        rotation ===  90 ? styles.playerRotate90  :
        rotation === -90 ? styles.playerRotate90n : '',
      ].filter(Boolean).join(' ')}
      style={{
        '--player-color': player.color,
        ...(player.artCropUrl ? {
          backgroundImage: `linear-gradient(rgba(10,10,18,0.55) 0%, rgba(10,10,18,0.80) 100%), url(${player.artCropUrl})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
        } : {}),
      }}>

      {/* Name + deck badge + settings cog */}
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
        <button
          className={`${styles.playerSettingsBtn} ${showPlayerSettings ? styles.playerSettingsBtnOpen : ''}`}
          onClick={() => setShowPlayerSettings(v => !v)}
          title="Player settings">⚙</button>
      </div>

      {/* Color + art-picker row — hidden by default, toggled by cog */}
      {showPlayerSettings && (
        <>
          <div className={styles.colorRow}>
            {PLAYER_COLORS.map(c => (
              <button key={c}
                className={`${styles.colorDot} ${c === player.color ? styles.colorDotActive : ''}`}
                style={{ background: c }} onClick={() => onColorChange(player.id, c)} />
            ))}
            <button onClick={() => { onRequestArtPicker(player.id); setShowPlayerSettings(false) }}
              className={styles.artPickerBtn} title="Set background art">🖼</button>
          </div>
          {showCommander && (
            <button
              className={`${styles.partnerToggleBtn} ${player.hasPartner ? styles.partnerToggleBtnActive : ''}`}
              onClick={() => onTogglePartner?.(player.id)}>
              {player.hasPartner ? '⚔⚔ Partner Commanders (on)' : '⚔ Partner Commanders'}
            </button>
          )}
        </>
      )}

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
          {displayDelta != null && (
            <span
              className={`${styles.lifeDelta} ${displayDelta > 0 ? styles.lifeDeltaUp : styles.lifeDeltaDown} ${deltaFading ? styles.lifeDeltaFade : ''}`}>
              {displayDelta > 0 ? `+${displayDelta}` : displayDelta}
            </span>
          )}
        </div>

        <button className={styles.lifeBtn} onPointerDown={e => { e.preventDefault(); adjust(+1) }}>+</button>
      </div>

      {/* Quick life change buttons */}
      <div className={styles.quickRow}>
        <button className={styles.quickBtn} onPointerDown={e => { e.preventDefault(); adjust(-10) }}>−10</button>
        <button className={styles.quickBtn} onPointerDown={e => { e.preventDefault(); adjust(-5) }}>−5</button>
        <button className={styles.quickBtn} onPointerDown={e => { e.preventDefault(); adjust(-1) }}>−</button>
        <button className={styles.quickBtn} onPointerDown={e => { e.preventDefault(); adjust(+1) }}>+</button>
        <button className={styles.quickBtn} onPointerDown={e => { e.preventDefault(); adjust(+5) }}>+5</button>
        <button className={styles.quickBtn} onPointerDown={e => { e.preventDefault(); adjust(+10) }}>+10</button>
      </div>

      {/* Commander damage bar - tap to open overlay */}
      {showCommander && opponents.length > 0 && (
        <div className={styles.cmdBar} onClick={() => onRequestCmdDmgOverlay?.(player.id)}>
          <span className={styles.cmdBarIcon}>⚔</span>
          <div className={styles.cmdBadges}>
            {opponents.map(opp => {
              const dmg  = player.cmdDmg?.[opp.id]  || 0
              const dmg2 = player.cmdDmg2?.[opp.id] || 0
              const isLethal = dmg >= 21 || (opp.hasPartner && dmg2 >= 21)
              const hasAnyDmg = dmg > 0 || (opp.hasPartner && dmg2 > 0)
              return (
                <div key={opp.id}
                  className={`${styles.cmdBadge} ${hasAnyDmg ? styles.cmdBadgeHit : ''} ${isLethal ? styles.cmdBadgeLethal : ''}`}
                  style={{ '--opc': opp.color }}>
                  <span className={styles.cmdBadgeDot} title={opp.name} />
                  {opp.hasPartner
                    ? <span className={styles.cmdBadgeVal}>{dmg}<span className={styles.cmdBadgeSep}>/</span>{dmg2}</span>
                    : <span className={styles.cmdBadgeVal}>{dmg}</span>}
                </div>
              )
            })}
          </div>
          <span className={styles.cmdBarHint}>tap to edit</span>
        </div>
      )}

      {/* Death overlay */}
      {isDead && deathText && (
        <div className={styles.deathOverlay}>
          <div className={styles.deathIcon}>💀</div>
          <div className={styles.deathText}>{deathText}</div>
        </div>
      )}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function LifeTrackerPage() {
  const { user }     = useAuth()
  const { nickname } = useSettings()

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
  const [fsPos,        setFsPos]        = useState(null) // null = CSS default (centered)
  const fsDragRef     = useRef(null)
  const fsControlsRef = useRef(null)
  const gearMenuRef   = useRef(null)
  const gearMenuFsRef = useRef(null)
  const [session,        setSession]        = useState(null)
  const [lobbyConfig,    setLobbyConfig]    = useState(null)
  const [gameSessionId,  setGameSessionId]  = useState(null)
  const [deckStatsMap, setDeckStatsMap] = useState({})
  const [gameLog,      setGameLog]      = useState([])   // flat [{ts, type, playerName, playerColor, ...}]
  const [showGameLog,  setShowGameLog]  = useState(false)

  const addGameLogEvent = useCallback((event) => {
    setGameLog(prev => [event, ...prev].slice(0, 120))
  }, [])

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

  const handleFsDragStart = useCallback((e) => {
    if (e.target.closest('button')) return // don't start drag on button clicks
    e.preventDefault()
    const rect = fsControlsRef.current?.getBoundingClientRect()
    const origX = rect ? rect.left : window.innerWidth / 2 - 50
    const origY = rect ? rect.top  : 8
    fsDragRef.current = { startX: e.clientX, startY: e.clientY, origX, origY, moved: false }

    const onMove = (e2) => {
      if (!fsDragRef.current) return
      const dx = e2.clientX - fsDragRef.current.startX
      const dy = e2.clientY - fsDragRef.current.startY
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) fsDragRef.current.moved = true
      if (!fsDragRef.current.moved) return
      setFsPos({
        x: Math.max(0, Math.min(window.innerWidth  - 120, fsDragRef.current.origX + dx)),
        y: Math.max(0, Math.min(window.innerHeight -  44, fsDragRef.current.origY + dy)),
      })
    }
    const onUp = () => {
      fsDragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

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

      // Create all player slots (unclaimed — host will claim slot 0 on next screen)
      const slots = Array.from({ length: config.playerCount }, (_, i) => ({
        session_id:  sess.id,
        slot_index:  i,
        player_name: config.playerConfigs[i]?.name  || PLAYER_NAMES[i],
        color:       config.playerConfigs[i]?.color || PLAYER_COLORS[i],
      }))
      await sb.from('game_players').insert(slots)

      setSession(sess)
      setLobbyConfig(config)
      setScreen('host-setup')  // host fills their slot before showing lobby
      return
    }
  }, [user])

  const handleCancelLobby = useCallback(async () => {
    if (session) await sb.from('game_sessions').delete().eq('id', session.id)
    setSession(null)
    setLobbyConfig(null)
    setScreen('setup')
  }, [session])

  const handleLobbyStart = useCallback(({ gamePlayers, layout, sessionId }) => {
    setPlayers(gamePlayers)
    setGameConfig({ ...lobbyConfig, layout })
    setStartedAt(Date.now())
    setGameSessionId(sessionId || null)
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
    if (!user) return
    sb.from('game_results')
      .select('deck_id,placement')
      .eq('user_id', user.id)
      .then(({ data }) => {
        if (!data) return
        const map = {}
        data.forEach(r => {
          if (!r.deck_id) return
          if (!map[r.deck_id]) map[r.deck_id] = { wins: 0, losses: 0, games: 0 }
          map[r.deck_id].games++
          if (r.placement === 1) map[r.deck_id].wins++
          else map[r.deck_id].losses++
        })
        Object.values(map).forEach(s => {
          s.win_pct = s.games > 0 ? Math.round(100 * s.wins / s.games) : 0
        })
        setDeckStatsMap(map)
      })
  }, [user])

  useEffect(() => {
    const saved = loadSession()
    if (saved?.screen === 'playing' && saved.players?.length) {
      setScreen('playing')
      setGameConfig(saved.config)
      setPlayers(saved.players.map(migratePlayer))
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
    setGameLog([])
    setShowGameLog(false)
    setShowEndDialog(false)
    setShowGameMenu(false)
  }

  const handleSaveGame = async ({ placements, notes }) => {
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

    // Persist results to Supabase for any player with an ArcaneVault deck ID
    if (user) {
      const isShared = !!gameSessionId
      const now = new Date().toISOString()
      const results = players
        .filter(p => p.deckId && (isShared ? p.userId : true))
        .map(p => ({
          session_id:   gameSessionId || null,
          user_id:      isShared ? p.userId : user.id,
          deck_id:      p.deckId,
          deck_name:    p.deckName,
          format:       gameConfig.mode,
          player_count: players.length,
          placement:    placements[p.id],
          played_at:    now,
        }))
      if (results.length > 0) {
        try {
          await sb.from('game_results').insert(results)
          // Refresh local stats map after save
          const { data } = await sb.from('game_results')
            .select('deck_id,placement').eq('user_id', user.id)
          if (data) {
            const map = {}
            data.forEach(r => {
              if (!r.deck_id) return
              if (!map[r.deck_id]) map[r.deck_id] = { wins: 0, losses: 0, games: 0 }
              map[r.deck_id].games++
              if (r.placement === 1) map[r.deck_id].wins++
              else map[r.deck_id].losses++
            })
            Object.values(map).forEach(s => {
              s.win_pct = s.games > 0 ? Math.round(100 * s.wins / s.games) : 0
            })
            setDeckStatsMap(map)
          }
        } catch (e) { console.error('game_results insert:', e) }
      }
    }
    setGameSessionId(null)
    handleNewGame()
  }

  const resetGame = () => {
    if (!gameConfig) return
    const life = gameConfig.mode === 'custom' ? gameConfig.customLife : MODES[gameConfig.mode].life
    setPlayers(prev =>
      Array.from({ length: gameConfig.playerCount }, (_, i) => ({
        ...makePlayer(i, life, prev[i]),
        life,
        counters: { poison: 0, energy: 0, experience: 0, radiation: 0 },
        cmdDmg: {}, cmdDmg2: {},
      }))
    )
    setGameLog([])
    setShowGameMenu(false)
  }

  const onLifeChange = (id, delta) => {
    const player  = players.find(p => p.id === id)
    const newLife = (player?.life ?? 0) + delta
    setPlayers(ps => ps.map(p => p.id === id ? { ...p, life: p.life + delta } : p))
    addGameLogEvent({ ts: Date.now(), type: 'life', delta, total: newLife, playerName: player?.name, playerColor: player?.color })
  }
  const onCounterChange = (id, key, delta) => {
    const player = players.find(p => p.id === id)
    const cur    = player?.counters?.[key] ?? 0
    const newVal = Math.max(0, cur + delta)
    const applied = newVal - cur
    setPlayers(ps => ps.map(p => {
      if (p.id !== id) return p
      return { ...p, counters: { ...p.counters, [key]: newVal } }
    }))
    if (applied !== 0) {
      const player = players.find(p => p.id === id)
      addGameLogEvent({ ts: Date.now(), type: 'counter', key, delta: applied, total: newVal, playerName: player?.name, playerColor: player?.color })
    }
  }
  const onCmdDmgChange = (pid, fid, delta, isPartner2 = false) => {
    const player  = players.find(p => p.id === pid)
    const opp     = players.find(p => p.id === fid)
    const field   = isPartner2 ? 'cmdDmg2' : 'cmdDmg'
    const cur     = player?.[field]?.[fid] || 0
    const newVal  = Math.max(0, cur + delta)
    const applied = newVal - cur
    setPlayers(ps => ps.map(p => {
      if (p.id !== pid) return p
      return { ...p, life: p.life - applied, [field]: { ...p[field], [fid]: newVal } }
    }))
    if (applied !== 0) {
      const newLife = (player?.life ?? 0) - applied
      const label   = isPartner2 ? `${opp?.name || '?'} ②` : (opp?.name || '?')
      addGameLogEvent({ ts: Date.now(), type: 'cmdDmg', delta: -applied, total: newLife, fromName: label, playerName: player?.name, playerColor: player?.color })
    }
  }
  const onTogglePartner = (id) => setPlayers(ps => ps.map(p => p.id === id ? { ...p, hasPartner: !p.hasPartner } : p))
  const onNameChange    = (id, name)  => setPlayers(ps => ps.map(p => p.id === id ? { ...p, name } : p))
  const onColorChange   = (id, color) => setPlayers(ps => ps.map(p => p.id === id ? { ...p, color } : p))
  const onArtChange     = (id, url)   => setPlayers(ps => ps.map(p => p.id === id ? { ...p, artCropUrl: url } : p))

  if (screen === 'setup') {
    return (
      <div className={styles.page}>
        <PreGameSetup
          onStart={handleStart}
          onCreateLobby={handleCreateLobby}
          decks={decks}
          history={history}
          deckStatsMap={deckStatsMap}
          nickname={nickname}
        />
      </div>
    )
  }

  if (screen === 'host-setup') {
    return (
      <div className={styles.page}>
        <HostSetupScreen
          session={session}
          config={lobbyConfig}
          decks={decks}
          onSubmit={() => setScreen('lobby')}
          onCancel={handleCancelLobby}
          nickname={nickname}
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
    <div className={`${styles.pageGame} ${isFullscreen ? styles.pageFullscreen : ''}`}>
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
                <button className={styles.gearMenuItem} onClick={() => { setShowGameLog(true); setShowGameMenu(false) }}>
                  📜 Game Log
                </button>
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
        <div
          className={styles.fsControls}
          ref={fsControlsRef}
          onPointerDown={handleFsDragStart}
          style={fsPos ? { left: fsPos.x, top: fsPos.y, transform: 'none' } : undefined}
        >
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
                <button className={styles.gearMenuItem} onClick={() => { setShowGameLog(true); setShowGameMenu(false) }}>
                  📜 Game Log
                </button>
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
                onCounterChange={onCounterChange}
                onCmdDmgChange={onCmdDmgChange}
                onNameChange={onNameChange}
                onColorChange={onColorChange}
                onRequestArtPicker={setArtPickerPlayer}
                onRequestCmdDmgOverlay={modeConf.commander ? setCmdDmgPlayer : null}
                onTogglePartner={onTogglePartner}
                showCommander={modeConf.commander}
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
          onClose={() => { setCmdDmgPlayer(null); pendingLogRef.current = null }} />
      )}

      {showGameLog && (
        <GameLogOverlay
          events={gameLog}
          onClose={() => setShowGameLog(false)} />
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
