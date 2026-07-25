import { useEffect, useRef, useState } from 'react'
import { Button, Select } from '../UI'
import { useSettings } from '../SettingsContext'
import Sheet from './Sheet'
import c from './controls.module.css'

// Dice, coins and "who goes first" in one sheet with three tabs.
//
// These were three separate full-screen overlays before, each with its own
// backdrop, close button and animation loop. They are the same kind of thing —
// ask the table for a random answer — so they belong behind one Tools button.

const DIE_TYPES = [2, 4, 6, 8, 10, 12, 20, 100]
const SPIN_MS = 620
const SPIN_TICK_MS = 55

function randomInt(max) {
  return 1 + Math.floor(Math.random() * max)
}

// Shared settle animation: tick through random values, then land on a final one.
// Skipped entirely under reduce_motion — a spinner the user asked not to see.
function useSpin(reduceMotion) {
  const [spinning, setSpinning] = useState(false)
  const timers = useRef([])

  useEffect(() => () => timers.current.forEach(clearInterval), [])

  const spin = (tick, settle) => {
    if (reduceMotion) { settle(); return }
    setSpinning(true)
    const interval = setInterval(tick, SPIN_TICK_MS)
    const stop = setTimeout(() => {
      clearInterval(interval)
      settle()
      setSpinning(false)
    }, SPIN_MS)
    timers.current.push(interval, stop)
  }

  return { spinning, spin }
}

