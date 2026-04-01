/**
 * CardScanner — full-screen MTG card scanner
 *
 * Native: @capacitor-community/camera-preview renders behind the transparent WebView
 * Web:    getUserMedia() feeds a <video> element
 *
 * Camera starts immediately on mount. The hash DB loads in the background.
 * Tap "Scan Card" to capture and identify the card in the reticle.
 * Matched cards accumulate in a session history strip at the bottom.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'
import { CameraPreview } from '@capacitor-community/camera-preview'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { databaseService } from './DatabaseService'
import {
  waitForOpenCV,
  detectCardCorners, warpCard, cropArtRegion, computePHash256, cropCardFromReticle,
} from './ScannerEngine'
import styles from './CardScanner.module.css'

const MATCH_THRESHOLD = 110
const MATCH_MIN_GAP = 12
const MATCH_COOLDOWN = 3000
const CROP_VARIANTS = [
  { xOffset: 0, yOffset: 0 },
  { xOffset: 0, yOffset: -10 },
  { xOffset: 0, yOffset: 10 },
  { xOffset: -8, yOffset: 0 },
  { xOffset: 8, yOffset: 0 },
  { xOffset: 0, yOffset: 0, inset: 6 },
  { xOffset: 0, yOffset: 0, inset: -6 },
]
const STABILITY_SAMPLES = 4
const STABILITY_REQUIRED = 2
const SAMPLE_DELAY_MS = 120
const DEBUG = true
const RETICLE_WIDTH = 280
const RETICLE_HEIGHT = 392
const RETICLE_CENTER_Y_OFFSET = -8

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

export default function CardScanner({ onMatch, onAddCard, onClose }) {
  const isNative = Capacitor.isNativePlatform()

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const mountedRef = useRef(true)
  const lastMatchRef = useRef({ id: null, time: 0 })
  const latestMatchTimerRef = useRef(null)

  const [cvReady, setCvReady] = useState(false)
  const [dbReady, setDbReady] = useState(false)
  const [preparing, setPreparing] = useState(true)
  const [errorMsg, setErrorMsg] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [cardCount, setCardCount] = useState(0)
  const [scanHistory, setScanHistory] = useState([])
  const [latestMatch, setLatestMatch] = useState(null)
  const [selectedCard, setSelectedCard] = useState(null)
  const [debugInfo, setDebugInfo] = useState(null)

  const isReady = cvReady && dbReady

  useEffect(() => {
    mountedRef.current = true

    ;(async () => {
      try {
        await databaseService.init(n => {
          if (mountedRef.current) setCardCount(n)
        })
        await databaseService.waitUntilFullyLoaded()
        if (!mountedRef.current) return
        setDbReady(true)
        setCardCount(databaseService.cardCount)

        if (databaseService.cardCount === 0) {
          await databaseService.sync(n => {
            if (mountedRef.current) setCardCount(n)
          })
          await databaseService.waitUntilFullyLoaded()
          if (!mountedRef.current) return
          setCardCount(databaseService.cardCount)
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

  useEffect(() => {
    let started = false

    ;(async () => {
      try {
        if (isNative) {
          await CameraPreview.start({
            position: 'rear',
            toBack: true,
            width: window.screen.width,
            height: window.screen.height,
            disableAudio: true,
            enableHighResolution: true,
          })
        } else {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
          })
          if (videoRef.current && mountedRef.current) {
            videoRef.current.srcObject = stream
            await videoRef.current.play()

            const track = stream.getVideoTracks()[0]
            if (track) {
              const caps = track.getCapabilities?.() ?? {}
              const advanced = {}
              if (caps.focusMode?.includes('continuous')) advanced.focusMode = 'continuous'
              if (caps.exposureMode?.includes('continuous')) advanced.exposureMode = 'continuous'
              if (caps.whiteBalanceMode?.includes('continuous')) advanced.whiteBalanceMode = 'continuous'
              if (Object.keys(advanced).length) {
                track.applyConstraints({ advanced: [advanced] }).catch(() => {})
              }
            }
          } else {
            stream.getTracks().forEach(t => t.stop())
            return
          }
        }
        started = true
      } catch (e) {
        if (mountedRef.current) setErrorMsg('Camera: ' + e.message)
      }
    })()

    return () => {
      if (!started) return
      if (isNative) CameraPreview.stop().catch(() => {})
      else videoRef.current?.srcObject?.getTracks().forEach(t => t.stop())
    }
  }, [isNative])

  const captureFrame = useCallback(async () => {
    let imageData, w, h

    if (isNative) {
      const { value } = await CameraPreview.capture({ quality: 95 })
      const img = await new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = reject
        image.src = 'data:image/jpeg;base64,' + value
      })
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      canvas.getContext('2d').drawImage(img, 0, 0)
      imageData = canvas.getContext('2d').getImageData(0, 0, img.width, img.height)
      w = img.width
      h = img.height
    } else {
      const vid = videoRef.current
      if (!vid?.videoWidth) return null
      const canvas = canvasRef.current
      canvas.width = vid.videoWidth
      canvas.height = vid.videoHeight
      canvas.getContext('2d').drawImage(vid, 0, 0)
      w = canvas.width
      h = canvas.height
      imageData = canvas.getContext('2d').getImageData(0, 0, w, h)
    }

    return { imageData, w, h }
  }, [isNative])

  const scanSingleFrame = useCallback(async () => {
    const frame = await captureFrame()
    if (!frame) return { status: 'error', stage: 'no frame', best: null, second: null, candidateCount: 0, totalCount: 0, variant: null }

    const { imageData, w, h } = frame
    const corners = detectCardCorners(imageData, w, h)

    let best = null
    let second = null
    let bestStats = { candidateCount: 0, totalCount: databaseService.cardCount }
    let bestVariant = null
    let bestSource = corners ? 'corners' : 'reticle'

    const tryMatchCardImage = (cardImageData, sourceLabel) => {
      for (const variant of CROP_VARIANTS) {
        const artCrop = cropArtRegion(cardImageData, variant)
        if (!artCrop) continue
        const hash = computePHash256(artCrop)
        if (!hash) continue
        const { best: candidate, second: runnerUp, candidateCount, totalCount } = databaseService.findBestTwoWithStats(hash)
        if (candidate && (!best || candidate.distance < best.distance)) {
          best = candidate
          second = runnerUp
          bestStats = { candidateCount, totalCount }
          bestVariant = variant
          bestSource = sourceLabel
        }
      }
    }

    if (corners) {
      const warped = warpCard(imageData, corners)
      if (warped) tryMatchCardImage(warped, 'corners')
    }

    if (!best) {
      const viewportWidth = window.innerWidth || window.screen.width || w
      const viewportHeight = window.innerHeight || window.screen.height || h
      for (const inset of [0, 10, 18, -8]) {
        const reticleCard = cropCardFromReticle(
          imageData,
          w,
          h,
          viewportWidth,
          viewportHeight,
          {
            reticleWidth: RETICLE_WIDTH,
            reticleHeight: RETICLE_HEIGHT,
            centerYOffsetPx: RETICLE_CENTER_Y_OFFSET,
            inset,
          },
        )
        tryMatchCardImage(reticleCard, corners ? 'reticle fallback' : 'reticle')
      }
    }

    if (!best) {
      return {
        status: 'notfound',
        stage: corners ? 'no candidate' : 'no corners',
        best: null,
        second: null,
        candidateCount: bestStats.candidateCount,
        totalCount: bestStats.totalCount,
        variant: null,
        source: bestSource,
      }
    }

    const gap = second ? second.distance - best.distance : 256
    return {
      status: best.distance <= MATCH_THRESHOLD && gap >= MATCH_MIN_GAP ? 'found' : 'notfound',
      stage: `dist ${best.distance}, gap ${gap}`,
      best,
      second,
      gap,
      candidateCount: bestStats.candidateCount,
      totalCount: bestStats.totalCount,
      variant: bestVariant,
      source: bestSource,
    }
  }, [captureFrame])

  const handleScan = useCallback(async () => {
    if (!isReady || scanning || !mountedRef.current) return
    setScanning(true)
    setScanResult(null)

    try {
      const votes = new Map()
      let bestObserved = null
      let bestObservedGap = null
      let bestObservedCandidates = null
      let bestObservedVariant = null
      let bestObservedSource = null
      const frameSummaries = []

      for (let i = 0; i < STABILITY_SAMPLES; i++) {
        const result = await scanSingleFrame()
        frameSummaries.push(
          result.best
            ? `${i + 1}:${result.best.distance}/${result.gap ?? '?'}`
            : `${i + 1}:${result.stage}`
        )
        if (result.best && (!bestObserved || result.best.distance < bestObserved.distance)) {
          bestObserved = result.best
          bestObservedGap = result.second ? result.second.distance - result.best.distance : 256
          bestObservedCandidates = result.candidateCount
          bestObservedVariant = result.variant
          bestObservedSource = result.source
        }

        if (result.status === 'found' && result.best) {
          const previous = votes.get(result.best.id) ?? { count: 0, best: result.best }
          votes.set(result.best.id, {
            count: previous.count + 1,
            best: result.best.distance < previous.best.distance ? result.best : previous.best,
          })
        }

        const stableVote = [...votes.values()].sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count
          return a.best.distance - b.best.distance
        })[0]

        if (stableVote?.count >= STABILITY_REQUIRED) break
        if (i < STABILITY_SAMPLES - 1) await sleep(SAMPLE_DELAY_MS)
      }

      const stableVote = [...votes.values()].sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        return a.best.distance - b.best.distance
      })[0] ?? null
      const match = stableVote?.count >= STABILITY_REQUIRED ? stableVote.best : null

      if (DEBUG && mountedRef.current) {
        setDebugInfo({
          stage: match
            ? `MATCHED ${stableVote.count}/${STABILITY_SAMPLES} (${bestObservedGap ?? '?'})`
            : bestObserved
              ? `no match - ${bestObserved.distance}/${bestObservedGap ?? '?'}`
              : 'no match - no candidate',
          bestName: match?.name ?? bestObserved?.name ?? '',
          hashes: databaseService.cardCount,
          candidates: bestObservedCandidates,
          total: databaseService.cardCount,
          votes: stableVote?.count ? `${stableVote.count}/${STABILITY_REQUIRED}` : `0/${STABILITY_REQUIRED}`,
          frames: frameSummaries.join(' | '),
          source: bestObservedSource ?? '-',
          variant: bestObservedVariant
            ? `x:${bestObservedVariant.xOffset ?? 0} y:${bestObservedVariant.yOffset ?? 0} i:${bestObservedVariant.inset ?? 0}`
            : '-',
        })
      }

      if (!match) {
        setScanResult('notfound')
        return
      }

      const now = Date.now()
      const last = lastMatchRef.current
      if (last.id === match.id && now - last.time < MATCH_COOLDOWN) {
        setScanResult('found')
        return
      }

      lastMatchRef.current = { id: match.id, time: now }
      const entry = { ...match, timestamp: now }

      setScanHistory(history => [entry, ...history.slice(0, 49)])
      setLatestMatch(entry)
      setScanResult('found')
      clearTimeout(latestMatchTimerRef.current)
      latestMatchTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setLatestMatch(null)
      }, 3000)

      try {
        await Haptics.impact({ style: ImpactStyle.Medium })
      } catch {}
      onMatch?.(match)
    } catch (e) {
      if (DEBUG && mountedRef.current) setDebugInfo(d => ({ ...d, stage: `error: ${e.message}` }))
      setScanResult('error')
    } finally {
      if (mountedRef.current) setScanning(false)
    }
  }, [isReady, onMatch, scanSingleFrame, scanning])

  return (
    <div className={styles.root}>
      {!isNative && (
        <>
          <video ref={videoRef} className={styles.video} playsInline muted />
          <canvas ref={canvasRef} className={styles.hiddenCanvas} />
        </>
      )}

      <div className={`${styles.overlay} ${isNative ? styles.overlayNative : ''}`}>
        <div className={styles.topBar}>
          {(preparing || errorMsg) && (
            <div className={styles.statusPill}>
              {errorMsg ? `X ${errorMsg}` : 'Starting...'}
            </div>
          )}
          <button className={styles.closeBtn} onClick={onClose}>X</button>
        </div>

        <div className={`${styles.targetFrame} ${scanResult === 'found' ? styles.targetLit : ''} ${scanning ? styles.targetPaused : ''}`}>
          <span className={`${styles.corner} ${styles.tl}`} />
          <span className={`${styles.corner} ${styles.tr}`} />
          <span className={`${styles.corner} ${styles.br}`} />
          <span className={`${styles.corner} ${styles.bl}`} />
          {preparing && !errorMsg && <div className={styles.preparingSpinner}>...</div>}
          {scanning && <div className={styles.pausedLabel}>Scanning...</div>}
        </div>

        {DEBUG && (
          <div className={styles.debugPanel}>
            <div><b>Hashes:</b> {cardCount.toLocaleString()} {databaseService.isFullyLoaded ? 'loaded' : 'loading...'}</div>
            <div><b>CV:</b> {cvReady ? 'ready' : '...'} &nbsp;<b>DB:</b> {dbReady ? 'ready' : '...'}</div>
            {debugInfo && (
              <>
                <div><b>Stage:</b> {debugInfo.stage}</div>
                <div><b>Best:</b> {debugInfo.bestName}</div>
                <div><b>Pool:</b> {debugInfo.candidates?.toLocaleString?.() ?? 0}/{debugInfo.total?.toLocaleString?.() ?? cardCount.toLocaleString()}</div>
                <div><b>Votes:</b> {debugInfo.votes}</div>
                <div><b>Source:</b> {debugInfo.source}</div>
                <div><b>Crop:</b> {debugInfo.variant}</div>
                <div><b>Frames:</b> {debugInfo.frames}</div>
              </>
            )}
          </div>
        )}

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
            <div className={styles.latestToastCheck}>OK</div>
          </div>
        )}

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

        <div className={styles.bottomBar}>
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

          {isReady && (
            <div className={styles.btnRow}>
              <button
                className={styles.primaryBtn}
                onClick={handleScan}
                disabled={scanning}
              >
                {scanning
                  ? 'Scanning...'
                  : scanResult === 'found'
                    ? 'Found - Scan Again'
                    : scanResult === 'notfound'
                      ? 'Not Found - Try Again'
                      : 'Scan Card'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
