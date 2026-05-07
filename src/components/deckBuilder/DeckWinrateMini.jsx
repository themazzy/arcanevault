// Win-rate widget shown in the deck stats tab. Pure component, no IO.

export default function DeckWinrateMini({ results, loading, deckName: _deckName }) {
  const games  = results.length
  const wins   = results.filter(r => Number(r.placement) === 1).length
  const losses = games - wins
  const rate   = games > 0 ? Math.round((wins / games) * 100) : null

  const sectionLabel = {
    fontFamily: 'var(--font-display)', fontSize: '0.65rem', letterSpacing: '0.12em',
    color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 10,
  }

  if (loading) return (
    <div>
      <div style={sectionLabel}>Win Rate</div>
      <div style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>Loading...</div>
    </div>
  )

  if (!games) return (
    <div>
      <div style={sectionLabel}>Win Rate</div>
      <div style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>
        No games tracked yet. Log a game in Life Tracker to see stats here.
      </div>
    </div>
  )

  const recentFive = results.slice(0, 5)

  return (
    <div>
      <div style={sectionLabel}>Win Rate</div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, background: 'var(--s2)', borderRadius: 6, padding: '10px 12px', borderTop: '2px solid var(--gold)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--gold)', lineHeight: 1 }}>{rate}%</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-faint)', marginTop: 3 }}>Win Rate</div>
        </div>
        <div style={{ flex: 1, background: 'var(--s2)', borderRadius: 6, padding: '10px 12px', borderTop: '2px solid var(--s-border2)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text)', lineHeight: 1 }}>{games}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-faint)', marginTop: 3 }}>Games</div>
        </div>
        <div style={{ flex: 1, background: 'var(--s2)', borderRadius: 6, padding: '10px 12px', borderTop: '2px solid var(--s-border2)' }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, lineHeight: 1 }}>
            <span style={{ color: 'var(--green)' }}>{wins}W</span>
            <span style={{ color: 'var(--text-faint)', fontSize: '0.8rem', margin: '0 3px' }}>&middot;</span>
            <span style={{ color: '#e07070' }}>{losses}L</span>
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-faint)', marginTop: 3 }}>Record</div>
        </div>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--s-border2)', overflow: 'hidden', marginBottom: 10 }}>
        <div style={{ height: '100%', width: `${rate}%`, background: 'var(--gold)', borderRadius: 3, transition: 'width 0.4s' }} />
      </div>
      {recentFive.length > 0 && (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)', marginBottom: 4 }}>Recent games</div>
      )}
      <div style={{ display: 'flex', gap: 4 }}>
        {recentFive.map(r => {
          const place = Number(r.placement) || 1
          const isWin = place === 1
          return (
            <div key={r.id} title={`#${place} · ${r.played_at ? new Date(r.played_at).toLocaleDateString() : ''}`}
              style={{
                width: 22, height: 22, borderRadius: 4, fontSize: '0.62rem', fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: isWin ? 'rgba(201,168,76,0.18)' : 'var(--s3)',
                color: isWin ? 'var(--gold)' : 'var(--text-faint)',
                border: `1px solid ${isWin ? 'rgba(201,168,76,0.35)' : 'transparent'}`,
              }}
            >
              {place === 1 ? '1st' : `#${place}`}
            </div>
          )
        })}
      </div>
    </div>
  )
}
