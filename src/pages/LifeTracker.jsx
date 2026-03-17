import { useState, useCallback, useRef, useEffect } from 'react'
import { Modal, Button } from '../components/UI'
import styles from './LifeTracker.module.css'

// ── Constants ──────────────────────────────────────────────────────────────────

const PLAYER_COLORS = ['#c46060', '#6080c4', '#60a860', '#c4a040', '#9060c4', '#60b8c4']
const PLAYER_NAMES  = ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6']

const MODES = {
  standard:  { label: 'Standard',  life: 20,  commander: false, poison: false },
  commander: { label: 'Commander', life: 40,  commander: true,  poison: true  },
  brawl:     { label: 'Brawl',     life: 25,  commander: true,  poison: false },
  oathbreaker:{ label: 'Oathbreaker', life: 20, commander: true, poison: false },
  planechase:{ label: 'Planechase',life: 20,  commander: false, poison: false },
  custom:    { label: 'Custom',    life: 20,  commander: false, poison: false },
}

function makePlayer(i, life) {
  return {
    id: i,
    name: PLAYER_NAMES[i],
    color: PLAYER_COLORS[i],
    artCropUrl: null,
    life,
    poison: 0,
    cmdDmg: {},     // keyed by opponent id, value = dmg taken
    history: [],    // last few deltas
    editing: false,
  }
}

// ── Art picker for life tracker ───────────────────────────────────────────────
function LifeArtPicker({ onSelect, onClear, onClose }) {
  const [query, setQuery]   = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])

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
      <button onClick={onClear} style={{ background: 'none', border: '1px solid rgba(200,70,60,0.3)', borderRadius: 3, padding: '4px 12px', color: '#e08878', fontSize: '0.76rem', cursor: 'pointer', marginBottom: 10 }}>
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

// ── Life delta animation hook ──────────────────────────────────────────────────
function useDeltaQueue(initial = 0) {
  const [display, setDisplay] = useState(initial)
  const [delta,   setDelta]   = useState(null)  // { value, key }
  const timerRef = useRef(null)

  const update = useCallback((newVal) => {
    setDelta(d => {
      const prev = d?.accumulated ?? display
      return { value: newVal - prev, accumulated: newVal, key: Date.now() }
    })
    setDisplay(newVal)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setDelta(null), 1800)
  }, [display])

  useEffect(() => () => clearTimeout(timerRef.current), [])
  return { display, delta, update, setDisplay }
}

