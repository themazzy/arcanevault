import { useState, useEffect, useMemo, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { parseDeckMeta, serializeDeckMeta, FORMATS, groupDeckCards, TYPE_GROUPS } from '../lib/deckBuilderApi'
import DeckStats, { normalizeDeckBuilderCards } from '../components/DeckStats'
import styles from './DeckView.module.css'
import uiStyles from '../components/UI.module.css'
import { fetchDeckCards } from '../lib/deckData'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { getPrice, formatPrice } from '../lib/scryfall'
import { ResponsiveMenu } from '../components/UI'
import { CardBrowserContent, CARD_BROWSER_VIEW_MODES } from '../components/CardBrowserViews'
import { GridViewIcon, StacksViewIcon, TextViewIcon, TableViewIcon, CopyIcon, CheckIcon } from '../icons'

// ── Mana / symbol renderer ────────────────────────────────────────────────────
// Converts Scryfall notation like {W}, {T}, {2/U}, {X} → inline SVG images.
// Newlines in oracle text are preserved via the parent's white-space: pre-line.
function ManaText({ text, imgStyle }) {
  if (!text) return null
  const parts = text.split(/(\{[^}]+\})/g)
  const symStyle = { width: '1em', height: '1em', verticalAlign: '-0.15em', display: 'inline-block', margin: '0 1.5px', ...imgStyle }
  return (
    <>
      {parts.map((part, i) => {
        if (/^\{[^}]+\}$/.test(part)) {
          // Strip braces, upper-case, replace / with - for hybrid (e.g. W/U → W-U)
          const sym = part.slice(1, -1).toUpperCase().replace(/\//g, '-')
          return (
            <img
              key={i}
              src={`https://svgs.scryfall.io/card-symbols/${sym}.svg`}
              alt={part}
              title={part}
              style={symStyle}
            />
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

// ── Lightweight card detail modal (fetches from Scryfall) ────────────────────
function CardDetailModal({ cardName, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!cardName) return
    setLoading(true)
    fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(cardName)}&format=json`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [cardName])

  const face  = data?.card_faces?.[0] || data
  const face2 = data?.card_faces?.[1] || null
  const imgUrl  = face?.image_uris?.normal  || data?.image_uris?.normal
  const imgUrl2 = face2?.image_uris?.normal || null

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalBox} onClick={e => e.stopPropagation()}>

        {loading && <div className={styles.modalLoading}>Loading…</div>}

        {!loading && data && (
          <>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.modalCardName}>{data.name}</div>
                <div className={styles.modalTypeLine}>{face?.type_line || data.type_line}</div>
              </div>
              <div className={styles.modalHeaderRight}>
                {(face?.mana_cost || data.mana_cost) && (
                  <span className={styles.modalManaCost}>
                    <ManaText
                      text={face?.mana_cost || data.mana_cost}
                      imgStyle={{ width: '1.1em', height: '1.1em' }}
                    />
                  </span>
                )}
                <button className={styles.modalClose} onClick={onClose}>×</button>
              </div>
            </div>

            <div className={styles.modalBody}>
              <div className={styles.modalImages}>
                {imgUrl  && <img src={imgUrl}  alt={data.name} />}
                {imgUrl2 && <img src={imgUrl2} alt={data.name} />}
              </div>
              <div className={styles.modalDetails}>
                {(face?.oracle_text || data.oracle_text) && (
                  <div className={styles.modalOracleText}>
                    <ManaText text={face?.oracle_text || data.oracle_text} />
                  </div>
                )}
                {face2?.oracle_text && (
                  <div className={styles.modalOracleText2}>
                    <ManaText text={face2.oracle_text} />
                  </div>
                )}
                <div className={styles.modalTags}>
                  {data.set_name     && <span className={styles.modalTag}>{data.set_name}</span>}
                  {data.rarity       && <span className={styles.modalTag}>{data.rarity}</span>}
                  {face?.power != null && <span className={styles.modalTag}>{face.power}/{face.toughness}</span>}
                  {data.loyalty      && <span className={styles.modalTag}>Loyalty {data.loyalty}</span>}
                </div>
                {data.flavor_text && (
                  <div className={styles.modalFlavor}>{data.flavor_text}</div>
                )}
              </div>
            </div>
          </>
        )}

        {!loading && !data && (
          <div className={styles.modalError}>Could not load card data.</div>
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DeckViewPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()

  // ── All state up top (before any conditional returns) ─────────────────────
  const [deck, setDeck]         = useState(null)
  const [deckMeta, setDeckMeta] = useState({})
  const [cards, setCards]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  const [detailCard, setDetailCard] = useState(null)
  const [viewMode, setViewMode]     = useState('grid')
  const [hoverImg, setHoverImg]     = useState(null)
  const [hoverPos, setHoverPos]     = useState({ x: 0, y: 0 })
  useEffect(() => {
    const handler = e => setHoverPos({ x: e.clientX, y: e.clientY })
    window.addEventListener('mousemove', handler)
    return () => window.removeEventListener('mousemove', handler)
  }, [])
  const [copying, setCopying]       = useState(false)
  const [copyDone, setCopyDone]     = useState(false)

  const [sortBy,    setSortBy]    = useState('type')  // 'type' | 'name' | 'cmc' | 'color'
  const [groupBy,   setGroupBy]   = useState('type')  // 'type' | 'none'
  const [showDecklist, setShowDecklist] = useState(false)
  const [decklistCopied, setDecklistCopied] = useState(false)
  const [sfMap,     setSfMap]     = useState({})

  const [statsBracketOverride, setStatsBracketOverride] = useState(null)

  // ── Load deck data ──────────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      const { data: folder, error: ferr } = await sb.from('folders').select('*').eq('id', id).maybeSingle()
      if (ferr || !folder) {
        setError(user ? 'Deck not found' : 'sign-in')
        setLoading(false)
        return
      }
      setDeck(folder)
      setDeckMeta(parseDeckMeta(folder.description))

      const deckCards = await fetchDeckCards(id)
      setCards(deckCards || [])
      setLoading(false)
      if (deckCards?.length) {
        loadCardMapWithSharedPrices(deckCards).then(setSfMap).catch(() => {})
      }
    })()
  }, [id, user])

  // ── Copy deck to own builder ────────────────────────────────────────────────
  async function copyDeck() {
    if (!user || copying) return
    setCopying(true)
    try {
      const newMeta = serializeDeckMeta({ ...deckMeta, copiedFrom: id })
      const { data: existingDecks, error: namesErr } = await sb
        .from('folders')
        .select('name')
        .eq('user_id', user.id)
        .eq('type', 'builder_deck')
      if (namesErr) throw namesErr

      const existingNames = new Set((existingDecks || []).map(row => row.name))
      const baseName = deck.name?.trim() || 'Copied Deck'
      let nextName = baseName
      if (existingNames.has(nextName)) {
        let copyIndex = 2
        nextName = `${baseName} (Copy)`
        while (existingNames.has(nextName)) {
          nextName = `${baseName} (Copy ${copyIndex})`
          copyIndex += 1
        }
      }

      const { data: newFolder, error: folderErr } = await sb
        .from('folders')
        .insert({ name: nextName, type: 'builder_deck', user_id: user.id, description: newMeta })
        .select()
        .single()
      if (folderErr) throw folderErr

      if (cards.length > 0) {
        const rows = cards.map(c => ({
          deck_id:          newFolder.id,
          user_id:          user.id,
          card_print_id:    c.card_print_id || null,
          scryfall_id:      c.scryfall_id || null,
          name:             c.name,
          set_code:         c.set_code || null,
          collector_number: c.collector_number || null,
          mana_cost:        c.mana_cost || null,
          cmc:              c.cmc ?? null,
          color_identity:   c.color_identity || [],
          image_uri:        c.image_uri || null,
          qty:              c.qty,
          foil:             c.foil || false,
          is_commander:     c.is_commander || false,
          board:            c.board || 'main',
          type_line:        c.type_line || null,
        }))
        const { error: cardsErr } = await sb.from('deck_cards').insert(rows)
        if (cardsErr) throw cardsErr
      }

      setCopyDone(true)
      setTimeout(() => navigate(`/builder/${newFolder.id}`), 900)
    } catch (e) {
      console.error('[DeckView] copyDeck error:', e)
      setCopying(false)
    }
  }

  // ── Derived values ─────────────────────────────────────────────────────────
  const isOwner    = user && deck?.user_id === user.id
  const isViewer   = user && deck?.user_id !== user.id
  const format     = FORMATS.find(f => f.id === deckMeta.format)
  const totalCards = useMemo(() => cards.reduce((s, c) => s + c.qty, 0), [cards])

  // Sort cards according to sortBy
  const sortCards = useCallback((list) => {
    const copy = [...list]
    if (sortBy === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name))
    if (sortBy === 'cmc')  return copy.sort((a, b) => (a.cmc ?? 0) - (b.cmc ?? 0) || a.name.localeCompare(b.name))
    if (sortBy === 'color') return copy.sort((a, b) => {
      const ca = (a.color_identity || []).join('') || 'Z'
      const cb = (b.color_identity || []).join('') || 'Z'
      return ca.localeCompare(cb) || a.name.localeCompare(b.name)
    })
    return copy // 'type' — groupDeckCards handles ordering
  }, [sortBy])

  const groupedCards  = useMemo(() => groupDeckCards(cards), [cards])
  const sortedFlat    = useMemo(() => sortCards(cards), [cards, sortCards])
  const effectiveViewMode = viewMode === 'list' ? 'table' : viewMode

  // Total deck value
  const { totalValue, totalValueFmt } = useMemo(() => {
    const v = cards.reduce((sum, c) => {
      const sfCard = sfMap[`${c.set_code}-${c.collector_number}`]
      const p = getPrice(sfCard, c.foil)
      return p != null ? sum + p * c.qty : sum
    }, 0)
    return { totalValue: v, totalValueFmt: v > 0 ? formatPrice(v) : null }
  }, [cards, sfMap])

  // Build plain-text decklist for copy
  const buildDecklist = useCallback(() => {
    const commander = cards.filter(c => c.is_commander)
    const main      = cards.filter(c => !c.is_commander && c.board !== 'side' && c.board !== 'maybe')
    const side      = cards.filter(c => c.board === 'side')
    const lines = []
    if (commander.length) {
      lines.push('// Commander')
      commander.forEach(c => lines.push(`${c.qty} ${c.name}`))
      lines.push('')
    }
    if (groupBy === 'type') {
      TYPE_GROUPS.forEach(group => {
        const gc = groupedCards.get(group)?.filter(c => !c.is_commander && c.board !== 'side' && c.board !== 'maybe')
        if (!gc?.length) return
        lines.push(`// ${group}`)
        sortCards(gc).forEach(c => lines.push(`${c.qty} ${c.name}`))
        lines.push('')
      })
    } else {
      if (main.length) {
        lines.push('// Main')
        sortCards(main).forEach(c => lines.push(`${c.qty} ${c.name}`))
        lines.push('')
      }
    }
    if (side.length) {
      lines.push('// Sideboard')
      sortCards(side).forEach(c => lines.push(`${c.qty} ${c.name}`))
    }
    return lines.join('\n').trim()
  }, [cards, groupBy, groupedCards, sortCards])

  // Best available card image
  const cardImg = (c) =>
    c.image_uri ||
    `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.name)}&format=image&version=normal`

  // ── Loading / error states ─────────────────────────────────────────────────
  if (loading) return (
    <div className={styles.signinPage}>
      <div className={styles.signinLogo}>UNTAP<span>HUB</span></div>
      <div className={styles.signinMsg} style={{ fontStyle: 'italic' }}>Loading deck…</div>
    </div>
  )

  if (error === 'sign-in') return (
    <div className={styles.signinPage}>
      <div className={styles.signinLogo}>UNTAP<span>HUB</span></div>
      <div className={styles.signinMsg}>Sign in to view this deck.</div>
      <Link to="/login" className={styles.signinLink}>Sign In to UntapHub</Link>
    </div>
  )

  if (error) return (
    <div className={styles.signinPage}>
      <div className={styles.signinMsg}>{error}</div>
      <Link to="/" className={styles.signinLink}>Go to UntapHub</Link>
    </div>
  )

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>

      {/* Card detail modal */}
      {detailCard && <CardDetailModal cardName={detailCard} onClose={() => setDetailCard(null)} />}

      {/* ── Top bar ── */}
      <div className={styles.topBar}>
        <Link to="/" className={styles.logo}>UNTAP<span>HUB</span></Link>

        <div className={styles.topActions}>
          {!user ? (
            <>
              <Link to="/login" className={styles.signInBtn}>Sign In</Link>
              <Link to="/login" className={styles.actionLink}>Create Account</Link>
            </>
          ) : isOwner ? (
            <Link to={`/builder/${id}`} className={styles.actionLink}>⚔ Edit in Builder</Link>
          ) : (
            <>
              <Link to="/" className={styles.topLink}>← My Vault</Link>
            </>
          )}
        </div>
      </div>

      {/* ── Deck header ── */}
      <div className={styles.deckHeader}>
        <h1 className={styles.deckTitle}>{deck.name}</h1>
        <div className={styles.deckMeta}>
          {format && <span className={styles.formatBadge}>{format.label}</span>}
          {format && <span className={styles.metaDot}>·</span>}
          <span>{totalCards} cards</span>
          {totalValueFmt && <><span className={styles.metaDot}>·</span><span className={styles.deckValue}>{totalValueFmt}</span></>}
          {deckMeta.commanderName && (
            <>
              <span className={styles.metaDot}>·</span>
              <span className={styles.commanderBadge}>⚔ {deckMeta.commanderName}</span>
            </>
          )}
        </div>
        {isViewer && (
          <div className={styles.viewerBanner}>
            <div className={styles.viewerCopy}>
              <div className={styles.viewerEyebrow}>Shared Deck</div>
              <div className={styles.viewerText}>Copy this list straight into your deckbuilder.</div>
            </div>
            <button
              onClick={copyDeck}
              disabled={copying || copyDone}
              className={`${styles.actionBtn}${copyDone ? ' ' + styles.actionBtnDone : ''}`}
            >
              {copyDone ? '✓ Added to Deckbuilder' : copying ? 'Copying…' : '＋ Copy to My Deckbuilder'}
            </button>
          </div>
        )}
      </div>

      {/* ── Body: deck list (dominant) + right sidebar ── */}
      <div className={styles.body}>

        {/* ── Left: deck list — the star of the page ── */}
        <div className={styles.deckListPanel}>

          {/* Header: label + controls */}
          <div className={styles.listHeader}>
            <span className={styles.listLabel}>Decklist · {totalCards}</span>
            <div className={styles.listControls}>
              {/* Sort menu */}
              <ResponsiveMenu
                trigger={({ open, toggle }) => (
                  <button
                    className={`${uiStyles.btn} ${uiStyles.sm} ${uiStyles.ghost} ${open ? uiStyles.active : ''}`}
                    onClick={toggle}
                  >
                    Sort: {sortBy === 'type' ? 'Type' : sortBy === 'name' ? 'Name' : sortBy === 'cmc' ? 'CMC' : 'Color'} ▾
                  </button>
                )}
              >
                {({ close }) => (
                  <>
                    {[
                      { id: 'type',  label: 'By Type' },
                      { id: 'name',  label: 'By Name' },
                      { id: 'cmc',   label: 'By CMC' },
                      { id: 'color', label: 'By Color' },
                    ].map(opt => (
                      <button
                        key={opt.id}
                        className={`${uiStyles.responsiveMenuAction}${sortBy === opt.id ? ' ' + uiStyles.responsiveMenuActionActive : ''}`}
                        onClick={() => { setSortBy(opt.id); close() }}
                      >
                        {opt.label}
                        <span className={uiStyles.responsiveMenuCheck}>{sortBy === opt.id ? '✓' : ''}</span>
                      </button>
                    ))}
                  </>
                )}
              </ResponsiveMenu>
              {/* Group toggle pill */}
              <div className={styles.viewToggles}>
                <button
                  className={`${styles.vBtn}${groupBy === 'type' ? ' ' + styles.vBtnActive : ''}`}
                  onClick={() => setGroupBy('type')}
                >Grouped</button>
                <button
                  className={`${styles.vBtn}${groupBy === 'none' ? ' ' + styles.vBtnActive : ''}`}
                  onClick={() => setGroupBy('none')}
                >Ungrouped</button>
              </div>
              {/* Copy decklist */}
              <button
                className={styles.actionBtn}
                onClick={isViewer ? copyDeck : () => setShowDecklist(true)}
                disabled={isViewer && (copying || copyDone)}
              >
                {isViewer
                  ? (copyDone ? '✓ Added to Deckbuilder' : copying ? 'Copying…' : '＋ Copy to My Deckbuilder')
                  : '⎘ Copy Decklist'}
              </button>
              {/* View toggle — all 5 modes */}
              <div className={styles.viewToggles}>
                {[
                  { id: 'stacks', Icon: StacksViewIcon, label: 'Stacks' },
                  { id: 'text',   Icon: TextViewIcon,   label: 'Text' },
                  { id: 'grid',   Icon: GridViewIcon,   label: 'Grid' },
                  { id: 'table',  Icon: TableViewIcon,  label: 'Table' },
                ].map(m => (
                  <button
                    key={m.id}
                    className={`${styles.vBtn}${effectiveViewMode === m.id ? ' ' + styles.vBtnActive : ''}`}
                    title={m.label}
                    onClick={() => setViewMode(m.id)}
                  ><m.Icon size={13} /></button>
                ))}
              </div>
            </div>
          </div>

          {/* ── Card browser content ── */}
          <CardBrowserContent
            cards={sortedFlat}
            sfMap={sfMap}
            priceSource="cardmarket_trend"
            viewMode={effectiveViewMode}
            groupBy={groupBy}
            onSelect={card => setDetailCard(card.name)}
            onHover={effectiveViewMode !== 'grid' ? img => setHoverImg(img) : undefined}
            onHoverEnd={effectiveViewMode !== 'grid' ? () => setHoverImg(null) : undefined}
          />

          {cards.length === 0 && (
            <div className={styles.emptyDeck}>This deck has no cards yet.</div>
          )}
        </div>

        {/* Floating hover preview */}
        {hoverImg && (
          <img
            src={hoverImg}
            alt=""
            className={styles.hoverPreview}
            style={{
              left: hoverPos.x + 18,
              top: Math.min(hoverPos.y - 60, window.innerHeight - 320),
            }}
          />
        )}

        {/* ── Right sidebar ── */}
        <div className={styles.sidebar}>
          {cards.length > 0 && (
            <div>
              <div className={styles.sectionLabel}>Stats</div>
              <DeckStats
                cards={normalizeDeckBuilderCards(cards)}
                bracketOverride={statsBracketOverride}
                onBracketOverride={isOwner ? setStatsBracketOverride : undefined}
              />
            </div>
          )}
        </div>
      </div>
      {/* ── Decklist modal ── */}
      {showDecklist && (() => {
        const text = buildDecklist()
        return (
          <div className={styles.decklistBackdrop} onClick={() => setShowDecklist(false)}>
            <div className={styles.decklistModal} onClick={e => e.stopPropagation()}>
              <div className={styles.decklistHeader}>
                <span className={styles.decklistTitle}>Decklist</span>
                <div className={styles.decklistHeaderActions}>
                  <button
                    className={`${styles.actionBtn}${decklistCopied ? ' ' + styles.actionBtnDone : ''}`}
                    onClick={() => {
                      navigator.clipboard.writeText(text).then(() => {
                        setDecklistCopied(true)
                        setTimeout(() => setDecklistCopied(false), 2000)
                      })
                    }}
                  >
                    {decklistCopied ? '✓ Copied' : '⎘ Copy'}
                  </button>
                  <button className={styles.decklistClose} onClick={() => setShowDecklist(false)}>×</button>
                </div>
              </div>
              <pre className={styles.decklistText}>{text}</pre>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
