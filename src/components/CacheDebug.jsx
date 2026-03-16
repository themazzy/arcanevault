import { useState, useEffect } from 'react'
import { getDbStats, clearScryfallStore } from '../lib/db'
import { clearScryfallCache, clearAllScryfallCache } from '../lib/scryfall'
import styles from './CacheDebug.module.css'

function Row({ label, value, ok, warn }) {
  const color = ok === true ? '#6db96d' : ok === false ? '#e05252' : warn ? '#e0a852' : '#aaa'
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: '0.82rem' }}>
      <span style={{ color: '#888' }}>{label}</span>
      <span style={{ color, fontFamily: 'monospace', maxWidth: '65%', textAlign: 'right', wordBreak: 'break-all' }}>{String(value)}</span>
    </div>
  )
}

export default function CacheDebug() {
  const [open, setOpen]   = useState(false)
  const [stats, setStats] = useState(null)
  const [msg, setMsg]     = useState('')

  const refresh = async () => {
    const s = await getDbStats()
    setStats(s)
  }

  useEffect(() => { if (open) refresh() }, [open])

  const handleClearPrices = async () => {
    await clearScryfallCache()
    setMsg('✓ Prices cleared — images kept')
    await refresh()
    setTimeout(() => setMsg(''), 3000)
  }

  const handleClearAll = async () => {
    await clearAllScryfallCache()
    setMsg('✓ All Scryfall data cleared')
    await refresh()
    setTimeout(() => setMsg(''), 3000)
  }

  const ageLabel = stats?.sfUpdatedAt
    ? `${(( Date.now() - stats.sfUpdatedAt) / 3600000).toFixed(1)}h ago`
    : 'Never fetched'

  return (
    <div className={styles.wrap}>
      <button className={styles.toggle} onClick={() => setOpen(v => !v)}>
        {open ? '▲' : '▼'} Cache Diagnostics (IndexedDB)
      </button>

      {open && (
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <span>IndexedDB — no size limit</span>
            <button className={styles.refreshBtn} onClick={refresh}>↻ Refresh</button>
          </div>

          {stats && (
            <>
              <div className={styles.group}>
                <div className={styles.groupTitle}>Stores</div>
                <Row label="Cards (owned)"  value={stats.cards}       ok={stats.cards > 0} />
                <Row label="Folders"        value={stats.folders} />
                <Row label="Folder links"   value={stats.folderCards} />
                <Row label="Scryfall cache" value={stats.scryfall}    ok={stats.scryfall > 0} />
                <Row label="Prices last fetched" value={ageLabel} />
              </div>

              <div className={styles.group}>
                <div className={styles.groupTitle}>Actions</div>
                <div style={{ display: 'flex', gap: 8, paddingTop: 4, flexWrap: 'wrap' }}>
                  <button className={styles.refreshBtn} onClick={handleClearPrices}>
                    Clear prices (keep images)
                  </button>
                  <button className={styles.refreshBtn} onClick={handleClearAll}
                    style={{ color: '#e05252', borderColor: 'rgba(224,82,82,0.3)' }}>
                    Clear all Scryfall data
                  </button>
                </div>
                {msg && <div style={{ fontSize: '0.78rem', color: '#6db96d', marginTop: 6, fontFamily: 'monospace' }}>{msg}</div>}
              </div>

              {stats.scryfall === 0 && (
                <div className={styles.errors}>
                  <div className={styles.groupTitle} style={{ color: '#e05252' }}>⚠ Issues</div>
                  <div className={styles.error}>Scryfall cache is empty — prices will be fetched on next visit</div>
                </div>
              )}
              {stats.scryfall > 0 && stats.cards > 0 && (
                <div className={styles.ok}>✓ Cache healthy — {stats.scryfall} cards cached in IndexedDB</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
