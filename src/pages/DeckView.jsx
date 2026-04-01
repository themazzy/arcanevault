import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { parseDeckMeta, serializeDeckMeta, FORMATS, groupDeckCards, TYPE_GROUPS } from '../lib/deckBuilderApi'
import DeckStats, { normalizeDeckBuilderCards } from '../components/DeckStats'
import styles from './DeckView.module.css'

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
  const [deckView, setDeckView]     = useState('grid')
  const [hoverImg, setHoverImg]     = useState(null)
  const [hoverPos, setHoverPos]     = useState({ x: 0, y: 0 })
  const [copying, setCopying]       = useState(false)
  const [copyDone, setCopyDone]     = useState(false)

  // wide = show deck list in 2-col typographic layout (enough horizontal room)
  const [wide, setWide] = useState(() => window.innerWidth >= 1100)
  useEffect(() => {
    const handler = () => setWide(window.innerWidth >= 1100)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  const [combosLoading,  setCombosLoading]  = useState(false)
  const [combosFetched,  setCombosFetched]  = useState(false)
  const [combosIncluded, setCombosIncluded] = useState([])
  const [combosAlmost,   setCombosAlmost]   = useState([])

  const [statsBracketOverride, setStatsBracketOverride] = useState(null)

  // ── Load deck data ──────────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      const { data: folder, error: ferr } = await sb.from('folders').select('*').eq('id', id).single()
      if (ferr || !folder) {
        setError(user ? 'Deck not found' : 'sign-in')
        setLoading(false)
        return
      }
      setDeck(folder)
      setDeckMeta(parseDeckMeta(folder.description))

      const { data: deckCards, error: dcErr } = await sb
        .from('deck_cards').select('*').eq('deck_id', id)
        .order('is_commander', { ascending: false })
      if (dcErr) console.error('[DeckView] deck_cards error:', dcErr)

      // Fallback: collection decks store cards in folder_cards
      if ((!deckCards || deckCards.length === 0) && folder.type === 'deck') {
        const { data: fc } = await sb.from('folder_cards').select('*, cards(*)').eq('folder_id', id)
        if (fc?.length) {
          setCards(fc.map(r => ({
            id:           r.id,
            deck_id:      id,
            name:         r.cards?.name || '',
            qty:          r.qty || 1,
            foil:         r.cards?.foil || false,
            is_commander: false,
            type_line:    null,
            image_uri:    null,
          })))
          setLoading(false)
          return
        }
      }

      setCards(deckCards || [])
      setLoading(false)
    })()
  }, [id, user])

  // ── Fetch combos once cards load ────────────────────────────────────────────
  async function fetchCombos() {
    if (combosLoading) return
    setCombosLoading(true)
    try {
      const commander = cards.find(c => c.is_commander)
      const body = {
        commanders: commander ? [{ card: commander.name }] : [],
        main: cards.filter(c => !c.is_commander).map(c => ({ card: c.name })),
      }
      const res = await fetch('/api/combos/find-my-combos/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`API ${res.status}`)
      const data = await res.json()
      const r = data.results || {}
      setCombosIncluded(r.included || [])
      setCombosAlmost([...(r.almostIncluded || []), ...(r.almostIncludedByAddingColors || [])])
      setCombosFetched(true)
    } catch (e) {
      console.warn('[DeckView Combos]', e)
    }
    setCombosLoading(false)
  }

  useEffect(() => {
    if (cards.length > 0 && !combosFetched && !combosLoading) fetchCombos()
  }, [cards]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Copy deck to own builder ────────────────────────────────────────────────
  async function copyDeck() {
    if (!user || copying) return
    setCopying(true)
    try {
      const newMeta = serializeDeckMeta({ ...deckMeta, copiedFrom: id })
      const { data: newFolder, error: folderErr } = await sb
        .from('folders')
        .insert({ name: deck.name, type: 'builder_deck', user_id: user.id, description: newMeta })
        .select()
        .single()
      if (folderErr) throw folderErr

      if (cards.length > 0) {
        const rows = cards.map(c => ({
          deck_id:          newFolder.id,
          name:             c.name,
          qty:              c.qty,
          foil:             c.foil || false,
          is_commander:     c.is_commander || false,
          type_line:        c.type_line || null,
          image_uri:        c.image_uri || null,
          set_code:         c.set_code || null,
          collector_number: c.collector_number || null,
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
  const format     = FORMATS.find(f => f.id === deckMeta.format)
  const grouped    = groupDeckCards(cards)
  const totalCards = cards.reduce((s, c) => s + c.qty, 0)

  // Best available card image
  const cardImg = (c) =>
    c.image_uri ||
    `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(c.name)}&format=image&version=normal`

  // ── Loading / error states ─────────────────────────────────────────────────
  if (loading) return (
    <div className={styles.signinPage}>
      <div className={styles.signinLogo}>ARCANE<span>VAULT</span></div>
      <div className={styles.signinMsg} style={{ fontStyle: 'italic' }}>Loading deck…</div>
    </div>
  )

  if (error === 'sign-in') return (
    <div className={styles.signinPage}>
      <div className={styles.signinLogo}>ARCANE<span>VAULT</span></div>
      <div className={styles.signinMsg}>Sign in to view this deck.</div>
      <Link to="/login" className={styles.signinLink}>Sign In to ArcaneVault</Link>
    </div>
  )

  if (error) return (
    <div className={styles.signinPage}>
      <div className={styles.signinMsg}>{error}</div>
      <Link to="/" className={styles.signinLink}>Go to ArcaneVault</Link>
    </div>
  )

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>

      {/* Card detail modal */}
      {detailCard && <CardDetailModal cardName={detailCard} onClose={() => setDetailCard(null)} />}

      {/* ── Top bar ── */}
      <div className={styles.topBar}>
        <Link to="/" className={styles.logo}>ARCANE<span>VAULT</span></Link>

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
              <button
                onClick={copyDeck}
                disabled={copying || copyDone}
                className={`${styles.actionBtn}${copyDone ? ' ' + styles.actionBtnDone : ''}`}
              >
                {copyDone ? '✓ Added to My Decks' : copying ? 'Copying…' : '＋ Add to My Decks'}
              </button>
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
          {deckMeta.commanderName && (
            <>
              <span className={styles.metaDot}>·</span>
              <span className={styles.commanderBadge}>⚔ {deckMeta.commanderName}</span>
            </>
          )}
        </div>
      </div>

      {/* ── Body: deck list (dominant) + right sidebar ── */}
      <div className={styles.body}>

        {/* ── Left: deck list — the star of the page ── */}
        <div className={styles.deckListPanel}>

          {/* Header: label + view toggle */}
          <div className={styles.listHeader}>
            <span className={styles.listLabel}>Decklist · {totalCards}</span>
            <div className={styles.viewToggles}>
              <button
                className={`${styles.vBtn}${deckView === 'list' ? ' ' + styles.vBtnActive : ''}`}
                title="List view"
                onClick={() => setDeckView('list')}
              >☰</button>
              <button
                className={`${styles.vBtn}${deckView === 'grid' ? ' ' + styles.vBtnActive : ''}`}
                title="Grid view"
                onClick={() => setDeckView('grid')}
              >⊞</button>
            </div>
          </div>

          {/* ── List view — 2 typographic columns on wide screens ── */}
          {deckView === 'list' && (
            <div className={wide ? styles.listTwoCol : undefined}>
              {TYPE_GROUPS.map(group => {
                const groupCards = grouped.get(group)
                if (!groupCards?.length) return null
                const groupQty = groupCards.reduce((s, c) => s + c.qty, 0)
                return (
                  <div key={group} className={styles.cardGroup}>
                    <div className={styles.groupHeader}>
                      <span>{group}</span>
                      <span className={styles.groupCount}>{groupQty}</span>
                    </div>
                    {groupCards.map(c => (
                      <div
                        key={c.id}
                        className={styles.cardRow}
                        onClick={() => setDetailCard(c.name)}
                        onMouseEnter={e => { setHoverImg(cardImg(c)); setHoverPos({ x: e.clientX, y: e.clientY }) }}
                        onMouseMove={e => setHoverPos({ x: e.clientX, y: e.clientY })}
                        onMouseLeave={() => setHoverImg(null)}
                      >
                        {c.image_uri
                          ? <img src={c.image_uri} alt="" className={styles.cardThumb} loading="lazy" />
                          : <div className={styles.cardThumbPh} />
                        }
                        <span className={styles.cardName}>{c.name}</span>
                        {c.is_commander && <span className={styles.cmdIcon}>⚔</span>}
                        {c.foil         && <span className={styles.foilIcon}>✦</span>}
                        <span className={styles.cardQty}>×{c.qty}</span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}

          {/* ── Grid view ── */}
          {deckView === 'grid' && (
            <div className={styles.cardGrid}>
              {cards.map(c => (
                <div
                  key={c.id}
                  className={styles.gridCard}
                  onClick={() => setDetailCard(c.name)}
                  onMouseEnter={e => { setHoverImg(cardImg(c)); setHoverPos({ x: e.clientX, y: e.clientY }) }}
                  onMouseMove={e => setHoverPos({ x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setHoverImg(null)}
                  title={c.name}
                >
                  <img src={cardImg(c)} alt={c.name} loading="lazy" />
                  {c.qty > 1 && <div className={styles.gridQtyBadge}>×{c.qty}</div>}
                  {c.is_commander && <div className={styles.gridCmdBadge}>⚔</div>}
                </div>
              ))}
            </div>
          )}

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

        {/* ── Right sidebar: stats + combos stacked ── */}
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
          <CombosPanel
            loading={combosLoading}
            fetched={combosFetched}
            included={combosIncluded}
            almost={combosAlmost}
          />
        </div>
      </div>
    </div>
  )
}

// ── Combos panel ──────────────────────────────────────────────────────────────
function CombosPanel({ loading, fetched, included, almost }) {
  return (
    <div className={styles.combosPanel}>
      <div className={styles.sectionLabel}>Combos</div>

      {loading && <div className={styles.combosLoading}>Finding combos…</div>}

      {fetched && included.length === 0 && almost.length === 0 && (
        <div className={styles.combosEmpty}>No combos found for this deck.</div>
      )}

      {fetched && included.length > 0 && (
        <div>
          <div className={styles.comboSubLabel}>
            Combos in Deck
            <span className={styles.comboCount}>{included.length}</span>
          </div>
          {included.map((combo, i) => <ComboCard key={i} combo={combo} />)}
        </div>
      )}

      {fetched && almost.length > 0 && (
        <div>
          <div className={`${styles.comboSubLabel} ${styles.comboSubLabelDim}`}>
            Almost Included
            <span className={`${styles.comboCount} ${styles.comboCountDim}`}>{almost.length}</span>
          </div>
          {almost.slice(0, 15).map((combo, i) => <ComboCard key={i} combo={combo} dim />)}
        </div>
      )}
    </div>
  )
}

// ── Single combo card ─────────────────────────────────────────────────────────
function ComboCard({ combo, dim }) {
  const uses    = (combo.uses    || []).map(u => u.card?.name || u.template?.name || '').filter(Boolean)
  const results = (combo.produces || []).map(p => p.feature?.name || '').filter(Boolean)
  return (
    <div className={`${styles.comboCard}${dim ? ' ' + styles.comboCardDim : ''}`}>
      <div className={styles.comboPieces}>
        {uses.map((name, i) => (
          <span key={i} className={styles.comboPiece}>{name}</span>
        ))}
      </div>
      {results.length > 0 && (
        <div className={styles.comboResults}>
          {results.map((r, i) => (
            <span key={i} className={styles.comboResult}>{r}</span>
          ))}
        </div>
      )}
    </div>
  )
}