// ── Single player panel ────────────────────────────────────────────────────────
function PlayerPanel({ player, opponents, onLifeChange, onPoisonChange, onCmdDmgChange, onNameChange, onColorChange, onArtChange, showCommander, showPoison, dead }) {

  const [editingName, setEditingName]   = useState(false)
  const [nameInput, setNameInput]       = useState(player.name)
  const [showCmdDmg, setShowCmdDmg]     = useState(false)
  const [showArtPicker, setShowArtPicker] = useState(false)
  const [lastDelta, setLastDelta]       = useState(null)
  const deltaTimer = useRef(null)
  const prevLife   = useRef(player.life)

  // Track delta for animation
  useEffect(() => {
    const d = player.life - prevLife.current
    if (d !== 0) {
      setLastDelta(d)
      clearTimeout(deltaTimer.current)
      deltaTimer.current = setTimeout(() => setLastDelta(null), 1600)
    }
    prevLife.current = player.life
  }, [player.life])

  useEffect(() => () => clearTimeout(deltaTimer.current), [])

  const adjust = (amount) => onLifeChange(player.id, amount)

  const handleNameSubmit = () => {
    setEditingName(false)
    onNameChange(player.id, nameInput.trim() || player.name)
  }

  const cmdTotal = Object.values(player.cmdDmg || {}).reduce((s, v) => s + v, 0)
  const isDead = dead || player.life <= 0 || player.poison >= 10

  return (
    <div
      className={`${styles.playerPanel} ${isDead ? styles.playerDead : ''}`}
      style={{
        '--player-color': player.color,
        ...(player.artCropUrl ? {
          backgroundImage: `linear-gradient(rgba(10,10,18,0.50) 0%, rgba(10,10,18,0.75) 100%), url(${player.artCropUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        } : {}),
      }}
    >
      {/* Color + art picker row */}
      <div className={styles.colorRow}>
        {PLAYER_COLORS.map(c => (
          <button key={c} className={`${styles.colorDot} ${c === player.color ? styles.colorDotActive : ''}`}
            style={{ background: c }} onClick={() => onColorChange(player.id, c)} />
        ))}
        <button
          onClick={() => setShowArtPicker(true)}
          title="Set art background"
          style={{ background: 'none', border: 'none', color: player.artCropUrl ? 'var(--gold)' : 'var(--text-faint)', cursor: 'pointer', fontSize: '0.85rem', padding: '0 2px', opacity: 0.8 }}>
          🖼
        </button>
      </div>

      {/* Art picker modal */}
      {showArtPicker && (
        <LifeArtPicker
          onSelect={url => { onArtChange(player.id, url); setShowArtPicker(false) }}
          onClear={() => { onArtChange(player.id, null); setShowArtPicker(false) }}
          onClose={() => setShowArtPicker(false)}
        />
      )}

      {/* Name */}
      <div className={styles.nameRow}>
        {editingName
          ? <input
              className={styles.nameInput}
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={e => { if (e.key === 'Enter') handleNameSubmit() }}
              autoFocus
            />
          : <button className={styles.nameBtn} onClick={() => { setEditingName(true); setNameInput(player.name) }}>
              {player.name}
            </button>
        }
      </div>

      {/* Life total area */}
      <div className={styles.lifeArea}>
        <button className={styles.lifeBtn} onPointerDown={e => { e.preventDefault(); adjust(-1) }}>−</button>

        <div className={styles.lifeTotalWrap}>
          <span className={`${styles.lifeTotal} ${player.life <= 5 ? styles.lifeLow : ''} ${player.life <= 0 ? styles.lifeDead : ''}`}>
            {player.life}
          </span>
          {lastDelta != null && (
            <span key={lastDelta + Date.now()} className={`${styles.lifeDelta} ${lastDelta > 0 ? styles.lifeDeltaUp : styles.lifeDeltaDown}`}>
              {lastDelta > 0 ? `+${lastDelta}` : lastDelta}
            </span>
          )}
        </div>

        <button className={styles.lifeBtn} onPointerDown={e => { e.preventDefault(); adjust(+1) }}>+</button>
      </div>

      {/* Quick ±5 buttons */}
      <div className={styles.quickRow}>
        <button className={styles.quickBtn} onClick={() => adjust(-5)}>−5</button>
        <button className={styles.quickBtn} onClick={() => adjust(-10)}>−10</button>
        <button className={styles.quickBtn} onClick={() => adjust(+5)}>+5</button>
        <button className={styles.quickBtn} onClick={() => adjust(+10)}>+10</button>
      </div>

      {/* Poison counters */}
      {showPoison && (
        <div className={styles.poisonRow}>
          <span className={styles.poisonLabel}>☠ Poison</span>
          <div className={styles.counterRow}>
            <button className={styles.counterBtn} onClick={() => onPoisonChange(player.id, -1)}>−</button>
            <span className={`${styles.counterVal} ${player.poison >= 10 ? styles.counterDead : ''}`}>{player.poison}</span>
            <button className={styles.counterBtn} onClick={() => onPoisonChange(player.id, +1)}>+</button>
          </div>
        </div>
      )}

      {/* Commander damage */}
      {showCommander && opponents.length > 0 && (
        <div className={styles.cmdSection}>
          <button className={styles.cmdToggle} onClick={() => setShowCmdDmg(v => !v)}>
            ⚔ Cmdr dmg ({cmdTotal}) {showCmdDmg ? '▲' : '▼'}
          </button>
          {showCmdDmg && (
            <div className={styles.cmdList}>
              {opponents.map(opp => (
                <div key={opp.id} className={styles.cmdRow}>
                  <span className={styles.cmdOppName} style={{ color: opp.color }}>
                    {opp.name}
                  </span>
                  <div className={styles.counterRow}>
                    <button className={styles.counterBtn}
                      onClick={() => onCmdDmgChange(player.id, opp.id, -1)}>−</button>
                    <span className={`${styles.counterVal} ${(player.cmdDmg?.[opp.id] || 0) >= 21 ? styles.counterDead : ''}`}>
                      {player.cmdDmg?.[opp.id] || 0}
                    </span>
                    <button className={styles.counterBtn}
                      onClick={() => onCmdDmgChange(player.id, opp.id, +1)}>+</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function LifeTrackerPage() {
  const [playerCount, setPlayerCount] = useState(4)
  const [mode, setMode]               = useState('commander')
  const [customLife, setCustomLife]   = useState(40)
  const [players, setPlayers]         = useState(() =>
    Array.from({ length: 4 }, (_, i) => makePlayer(i, 40))
  )
  const [showSetup, setShowSetup]     = useState(false)

  const modeConf = MODES[mode]
  const startLife = mode === 'custom' ? customLife : modeConf.life

  // Rebuild players when count or mode changes
  const resetGame = useCallback((count = playerCount, newMode = mode, newCustomLife = customLife) => {
    const life = newMode === 'custom' ? newCustomLife : MODES[newMode].life
    setPlayers(prev => Array.from({ length: count }, (_, i) => ({
      ...makePlayer(i, life),
      name:  prev[i]?.name  || PLAYER_NAMES[i],
      color: prev[i]?.color || PLAYER_COLORS[i],
    })))
  }, [playerCount, mode, customLife])

  const handleCountChange = (n) => {
    setPlayerCount(n)
    resetGame(n, mode, customLife)
  }

  const handleModeChange = (m) => {
    setMode(m)
    resetGame(playerCount, m, customLife)
  }

  const handleCustomLifeChange = (v) => {
    setCustomLife(v)
    if (mode === 'custom') resetGame(playerCount, 'custom', v)
  }

  const onLifeChange = (id, delta) => {
    setPlayers(ps => ps.map(p => p.id === id ? { ...p, life: p.life + delta } : p))
  }

  const onPoisonChange = (id, delta) => {
    setPlayers(ps => ps.map(p => p.id === id
      ? { ...p, poison: Math.max(0, p.poison + delta) }
      : p))
  }

  const onCmdDmgChange = (playerId, fromId, delta) => {
    setPlayers(ps => ps.map(p => {
      if (p.id !== playerId) return p
      const cur = p.cmdDmg?.[fromId] || 0
      return { ...p, cmdDmg: { ...p.cmdDmg, [fromId]: Math.max(0, cur + delta) } }
    }))
  }

  const onNameChange = (id, name) => {
    setPlayers(ps => ps.map(p => p.id === id ? { ...p, name } : p))
  }

  const onColorChange = (id, color) => {
    setPlayers(ps => ps.map(p => p.id === id ? { ...p, color } : p))
  }

  const onArtChange = (id, artCropUrl) => {
    setPlayers(ps => ps.map(p => p.id === id ? { ...p, artCropUrl } : p))
  }

  // Grid layout based on player count
  const gridClass = {
    2: styles.grid2,
    3: styles.grid3,
    4: styles.grid4,
    5: styles.grid5,
    6: styles.grid6,
  }[playerCount] || styles.grid4

  return (
    <div className={styles.page}>
      {/* ── Top bar ── */}
      <div className={styles.topBar}>
        <div className={styles.topLeft}>
          <span className={styles.pageTitle}>♥ Life Tracker</span>
          <span className={styles.modeLabel}>{modeConf.label} · {startLife} life</span>
        </div>
        <div className={styles.topRight}>
          <button className={`${styles.topBtn} ${showSetup ? styles.topBtnActive : ''}`}
            onClick={() => setShowSetup(v => !v)}>
            Setup {showSetup ? '▲' : '▼'}
          </button>
          <button className={styles.resetBtn} onClick={() => resetGame()}>
            ↺ Reset
          </button>
        </div>
      </div>

      {/* ── Setup panel ── */}
      {showSetup && (
        <div className={styles.setupPanel}>
          <div className={styles.setupSection}>
            <div className={styles.setupLabel}>Players</div>
            <div className={styles.setupChips}>
              {[2, 3, 4, 5, 6].map(n => (
                <button key={n}
                  className={`${styles.chip} ${playerCount === n ? styles.chipActive : ''}`}
                  onClick={() => handleCountChange(n)}>{n}</button>
              ))}
            </div>
          </div>

          <div className={styles.setupSection}>
            <div className={styles.setupLabel}>Game Mode</div>
            <div className={styles.setupChips}>
              {Object.entries(MODES).map(([key, conf]) => (
                <button key={key}
                  className={`${styles.chip} ${mode === key ? styles.chipActive : ''}`}
                  onClick={() => handleModeChange(key)}>{conf.label}</button>
              ))}
            </div>
          </div>

          {mode === 'custom' && (
            <div className={styles.setupSection}>
              <div className={styles.setupLabel}>Starting Life</div>
              <div className={styles.setupChips}>
                {[10, 20, 25, 30, 40, 50].map(v => (
                  <button key={v}
                    className={`${styles.chip} ${customLife === v ? styles.chipActive : ''}`}
                    onClick={() => handleCustomLifeChange(v)}>{v}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Player grid ── */}
      <div className={`${styles.grid} ${gridClass}`}>
        {players.map(player => (
          <PlayerPanel
            key={player.id}
            player={player}
            opponents={players.filter(p => p.id !== player.id)}
            onLifeChange={onLifeChange}
            onPoisonChange={onPoisonChange}
            onCmdDmgChange={onCmdDmgChange}
            onNameChange={onNameChange}
            onColorChange={onColorChange}
            onArtChange={onArtChange}
            showCommander={modeConf.commander}
            showPoison={modeConf.poison}
          />
        ))}
      </div>
    </div>
  )
}
