import { useState } from 'react'
import { Link } from 'react-router-dom'
import styles from './DeckWinrateMini.module.css'

// Win-rate widget shown in the deck stats tab. Pure component, no IO.

export default function DeckWinrateMini({ results, loading, deckName: _deckName }) {
  const [isOpen, setIsOpen] = useState(true)
  const games  = results.length
  const wins   = results.filter(r => Number(r.placement) === 1).length
  const losses = games - wins
  const rate   = games > 0 ? Math.round((wins / games) * 100) : null

  const recentFive = results.slice(0, 5)
  const metric = loading ? 'Loading…' : games ? `${rate}% · ${games} games` : 'No games'

  return (
    <details className={styles.tile} open={isOpen} onToggle={event => setIsOpen(event.currentTarget.open)}>
      <summary className={styles.summary}>
        <span className={styles.title}>Win Rate</span>
        <span className={styles.metric}>{metric}</span>
      </summary>
      <div className={styles.body}>
        {loading ? (
          <div className={styles.loading}>Loading…</div>
        ) : !games ? (
          <div className={styles.emptyState}>
            <div>
              <div className={styles.emptyTitle}>No games tracked yet</div>
              <div className={styles.emptyCopy}>Play with this deck in Life Tracker and its results will appear here.</div>
            </div>
            <Link to="/life" className={styles.lifeLink} aria-label="Open Life Tracker to log a game">
              Open Life Tracker
            </Link>
          </div>
        ) : (
          <>
            <div className={styles.summaryGrid}>
              <div className={`${styles.summaryCard} ${styles.summaryCardAccent}`}>
                <div className={styles.rateValue}>{rate}%</div>
                <div className={styles.cardLabel}>Win Rate</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.gamesValue}>{games}</div>
                <div className={styles.cardLabel}>Games</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.recordValue}>
                  <span className={styles.wins}>{wins}W</span>
                  <span className={styles.recordDot}>&middot;</span>
                  <span className={styles.losses}>{losses}L</span>
                </div>
                <div className={styles.cardLabel}>Record</div>
              </div>
            </div>
            <div className={styles.rateTrack}>
              <div className={styles.rateFill} style={{ width: `${rate}%` }} />
            </div>
            {recentFive.length > 0 && <div className={styles.recentLabel}>Recent games</div>}
            <div className={styles.recentGames}>
              {recentFive.map(result => {
                const place = Number(result.placement) || 1
                const isWin = place === 1
                return (
                  <div
                    key={result.id}
                    className={`${styles.recentResult} ${isWin ? styles.recentWin : ''}`}
                    title={`#${place} · ${result.played_at ? new Date(result.played_at).toLocaleDateString() : ''}`}
                  >
                    {place === 1 ? '1st' : `#${place}`}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </details>
  )
}
