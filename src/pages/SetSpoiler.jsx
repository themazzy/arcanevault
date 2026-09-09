import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import PublicPageFooter from '../components/PublicPageFooter'
import CardImg from '../components/CardImg'
import { useAuth } from '../components/Auth'
import { useToast } from '../components/ToastContext'
import { Button, EmptyState, ErrorBox, Modal, SearchInput, Select } from '../components/UI'
import { ChevronLeftIcon, ExternalLinkIcon, FilterIcon, SearchIcon, WishlistsIcon } from '../icons'
import { sb } from '../lib/supabase'
import { addMissingToWishlist } from '../lib/setCompletion'
import { rarityColor } from '../lib/rarity'
import { useSettings } from '../components/SettingsContext'
import { getPrice, formatPrice } from '../lib/scryfall'
import { useCardPreview, HOVER_PREVIEW_W } from '../components/deckBuilder/useCardPreview'
import {
  EMPTY_SPOILER_FILTERS,
  RARITIES,
  PRINTING_MODES,
  SPOILER_SORTS,
  countdownLabel,
  daysUntil,
  extractMechanics,
  fetchAllSets,
  fetchMechanicHistory,
  fetchSetPrices,
  fetchSpoiledCards,
  attachPrices,
  applyPrintingMode,
  countUniqueCards,
  filterSpoilerCards,
  formatReleaseDate,
  isNewMechanic,
  mechanicReminderText,
  setTypeLabel,
  sortSpoilerCards,
  summarizeSpoilers,
  todayIso,
} from '../lib/upcomingSets'
import styles from './SetSpoiler.module.css'

// Public spoiler page at /sets/:code — every card Scryfall knows about in one
// set, with the set's own facts derived from those cards rather than from a
// blurb someone has to write per release.
//
// The cards are the page. Rarity, colour, type and mechanic counts are filters
// rather than statistics, so they live in a rail beside the grid: as full-width
// panels above it they pushed the first card below the fold and were read once
// and never used.

// The painted width of a grid tile; CardImg needs the real CSS width to pick a
// Scryfall image tier, and it must match .grid in the stylesheet.
const TILE_WIDTH = 208
// Novelty is one Scryfall request per mechanic. A set has ~25; the cap is there
// so a pathological set cannot spend a minute of rate-limited requests.
const MAX_MECHANIC_LOOKUPS = 40
// Enough mechanics to say what a set is about; the rest are one click away
// rather than turning the rail into a column of evergreen keywords.
const MECHANICS_BEFORE_FOLD = 8

// Matches the collection grid: a card image is not a draggable asset, and the
// long-press callout fights the tap target on touch.
const NON_DRAGGABLE_IMG_PROPS = {
  draggable: false,
  onDragStart: e => e.preventDefault(),
  onContextMenu: e => e.preventDefault(),
}

function ManaSymbol({ sym, size = 15 }) {
  const key = sym.replace(/\//g, '').toUpperCase()
  return (
    <img
      className={styles.manaSymbol}
      style={{ width: size, height: size }}
      src={`https://svgs.scryfall.io/card-symbols/${key}.svg`}
      alt={`{${sym}}`}
    />
  )
}

function ManaCost({ cost, size = 15 }) {
  if (!cost) return null
  const symbols = [...cost.matchAll(/\{([^}]+)\}/g)].map(m => m[1])
  if (!symbols.length) return null
  return <span className={styles.manaCost}>{symbols.map((s, i) => <ManaSymbol key={i} sym={s} size={size} />)}</span>
}

// Oracle text carries inline symbols and parenthesised reminder text; both read
// wrong as raw braces, and reminder text is quieter than the rule it explains.
function OracleText({ text }) {
  if (!text) return null
  return (
    <div className={styles.oracle}>
      {text.split('\n').map((line, lineIndex) => (
        <p key={lineIndex}>
          {line.split(/(\{[^}]+\}|\([^)]*\))/g).map((part, i) => {
            const symbol = part.match(/^\{([^}]+)\}$/)
            if (symbol) return <ManaSymbol key={i} sym={symbol[1]} size={14} />
            if (/^\([^)]*\)$/.test(part)) return <em key={i} className={styles.reminder}>{part}</em>
            return <span key={i}>{part}</span>
          })}
        </p>
      ))}
    </div>
  )
}

