import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, Link } from 'react-router-dom'
import PublicPageFooter from '../components/PublicPageFooter'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { useSettings, DEFAULT_BENTO_CONFIG } from '../components/SettingsContext'
import { Button, Modal, EmptyState } from '../components/UI'
import { useToast } from '../components/ToastContext'
import CardArtPicker from '../components/CardArtPicker'
import {
  CheckIcon, CloseIcon, ImageIcon, ShareIcon, TradingIcon,
  EditIcon, StarIcon, ChevronRightIcon,
} from '../icons'
import { Select } from '../components/UI'
import { MILESTONES, groupedMilestones } from '../lib/milestones'
import { checkAndNotifyMilestones } from '../lib/milestoneTracker'
import FollowButton from '../components/community/FollowButton'
import { getUserFollowStats, setFollow, recordMilestoneNotifications } from '../lib/community'
import {
  fetchPublicProfile, fetchPublicDecks, fetchFollowList,
  refreshMyProfileStats, profileKeys, PROFILE_STALE_MS,
} from '../lib/profileApi'
import { getPublicAppUrl } from '../lib/publicUrl'
import {
  NICKNAME_MAX_LENGTH, validateNickname, isSameNickname, isNicknameAvailable,
  checkNicknameForSave, isNicknameTakenError,
} from '../lib/nickname'
import { useDeckArt } from '../lib/deckArt'
import { deckBracketBadge } from '../lib/commanderBracket'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import CardImg from '../components/CardImg'
import styles from './Profile.module.css'

// ── Constants ─────────────────────────────────────────────────────────────────

// Painted widths of the card images on this page, so CardImg can pick the tier
// each needs. `owned_cards_view.image_uri` is always the 488px `normal`, so the
// small thumbs were pulling a ~78KB image apiece; those ask for `small` by name
// (nothing is legible at that size, and it is ~7x lighter). Keep in sync with
// `.standoutCard` and `.valueHeroArt` in the stylesheet.
const STANDOUT_TILE_W = 150
const BINDER_CARD_W = 220

const ACCENT_PALETTE = [
  '#c9a84c', '#e8c96a', '#e07840', '#e05c5c', '#c44569',
  '#9b59b6', '#6c5ce7', '#4a90d9', '#00b4d8', '#2ecc71',
  '#27ae60', '#a8e6cf', '#f9ca24', '#e84393', '#fd79a8',
  '#b2bec3', '#636e72', '#dfe6e9', '#2d3436', '#00cec9',
]

const FORMAT_LABEL = {
  standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern', legacy: 'Legacy',
  vintage: 'Vintage', commander: 'Commander', pauper: 'Pauper', historic: 'Historic',
  explorer: 'Explorer', alchemy: 'Alchemy', brawl: 'Brawl', oathbreaker: 'Oathbreaker',
}

const MANA_SYMBOL_URL = c => `https://svgs.scryfall.io/card-symbols/${c}.svg`

// ── Block metadata ────────────────────────────────────────────────────────────
// `kind` decides where a block lives. Stats are a single engraved line under the
// name — they are context for the showcase, not the subject of the page. Panels
// are the showcase itself: a deck, a binder page, a shelf.
//
// The analytics blocks (colour pie, rarity breakdown, formats played, crown
// jewel, favourite commander) were removed 2026-08. A public profile answers
// "who is this collector and what should I look at" — distribution charts answer
// "how is my collection composed", which is a question you ask about your own
// collection, on /stats. Dropping an id here also drops it from saved configs,
// since mergeBlocks filters against these keys.
const BLOCK_DEFS = {
  total:         { label: 'Total Cards',    kind: 'stat' },
  unique:        { label: 'Unique Prints',  kind: 'stat' },
  foils:         { label: 'Foils',          kind: 'stat' },
  sets:          { label: 'Sets',           kind: 'stat' },
  since:         { label: 'Collecting Since', kind: 'stat' },
  value:         { label: 'Est. Value',     kind: 'stat' },
  deck_count:    { label: 'Public Decks',   kind: 'stat' },
  winrate:       { label: 'Win Rate',       kind: 'stat' },
  fav_format:    { label: 'Most Played',    kind: 'stat' },

  featured_deck: { label: 'The Deck',          kind: 'panel', span: 'full' },
  top_cards:     { label: 'The Binder',        kind: 'panel', span: 'full' },
  decks:         { label: 'Deck Shelf',        kind: 'panel', span: 'full' },
  bio:           { label: 'Text Block',        kind: 'panel', span: 'full' },
  milestones:    { label: 'Milestones',        kind: 'panel', span: 'full' },
  recent_cards:  { label: 'Recently Added',    kind: 'panel', span: 'full' },
}

const LEDGER_DROP_ID = 'drop-ledger'
const PANEL_DROP_ID  = 'drop-panels'
const TRAY_DROP_ID   = 'drop-tray'
const noDisplace     = () => null

const isStat = id => BLOCK_DEFS[id]?.kind === 'stat'

function mergeBlocks(configBlocks) {
  const allIds      = Object.keys(BLOCK_DEFS)
  const existing    = configBlocks || []
  const existingIds = existing.map(b => b.id)
  return [
    ...existing.filter(b => allIds.includes(b.id)),
    ...allIds.filter(id => !existingIds.includes(id)).map(id => ({ id, enabled: false })),
  ]
}

function fmtNum(val) {
  return typeof val === 'number' ? val.toLocaleString() : '—'
}

function spanClass(id) {
  return BLOCK_DEFS[id]?.span === 'half' ? styles.panelHalf : styles.panelFull
}

