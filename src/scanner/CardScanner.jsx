/**
 * CardScanner — full-screen MTG card scanner component
 *
 * Native: @capacitor-community/camera-preview renders behind the transparent WebView
 * Web:    getUserMedia() feeds a <video> element
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'
import { CameraPreview } from '@capacitor-community/camera-preview'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { databaseService } from './DatabaseService'
import {
  isOpenCVReady, waitForOpenCV,
  detectCardCorners, warpCard, cropArtRegion, computePHash256,
} from './ScannerEngine'
import styles from './CardScanner.module.css'

const SCAN_MS          = 280   // ~3.5 FPS
const MATCH_THRESHOLD  = 20    // max Hamming distance out of 256
const STABILITY_FRAMES = 2     // consecutive matches required

export default function CardScanner({ onMatch, onClose }) {
  const isNative = Capacitor.isNativePlatform()

  const videoRef     = useRef(null)
  const canvasRef    = useRef(null)
  const loopRef      = useRef(null)
  const mountedRef   = useRef(true)
  const stabilityRef = useRef({ id: null, count: 0 })

  const [status,      setStatus]      = useState('initializing')
  const [cvReady,     setCvReady]     = useState(false)
  const [dbReady,     setDbReady]     = useState(false)
  const [cardCount,   setCardCount]   = useState(0)
  const [syncing,     setSyncing]     = useState(false)
  const [syncCount,   setSyncCount]   = useState(0)
  const [matchedCard, setMatchedCard] = useState(null)
  const [errorMsg,    setErrorMsg]    = useState(null)
  const [detecting,   setDetecting]   = useState(false)

  // ── Init OpenCV + DB ──────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true
    ;(async () => {
      try {
        await databaseService.init()
        if (!mountedRef.current) return
        setDbReady(true)
        setCardCount(databaseService.cardCount)

        await waitForOpenCV()
        if (!mountedRef.current) return
        setCvReady(true)
        setStatus(databaseService.cardCount > 0 ? 'ready' : 'needs-sync')
      } catch (e) {
        if (mountedRef.current) { setErrorMsg(e.message); setStatus('error') }
      }
    })()
    return () => { mountedRef.current = false }
  }, [])

  // ── Camera start / stop ───────────────────────────────────────────────────
  const cameraActive = status === 'ready' || status === 'scanning'

  useEffect(() => {
    if (!cameraActive) return
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
        if (mountedRef.current) { setErrorMsg('Camera: ' + e.message); setStatus('error') }
      }
    })()

    return () => {
      if (!started) return
      if (isNative) { CameraPreview.stop().catch(() => {}) }
      else { videoRef.current?.srcObject?.getTracks().forEach(t => t.stop()) }
    }
  }, [cameraActive, isNative])

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
        clearInterval(loopRef.current)
        if (!mountedRef.current) return
        setMatchedCard(match)
        setStatus('matched')
        setDetecting(false)
        try { await Haptics.impact({ style: ImpactStyle.Medium }) } catch {}
        onMatch?.(match)
      }
    } else {
      stabilityRef.current = { id: match.id, count: 1 }
    }
  }, [cvReady, dbReady, isNative, onMatch])

  // ── Scan loop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'scanning') { clearInterval(loopRef.current); return }
    stabilityRef.current = { id: null, count: 0 }
    loopRef.current = setInterval(processFrame, SCAN_MS)
    return () => clearInterval(loopRef.current)
  }, [status, processFrame])

  // ── Sync ──────────────────────────────────────────────────────────────────
  const handleSync = async () => {
    setSyncing(true); setSyncCount(0)
    try {
      await databaseService.sync(n => setSyncCount(n))
      setCardCount(databaseService.cardCount)
      setStatus('ready')
    } catch (e) { setErrorMsg('Sync failed: ' + e.message) }
    setSyncing(false)
  }

  const handleScanAgain = () => {
    setMatchedCard(null)
    stabilityRef.current = { id: null, count: 0 }
    setStatus('scanning')
  }

  const confidence = matchedCard
    ? Math.round((1 - matchedCard.distance / 256) * 100)
    : 0

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

        {/* Top bar */}
        <div className={styles.topBar}>
          <div className={styles.statusPill}>
            {status === 'initializing' && '⟳ Initializing…'}
            {status === 'needs-sync'   && '⚠ No card database — sync required'}
            {status === 'ready'        && `${cardCount.toLocaleString()} cards ready`}
            {status === 'scanning'     && (detecting ? '▣ Card detected!' : '◎ Point at a card…')}
            {status === 'matched'      && '✓ Match found!'}
            {status === 'error'        && `✕ ${errorMsg}`}
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Targeting reticle */}
        {(status === 'scanning' || status === 'ready') && (
          <div className={`${styles.targetFrame} ${detecting ? styles.targetLit : ''}`}>
            <span className={`${styles.corner} ${styles.tl}`} />
            <span className={`${styles.corner} ${styles.tr}`} />
            <span className={`${styles.corner} ${styles.br}`} />
            <span className={`${styles.corner} ${styles.bl}`} />
            {status === 'scanning' && <div className={styles.scanLine} />}
          </div>
        )}

        {/* Bottom controls */}
        <div className={styles.bottomBar}>
          {status === 'needs-sync' && (
            <button className={styles.primaryBtn} onClick={handleSync} disabled={syncing}>
              {syncing
                ? `⬇ Syncing… ${syncCount.toLocaleString()} cards`
                : '⬇ Download Card Database'}
            </button>
          )}

          {status === 'ready' && (
            <div className={styles.btnRow}>
              <button className={styles.primaryBtn} onClick={() => setStatus('scanning')}>
                ⊙ Start Scanning
              </button>
              <button className={styles.secondaryBtn} onClick={handleSync} disabled={syncing}>
                {syncing ? `${syncCount.toLocaleString()}…` : '⟳ Re-sync'}
              </button>
            </div>
          )}

          {status === 'scanning' && (
            <button className={styles.stopBtn} onClick={() => setStatus('ready')}>
              ◼ Stop
            </button>
          )}

          {status === 'matched' && matchedCard && (
            <div className={styles.matchCard}>
              {matchedCard.imageUri && (
                <img src={matchedCard.imageUri} className={styles.matchImg} alt={matchedCard.name} />
              )}
              <div className={styles.matchInfo}>
                <div className={styles.matchName}>{matchedCard.name}</div>
                <div className={styles.matchMeta}>
                  {matchedCard.setCode?.toUpperCase()}
                  {matchedCard.collNum ? ` · #${matchedCard.collNum}` : ''}
                </div>
                <div className={styles.matchConf}>
                  <span className={styles.confDot} style={{
                    background: confidence >= 90 ? 'var(--green)' : confidence >= 75 ? '#c4a040' : 'var(--red)'
                  }} />
                  {confidence}% match
                </div>
              </div>
              <button className={styles.scanAgainBtn} onClick={handleScanAgain}>
                ⊙ Scan Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