function faceImages(card) {
  if (card?.image_uris?.normal) return [{ label: card.name, url: card.image_uris.normal }]
  const faces = (card?.card_faces || []).filter(f => f.image_uris?.normal)
  return faces.map(f => ({ label: f.name, url: f.image_uris.normal }))
}

/**
 * Which faces to print text for.
 *
 * Two different kinds of card carry `card_faces`, and they need opposite
 * treatment. A transforming or modal double-faced card has an image per face,
 * so only the face on screen is shown and a flip button swaps it. A split,
 * Adventure or flip card has both halves on *one* image — showing a single face
 * there hides half the card, so both halves are printed together.
 */
function textFaces(card, faceIndex, hasFaceImages) {
  const faces = card?.card_faces || []
  if (!faces.length) return [card]
  if (hasFaceImages) return [faces[Math.min(faceIndex, faces.length - 1)]]
  return faces
}

function faceStats(face) {
  if (face.power != null && face.toughness != null) return `${face.power}/${face.toughness}`
  if (face.loyalty != null) return `Loyalty ${face.loyalty}`
  return null
}

function CardFaceText({ face, showName }) {
  const stats = faceStats(face)
  return (
    <div className={styles.faceBlock}>
      <div className={styles.detailNameRow}>
        {showName && <h3 className={styles.faceName}>{face.name}</h3>}
        <ManaCost cost={face.mana_cost} size={17} />
      </div>
      <p className={styles.detailType}>{face.type_line}</p>
      <OracleText text={face.oracle_text} />
      {stats && <p className={styles.detailStats}>{stats}</p>}
      {face.flavor_text && <p className={styles.flavorText}>{face.flavor_text}</p>}
    </div>
  )
}

// ── Add to wishlist ──────────────────────────────────────────────────────────