// ── Standout card picker (featured deck) ─────────────────────────────────────
function StandoutCardPicker({ deck, selected, onAdd, onRemove, onClose }) {
  const [cards, setCards]     = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!deck) return
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const table = deck.type === 'builder_deck' ? 'deck_cards_view' : 'deck_allocations_view'
        const { data } = await sb.from(table).select('scryfall_id,name').eq('deck_id', deck.id)
        const rows = data || []

        const seen   = new Set()
        const unique = rows.filter(r => {
          if (!r.scryfall_id || seen.has(r.scryfall_id)) return false
          seen.add(r.scryfall_id)
          return true
        })

        if (!unique.length) { if (!cancelled) setCards([]); return }

        const ids = unique.map(r => r.scryfall_id)
        const { data: priceRows } = await sb.from('card_prices')
          .select('scryfall_id,price_regular_eur,price_regular_usd')
          .in('scryfall_id', ids)
          .order('snapshot_date', { ascending: false })

        const priceMap = {}
        for (const p of (priceRows || [])) {
          if (!priceMap[p.scryfall_id]) priceMap[p.scryfall_id] = p.price_regular_eur ?? p.price_regular_usd ?? 0
        }

        const result = unique.map(r => ({
          scryfall_id: r.scryfall_id,
          name:        r.name,
          art_crop:    `https://cards.scryfall.io/art_crop/front/${r.scryfall_id[0]}/${r.scryfall_id[1]}/${r.scryfall_id}.jpg`,
          price:       priceMap[r.scryfall_id] ?? 0,
        })).sort((a, b) => b.price - a.price)

        if (!cancelled) setCards(result)
      } catch { if (!cancelled) setCards([]) }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [deck?.id, deck?.type])

  const isSelected = card => selected.some(s => s.scryfall_id
    ? s.scryfall_id === card.scryfall_id
    : s.name === card.name)
  const full = selected.length >= 5

  // Portaled to <body> because UI.jsx's Modal renders in place, and this one is
  // mounted inside the featured-deck section — which sets `isolation: isolate`
  // for its background art, and in edit mode also carries a dnd-kit transform.
  // Either is enough to make a stacking context the overlay's z-index cannot
  // escape, so later sections (the deck shelf) painted straight over the dialog.
  return createPortal(
    <Modal onClose={onClose}>
      <h2 className={styles.dialogTitle}>Standout cards ({selected.length}/5)</h2>
      <p className={styles.dialogSub}>Pick up to five cards to show alongside the deck.</p>

      {selected.length > 0 && (
        <div className={styles.pickerSelected}>
          {selected.map((c, i) => (
            <div key={i} className={styles.pickerSelectedItem}>
              <img src={c.art_crop} alt="" className={styles.pickerSelectedImg} />
              <span className={styles.pickerSelectedName}>{c.name}</span>
              <button className={styles.pickerSelectedRemove} onClick={() => onRemove(i)}
                aria-label={`Remove ${c.name}`}><CloseIcon size={12} /></button>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className={styles.dialogNote}>Loading deck cards…</div>
      ) : cards.length === 0 ? (
        <div className={styles.dialogNote}>This deck has no cards yet.</div>
      ) : (
        <div className={styles.pickerGrid}>
          {cards.map(card => {
            const sel      = isSelected(card)
            const disabled = full && !sel
            return (
              <button key={card.scryfall_id}
                className={`${styles.pickerItem}${sel ? ' ' + styles.pickerItemSel : ''}`}
                disabled={disabled}
                onClick={() => { if (!disabled && !sel) onAdd({ scryfall_id: card.scryfall_id, name: card.name, art_crop: card.art_crop }) }}
                title={card.name}>
                <img src={card.art_crop} alt="" className={styles.pickerImg} />
                {card.price > 0 && <span className={styles.pickerPrice}>€{card.price.toFixed(2)}</span>}
                {sel && <span className={styles.pickerCheck}><CheckIcon size={16} /></span>}
                <span className={styles.pickerName}>{card.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </Modal>,
    document.body
  )
}

// ── Ledger cells ──────────────────────────────────────────────────────────────
function StatCell({ label, value, tone }) {
  return (
    <div className={styles.statCell}>
      <div className={`${styles.statValue}${tone ? ' ' + styles[tone] : ''}`}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  )
}

// ── Sections ──────────────────────────────────────────────────────────────────
// No boxes. A section is a small-caps marker, a rule carrying the collector's
// accent, and open content — the bordered panels were what made this page read
// as a dashboard, because a two-digit number sat in the same frame as the deck
// showcase. Weight now comes from the size of the artwork inside.
function Section({ marker, note, action, children, className = '' }) {
  return (
    <section className={`${styles.section} ${className}`}>
      {(marker || action) && (
        <header className={styles.sectionHead}>
          {marker && <h2 className={styles.sectionMarker}>{marker}</h2>}
          <span className={styles.sectionRule} aria-hidden="true" />
          {note && <span className={styles.sectionNote}>{note}</span>}
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

function SectionEmpty({ children }) {
  return <p className={styles.sectionEmpty}>{children}</p>
}

function TextBlock({ text, editMode, onChangeText }) {
  if (editMode) return (
    <Section marker="Text block">
      <textarea className={styles.textarea} value={text}
        onChange={e => onChangeText(e.target.value)}
        placeholder="Favourite format, what you collect, what you're hunting for…"
        maxLength={500} rows={4} />
      <div className={styles.charCount}>{text.length}/500</div>
    </Section>
  )
  if (!text) return null
  return <Section><p className={styles.bodyText}>{text}</p></Section>
}

function WinRateBlock({ gameStats }) {
  if (!gameStats || !gameStats.total) return <StatCell label="Win rate" value="—" />
  const pct = Math.round(gameStats.wins / gameStats.total * 100)
  return <StatCell label={`${gameStats.wins}W ${gameStats.losses}L`} value={`${pct}%`}
    tone={pct >= 50 ? 'toneGood' : 'toneBad'} />
}

function FavFormatBlock({ gameStats, decks }) {
  const format = useMemo(() => {
    if (gameStats?.fav_format) return gameStats.fav_format
    if (!decks?.length) return null
    const counts = {}
    decks.forEach(d => { if (d.format) counts[d.format] = (counts[d.format] || 0) + 1 })
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null
  }, [gameStats, decks])
  return <StatCell label="Most played" value={format ? (FORMAT_LABEL[format] || format) : '—'} />
}

// ── Milestones ────────────────────────────────────────────────────────────────
function MilestoneTooltip({ m, earned, earnedAt, rect }) {
  return createPortal(
    <div className={styles.tooltip} style={{ left: rect.left + rect.width / 2, top: rect.top }} role="tooltip">
      <div className={styles.tooltipHead}>
        <span className={styles.tooltipIcon}>{m.icon}</span>
        <span className={styles.tooltipTitle}>{m.label}</span>
      </div>
      <div className={styles.tooltipDesc}>{m.desc}</div>
      {!earned && <div className={styles.tooltipReq}>Requires {m.req}</div>}
      {earned && earnedAt && (
        <div className={styles.tooltipDate}>
          Earned {new Date(earnedAt).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}
        </div>
      )}
    </div>,
    document.body
  )
}

function AllMilestonesDialog({ stats, profile, earnedAt, onClose }) {
  const groups = useMemo(() => groupedMilestones(stats, profile), [stats, profile])
  const earnedCount = groups.reduce((a, g) => a + g.items.filter(i => i.earned).length, 0)
  const totalCount  = groups.reduce((a, g) => a + g.items.length, 0)

  // Portaled for the same reason as StandoutCardPicker: in edit mode this sits
  // inside a dnd-kit-transformed panel, which traps a non-portaled overlay.
  return createPortal(
    <Modal onClose={onClose}>
      <h2 className={styles.dialogTitle}>Milestones</h2>
      <p className={styles.dialogSub}>{earnedCount} of {totalCount} earned.</p>
      <div className={styles.dialogScroll}>
        {groups.map(group => (
          <section key={group.id} className={styles.milestoneGroup}>
            <h3 className={styles.milestoneGroupTitle}>{group.label}</h3>
            <ul className={styles.milestoneList}>
              {group.items.map(m => (
                <li key={m.id} className={`${styles.milestoneRow}${m.earned ? ' ' + styles.milestoneRowEarned : ''}`}>
                  <span className={styles.milestoneRowIcon}>{m.icon}</span>
                  <span className={styles.milestoneRowText}>
                    <span className={styles.milestoneRowName}>{m.label}</span>
                    <span className={styles.milestoneRowDesc}>{m.earned ? m.desc : `Requires ${m.req}`}</span>
                  </span>
                  {m.earned && (
                    <span className={styles.milestoneRowCheck}>
                      <CheckIcon size={12} />
                      {earnedAt?.[m.id] && (
                        <span className={styles.milestoneRowDate}>
                          {new Date(earnedAt[m.id]).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}
                        </span>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>,
    document.body
  )
}

function MilestonesBlock({ stats, profile }) {
  const [tooltip, setTooltip] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const earnedAt = profile?.bento_config?.milestone_earned_at || {}

  const earned = useMemo(
    () => MILESTONES.filter(m => m.check(stats, profile)),
    [stats, profile]
  )

  return (
    <Section
      marker="Milestones"
      action={
        <button className={styles.sectionAction} onClick={() => setShowAll(true)}>
          {earned.length} of {MILESTONES.length}
          <ChevronRightIcon size={12} />
        </button>
      }
    >
      {earned.length === 0 ? (
        <SectionEmpty>No milestones earned yet — adding cards is the fastest way to start.</SectionEmpty>
      ) : (
        <ul className={styles.badgeGrid}>
          {earned.map(m => (
            <li key={m.id}
              className={styles.badge}
              tabIndex={0}
              onFocus={e => setTooltip({ m, earned: true, earnedAt: earnedAt[m.id], rect: e.currentTarget.getBoundingClientRect() })}
              onBlur={() => setTooltip(null)}
              onMouseEnter={e => setTooltip({ m, earned: true, earnedAt: earnedAt[m.id], rect: e.currentTarget.getBoundingClientRect() })}
              onMouseLeave={() => setTooltip(null)}
            >
              <span className={styles.badgeIcon}>{m.icon}</span>
              <span className={styles.badgeName}>{m.label}</span>
            </li>
          ))}
        </ul>
      )}
      {tooltip && <MilestoneTooltip {...tooltip} />}
      {showAll && (
        <AllMilestonesDialog stats={stats} profile={profile} earnedAt={earnedAt}
          onClose={() => setShowAll(false)} />
      )}
    </Section>
  )
}

// ── Featured deck — the signature surface ─────────────────────────────────────
function FeaturedDeckInner({ deck, standoutCards, deckStats, editMode, decks, onChangeDeck, onChangeCards }) {
  const art          = useDeckArt(deck)
  const colors       = Array.isArray(deck.color_identity) ? deck.color_identity : []
  const tags         = Array.isArray(deck.tags) ? deck.tags.filter(Boolean) : []
  const description  = (deck.deck_description || '').trim()
  const bracketBadge = deckBracketBadge(deck.format, deck.bracket)
  const [showPicker, setShowPicker] = useState(false)

  const commanderDisplayName = useMemo(() => {
    const commanders = Array.isArray(deck.commanders) ? deck.commanders : null
    if (commanders?.length > 0) return commanders.map(c => c.name).join(' + ')
    return deck.commander_name || null
  }, [deck.commanders, deck.commander_name])

  const cards = standoutCards || []

  return (
    <section className={styles.featured}>
      {art && <div className={styles.featuredArt} style={{ backgroundImage: `url(${art})` }} />}
      <div className={styles.featuredScrim} />

      <div className={styles.featuredBody}>
        <div className={styles.featuredText}>
          {colors.length > 0 && (
            <div className={styles.pipRow}>
              {colors.map(c => <img key={c} className={styles.pip} src={MANA_SYMBOL_URL(c)} alt="" />)}
            </div>
          )}
          <Link to={`/d/${deck.id}`} className={styles.featuredName}>{deck.name}</Link>
          {commanderDisplayName && <p className={styles.featuredCommander}>{commanderDisplayName}</p>}

          <div className={styles.featuredMeta}>
            {deck.format && FORMAT_LABEL[deck.format] && <span>{FORMAT_LABEL[deck.format]}</span>}
            {bracketBadge && <span title={bracketBadge.desc}>Bracket {deck.bracket} · {bracketBadge.label}</span>}
            <span>{deck.card_count} cards</span>
            {deckStats?.total > 0 && <span>{deckStats.wins}W – {deckStats.losses}L</span>}
          </div>

          {description && <p className={styles.featuredDesc}>{description}</p>}

          {tags.length > 0 && (
            <ul className={styles.chipRow}>
              {tags.map((t, i) => <li key={i} className={styles.chipGold}>{t}</li>)}
            </ul>
          )}

          {editMode && decks?.length > 1 && (
            <Select className={styles.featuredPicker} title="Featured deck"
              value={deck.id} onChange={e => onChangeDeck(e.target.value)} portal searchable>
              {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          )}
        </div>

        {/* The spread — cards laid out the way you'd actually fan them across a
            table to show someone. Each sits at its own angle; hovering lifts one
            out of the fan. */}
        {(cards.length > 0 || editMode) && (
          <div className={styles.fan} style={{ '--fan-count': cards.length }}>
            {editMode && cards.length === 0 && (
              <p className={styles.fanEmpty}>
                Pick up to five cards from this deck to show here.
              </p>
            )}
            {cards.map((c, i) => {
              const fullImg = c.scryfall_id
                ? `https://cards.scryfall.io/normal/front/${c.scryfall_id[0]}/${c.scryfall_id[1]}/${c.scryfall_id}.jpg`
                : c.art_crop
              return (
                <div key={i} className={styles.fanCard} title={c.name} style={{ '--i': i }}>
                  <CardImg url={fullImg} width={STANDOUT_TILE_W} alt={c.name}
                    className={styles.fanImg} loading="lazy" />
                  {editMode && (
                    <button className={styles.fanRemove}
                      aria-label={`Remove ${c.name}`}
                      onClick={() => onChangeCards(cards.filter((_, j) => j !== i))}>
                      <CloseIcon size={12} />
                    </button>
                  )}
                </div>
              )
            })}
            {editMode && cards.length < 5 && (
              <button className={styles.fanAdd} onClick={() => setShowPicker(true)}>
                {cards.length === 0 ? 'Choose cards' : 'Add another'}
              </button>
            )}
          </div>
        )}
      </div>

      {showPicker && (
        <StandoutCardPicker
          deck={deck}
          selected={cards}
          onAdd={card => onChangeCards([...cards, card])}
          onRemove={i => onChangeCards(cards.filter((_, j) => j !== i))}
          onClose={() => setShowPicker(false)}
        />
      )}
    </section>
  )
}

function FeaturedDeckBlock({ decks, featuredDeckId, standoutCards, deckStats, editMode, onChangeFeaturedDeck, onChangeStandoutCards }) {
  const deck = useMemo(
    () => decks?.find(d => d.id === featuredDeckId) || decks?.[0] || null,
    [decks, featuredDeckId]
  )
  if (!deck) return <Section marker="The deck"><SectionEmpty>No public decks to feature yet.</SectionEmpty></Section>
  return (
    <FeaturedDeckInner
      deck={deck}
      standoutCards={standoutCards}
      deckStats={deckStats}
      editMode={editMode}
      decks={decks}
      onChangeDeck={onChangeFeaturedDeck}
      onChangeCards={onChangeStandoutCards}
    />
  )
}

// ── Cards / decks ─────────────────────────────────────────────────────────────
function RecentCardsBlock({ cards }) {
  if (!cards?.length) return <Section marker="Recently added"><SectionEmpty>Nothing added yet.</SectionEmpty></Section>
  return (
    <Section marker="Recently added">
      <div className={styles.cardStrip}>
        {cards.map((card, i) => (
          <div key={i} className={styles.stripCard} title={card.name}>
            {card.image_uri
              ? <CardImg url={card.image_uri} forceTier="small" alt={card.name} className={styles.stripImg} loading="lazy" />
              : <span className={styles.stripPlaceholder}>{card.name?.[0] || '?'}</span>}
          </div>
        ))}
      </div>
    </Section>
  )
}

function ProfileDeckTile({ deck, pinned, editMode, onTogglePin }) {
  const art    = useDeckArt(deck)
  const colors = Array.isArray(deck.color_identity) ? deck.color_identity : []
  const fmtLabel     = FORMAT_LABEL[deck.format] || null
  const isCollection = deck.type === 'deck'
  const bracketBadge = deckBracketBadge(deck.format, deck.bracket)

  const commanderDisplay = useMemo(() => {
    const commanders = Array.isArray(deck.commanders) ? deck.commanders : null
    if (commanders?.length > 0) return commanders.map(c => c.name).join(' + ')
    return deck.commander_name || null
  }, [deck.commanders, deck.commander_name])

  return (
    <div className={styles.deckTileWrap}>
      <Link to={`/d/${deck.id}`} className={styles.deckTile}>
        {/* An <img> rather than a background so the browser can defer it. A
            collector with 30+ public decks was fetching every cover eagerly —
            background-image has no lazy loading — which is most of the request
            count on this page, for a shelf that starts below the fold.
            Deliberately not CardImg: it re-tiers by painted width, and
            scryfallImageAtSize would rewrite this art_crop URL to `normal`,
            swapping the artwork for the whole card face. */}
        {art && (
          <img className={styles.deckTileArt} src={art} alt=""
            loading="lazy" decoding="async" />
        )}
        {/* Everything legible lives in one block at the foot, over the scrim.
            The tags used to float at the top on undimmed artwork, where a
            translucent --s2 pill all but disappears. Keeping the upper two
            thirds pure art is also the better read for a shelf of deck covers. */}
        <div className={styles.deckTileBody}>
          <div className={styles.deckTileFoot}>
            <div className={styles.deckTileTags}>
              {isCollection && <span className={styles.tagCollection}>Collection</span>}
              {fmtLabel && <span className={styles.tag}>{fmtLabel}</span>}
              {bracketBadge && (
                <span className={styles.tag} style={{ color: bracketBadge.color }} title={bracketBadge.desc}>
                  B{deck.bracket}
                </span>
              )}
            </div>
            <div className={styles.deckTileName}>{deck.name}</div>
            {commanderDisplay && <div className={styles.deckTileCommander}>{commanderDisplay}</div>}
            <div className={styles.deckTileStats}>
              {colors.length > 0 && (
                <span className={styles.pipRow}>
                  {colors.map(c => <img key={c} className={styles.pipSm} src={MANA_SYMBOL_URL(c)} alt="" />)}
                </span>
              )}
              <span>{deck.card_count} cards</span>
            </div>
          </div>
        </div>
      </Link>
      {editMode && (
        <button
          className={`${styles.pinBtn}${pinned ? ' ' + styles.pinBtnOn : ''}`}
          onClick={() => onTogglePin(deck.id)}
          title={pinned ? 'Unpin from the top' : 'Pin to the top'}
          aria-pressed={pinned}
        >
          <StarIcon size={12} />
        </button>
      )}
      {!editMode && pinned && (
        <span className={styles.pinnedMark} title="Pinned"><StarIcon size={11} /></span>
      )}
    </div>
  )
}

function DecksBlock({ decks, pinnedIds, editMode, onTogglePin }) {
  const ordered = useMemo(() => {
    if (!decks?.length) return []
    const pinRank = new Map((pinnedIds || []).map((id, i) => [id, i]))
    return [...decks].sort((a, b) => {
      const ra = pinRank.has(a.id) ? pinRank.get(a.id) : Infinity
      const rb = pinRank.has(b.id) ? pinRank.get(b.id) : Infinity
      return ra - rb
    })
  }, [decks, pinnedIds])

  if (!ordered.length) return <Section marker="Deck shelf"><SectionEmpty>No public decks yet.</SectionEmpty></Section>
  return (
    <Section marker="Deck shelf" note={`${ordered.length}`}
      action={editMode ? <span className={styles.sectionHint}>Star a deck to pin it first</span> : null}>
      <div className={styles.deckGrid}>
        {ordered.map(deck => (
          <ProfileDeckTile key={deck.id} deck={deck}
            pinned={(pinnedIds || []).includes(deck.id)}
            editMode={editMode} onTogglePin={onTogglePin} />
        ))}
      </div>
    </Section>
  )
}

// The binder page — the signature surface. Cards sit in sleeve pockets at a size
// where the artwork is actually legible, which is the whole reason anyone
// collects these. It replaced a hero-plus-ranked-list layout that showed one
// card large and the rest as 40px thumbnails in what amounted to a leaderboard.
function BinderBlock({ cards }) {
  if (!cards?.length) {
    return <Section marker="The binder"><SectionEmpty>No priced cards yet.</SectionEmpty></Section>
  }
  const total = cards.reduce((sum, c) => sum + Number(c.price ?? 0), 0)
  return (
    <Section marker="The binder" note={`Top ${cards.length} · €${total.toFixed(0)}`}>
      <ol className={styles.binder}>
        {cards.map((c, i) => (
          <li key={i} className={styles.pocket}>
            <div className={styles.pocketSleeve}>
              {c.image_uri
                ? <CardImg url={c.image_uri} width={BINDER_CARD_W} alt={c.name}
                    className={styles.pocketImg} loading="lazy" />
                : <span className={styles.pocketBlank}>{c.name?.[0] || '?'}</span>}
              {c.foil && <span className={styles.pocketFoil} aria-hidden="true" />}
            </div>
            <div className={styles.pocketMeta}>
              <span className={styles.pocketName} title={c.name}>{c.name}</span>
              <span className={styles.pocketPrice}>€{Number(c.price ?? 0).toFixed(2)}</span>
            </div>
            <span className={styles.pocketSet}>
              {(c.set_code || '').toUpperCase()}{c.foil ? ' · Foil' : ''}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  )
}

// ── Follow list dialog ────────────────────────────────────────────────────────
function FollowListDialog({ username, kind, onClose }) {
  const { data, isLoading } = useQuery({
    queryKey: profileKeys.follows(username, kind),
    queryFn: () => fetchFollowList(username, kind),
    staleTime: PROFILE_STALE_MS,
  })

  return (
    <Modal onClose={onClose}>
      <h2 className={styles.dialogTitle}>{kind === 'followers' ? 'Followers' : 'Following'}</h2>
      {isLoading ? (
        <div className={styles.dialogNote}>Loading…</div>
      ) : !data?.length ? (
        <div className={styles.dialogNote}>
          {kind === 'followers' ? 'Nobody follows this collector yet.' : 'Not following anyone yet.'}
        </div>
      ) : (
        <ul className={styles.followList}>
          {data.map(u => (
            <li key={u.nickname}>
              <Link to={`/profile/${encodeURIComponent(u.nickname)}`} className={styles.followRow} onClick={onClose}>
                <span className={styles.followAvatar} style={{ borderColor: u.accent || 'var(--gold)', color: u.accent || 'var(--gold)' }}>
                  {(u.nickname[0] || '?').toUpperCase()}
                </span>
                <span className={styles.followName}>{u.nickname}</span>
                {u.premium && <span className={styles.chipGold}>Supporter</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

// ── dnd-kit sortable items ────────────────────────────────────────────────────
function SortableBlock({ id, onHide, children, cell = false }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  return (
    <div ref={setNodeRef} style={style}
      className={[
        cell ? styles.editCell : `${styles.editPanel} ${spanClass(id)}`,
        isDragging ? styles.dragging : '',
      ].filter(Boolean).join(' ')}
      {...attributes}>
      <div className={styles.editBar}>
        <span className={styles.editGrip} {...listeners}>
          <span aria-hidden="true">⠿</span>
          <span className={styles.editLabel}>{BLOCK_DEFS[id]?.label}</span>
        </span>
        <button className={styles.editHide}
          onClick={e => { e.stopPropagation(); onHide(id) }}
          title="Hide this block" aria-label={`Hide ${BLOCK_DEFS[id]?.label}`}>
          <CloseIcon size={12} />
        </button>
      </div>
      {children}
    </div>
  )
}

function SortableTrayItem({ id, onShow }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const def   = BLOCK_DEFS[id]
  return (
    <div ref={setNodeRef} style={style}
      className={`${styles.trayItem}${isDragging ? ' ' + styles.dragging : ''}`}
      {...attributes} {...listeners}>
      <span aria-hidden="true" className={styles.editGripDot}>⠿</span>
      <span className={styles.trayText}>
        <span className={styles.trayName}>{def?.label}</span>
        <span className={styles.trayKind}>{def?.kind === 'stat' ? 'Ledger' : 'Panel'}</span>
      </span>
      <button className={styles.trayShow}
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onShow(id) }}
        title="Show this block" aria-label={`Show ${def?.label}`}>+</button>
    </div>
  )
}

// Named Zone, not DropZone — UI.jsx exports a DropZone primitive (file upload)
// and two components with the same name in one codebase is a trap.
function Zone({ id, className, children }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div ref={setNodeRef} className={`${className}${isOver ? ' ' + styles.dropActive : ''}`}>
      {children}
    </div>
  )
}

// Shown while the profile loads.
//
// Built out of the page's own containers — .banner, .bannerInner, .identity,
// .ledger, .panels — with shimmer bars where the text goes, rather than out of
// two blocks sized by hand. The banner's height is not a number here; it comes
// from the same `calc(var(--nav-h) + 96px)` padding and the same 68px avatar
// that the loaded banner uses, so it cannot drift away from them. The previous
// version guessed 220px against a real banner of 280px+, and left the whole
// bento showcase below it with no placeholder at all.
export function ProfileSkeleton() {
  return (
    <div className={styles.page} aria-busy="true">
      <span className="sr-only" role="status">Loading profile</span>
      <header className={styles.banner} aria-hidden="true">
        <div className={styles.bannerFallback} />
        <div className={styles.bannerScrim} />

        <div className={`${styles.shell} ${styles.bannerInner}`}>
          <div className={styles.identity}>
            <div className={`${styles.avatar} ${styles.skelAvatar}`} />
            <div className={styles.identityText}>
              <span className={`${styles.skelBar} ${styles.skelName}`} />
              <span className={`${styles.skelBar} ${styles.skelBio}`} />
            </div>
          </div>

          <dl className={styles.ledger}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={styles.ledgerEntry}>
                {/* Term before definition, as a <dl> requires; .skelLedgerValue
                    lifts the value above its label the way .ledgerValue does. */}
                <dt className={`${styles.skelBar} ${styles.skelLedgerLabel}`} />
                <dd className={`${styles.skelBar} ${styles.skelLedgerValue}`} />
              </div>
            ))}
          </dl>
        </div>
      </header>

      <div className={styles.shell} aria-hidden="true">
        <div className={styles.panels}>
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className={styles.section}>
              <div className={styles.sectionHead}>
                <span className={`${styles.skelBar} ${styles.skelSectionMarker}`} />
                <span className={styles.sectionRule} />
              </div>
              <span className={`${styles.skelBar} ${styles.skelPanelBody}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const { username } = useParams()
  const navigate     = useNavigate()
  const { user }     = useAuth()
  const settings     = useSettings()
  const { showToast } = useToast()
  const queryClient  = useQueryClient()

  const decodedUsername = decodeURIComponent(username)

  const [editMode, setEditMode]                       = useState(false)
  const [draftNickname, setDraftNickname]             = useState('')
  const [nicknameError, setNicknameError]             = useState('')
  const [nicknameStatus, setNicknameStatus]           = useState('')
  const [draftBio, setDraftBio]                       = useState('')
  const [draftAccent, setDraftAccent]                 = useState('')
  const [draftBlocks, setDraftBlocks]                 = useState([])
  const [draftHeaderArt, setDraftHeaderArt]           = useState('')
  const [draftTextContent, setDraftTextContent]       = useState('')
  const [draftFeaturedDeckId, setDraftFeaturedDeckId] = useState('')
  const [draftStandoutCards, setDraftStandoutCards]   = useState([])
  const [draftPinnedDecks, setDraftPinnedDecks]       = useState([])
  const [showArtPicker, setShowArtPicker]             = useState(false)
  const [saving, setSaving]                           = useState(false)
  const [followDialog, setFollowDialog]               = useState(null)
  const [followBusy, setFollowBusy]                   = useState(false)
  const [activeId, setActiveId]                       = useState(null)
  const nicknameTimer = useRef(null)
  const pendingNicknameRef = useRef('')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor,   { activationConstraint: { delay: 200, tolerance: 5 } })
  )

  // Optimistic ownership from the local nickname — cheap, drives instant own-
  // profile rendering. A wrong value here can only mis-decorate, never leak.
  const isOwn = !!(user && settings.nickname &&
    decodedUsername.toLowerCase() === settings.nickname.toLowerCase())

  const profileQuery = useQuery({
    queryKey: profileKeys.profile(decodedUsername),
    queryFn: () => fetchPublicProfile(decodedUsername),
    staleTime: PROFILE_STALE_MS,
  })

  const decksQuery = useQuery({
    queryKey: profileKeys.decks(decodedUsername),
    queryFn: () => fetchPublicDecks(decodedUsername),
    staleTime: PROFILE_STALE_MS,
    enabled: !!profileQuery.data,
  })

  // Authoritative ownership for anything that grants write power. The server
  // compares auth.uid() to the profile's resolved user_id, so a stale local
  // nickname can never unlock editing of someone else's profile.
  const followQuery = useQuery({
    queryKey: ['followStats', decodedUsername, user?.id ?? 'anon'],
    queryFn: () => getUserFollowStats(decodedUsername),
    staleTime: PROFILE_STALE_MS,
  })

  const followStats = followQuery.data || null
  const canEdit     = followStats?.is_self === true

  const ownProfileFallback = useMemo(() => ({
    nickname:          settings.nickname,
    bio:               settings.profile_bio || '',
    accent:            settings.profile_accent || '',
    premium:           settings.premium,
    bento_config:      settings.profile_config || DEFAULT_BENTO_CONFIG,
    stats:             null,
    top_card:          null,
    recent_cards:      null,
    joined_at:         null,
    collection_value:  null,
    public_deck_count: null,
  }), [settings.nickname, settings.profile_bio, settings.profile_accent, settings.premium, settings.profile_config])

  // A brand-new user has no row yet; show their local settings rather than a
  // "not found" wall on their own page.
  const profile = profileQuery.data ?? (isOwn ? ownProfileFallback : null)
  const publicDecks = decksQuery.data || []
  const notFound = !profileQuery.isLoading && !profileQuery.data && !isOwn
  const gameStats = profile?.game_stats || null

  // Own numbers are served from the nightly profile_stats cache, so rebuild the
  // row once after first paint — that is what keeps your own totals honest right
  // after an import instead of showing last night's figures.
  const refreshedRef = useRef(false)
  useEffect(() => {
    if (!canEdit || refreshedRef.current) return
    refreshedRef.current = true
    refreshMyProfileStats()
      .then(() => queryClient.invalidateQueries({ queryKey: profileKeys.profile(decodedUsername) }))
      .catch(() => {})
  }, [canEdit, decodedUsername, queryClient])

  // Featured deck record. Owner only — game_results carries no public per-deck
  // exposure, so a visitor simply sees the deck without a W/L line.
  const savedFeaturedDeckId = profile?.bento_config?.featured_deck_id || publicDecks?.[0]?.id || null
  const featuredStatsQuery = useQuery({
    queryKey: ['featuredDeckStats', user?.id, savedFeaturedDeckId],
    enabled: !!(canEdit && user && savedFeaturedDeckId),
    staleTime: PROFILE_STALE_MS,
    queryFn: async () => {
      const { data, error } = await sb.from('game_results')
        .select('placement').eq('user_id', user.id).eq('deck_id', savedFeaturedDeckId)
      if (error) throw error
      const rows = data || []
      const wins = rows.filter(r => r.placement === 1).length
      return { wins, losses: rows.length - wins, total: rows.length }
    },
  })
  const featuredDeckStats = featuredStatsQuery.data || null

  // Record milestone earn dates for the owner. Profile stats are richer than the
  // watcher's IDB-derived shape, so this catches ones the watcher can't see.
  useEffect(() => {
    if (!canEdit || !user || !profile?.stats) return
    checkAndNotifyMilestones({
      stats: profile.stats,
      profile,
      userId: user.id,
      onUnlock: ids => recordMilestoneNotifications(user.id, ids).catch(() => {}),
    })
    const cfg      = profile.bento_config || {}
    const earnedAt = cfg.milestone_earned_at || {}
    const now      = new Date().toISOString()
    let updated    = false
    const newEarnedAt = { ...earnedAt }
    MILESTONES.forEach(m => {
      if (!newEarnedAt[m.id] && m.check(profile.stats, profile)) {
        newEarnedAt[m.id] = now
        updated = true
      }
    })
    if (!updated) return
    const newConfig = { ...cfg, milestone_earned_at: newEarnedAt }
    sb.from('user_settings').update({ profile_config: newConfig, updated_at: now }).eq('user_id', user.id)
      .then(() => {
        settings.save({ profile_config: newConfig })
        queryClient.setQueryData(profileKeys.profile(decodedUsername),
          prev => prev ? { ...prev, bento_config: newConfig } : prev)
      })
      .catch(() => {})
  }, [canEdit, user?.id, profile?.stats, profile?.public_deck_count, profile?.collection_value])

  // ── Follow ─────────────────────────────────────────────────────────────────
  const toggleFollow = useCallback(async () => {
    if (!user || !followStats || followStats.is_self || followBusy) return
    const next = !followStats.viewer_following
    const key  = ['followStats', decodedUsername, user.id]
    setFollowBusy(true)
    queryClient.setQueryData(key, s => s ? {
      ...s,
      viewer_following: next,
      follower_count: Math.max(0, (s.follower_count || 0) + (next ? 1 : -1)),
    } : s)
    try {
      await setFollow(user.id, followStats.user_id, next)
      queryClient.invalidateQueries({ queryKey: profileKeys.follows(decodedUsername, 'followers') })
    } catch {
      queryClient.setQueryData(key, s => s ? {
        ...s,
        viewer_following: !next,
        follower_count: Math.max(0, (s.follower_count || 0) + (next ? -1 : 1)),
      } : s)
      showToast('Could not update follow.', { tone: 'error' })
    } finally {
      setFollowBusy(false)
    }
  }, [user, followStats, followBusy, decodedUsername, queryClient, showToast])

  const shareProfile = useCallback(async () => {
    const url = getPublicAppUrl(`/profile/${encodeURIComponent(decodedUsername)}`)
    try {
      await navigator.clipboard.writeText(url)
      showToast('Profile link copied.')
    } catch {
      showToast('Could not copy the link.', { tone: 'error' })
    }
  }, [decodedUsername, showToast])

  // ── Edit mode ──────────────────────────────────────────────────────────────
  function enterEdit() {
    if (!canEdit) return
    const cfg = profile?.bento_config || {}
    setDraftNickname(profile?.nickname || decodedUsername)
    setNicknameError('')
    setNicknameStatus('')
    setDraftBio(profile?.bio || '')
    setDraftAccent(profile?.accent || '')
    setDraftBlocks(mergeBlocks(cfg.blocks))
    setDraftHeaderArt(cfg.header_art || '')
    setDraftTextContent(cfg.text_content || '')
    setDraftFeaturedDeckId(cfg.featured_deck_id || '')
    setDraftStandoutCards(cfg.featured_deck_standout_cards || [])
    setDraftPinnedDecks(cfg.pinned_deck_ids || [])
    setEditMode(true)
  }

  function cancelEdit() {
    setEditMode(false)
    setActiveId(null)
    setShowArtPicker(false)
    clearTimeout(nicknameTimer.current)
    setNicknameError('')
    setNicknameStatus('')
  }

  // The handle in force right now — the saved one, falling back to the URL that
  // resolved this page. Everything that asks "did the nickname change?" measures
  // against this, not against the draft's own previous value.
  const savedNickname = profile?.nickname || decodedUsername

  function handleNicknameChange(val) {
    setDraftNickname(val)
    clearTimeout(nicknameTimer.current)

    const check = validateNickname(val, { required: true })
    setNicknameError(check.error)
    if (!check.ok) { setNicknameStatus(''); return }

    if (isSameNickname(check.value, savedNickname)) { setNicknameStatus(''); return }

    setNicknameStatus('checking')
    pendingNicknameRef.current = check.value
    nicknameTimer.current = setTimeout(() => {
      isNicknameAvailable(check.value)
        .then(free => {
          // A keystroke may have landed while the request was in flight; only
          // the answer to what is currently typed may set the status.
          if (pendingNicknameRef.current !== check.value) return
          setNicknameStatus(free ? 'available' : 'taken')
        })
        .catch(() => { if (pendingNicknameRef.current === check.value) setNicknameStatus('') })
    }, 600)
  }

  async function saveEdit() {
    if (!canEdit) return

    setSaving(true)

    // Validate and re-ask availability at save time rather than trusting the
    // debounced status: it may never have fired, and a handle free 20 seconds
    // ago can be claimed since. Same guard Settings runs — see lib/nickname.js.
    const nick = await checkNicknameForSave(draftNickname, { current: savedNickname })
    if (!nick.ok) {
      if (nick.reason === 'taken') setNicknameStatus('taken')
      else setNicknameError(nick.error)
      showToast(nick.error, { tone: 'error' })
      setSaving(false)
      return
    }
    const nicknameChanged = nick.changed

    const newConfig = {
      blocks:                       draftBlocks,
      header_art:                   draftHeaderArt,
      text_content:                 draftTextContent,
      featured_deck_id:             draftFeaturedDeckId,
      featured_deck_standout_cards: draftStandoutCards,
      pinned_deck_ids:              draftPinnedDecks,
      milestone_earned_at:          profile?.bento_config?.milestone_earned_at || {},
    }
    const { error } = await sb.from('user_settings').update({
      ...(nicknameChanged ? { nickname: nick.value } : {}),
      profile_bio:    draftBio,
      profile_accent: draftAccent,
      profile_config: newConfig,
      updated_at:     new Date().toISOString(),
    }).eq('user_id', user.id)

    if (error) {
      // The unique index on nickname; nothing else on this update can collide.
      // Losing the race with another signup is rare but not impossible.
      const taken = isNicknameTakenError(error)
      if (taken) setNicknameStatus('taken')
      showToast(taken ? 'That nickname was just taken.' : 'Could not save your profile.', { tone: 'error' })
      setSaving(false)
      return
    }

    settings.save({
      ...(nicknameChanged ? { nickname: nick.value } : {}),
      profile_bio: draftBio, profile_accent: draftAccent, profile_config: newConfig,
    })
    queryClient.setQueryData(profileKeys.profile(decodedUsername),
      prev => prev ? { ...prev, bio: draftBio, accent: draftAccent, bento_config: newConfig } : prev)
    // Block visibility changes what the RPC returns, so the cached row is stale.
    queryClient.invalidateQueries({ queryKey: profileKeys.profile(decodedUsername) })
    setEditMode(false)
    setSaving(false)
    showToast(nicknameChanged ? `You are now ${nick.value}.` : 'Profile saved.')

    // The nickname IS the address of this page, so a rename has to move the
    // route with it — otherwise the next render fetches a profile whose handle
    // no longer exists. replace: true keeps Back from returning to a dead URL.
    if (nicknameChanged) {
      queryClient.removeQueries({ queryKey: profileKeys.profile(decodedUsername) })
      navigate(`/profile/${encodeURIComponent(nick.value)}`, { replace: true })
    }
  }

  function hideBlock(id) { setDraftBlocks(prev => prev.map(b => b.id === id ? { ...b, enabled: false } : b)) }
  function showBlock(id) { setDraftBlocks(prev => prev.map(b => b.id === id ? { ...b, enabled: true  } : b)) }
  function togglePin(id) {
    setDraftPinnedDecks(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id])
  }

  // ── dnd ────────────────────────────────────────────────────────────────────
  const ledgerIds = useMemo(() => draftBlocks.filter(b => b.enabled && isStat(b.id)).map(b => b.id), [draftBlocks])
  const panelIds  = useMemo(() => draftBlocks.filter(b => b.enabled && !isStat(b.id)).map(b => b.id), [draftBlocks])
  const trayIds   = useMemo(() => draftBlocks.filter(b => !b.enabled).map(b => b.id), [draftBlocks])

  function handleDragEnd({ active, over }) {
    setActiveId(null)
    if (!over || active.id === over.id) return
    const dropId    = over.id
    const toTray    = dropId === TRAY_DROP_ID || trayIds.includes(dropId)
    const wasHidden = trayIds.includes(active.id)

    setDraftBlocks(prev => {
      const block = prev.find(b => b.id === active.id)
      if (!block) return prev

      // A block's kind fixes which zone it belongs to, so dropping only ever
      // decides shown vs hidden — never which zone. That is what stops a stat
      // ending up as a full-width panel.
      if (toTray) {
        if (wasHidden) return prev
        return prev.map(b => b.id === active.id ? { ...b, enabled: false } : b)
      }
      if (wasHidden) {
        return prev.map(b => b.id === active.id ? { ...b, enabled: true } : b)
      }

      // Reorder inside the block's own zone.
      const zone = isStat(active.id) ? ledgerIds : panelIds
      const from = zone.indexOf(active.id)
      const to   = zone.indexOf(dropId)
      if (from < 0 || to < 0 || from === to) return prev

      // Rebuild the array with this zone's blocks in their new order. Render
      // order comes from draftBlocks order, and `rest` (the other zone plus the
      // hidden blocks) keeps its own relative order either way.
      const reordered = arrayMove(zone, from, to)
      const inZone    = new Set(reordered)
      const rest      = prev.filter(b => !inZone.has(b.id))
      const moved     = reordered.map(id => prev.find(b => b.id === id))
      return isStat(active.id) ? [...moved, ...rest] : [...rest, ...moved]
    })
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  const cfg      = profile?.bento_config || {}
  const stats    = profile?.stats
  const featId   = editMode ? draftFeaturedDeckId : cfg.featured_deck_id
  const standout = editMode ? draftStandoutCards : (cfg.featured_deck_standout_cards || [])
  const pinned   = editMode ? draftPinnedDecks : (cfg.pinned_deck_ids || [])

  // One source of truth for a stat's text. The banner ledger and edit mode's
  // stat cells are two presentations of the same figures — the ledger is what
  // a visitor sees, the cells are only the editing affordance.
  function statFor(id) {
    switch (id) {
      case 'total':      return { label: 'Cards',            value: fmtNum(stats?.total_cards) }
      case 'unique':     return { label: 'Unique prints',    value: fmtNum(stats?.unique_cards) }
      case 'foils':      return { label: 'Foils',            value: fmtNum(stats?.foil_count) }
      case 'sets':       return { label: 'Sets',             value: fmtNum(stats?.sets_count) }
      case 'since':      return { label: 'Collecting since', value: profile?.joined_at ? new Date(profile.joined_at).getFullYear() : '—' }
      case 'value':      return { label: 'Est. value',       value: profile?.collection_value != null ? `€${Number(profile.collection_value).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—' }
      case 'deck_count': return { label: 'Public decks',     value: fmtNum(profile?.public_deck_count) }
      default:           return null
    }
  }

  function renderStat(id) {
    if (id === 'winrate')    return <WinRateBlock gameStats={gameStats} />
    if (id === 'fav_format') return <FavFormatBlock gameStats={gameStats} decks={publicDecks} />
    const stat = statFor(id)
    return stat ? <StatCell label={stat.label} value={stat.value} /> : null
  }

  function ledgerStat(id) {
    if (id === 'winrate') {
      if (!gameStats?.total) return null
      return { label: 'Win rate', value: `${Math.round(gameStats.wins / gameStats.total * 100)}%` }
    }
    if (id === 'fav_format') {
      const fmt = gameStats?.fav_format
        || [...new Set(publicDecks.map(d => d.format).filter(Boolean))][0]
      return fmt ? { label: 'Most played', value: FORMAT_LABEL[fmt] || fmt } : null
    }
    const stat = statFor(id)
    // A dash carries no information in a run of figures — drop the whole entry.
    return stat && stat.value !== '—' ? stat : null
  }

  function renderPanel(id) {
    switch (id) {
      case 'bio':           return <TextBlock text={editMode ? draftTextContent : (cfg.text_content || '')} editMode={editMode} onChangeText={setDraftTextContent} />
      case 'top_cards':     return <BinderBlock cards={profile?.top_cards} />
      case 'milestones':    return <MilestonesBlock stats={stats} profile={profile} />
      case 'recent_cards':  return <RecentCardsBlock cards={profile?.recent_cards} />
      case 'decks':         return <DecksBlock decks={publicDecks} pinnedIds={pinned} editMode={editMode} onTogglePin={togglePin} />
      case 'featured_deck': return (
        <FeaturedDeckBlock
          decks={publicDecks}
          featuredDeckId={featId}
          standoutCards={standout}
          deckStats={featuredDeckStats}
          editMode={editMode}
          // Standout cards belong to the deck they were picked from, so
          // switching decks has to drop them. Keeping them showed cards from
          // the previous deck under the new deck's name, and saving that would
          // have persisted the mismatch.
          onChangeFeaturedDeck={id => { setDraftFeaturedDeckId(id); setDraftStandoutCards([]) }}
          onChangeStandoutCards={setDraftStandoutCards}
        />
      )
      default: return null
    }
  }

  const headerArt   = editMode ? draftHeaderArt : (cfg.header_art || '')
  const accentColor = (editMode ? draftAccent : profile?.accent) || 'var(--gold)'
  const displayName = profile?.nickname || decodedUsername
  const headerBio   = editMode ? draftBio : (profile?.bio || '')

  const viewBlocks  = mergeBlocks(cfg.blocks).filter(b => b.enabled)
  const viewPanels  = viewBlocks.filter(b => !isStat(b.id))
  const ledgerStats = viewBlocks
    .filter(b => isStat(b.id))
    .map(b => { const s = ledgerStat(b.id); return s ? { id: b.id, ...s } : null })
    .filter(Boolean)

  if (profileQuery.isLoading) return <ProfileSkeleton />

  if (notFound) return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <EmptyState>
          <h1 className={styles.notFoundTitle}>No collector called “{decodedUsername}”</h1>
          <p>Check the spelling, or head back and find them from a shared deck.</p>
          <Link to="/" className={styles.textLink}>Back to home</Link>
        </EmptyState>
      </div>
    </div>
  )

  return (
    <div className={styles.page} style={{ '--profile-accent': accentColor }}>
      {/* ── Banner ── */}
      <header className={styles.banner}>
        {headerArt
          ? <div className={styles.bannerArt} style={{ backgroundImage: `url(${headerArt})` }} />
          : <div className={styles.bannerFallback} />}
        <div className={styles.bannerScrim} />

        <div className={`${styles.shell} ${styles.bannerInner}`}>
          <div className={styles.identity}>
            {/* Follows the draft while renaming, so the monogram is not still
                showing the old initial as you type the new handle. */}
            <div className={styles.avatar}>
              {((editMode ? draftNickname.trim() || displayName : displayName)[0] || '?').toUpperCase()}
            </div>
            <div className={styles.identityText}>
              {editMode ? (
                <div className={styles.nameEdit}>
                  <input
                    className={styles.nameInput}
                    type="text"
                    value={draftNickname}
                    onChange={e => handleNicknameChange(e.target.value)}
                    maxLength={NICKNAME_MAX_LENGTH}
                    aria-label="Nickname"
                    aria-invalid={!!nicknameError}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className={styles.nameEditMeta}>
                    {nicknameError
                      ? <span className={styles.nameStatusBad}>{nicknameError}</span>
                      : nicknameStatus === 'checking'  ? <span className={styles.nameStatus}>Checking…</span>
                      : nicknameStatus === 'taken'     ? <span className={styles.nameStatusBad}>Taken</span>
                      : nicknameStatus === 'available' ? <span className={styles.nameStatusOk}>✓ Available</span>
                      : null}
                    {!nicknameError && !isSameNickname(draftNickname, savedNickname) && (
                      <span className={styles.nameStatus}>
                        Renaming moves your profile — links to /profile/{savedNickname} will stop working.
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <h1 className={styles.name}>
                  {displayName}
                  {profile?.premium && <span className={styles.supporter}>Supporter</span>}
                </h1>
              )}

              {editMode ? (
                <textarea className={styles.bioEdit} value={draftBio}
                  onChange={e => setDraftBio(e.target.value)}
                  placeholder="One line about what you collect…" maxLength={300} rows={2} />
              ) : headerBio ? (
                <p className={styles.bio}>{headerBio}</p>
              ) : null}

              <div className={styles.metaRow}>
                {followStats && (
                  <>
                    <button className={styles.metaLink} onClick={() => setFollowDialog('followers')}>
                      <strong>{followStats.follower_count}</strong> follower{followStats.follower_count === 1 ? '' : 's'}
                    </button>
                    <button className={styles.metaLink} onClick={() => setFollowDialog('following')}>
                      <strong>{followStats.following_count}</strong> following
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* The ledger — the collector's figures as ruled, aligned columns.
              Context for the showcase below, not the subject of the page. */}
          {!editMode && ledgerStats.length > 0 && (
            <dl className={styles.ledger}>
              {ledgerStats.map(({ id, label, value }) => (
                // Term before definition, as a <dl> requires; the value is
                // lifted above its label visually with `order`.
                <div key={id} className={styles.ledgerEntry}>
                  <dt className={styles.ledgerLabel}>{label}</dt>
                  <dd className={styles.ledgerValue}>{value}</dd>
                </div>
              ))}
            </dl>
          )}

          <div className={styles.bannerActions}>
            {!editMode && (
              <>
                <FollowButton stats={followStats} user={user} busy={followBusy} onToggle={toggleFollow} />
                <Button variant="secondary" size="sm" onClick={shareProfile}>
                  <ShareIcon size={13} /> Share
                </Button>
                <Link to={`/trade/${encodeURIComponent(decodedUsername)}`} className={styles.tradeLink}>
                  <TradingIcon size={13} /> Trade post
                </Link>
                {canEdit && (
                  <Button variant="secondary" size="sm" onClick={enterEdit}>
                    <EditIcon size={13} /> Edit profile
                  </Button>
                )}
              </>
            )}
            {editMode && (
              <>
                <Button variant="green" size="sm" onClick={saveEdit} disabled={saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
                <Button variant="ghost" size="sm" onClick={cancelEdit}>Cancel</Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── Edit toolbar ── */}
      {editMode && (
        <div className={`${styles.shell} ${styles.editShell}`}>
          <div className={styles.editToolbar}>
            <div className={styles.editToolbarGroup}>
              <span className={styles.editToolbarLabel}>Accent</span>
              <div className={styles.swatches}>
                {ACCENT_PALETTE.map(color => (
                  <button key={color}
                    className={`${styles.swatch}${(draftAccent || '#c9a84c') === color ? ' ' + styles.swatchOn : ''}`}
                    style={{ background: color }}
                    onClick={() => setDraftAccent(color)}
                    title={color} aria-label={`Accent colour ${color}`} />
                ))}
              </div>
            </div>
            <div className={styles.editToolbarGroup}>
              <span className={styles.editToolbarLabel}>Banner</span>
              <Button variant="secondary" size="sm" onClick={() => setShowArtPicker(true)}>
                <ImageIcon size={13} /> {draftHeaderArt ? 'Change art' : 'Add art'}
              </Button>
              {draftHeaderArt && (
                <Button variant="danger" size="sm" onClick={() => setDraftHeaderArt('')}>Remove</Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── View mode ── */}
      {!editMode && (
        <div className={styles.shell}>
          <div className={styles.panels}>
            {viewPanels.map(b => (
              <div key={b.id} className={spanClass(b.id)}>{renderPanel(b.id)}</div>
            ))}
          </div>
        </div>
      )}

      {/* ── Edit mode ── */}
      {editMode && (
        <DndContext sensors={sensors} collisionDetection={closestCenter}
          onDragStart={({ active }) => setActiveId(active.id)} onDragEnd={handleDragEnd}>
          <div className={`${styles.shell} ${styles.editShell} ${styles.editLayout}`}>
            <div className={styles.editMain}>
              <p className={styles.editHint}>
                Drag to reorder. Stats stay in the ledger strip, panels stay in the showcase.
              </p>

              <Zone id={LEDGER_DROP_ID} className={styles.editLedgerZone}>
                <span className={styles.zoneLabel}>Ledger</span>
                <SortableContext items={ledgerIds} strategy={noDisplace}>
                  <div className={styles.editLedgerGrid}>
                    {ledgerIds.map(id => (
                      <SortableBlock key={id} id={id} onHide={hideBlock} cell>
                        {renderStat(id)}
                      </SortableBlock>
                    ))}
                  </div>
                </SortableContext>
                {ledgerIds.length === 0 && <p className={styles.zoneEmpty}>Drag a stat here.</p>}
              </Zone>

              <Zone id={PANEL_DROP_ID} className={styles.editPanelZone}>
                <span className={styles.zoneLabel}>Showcase</span>
                <SortableContext items={panelIds} strategy={noDisplace}>
                  <div className={styles.panels}>
                    {panelIds.map(id => (
                      <SortableBlock key={id} id={id} onHide={hideBlock}>
                        {renderPanel(id)}
                      </SortableBlock>
                    ))}
                  </div>
                </SortableContext>
                {panelIds.length === 0 && <p className={styles.zoneEmpty}>Drag a panel here.</p>}
              </Zone>
            </div>

            <Zone id={TRAY_DROP_ID} className={styles.tray}>
              <h2 className={styles.trayTitle}>Hidden</h2>
              <p className={styles.traySub}>Drag a block here to hide it.</p>
              <div className={styles.trayList}>
                {trayIds.length === 0
                  ? <p className={styles.zoneEmpty}>Everything is on your profile.</p>
                  : (
                    <SortableContext items={trayIds} strategy={verticalListSortingStrategy}>
                      {trayIds.map(id => <SortableTrayItem key={id} id={id} onShow={showBlock} />)}
                    </SortableContext>
                  )}
              </div>
            </Zone>
          </div>

          <DragOverlay dropAnimation={{ duration: 150, easing: 'ease' }}>
            {activeId && (
              <div className={styles.dragGhost}>
                <span aria-hidden="true">⠿</span>{BLOCK_DEFS[activeId]?.label}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {showArtPicker && (
        <CardArtPicker
          title="Choose banner art"
          onSelect={url => { setDraftHeaderArt(url); setShowArtPicker(false) }}
          onClose={() => setShowArtPicker(false)}
        />
      )}

      {followDialog && (
        <FollowListDialog username={decodedUsername} kind={followDialog}
          onClose={() => setFollowDialog(null)} />
      )}
      <PublicPageFooter />
    </div>
  )
}
