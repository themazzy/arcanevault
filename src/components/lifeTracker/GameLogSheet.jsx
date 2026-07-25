import { Button } from '../UI'
import { COUNTER_DEFS } from '../../lib/lifeGame'
import Sheet from './Sheet'
import c from './controls.module.css'

// What happened this game, newest first.
//
// The log is part of the saved game now. Previously it lived in component state
// only and was silently emptied by any reload, while the life totals survived —
// so the one thing you open the log to check ("wait, what did I go to?") was
// exactly the thing a reload destroyed.

const COUNTER_LABEL = Object.fromEntries(COUNTER_DEFS.map(d => [d.key, d.label.toLowerCase()]))

function describe(entry) {
  switch (entry.kind) {
    case 'cmdDamage':
      return `took commander damage from ${entry.fromName}`
    case 'counter': {
      const label = COUNTER_LABEL[entry.counterKey] || entry.counterKey
      return entry.delta > 0 ? `gained ${label}` : `lost ${label}`
    }
    default:
      return entry.delta > 0 ? 'gained life' : 'lost life'
  }
}

function clockOf(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export default function GameLogSheet({ log, onClose }) {
  return (
    <Sheet
      title="Game log"
      subtitle={log.length ? `${log.length} ${log.length === 1 ? 'entry' : 'entries'}` : undefined}
      onClose={onClose}
      footer={<Button variant="primary" block onClick={onClose}>Done</Button>}
    >
      {log.length === 0 ? (
        <p className={c.emptyNote}>Nothing has happened yet. Life changes show up here.</p>
      ) : (
        <div className={c.logList}>
          {log.map(entry => (
            <div key={`${entry.ts}-${entry.playerId}-${entry.kind}`} className={c.logRow}>
              <span className={c.logDot} style={{ '--sw': entry.playerColor }} aria-hidden="true" />
              <span className={c.logText}>
                <span className={c.logWho}>{entry.playerName}</span> {describe(entry)}
                {' · '}{clockOf(entry.ts)}
              </span>
              <span className={c.logDelta} data-sign={entry.delta > 0 ? 'up' : 'down'}>
                {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
              </span>
              <span className={c.logTotal}>{entry.total}</span>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  )
}
