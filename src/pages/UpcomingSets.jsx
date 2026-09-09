import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PublicPageFooter from '../components/PublicPageFooter'
import { EmptyState, ErrorBox } from '../components/UI'
import { ChevronRightIcon } from '../icons'
import {
  fetchUpcomingSets,
  groupSetsByParent,
  setTypeLabel,
  formatReleaseDate,
  daysUntil,
  countdownLabel,
  todayIso,
} from '../lib/upcomingSets'
import styles from './UpcomingSets.module.css'

// Public release calendar at /sets. Every set here links to its own spoiler
// page rather than out to Scryfall — see SetSpoiler.jsx.

function SetSymbol({ set, size = 'md' }) {
  if (!set.icon_svg_uri) return <span className={`${styles.symbol} ${styles[size]}`} aria-hidden="true" />
  return (
    <img
      className={`${styles.symbol} ${styles[size]}`}
      src={set.icon_svg_uri}
      alt=""
      loading="lazy"
      aria-hidden="true"
    />
  )
}

function CardCount({ set }) {
  // `card_count` is how many printings Scryfall currently holds for the set,
  // which for an unreleased set is exactly what has been revealed so far. The
  // spoiler page counts distinct cards instead, so both numbers are labelled
  // for what they are rather than presented as one figure.
  if (!set.card_count) return <span className={styles.metaQuiet}>Nothing revealed yet</span>
  return <span>{set.card_count} printing{set.card_count === 1 ? '' : 's'} revealed</span>
}

function SetRow({ set, today, nested = false }) {
  const days = daysUntil(set.released_at, today)
  return (
    <Link
      to={`/sets/${set.code}`}
      className={nested ? styles.childRow : styles.setRow}
      aria-label={`${set.name} — ${formatReleaseDate(set.released_at)}`}
    >
      <SetSymbol set={set} size={nested ? 'sm' : 'md'} />
      <span className={styles.setCopy}>
        <span className={styles.setName}>{set.name}</span>
        <span className={styles.setMeta}>
          <span>{setTypeLabel(set.set_type)}</span>
          <CardCount set={set} />
        </span>
      </span>
      <span className={styles.setDates}>
        <span className={styles.setDate}>{formatReleaseDate(set.released_at)}</span>
        {!nested && <span className={styles.countdown}>{countdownLabel(days)}</span>}
      </span>
      <ChevronRightIcon size={12} />
    </Link>
  )
}

function SetSkeleton() {
  return (
    <div className={styles.list}>
      {Array.from({ length: 5 }).map((_, i) => <div key={i} className={styles.rowSkeleton} />)}
    </div>
  )
}

export default function UpcomingSetsPage() {
  const [sets, setSets] = useState(null)
  const [error, setError] = useState('')
  const today = todayIso()

  useEffect(() => {
    document.title = 'Upcoming Magic Sets — DeckLoom'
    let cancelled = false
    fetchUpcomingSets(today)
      .then(list => { if (!cancelled) setSets(list) })
      .catch(() => { if (!cancelled) { setSets([]); setError('Could not load the release calendar. Try again shortly.') } })
    return () => { cancelled = true }
  }, [today])

  const grouped = sets ? groupSetsByParent(sets) : []
  const total = sets?.length || 0

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Release calendar</div>
          <h1 className={styles.title}>Upcoming Sets</h1>
          <p className={styles.subtitle}>
            Every announced Magic set, with the cards spoiled so far.
          </p>
        </div>
        {sets && total > 0 && (
          <span className={styles.count}>{total} announced</span>
        )}
      </header>

      {error && <ErrorBox>{error}</ErrorBox>}

      {!sets ? <SetSkeleton /> : grouped.length === 0 ? (
        <EmptyState>No sets have been announced yet. Check back after the next preview season.</EmptyState>
      ) : (
        <div className={styles.list}>
          {grouped.map(set => (
            <article key={set.code} className={styles.setCard}>
              <SetRow set={set} today={today} />
              {set.children.length > 0 && (
                <div className={styles.children}>
                  {set.children.map(child => (
                    <SetRow key={child.code} set={child} today={today} nested />
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      <p className={styles.sourceNote}>
        Set and card data from <a href="https://scryfall.com" target="_blank" rel="noopener noreferrer">Scryfall</a>,
        refreshed as previews are revealed.
      </p>

      <PublicPageFooter />
    </div>
  )
}
