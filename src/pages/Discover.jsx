import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { listPublicDecks } from '../lib/community'
import { FORMATS } from '../lib/deckBuilderApi'
import styles from './Discover.module.css'

const PAGE = 24

export default function Discover() {
  const [sort, setSort]     = useState('popular')   // 'popular' | 'recent'
  const [format, setFormat] = useState('')          // '' = all
  const [decks, setDecks]   = useState(null)         // null = loading
  const [loadingMore, setLoadingMore] = useState(false)
  const [done, setDone]     = useState(false)
  const reqId = useRef(0)

  const fetchPage = useCallback(async (offset) => {
    const id = ++reqId.current
    try {
      const rows = await listPublicDecks({ sort, format: format || null, limit: PAGE, offset })
      if (id !== reqId.current) return null
      return rows
    } catch {
      if (id !== reqId.current) return null
      return []
    }
  }, [sort, format])

  // Reload from scratch on sort/format change.
  useEffect(() => {
    let alive = true
    setDecks(null); setDone(false)
    fetchPage(0).then(rows => {
      if (!alive || rows === null) return
      setDecks(rows)
      setDone(rows.length < PAGE)
    })
    return () => { alive = false }
  }, [fetchPage])

  const loadMore = async () => {
    if (loadingMore || done || !decks) return
    setLoadingMore(true)
    const rows = await fetchPage(decks.length)
    if (rows) {
      setDecks(prev => [...(prev || []), ...rows])
      if (rows.length < PAGE) setDone(true)
    }
    setLoadingMore(false)
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Discover</h1>
        <p className={styles.sub}>Browse public decks from the community.</p>
      </div>

      <div className={styles.controls}>
        <div className={styles.sortToggle}>
          <button className={`${styles.sortBtn} ${sort === 'popular' ? styles.sortActive : ''}`} onClick={() => setSort('popular')}>Popular</button>
          <button className={`${styles.sortBtn} ${sort === 'recent' ? styles.sortActive : ''}`} onClick={() => setSort('recent')}>Recent</button>
        </div>
        <select className={styles.formatSelect} value={format} onChange={e => setFormat(e.target.value)} aria-label="Filter by format">
          <option value="">All formats</option>
          {FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>

      {decks === null ? (
        <div className={styles.grid}>
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className={styles.skeleton} />)}
        </div>
      ) : decks.length === 0 ? (
        <div className={styles.empty}>No public decks{format ? ' for this format' : ''} yet.</div>
      ) : (
        <>
          <div className={styles.grid}>
            {decks.map(d => (
              <Link key={d.deck_id} to={`/d/${d.deck_id}`} className={styles.card}>
                <div className={styles.art} style={d.art ? { backgroundImage: `url(${d.art})` } : undefined}>
                  <div className={styles.artScrim} />
                  <div className={styles.cardStats}>
                    <span className={styles.stat} title="Likes">♥ {d.like_count}</span>
                    <span className={styles.stat} title="Comments">💬 {d.comment_count}</span>
                  </div>
                </div>
                <div className={styles.cardBody}>
                  <div className={styles.cardName}>{d.name}</div>
                  {d.commander && <div className={styles.cardCommander}>{d.commander}</div>}
                  <div className={styles.cardMeta}>
                    {d.format && <span className={styles.cardFormat}>{FORMATS.find(f => f.id === d.format)?.label || d.format}</span>}
                    <span className={styles.cardCount}>{d.total_cards} cards</span>
                  </div>
                  {d.username && <div className={styles.cardAuthor}>by {d.username}</div>}
                </div>
              </Link>
            ))}
          </div>
          {!done && (
            <div className={styles.loadMoreRow}>
              <button className={styles.loadMoreBtn} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
