import { memo } from 'react'
import { AddIcon, ChevronDownIcon, RemoveIcon, WarningIcon } from '../../icons'
import { COUNTER_DEFS, LETHAL_CMD_DMG, LETHAL_POISON, maxCmdDmg } from '../../lib/lifeGame'
import useHoldRepeat from './useHoldRepeat'
import useLifeDelta from './useLifeDelta'
import styles from './SeatPanel.module.css'

// A seat is one player's whole control surface, and the surface *is* the button:
// the left half removes life, the right half adds it. There are no ±1/±10 buttons
// because the tracker is used with a hand full of cards, often without looking —
// a target the size of half a panel survives that, a 44px button does not. It also
// gives the life numeral the entire panel to be large in.

// Commander damage is tracked per commander, so a partner pair is two separate
// clocks to 21 and never one combined total. The rail reads out the same slots
// the damage sheet edits.
function damageSlots(player, opponent) {
  const pair = player.dmg?.[opponent.id] || [0, 0]
  return opponent.hasPartner ? [pair[0] || 0, pair[1] || 0] : [pair[0] || 0]
}

function damageLabel(player, opponents) {
  const dealt = opponents
    .map(o => `${o.name} ${damageSlots(player, o).join(' and ')}`)
    .join(', ')
  return `Commander damage to ${player.name}: ${dealt}. Open to edit.`
}

function SeatPanel({
  player,
  seatIndex,
  opponents,
  rotation = 0,
  area,
  commander = false,
  dead = false,
  deathText = null,
  swapping = false,
  picked = false,
  dropTarget = false,
  onLife,
  onOpenSeat,
  onOpenDamage,
  onSwapPointerDown,
  onSwapPointerMove,
  onSwapPointerUp,
  onSwapActivate,
}) {
  const delta = useLifeDelta(player.life)
  const { pressed, pressProps } = useHoldRepeat(onLife)

  const poison = player.counters?.poison ?? 0
  const worstDamage = maxCmdDmg(player)
  const activeCounters = COUNTER_DEFS.filter(c => (player.counters?.[c.key] ?? 0) > 0)
  const tax = player.tax || [0, 0]
  const showTax = commander && (tax[0] > 0 || tax[1] > 0)

  // data-seat-index lives on the cell, not the seat: the page hit-tests with
  // closest() so an ancestor works, and a cell is never transformed, so its
  // bounding box is exact for measuring the swap arrow's endpoints.
  return (
    <div className={styles.cell} style={{ gridArea: area }} data-rot={rotation}
      data-seat-index={seatIndex}>
      <div
        className={styles.seat}
        style={{ '--pc': player.color }}
        data-dead={dead ? 'true' : undefined}
        data-art={player.artUrl ? 'true' : undefined}
        data-picked={picked ? 'true' : undefined}
        data-drop={dropTarget ? 'true' : undefined}
        data-swapping={swapping ? 'true' : undefined}
      >
        {player.artUrl && (
          <img className={styles.art} src={player.artUrl} alt="" aria-hidden="true" draggable={false} />
        )}
        <div className={styles.wash} aria-hidden="true" />

        {/* In swap mode the split-tap is replaced outright rather than merely
            covered: a drag starting on a life half would change life on
            pointerdown before the drag was recognised. One full-panel button also
            makes swapping reachable by keyboard. */}
        {swapping ? (
          <button
            type="button"
            className={styles.swapGrab}
            onPointerDown={e => { if (e.button === 0) onSwapPointerDown?.(seatIndex, e) }}
            onPointerMove={e => onSwapPointerMove?.(seatIndex, e)}
            onPointerUp={e => onSwapPointerUp?.(seatIndex, e)}
            onPointerCancel={e => onSwapPointerUp?.(seatIndex, e)}
            onLostPointerCapture={e => onSwapPointerUp?.(seatIndex, e)}
            onClick={e => { if (e.detail === 0) onSwapActivate?.(seatIndex) }}
            onContextMenu={e => e.preventDefault()}
            aria-pressed={picked}
            aria-label={picked
              ? `${player.name} picked up. Choose a seat to swap with.`
              : `Move ${player.name} to another seat`}
          />
        ) : (
          <>
            <button {...pressProps(-1)}
              className={`${styles.half} ${styles.halfDown}`}
              data-active={pressed === -1 ? 'true' : undefined}
              aria-label={`Lose life — ${player.name}`}>
              <RemoveIcon size={15} className={styles.halfGlyph} />
            </button>
            <button {...pressProps(1)}
              className={`${styles.half} ${styles.halfUp}`}
              data-active={pressed === 1 ? 'true' : undefined}
              aria-label={`Gain life — ${player.name}`}>
              <AddIcon size={15} className={styles.halfGlyph} />
            </button>
          </>
        )}

        <div className={styles.content}>
          <button className={styles.nameRow} onClick={onOpenSeat}
            aria-label={`Edit ${player.name}`}>
            <span className={styles.nameDot} aria-hidden="true" />
            <span className={styles.name}>{player.name}</span>
            <ChevronDownIcon size={10} className={styles.nameChevron} />
          </button>

          {/* Pinned to the life band rather than hung off the numeral. The numeral
              moves when a seat goes out and the epitaph claims its space, and a
              readout that rides along with it slides under the name row — or off
              the panel — exactly on the blow you most want to read. */}
          {delta !== 0 && (
            <span className={styles.delta} data-sign={delta > 0 ? 'up' : 'down'} aria-hidden="true">
              {delta > 0 ? `+${delta}` : delta}
            </span>
          )}

          <div className={styles.centre} data-out={dead && deathText ? 'true' : undefined}>
            <div className={styles.lifeWrap} role="status" aria-live="polite"
              aria-label={`${player.name}: ${player.life} life`}>
              <span className={styles.life}>{player.life}</span>
            </div>
            {/* Always mounted, collapsed to nothing while the seat is alive: the
                epitaph opens this row from 0fr, which is what gives the numeral a
                glide up instead of a jump. */}
            <div className={styles.deathSlot}>
              {dead && deathText && <span className={styles.deathText}>{deathText}</span>}
            </div>
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
                aria-label={damageLabel(player, opponents)}>
                {worstDamage >= LETHAL_CMD_DMG && (
                  <WarningIcon size={12} className={styles.railWarn} />
                )}
                {opponents.map(o => (
                  <span key={o.id} className={styles.foe} style={{ '--opc': o.color }}>
                    {damageSlots(player, o).map((value, slot) => (
                      <span key={slot} className={styles.pip}
                        data-hit={value > 0 ? 'true' : undefined}
                        data-lethal={value >= LETHAL_CMD_DMG ? 'true' : undefined}>
                        {value}
                      </span>
                    ))}
                  </span>
                ))}
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