export default function ToolsSheet({ players, onClose }) {
  const [tab, setTab] = useState('first')

  return (
    <Sheet
      title="Table tools"
      onClose={onClose}
      footer={<Button variant="primary" block onClick={onClose}>Done</Button>}
    >
      <div className={c.segTabs} role="tablist" aria-label="Table tools">
        {[
          { id: 'first', label: 'Who starts' },
          { id: 'dice', label: 'Dice' },
          { id: 'coin', label: 'Coins' },
        ].map(t => (
          <button key={t.id} type="button" role="tab" className={c.segTab}
            data-active={tab === t.id ? 'true' : undefined}
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'first' && <FirstPlayer players={players} />}
      {tab === 'dice' && <Dice />}
      {tab === 'coin' && <Coins />}
    </Sheet>
  )
}

// ── Who goes first ────────────────────────────────────────────────────────────
function FirstPlayer({ players }) {
  const { reduce_motion } = useSettings()
  const [chosen, setChosen] = useState(null)
  const [flicker, setFlicker] = useState(null)
  const { spinning, spin } = useSpin(reduce_motion)

  const pick = () => {
    const winner = players[Math.floor(Math.random() * players.length)]
    setChosen(null)
    spin(
      () => setFlicker(players[Math.floor(Math.random() * players.length)].id),
      () => { setFlicker(null); setChosen(winner) },
    )
  }

  return (
    <>
      <div className={c.readout} aria-live="polite">
        {chosen
          ? <span className={c.readoutBig} style={{ color: chosen.color }}>{chosen.name}</span>
          : <span className={c.hint}>{spinning ? 'Choosing…' : 'Pick a random player to take the first turn.'}</span>}
      </div>

      <div className={c.pickList}>
        {players.map(p => (
          <div key={p.id} className={c.pickRow}
            data-picked={(chosen?.id === p.id || flicker === p.id) ? 'true' : undefined}>
            <span className={c.pickPlace} data-win={chosen?.id === p.id ? 'true' : undefined}>
              {chosen?.id === p.id ? '1' : '–'}
            </span>
            <span className={c.pickBody}>
              <span className={c.pickName}>
                <span className={c.stepDot} style={{ '--sw': p.color }} aria-hidden="true" />
                {p.name}
              </span>
            </span>
          </div>
        ))}
      </div>

      <Button variant="primary" block onClick={pick} disabled={spinning}>
        {chosen ? 'Choose again' : 'Choose first player'}
      </Button>
    </>
  )
}

// ── Dice ──────────────────────────────────────────────────────────────────────
function Dice() {
  const { reduce_motion } = useSettings()
  const [sides, setSides] = useState(6)
  const [count, setCount] = useState(1)
  const [rolls, setRolls] = useState([])
  const { spinning, spin } = useSpin(reduce_motion)

  const roll = () => {
    const final = Array.from({ length: count }, () => randomInt(sides))
    spin(
      () => setRolls(Array.from({ length: count }, () => randomInt(sides))),
      () => setRolls(final),
    )
  }

  const total = rolls.reduce((sum, n) => sum + n, 0)
  const highest = rolls.length > 2 ? Math.max(...rolls) : null
  const lowest = rolls.length > 2 ? Math.min(...rolls) : null

  return (
    <>
      <div className={c.readout} aria-live="polite">
        {rolls.length === 0
          ? <span className={c.hint}>Roll to see a result.</span>
          : rolls.map((n, i) => (
            <span key={i} className={c.die}
              data-high={highest !== null && n === highest && highest !== lowest ? 'true' : undefined}
              data-low={lowest !== null && n === lowest && highest !== lowest ? 'true' : undefined}>
              {n}
            </span>
          ))}
      </div>

      {rolls.length > 1 && <p className={c.hint}>Total {total}</p>}

      <div className={c.field}>
        <span className={c.label}>Die</span>
        <Select value={String(sides)} onChange={e => setSides(Number(e.target.value))} portal
          title="Select die">
          {DIE_TYPES.map(d => <option key={d} value={String(d)}>d{d}</option>)}
        </Select>
      </div>

      <div className={c.field}>
        <span className={c.label}>How many</span>
        <div className={c.chipRow}>
          {[1, 2, 3, 4, 5, 6, 8, 10].map(n => (
            <Button key={n} variant="toggle" active={count === n} onClick={() => setCount(n)}>
              {n}
            </Button>
          ))}
        </div>
      </div>

      <Button variant="primary" block onClick={roll} disabled={spinning}>
        Roll {count} × d{sides}
      </Button>
    </>
  )
}

// ── Coins ─────────────────────────────────────────────────────────────────────
const HEADS = 'Heads'
const TAILS = 'Tails'

function Coins() {
  const { reduce_motion } = useSettings()
  const [count, setCount] = useState(1)
  const [flips, setFlips] = useState([])
  const [streak, setStreak] = useState(null)
  const { spinning, spin } = useSpin(reduce_motion)

  const randomFace = () => (Math.random() < 0.5 ? HEADS : TAILS)

  const flip = () => {
    setStreak(null)
    const final = Array.from({ length: count }, randomFace)
    spin(
      () => setFlips(Array.from({ length: count }, randomFace)),
      () => setFlips(final),
    )
  }

  // Krark's Thumb and friends: keep flipping while you keep winning.
  const flipUntilLoss = () => {
    let wins = 0
    while (randomFace() === HEADS) wins++
    const final = [...Array.from({ length: wins }, () => HEADS), TAILS]
    spin(
      () => setFlips([randomFace()]),
      () => { setFlips(final); setStreak(wins) },
    )
  }

  const heads = flips.filter(f => f === HEADS).length

  return (
    <>
      <div className={c.readout} aria-live="polite">
        {flips.length === 0
          ? <span className={c.hint}>Flip to see a result.</span>
          : flips.map((face, i) => (
            <span key={i} className={c.die} data-high={face === HEADS ? 'true' : undefined}>
              {face === HEADS ? 'H' : 'T'}
            </span>
          ))}
      </div>

      {streak !== null && (
        <p className={c.hint}>Won {streak} {streak === 1 ? 'flip' : 'flips'} before losing one.</p>
      )}
      {streak === null && flips.length > 1 && (
        <p className={c.hint}>{heads} heads, {flips.length - heads} tails</p>
      )}

      <div className={c.field}>
        <span className={c.label}>How many</span>
        <div className={c.chipRow}>
          {[1, 2, 3, 4, 6, 8, 12].map(n => (
            <Button key={n} variant="toggle" active={count === n} onClick={() => setCount(n)}>
              {n}
            </Button>
          ))}
        </div>
      </div>

      <Button variant="primary" block onClick={flip} disabled={spinning}>
        Flip {count === 1 ? 'a coin' : `${count} coins`}
      </Button>
      <Button variant="secondary" block onClick={flipUntilLoss} disabled={spinning}>
        Flip until you lose one
      </Button>
    </>
  )
}
