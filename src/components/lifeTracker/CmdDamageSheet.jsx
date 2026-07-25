import { Button } from '../UI'
import { AddIcon, RemoveIcon } from '../../icons'
import { LETHAL_CMD_DMG } from '../../lib/lifeGame'
import Sheet from './Sheet'
import c from './controls.module.css'

// Commander damage dealt TO one seat, one row per opposing commander.
//
// Damage moves life in the same reducer action, so the two can never disagree —
// the old implementation applied them as separate state writes.

export default function CmdDamageSheet({ player, opponents, rotation, onDamage, onClose }) {
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
      rotation={rotation}
      onClose={onClose}
      footer={<Button variant="primary" block onClick={onClose}>Done</Button>}
    >
      <div className={c.field}>
        {opponents.map(opponent => {
          const pair = player.dmg?.[opponent.id] || [0, 0]
          return (
            <div key={opponent.id}>
              <DamageRow
                color={opponent.color}
                name={opponent.hasPartner ? `${opponent.name} — first commander` : opponent.name}
                value={pair[0] || 0}
                onStep={d => onDamage(opponent.id, 0, d)}
              />
              {opponent.hasPartner && (
                <DamageRow
                  color={opponent.color}
                  name={`${opponent.name} — second commander`}
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

function DamageRow({ color, name, value, onStep }) {
  const lethal = value >= LETHAL_CMD_DMG
  return (
    <div className={c.stepRow}>
      <div className={c.stepInfo}>
        <span className={c.stepName}>
          <span className={c.stepDot} style={{ '--sw': color }} aria-hidden="true" />
          {name}
        </span>
        {lethal && <span className={c.stepMeta} data-alarm="true">Lethal</span>}
      </div>
      <div className={c.stepper}>
        <button type="button" className={c.stepBtn} onClick={() => onStep(-1)}
          disabled={value <= 0} aria-label={`Remove damage from ${name}`}>
          <RemoveIcon size={14} />
        </button>
        <span className={c.stepValue} data-alarm={lethal ? 'true' : undefined}>{value}</span>
        <button type="button" className={c.stepBtn} onClick={() => onStep(1)}
          aria-label={`Add damage from ${name}`}>
          <AddIcon size={14} />
        </button>
      </div>
    </div>
  )
}
