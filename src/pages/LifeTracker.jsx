import { useState, useRef, useEffect } from 'react'
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

const MODES = {
  standard:    { label: 'Standard',    life: 20, commander: false, poison: false },
  commander:   { label: 'Commander',   life: 40, commander: true,  poison: true  },
  brawl:       { label: 'Brawl',       life: 25, commander: true,  poison: false },
  oathbreaker: { label: 'Oathbreaker', life: 20, commander: true,  poison: false },
  planechase:  { label: 'Planechase',  life: 20, commander: false, poison: false },
  custom:      { label: 'Custom',      life: 20, commander: false, poison: false },
}

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

// ── Custom Deck Dropdown (fully styled, no native select weirdness) ─────────────
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
        <p className={styles.cmdOverlayHint}>Adjustments also update life total · tap outside to close</p>
      </div>
    </div>
  )
}

// ── Dice Roller ───────────────────────────────────────────────────────────────
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

  const shown = rolling ? dispVals : results
  const total = results.reduce((s, v) => s + v, 0)

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
                    className={`${styles.dieFace} ${rolling ? styles.dieFaceRolling : styles.dieFaceSettled} ${!rolling && v === dieType ? styles.dieFaceMax : ''} ${!rolling && v === 1 ? styles.dieFaceMin : ''}`}>
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

