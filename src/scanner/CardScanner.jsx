/**
 * CardScanner — full-screen MTG card scanner
 *
 * Native: @capacitor-community/camera-preview renders behind the transparent WebView
 * Web:    getUserMedia() feeds a <video> element
 *
 * Camera starts immediately on mount. The hash DB loads in the background.
 * Scanning begins as soon as both OpenCV and the DB are ready — no buttons needed.
 * Matched cards accumulate in a session history strip at the bottom.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'
import { CameraPreview } from '@capacitor-community/camera-preview'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { databaseService } from './DatabaseService'
import {
  waitForOpenCV,
  detectCardCorners, warpCard, cropArtRegion, computePHash256,
} from './ScannerEngine'
import styles from './CardScanner.module.css'

const SCAN_MS          = 280   // ~3.5 FPS
const MATCH_THRESHOLD  = 35    // max Hamming distance out of 256
const STABILITY_FRAMES = 2     // consecutive matches before confirming
const MATCH_COOLDOWN   = 5000  // ms before same card can re-enter history

export default function CardScanner({ onMatch, onClose }) {
  const isNative = Capacitor.isNativePlatform()

  const videoRef            = useRef(null)
  const canvasRef           = useRef(null)
  const loopRef             = useRef(null)
  const mountedRef          = useRef(true)
  const stabilityRef        = useRef({ id: null, count: 0 })
  const lastMatchRef        = useRef({ id: null, time: 0 })
  const latestMatchTimerRef = useRef(null)

  // Internal readiness — not shown as status labels to user
  const [cvReady,     setCvReady]     = useState(false)
  const [dbReady,     setDbReady]     = useState(false)
  const [preparing,   setPreparing]   = useState(true)   // true while loading
  const [errorMsg,    setErrorMsg]    = useState(null)
  const [paused,      setPaused]      = useState(false)
  const [detecting,   setDetecting]   = useState(false)
  const [scanHistory, setScanHistory] = useState([])
  const [latestMatch, setLatestMatch] = useState(null)

  const isReady = cvReady && dbReady

  // ── Init: camera + DB + OpenCV all start in parallel ─────────────────────
  useEffect(() => {
    mountedRef.current = true

    ;(async () => {
      try {
        // DB init — hashes load in background pages after the first resolves
        await databaseService.init()
        if (!mountedRef.current) return
        setDbReady(true)

        // If native and no local hashes, auto-sync from Supabase silently
        if (databaseService.cardCount === 0) {
          await databaseService.sync()
        }

        await waitForOpenCV()
        if (!mountedRef.current) return
        setCvReady(true)
        setPreparing(false)
      } catch (e) {
        if (mountedRef.current) setErrorMsg(e.message)
      }
    })()

    return () => {
      mountedRef.current = false
      clearTimeout(latestMatchTimerRef.current)
    }
  }, [])

  // ── Camera: start immediately on mount, stop on unmount ──────────────────
  useEffect(() => {
    let started = false

    ;(async () => {
      try {
        if (isNative) {
          await CameraPreview.start({
            position: 'rear', toBack: true,
            width: window.screen.width, height: window.screen.height,
            disableAudio: true,
          })
        } else {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          })
          if (videoRef.current && mountedRef.current) {
            videoRef.current.srcObject = stream
            await videoRef.current.play()
          } else {
            stream.getTracks().forEach(t => t.stop()); return
          }
        }
        started = true
      } catch (e) {
        if (mountedRef.current) setErrorMsg('Camera: ' + e.message)
      }
    })()

    return () => {
      if (!started) return
      if (isNative) { CameraPreview.stop().catch(() => {}) }
      else { videoRef.current?.srcObject?.getTracks().forEach(t => t.stop()) }
    }
  }, [isNative])

  // ── Frame processor ───────────────────────────────────────────────────────
  const processFrame = useCallback(async () => {
    if (!cvReady || !dbReady || !mountedRef.current) return

    let imageData, w, h
    try {
      if (isNative) {
        const { value } = await CameraPreview.capture({ quality: 80 })
        const img = await new Promise((res, rej) => {
          const i = new Image(); i.onload = () => res(i); i.onerror = rej
          i.src = 'data:image/jpeg;base64,' + value
        })
        const c = document.createElement('canvas')
        c.width = img.width; c.height = img.height
        c.getContext('2d').drawImage(img, 0, 0)
        imageData = c.getContext('2d').getImageData(0, 0, img.width, img.height)
        w = img.width; h = img.height
      } else {
        const vid = videoRef.current
        if (!vid?.videoWidth) return
        const c = canvasRef.current
        c.width = vid.videoWidth; c.height = vid.videoHeight
        c.getContext('2d').drawImage(vid, 0, 0)
        w = c.width; h = c.height
        imageData = c.getContext('2d').getImageData(0, 0, w, h)
      }
    } catch { return }

    const corners = detectCardCorners(imageData, w, h)
    if (mountedRef.current) setDetecting(!!corners)
    if (!corners) { stabilityRef.current = { id: null, count: 0 }; return }

    const warped  = warpCard(imageData, corners);  if (!warped)  return
    const artCrop = cropArtRegion(warped);          if (!artCrop) return
    const hash    = computePHash256(artCrop);       if (!hash)    return

    const match = databaseService.findMatch(hash, MATCH_THRESHOLD)
    if (!match) { stabilityRef.current = { id: null, count: 0 }; return }

    const stab = stabilityRef.current
    if (stab.id === match.id) {
      stab.count++
      if (stab.count >= STABILITY_FRAMES) {
        stabilityRef.current = { id: null, count: 0 }

        const now  = Date.now()
        const last = lastMatchRef.current
        if (last.id === match.id && now - last.time < MATCH_COOLDOWN) return

        lastMatchRef.current = { id: match.id, time: now }
        const entry = { ...match, timestamp: now }

        if (mountedRef.current) {
          setScanHistory(h => [entry, ...h.slice(0, 49)])
          setLatestMatch(entry)
          clearTimeout(latestMatchTimerRef.current)
          latestMatchTimerRef.current = setTimeout(() => {
            if (mountedRef.current) setLatestMatch(null)
          }, 3000)
        }

        try { await Haptics.impact({ style: ImpactStyle.Medium }) } catch {}
        onMatch?.(match)
      }
    } else {
      stabilityRef.current = { id: match.id, count: 1 }
    }
  }, [cvReady, dbReady, isNative, onMatch])

  // ── Scan loop — runs whenever ready and not paused ───────────────────────
  useEffect(() => {
    if (!isReady || paused) { clearInterval(loopRef.current); return }
    stabilityRef.current = { id: null, count: 0 }
    loopRef.current = setInterval(processFrame, SCAN_MS)
    return () => clearInterval(loopRef.current)
  }, [isReady, paused, processFrame])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.root}>
      {!isNative && (
        <>
          <video ref={videoRef} className={styles.video} playsInline muted />
          <canvas ref={canvasRef} className={styles.hiddenCanvas} />
        </>
      )}

      <div className={`${styles.overlay} ${isNative ? styles.overlayNative : ''}`}>

        {/* Top bar — only close button + error/loading indicator if needed */}
        <div className={styles.topBar}>
          {(preparing || errorMsg) && (
            <div className={styles.statusPill}>
              {errorMsg  ? `✕ ${errorMsg}` : '⟳ Starting…'}
            </div>
          )}
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Targeting reticle — always visible */}
        <div className={`${styles.targetFrame} ${detecting ? styles.targetLit : ''} ${paused ? styles.targetPaused : ''}`}>
          <span className={`${styles.corner} ${styles.tl}`} />
          <span className={`${styles.corner} ${styles.tr}`} />
          <span className={`${styles.corner} ${styles.br}`} />
          <span className={`${styles.corner} ${styles.bl}`} />
          {isReady && !paused && <div className={styles.scanLine} />}
          {paused && <div className={styles.pausedLabel}>Paused</div>}
          {preparing && !errorMsg && <div className={styles.preparingSpinner}>⟳</div>}
        </div>

        {/* Latest match toast */}
        {latestMatch && (
          <div className={styles.latestToast}>
            {latestMatch.imageUri && (
              <img src={latestMatch.imageUri} className={styles.latestToastImg} alt={latestMatch.name} />
            )}
            <div className={styles.latestToastInfo}>
              <div className={styles.latestToastName}>{latestMatch.name}</div>
              <div className={styles.latestToastMeta}>
                {latestMatch.setCode?.toUpperCase()}
                {latestMatch.collNum ? ` · #${latestMatch.collNum}` : ''}
              </div>
            </div>
            <div className={styles.latestToastCheck}>✓</div>
          </div>
        )}

        {/* Bottom bar */}
        <div className={styles.bottomBar}>
          {/* Scan history strip */}
          {scanHistory.length > 0 && (
            <div className={styles.historyStrip}>
              {scanHistory.map(card => (
                <div key={`${card.id}-${card.timestamp}`} className={styles.historyItem}>
                  {card.imageUri
                    ? <img src={card.imageUri} className={styles.historyImg} alt={card.name} />
                    : <div className={styles.historyImgPlaceholder}>{card.name[0]}</div>
                  }
                  <div className={styles.historyName}>{card.name}</div>
                </div>
              ))}
            </div>
          )}

          {/* Pause / resume */}
          {isReady && (
            <div className={styles.btnRow}>
              <button
                className={paused ? styles.primaryBtn : styles.stopBtn}
                onClick={() => setPaused(p => !p)}
              >
                {paused ? '▶ Resume' : '◼ Pause'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
