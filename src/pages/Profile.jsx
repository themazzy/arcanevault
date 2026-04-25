import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { useSettings, DEFAULT_BENTO_CONFIG } from '../components/SettingsContext'
import styles from './Profile.module.css'

// ── Block metadata ────────────────────────────────────────────────────────────
const BLOCK_DEFS = {
  bio:        { label: 'Bio',              span: 'full' },
  total:      { label: 'Total Cards',      span: 'third' },
  unique:     { label: 'Unique Prints',    span: 'third' },
  since:      { label: 'Member Since',     span: 'third' },
  value:      { label: 'Est. Value',       span: 'third' },
  deck_count: { label: 'Public Decks',     span: 'third' },
  crown:      { label: 'Crown Jewel',      span: 'third' },
  decks:      { label: 'Deck Showcase',    span: 'full' },
}

function mergeBlocks(configBlocks) {
  const allIds = Object.keys(BLOCK_DEFS)
  const existing = configBlocks || []
  const existingIds = existing.map(b => b.id)
  return [
    ...existing.filter(b => allIds.includes(b.id)),
    ...allIds.filter(id => !existingIds.includes(id)).map(id => ({ id, enabled: false })),
  ]
}

function fmtNum(val) {
  return val != null && typeof val === 'number' ? val.toLocaleString() : '—'
}

// ── Block renderers ───────────────────────────────────────────────────────────
function BioBlock({ bio, editMode, onChangeBio }) {
  if (editMode) {
    return (
      <div className={styles.blockInner}>
        <div className={styles.blockTitle}>Bio</div>
        <textarea
          className={styles.bioTextarea}
          value={bio}
          onChange={e => onChangeBio(e.target.value)}
          placeholder="Tell the community about yourself…"
          maxLength={500}
          rows={4}
        />
        <div className={styles.bioCount}>{bio.length}/500</div>
      </div>
    )
  }
  if (!bio) return null
  return (
    <div className={styles.blockInner}>
      <div className={styles.bioText}>{bio}</div>
    </div>
  )
}

function StatBlock({ label, value, sub }) {
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>{label}</div>
      <div className={styles.statBig}>{value}</div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  )
}

