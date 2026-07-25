import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, ConfirmModal, ErrorBox, ResponsiveMenu, Select } from '../components/UI'
import uiStyles from '../components/UI.module.css'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { useToast } from '../components/ToastContext'
import {
  CheckIcon, CopyIcon, DiceIcon, ListIcon, MenuIcon, PlayerIcon, SwordIcon, TrophyIcon,
} from '../icons'
import { sb } from '../lib/supabase'
import { getPublicAppUrl } from '../lib/publicUrl'
import {
  FORMAT_ORDER, LIFE_FORMATS, MAX_SEATS, MIN_SEATS,
  clampLife, createGame, deathTextFor, findLayout, gameReducer, isCommanderFormat,
  isPlayerDead, layoutsFor, startingLifeFor,
} from '../lib/lifeGame'
import {
  clearGame, flushGame, loadGame, loadSetup, registerFlushHooks, saveGame, saveSetup,
} from '../lib/lifeStorage'
import {
  buildDeckStatsMap, buildGameResultRows, buildPlacements, buildTrackedGamePayload,
} from '../lib/lifeResults'
import {
  cancelLobby, claimSlot, createLobby, endLobby, fetchLobbySlots,
  mergeSlotAttribution, seedsFromSlots, startLobby, subscribeLobby,
} from '../lib/lifeLobby'
import SeatPanel from '../components/lifeTracker/SeatPanel'
import SwapArrow from '../components/lifeTracker/SwapArrow'
import { measureSeats, seatAtPoint, seatCentre } from '../components/lifeTracker/seatGeometry'
import SeatSheet from '../components/lifeTracker/SeatSheet'
import CmdDamageSheet from '../components/lifeTracker/CmdDamageSheet'
import GameLogSheet from '../components/lifeTracker/GameLogSheet'
import ToolsSheet from '../components/lifeTracker/ToolsSheet'
import EndGameSheet from '../components/lifeTracker/EndGameSheet'
import styles from './LifeTracker.module.css'

const SEAT_OPTIONS = Array.from({ length: MAX_SEATS - MIN_SEATS + 1 }, (_, i) => MIN_SEATS + i)
const NO_DECK = '__none__'