// ── Random Player Picker ──────────────────────────────────────────────────────
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
              <div className={styles.pickerName} style={{ color: current.color }}>
                {current.name}
              </div>
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
function PreGameSetup({ onStart, decks, history }) {
  const [playerCount, setPlayerCount] = useState(4)
  const [mode,        setMode]        = useState('commander')
  const [customLife,  setCustomLife]  = useState(40)
  const [configs, setConfigs] = useState(
    Array.from({ length: 6 }, (_, i) => ({
      name: PLAYER_NAMES[i], color: PLAYER_COLORS[i], deckId: null, deckName: null,
    }))
  )
  const [showHistory, setShowHistory] = useState(false)

  const updateConfig = (i, patch) =>
    setConfigs(prev => prev.map((c, idx) => idx === i ? { ...c, ...patch } : c))

  const handleStart = () => {
    const life = mode === 'custom' ? customLife : MODES[mode].life
    const players = Array.from({ length: playerCount }, (_, i) => makePlayer(i, life, configs[i]))
    onStart({ playerCount, mode, customLife, players, startedAt: Date.now() })
  }

  return (
    <div className={styles.setupScreen}>
      <div className={styles.setupHero}>
        <div className={styles.setupHeroGlyph}>♥</div>
        <h1 className={styles.setupTitle}>Life Tracker</h1>
        <p className={styles.setupSub}>Configure your game</p>
      </div>

      <section className={styles.setupBlock}>
        <div className={styles.setupLabel}>Game Mode</div>
        <div className={styles.modeGrid}>
          {Object.entries(MODES).map(([key, conf]) => (
            <button key={key}
              className={`${styles.modeCard} ${mode === key ? styles.modeCardActive : ''}`}
              onClick={() => setMode(key)}>
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

      <section className={styles.setupBlock}>
        <div className={styles.setupLabel}>Number of Players</div>
        <div className={styles.countRow}>
          {[2, 3, 4, 5, 6].map(n => (
            <button key={n}
              className={`${styles.countChip} ${playerCount === n ? styles.countChipActive : ''}`}
              onClick={() => setPlayerCount(n)}>{n}</button>
          ))}
        </div>
      </section>

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
  showCommander, showPoison, inverted,
}) {
  const [editingName, setEditingName] = useState(false)
  const [nameInput,   setNameInput]   = useState(player.name)
  const [lastDelta,   setLastDelta]   = useState(null)
  const deltaTimerRef = useRef(null)
  const holdTimerRef  = useRef(null)
  const prevLife      = useRef(player.life)

  // Life delta animation
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

  // Long-hold on life total → commander damage overlay
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

  const cmdTotal = Object.values(player.cmdDmg || {}).reduce((s, v) => s + v, 0)
  const isDead   = player.life <= 0 || player.poison >= 10

  return (
    <div
      className={`${styles.playerPanel} ${isDead ? styles.playerDead : ''} ${inverted ? styles.playerInverted : ''}`}
      style={{
        '--player-color': player.color,
        ...(player.artCropUrl ? {
          backgroundImage: `linear-gradient(rgba(10,10,18,0.55) 0%, rgba(10,10,18,0.80) 100%), url(${player.artCropUrl})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
        } : {}),
      }}>

      {/* Color row */}
      <div className={styles.colorRow}>
        {PLAYER_COLORS.map(c => (
          <button key={c}
            className={`${styles.colorDot} ${c === player.color ? styles.colorDotActive : ''}`}
            style={{ background: c }} onClick={() => onColorChange(player.id, c)} />
        ))}
        <button onClick={() => onRequestArtPicker(player.id)} title="Set art background"
          style={{ background: 'none', border: 'none', color: player.artCropUrl ? 'var(--gold)' : 'var(--text-faint)', cursor: 'pointer', fontSize: '0.85rem', padding: '0 2px', opacity: 0.8 }}>
          🖼
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
          {showCommander && opponents.length > 0 && cmdTotal > 0 && (
            <span className={styles.cmdTotalBadge} title={`${cmdTotal} total cmd dmg`}>⚔{cmdTotal}</span>
          )}
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

      {/* Commander damage — always visible, compact */}
      {showCommander && opponents.length > 0 && (
        <div className={styles.cmdBar}>
          <button
            className={styles.cmdBarLabel}
            onClick={() => onRequestCmdDmgOverlay?.(player.id)}
            title="Open commander damage editor">
            ⚔
          </button>
          <div className={styles.cmdBadges}>
            {opponents.map(opp => {
              const dmg = player.cmdDmg?.[opp.id] || 0
              return (
                <div key={opp.id}
                  className={`${styles.cmdBadge} ${dmg > 0 ? styles.cmdBadgeHit : ''} ${dmg >= 21 ? styles.cmdBadgeLethal : ''}`}
                  style={{ '--opc': opp.color }}>
                  <span className={styles.cmdBadgeDot} title={opp.name} />
                  <button className={styles.cmdBadgeBtn}
                    onPointerDown={e => { e.preventDefault(); onCmdDmgChange(player.id, opp.id, -1) }}>−</button>
                  <span className={styles.cmdBadgeVal}>{dmg}</span>
                  <button className={styles.cmdBadgeBtn}
                    onPointerDown={e => { e.preventDefault(); onCmdDmgChange(player.id, opp.id, +1) }}>+</button>
                </div>
              )
            })}
          </div>
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
  const gearMenuRef = useRef(null)

  // Close gear menu on outside click
  useEffect(() => {
    if (!showGameMenu) return
    const handler = e => { if (!gearMenuRef.current?.contains(e.target)) setShowGameMenu(false) }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [showGameMenu])

  // Load decks — filter client-side as well in case Supabase filter doesn't match
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

  // Restore session on mount
  useEffect(() => {
    const saved = loadSession()
    if (saved?.screen === 'playing' && saved.players?.length) {
      setScreen('playing')
      setGameConfig(saved.config)
      setPlayers(saved.players)
      setStartedAt(saved.startedAt)
    }
  }, [])

  // Persist active game state
  useEffect(() => {
    if (screen === 'playing') {
      saveSession({ screen, config: gameConfig, players, startedAt })
    }
  }, [screen, gameConfig, players, startedAt])

  // ── Game handlers ──
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

  // ── Player state handlers ──
  const onLifeChange   = (id, delta) => setPlayers(ps => ps.map(p => p.id === id ? { ...p, life: p.life + delta } : p))
  const onPoisonChange = (id, delta) => setPlayers(ps => ps.map(p => p.id === id ? { ...p, poison: Math.max(0, p.poison + delta) } : p))

  // Commander damage also adjusts life total directly
  const onCmdDmgChange = (pid, fid, delta) => setPlayers(ps => ps.map(p => {
    if (p.id !== pid) return p
    const cur      = p.cmdDmg?.[fid] || 0
    const newVal   = Math.max(0, cur + delta)
    const applied  = newVal - cur               // actual change (respects clamp to 0)
    return { ...p, life: p.life - applied, cmdDmg: { ...p.cmdDmg, [fid]: newVal } }
  }))

  const onNameChange  = (id, name)  => setPlayers(ps => ps.map(p => p.id === id ? { ...p, name } : p))
  const onColorChange = (id, color) => setPlayers(ps => ps.map(p => p.id === id ? { ...p, color } : p))
  const onArtChange   = (id, url)   => setPlayers(ps => ps.map(p => p.id === id ? { ...p, artCropUrl: url } : p))

  // ── Setup screen ──
  if (screen === 'setup') {
    return (
      <div className={styles.page}>
        <PreGameSetup onStart={handleStart} decks={decks} history={history} />
      </div>
    )
  }

  // ── Active game ──
  const modeConf  = MODES[gameConfig?.mode] || MODES.commander
  const count     = players.length
  const gridClass = { 2: styles.grid2, 3: styles.grid3, 4: styles.grid4, 5: styles.grid5, 6: styles.grid6 }[count] || styles.grid4
  const halfPoint = Math.ceil(count / 2)

  return (
    <div className={styles.page}>
      {/* ── Top bar ── */}
      <div className={styles.topBar}>
        <div className={styles.topLeft}>
          <span className={styles.pageTitle}>♥ Life Tracker</span>
          <span className={styles.modeLabel}>{modeConf.label}</span>
        </div>
        <div className={styles.topRight}>
          {/* Gear menu */}
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

      {/* ── Player grid ── */}
      <div className={`${styles.grid} ${gridClass}`}>
        {players.map((player, idx) => (
          <PlayerPanel
            key={player.id}
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
            inverted={idx >= halfPoint}
          />
        ))}
      </div>

      {/* ── Page-level overlays (safe from transform:rotate) ── */}
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

      {showDice && <DiceRoller onClose={() => setShowDice(false)} />}

      {showPicker && (
        <RandomPicker players={players} onClose={() => setShowPicker(false)} />
      )}

      {showEndDialog && (
        <EndGameDialog
          players={players}
          onSave={handleSaveGame}
          onCancel={() => setShowEndDialog(false)} />
      )}
    </div>
  )
}
