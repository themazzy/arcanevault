import { useState } from 'react'
import { Button, ErrorBox } from '../UI'
import { isPlayerDead } from '../../lib/lifeGame'
import Sheet from './Sheet'
import c from './controls.module.css'

// Record the result.
//
// Players are tapped in the order they finished, winner first. Anyone left untapped
// shares the next place, because at a real table the last two players rarely have a
// meaningful order and forcing one invents data. Only the winner is required — that
// is the single fact every stats surface actually reads.

export default function EndGameSheet({ players, saving, error, onSave, onDiscard, onClose }) {
  const [order, setOrder] = useState([])
  const [notes, setNotes] = useState('')

  const toggle = (id) => {
    setOrder(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }

  const placeOf = (id) => {
    const index = order.indexOf(id)
    return index === -1 ? null : index + 1
  }

  const restPlace = order.length + 1
  const decked = players.filter(p => p.deckId).length

  return (
    <Sheet
      title="End game"
      subtitle="Tap players in the order they finished"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Keep playing</Button>
          <Button variant="primary" block onClick={() => onSave({ order, notes })}
            disabled={saving || order.length === 0}>
            {saving ? 'Saving…' : 'Save result'}
          </Button>
        </>
      }
    >
      <div className={c.pickList}>
        {players.map(p => {
          const place = placeOf(p.id)
          return (
            <button key={p.id} type="button" className={c.pickRow}
              data-picked={place != null ? 'true' : undefined}
              onClick={() => toggle(p.id)}
              aria-pressed={place != null}>
              <span className={c.pickPlace} data-win={place === 1 ? 'true' : undefined}>
                {place ?? restPlace}
              </span>
              <span className={c.pickBody}>
                <span className={c.pickName}>
                  <span className={c.stepDot} style={{ '--sw': p.color }} aria-hidden="true" />
                  {p.name}
                  {place === 1 && ' — winner'}
                </span>
                <span className={c.pickMeta}>
                  {p.deckName || 'No deck'} · {p.life} life
                  {isPlayerDead(p) ? ' · out' : ''}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {order.length === 0 && (
        <p className={c.hint}>Tap the winner to continue.</p>
      )}

      <div className={c.field}>
        <label className={c.label} htmlFor="end-notes">Notes</label>
        <textarea id="end-notes" className={c.notes} value={notes} rows={3}
          onChange={e => setNotes(e.target.value)}
          placeholder="How did it end?" />
      </div>

      {decked === 0 && (
        <p className={c.hint}>
          No decks are attached, so this saves against your account without deck
          win rates. Tap a seat name to attach one.
        </p>
      )}

      <ErrorBox>{error}</ErrorBox>

      {/* The other way a game ends. Kept in the body rather than the footer so
          it never sits shoulder-to-shoulder with Save result. */}
      {onDiscard && (
        <div className={c.discardRow}>
          <Button variant="danger" size="sm" onClick={onDiscard} disabled={saving}>
            Discard without saving
          </Button>
        </div>
      )}
    </Sheet>
  )
}