function WishlistAdder({ card }) {
  const { user } = useAuth()
  const toast = useToast()
  const [lists, setLists] = useState(null)
  const [target, setTarget] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!user) { setLists([]); return }
    let cancelled = false
    sb.from('folders').select('id,name').eq('user_id', user.id).eq('type', 'list').order('name')
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) { setLists([]); setError('Could not load your wishlists.'); return }
        setLists(data || [])
        setTarget(prev => prev || data?.[0]?.id || '')
      })
    return () => { cancelled = true }
  }, [user])

  if (!user) {
    return (
      <p className={styles.signedOutNote}>
        <Link to="/">Sign in</Link> to add spoiled cards to a wishlist.
      </p>
    )
  }

  if (lists && lists.length === 0) {
    return (
      <p className={styles.signedOutNote}>
        <Link to="/lists">Create a wishlist</Link> to track cards from this set.
      </p>
    )
  }

  const add = async () => {
    if (!target) return
    setSaving(true); setError('')
    try {
      // The card has no card_prints row until the set syncs, so this path
      // inserts one on the way through (requireCardPrintIds -> ensureCardPrints)
      // exactly as any other add of an unseen printing does.
      await addMissingToWishlist({ folderId: target, userId: user.id, sfCards: [card] })
      const list = lists.find(l => l.id === target)
      toast.showToast(`Added ${card.name} to ${list?.name || 'your wishlist'}`)
    } catch (err) {
      setError(err?.message || 'Could not add this card.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.wishlistRow}>
      <Select
        value={target}
        onChange={e => setTarget(e.target.value)}
        className={styles.wishlistSelect}
        title="Choose a wishlist"
        disabled={!lists}
        portal
      >
        {(lists || []).map(list => <option key={list.id} value={list.id}>{list.name}</option>)}
      </Select>
      <Button size="sm" onClick={add} disabled={!target || saving}>
        <WishlistsIcon size={13} />
        {saving ? 'Adding…' : 'Add to wishlist'}
      </Button>
      {error && <span className={styles.wishlistError}>{error}</span>}
    </div>
  )
}

// ── Card detail ──────────────────────────────────────────────────────────────

function SpoilerCardModal({ card, onClose }) {
  const [faceIndex, setFaceIndex] = useState(0)
  const images = faceImages(card)
  const hasFaceImages = images.length > 1
  const image = images[Math.min(faceIndex, images.length - 1)]
  const faces = textFaces(card, faceIndex, hasFaceImages)

  return (
    <Modal onClose={onClose} className={styles.detailModal} allowOverflow={false} autoHeight={false}>
      <div className={styles.detailBody}>
        <div className={styles.detailArt}>
          {image
            ? <img className={styles.detailImg} src={image.url} alt={card.name} />
            : <div className={styles.detailImgEmpty}>No image revealed yet</div>}
          {hasFaceImages && (
            <Button size="sm" variant="secondary" onClick={() => setFaceIndex(i => (i + 1) % images.length)}>
              Flip to {images[(faceIndex + 1) % images.length].label}
            </Button>
          )}
        </div>

        <div className={styles.detailInfo}>
          <h2 className={styles.detailName}>{card.name}</h2>
          {faces.map((face, i) => (
            <CardFaceText key={face.name || i} face={face} showName={faces.length > 1 || face.name !== card.name} />
          ))}

          <dl className={styles.detailMeta}>
            <div>
              <dt className={styles.metaLabel}>Rarity</dt>
              <dd className={styles.metaRarity} style={{ color: rarityColor(card.rarity) }}>{card.rarity}</dd>
            </div>
            <div><dt className={styles.metaLabel}>Number</dt><dd>{card.collector_number}</dd></div>
            {card.artist && <div><dt className={styles.metaLabel}>Artist</dt><dd>{card.artist}</dd></div>}
          </dl>

          {card.preview?.source && (
            <p className={styles.previewSource}>
              Previewed by{' '}
              {card.preview.source_uri
                ? <a href={card.preview.source_uri} target="_blank" rel="noopener noreferrer">{card.preview.source}</a>
                : card.preview.source}
              {card.preview.previewed_at ? ` on ${formatReleaseDate(card.preview.previewed_at)}` : ''}
            </p>
          )}

          <WishlistAdder card={card} />

          {card.scryfall_uri && (
            <a className={styles.scryfallLink} href={card.scryfall_uri} target="_blank" rel="noopener noreferrer">
              View on Scryfall <ExternalLinkIcon size={12} />
            </a>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ── Card grid ────────────────────────────────────────────────────────────────

function SpoilerCardTile({ card, onOpen, previewProps, priceSource }) {
  const image = faceImages(card)[0]
  const price = getPrice(card, false, { price_source: priceSource })
  return (
    <button
      type="button"
      className={styles.cardTile}
      onClick={() => onOpen(card)}
      // aria-label, not title: a native tooltip fires on the same hover that
      // opens the card preview, so both appear at once and the tooltip lands on
      // top of the image it is describing. Same fix as 6a8be86 in the build
      // assistant. The tile already renders the name, and the preview shows the
      // whole card, so nothing is lost visually.
      aria-label={card.name}
      {...previewProps}
    >
      <span className={styles.imgContainer}>
        {image
          ? <CardImg
              url={image.url}
              width={TILE_WIDTH}
              alt={card.name}
              className={styles.cardImg}
              loading="lazy"
              {...NON_DRAGGABLE_IMG_PROPS}
            />
          : <span className={styles.cardImgEmpty}>{card.name}</span>}
      </span>
      <span className={styles.cardCaption}>
        <span
          className={styles.rarityDot}
          style={{ background: rarityColor(card.rarity) }}
          aria-hidden="true"
        />
        <span className={styles.cardName}>{card.name}</span>
        {/* No price is the normal state on an unreleased set, so it reads as
            absent rather than as an error. */}
        {price != null && (
          <span className={styles.cardPrice}>{formatPrice(price, priceSource)}</span>
        )}
      </span>
    </button>
  )
}

// ── Filter rail ──────────────────────────────────────────────────────────────

function RailGroup({ title, children, action = null }) {
  return (
    <div className={styles.railGroup}>
      <h2 className={styles.railTitle}>{title}</h2>
      <ul className={styles.railList}>{children}</ul>
      {action}
    </div>
  )
}

function RailRow({ label, count, active, onClick, dotColor = null, badge = null, title }) {
  return (
    <li>
      <button
        type="button"
        title={title}
        aria-pressed={active}
        className={`${styles.railRow} ${active ? styles.railRowActive : ''}`}
        onClick={onClick}
      >
        {dotColor && <span className={styles.rarityDot} style={{ background: dotColor }} aria-hidden="true" />}
        <span className={styles.railRowName}>{label}</span>
        {badge}
        <span className={styles.railRowCount}>{count}</span>
      </button>
    </li>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SetSpoilerPage() {
  const { code } = useParams()
  const setCode = String(code || '').toLowerCase()
  const [searchParams, setSearchParams] = useSearchParams()

  const [set, setSet] = useState(undefined)   // undefined = loading, null = unknown set
  const [siblings, setSiblings] = useState([])
  const [cards, setCards] = useState(null)
  const [error, setError] = useState('')
  const [mechanicHistory, setMechanicHistory] = useState({})
  const [selected, setSelected] = useState(null)
  // The app's shared card preview. It positions via a transform written
  // straight to the DOM rather than setState per pointer frame — see the header
  // of useCardPreview.js for the regression that shape exists to prevent.
  const { preview, hoverCapable, previewHandlers, anchorProps, clearPreview } = useCardPreview()

  const { price_source } = useSettings()
  const [prices, setPrices] = useState(null)
  const [filters, setFilters] = useState(EMPTY_SPOILER_FILTERS)
  const [sort, setSort] = useState('spoiled')
  const [printingMode, setPrintingMode] = useState('unique')
  const [railOpen, setRailOpen] = useState(false)
  const [showAllMechanics, setShowAllMechanics] = useState(false)
  const today = todayIso()

  // The mechanic filter is in the URL so a "here are the Station cards" link is
  // shareable; every other filter is transient enough not to be worth it.
  const mechanicParam = searchParams.get('mechanic') || ''
  const setMechanic = useCallback((next) => {
    setSearchParams(prev => {
      const params = new URLSearchParams(prev)
      if (next) params.set('mechanic', next)
      else params.delete('mechanic')
      return params
    }, { replace: true })
  }, [setSearchParams])

  useEffect(() => {
    let cancelled = false
    setSet(undefined); setCards(null); setError(''); setMechanicHistory({})
    fetchAllSets()
      .then(all => {
        if (cancelled) return
        const found = all.find(s => (s.code || '').toLowerCase() === setCode) || null
        setSet(found)
        if (!found) return
        // Products that ship together: the parent set and everything hanging
        // off it, minus this one.
        const family = found.parent_set_code || found.code
        setSiblings(all.filter(s =>
          s.code !== found.code
          && (s.code === family || s.parent_set_code === family)
          && s.card_count > 0))
      })
      .catch(() => { if (!cancelled) { setSet(null); setError('Could not load this set.') } })
    return () => { cancelled = true }
  }, [setCode])

  useEffect(() => {
    if (!set) return
    let cancelled = false
    fetchSpoiledCards(set.code)
      .then(list => { if (!cancelled) setCards(list) })
      .catch(() => { if (!cancelled) { setCards([]); setError('Could not load the spoiled cards for this set.') } })
    return () => { cancelled = true }
  }, [set])

  // Loaded separately from the cards so a price failure costs prices only, and
  // the grid paints before they arrive.
  useEffect(() => {
    if (!set) return
    let cancelled = false
    setPrices(null)
    fetchSetPrices(set.code)
      .then(map => { if (!cancelled) setPrices(map) })
      .catch(() => { if (!cancelled) setPrices(new Map()) })
    return () => { cancelled = true }
  }, [set])

  useEffect(() => {
    document.title = set ? `${set.name} spoilers — DeckLoom` : 'Set spoilers — DeckLoom'
  }, [set])

  const pricedCards = useMemo(() => attachPrices(cards, prices), [cards, prices])
  // Everything below works from the current printing mode, so the rail's counts
  // always describe what clicking them would actually give you.
  const pool = useMemo(() => applyPrintingMode(pricedCards, printingMode), [pricedCards, printingMode])
  const mechanics = useMemo(() => extractMechanics(pool), [pool])

  // Novelty resolves after the cards are on screen; the rows render with their
  // counts immediately and grow a "New" flag as each answer lands.
  //
  // One at a time, not Promise.all. A big set carries 30+ keywords, and firing
  // them together pushed past Scryfall's rate limit — which used to surface as
  // evergreen keywords being labelled new. Nothing here is latency-sensitive:
  // the badges are enrichment on a page that already rendered.
  useEffect(() => {
    if (!set || !mechanics.length) return
    let cancelled = false
    const wanted = mechanics.slice(0, MAX_MECHANIC_LOOKUPS)
    ;(async () => {
      for (const { name } of wanted) {
        if (cancelled) return
        const history = await fetchMechanicHistory(name, { setCode: set.code, releasedAt: set.released_at })
        if (cancelled) return
        // null means the lookup could not be answered, not that the mechanic is
        // new — leave it unflagged. It also means we are being refused, so stop
        // asking: continuing the loop against a rate-limited endpoint fills the
        // console with failures and keeps the cooldown alive. The remaining
        // keywords stay unflagged and uncached, and the next visit retries.
        if (!history) return
        setMechanicHistory(prev => ({ ...prev, [name]: history }))
      }
    })().catch(() => { /* a missing novelty flag is not worth surfacing */ })
    return () => { cancelled = true }
  }, [set, mechanics])

  const summary = useMemo(() => summarizeSpoilers(pool), [pool])
  // Declared with the other hooks, above the unknown-set early return — a hook
  // after a conditional return runs on some renders and not others.
  const uniqueCardCount = useMemo(() => countUniqueCards(cards), [cards])
  const visible = useMemo(
    () => sortSpoilerCards(
      filterSpoilerCards(pool, { ...filters, mechanic: mechanicParam }),
      sort,
      price_source,
    ),
    [pool, filters, mechanicParam, sort, price_source],
  )

  // New mechanics float to the top of the rail: they are the reason to read the
  // list at all, and by raw count they sort below every evergreen keyword.
  const rankedMechanics = useMemo(() => {
    const rank = m => (isNewMechanic(mechanicHistory[m.name]) ? 0 : 1)
    return [...mechanics].sort((a, b) => rank(a) - rank(b))
  }, [mechanics, mechanicHistory])

  const newMechanics = rankedMechanics.filter(m => isNewMechanic(mechanicHistory[m.name]))
  const shownMechanics = showAllMechanics ? rankedMechanics : rankedMechanics.slice(0, MECHANICS_BEFORE_FOLD)

  const activeFilterCount = Object.values(filters).filter(Boolean).length + (mechanicParam ? 1 : 0)
  const filtersActive = activeFilterCount > 0
  const clearFilters = () => { setFilters(EMPTY_SPOILER_FILTERS); setMechanic('') }
  // The preview sits above the modal in the stacking order, so it has to go
  // before the card opens.
  const openCard = (card) => { clearPreview(); setSelected(card) }
  const toggleFilter = (key, value) => setFilters(f => ({ ...f, [key]: f[key] === value ? '' : value }))

  if (set === null) {
    return (
      <div className={styles.page}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link to="/" className={styles.back}><ChevronLeftIcon size={12} /> Home</Link>
        <Link to="/sets" className={styles.crumbLink}>Upcoming sets</Link>
      </nav>
        <EmptyState>No set with the code “{setCode}”. It may not have been announced yet.</EmptyState>
        <PublicPageFooter />
      </div>
    )
  }

  const days = set ? daysUntil(set.released_at, today) : null

  return (
    <div className={styles.page}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link to="/" className={styles.back}><ChevronLeftIcon size={12} /> Home</Link>
        <Link to="/sets" className={styles.crumbLink}>Upcoming sets</Link>
      </nav>

      <header className={styles.header}>
        {set?.icon_svg_uri && <img className={styles.setSymbol} src={set.icon_svg_uri} alt="" aria-hidden="true" />}
        <div className={styles.headerCopy}>
          <div className={styles.eyebrow}>{set ? setTypeLabel(set.set_type) : 'Set'}</div>
          <h1 className={styles.title}>{set?.name || '…'}</h1>
          {set && (
            <p className={styles.headerMeta}>
              <span>{formatReleaseDate(set.released_at)}</span>
              {days != null && <span>{countdownLabel(days)}</span>}
              {cards && (
                <span>{uniqueCardCount} {uniqueCardCount === 1 ? 'card revealed' : 'cards revealed'}</span>
              )}
              {cards && cards.length > uniqueCardCount && <span>{cards.length} printings</span>}
            </p>
          )}
        </div>
      </header>

      {siblings.length > 0 && (
        <nav className={styles.siblings} aria-label="Products that ship with this set">
          <span className={styles.siblingsLabel}>Ships with</span>
          {siblings.map(s => (
            <Link key={s.code} to={`/sets/${s.code}`} className={styles.siblingLink}>{s.name}</Link>
          ))}
        </nav>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

      <div className={styles.layout}>
        <aside className={styles.rail} aria-label="Filter the revealed cards">
          <button
            type="button"
            className={styles.railToggle}
            aria-expanded={railOpen}
            onClick={() => setRailOpen(open => !open)}
          >
            <FilterIcon size={13} />
            <span>Filters</span>
            {activeFilterCount > 0 && <span className={styles.railToggleCount}>{activeFilterCount}</span>}
          </button>

          <div className={`${styles.railBody} ${railOpen ? styles.railBodyOpen : ''}`}>
            {rankedMechanics.length > 0 && (
              <RailGroup
                title="Mechanics"
                action={rankedMechanics.length > MECHANICS_BEFORE_FOLD ? (
                  <button type="button" className={styles.railMore} onClick={() => setShowAllMechanics(v => !v)}>
                    {showAllMechanics ? 'Show fewer' : `Show all ${rankedMechanics.length}`}
                  </button>
                ) : null}
              >
                {shownMechanics.map(m => {
                  const history = mechanicHistory[m.name]
                  return (
                    <RailRow
                      key={m.name}
                      label={m.name}
                      count={m.count}
                      active={mechanicParam === m.name}
                      onClick={() => setMechanic(mechanicParam === m.name ? '' : m.name)}
                      badge={isNewMechanic(history) ? <span className={styles.newFlag}>New</span> : null}
                      title={history && !isNewMechanic(history)
                        ? `Also on ${history.priorCount} earlier card${history.priorCount === 1 ? '' : 's'}`
                        : undefined}
                    />
                  )
                })}
              </RailGroup>
            )}

            {summary.total > 0 && (
              <>
                <RailGroup title="Rarity">
                  {RARITIES.filter(r => summary.rarity[r]).map(r => (
                    <RailRow
                      key={r}
                      label={r}
                      count={summary.rarity[r]}
                      dotColor={rarityColor(r)}
                      active={filters.rarity === r}
                      onClick={() => toggleFilter('rarity', r)}
                    />
                  ))}
                </RailGroup>

                <RailGroup title="Colour">
                  {summary.colors.filter(c => c.count > 0).map(c => (
                    <RailRow
                      key={c.id}
                      label={c.label}
                      count={c.count}
                      active={filters.color === c.id}
                      onClick={() => toggleFilter('color', c.id)}
                    />
                  ))}
                </RailGroup>

                <RailGroup title="Card type">
                  {summary.types.map(t => (
                    <RailRow
                      key={t.type}
                      label={t.type}
                      count={t.count}
                      active={filters.type === t.type}
                      onClick={() => toggleFilter('type', t.type)}
                    />
                  ))}
                </RailGroup>
              </>
            )}

            {filtersActive && (
              <Button size="sm" variant="ghost" block onClick={clearFilters}>Clear filters</Button>
            )}
          </div>
        </aside>

        <div className={styles.content}>
          {newMechanics.length > 0 && (
            <section className={styles.newMechanics} aria-label="New in this set">
              {newMechanics.map(m => {
                const reminder = mechanicReminderText(cards, m.name)
                return (
                  <div key={m.name} className={styles.newMechanic}>
                    <span className={styles.newMechanicName}>{m.name}</span>
                    <span className={styles.newMechanicText}>{reminder || 'New to this set.'}</span>
                  </div>
                )
              })}
            </section>
          )}

          <div className={styles.toolbar}>
            <SearchInput
              value={filters.search}
              onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
              placeholder="Search name or rules text"
              className={styles.search}
              wrapClassName={styles.searchWrap}
              leadingIcon={<SearchIcon size={13} />}
            />
            <Select
              value={printingMode}
              onChange={e => setPrintingMode(e.target.value)}
              title="Printings"
              className={styles.sortSelect}
            >
              {PRINTING_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </Select>
            <Select value={sort} onChange={e => setSort(e.target.value)} title="Sort" className={styles.sortSelect}>
              {SPOILER_SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
            {filtersActive && cards && (
              <span className={styles.resultCount}>{visible.length} of {summary.total}</span>
            )}
          </div>

          {!cards ? (
            <div className={styles.grid}>
              {Array.from({ length: 12 }).map((_, i) => <div key={i} className={styles.tileSkeleton} />)}
            </div>
          ) : summary.total === 0 ? (
            <EmptyState>
              Nothing has been previewed from this set yet. Spoilers appear here as they are revealed.
            </EmptyState>
          ) : visible.length === 0 ? (
            <EmptyState>No revealed card matches these filters.</EmptyState>
          ) : (
            <div className={styles.grid}>
              {visible.map(card => (
                <SpoilerCardTile
                  key={card.id}
                  card={card}
                  onOpen={openCard}
                  priceSource={price_source}
                  // Only on pointer devices: on touch the hook's handlers are an
                  // onClick, which would fight the tile's own click. Tapping a
                  // tile opens the detail modal instead — a better answer than a
                  // lightbox, since it carries the rules text and the wishlist
                  // action as well as the art.
                  previewProps={hoverCapable
                    ? previewHandlers({ name: card.name, img: faceImages(card)[0]?.url })
                    : {}}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Two nodes, not one: the anchor carries the cursor-follow transform and
          the inner card carries the entry animation. An animation overrides an
          inline transform for its whole duration, so sharing a node flashes the
          card at the top-left corner before it snaps to the cursor. Portaled so
          no ancestor's overflow can clip it. */}
      {hoverCapable && preview?.img && createPortal(
        <div className={styles.hoverPreviewAnchor} {...anchorProps(1)}>
          <div className={styles.hoverPreview}>
            <CardImg
              url={preview.img}
              width={HOVER_PREVIEW_W}
              alt={preview.name}
              className={styles.hoverPreviewImg}
              {...NON_DRAGGABLE_IMG_PROPS}
            />
          </div>
        </div>,
        document.body,
      )}

      {selected && <SpoilerCardModal card={selected} onClose={() => setSelected(null)} />}

      <p className={styles.sourceNote}>
        Card data from <a href="https://scryfall.com" target="_blank" rel="noopener noreferrer">Scryfall</a>.
        Unreleased cards can change before release.
      </p>

      <PublicPageFooter />
    </div>
  )
}
