import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { fetchDeckCards } from '../lib/deckData'
import { FORMATS, fetchCardsByScryfallIds, getCardImageUri, parseDeckMeta } from '../lib/deckBuilderApi'
import { CardDetail } from '../components/CardComponents'
import styles from './DeckGoldfish.module.css'

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

function MiniCard({ card, zone, onOpenMenu, onHoverCard, onPreviewStart, onPreviewMove, onPreviewEnd }) {
  const img = getCardFaceImage(card)
  const style = zone === 'battlefield'
    ? {
        left: `${card.battlefieldX ?? 24}px`,
        top: `${card.battlefieldY ?? 24}px`,
      }
    : undefined

  return (
    <button
      className={`${styles.card}${zone === 'battlefield' ? ' ' + styles.battlefieldCard : ''}${card.tapped ? ' ' + styles.cardTapped : ''}`}
      style={style}
      draggable
      onMouseEnter={event => {
        onHoverCard(zone === 'battlefield' ? { zone, instanceId: card.instanceId } : null)
        onPreviewStart(card, event)
      }}
      onMouseMove={event => onPreviewMove(event)}
      onMouseLeave={() => {
        onHoverCard(null)
        onPreviewEnd()
      }}
      onClick={event => onOpenMenu(card, zone, event)}
      onContextMenu={event => {
        event.preventDefault()
        onOpenMenu(card, zone, event)
      }}
      onDragStart={event => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/json', JSON.stringify({ fromZone: zone, instanceId: card.instanceId }))
      }}
      title={card.name}
    >
      <span className={styles.cardImageWrap}>
        {img
          ? <img className={styles.cardImage} src={img} alt="" loading="lazy" />
          : <span className={styles.cardPlaceholder}>{card.name}</span>
        }
      </span>
      <span className={styles.cardName}>{card.name}</span>
    </button>
  )
}

