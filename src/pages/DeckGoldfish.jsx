import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { fetchDeckCards } from '../lib/deckData'
import { FORMATS, fetchCardsByScryfallIds, getCardImageUri, parseDeckMeta } from '../lib/deckBuilderApi'
import { CardDetail } from '../components/CardComponents'
import { fetchDeckTokenCard, getDeckTokenItems } from '../lib/deckTokens'
import { isNativeApp } from '../lib/nativeAuth'
import {
  BATTLEFIELD_CARD_HEIGHT,
  BATTLEFIELD_CARD_WIDTH,
  computeBattlefieldPlacement,
} from '../lib/playtestGrid'
import { CloseIcon } from '../icons'
import styles from './DeckGoldfish.module.css'

// Cards must travel a little before a drag starts, so a plain click still opens
// the card menu. Touch waits instead, so the hand strip stays scrollable.
const DRAG_SENSORS = {
  mouse: { activationConstraint: { distance: 6 } },
  touch: { activationConstraint: { delay: 180, tolerance: 8 } },
}

// Battlefield zoom scales the card size (and the dot grid) about the body's
// top-left. Card positions stay in base (zoom-1) coordinates, so the snap grid
// and all placement math are zoom-agnostic — only drag input is divided by zoom.
const ZOOM_MIN = 0.5
const ZOOM_MAX = 2.5
const ZOOM_STEP = 0.1
const clampZoom = value => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100))

// Picks the desktop vs touch layout by input device, not screen width, so a
// touchscreen laptop gets touch controls and a small desktop window doesn't.
function detectTouch() {
  if (typeof window === 'undefined') return false
  if (isNativeApp()) return true
  return window.matchMedia?.('(pointer: coarse)').matches ?? false
}

function useIsTouch() {
  const [touch, setTouch] = useState(detectTouch)
  useEffect(() => {
    const mq = window.matchMedia?.('(pointer: coarse)')
    if (!mq) return undefined
    const onChange = () => setTouch(detectTouch())
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return touch
}

// Client coords from a dnd-kit activator event (MouseEvent or TouchEvent).
function clientPoint(event) {
  if (!event) return null
  if (typeof event.clientX === 'number') return { x: event.clientX, y: event.clientY }
  const touch = event.touches?.[0] || event.changedTouches?.[0]
  return touch ? { x: touch.clientX, y: touch.clientY } : null
}

// The overlay flies from the cursor into the snapped slot on release.
const DROP_ANIMATION = {
  duration: 160,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  sideEffects: ({ active }) => {
    // Hide the real card while the overlay animates onto it, otherwise it shows
    // up in its snapped slot and the two are briefly visible at once.
    active.node.style.opacity = '0'
    return () => { active.node.style.opacity = '' }
  },
}

const ZONE_LABELS = {
  hand: 'Hand',
  battlefield: 'Battlefield',
  graveyard: 'Graveyard',
  exile: 'Exile',
  command: 'Command',
  library: 'Library',
}

function isLand(card) {
  return String(card?.type_line || '').toLowerCase().includes('land')
}

function manaValue(card) {
  return Number(card?.cmc ?? 0) || 0
}

function shuffle(cards) {
  const next = [...cards]
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[next[i], next[j]] = [next[j], next[i]]
  }
  return next
}

function copyId(row, copyIndex) {
  return `${row.id || row.scryfall_id || row.name}:${copyIndex}:${crypto.randomUUID()}`
}

function expandDeckCards(rows) {
  const main = []
  const command = []
  for (const row of rows || []) {
    if (row.board && row.board !== 'main') continue
    const qty = Math.max(1, Number(row.qty) || 1)
    for (let i = 0; i < qty; i += 1) {
      const card = {
        ...row,
        instanceId: copyId(row, i),
        qty: 1,
      }
      if (row.is_commander) command.push(card)
      else main.push(card)
    }
  }
  return { main, command }
}

function drawCards(state, count) {
  const library = [...state.library]
  const drawn = library.splice(0, count)
  return {
    ...state,
    library,
    hand: [...state.hand, ...drawn],
  }
}

function removeFromZone(cards, instanceId) {
  const index = cards.findIndex(card => card.instanceId === instanceId)
  if (index < 0) return { card: null, cards }
  const next = [...cards]
  const [card] = next.splice(index, 1)
  return { card, cards: next }
}

function getFaceCount(card) {
  return Array.isArray(card?.card_faces) ? card.card_faces.length : 0
}

function canFlip(card) {
  return getFaceCount(card) > 1
}

function getCardFaceImage(card) {
  const faceIndex = Math.min(card?.faceIndex || 0, Math.max(0, getFaceCount(card) - 1))
  const face = card?.card_faces?.[faceIndex]
  return face?.image_uris?.normal || getCardImageUri(card, 'normal') || card?.image_uri || null
}

function ZoneStats({ cards }) {
  const lands = cards.filter(isLand).length
  const spells = cards.length - lands
  return (
    <span className={styles.zoneStats}>
      {cards.length} cards · {lands} land · {spells} spell
    </span>
  )
}

function actionLabel(action) {
  if (action === 'top') return 'Top of Library'
  if (action === 'bottom') return 'Bottom of Library'
  return ZONE_LABELS[action] || action
}

function getCardActions(zone) {
  return zone === 'library'
    ? ['hand', 'battlefield', 'graveyard', 'exile']
    : ['hand', 'battlefield', 'graveyard', 'exile', 'command', 'top', 'bottom'].filter(target => target !== zone)
}

// The whole card face — the printed card name on the image is the label, so no
// separate text bar. object-fit keeps the full card visible (never cropped).
function CardFace({ card }) {
  const img = getCardFaceImage(card)
  return (
    <span className={styles.cardImageWrap}>
      {card.isCustomToken
        ? (
            <span className={styles.customTokenFace} style={{ '--token-background': getTokenBackground(card.tokenColors) }}>
              <strong>{card.name}</strong>
              <span>Token</span>
              <b>{card.power}/{card.toughness}</b>
            </span>
          )
        : img
        ? <img className={styles.cardImage} src={img} alt={card.name} loading="lazy" />
        : <span className={styles.cardPlaceholder}>{card.name}</span>
      }
    </span>
  )
}

// A drag ends with a click on the element it started from, which would otherwise
// pop the card menu open every time. Track whether this gesture became a drag,
// resetting on each new press so a swallowed click can't leak into the next one.
function useClickAfterDragGuard(isDragging) {
  const draggedRef = useRef(false)

  useEffect(() => {
    if (isDragging) draggedRef.current = true
  }, [isDragging])

  const onPressStart = useCallback(() => { draggedRef.current = false }, [])
  const wasDragged = useCallback(() => draggedRef.current, [])

  return { onPressStart, wasDragged }
}

function MiniCard({ card, zone, zoom = 1, onOpenMenu, onHoverCard, onPreviewStart, onPreviewMove, onPreviewEnd }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.instanceId,
    data: { fromZone: zone, card },
  })
  const { onPressStart, wasDragged } = useClickAfterDragGuard(isDragging)

  const style = {
    ...(zone === 'battlefield'
      ? {
          // Position scales with zoom; width scales via CSS calc(… * --bf-zoom)
          // inherited from the battlefield body, preserving the mobile base width.
          left: `${(card.battlefieldX ?? 24) * zoom}px`,
          top: `${(card.battlefieldY ?? 24) * zoom}px`,
        }
      : null),
    // The overlay is the visible card while dragging. visibility (not opacity)
    // keeps the layout slot and stays clear of the opacity the drop animation
    // drives on this same node.
    ...(isDragging ? { visibility: 'hidden' } : null),
  }

  return (
    <button
      ref={setNodeRef}
      className={`${styles.card}${zone === 'battlefield' ? ' ' + styles.battlefieldCard : ''}${card.tapped ? ' ' + styles.cardTapped : ''}`}
      style={style}
      onMouseEnter={event => {
        onHoverCard(zone === 'battlefield' ? { zone, instanceId: card.instanceId } : null)
        onPreviewStart(card, event)
      }}
      onMouseMove={event => onPreviewMove(event)}
      onMouseLeave={() => {
        onHoverCard(null)
        onPreviewEnd()
      }}
      onClick={event => {
        if (wasDragged()) return
        onOpenMenu(card, zone, event)
      }}
      onContextMenu={event => {
        event.preventDefault()
        onOpenMenu(card, zone, event)
      }}
      aria-label={card.name}
      {...attributes}
      {...listeners}
      onMouseDown={event => {
        onPressStart()
        listeners?.onMouseDown?.(event)
      }}
      onTouchStart={event => {
        onPressStart()
        listeners?.onTouchStart?.(event)
      }}
    >
      <CardFace card={card} />
    </button>
  )
}