function formatElapsed(ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'moments ago'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${minutes % 60} min ago`
}

export default function LifeTrackerPage() {
  const { user } = useAuth()
  const { nickname } = useSettings()
  const { showToast } = useToast()
  const navigate = useNavigate()

  // Restore happens in the initialisers, not an effect, so the first paint is
  // already the right screen — no flash of the setup form over a live game.
  // loadGame also consumes the pre-rewrite sessionStorage key, so it must run once.
  const [boot] = useState(loadGame)
  const [game, dispatch] = useReducer(
    gameReducer,
    boot,
    // A game found on disk resumes silently: after a crash or a backgrounded tab
    // that is what the user wants. A game left overnight becomes an offer instead.
    saved => (saved?.canAutoResume ? saved.game : null),
  )
  const [setup, setSetup] = useState(loadSetup)
  const [resumable, setResumable] = useState(() => (
    boot && !boot.canAutoResume
      ? { game: boot.game, label: formatElapsed(Date.now() - boot.savedAt) }
      : null
  ))

  const [decks, setDecks] = useState([])
  const [deckStats, setDeckStats] = useState({})

  const [seatSheet, setSeatSheet] = useState(null)
  const [damageSheet, setDamageSheet] = useState(null)
  const [showLog, setShowLog] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [showEnd, setShowEnd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [confirmNew, setConfirmNew] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [picked, setPicked] = useState(null)   // seat index lifted for swapping
  const [drag, setDrag] = useState(null)       // { from, target, point } while dragging
  const dragFrom = useRef(null)
  const seatRects = useRef({})                 // grid-relative, measured at drag start
  const gridOrigin = useRef({ left: 0, top: 0 })
  const gridRef = useRef(null)

  const [lobby, setLobby] = useState(null)     // { session, slots }
  const [lobbyBusy, setLobbyBusy] = useState(false)
  const [lobbyError, setLobbyError] = useState('')
  const [copied, setCopied] = useState(false)

  const format = LIFE_FORMATS[setup.format] ? setup.format : 'commander'
  const startingLife = startingLifeFor(format, setup.customLife)
  const layoutOptions = layoutsFor(setup.seatCount)
  const activeSetupLayout = findLayout(setup.seatCount, setup.layoutId)

  const playing = !!game

  useEffect(() => registerFlushHooks(), [])

  useEffect(() => {
    if (game) saveGame(game)
  }, [game])

  useEffect(() => { saveSetup(setup) }, [setup])

  // Suppresses the premium themes' ambient card-art canvas over the table.
  useEffect(() => {
    if (!playing) return
    const root = document.documentElement
    root.setAttribute('data-life-tracker', '')
    return () => root.removeAttribute('data-life-tracker')
  }, [playing])

  useEffect(() => {
    const sync = () => setFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  useEffect(() => {
    if (!user) return
    let active = true
    sb.from('folders')
      .select('id,name,type')
      .eq('user_id', user.id)
      .in('type', ['deck', 'builder_deck'])
      .order('name')
      .then(({ data }) => { if (active) setDecks(data || []) })
    return () => { active = false }
  }, [user])

  const refreshDeckStats = useCallback(async () => {
    if (!user) return
    const { data } = await sb.from('game_results')
      .select('deck_id,placement')
      .eq('user_id', user.id)
    setDeckStats(buildDeckStatsMap(data || []))
  }, [user])

  // Loaded on mount, not only after saving a game — the old implementation only
  // refreshed on save, so the deck W/L badge was empty on every fresh page load.
  useEffect(() => { refreshDeckStats() }, [refreshDeckStats])

  // ── Lobby ────────────────────────────────────────────────────────────────────
  const lobbySessionId = lobby?.session?.id
  useEffect(() => {
    if (!lobbySessionId || playing) return
    const sessionId = lobbySessionId
    let active = true
    const reload = async () => {
      try {
        const slots = await fetchLobbySlots(sessionId)
        if (active) setLobby(prev => (prev?.session?.id === sessionId ? { ...prev, slots } : prev))
      } catch { /* the poll will try again */ }
    }
    const unsubscribe = subscribeLobby(sessionId, reload)
    return () => { active = false; unsubscribe() }
  }, [lobbySessionId, playing])

  const handleHostGame = async () => {
    if (!user) return
    setLobbyBusy(true)
    setLobbyError('')
    try {
      const { session } = await createLobby({
        hostUserId: user.id, format, customLife: startingLife, seatCount: setup.seatCount,
      })
      const slots = await fetchLobbySlots(session.id)
      // The host owns seat 1 automatically — one less thing to do before guests
      // can start joining.
      if (slots[0]) {
        await claimSlot(slots[0].id, {
          userId: user.id,
          name: nickname?.trim() || slots[0].player_name,
          color: slots[0].color,
        })
      }
      setLobby({ session, slots: await fetchLobbySlots(session.id) })
    } catch (err) {
      setLobbyError(err?.message || 'Could not create the shared game.')
    }
    setLobbyBusy(false)
  }

  const handleCancelLobby = async () => {
    if (!lobby) return
    const sessionId = lobby.session.id
    setLobby(null)
    setLobbyError('')
    await cancelLobby(sessionId)
  }

  const handleStartShared = async () => {
    if (!lobby) return
    setLobbyBusy(true)
    setLobbyError('')
    try {
      const slots = await fetchLobbySlots(lobby.session.id)
      await startLobby(lobby.session.id)
      dispatch({
        type: 'hydrate',
        game: createGame({
          format, customLife: startingLife, seatCount: setup.seatCount,
          layoutId: setup.layoutId, seeds: seedsFromSlots(slots), sessionId: lobby.session.id,
        }),
      })
      setLobby(null)
    } catch (err) {
      setLobbyError(err?.message || 'Could not start the game.')
    }
    setLobbyBusy(false)
  }

  const handleHostDeck = async (deckId) => {
    if (!lobby || !user) return
    const mine = lobby.slots.find(s => s.user_id === user.id)
    if (!mine) return
    const deck = deckId === NO_DECK ? null : decks.find(d => d.id === deckId)
    try {
      await claimSlot(mine.id, {
        userId: user.id, name: mine.player_name, color: mine.color,
        deckId: deck?.id || null, deckName: deck?.name || null, artUrl: mine.art_crop_url,
      })
      setLobby(prev => ({ ...prev, slots: applySlotDeck(prev.slots, mine.id, deck) }))
    } catch (err) {
      setLobbyError(err?.message || 'Could not save your deck.')
    }
  }

  const copyJoinLink = () => {
    if (!lobby) return
    const url = getPublicAppUrl(`/join/${lobby.session.code}`)
    navigator.clipboard?.writeText(url)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
      .catch(() => showToast('Could not copy the link.', { tone: 'error' }))
  }

  // ── Game lifecycle ───────────────────────────────────────────────────────────
  const handleStartLocal = () => {
    setResumable(null)
    dispatch({
      type: 'hydrate',
      game: createGame({
        format, customLife: startingLife, seatCount: setup.seatCount, layoutId: setup.layoutId,
      }),
    })
  }

  const closeSheets = () => {
    setSeatSheet(null)
    setDamageSheet(null)
    setShowLog(false)
    setShowTools(false)
    setShowEnd(false)
  }

  const handleNewGame = () => {
    closeSheets()
    setSwapping(false)
    setPicked(null)
    dragFrom.current = null
    setConfirmNew(false)
    clearGame()
    setResumable(null)
    dispatch({ type: 'hydrate', game: null })
  }

  const handleLeave = () => {
    flushGame()
    navigate('/')
  }

  const toggleFullscreen = async () => {
    const root = document.documentElement
    try {
      if (!fullscreen) {
        if (root.requestFullscreen) { await root.requestFullscreen(); return }
        if (root.webkitRequestFullscreen) { root.webkitRequestFullscreen(); return }
      } else {
        if (document.fullscreenElement && document.exitFullscreen) { await document.exitFullscreen(); return }
        if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
          document.webkitExitFullscreen(); return
        }
      }
    } catch { /* not available — the toggle is a nicety, not a requirement */ }
    setFullscreen(v => !v)
  }

  const handleSaveResult = async ({ order, notes }) => {
    if (!game || !user) return
    setSaving(true)
    setSaveError('')

    const endedAt = Date.now()

    try {
      // Pull the seats once more for a shared game: a guest may have claimed a seat
      // or swapped decks after the game started, and that has to reach their row.
      let finalGame = game
      if (game.sessionId) {
        try {
          finalGame = mergeSlotAttribution(game, await fetchLobbySlots(game.sessionId))
        } catch { /* fall back to what the device has */ }
      }
      const placements = buildPlacements(finalGame.players, order)

      const { data: tracked, error: trackedError } = await sb.from('tracked_games')
        .insert(buildTrackedGamePayload({ game: finalGame, placements, hostUserId: user.id, endedAt }))
        .select('id')
        .single()
      if (trackedError) throw trackedError

      const rows = buildGameResultRows({
        game: finalGame, placements, hostUserId: user.id, endedAt, notes, trackedGameId: tracked.id,
      })
      if (rows.length > 0) {
        const { error } = await sb.from('game_results').insert(rows)
        if (error) throw error
      }

      if (game.sessionId) await endLobby(game.sessionId, new Date(endedAt).toISOString())
      await refreshDeckStats()

      showToast('Game saved.', { tone: 'success' })
      handleNewGame()
    } catch (err) {
      // The game stays open so nothing is lost and the save can be retried.
      const detail = [err?.message, err?.details, err?.hint].filter(Boolean).join(' ')
      setSaveError(detail ? `Could not save. ${detail}` : 'Could not save the result. Try again.')
    }
    setSaving(false)
  }

  // ── Seat swapping ────────────────────────────────────────────────────────────
  // Two ways in, one code path. Drag a seat onto another and release, or tap one
  // then tap the other. Tap exists because a drag across a phone held by three
  // people misses often, and it gives keyboard users the same feature for free.
  const exitSwap = useCallback(() => {
    setSwapping(false)
    setPicked(null)
    setDrag(null)
    dragFrom.current = null
  }, [])

  useEffect(() => {
    if (!swapping) return
    const onKey = e => { if (e.key === 'Escape') exitSwap() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [swapping, exitSwap])

  const swapWith = useCallback((from, to) => {
    if (from == null || to == null || from === to) return
    dispatch({ type: 'swapSeats', a: from, b: to })
    setPicked(null)
    setDrag(null)
    dragFrom.current = null
  }, [])

  const swapHandlers = useMemo(() => {
    // Seats do not move until the drag is released, so one measurement per drag is
    // enough. Hit testing is then pure geometry against those rects rather than
    // elementFromPoint — it forces no layout, cannot be fooled by an overlay, and
    // gives the snap preview and the release the same answer by construction.
    const measure = () => {
      const { origin, rects } = measureSeats(gridRef.current)
      gridOrigin.current = origin
      seatRects.current = rects
    }

    const seatAt = (clientX, clientY) => seatAtPoint(
      seatRects.current,
      clientX - gridOrigin.current.left,
      clientY - gridOrigin.current.top,
    )

    const handlers = {}
    for (let index = 0; index < MAX_SEATS; index++) {
      handlers[index] = {
        onSwapPointerDown: (seatIndex, e) => {
          setPicked(prev => {
            if (prev != null && prev !== seatIndex) {
              // Second tap of a tap-tap swap.
              dispatch({ type: 'swapSeats', a: prev, b: seatIndex })
              dragFrom.current = null
              setDrag(null)
              return null
            }
            if (prev === seatIndex) { dragFrom.current = null; setDrag(null); return null }
            dragFrom.current = seatIndex
            measure()
            // Capture is what makes this work on touch at all: without it,
            // pointermove stops being delivered the moment the finger leaves
            // this element, which is immediately.
            try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* optional */ }
            return seatIndex
          })
        },
        onSwapPointerMove: (seatIndex, e) => {
          const from = dragFrom.current
          if (from == null) return
          const target = seatAt(e.clientX, e.clientY)
          setDrag({
            from,
            target: target != null && target !== from ? target : null,
            point: {
              x: e.clientX - gridOrigin.current.left,
              y: e.clientY - gridOrigin.current.top,
            },
            // Carried in state rather than read from the ref at render time: the
            // rects are fixed for the whole drag, and render must not depend on a
            // ref React cannot track.
            rects: seatRects.current,
          })
        },
        onSwapPointerUp: (seatIndex, e) => {
          const from = dragFrom.current
          if (from == null) return
          const target = seatAt(e.clientX, e.clientY)
          // Released somewhere else — that was a drag. Released on itself — that was
          // a tap, so the seat stays lifted for a second tap.
          if (target != null && target !== from) swapWith(from, target)
          else { dragFrom.current = null; setDrag(null) }
        },
        onSwapActivate: (seatIndex) => {
          setPicked(prev => {
            if (prev == null) return seatIndex
            if (prev === seatIndex) return null
            dispatch({ type: 'swapSeats', a: prev, b: seatIndex })
            return null
          })
        },
      }
    }
    return handlers
  }, [swapWith])

  // ── Seat handlers ────────────────────────────────────────────────────────────
  // Built once and keyed by seat index so they are referentially stable, which is
  // what lets SeatPanel's memo do its job: one tap re-renders one seat instead of
  // every seat, every art image and every chip on the table.
  const seatHandlers = useMemo(() => {
    const handlers = {}
    for (let id = 0; id < MAX_SEATS; id++) {
      handlers[id] = {
        onLife: delta => dispatch({ type: 'life', id, delta }),
        onOpenSeat: () => setSeatSheet(id),
        onOpenDamage: () => setDamageSheet(id),
      }
    }
    return handlers
  }, [])

  // Opponent lists only carry identity, so they are rebuilt when identity changes
  // rather than on every life change — a direct comparison of the fields the rail
  // actually reads.
  const identityKey = game?.players.map(p => `${p.id}:${p.color}:${p.hasPartner ? 1 : 0}:${p.name}`).join('|')
  const opponentsBySeat = useMemo(() => {
    if (!game) return {}
    const out = {}
    for (const player of game.players) {
      out[player.id] = game.players
        .filter(other => other.id !== player.id)
        .map(({ id, name, color, hasPartner }) => ({ id, name, color, hasPartner }))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey])

  const layout = game ? findLayout(game.seatCount, game.layoutId) : null
  const commander = game ? isCommanderFormat(game.format) : false
  const seatSheetPlayer = game?.players.find(p => p.id === seatSheet) || null
  const damageSheetPlayer = game?.players.find(p => p.id === damageSheet) || null
  // Rotation belongs to the position a player currently sits in, not their id —
  // seats can be swapped, so the two are not the same thing.
  const rotationOf = (id) => {
    const index = game?.players.findIndex(p => p.id === id) ?? -1
    return index < 0 ? 0 : (layout?.seats[index]?.rotation ?? 0)
  }

  // ── Game table ───────────────────────────────────────────────────────────────
  if (game) {
    return (
      <div className={styles.table} data-fullscreen={fullscreen ? 'true' : undefined}>
        <div className={styles.bar} data-mode={swapping ? 'swap' : undefined}>
          {swapping ? (
            <>
              <span className={styles.barSwapHint}>
                {picked != null
                  ? `Moving ${game.players[picked]?.name} — choose a seat`
                  : 'Drag a seat onto another, or tap two seats'}
              </span>
              <Button size="lg" variant="primary" onClick={exitSwap}>
                <CheckIcon size={14} /> Done
              </Button>
            </>
          ) : (
          <>
          <span className={styles.barLabel}>
            {LIFE_FORMATS[game.format]?.label || game.format} · {game.players.length}
            {game.sessionId && <span className={styles.sharedDot} title="Shared game" />}
          </span>

          <div className={styles.barActions}>
            <button className={styles.iconBtn} onClick={() => setShowTools(true)} aria-label="Table tools">
              <DiceIcon size={15} />
            </button>
            <button className={styles.iconBtn} onClick={() => setShowLog(true)} aria-label="Game log">
              <ListIcon size={15} />
            </button>

            <ResponsiveMenu title="Game" align="right" portal
              trigger={({ toggle }) => (
                <button className={styles.iconBtn} onClick={toggle} aria-label="Game menu">
                  <MenuIcon size={15} />
                </button>
              )}>
              {({ close }) => (
                <div className={uiStyles.responsiveMenuList}>
                  <div className={uiStyles.responsiveMenuSectionLabel}>Seating</div>
                  {layoutsFor(game.seatCount).map(option => (
                    <button key={option.id}
                      className={`${uiStyles.responsiveMenuAction} ${option.id === game.layoutId ? uiStyles.responsiveMenuActionActive : ''}`}
                      onClick={() => { dispatch({ type: 'setLayout', layoutId: option.id }); close() }}>
                      {option.label}
                      {option.id === game.layoutId && (
                        <span className={uiStyles.responsiveMenuCheck}><CheckIcon size={11} /></span>
                      )}
                    </button>
                  ))}
                  <button className={uiStyles.responsiveMenuAction}
                    onClick={() => { setSwapping(true); setPicked(null); close() }}>
                    Swap seats…
                  </button>

                  <div className={uiStyles.responsiveMenuSectionLabel}>Game</div>
                  <button className={uiStyles.responsiveMenuAction}
                    onClick={() => { dispatch({ type: 'reset' }); close() }}>
                    Reset totals
                  </button>
                  <button className={uiStyles.responsiveMenuAction}
                    onClick={() => { toggleFullscreen(); close() }}>
                    {fullscreen ? 'Exit full screen' : 'Full screen'}
                  </button>
                  <button className={uiStyles.responsiveMenuAction}
                    onClick={() => { handleLeave(); close() }}>
                    Leave tracker
                  </button>
                  {/* Danger is a colour-only modifier — the base action class
                      carries the row's border, height and typography. */}
                  <button
                    className={`${uiStyles.responsiveMenuAction} ${uiStyles.responsiveMenuActionDanger}`}
                    onClick={() => { setConfirmNew(true); close() }}>
                    Discard game
                  </button>
                </div>
              )}
            </ResponsiveMenu>

            <Button size="sm" variant="primary" onClick={() => setShowEnd(true)}>End</Button>
          </div>
          </>
          )}
        </div>

        <div
          ref={gridRef}
          className={styles.grid}
          style={{
            gridTemplateAreas: layout.areas,
            gridTemplateColumns: layout.cols,
            gridTemplateRows: layout.rows,
          }}
        >
          {game.players.map((player, index) => (
            <SeatPanel
              key={player.id}
              player={player}
              seatIndex={index}
              opponents={opponentsBySeat[player.id] || []}
              rotation={layout.seats[index]?.rotation ?? 0}
              area={layout.seats[index]?.area}
              commander={commander}
              dead={isPlayerDead(player)}
              deathText={deathTextFor(game, player)}
              swapping={swapping}
              picked={picked === index}
              dropTarget={drag?.target === index}
              onLife={seatHandlers[player.id].onLife}
              onOpenSeat={seatHandlers[player.id].onOpenSeat}
              onOpenDamage={seatHandlers[player.id].onOpenDamage}
              onSwapPointerDown={swapHandlers[index].onSwapPointerDown}
              onSwapPointerMove={swapHandlers[index].onSwapPointerMove}
              onSwapPointerUp={swapHandlers[index].onSwapPointerUp}
              onSwapActivate={swapHandlers[index].onSwapActivate}
            />
          ))}

          {/* Snaps to the target seat's centre once the finger is over one, and
              follows the finger otherwise, so it always says where the seat is
              headed. */}
          {drag && (
            <SwapArrow
              from={seatCentre(drag.rects, drag.from)}
              to={drag.target != null ? seatCentre(drag.rects, drag.target) : drag.point}
              snapped={drag.target != null}
            />
          )}
        </div>

        {seatSheetPlayer && (
          <SeatSheet
            player={seatSheetPlayer}
            decks={decks}
            deckStats={deckStats}
            commander={commander}
            rotation={rotationOf(seatSheetPlayer.id)}
            onPatch={patch => dispatch({ type: 'patchPlayer', id: seatSheetPlayer.id, patch })}
            onCounter={(key, delta) => dispatch({ type: 'counter', id: seatSheetPlayer.id, key, delta })}
            onTax={(slot, delta) => dispatch({ type: 'tax', id: seatSheetPlayer.id, slot, delta })}
            onClose={() => setSeatSheet(null)}
          />
        )}

        {damageSheetPlayer && (
          <CmdDamageSheet
            player={damageSheetPlayer}
            opponents={opponentsBySeat[damageSheetPlayer.id] || []}
            rotation={rotationOf(damageSheetPlayer.id)}
            onDamage={(fromId, slot, delta) =>
              dispatch({ type: 'cmdDamage', id: damageSheetPlayer.id, fromId, slot, delta })}
            onClose={() => setDamageSheet(null)}
          />
        )}

        {showLog && <GameLogSheet log={game.log} onClose={() => setShowLog(false)} />}
        {showTools && <ToolsSheet players={game.players} onClose={() => setShowTools(false)} />}

        {showEnd && (
          <EndGameSheet
            players={game.players}
            saving={saving}
            error={saveError}
            onSave={handleSaveResult}
            onClose={() => { setShowEnd(false); setSaveError('') }}
          />
        )}

        {confirmNew && (
          <ConfirmModal
            title="Discard this game?"
            message="Life totals and the game log are deleted. Nothing is saved to your stats."
            confirmLabel="Discard"
            onConfirm={handleNewGame}
            onClose={() => setConfirmNew(false)}
          />
        )}
      </div>
    )
  }

  // ── Lobby ────────────────────────────────────────────────────────────────────
  if (lobby) {
    const claimed = lobby.slots.filter(s => s.user_id).length
    const mine = lobby.slots.find(s => s.user_id === user?.id)
    return (
      <div className={styles.page}>
        <div className={styles.setup}>
          <header className={styles.setupHead}>
            <span className={styles.eyebrow}>Shared game</span>
            <h1 className={styles.title}>Others join to track their decks</h1>
            <p className={styles.lede}>
              Life is tracked here, on this device. Anyone who joins gets the result
              saved to their own deck record.
            </p>
          </header>

          <div className={styles.codeCard}>
            <span className={styles.codeLabel}>Join code</span>
            <span className={styles.code}>{lobby.session.code}</span>
            <Button variant="secondary" onClick={copyJoinLink}>
              {copied ? <><CheckIcon size={13} /> Copied</> : <><CopyIcon size={13} /> Copy link</>}
            </Button>
          </div>

          <div className={styles.slotList}>
            {lobby.slots.map(slot => (
              <div key={slot.id} className={styles.slot}
                data-claimed={slot.user_id ? 'true' : undefined}>
                <span className={styles.slotDot} style={{ '--sw': slot.color }} />
                <div className={styles.slotBody}>
                  <span className={styles.slotName}>{slot.player_name}</span>
                  <span className={styles.slotMeta}>
                    {slot.user_id
                      ? (slot.deck_name || 'No deck chosen')
                      : 'Open — waiting for a player'}
                  </span>
                </div>
                {slot.user_id && <CheckIcon size={14} />}
              </div>
            ))}
          </div>

          {mine && decks.length > 0 && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Your deck</span>
              <Select value={mine.deck_id || NO_DECK} onChange={e => handleHostDeck(e.target.value)}
                searchable title="Select your deck">
                <option value={NO_DECK}>— No deck —</option>
                {decks.map(deck => <option key={deck.id} value={deck.id}>{deck.name}</option>)}
              </Select>
            </div>
          )}

          <ErrorBox>{lobbyError}</ErrorBox>

          <div className={styles.setupActions}>
            <Button variant="primary" size="lg" block onClick={handleStartShared} disabled={lobbyBusy}>
              {lobbyBusy ? 'Starting…' : `Start game · ${claimed} joined`}
            </Button>
            <Button variant="ghost" block onClick={handleCancelLobby} disabled={lobbyBusy}>
              Cancel shared game
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ── Setup ────────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>
      <div className={styles.setup}>
        <header className={styles.setupHead}>
          <span className={styles.eyebrow}>Life tracker</span>
          <h1 className={styles.title}>Set the table</h1>
        </header>

        {resumable && (
          <div className={styles.resume}>
            <div className={styles.resumeBody}>
              <span className={styles.resumeTitle}>Game in progress</span>
              <span className={styles.resumeMeta}>
                {LIFE_FORMATS[resumable.game.format]?.label || resumable.game.format}
                {' · '}{resumable.game.players.length} players
                {' · '}{resumable.label}
              </span>
            </div>
            <Button variant="primary"
              onClick={() => { dispatch({ type: 'hydrate', game: resumable.game }); setResumable(null) }}>
              Resume
            </Button>
            <Button variant="ghost" onClick={() => { clearGame(); setResumable(null) }}>Discard</Button>
          </div>
        )}

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Format</span>
          <div className={styles.chipRow}>
            {FORMAT_ORDER.map(key => (
              <Button key={key} variant="toggle" active={format === key}
                onClick={() => setSetup(prev => ({
                  ...prev,
                  format: key,
                  seatCount: LIFE_FORMATS[key].seats,
                  layoutId: null,
                }))}>
                {LIFE_FORMATS[key].label}
              </Button>
            ))}
          </div>
        </div>

        <div className={styles.lifeCard}>
          <span className={styles.fieldLabel}>Starting life</span>
          {format === 'custom' ? (
            <input
              className={styles.lifeInput}
              type="text"
              inputMode="numeric"
              value={setup.customLife}
              aria-label="Starting life"
              // Stored as typed and only clamped on commit. Clamping every
              // keystroke was the old field's bug: Number('') is 0, which snapped
              // the value to 1 the moment you cleared it to type a new number.
              onChange={e => {
                const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 3)
                setSetup(prev => ({ ...prev, customLife: digits }))
              }}
              onBlur={() => setSetup(prev => ({ ...prev, customLife: clampLife(prev.customLife) }))}
            />
          ) : (
            <span className={styles.lifeValue}>{startingLife}</span>
          )}
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Players</span>
          <div className={styles.chipRow}>
            {SEAT_OPTIONS.map(count => (
              <Button key={count} variant="toggle" active={setup.seatCount === count}
                onClick={() => setSetup(prev => ({ ...prev, seatCount: count, layoutId: null }))}>
                {count}
              </Button>
            ))}
          </div>
        </div>

        {layoutOptions.length > 1 && (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Seating</span>
            <div className={styles.layoutRow}>
              {layoutOptions.map(option => (
                <button key={option.id} type="button" className={styles.layoutOption}
                  data-active={activeSetupLayout.id === option.id ? 'true' : undefined}
                  onClick={() => setSetup(prev => ({ ...prev, layoutId: option.id }))}>
                  <span className={styles.layoutMap}
                    style={{
                      gridTemplateAreas: option.areas,
                      gridTemplateColumns: option.cols,
                      gridTemplateRows: option.rows,
                    }}>
                    {option.seats.map((s, i) => (
                      <span key={i} className={styles.layoutSeat}
                        style={{ gridArea: s.area }} data-rot={s.rotation} />
                    ))}
                  </span>
                  <span className={styles.layoutLabel}>{option.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={styles.setupActions}>
          <Button variant="primary" size="lg" block onClick={handleStartLocal}>
            <SwordIcon size={14} /> Start game
          </Button>
          <Button variant="secondary" block onClick={handleHostGame} disabled={lobbyBusy || !user}>
            <PlayerIcon size={14} /> {lobbyBusy ? 'Creating…' : 'Host a shared game'}
          </Button>
          <Button variant="ghost" block onClick={() => navigate('/stats')}>
            <TrophyIcon size={14} /> Past games and win rates
          </Button>
        </div>

        <ErrorBox>{lobbyError}</ErrorBox>

        <p className={styles.footNote}>
          Set names, colours, art and decks by tapping a seat once the game is running.
        </p>
      </div>
    </div>
  )
}

// Applies the host's deck choice to the local slot list without a refetch.
function applySlotDeck(slots, slotId, deck) {
  return slots.map(slot => (
    slot.id === slotId
      ? { ...slot, deck_id: deck?.id || null, deck_name: deck?.name || null }
      : slot
  ))
}
