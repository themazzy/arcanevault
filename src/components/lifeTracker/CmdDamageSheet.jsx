import { Button } from '../UI'
import { AddIcon, RemoveIcon } from '../../icons'
import { LETHAL_CMD_DMG } from '../../lib/lifeGame'
import Sheet from './Sheet'
import useHoldRepeat from './useHoldRepeat'
import useLifeDelta from './useLifeDelta'
import c from './controls.module.css'

// Commander damage dealt TO one seat.
//
// One card per opponent, one bar inside it per commander: commander damage is
// counted per commander, so a partner pair is two clocks to 21 that happen to
// belong to the same player. Cards rather than a list because the list ran to ten
// rows at a full table with partners — the sheet is opened mid-combat, and
// scrolling to find the player who just swung is the one thing it must not ask.
//
// Damage moves life in the same reducer action, so the two can never disagree —
// the old implementation applied them as separate state writes.

export default function CmdDamageSheet({ player, opponents, rotation, onDamage, onClose }) {
  // Same readout as the seat panel, because the sheet covers the seat: without it
  // you are dealing damage to a life total you cannot see.
  const delta = useLifeDelta(player.life)

  const worst = Math.max(
    0,
    ...opponents.flatMap(o => {
      const pair = player.dmg?.[o.id] || [0, 0]
      return [pair[0] || 0, pair[1] || 0]
    }),
  )

  return (
    <Sheet
      title={`Damage to ${player.name}`}
      subtitle={
        worst >= LETHAL_CMD_DMG
          ? `Lethal — ${worst} from one commander`
          : `${LETHAL_CMD_DMG} from a single commander is lethal`
      }
      aside={
        <div className={c.lifeReadout}>
          <span className={c.lifeValue}>{player.life}</span>
          <span className={c.lifeUnit}>life</span>
          {delta !== 0 && (
            <span className={c.deltaPill} data-sign={delta > 0 ? 'up' : 'down'}>
              {delta > 0 ? `+${delta}` : delta}
            </span>
          )}
        </div>
      }
      size="xl"
      rotation={rotation}
      onClose={onClose}
      footer={<Button variant="primary" block onClick={onClose}>Done</Button>}
    >
      <div className={c.foeGrid}>
        {opponents.map(opponent => {
          const pair = player.dmg?.[opponent.id] || [0, 0]
          return (
            <div key={opponent.id} className={c.foeCard}>
              <div className={c.foeHead}>
                <span className={c.stepDot} style={{ '--sw': opponent.color }} aria-hidden="true" />
                <span className={c.foeName}>{opponent.name}</span>
              </div>

              <DamageBar
                label={opponent.hasPartner ? 'First' : 'Commander'}
                name={opponent.hasPartner
                  ? `${opponent.name}, first commander`
                  : opponent.name}
                value={pair[0] || 0}
                onStep={d => onDamage(opponent.id, 0, d)}
              />

              {opponent.hasPartner && (
                <DamageBar
                  label="Second"
                  name={`${opponent.name}, second commander`}
                  value={pair[1] || 0}
                  onStep={d => onDamage(opponent.id, 1, d)}
                />
              )}
            </div>
          )
        })}
      </div>

      <p className={c.hint}>
        Adding damage here also removes that much life.
      </p>
    </Sheet>
  )
}

// The bar *is* the button, the way a seat is: left pane removes damage, right pane
// adds it, and the number in the middle belongs to both. Same gesture as the
// table, and it turns a 58px target into half a card.
//
// Holding repeats at 1 rather than accelerating the way life does — commander
// damage is a race to 21, and a ramp to 10 a tick would fly past the only number
// on the bar that decides anything.
function DamageBar({ label, name, value, onStep }) {
  const { pressed, pressProps } = useHoldRepeat(onStep, { ramp: false })
  const lethal = value >= LETHAL_CMD_DMG
  const empty = value <= 0
  // Lethal is the more urgent thing a one-word tag can say, so it takes the slot.
  const tag = lethal ? 'Lethal' : label

  return (
    <div className={c.dmgBar} data-alarm={lethal ? 'true' : undefined}>
      <button {...pressProps(-1)}
        className={`${c.dmgPane} ${c.dmgPaneDown}`}
        data-active={pressed === -1 ? 'true' : undefined}
        disabled={empty}
        aria-label={`Remove damage from ${name}`}>
        <RemoveIcon size={16} className={c.dmgGlyph} />
      </button>

      {/* Transparent to pointers so the numeral is part of both panes rather than
          a dead strip down the middle of the control. */}
      <span className={c.dmgReadout} aria-hidden="true">
        <span className={c.dmgLabel} data-alarm={lethal ? 'true' : undefined}>{tag}</span>
        <span className={c.dmgValue}>{value}</span>
      </span>

      <button {...pressProps(1)}
        className={`${c.dmgPane} ${c.dmgPaneUp}`}
        data-active={pressed === 1 ? 'true' : undefined}
        aria-label={`Add damage from ${name}`}>
        <AddIcon size={16} className={c.dmgGlyph} />
      </button>
    </div>
  )
}