function DropZone({
  id,
  title,
  cards,
  collapsed,
  onToggle,
  onMove,
  onOpenMenu,
  onHoverCard,
  onPreviewStart,
  onPreviewMove,
  onPreviewEnd,
  variant = 'default',
}) {
  function handleDrop(event) {
    event.preventDefault()
    try {
      const data = JSON.parse(event.dataTransfer.getData('application/json') || '{}')
      if (!data.fromZone || !data.instanceId) return
      const body = event.currentTarget.querySelector('[data-zone-body="true"]')
      const rect = body?.getBoundingClientRect()
      const placement = id === 'battlefield' && rect
        ? {
            x: Math.max(0, Math.min(event.clientX - rect.left - 58, rect.width - 116)),
            y: Math.max(0, Math.min(event.clientY - rect.top - 82, rect.height - 164)),
          }
        : {}
      onMove(data.fromZone, data.instanceId, id === 'library' ? 'bottom' : id, placement)
    } catch {}
  }

  return (
    <section
      className={`${styles.zone} ${styles[`zone_${variant}`] || ''}`}
      onDragOver={event => event.preventDefault()}
      onDrop={handleDrop}
    >
      <button className={styles.zoneHeader} onClick={onToggle || (() => {})}>
        <span>{title}</span>
        <ZoneStats cards={cards} />
      </button>
      {!collapsed && (
        <div className={styles.zoneGrid} data-zone-body="true">
          {cards.length
            ? cards.map(card => (
                <MiniCard
                  key={card.instanceId}
                  card={card}
                  zone={id}
                  onOpenMenu={onOpenMenu}
                  onHoverCard={onHoverCard}
                  onPreviewStart={onPreviewStart}
                  onPreviewMove={onPreviewMove}
                  onPreviewEnd={onPreviewEnd}
                />
              ))
            : <div className={styles.emptyZone}>Empty</div>
          }
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

function CardActionMenu({ menu, onMove, onInspect, onToggleTapped, onFlip, onClose }) {
  if (!menu) return null
  const actions = getCardActions(menu.zone)
  return (
    <>
      <button className={styles.menuBackdrop} aria-label="Close card menu" onClick={onClose} />
      <div className={styles.cardMenu} style={{ left: menu.x, top: menu.y }}>
        <div className={styles.cardMenuTitle}>{menu.card.name}</div>
        <button onClick={() => { onInspect(menu.card); onClose() }}>View Card</button>
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
        {actions.map(action => (
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
      </div>
    </>
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
  const hoverPreviewTimer = useRef(null)

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

  if (loading) return <div className={styles.page}><div className={styles.status}>Loading playtest...</div></div>
  if (loadError) return (
    <div className={styles.page}>
      <div className={styles.status}>
        <div className={styles.error}>{loadError}</div>
        <Link to="/builder">Back to Builder</Link>
      </div>
    </div>
  )

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link className={styles.backLink} to={`/builder/${deckId}`}>Back to deck</Link>
          <h1>{deck?.name || 'Deck Playtest'}</h1>
          <p>{format?.label || 'Deck'} · {deckSummary.mainCount} library cards · {deckSummary.commandCount} command · {deckSummary.lands} lands</p>
        </div>
        <div className={styles.headerActions}>
          <button onClick={() => newGame()}>New Game</button>
          <button onClick={mulligan} disabled={!state}>Mulligan</button>
          <button onClick={() => draw(1)} disabled={!state || state.library.length === 0}>Draw</button>
          <button onClick={() => draw(7)} disabled={!state || state.library.length === 0}>Draw 7</button>
          <button onClick={nextTurn} disabled={!state || state.library.length === 0}>Next Turn</button>
          <button onClick={startScry} disabled={!state || state.library.length === 0}>Scry</button>
          <button onClick={startSurveil} disabled={!state || state.library.length === 0}>Surveil</button>
          <button onClick={startCascade} disabled={!state || state.library.length === 0}>Cascade</button>
        </div>
      </header>

      {state && (
        <main className={styles.board}>
          <aside className={styles.sidebar}>
            <div className={styles.statCard}>
              <span>Turn</span>
              <strong>{turn}</strong>
            </div>
            <div className={styles.statCard}>
              <span>Mulligans</span>
              <strong>{mulligans}</strong>
            </div>
            <div className={styles.statCard}>
              <span>Library</span>
              <strong>{state.library.length}</strong>
            </div>
            <button className={styles.secondaryBtn} onClick={shuffleLibraryOnly}>Shuffle Library</button>
          </aside>

          <div className={styles.table}>
            <div className={styles.sideZones}>
              <DropZone id="command" title="Command" cards={state.command} collapsed={collapsed.command} onToggle={() => toggleZone('command')} onMove={moveCard} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="side" />
              <DropZone id="graveyard" title="Graveyard" cards={state.graveyard} collapsed={collapsed.graveyard} onToggle={() => toggleZone('graveyard')} onMove={moveCard} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="side" />
              <DropZone id="exile" title="Exile" cards={state.exile} collapsed={collapsed.exile} onToggle={() => toggleZone('exile')} onMove={moveCard} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="side" />
              <DropZone id="library" title="Library" cards={state.library} collapsed={collapsed.library} onToggle={() => toggleZone('library')} onMove={moveCard} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="side" />
            </div>
            <DropZone id="battlefield" title="Battlefield" cards={state.battlefield} collapsed={false} onMove={moveCard} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="battlefield" />
            <DropZone id="hand" title="Hand" cards={state.hand} collapsed={false} onMove={moveCard} onOpenMenu={openCardMenu} onHoverCard={setHoveredCard} onPreviewStart={startHoverPreview} onPreviewMove={moveHoverPreview} onPreviewEnd={clearHoverPreview} variant="hand" />
          </div>
        </main>
      )}

      <HoverPreview preview={hoverPreview} />

      <CardActionMenu
        menu={cardMenu}
        onMove={moveCard}
        onInspect={setDetailCard}
        onToggleTapped={toggleTapped}
        onFlip={flipCard}
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
