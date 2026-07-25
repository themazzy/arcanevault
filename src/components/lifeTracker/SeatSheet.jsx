import { useEffect, useRef, useState } from 'react'
import { Button, Select } from '../UI'
import { AddIcon, ImageIcon, RemoveIcon } from '../../icons'
import { COUNTER_DEFS, PLAYER_COLORS } from '../../lib/lifeGame'
import ArtPicker from './ArtPicker'
import Sheet from './Sheet'
import c from './controls.module.css'

// Everything about one seat's identity and its slow-moving numbers.
//
// The name field lives here rather than inline on the panel, which is what fixes
// the old "tap a life button while the name input is focused" bug: blur committed
// the name and the tap changed life in the same frame, from two different reads of
// state. In a sheet the two controls cannot be touched at the same time.

const NO_DECK = '__none__'

export default function SeatSheet({
  player,
  decks,
  deckStats,
  commander,
  rotation,
  onPatch,
  onCounter,
  onTax,
  onClose,
}) {
  const [artOpen, setArtOpen] = useState(false)
  const [draftName, setDraftName] = useState(player.name)
  const committed = useRef(player.name)

  // Commit on blur and on Enter, revert on Escape. An emptied field keeps the old
  // name — a seat with no name is not a useful state.
  const commitName = () => {
    const next = draftName.trim()
    if (!next || next === committed.current) { setDraftName(committed.current); return }
    committed.current = next
    onPatch({ name: next })
  }

  // The sheet can also be dismissed by the backdrop or Escape, which blurs the
  // input first — but not on every platform, so commit on unmount too. Read the
  // draft through a ref: an empty dep array is what keeps this to unmount only,
  // and a closed-over draftName would be the value from first render.
  const draftRef = useRef(draftName)
  const patchRef = useRef(onPatch)
  useEffect(() => { draftRef.current = draftName }, [draftName])
  useEffect(() => { patchRef.current = onPatch }, [onPatch])
  useEffect(() => () => {
    const next = draftRef.current.trim()
    if (next && next !== committed.current) patchRef.current({ name: next })
  }, [])

  const deckValue = player.deckId || NO_DECK

  const handleDeck = (id) => {
    if (id === NO_DECK) { onPatch({ deckId: null, deckName: null }); return }
    const deck = decks.find(d => d.id === id)
    onPatch({ deckId: id, deckName: deck?.name || null })
  }

  if (artOpen) {
    return (
      <Sheet
        title="Background art"
        subtitle={`Behind ${player.name}'s life total`}
        rotation={rotation}
        onClose={() => setArtOpen(false)}
        footer={
          <>
            <Button variant="ghost" block onClick={() => setArtOpen(false)}>Back</Button>
            {player.artUrl && (
              <Button variant="danger" block
                onClick={() => { onPatch({ artUrl: null }); setArtOpen(false) }}>
                Remove art
              </Button>
            )}
          </>
        }
      >
        <ArtPicker
          value={player.artUrl}
          autoFocus
          onSelect={url => { onPatch({ artUrl: url }); setArtOpen(false) }}
        />
      </Sheet>
    )
  }

  return (
    <Sheet
      title={player.name}
      subtitle={player.deckName || 'No deck attached'}
      rotation={rotation}
      onClose={onClose}
      footer={<Button variant="primary" block onClick={onClose}>Done</Button>}
    >
      <div className={c.field}>
        <label className={c.label} htmlFor="seat-name">Name</label>
        <input
          id="seat-name"
          className={c.textInput}
          value={draftName}
          maxLength={24}
          onChange={e => setDraftName(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.currentTarget.blur() }
            if (e.key === 'Escape') { setDraftName(committed.current); e.currentTarget.blur() }
          }}
        />
      </div>

      <div className={c.field}>
        <span className={c.label}>Colour</span>
        <div className={c.swatches}>
          {PLAYER_COLORS.map(color => (
            <button
              key={color}
              type="button"
              className={c.swatch}
              style={{ '--sw': color }}
              data-active={player.color === color ? 'true' : undefined}
              onClick={() => onPatch({ color })}
              aria-label={`Set colour ${color}`}
              aria-pressed={player.color === color}
            />
          ))}
        </div>
      </div>

      <div className={c.field}>
        <span className={c.label}>Background art</span>
        <div className={c.artRow}>
          {player.artUrl
            ? <img className={c.artThumb} src={player.artUrl} alt="" />
            : <span className={c.artEmpty}><ImageIcon size={16} /></span>}
          <Button variant="secondary" onClick={() => setArtOpen(true)}>
            {player.artUrl ? 'Change art' : 'Choose art'}
          </Button>
          {player.artUrl && (
            <Button variant="ghost" onClick={() => onPatch({ artUrl: null })}>Remove</Button>
          )}
        </div>
      </div>

      {decks.length > 0 && (
        <div className={c.field}>
          <span className={c.label}>Deck</span>
          {/* portal: this sheet's body scrolls, so an inline panel would clip. */}
          <Select value={deckValue} onChange={e => handleDeck(e.target.value)} searchable portal
            title="Select deck">
            <option value={NO_DECK}>— No deck —</option>
            {decks.map(deck => {
              const stat = deckStats?.[deck.id]
              const suffix = stat ? `  ·  ${stat.wins}W ${stat.losses}L` : ''
              // label disambiguates two decks that happen to share a name; name is
              // what gets stored as deck_name.
              return <option key={deck.id} value={deck.id}>{deck.label || deck.name}{suffix}</option>
            })}
          </Select>
          <p className={c.hint}>
            The result saves to this deck when the game ends.
          </p>
        </div>
      )}

      {commander && (
        <div className={c.field}>
          <span className={c.label}>Commander</span>
          <div className={c.stepRow}>
            <div className={c.stepInfo}>
              <span className={c.stepName}>Partner or background</span>
              <span className={c.stepMeta}>Adds a second commander to damage and tax</span>
            </div>
            <Button variant="toggle" active={player.hasPartner}
              onClick={() => onPatch({ hasPartner: !player.hasPartner })}
              aria-pressed={player.hasPartner}>
              {player.hasPartner ? 'On' : 'Off'}
            </Button>
          </div>

          <Stepper
            label={player.hasPartner ? 'Cast tax — first commander' : 'Cast tax'}
            meta={`+${(player.tax?.[0] ?? 0) * 2} generic`}
            value={player.tax?.[0] ?? 0}
            onStep={d => onTax(0, d)}
          />
          {player.hasPartner && (
            <Stepper
              label="Cast tax — second commander"
              meta={`+${(player.tax?.[1] ?? 0) * 2} generic`}
              value={player.tax?.[1] ?? 0}
              onStep={d => onTax(1, d)}
            />
          )}
        </div>
      )}

      <div className={c.field}>
        <span className={c.label}>Counters</span>
        {COUNTER_DEFS.map(def => {
          const value = player.counters?.[def.key] ?? 0
          const lethal = def.lethalAt != null && value >= def.lethalAt
          return (
            <Stepper
              key={def.key}
              label={def.label}
              meta={def.lethalAt ? `Lethal at ${def.lethalAt}` : null}
              alarm={lethal}
              value={value}
              onStep={d => onCounter(def.key, d)}
            />
          )
        })}
      </div>
    </Sheet>
  )
}

function Stepper({ label, meta, value, onStep, alarm = false }) {
  return (
    <div className={c.stepRow}>
      <div className={c.stepInfo}>
        <span className={c.stepName}>{label}</span>
        {meta && <span className={c.stepMeta} data-alarm={alarm ? 'true' : undefined}>{meta}</span>}
      </div>
      <div className={c.stepper}>
        <button type="button" className={c.stepBtn} onClick={() => onStep(-1)}
          disabled={value <= 0} aria-label={`Decrease ${label}`}>
          <RemoveIcon size={14} />
        </button>
        <span className={c.stepValue} data-alarm={alarm ? 'true' : undefined}>{value}</span>
        <button type="button" className={c.stepBtn} onClick={() => onStep(1)}
          aria-label={`Increase ${label}`}>
          <AddIcon size={14} />
        </button>
      </div>
    </div>
  )
}