function DropZone({
  id,
  title,
  cards,
  collapsed,
  onToggle,
  onOpenMenu,
  onHoverCard,
  onPreviewStart,
  onPreviewMove,
  onPreviewEnd,
  bodyRef,
  zoom = 1,
  onZoom,
  variant = 'default',
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const zoomable = variant === 'battlefield'

  const bodyStyle = zoomable
    ? { '--bf-zoom': zoom, backgroundSize: `${22 * zoom}px ${22 * zoom}px` }
    : undefined

  // Wheel zooms the battlefield toward the cursor instead of scrolling it (scroll
  // is rarely useful here — cards are free-placed). Attached natively with
  // passive:false because React registers wheel listeners as passive, which
  // blocks preventDefault.
  useEffect(() => {
    const el = bodyRef?.current
    if (!zoomable || !el || !onZoom) return undefined
    const onWheel = event => {
      event.preventDefault()
      onZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP, { clientX: event.clientX, clientY: event.clientY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomable, bodyRef, onZoom])

  // Hold left-click on empty battlefield to pan when zoomed in. dnd-kit only
  // claims mousedowns on the cards themselves, so a press on empty space is free
  // for panning — cards keep dragging, empty space scrolls the view.
  useEffect(() => {
    const el = bodyRef?.current
    if (!zoomable || !el) return undefined
    let startX = 0
    let startY = 0
    let startLeft = 0
    let startTop = 0
    let panning = false
    const onMove = event => {
      if (!panning) return
      el.scrollLeft = startLeft - (event.clientX - startX)
      el.scrollTop = startTop - (event.clientY - startY)
    }
    const onUp = () => {
      panning = false
      el.classList.remove(styles.panning)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    const onDown = event => {
      // Left button, on empty space only (cards are buttons and drag themselves).
      if (event.button !== 0 || event.target.closest('button')) return
      event.preventDefault()
      panning = true
      startX = event.clientX
      startY = event.clientY
      startLeft = el.scrollLeft
      startTop = el.scrollTop
      el.classList.add(styles.panning)
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
    el.addEventListener('mousedown', onDown)
    return () => {
      el.removeEventListener('mousedown', onDown)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [zoomable, bodyRef])

  return (
    <section
      ref={setNodeRef}
      className={`${styles.zone} ${styles[`zone_${variant}`] || ''}${isOver ? ` ${styles.zoneOver}` : ''}`}
    >
      <button className={styles.zoneHeader} onClick={onToggle || (() => {})}>
        <span>{title}</span>
        <ZoneStats cards={cards} />
      </button>
      {!collapsed && (
        <div
          className={`${styles.zoneGrid}${zoomable && zoom > 1 ? ` ${styles.pannable}` : ''}`}
          ref={bodyRef}
          data-zone-body="true"
          style={bodyStyle}
        >
          {/* Reserves scrollable area at the current zoom so zooming in has room
              to pan toward the cursor. Sized in flow; cards sit above it. */}
          {zoomable && <div className={styles.bfCanvas} aria-hidden="true" />}
          {cards.length
            ? cards.map(card => (
                <MiniCard
                  key={card.instanceId}
                  card={card}
                  zone={id}
                  zoom={zoom}
                  onOpenMenu={onOpenMenu}
                  onHoverCard={onHoverCard}
                  onPreviewStart={onPreviewStart}
                  onPreviewMove={onPreviewMove}
                  onPreviewEnd={onPreviewEnd}
                />
              ))
            : !zoomable && <div className={styles.emptyZone}>Empty</div>
          }
        </div>
      )}
      {zoomable && onZoom && (
        <div className={styles.zoomControl}>
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= ZOOM_MIN}
            onClick={() => onZoom(-ZOOM_STEP)}
          >
            −
          </button>
          <span className={styles.zoomValue}>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= ZOOM_MAX}
            onClick={() => onZoom(ZOOM_STEP)}
          >
            +
          </button>
        </div>
      )}
    </section>
  )
}

function HoverPreview({ preview }) {
  if (!preview?.card) return null
  const img = getCardFaceImage(preview.card)
  if (!img) return null
  const width = 260
  const height = 364
  const left = Math.min(preview.x + 18, window.innerWidth - width - 12)
  const top = Math.min(preview.y + 18, window.innerHeight - height - 12)
  return (
    <div className={styles.hoverPreview} style={{ left, top }}>
      <img src={img} alt="" />
    </div>
  )
}

function CardActionMenu({ menu, onMove, onInspect, onToggleTapped, onFlip, onRemove, onClose }) {
  if (!menu) return null
  const actions = getCardActions(menu.zone)
  return (
    <>
      <button className={styles.menuBackdrop} aria-label="Close card menu" onClick={onClose} />
      <div className={styles.cardMenu} style={{ left: menu.x, top: menu.y }}>
        <div className={styles.cardMenuTitle}>{menu.card.name}</div>
        {!menu.card.isCustomToken && <button onClick={() => { onInspect(menu.card); onClose() }}>View Card</button>}
        {menu.zone === 'battlefield' && (
          <button onClick={() => { onToggleTapped(menu.card.instanceId); onClose() }}>
            {menu.card.tapped ? 'Untap' : 'Tap'}
          </button>
        )}
        {canFlip(menu.card) && (
          <button onClick={() => { onFlip(menu.zone, menu.card.instanceId); onClose() }}>
            Flip Card
          </button>
        )}
        {!menu.card.isToken && actions.map(action => (
          <button
            key={action}
            onClick={() => {
              onMove(menu.zone, menu.card.instanceId, action)
              onClose()
            }}
          >
            Move to {actionLabel(action)}
          </button>
        ))}
        {menu.card.isToken && (
          <button onClick={() => { onRemove(menu.zone, menu.card.instanceId); onClose() }}>Remove Token</button>
        )}
      </div>
    </>
  )
}

const TOKEN_COLORS = [
  { id: 'W', label: 'White', hex: '#d9d1aa' },
  { id: 'U', label: 'Blue', hex: '#3978a8' },
  { id: 'B', label: 'Black', hex: '#4b4350' },
  { id: 'R', label: 'Red', hex: '#a84236' },
  { id: 'G', label: 'Green', hex: '#3d8055' },
  { id: 'C', label: 'Colorless', hex: '#777b83' },
]

function getTokenBackground(colorIds = ['C']) {
  const colors = colorIds
    .map(id => TOKEN_COLORS.find(color => color.id === id)?.hex)
    .filter(Boolean)
  if (colors.length <= 1) return colors[0] || TOKEN_COLORS[5].hex
  const step = 100 / colors.length
  const stops = colors.flatMap((color, index) => [
    `${color} ${index * step}%`,
    `${color} ${(index + 1) * step}%`,
  ])
  return `linear-gradient(135deg, ${stops.join(', ')})`
}

function TokenFace({ token, loading }) {
  return (
    <>
      <span className={styles.tokenImage}>
        {token.isCustomToken
          ? (
              <span className={styles.customTokenFace} style={{ '--token-background': getTokenBackground(token.tokenColors) }}>
                <strong>{token.name}</strong>
                <span>Token</span>
                <b>{token.power}/{token.toughness}</b>
              </span>
            )
          : token.imageUri
            ? <img src={token.imageUri} alt="" loading="lazy" />
            : <span>{loading ? 'Loading…' : token.name}</span>
        }
      </span>
      <span className={styles.tokenName}>{token.name}</span>
    </>
  )
}

function TokenTile({ token, loading, onCreate, onRemoveCustom }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `token:${token.key}`,
    data: { tokenKey: token.key, token },
  })
  const { onPressStart, wasDragged } = useClickAfterDragGuard(isDragging)

  return (
    <div className={`${styles.tokenTile}${token.isCustomToken ? '' : ` ${styles.tokenTileImported}`}`}>
      <button
        ref={setNodeRef}
        type="button"
        className={styles.tokenTileCreate}
        style={isDragging ? { visibility: 'hidden' } : undefined}
        onClick={() => {
          if (wasDragged()) return
          onCreate(token.key)
        }}
        title={`Create ${token.name} on the battlefield`}
        {...attributes}
        {...listeners}
        onMouseDown={event => {
          onPressStart()
          listeners?.onMouseDown?.(event)
        }}
        onTouchStart={event => {
          onPressStart()
          listeners?.onTouchStart?.(event)
        }}
      >
        <TokenFace token={token} loading={loading} />
      </button>
      {token.isCustomToken && (
        <button
          type="button"
          className={styles.deleteCustomToken}
          aria-label={`Delete ${token.name} custom token`}
          title="Delete custom token"
          onClick={() => onRemoveCustom(token.key)}
        >
          <CloseIcon size={11} />
        </button>
      )}
    </div>
  )
}

function TokenTray({ tokens, loading, onCreate, onAddCustom, onRemoveCustom }) {
  const [showCustom, setShowCustom] = useState(false)
  const [name, setName] = useState('Custom Token')
  const [power, setPower] = useState('1')
  const [toughness, setToughness] = useState('1')
  const [colors, setColors] = useState(['C'])

  function toggleColor(colorId) {
    setColors(current => {
      if (colorId === 'C') return ['C']
      const withoutColorless = current.filter(id => id !== 'C')
      if (withoutColorless.includes(colorId)) {
        const next = withoutColorless.filter(id => id !== colorId)
        return next.length ? next : ['C']
      }
      const selected = new Set([...withoutColorless, colorId])
      return TOKEN_COLORS.filter(color => selected.has(color.id)).map(color => color.id)
    })
  }

  function submitCustom(event) {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return
    onAddCustom({ name: trimmedName, power: power.trim() || '0', toughness: toughness.trim() || '0', tokenColors: colors })
    setShowCustom(false)
  }

  return (
    <section className={`${styles.tokenTray}${showCustom ? ` ${styles.tokenTrayCustomOpen}` : ''}`} aria-label="Deck tokens and extras">
      <div className={styles.tokenTrayHeader}>
        <span>Tokens &amp; Extras</span>
        <button type="button" onClick={() => setShowCustom(value => !value)}>+ Custom</button>
      </div>
      {showCustom && (
        <form className={styles.customTokenForm} onSubmit={submitCustom}>
          <label className={styles.customTokenField}>
            <span>Name</span>
            <input value={name} onChange={event => setName(event.target.value)} placeholder="Token name" autoFocus />
          </label>
          <div className={styles.customTokenStats}>
            <label className={styles.customTokenField}>
              <span>Power</span>
              <input value={power} onChange={event => setPower(event.target.value)} placeholder="P" inputMode="text" />
            </label>
            <span className={styles.statDivider}>/</span>
            <label className={styles.customTokenField}>
              <span>Toughness</span>
              <input value={toughness} onChange={event => setToughness(event.target.value)} placeholder="T" inputMode="text" />
            </label>
          </div>
          <fieldset className={styles.colorPicker}>
            <legend>Colors</legend>
            <div className={styles.colorOptions}>
              {TOKEN_COLORS.map(color => (
                <button
                  type="button"
                  key={color.id}
                  className={`${styles.colorOption}${colors.includes(color.id) ? ` ${styles.colorOptionActive}` : ''}`}
                  style={{ '--swatch-color': color.hex }}
                  aria-label={color.label}
                  aria-pressed={colors.includes(color.id)}
                  title={color.label}
                  onClick={() => toggleColor(color.id)}
                >
                  <span className={styles.colorSwatch} />
                  <span>{color.id}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <button className={styles.addCustomTokenBtn} type="submit">Add to tray</button>
        </form>
      )}
      <div className={styles.tokenList}>
        {tokens.map(token => (
          <TokenTile
            key={token.key}
            token={token}
            loading={loading}
            onCreate={onCreate}
            onRemoveCustom={onRemoveCustom}
          />
        ))}
        {!tokens.length && <div className={styles.tokenEmpty}>{loading ? 'Finding deck tokens…' : 'No deck tokens detected.'}</div>}
      </div>
      <p className={styles.tokenHint}>Click or drag a token onto the battlefield.</p>
    </section>
  )
}

function LibraryActionModal({ action, onResolveCard, onResolveCascade, onClose }) {
  if (!action) return null
  const isCascade = action.mode === 'cascade'
  const title = isCascade
    ? `Cascade ${action.threshold}`
    : action.mode === 'scry'
      ? `Scry ${action.cards.length}`
      : `Surveil ${action.cards.length}`
  const hit = isCascade ? action.cards.find(card => card.instanceId === action.hitId) : null
  const misses = isCascade ? action.cards.filter(card => card.instanceId !== action.hitId) : []

  return (
    <div className={styles.libraryOverlay}>
      <div className={styles.libraryModal}>
        <div className={styles.libraryModalHeader}>
          <div>
            <h2>{title}</h2>
            <p>{isCascade ? 'Resolve the hit, then the rest go on the bottom in random order.' : 'Resolve each revealed card from left to right.'}</p>
          </div>
          <button onClick={onClose}>Close</button>
        </div>

        {isCascade && (
          <>
            <div className={styles.librarySectionTitle}>Cascade hit</div>
            {hit ? (
              <div className={styles.libraryCards}>
                <LibraryActionCard card={hit}>
                  <button onClick={() => onResolveCascade('battlefield')}>Cast / Battlefield</button>
                  <button onClick={() => onResolveCascade('hand')}>Hand</button>
                  <button onClick={() => onResolveCascade('exile')}>Exile</button>
                </LibraryActionCard>
              </div>
            ) : (
              <div className={styles.libraryEmpty}>No eligible nonland card found.</div>
            )}
            {misses.length > 0 && (
              <>
                <div className={styles.librarySectionTitle}>Cards revealed before the hit</div>
                <div className={styles.libraryCards}>
                  {misses.map(card => <LibraryActionCard key={card.instanceId} card={card} />)}
                </div>
              </>
            )}
            {!hit && <button className={styles.libraryDoneBtn} onClick={() => onResolveCascade(null)}>Put revealed cards on bottom</button>}
          </>
        )}

        {!isCascade && (
          <div className={styles.libraryCards}>
            {action.cards.map(card => (
              <LibraryActionCard key={card.instanceId} card={card}>
                <button onClick={() => onResolveCard(card.instanceId, 'top')}>Top</button>
                <button onClick={() => onResolveCard(card.instanceId, action.mode === 'surveil' ? 'graveyard' : 'bottom')}>
                  {action.mode === 'surveil' ? 'Graveyard' : 'Bottom'}
                </button>
              </LibraryActionCard>
            ))}
            {!action.cards.length && <div className={styles.libraryEmpty}>All revealed cards resolved.</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function LibraryActionCard({ card, children }) {
  const img = getCardFaceImage(card)
  return (
    <div className={styles.libraryCard}>
      {img ? <img src={img} alt="" /> : <div className={styles.cardPlaceholder}>{card.name}</div>}
      <div className={styles.libraryCardName}>{card.name}</div>
      {children && <div className={styles.libraryCardActions}>{children}</div>}
    </div>
  )
}

export default function DeckGoldfishPage() {
  const { id: deckId } = useParams()
  const { user } = useAuth()
  const isTouch = useIsTouch()
  const [deck, setDeck] = useState(null)
  const [deckCards, setDeckCards] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [state, setState] = useState(null)
  const [turn, setTurn] = useState(1)
  const [mulligans, setMulligans] = useState(0)
  const [collapsed, setCollapsed] = useState({ library: true, graveyard: false, exile: false, command: false })
  const [detailCard, setDetailCard] = useState(null)
  const [cardMenu, setCardMenu] = useState(null)
  const [hoveredCard, setHoveredCard] = useState(null)
  const [libraryAction, setLibraryAction] = useState(null)
  const [hoverPreview, setHoverPreview] = useState(null)
  const [loadedTokenCatalog, setLoadedTokenCatalog] = useState({ sourceKey: '', items: [] })
  const [customTokens, setCustomTokens] = useState([])
  const [activeDrag, setActiveDrag] = useState(null)
  const [zoom, setZoom] = useState(1)
  const hoverPreviewTimer = useRef(null)
  const battlefieldBodyRef = useRef(null)
  const pendingScrollRef = useRef(null)

  // Zoom keeps the point under the focal position (cursor for wheel, body centre
  // for buttons) fixed on screen. We record the scroll offset that achieves this,
  // then apply it in a layout effect once the DOM has re-laid-out at the new zoom
  // (so the scroll container's range has already grown).
  const dragGrabRef = useRef(null)

  const adjustZoom = useCallback((delta, focal) => {
    setZoom(prev => {
      const next = clampZoom(prev + delta)
      const body = battlefieldBodyRef.current
      if (next === prev || !body) return next
      const rect = body.getBoundingClientRect()
      const focalX = focal ? focal.clientX - rect.left : body.clientWidth / 2
      const focalY = focal ? focal.clientY - rect.top : body.clientHeight / 2
      // Base coordinate currently under the focal point.
      const baseX = (body.scrollLeft + focalX) / prev
      const baseY = (body.scrollTop + focalY) / prev
      pendingScrollRef.current = {
        left: baseX * next - focalX,
        top: baseY * next - focalY,
      }
      return next
    })
  }, [])

  useLayoutEffect(() => {
    const body = battlefieldBodyRef.current
    const pending = pendingScrollRef.current
    if (!body || !pending) return
    body.scrollLeft = pending.left
    body.scrollTop = pending.top
    pendingScrollRef.current = null
  }, [zoom])

  const sensors = useSensors(
    useSensor(MouseSensor, DRAG_SENSORS.mouse),
    useSensor(TouchSensor, DRAG_SENSORS.touch),
  )

  useEffect(() => {
    let ignore = false
    ;(async () => {
      setLoading(true)
      setLoadError(null)
      try {
        const { data: folder, error } = await sb.from('folders').select('*').eq('id', deckId).single()
        if (error || !folder) throw new Error('Deck not found.')
        if (folder.user_id !== user.id) throw new Error('Access denied.')
        const cards = await fetchDeckCards(deckId)
        const scryfallIds = [...new Set((cards || []).map(card => card.scryfall_id).filter(Boolean))]
        const fullCards = scryfallIds.length ? await fetchCardsByScryfallIds(scryfallIds) : []
        const fullById = new Map(fullCards.map(card => [card.id, card]))
        const enrichedCards = (cards || []).map(card => {
          const full = fullById.get(card.scryfall_id)
          return full
            ? {
                ...card,
                image_uris: full.image_uris || null,
                card_faces: full.card_faces || null,
                layout: full.layout || card.layout || null,
                oracle_text: full.oracle_text || card.oracle_text || '',
                type_line: full.type_line || card.type_line || '',
                keywords: full.keywords || card.keywords || [],
              }
            : card
        })
        if (ignore) return
        setDeck(folder)
        setDeckCards(enrichedCards)
      } catch (err) {
        if (!ignore) setLoadError(err.message || 'Could not load deck.')
      } finally {
        if (!ignore) setLoading(false)
      }
    })()
    return () => { ignore = true }
  }, [deckId, user?.id])

  const deckMeta = useMemo(() => parseDeckMeta(deck?.description), [deck?.description])
  const format = FORMATS.find(f => f.id === (deckMeta.format || 'commander'))
  const detectedTokenItems = useMemo(() => getDeckTokenItems(deckCards), [deckCards])
  const detectedTokenKey = detectedTokenItems.map(item => `${item.kind}:${item.name}`).join('|')

  useEffect(() => {
    let active = true
    if (!detectedTokenItems.length) return () => { active = false }
    Promise.all(detectedTokenItems.map(async item => {
      try {
        const result = await fetchDeckTokenCard(item)
        return { ...result, key: `${item.kind}:${item.name}` }
      } catch {
        return { ...item, key: `${item.kind}:${item.name}`, imageUri: null, card: null }
      }
    })).then(results => {
      if (active) setLoadedTokenCatalog({ sourceKey: detectedTokenKey, items: results })
    })
    return () => { active = false }
  }, [detectedTokenItems, detectedTokenKey])

  const tokenCatalog = loadedTokenCatalog.sourceKey === detectedTokenKey
    ? loadedTokenCatalog.items
    : detectedTokenItems.map(item => ({ ...item, key: `${item.kind}:${item.name}`, imageUri: null, card: null }))
  const tokensLoading = Boolean(detectedTokenItems.length && loadedTokenCatalog.sourceKey !== detectedTokenKey)
  const allTokens = useMemo(() => [...tokenCatalog, ...customTokens], [tokenCatalog, customTokens])

  const deckSummary = useMemo(() => {
    const mainRows = deckCards.filter(card => (!card.board || card.board === 'main') && !card.is_commander)
    const commandRows = deckCards.filter(card => (!card.board || card.board === 'main') && card.is_commander)
    const mainCount = mainRows.reduce((sum, card) => sum + (Number(card.qty) || 1), 0)
    const commandCount = commandRows.reduce((sum, card) => sum + (Number(card.qty) || 1), 0)
    const lands = mainRows.reduce((sum, card) => sum + (isLand(card) ? (Number(card.qty) || 1) : 0), 0)
    return { mainCount, commandCount, lands }
  }, [deckCards])

  useEffect(() => {
    if (loading || loadError || state || !deck) return
    newGame()
  }, [loading, loadError, state, deck, deckCards])

  function newGame({ drawOpening = true, nextMulligans = 0 } = {}) {
    const expanded = expandDeckCards(deckCards)
    const initial = {
      library: shuffle(expanded.main),
      hand: [],
      battlefield: [],
      graveyard: [],
      exile: [],
      command: expanded.command,
    }
    setTurn(1)
    setMulligans(nextMulligans)
    setState(drawOpening ? drawCards(initial, 7) : initial)
  }

  function mulligan() {
    newGame({ drawOpening: true, nextMulligans: mulligans + 1 })
  }

  function draw(count = 1) {
    setState(prev => prev ? drawCards(prev, count) : prev)
  }

  function nextTurn() {
    setTurn(prev => prev + 1)
    draw(1)
  }

  function moveCard(fromZone, instanceId, target, placement = {}) {
    setState(prev => {
      if (!prev) return prev
      const source = removeFromZone(prev[fromZone] || [], instanceId)
      if (!source.card) return prev
      const next = { ...prev, [fromZone]: source.cards }
      const movedCard = target === 'battlefield'
        ? {
            ...source.card,
            battlefieldX: placement.x ?? source.card.battlefieldX ?? 24 + (next.battlefield.length % 6) * 24,
            battlefieldY: placement.y ?? source.card.battlefieldY ?? 24 + Math.floor(next.battlefield.length / 6) * 24,
          }
        : {
            ...source.card,
            tapped: target === 'top' || target === 'bottom' ? source.card.tapped : false,
          }
      if (target === 'top') {
        next.library = [movedCard, ...next.library]
      } else if (target === 'bottom') {
        next.library = [...next.library, movedCard]
      } else {
        next[target] = [...(next[target] || []), movedCard]
      }
      return next
    })
  }

  function createToken(tokenKey, placement = {}) {
    const template = allTokens.find(token => token.key === tokenKey)
    if (!template) return
    setState(prev => {
      if (!prev) return prev
      const index = prev.battlefield.length
      const source = template.card || {}
      const token = {
        ...source,
        name: template.name,
        image_uri: template.imageUri || source.image_uri || null,
        instanceId: `token:${crypto.randomUUID()}`,
        qty: 1,
        isToken: true,
        isCustomToken: Boolean(template.isCustomToken),
        tokenColors: template.tokenColors,
        power: template.power ?? source.power,
        toughness: template.toughness ?? source.toughness,
        battlefieldX: placement.x ?? 24 + (index % 6) * 24,
        battlefieldY: placement.y ?? 24 + Math.floor(index / 6) * 24,
      }
      return { ...prev, battlefield: [...prev.battlefield, token] }
    })
  }

  function addCustomToken(token) {
    setCustomTokens(prev => [
      ...prev,
      { ...token, key: `custom:${crypto.randomUUID()}`, kind: 'custom', isCustomToken: true, imageUri: null, card: null },
    ])
  }

  function removeCustomToken(tokenKey) {
    setCustomTokens(prev => prev.filter(token => token.key !== tokenKey))
  }

  function removeCard(zone, instanceId) {
    setState(prev => prev ? { ...prev, [zone]: removeFromZone(prev[zone] || [], instanceId).cards } : prev)
  }

  function updateCardInZones(instanceId, updater) {
    setState(prev => {
      if (!prev) return prev
      const next = { ...prev }
      for (const zone of Object.keys(ZONE_LABELS)) {
        next[zone] = (prev[zone] || []).map(card => card.instanceId === instanceId ? updater(card) : card)
      }
      return next
    })
  }

  function toggleTapped(instanceId) {
    updateCardInZones(instanceId, card => ({ ...card, tapped: !card.tapped }))
  }

  function flipCard(zone, instanceId) {
    updateCardInZones(instanceId, card => {
      if (!canFlip(card)) return card
      const nextFace = ((card.faceIndex || 0) + 1) % getFaceCount(card)
      return { ...card, faceIndex: nextFace }
    })
  }

  function openCardMenu(card, zone, event) {
    const x = Math.min(event.clientX + 8, window.innerWidth - 220)
    const y = Math.min(event.clientY + 8, window.innerHeight - 280)
    clearHoverPreview()
    setCardMenu({ card, zone, x, y })
  }

  function canShowHoverPreview() {
    return typeof window !== 'undefined'
      && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
      && !cardMenu
      && !libraryAction
  }

  function clearHoverPreview() {
    clearTimeout(hoverPreviewTimer.current)
    setHoverPreview(null)
  }

  function startHoverPreview(card, event) {
    if (!canShowHoverPreview()) return
    clearTimeout(hoverPreviewTimer.current)
    const x = event.clientX
    const y = event.clientY
    hoverPreviewTimer.current = setTimeout(() => {
      setHoverPreview({ card, x, y })
    }, 300)
  }

  function moveHoverPreview(event) {
    setHoverPreview(prev => prev ? { ...prev, x: event.clientX, y: event.clientY } : prev)
  }

  useEffect(() => () => clearTimeout(hoverPreviewTimer.current), [])

  useEffect(() => {
    function onKeyDown(event) {
      const tag = event.target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || event.target?.isContentEditable) return
      if (event.key.toLowerCase() === 'd') {
        event.preventDefault()
        if (state?.library?.length) draw(1)
      }
      if (event.key.toLowerCase() === 't') {
        const targetId = hoveredCard?.instanceId || cardMenu?.card?.instanceId
        const zone = hoveredCard?.zone || cardMenu?.zone
        if (targetId && zone === 'battlefield') {
          event.preventDefault()
          toggleTapped(targetId)
          setCardMenu(null)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cardMenu, hoveredCard, state])

  function startScry() {
    const count = Number(window.prompt('Scry how many cards?', '1'))
    if (!count || count < 1) return
    setState(prev => {
      if (!prev) return prev
      const cards = prev.library.slice(0, count)
      setLibraryAction({ mode: 'scry', cards })
      return { ...prev, library: prev.library.slice(cards.length) }
    })
  }

  function startSurveil() {
    const count = Number(window.prompt('Surveil how many cards?', '1'))
    if (!count || count < 1) return
    setState(prev => {
      if (!prev) return prev
      const cards = prev.library.slice(0, count)
      setLibraryAction({ mode: 'surveil', cards })
      return { ...prev, library: prev.library.slice(cards.length) }
    })
  }

  function startCascade() {
    const threshold = Number(window.prompt('Cascade below mana value?', '3'))
    if (!threshold || threshold < 1) return
    setState(prev => {
      if (!prev) return prev
      const revealed = []
      let hitId = null
      for (const card of prev.library) {
        revealed.push(card)
        if (!isLand(card) && manaValue(card) < threshold) {
          hitId = card.instanceId
          break
        }
      }
      setLibraryAction({ mode: 'cascade', threshold, cards: revealed, hitId })
      return { ...prev, library: prev.library.slice(revealed.length) }
    })
  }

  function resolveLibraryCard(instanceId, destination) {
    setLibraryAction(prevAction => {
      if (!prevAction) return prevAction
      const card = prevAction.cards.find(c => c.instanceId === instanceId)
      const cards = prevAction.cards.filter(c => c.instanceId !== instanceId)
      if (card) {
        setState(prev => {
          if (!prev) return prev
          if (destination === 'top') return { ...prev, library: [card, ...prev.library] }
          if (destination === 'bottom') return { ...prev, library: [...prev.library, card] }
          return { ...prev, [destination]: [...(prev[destination] || []), card] }
        })
      }
      return cards.length ? { ...prevAction, cards } : null
    })
  }

  function resolveCascade(destination) {
    if (!libraryAction) return
    const hit = libraryAction.cards.find(card => card.instanceId === libraryAction.hitId)
    const misses = libraryAction.cards.filter(card => card.instanceId !== libraryAction.hitId)
    setState(prev => {
      if (!prev) return prev
      const next = { ...prev, library: [...prev.library, ...shuffle(misses)] }
      if (hit && destination) {
        next[destination] = [...(next[destination] || []), destination === 'battlefield'
          ? { ...hit, battlefieldX: 32, battlefieldY: 32 }
          : hit
        ]
      } else if (hit) {
        next.library = [...next.library, hit]
      }
      return next
    })
    setLibraryAction(null)
  }

  function shuffleLibraryOnly() {
    setState(prev => prev ? { ...prev, library: shuffle(prev.library) } : prev)
  }

  function toggleZone(zone) {
    setCollapsed(prev => ({ ...prev, [zone]: !prev[zone] }))
  }

  function getBattlefieldPlacement(active, delta, activatorEvent) {
    const body = battlefieldBodyRef.current
    if (!body) return {}
    const data = active.data.current || {}
    const card = data.card
    const cardWidth = BATTLEFIELD_CARD_WIDTH
    const cardHeight = BATTLEFIELD_CARD_HEIGHT
    let x
    let y

    // Cards store base (zoom-1) coords; drag input is in rendered pixels, so
    // divide screen distances by zoom to land back in the base coordinate system.
    if (data.fromZone === 'battlefield' && card) {
      // Same size on the battlefield before and after, so the drag delta is exact —
      // and unlike the dragged node's rect it isn't skewed by a tapped card's rotation.
      x = (card.battlefieldX ?? 24) + delta.x / zoom
      y = (card.battlefieldY ?? 24) + delta.y / zoom
    } else {
      // Coming from another zone (hand/library) or the token tray: the placed card
      // is battlefield-sized (bigger than the source), so anchoring its corner to
      // the source's corner would drop it half a card off-cursor — worse the higher
      // the zoom. Instead keep the grab point under the cursor: take where the card
      // was grabbed as a fraction of the source, and scale that to the card's size.
      const start = clientPoint(activatorEvent)
      if (!start) return {}
      // Grab fraction captured at drag start from the real source node.
      const { grabFracX, grabFracY } = dragGrabRef.current || { grabFracX: 0.5, grabFracY: 0.5 }
      const pointerX = start.x + delta.x
      const pointerY = start.y + delta.y
      const bRect = body.getBoundingClientRect()
      x = (pointerX - bRect.left + body.scrollLeft) / zoom - grabFracX * cardWidth
      y = (pointerY - bRect.top + body.scrollTop) / zoom - grabFracY * cardHeight
    }

    return computeBattlefieldPlacement({
      x,
      y,
      // Clamp to the full scroll canvas (in base coords), not just the visible
      // viewport, so drops in a scrolled-away region when zoomed in aren't yanked back.
      bodyWidth: body.scrollWidth / zoom,
      bodyHeight: body.scrollHeight / zoom,
      cardWidth,
      cardHeight,
    })
  }

  function handleDragStart(event) {
    const data = event.active.data.current || {}
    clearHoverPreview()
    setCardMenu(null)
    // Record where the card was grabbed as a fraction of the *source* node, measured
    // here at drag start. By the time the drop fires, dnd-kit's active.rect has been
    // polluted by the resized DragOverlay (it reports battlefield size, not the
    // hand-card size), so grab fraction can't be recomputed reliably later.
    const start = clientPoint(event.activatorEvent)
    const srcRect = event.activatorEvent?.target?.closest?.('button')?.getBoundingClientRect()
      || event.active.rect.current?.initial
    let grabFracX = 0.5
    let grabFracY = 0.5
    if (srcRect && start && srcRect.width && srcRect.height) {
      grabFracX = (start.x - srcRect.left) / srcRect.width
      grabFracY = (start.y - srcRect.top) / srcRect.height
    }
    dragGrabRef.current = { grabFracX, grabFracY }

    // Preview at the battlefield's current zoomed size from the first frame, so a
    // card dragged from the hand already matches where it will land. The overlay is
    // bigger than the source, and dnd-kit anchors it to the source's corner, so
    // shift it to keep the grab point under the cursor.
    let offsetX = 0
    let offsetY = 0
    if ((data.card || data.token) && data.fromZone !== 'battlefield' && srcRect) {
      offsetX = -grabFracX * (BATTLEFIELD_CARD_WIDTH * zoom - srcRect.width)
      offsetY = -grabFracY * (BATTLEFIELD_CARD_HEIGHT * zoom - srcRect.height)
    }
    setActiveDrag({ card: data.card || null, token: data.token || null, zoom, offsetX, offsetY })
  }

  function handleDragEnd(event) {
    const { active, over, delta } = event
    setActiveDrag(null)
    if (!over) return
    const data = active.data.current || {}
    const zoneId = String(over.id)
    const placement = zoneId === 'battlefield' ? getBattlefieldPlacement(active, delta, event.activatorEvent) : {}

    if (data.tokenKey) {
      if (zoneId === 'battlefield') createToken(data.tokenKey, placement)
      return
    }
    if (!data.fromZone) return
    moveCard(data.fromZone, active.id, zoneId === 'library' ? 'bottom' : zoneId, placement)
  }

  if (loading) return <div className={styles.page}><div className={styles.status}>Loading playtest...</div></div>
  if (loadError) return (
    <div className={styles.page}>
      <div className={styles.status}>
        <div className={styles.error}>{loadError}</div>
        <Link to="/builder">Back to Builder</Link>
      </div>
    </div>
  )

  const canAct = Boolean(state && state.library.length)

  return (
    <div className={`${styles.page} ${isTouch ? styles.touch : styles.desktop}`}>
      <header className={styles.header}>
        <div className={styles.headerInfo}>
          <Link className={styles.backLink} to={`/builder/${deckId}`}>← Back to deck</Link>
          <h1>{deck?.name || 'Deck Playtest'}</h1>
          <p>{format?.label || 'Deck'} · {deckSummary.mainCount} in library · {deckSummary.commandCount} command · {deckSummary.lands} lands</p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.actionGroup}>
            <button onClick={() => newGame()}>New Game</button>
            <button onClick={mulligan} disabled={!state}>Mulligan</button>
          </div>
          <div className={styles.actionGroup}>
            <button onClick={() => draw(1)} disabled={!canAct}>Draw</button>
            <button onClick={() => draw(7)} disabled={!canAct}>Draw 7</button>
            <button onClick={nextTurn} disabled={!canAct}>Next Turn</button>
          </div>
          <div className={styles.actionGroup}>
            <button onClick={startScry} disabled={!canAct}>Scry</button>
            <button onClick={startSurveil} disabled={!canAct}>Surveil</button>
            <button onClick={startCascade} disabled={!canAct}>Cascade</button>
            <button onClick={shuffleLibraryOnly} disabled={!canAct}>Shuffle Library</button>
          </div>
        </div>
      </header>

      {state && (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          autoScroll={false}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDrag(null)}
        >
        <main className={styles.board}>
          <aside className={styles.sidebar}>
            <div className={styles.statBar}>
              <div className={styles.stat}>
                <span>Turn</span>
                <strong>{turn}</strong>
              </div>
              <div className={styles.stat}>
                <span>Mulls</span>
                <strong>{mulligans}</strong>
              </div>
              <div className={styles.stat}>
                <span>Library</span>
                <strong>{state.library.length}</strong>
              </div>
            </div>
            <TokenTray tokens={allTokens} loading={tokensLoading} onCreate={createToken} onAddCustom={addCustomToken} onRemoveCustom={removeCustomToken} />
          </aside>

          <div className={styles.table}>
            <div className={styles.sideZones}>
              <DropZone id="command" title="Command" cards={state.command} collapsed={collapsed.command} onToggle={() => toggleZone('command')} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="side" />
              <DropZone id="graveyard" title="Graveyard" cards={state.graveyard} collapsed={collapsed.graveyard} onToggle={() => toggleZone('graveyard')} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="side" />
              <DropZone id="exile" title="Exile" cards={state.exile} collapsed={collapsed.exile} onToggle={() => toggleZone('exile')} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="side" />
              <DropZone id="library" title="Library" cards={state.library} collapsed={collapsed.library} onToggle={() => toggleZone('library')} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="side" />
            </div>
            <DropZone id="battlefield" title="Battlefield" cards={state.battlefield} collapsed={false} bodyRef={battlefieldBodyRef} zoom={zoom} onZoom={adjustZoom} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="battlefield" />
            <DropZone id="hand" title="Hand" cards={state.hand} collapsed={false} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="hand" />
          </div>
        </main>

        <DragOverlay dropAnimation={DROP_ANIMATION} className={styles.dragOverlay}>
          {activeDrag?.card && (
            <div
              className={`${styles.card} ${styles.dragPreview}`}
              style={{
                width: `${BATTLEFIELD_CARD_WIDTH * (activeDrag.zoom || 1)}px`,
                transform: `translate(${activeDrag.offsetX || 0}px, ${activeDrag.offsetY || 0}px)${activeDrag.card.tapped ? ' rotate(90deg)' : ''} scale(1.03)`,
              }}
            >
              <CardFace card={activeDrag.card} />
            </div>
          )}
          {activeDrag?.token && (
            <div
              className={`${styles.tokenTileCreate} ${styles.dragPreview}`}
              style={{
                width: `${BATTLEFIELD_CARD_WIDTH * (activeDrag.zoom || 1)}px`,
                transform: `translate(${activeDrag.offsetX || 0}px, ${activeDrag.offsetY || 0}px) scale(1.03)`,
              }}
            >
              <TokenFace token={activeDrag.token} loading={false} />
            </div>
          )}
        </DragOverlay>
        </DndContext>
      )}

      <HoverPreview preview={hoverPreview} />

      <CardActionMenu
        menu={cardMenu}
        onMove={moveCard}
        onInspect={setDetailCard}
        onToggleTapped={toggleTapped}
        onFlip={flipCard}
        onRemove={removeCard}
        onClose={() => setCardMenu(null)}
      />

      <LibraryActionModal
        action={libraryAction}
        onResolveCard={resolveLibraryCard}
        onResolveCascade={resolveCascade}
        onClose={() => {
          if (libraryAction?.cards?.length) {
            setState(prev => prev ? { ...prev, library: [...prev.library, ...libraryAction.cards] } : prev)
          }
          setLibraryAction(null)
        }}
      />

      {detailCard && (
        <CardDetail
          card={detailCard}
          sfCard={detailCard}
          readOnly
          onClose={() => setDetailCard(null)}
        />
      )}
    </div>
  )
}
