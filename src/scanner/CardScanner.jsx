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
const MATCH_THRESHOLD  = 110   // camera pHash vs clean Scryfall art_crop; real-world offset ~90-100
const MIN_GAP          = 15    // second-best must be ≥ this many bits worse than best
const STABILITY_FRAMES = 2     // consecutive matches required before confirming
const MATCH_COOLDOWN   = 5000  // ms before same card can re-enter history
const CROP_OFFSETS     = [0, -10, 10]  // y-offsets for multi-crop hashing
const DEBUG            = true  // set false to hide debug overlay

export default function CardScanner({ onMatch, onAddCard, onClose }) {
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
  const [cardCount,          setCardCount]          = useState(0)
  const [scanHistory,        setScanHistory]        = useState([])
  const [latestMatch,        setLatestMatch]        = useState(null)
  const [selectedCard,       setSelectedCard]       = useState(null)  // history tap overlay
  const [debugInfo,          setDebugInfo]          = useState(null)

  const isReady = cvReady && dbReady

  // ── Init: camera + DB + OpenCV all start in parallel ─────────────────────
  useEffect(() => {
    mountedRef.current = true

    ;(async () => {
      try {
        // DB init — first page resolves quickly; remaining pages load in background.
        // Progress callback keeps cardCount state in sync so debug panel updates live.
        await databaseService.init(n => {
          if (mountedRef.current) setCardCount(n)
        })
        if (!mountedRef.current) return
        setDbReady(true)
        setCardCount(databaseService.cardCount)

        // If native and no local hashes, auto-sync from Supabase silently
        if (databaseService.cardCount === 0) {
          await databaseService.sync(n => {
            if (mountedRef.current) setCardCount(n)
          })
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
            enableHighResolution: true,
          })
        } else {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width:  { ideal: 1920 },
              height: { ideal: 1080 },
            },
          })
          if (videoRef.current && mountedRef.current) {
            videoRef.current.srcObject = stream
            await videoRef.current.play()

            // Apply continuous autofocus + auto-exposure if the device supports it.
            // applyConstraints is best-effort — silently ignored on unsupported browsers.
            const track = stream.getVideoTracks()[0]
            if (track) {
              const caps = track.getCapabilities?.() ?? {}
              const adv = {}
              if (caps.focusMode?.includes('continuous'))        adv.focusMode        = 'continuous'
              if (caps.exposureMode?.includes('continuous'))     adv.exposureMode     = 'continuous'
              if (caps.whiteBalanceMode?.includes('continuous')) adv.whiteBalanceMode = 'continuous'
              if (Object.keys(adv).length) {
                track.applyConstraints({ advanced: [adv] }).catch(() => {})
              }
            }
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
        const { value } = await CameraPreview.capture({ quality: 95 })
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
    if (!corners) {
      stabilityRef.current = { id: null, count: 0 }
      if (DEBUG && mountedRef.current) setDebugInfo(d => d ? { ...d, stage: 'no corners' } : null)
      return
    }

    const warped = warpCard(imageData, corners)
    if (!warped) { if (DEBUG && mountedRef.current) setDebugInfo(d => ({ ...d, stage: 'warp failed' })); return }

    // Multi-crop: try CROP_OFFSETS y-shifts, keep the result with the lowest distance.
    // This compensates for perspective warp residuals that shift the art region slightly.
    let best = null, second = null
    for (const yOff of CROP_OFFSETS) {
      const artCrop = cropArtRegion(warped, yOff)
      if (!artCrop) continue
      let hash = null
      try { hash = computePHash256(artCrop) } catch (e) {
        if (DEBUG && mountedRef.current) setDebugInfo(d => ({ ...d, stage: `hash error: ${e.message}` }))
        return
      }
      if (!hash) continue
      const [b, s] = databaseService.findBestTwo(hash)
      if (b && (!best || b.distance < best.distance)) { best = b; second = s }
    }

    if (!best) { if (DEBUG && mountedRef.current) setDebugInfo(d => ({ ...d, stage: 'hash returned null' })); return }

    // Gap check: only accept if best is significantly better than second-best.
    // Prevents false positives when many cards cluster near the threshold.
    const gap   = second ? second.distance - best.distance : 256
    const match = best.distance <= MATCH_THRESHOLD && gap >= MIN_GAP ? best : null

    if (DEBUG && mountedRef.current) {
      setDebugInfo({
        stage:     match
          ? `MATCHED (dist ${best.distance}, gap ${gap})`
          : `no match — dist ${best.distance}, gap ${gap}`,
        bestName:  best.name,
        stability: stabilityRef.current.count,
        hashes:    databaseService.cardCount,
      })
    }

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

        {/* Debug overlay */}
        {DEBUG && (
          <div className={styles.debugPanel}>
            <div><b>Hashes:</b> {cardCount.toLocaleString()} {cardCount < 5000 ? '⟳ loading…' : cardCount < 50000 ? '⟳ still loading…' : '✓'}</div>
            <div><b>CV:</b> {cvReady ? '✓' : '…'} &nbsp;<b>DB:</b> {dbReady ? '✓' : '…'}</div>
            {debugInfo
              ? <>
                  <div><b>Stage:</b> {debugInfo.stage}</div>
                  <div><b>Best:</b> {debugInfo.bestName}</div>
                  <div><b>Stability:</b> {debugInfo.stability}/{STABILITY_FRAMES}</div>
                </>
              : detecting && <div>⟳ computing…</div>
            }
          </div>
        )}

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

        {/* Selected card overlay — tapped from history */}
        {selectedCard && (
          <div className={styles.cardOverlay} onClick={() => setSelectedCard(null)}>
            <div className={styles.cardOverlayInner} onClick={e => e.stopPropagation()}>
              {selectedCard.imageUri && (
                <img src={selectedCard.imageUri} className={styles.cardOverlayImg} alt={selectedCard.name} />
              )}
              <div className={styles.cardOverlayName}>{selectedCard.name}</div>
              <div className={styles.cardOverlayMeta}>
                {selectedCard.setCode?.toUpperCase()}
                {selectedCard.collNum ? ` · #${selectedCard.collNum}` : ''}
              </div>
              <div className={styles.cardOverlayActions}>
                <button
                  className={styles.primaryBtn}
                  onClick={() => { onAddCard?.(selectedCard); setSelectedCard(null) }}
                >
                  + Add to Collection
                </button>
                <button className={styles.secondaryBtn} onClick={() => setSelectedCard(null)}>
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Bottom bar */}
        <div className={styles.bottomBar}>
          {/* Scan history strip */}
          {scanHistory.length > 0 && (
            <div className={styles.historyStrip}>
              {scanHistory.map(card => (
                <div
                  key={`${card.id}-${card.timestamp}`}
                  className={styles.historyItem}
                  onClick={() => setSelectedCard(card)}
                >
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