const MANA_SYMBOL_URL = c => `https://svgs.scryfall.io/card-symbols/${c}.svg`
const FORMAT_LABEL = { standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern', legacy: 'Legacy', vintage: 'Vintage', commander: 'Commander', pauper: 'Pauper', historic: 'Historic', explorer: 'Explorer', alchemy: 'Alchemy', brawl: 'Brawl', oathbreaker: 'Oathbreaker' }

const _artCache = {}
function useDeckArt(coverArtUri, commanderScryfallId) {
  const [art, setArt] = useState(coverArtUri || _artCache[commanderScryfallId] || null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    if (art || !commanderScryfallId) return
    fetch(`https://api.scryfall.com/cards/${commanderScryfallId}?format=json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const url = d?.image_uris?.art_crop || d?.card_faces?.[0]?.image_uris?.art_crop || null
        if (url) { _artCache[commanderScryfallId] = url }
        if (mounted.current && url) setArt(url)
      })
      .catch(() => {})
    return () => { mounted.current = false }
  }, [commanderScryfallId])
  return art
}

function ProfileDeckTile({ deck }) {
  const art = useDeckArt(deck.cover_art_uri, deck.commander_scryfall_id)
  const colors = Array.isArray(deck.color_identity) ? deck.color_identity : []
  const fmtLabel = FORMAT_LABEL[deck.format] || null
  const isCollection = deck.type === 'deck'

  return (
    <Link to={`/d/${deck.id}`} className={styles.deckTile}>
      {art && <div className={styles.deckTileArt} style={{ backgroundImage: `url(${art})` }} />}
      <div className={styles.deckTileContent}>
        <div className={styles.deckTileTop}>
          <div className={styles.deckTileBadges}>
            {isCollection
              ? <span className={styles.deckBadgeCollection}>Collection</span>
              : <span className={styles.deckBadgeFormat}>{fmtLabel || 'Builder'}</span>
            }
            {isCollection && fmtLabel && (
              <span className={styles.deckBadgeFormat}>{fmtLabel}</span>
            )}
          </div>
        </div>
        <div className={styles.deckTileBottom}>
          <div className={styles.deckTileName}>{deck.name}</div>
          {deck.commander_name && (
            <div className={styles.deckTileCommander}>{deck.commander_name}</div>
          )}
          {colors.length > 0 && (
            <div className={styles.deckTilePips}>
              {colors.map(c => (
                <img key={c} className={styles.deckTilePip} src={MANA_SYMBOL_URL(c)} alt={c} title={c} />
              ))}
            </div>
          )}
          <div className={styles.deckTileCount}>{deck.card_count} cards</div>
        </div>
      </div>
    </Link>
  )
}

function DecksBlock({ decks }) {
  if (!decks?.length) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Deck Showcase</div>
      <div className={styles.emptyNote}>No public decks yet.</div>
    </div>
  )
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Deck Showcase</div>
      <div className={styles.deckGrid}>
        {decks.map(deck => <ProfileDeckTile key={deck.id} deck={deck} />)}
      </div>
    </div>
  )
}

function CrownBlock({ topCard }) {
  if (!topCard) return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Crown Jewel</div>
      <div className={styles.emptyNote}>No price data yet.</div>
    </div>
  )
  return (
    <div className={styles.blockInner}>
      <div className={styles.blockTitle}>Crown Jewel</div>
      <div className={styles.crownWrap}>
        {topCard.image_uri && (
          <img className={styles.crownImg} src={topCard.image_uri} alt={topCard.name} loading="lazy" />
        )}
        <div className={styles.crownInfo}>
          <div className={styles.crownName}>{topCard.name}</div>
          <div className={styles.crownSet}>{(topCard.set_code || '').toUpperCase()} #{topCard.collector_number}</div>
          {topCard.price != null && (
            <div className={styles.crownPrice}>€{Number(topCard.price).toFixed(2)}</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const { username } = useParams()
  const { user } = useAuth()
  const settings = useSettings()
  const navigate = useNavigate()

  const [profile, setProfile]         = useState(null)
  const [publicDecks, setPublicDecks] = useState([])
  const [loading, setLoading]         = useState(true)
  const [notFound, setNotFound]       = useState(false)

  const [editMode, setEditMode]       = useState(false)
  const [draftBio, setDraftBio]       = useState('')
  const [draftAccent, setDraftAccent] = useState('')
  const [draftBlocks, setDraftBlocks] = useState([])
  const [saving, setSaving]           = useState(false)

  const bentoGridRef = useRef(null)
  const layoutRectsRef = useRef(new Map())
  const trayRef = useRef(null)
  const blockElemsRef = useRef({})
  const dragRef = useRef(null) // { id, dropBeforeId, trayActive }
  const [draggingId, setDraggingId] = useState(null)
  const [ghostPos, setGhostPos] = useState(null)
  const [dropBeforeId, setDropBeforeId] = useState(null)
  const [trayDropActive, setTrayDropActive] = useState(false)

  // ── Pointer drag + edge-scroll ─────────────────────────────────────────────
  useEffect(() => {
    if (!draggingId) return

    const EDGE_ZONE = 80, MAX_SPEED = 8
    let rafId, lastY = 0
    const step = () => {
      const vh = window.innerHeight
      let s = 0
      if (lastY < EDGE_ZONE) s = -MAX_SPEED * (1 - lastY / EDGE_ZONE)
      else if (lastY > vh - EDGE_ZONE) s = MAX_SPEED * (1 - (vh - lastY) / EDGE_ZONE)
      if (s) window.scrollBy(0, s)
      rafId = requestAnimationFrame(step)
    }
    rafId = requestAnimationFrame(step)

    function findTarget(x, y) {
      const tray = trayRef.current
      if (tray) {
        const r = tray.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return 'tray'
      }
      for (const [id, el] of Object.entries(blockElemsRef.current)) {
        if (!el || id === draggingId) continue
        const r = el.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id
      }
      return '__end__'
    }

    function onMove(e) {
      lastY = e.clientY
      setGhostPos({ x: e.clientX, y: e.clientY })
      const target = findTarget(e.clientX, e.clientY)
      if (!dragRef.current) return
      if (target === 'tray') {
        dragRef.current.dropBeforeId = null
        dragRef.current.trayActive = true
        setDropBeforeId(null); setTrayDropActive(true)
      } else {
        dragRef.current.dropBeforeId = target
        dragRef.current.trayActive = false
        setDropBeforeId(target); setTrayDropActive(false)
      }
    }

    function onUp() {
      const drag = dragRef.current
      if (drag) {
        if (drag.trayActive) {
          setDraftBlocks(prev => prev.map(b => b.id === drag.id ? { ...b, enabled: false } : b))
        } else if (drag.dropBeforeId) {
          setDraftBlocks(prev => {
            const cur = prev.find(b => b.id === drag.id)
            if (!cur) return prev
            const rest = prev.filter(b => b.id !== drag.id)
            const appendEnd = () => {
              const li = rest.reduce((l, b, i) => b.enabled ? i : l, -1)
              const n = [...rest]; n.splice(li + 1, 0, { ...cur, enabled: true }); return n
            }
            if (drag.dropBeforeId === '__end__') return appendEnd()
            const idx = rest.findIndex(b => b.id === drag.dropBeforeId)
            if (idx === -1) return appendEnd()
            const n = [...rest]; n.splice(idx, 0, { ...cur, enabled: true }); return n
          })
        }
      }
      dragRef.current = null
      setDraggingId(null); setGhostPos(null); setDropBeforeId(null); setTrayDropActive(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [draggingId])

  const decodedUsername = decodeURIComponent(username)
  const isOwn = !!(user && settings.nickname &&
    decodedUsername.toLowerCase() === settings.nickname.toLowerCase())

  const ownProfileFallback = useMemo(() => ({
    user_id:      user?.id,
    nickname:     settings.nickname,
    bio:          settings.profile_bio || '',
    accent:       settings.profile_accent || '',
    premium:      settings.premium,
    bento_config: settings.profile_config || DEFAULT_BENTO_CONFIG,
    stats:        null,
    top_card:     null,
    joined_at:    null,
    collection_value: null,
    public_deck_count: null,
  }), [
    user?.id,
    settings.nickname,
    settings.profile_bio,
    settings.profile_accent,
    settings.premium,
    settings.profile_config,
  ])
  // Keep a ref so loadProfile can read the latest fallback without depending on it
  const ownProfileFallbackRef = useRef(ownProfileFallback)
  useEffect(() => { ownProfileFallbackRef.current = ownProfileFallback }, [ownProfileFallback])

  // ── Load ───────────────────────────────────────────────────────────────────
  const loadProfile = useCallback(async () => {
    setLoading(true)
    setNotFound(false)

    const { data, error } = await sb.rpc('get_public_profile', { p_username: decodedUsername })
    if (error || !data) {
      // Migration may not have run yet — fall back to local settings
      if (isOwn) {
        setProfile(ownProfileFallbackRef.current)
        setPublicDecks([])
      } else {
        setNotFound(true)
      }
      setLoading(false)
      return
    }

    setProfile(data)
    sb.rpc('get_public_decks', { p_user_id: data.user_id })
      .then(({ data: decks }) => setPublicDecks(decks || []))
      .catch(() => {})
    setLoading(false)
  }, [decodedUsername, isOwn])

  useEffect(() => { loadProfile() }, [loadProfile])

  // ── Keep own profile in sync with settings changes ────────────────────────
  useEffect(() => {
    if (!isOwn) return
    setProfile(prev => prev ? {
      ...prev,
      nickname:     settings.nickname,
      bio:          settings.profile_bio   ?? prev.bio,
      accent:       settings.profile_accent ?? prev.accent,
      bento_config: settings.profile_config ?? prev.bento_config,
      premium:      settings.premium,
    } : prev)
  }, [isOwn, settings.nickname, settings.profile_bio, settings.profile_accent, settings.profile_config, settings.premium])

  // ── Edit mode ──────────────────────────────────────────────────────────────
  function enterEdit() {
    setDraftBio(profile?.bio || '')
    setDraftAccent(profile?.accent || '')
    setDraftBlocks(mergeBlocks(profile?.bento_config?.blocks))
    setEditMode(true)
  }
  function cancelEdit() { setEditMode(false) }

  async function saveEdit() {
    setSaving(true)
    await sb.from('user_settings').update({
      profile_bio:    draftBio,
      profile_accent: draftAccent,
      profile_config: { blocks: draftBlocks },
      updated_at:     new Date().toISOString(),
    }).eq('user_id', user.id)
    settings.save({ profile_bio: draftBio, profile_accent: draftAccent, profile_config: { blocks: draftBlocks } })
    setProfile(prev => prev ? { ...prev, bio: draftBio, accent: draftAccent, bento_config: { blocks: draftBlocks } } : prev)
    setEditMode(false)
    setSaving(false)
  }

  // ── Drag helpers ───────────────────────────────────────────────────────────
  function hideBlock(blockId) {
    setDraftBlocks(prev => prev.map(b => b.id === blockId ? { ...b, enabled: false } : b))
  }

  function onDragHandlePointerDown(e, blockId) {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { id: blockId, dropBeforeId: null, trayActive: false }
    setDraggingId(blockId)
    setGhostPos({ x: e.clientX, y: e.clientY })
  }

  // ── Render helpers ─────────────────────────────────────────────────────────
  const blocks      = editMode ? draftBlocks : mergeBlocks(profile?.bento_config?.blocks)
  const enabledBlocks = useMemo(() => blocks.filter(block => block.enabled), [blocks])
  const availableBlocks = useMemo(() => blocks.filter(block => !block.enabled), [blocks])
  const visibleBlocks = editMode ? enabledBlocks : blocks.filter(block => block.enabled)
  const accentColor = (editMode ? draftAccent : profile?.accent) || 'var(--gold)'
  const displayName = profile?.nickname || username

  useLayoutEffect(() => {
    if (!editMode || !bentoGridRef.current) return
    const nodes = Array.from(bentoGridRef.current.querySelectorAll('[data-layout-key]'))
    const nextRects = new Map()

    nodes.forEach(node => {
      const key = node.getAttribute('data-layout-key')
      if (!key) return
      const next = node.getBoundingClientRect()
      const prev = layoutRectsRef.current.get(key)
      nextRects.set(key, next)

      if (!prev) return
      const dx = prev.left - next.left
      const dy = prev.top - next.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return

      node.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0, 0)' },
        ],
        { duration: 170, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
      )
    })

    layoutRectsRef.current = nextRects
  }, [editMode, draggingId, visibleBlocks])

  function renderBlock(block) {
    const { stats, top_card, joined_at, collection_value, public_deck_count } = profile || {}
    switch (block.id) {
      case 'bio':
        return <BioBlock bio={editMode ? draftBio : (profile?.bio || '')} editMode={editMode} onChangeBio={setDraftBio} />
      case 'total':
        return <StatBlock label="Total Cards"   value={fmtNum(stats?.total_cards)}  />
      case 'unique':
        return <StatBlock label="Unique Prints"  value={fmtNum(stats?.unique_cards)} />
      case 'since':
        return <StatBlock label="Member Since"   value={joined_at ? new Date(joined_at).getFullYear() : '—'} />
      case 'value':
        return <StatBlock label="Est. Value" value={collection_value != null ? `€${Number(collection_value).toFixed(2)}` : '—'} />
      case 'deck_count':
        return <StatBlock label="Public Decks"   value={fmtNum(public_deck_count)} />
      case 'crown':
        return <CrownBlock topCard={top_card} />
      case 'decks':
        return <DecksBlock decks={publicDecks} />
      default:
        return null
    }
  }

  // ── Span resolution ────────────────────────────────────────────────────────
  function spanClass(id) {
    const span = BLOCK_DEFS[id]?.span
    if (span === 'full')  return styles.blockFull
    if (span === 'third') return styles.blockThird
    return styles.blockHalf
  }

  if (loading) return (
    <div className={styles.page}>
      <div className={styles.loadingMsg}>Loading profile…</div>
    </div>
  )

  if (notFound) return (
    <div className={styles.page}>
      <div className={styles.notFound}>
        <div className={styles.notFoundTitle}>Profile not found</div>
        <div className={styles.notFoundSub}>No user with the nickname "{username}" was found.</div>
        <Link to="/" className={styles.notFoundLink}>← Back to Home</Link>
      </div>
    </div>
  )

  return (
    <div className={styles.page}>
      {/* ── Profile header ── */}
      <div className={styles.header} style={{ '--profile-accent': accentColor }}>
        <div className={styles.headerAccentBar} />
        <div className={styles.headerContent}>
          <div className={styles.avatar} style={{ borderColor: accentColor, color: accentColor }}>
            {(displayName[0] || '?').toUpperCase()}
          </div>
          <div className={styles.headerInfo}>
            <div className={styles.displayName}>
              {displayName}
              {profile?.premium && <span className={styles.premiumBadge}>✦ Supporter</span>}
            </div>
          </div>
          <div className={styles.headerActions}>
            {isOwn && !editMode && (
              <button className={styles.editBtn} onClick={enterEdit}>Edit Profile</button>
            )}
            {isOwn && editMode && (
              <>
                <label className={styles.accentLabel}>
                  Accent
                  <input
                    type="color"
                    className={styles.accentInput}
                    value={draftAccent || '#c9a84c'}
                    onChange={e => setDraftAccent(e.target.value)}
                  />
                </label>
                <button className={styles.saveBtn} onClick={saveEdit} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button className={styles.cancelBtn} onClick={cancelEdit}>Cancel</button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Bento grid ── */}
      <div className={`${styles.bentoEditor}${editMode ? ' ' + styles.bentoEditorActive : ''}`}>
        <div ref={bentoGridRef} className={`${styles.bento}${editMode ? ' ' + styles.bentoEdit : ''}`}>
          {editMode && (
            <div className={styles.editHint} data-layout-key="edit-hint">Drag cards to reorder. Use ✕ to move a card to Available.</div>
          )}

          {visibleBlocks.map((block) => {
            const def = BLOCK_DEFS[block.id]
            if (!def) return null
            const isDragging = draggingId === block.id
            const isDropTarget = editMode && !!draggingId && dropBeforeId === block.id

            return (
              <div
                key={block.id}
                ref={el => { blockElemsRef.current[block.id] = el }}
                className={`${styles.blockOuter} ${spanClass(block.id)} ${isDragging ? styles.blockDragging : ''} ${isDropTarget ? styles.blockDropTarget : ''}`}
                data-layout-key={`block-${block.id}`}
              >
                {editMode && (
                  <div
                    className={styles.blockEditBar}
                    onPointerDown={e => onDragHandlePointerDown(e, block.id)}
                  >
                    <span className={styles.blockDragHandle}>⠿</span>
                    <span className={styles.blockEditLabel}>{def.label}</span>
                    <button
                      className={styles.blockRemoveBtn}
                      onPointerDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); hideBlock(block.id) }}
                      title="Remove from grid"
                      aria-label={`Remove ${def.label}`}
                    >✕</button>
                  </div>
                )}
                {renderBlock(block)}
              </div>
            )
          })}
        </div>

        {editMode && (
          <aside
            ref={trayRef}
            className={`${styles.availablePanel} ${trayDropActive ? styles.availablePanelActive : ''}`}
          >
            <div className={styles.availableTitle}>Available</div>
            <div className={styles.availableSub}>Drag cards here to hide them from the profile.</div>
            <div className={styles.availableList}>
              {availableBlocks.length === 0 ? (
                <div className={styles.availableEmpty}>All cards are on the grid.</div>
              ) : availableBlocks.map(block => {
                const def = BLOCK_DEFS[block.id]
                if (!def) return null
                return (
                  <div
                    key={block.id}
                    className={`${styles.availableItem} ${draggingId === block.id ? styles.availableItemDragging : ''}`}
                    onPointerDown={e => onDragHandlePointerDown(e, block.id)}
                  >
                    <span className={styles.blockDragHandle}>⠿</span>
                    <span className={styles.availableItemText}>
                      <span className={styles.availableItemName}>{def.label}</span>
                      <span className={styles.availableItemSpan}>{def.span}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </aside>
        )}
      </div>

      {editMode && ghostPos && draggingId && (
        <div
          className={styles.dragGhost}
          style={{ transform: `translate(${ghostPos.x + 14}px, ${ghostPos.y - 10}px)` }}
          aria-hidden="true"
        >
          <span>⠿</span>
          {BLOCK_DEFS[draggingId]?.label || draggingId}
        </div>
      )}
    </div>
  )
}
