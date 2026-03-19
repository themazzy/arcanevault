import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { parseDeckMeta, FORMATS, groupDeckCards, TYPE_GROUPS, getCardImageUri } from '../lib/deckBuilderApi'

export default function DeckViewPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const [deck, setDeck] = useState(null)
  const [deckMeta, setDeckMeta] = useState({})
  const [cards, setCards] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    ;(async () => {
      const { data: folder, error: ferr } = await sb.from('folders').select('*').eq('id', id).single()
      if (ferr || !folder) { setError('Deck not found'); setLoading(false); return }
      setDeck(folder)
      setDeckMeta(parseDeckMeta(folder.description))

      const { data: deckCards } = await sb.from('deck_cards').select('*').eq('deck_id', id).order('is_commander', { ascending: false })
      setCards(deckCards || [])
      setLoading(false)
    })()
  }, [id])

  const isOwner = user && deck?.user_id === user.id
  const format = FORMATS.find(f => f.id === deckMeta.format)
  const grouped = groupDeckCards(cards)
  const totalCards = cards.reduce((s, c) => s + c.qty, 0)

  if (loading) return (
    <div style={{ minHeight:'100vh', background:'var(--bg,#0a0814)', display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-dim,#9a8870)', fontFamily:'var(--font-display)' }}>
      Loading deck…
    </div>
  )

  if (error) return (
    <div style={{ minHeight:'100vh', background:'var(--bg,#0a0814)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, color:'var(--text-dim,#9a8870)' }}>
      <div>{error}</div>
      <Link to="/" style={{ color:'var(--gold,#c9a84c)', fontSize:'0.9rem' }}>Go to ArcaneVault</Link>
    </div>
  )

  return (
    <div style={{ minHeight:'100vh', background:'var(--bg,#0a0814)', color:'var(--text,#e8e0d0)', fontFamily:'var(--font-serif,serif)' }}>
      {/* Top bar */}
      <div style={{ background:'rgba(255,255,255,0.03)', borderBottom:'1px solid rgba(255,255,255,0.08)', padding:'12px 24px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
        <Link to="/" style={{ fontFamily:'var(--font-display)', color:'var(--gold,#c9a84c)', fontSize:'1.1rem', textDecoration:'none', letterSpacing:'0.1em' }}>
          ARCANE<span style={{ color:'var(--text,#e8e0d0)' }}>VAULT</span>
        </Link>
        {!user ? (
          <div style={{ display:'flex', gap:8 }}>
            <Link to="/login" style={{ background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.12)', borderRadius:4, padding:'6px 14px', color:'var(--text-dim,#9a8870)', fontSize:'0.83rem', textDecoration:'none' }}>
              Sign In
            </Link>
            <Link to="/login" style={{ background:'rgba(201,168,76,0.15)', border:'1px solid rgba(201,168,76,0.4)', borderRadius:4, padding:'6px 14px', color:'var(--gold,#c9a84c)', fontSize:'0.83rem', textDecoration:'none' }}>
              Create Account
            </Link>
          </div>
        ) : isOwner ? (
          <Link to={`/builder/${id}`} style={{ background:'rgba(201,168,76,0.12)', border:'1px solid rgba(201,168,76,0.3)', borderRadius:4, padding:'6px 14px', color:'var(--gold,#c9a84c)', fontSize:'0.83rem', textDecoration:'none' }}>
            ⚔ Edit in Builder
          </Link>
        ) : (
          <Link to="/" style={{ color:'var(--text-dim,#9a8870)', fontSize:'0.83rem', textDecoration:'none' }}>← My Collection</Link>
        )}
      </div>

      {/* Deck header */}
      <div style={{ padding:'24px 24px 0', maxWidth:800, margin:'0 auto' }}>
        <div style={{ fontFamily:'var(--font-display)', fontSize:'1.6rem', color:'var(--gold,#c9a84c)', letterSpacing:'0.04em', marginBottom:6 }}>
          {deck.name}
        </div>
        <div style={{ display:'flex', gap:12, alignItems:'center', fontSize:'0.83rem', color:'var(--text-dim,#9a8870)', marginBottom:24 }}>
          {format && <span>{format.label}</span>}
          <span>·</span>
          <span>{totalCards} cards</span>
          {deckMeta.commanderName && <><span>·</span><span>⚔ {deckMeta.commanderName}</span></>}
        </div>

        {/* Card list grouped by type */}
        {TYPE_GROUPS.map(group => {
          const groupCards = grouped.get(group)
          if (!groupCards?.length) return null
          const groupQty = groupCards.reduce((s, c) => s + c.qty, 0)
          return (
            <div key={group} style={{ marginBottom:20 }}>
              <div style={{ fontFamily:'var(--font-display)', fontSize:'0.75rem', letterSpacing:'0.08em', color:'var(--text-faint,#6a6058)', textTransform:'uppercase', marginBottom:6, display:'flex', justifyContent:'space-between' }}>
                <span>{group}</span>
                <span>{groupQty}</span>
              </div>
              {groupCards.map(c => (
                <div key={c.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 0', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
                  {c.image_uri && (
                    <img src={c.image_uri} alt="" style={{ width:28, height:39, objectFit:'cover', borderRadius:3, flexShrink:0 }} loading="lazy" />
                  )}
                  <span style={{ flex:1, fontSize:'0.85rem' }}>{c.name}</span>
                  {c.foil && <span style={{ fontSize:'0.65rem', color:'#c8a0ff' }}>✦</span>}
                  <span style={{ fontSize:'0.82rem', color:'var(--text-dim,#9a8870)' }}>×{c.qty}</span>
                </div>
              ))}
            </div>
          )
        })}

        {cards.length === 0 && (
          <div style={{ color:'var(--text-faint,#6a6058)', fontSize:'0.85rem', padding:'40px 0', textAlign:'center' }}>
            This deck has no cards yet.
          </div>
        )}
      </div>
    </div>
  )
}
