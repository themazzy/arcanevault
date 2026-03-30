// src/scanner/CardScanner.jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'
import { CameraPreview } from '@capacitor-community/camera-preview'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { databaseService } from './DatabaseService'
import {
  isOpenCVReady,
  waitForOpenCV,
  detectCardCorners,
  warpCard,
  cropArtRegion,
  computePHash256,
} from './ScannerEngine'
import styles from './CardScanner.module.css'

const SCAN_INTERVAL_MS = 250   // ~4 FPS
const MATCH_THRESHOLD  = 20    // max Hamming distance (out of 256)
const STABILITY_FRAMES = 2     // require N consecutive same-ID matches

export default function CardScanner({ onMatch, onClose }) {
  const isNative = Capacitor.isNativePlatform()

  const videoRef     = useRef(null)
  const canvasRef    = useRef(null)
  const loopRef      = useRef(null)
  const stabilityRef = useRef({ id: null, count: 0 })

  // status: initializing | needs-sync | ready | scanning | matched | error
  const [status,      setStatus]      = useState('initializing')
  const [cvReady,     setCvReady]     = useState(false)
  const [dbReady,     setDbReady]     = useState(false)
  const [cardCount,   setCardCount]   = useState(0)
  const [syncing,     setSyncing]     = useState(false)
  const [syncCount,   setSyncCount]   = useState(0)
  const [matchedCard, setMatchedCard] = useState(null)
  const [error,       setError]       = useState(null)

  // ── Init OpenCV + DB ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await databaseService.init()
        if (!cancelled) {
          setDbReady(true)
          setCardCount(databaseService.cardCount)
        }

        await waitForOpenCV()
        if (!cancelled) setCvReady(true)

        if (!cancelled) {
          setStatus(databaseService.cardCount > 0 ? 'ready' : 'needs-sync')
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message)
          setStatus('error')
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  // ── Camera setup ──────────────────────────────────────────────────────────
  // Only start/stop camera when transitioning into or out of a scan-capable state.
  const cameraActive = status === 'ready' || status === 'scanning'

  useEffect(() => {
    if (!cameraActive) return
    let active = true

    const startCamera = async () => {
      try {
        if (isNative) {
          await CameraPreview.start({
            position: 'rear',
            toBack:   true,
            width:    window.innerWidth,
            height:   window.innerHeight,
          })
        } else {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: 1280, height: 720 },
          })
          if (videoRef.current && active) {
            videoRef.current.srcObject = stream
            await videoRef.current.play()
          }
        }
      } catch (e) {
        if (active) {
          setError('Camera access denied: ' + e.message)
          setStatus('error')
        }
      }
    }

    startCamera()

    return () => {
      active = false
      if (isNative) {
        CameraPreview.stop().catch(() => {})
      } else {
        if (videoRef.current?.srcObject) {
          videoRef.current.srcObject.getTracks().forEach(t => t.stop())
        }
      }
    }
  }, [cameraActive, isNative])

  // ── Scanning loop ─────────────────────────────────────────────────────────
  const processFrame = useCallback(async () => {
    if (!cvReady || !dbReady) return

    try {
      let imageData, w, h

      if (isNative) {
        const { value } = await CameraPreview.capture({ quality: 75 })
        const img = await new Promise((res, rej) => {
          const i  = new Image()
          i.onload  = () => res(i)
          i.onerror = rej
          i.src     = 'data:image/jpeg;base64,' + value
        })
        const c = document.createElement('canvas')
        c.width  = img.width
        c.height = img.height
        c.getContext('2d').drawImage(img, 0, 0)
        imageData = c.getContext('2d').getImageData(0, 0, img.width, img.height)
        w = img.width
        h = img.height
      } else {
        if (!videoRef.current?.videoWidth) return
        const c = canvasRef.current
        c.width  = videoRef.current.videoWidth
        c.height = videoRef.current.videoHeight
        c.getContext('2d').drawImage(videoRef.current, 0, 0)
        w = c.width
        h = c.height
        imageData = c.getContext('2d').getImageData(0, 0, w, h)
      }

      const corners = detectCardCorners(imageData, w, h)
      if (!corners) {
        stabilityRef.current = { id: null, count: 0 }
        return
      }

      const warped = warpCard(imageData, corners)
      if (!warped) return

      const artCrop = cropArtRegion(warped)
      if (!artCrop) return

      const hash = computePHash256(artCrop)
      if (!hash) return

      const match = databaseService.findMatch(hash, MATCH_THRESHOLD)
      if (!match) {
        stabilityRef.current = { id: null, count: 0 }
        return
      }

      // Stability buffer — require N consecutive frames with the same match
      const stab = stabilityRef.current
      if (stab.id === match.id) {
        stab.count++
        if (stab.count >= STABILITY_FRAMES) {
          // Confirmed match — stop scanning
          clearInterval(loopRef.current)
          setMatchedCard(match)
          setStatus('matched')
          try { await Haptics.impact({ style: ImpactStyle.Medium }) } catch {}
          onMatch?.(match)
        }
      } else {
        stabilityRef.current = { id: match.id, count: 1 }
      }
    } catch (e) {
      console.warn('[Scanner] frame error:', e)
    }
  }, [cvReady, dbReady, isNative, onMatch])

  useEffect(() => {
    if (status !== 'scanning') {
      clearInterval(loopRef.current)
      return
    }
    loopRef.current = setInterval(processFrame, SCAN_INTERVAL_MS)
    return () => clearInterval(loopRef.current)
  }, [status, processFrame])

  // Clean up interval on unmount
  useEffect(() => {
    return () => clearInterval(loopRef.current)
  }, [])

  // ── Sync handler ──────────────────────────────────────────────────────────
  const handleSync = async () => {
    setSyncing(true)
    setSyncCount(0)
    try {
      await databaseService.sync(n => setSyncCount(n))
      setCardCount(databaseService.cardCount)
      setStatus('ready')
    } catch (e) {
      setError('Sync failed: ' + e.message)
      setStatus('error')
    }
    setSyncing(false)
  }

  const handleScanAgain = () => {
    setMatchedCard(null)
    stabilityRef.current = { id: null, count: 0 }
    setStatus('scanning')
  }

  const handleStop = () => {
    stabilityRef.current = { id: null, count: 0 }
    setStatus('ready')
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.root}>
      {/* Web camera feed — hidden on native (CameraPreview renders behind WebView) */}
      {!isNative && (
        <>
          <video ref={videoRef} className={styles.video} playsInline muted />
          <canvas ref={canvasRef} className={styles.hiddenCanvas} />
        </>
      )}

      {/* Overlay UI */}
      <div className={`${styles.overlay} ${isNative ? styles.overlayNative : ''}`}>

        {/* Close button */}
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close scanner">
          ✕
        </button>

        {/* Status bar */}
        <div className={styles.statusBar}>
          {status === 'initializing' && (
            <span className={styles.statusText}>Initializing…</span>
          )}
          {status === 'needs-sync' && (
            <span className={`${styles.statusText} ${styles.warn}`}>
              No card database. Tap Sync to download.
            </span>
          )}
          {status === 'ready' && (
            <span className={styles.statusText}>
              {cardCount.toLocaleString()} cards loaded. Tap Scan to start.
            </span>
          )}
          {status === 'scanning' && (
            <span className={`${styles.statusText} ${styles.scanning}`}>
              Scanning… point at a card
            </span>
          )}
          {status === 'matched' && (
            <span className={`${styles.statusText} ${styles.matchStatus}`}>
              Card identified!
            </span>
          )}
          {status === 'error' && (
            <span className={`${styles.statusText} ${styles.err}`}>{error}</span>
          )}
        </div>

        {/* Targeting frame */}
        {(status === 'scanning' || status === 'ready') && (
          <div className={styles.targetFrame}>
            <div className={`${styles.corner} ${styles.cornerTL}`} />
            <div className={`${styles.corner} ${styles.cornerTR}`} />
            <div className={`${styles.corner} ${styles.cornerBR}`} />
            <div className={`${styles.corner} ${styles.cornerBL}`} />
            {status === 'scanning' && <div className={styles.scanLine} />}
          </div>
        )}

        {/* Action buttons */}
        <div className={styles.actions}>
          {status === 'needs-sync' && (
            <button
              className={styles.syncBtn}
              onClick={handleSync}
              disabled={syncing}
            >
              {syncing
                ? `Syncing… ${syncCount.toLocaleString()}`
                : '⬇ Sync Card Database'}
            </button>
          )}

          {status === 'ready' && (
            <>
              <button className={styles.scanBtn} onClick={() => setStatus('scanning')}>
                ⊙ Start Scanning
              </button>
              <button
                className={styles.syncBtn}
                onClick={handleSync}
                disabled={syncing}
              >
                {syncing
                  ? `Syncing… ${syncCount.toLocaleString()}`
                  : '⟳ Re-sync'}
              </button>
            </>
          )}

          {status === 'scanning' && (
            <button className={styles.stopBtn} onClick={handleStop}>
              ◼ Stop
            </button>
          )}
        </div>

        {/* Match result panel */}
        {status === 'matched' && matchedCard && (
          <div className={styles.matchPanel}>
            {matchedCard.imageUri && (
              <img
                src={matchedCard.imageUri}
                className={styles.matchImg}
                alt={matchedCard.name}
              />
            )}
            <div className={styles.matchInfo}>
              <div className={styles.matchName}>{matchedCard.name}</div>
              <div className={styles.matchMeta}>
                {matchedCard.setCode?.toUpperCase()} #{matchedCard.collNum}
              </div>
              <div className={styles.matchDist}>
                Confidence:{' '}
                {Math.round((1 - matchedCard.distance / 256) * 100)}%
              </div>
            </div>
            <button className={styles.scanAgainBtn} onClick={handleScanAgain}>
              ⊙ Scan Again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
