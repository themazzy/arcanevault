import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { AddIcon, ChevronDownIcon, RemoveIcon, WarningIcon } from '../../icons'
import { COUNTER_DEFS, LETHAL_CMD_DMG, LETHAL_POISON, maxCmdDmg } from '../../lib/lifeGame'
import styles from './SeatPanel.module.css'

// A seat is one player's whole control surface, and the surface *is* the button:
// the left half removes life, the right half adds it. There are no ±1/±10 buttons
// because the tracker is used with a hand full of cards, often without looking —
// a target the size of half a panel survives that, a 44px button does not. It also
// gives the life numeral the entire panel to be large in.

const HOLD_DELAY_MS = 420   // deliberate hold, not an accidental long tap
const HOLD_TICK_MS = 130
const RAMP_TO_5_TICKS = 9   // ≈1.6s held
const RAMP_TO_10_TICKS = 18 // ≈2.8s held

// How long the running total stays up after the last tap. Long enough to read
// "−7" after a combat step, short enough not to hide the life total.
const DELTA_LINGER_MS = 1700

function stepForTick(ticks) {
  if (ticks > RAMP_TO_10_TICKS) return 10
  if (ticks > RAMP_TO_5_TICKS) return 5
  return 1
}

function SeatPanel({
  player,
  opponents,
  rotation = 0,
  area,
  commander = false,
  dead = false,
  deathText = null,
  onLife,
  onOpenSeat,
  onOpenDamage,
}) {
  const [pressed, setPressed] = useState(null) // 'down' | 'up' | null
  const [delta, setDelta] = useState(0)

  const hold = useRef({ timeout: null, interval: null, ticks: 0 })
  const deltaTimer = useRef(null)
  const prevLife = useRef(player.life)

  // The floating total is derived from life itself, so commander damage and
  // counter-driven changes surface the same way a direct tap does.
  useEffect(() => {
    const diff = player.life - prevLife.current
    prevLife.current = player.life
    if (diff === 0) return
    setDelta(prev => prev + diff)
    clearTimeout(deltaTimer.current)
    deltaTimer.current = setTimeout(() => setDelta(0), DELTA_LINGER_MS)
  }, [player.life])

  const stopHold = useCallback(() => {
    const h = hold.current
    if (h.timeout) clearTimeout(h.timeout)
    if (h.interval) clearInterval(h.interval)
    h.timeout = null
    h.interval = null
    h.ticks = 0
  }, [])

  useEffect(() => () => {
    clearTimeout(deltaTimer.current)
    const h = hold.current
    if (h.timeout) clearTimeout(h.timeout)
    if (h.interval) clearInterval(h.interval)
  }, [])

  const startHold = useCallback((dir) => {
    const h = hold.current
    h.ticks = 0
    h.timeout = setTimeout(() => {
      h.interval = setInterval(() => {
        h.ticks += 1
        onLife(dir * stepForTick(h.ticks))
      }, HOLD_TICK_MS)
    }, HOLD_DELAY_MS)
  }, [onLife])

  const handlePointerDown = (dir) => (e) => {
    if (e.button > 0) return
    // Capture keeps pointerup on this element even if the finger slides off,
    // so a hold can never get stuck repeating.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* not critical */ }
    setPressed(dir > 0 ? 'up' : 'down')
    onLife(dir)
    startHold(dir)
  }

  const handlePointerEnd = () => {
    stopHold()
    setPressed(null)
  }

  // A button activated from the keyboard or assistive tech fires click with
  // detail 0 and no pointerdown, so this is the only path that needs it.
  const handleClick = (dir) => (e) => {
    if (e.detail === 0) onLife(dir)
  }

  const poison = player.counters?.poison ?? 0
  const worstDamage = maxCmdDmg(player)
  const activeCounters = COUNTER_DEFS.filter(c => (player.counters?.[c.key] ?? 0) > 0)
  const tax = player.tax || [0, 0]
  const showTax = commander && (tax[0] > 0 || tax[1] > 0)

  const halfProps = (dir) => ({
    type: 'button',
    onPointerDown: handlePointerDown(dir),
    onPointerUp: handlePointerEnd,
    onPointerCancel: handlePointerEnd,
    onLostPointerCapture: handlePointerEnd,
    onClick: handleClick(dir),
    onContextMenu: (e) => e.preventDefault(),
  })

  return (
    <div className={styles.cell} style={{ gridArea: area }} data-rot={rotation}>
      <div
        className={styles.seat}
        style={{ '--pc': player.color }}
        data-dead={dead ? 'true' : undefined}
        data-art={player.artUrl ? 'true' : undefined}
      >
        {player.artUrl && (
          <img className={styles.art} src={player.artUrl} alt="" aria-hidden="true" draggable={false} />
        )}
        <div className={styles.wash} aria-hidden="true" />

        <button {...halfProps(-1)}
          className={`${styles.half} ${styles.halfDown}`}
          data-active={pressed === 'down' ? 'true' : undefined}
          aria-label={`Lose life — ${player.name}`}>
          <RemoveIcon size={15} className={styles.halfGlyph} />
        </button>
        <button {...halfProps(1)}
          className={`${styles.half} ${styles.halfUp}`}
          data-active={pressed === 'up' ? 'true' : undefined}
          aria-label={`Gain life — ${player.name}`}>
          <AddIcon size={15} className={styles.halfGlyph} />
        </button>

        <div className={styles.content}>
          <button className={styles.nameRow} onClick={onOpenSeat}
            aria-label={`Edit ${player.name}`}>
            <span className={styles.nameDot} aria-hidden="true" />
            <span className={styles.name}>{player.name}</span>
            <ChevronDownIcon size={10} className={styles.nameChevron} />
          </button>

          <div className={styles.centre}>
            <div className={styles.lifeWrap} role="status" aria-live="polite"
              aria-label={`${player.name}: ${player.life} life`}>
              <span className={styles.life}>{player.life}</span>
              {delta !== 0 && (
                <span className={styles.delta} data-sign={delta > 0 ? 'up' : 'down'} aria-hidden="true">
                  {delta > 0 ? `+${delta}` : delta}
                </span>
              )}
            </div>
            {dead && deathText && <span className={styles.deathText}>{deathText}</span>}
          </div>

          <div className={styles.footRow}>
            {dead && <span className={styles.outChip}>Out</span>}

            {activeCounters.map(c => {
              const value = player.counters[c.key]
              const lethal = c.lethalAt != null && value >= c.lethalAt
              return (
                <span key={c.key} className={styles.chip} data-alarm={lethal ? 'true' : undefined}>
                  {c.short} {value}
                </span>
              )
            })}

            {showTax && (
              <span className={styles.chip}>
                Tax {tax[0]}{tax[1] > 0 ? ` / ${tax[1]}` : ''}
              </span>
            )}

            {commander && opponents.length > 0 && (
              <button className={styles.rail} onClick={onOpenDamage}
                data-alarm={worstDamage >= LETHAL_CMD_DMG ? 'true' : undefined}
                aria-label={`Commander damage dealt to ${player.name}`}>
                {worstDamage >= LETHAL_CMD_DMG && <WarningIcon size={10} />}
                {opponents.map(o => {
                  const pair = player.dmg?.[o.id] || [0, 0]
                  const total = (pair[0] || 0) + (pair[1] || 0)
                  const worst = Math.max(pair[0] || 0, pair[1] || 0)
                  return (
                    <span key={o.id} className={styles.pip}
                      style={{ '--opc': o.color }}
                      data-hit={total > 0 ? 'true' : undefined}
                      data-lethal={worst >= LETHAL_CMD_DMG ? 'true' : undefined}>
                      {total}
                    </span>
                  )
                })}
              </button>
            )}

            {poison >= LETHAL_POISON && !dead && (
              <span className={styles.chip} data-alarm="true">Poisoned</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Memoized because a single tap otherwise re-renders every seat, every art
// image and every chip on the table. Handlers are supplied per-seat and stable
// (the page builds them from a reducer dispatch), so the default shallow
// comparison is enough.
export default memo(SeatPanel)
