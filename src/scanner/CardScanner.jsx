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
import { initScanner } from '../lib/scanner'
import { databaseService } from './DatabaseService'
import {
  waitForOpenCV,
  detectCardCorners, warpCard, cropArtRegion, computePHash256, cropCardFromReticle, createNameStripCanvas,
} from './ScannerEngine'
import styles from './CardScanner.module.css'

const MATCH_THRESHOLD = 110
const MATCH_MIN_GAP = 12
const MATCH_STRONG_THRESHOLD = 118
const MATCH_STRONG_SINGLE = 96
const MATCH_MIN_GAP_WITH_OCR = 8
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
const STABILITY_SAMPLES = 3
const STABILITY_REQUIRED = 2
const SAMPLE_DELAY_MS = 80
const DEBUG = true
const NATIVE_BURST_FRAMES = 3
const NATIVE_BURST_DELAY_MS = 70
const RETICLE_WIDTH = 280
const RETICLE_HEIGHT = 392
const RETICLE_CENTER_Y_OFFSET = -8
const OCR_MIN_CONFIDENCE = 45

const normalizeName = (value = '') =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function nameSupportScore(ocrText, candidateName) {
  const ocr = normalizeName(ocrText)
  const cand = normalizeName(candidateName)
  if (!ocr || !cand) return 0
  if (ocr === cand) return 1
  if (cand.includes(ocr) || ocr.includes(cand)) return 0.92

  const ocrWords = ocr.split(' ').filter(Boolean)
  const candWords = cand.split(' ').filter(Boolean)
  if (!ocrWords.length || !candWords.length) return 0
  let hits = 0
  for (const word of ocrWords) {
    if (candWords.some(cw => cw === word || cw.startsWith(word) || word.startsWith(cw))) hits++
  }
  return hits / Math.max(ocrWords.length, candWords.length)
}

function shouldAcceptMatch({ best, gap, stableCount, ocrSupport, ocrConfidence }) {
  if (!best) return { accepted: false, reason: 'no best candidate' }
  if (stableCount >= STABILITY_REQUIRED && best.distance <= MATCH_THRESHOLD && gap >= MATCH_MIN_GAP) {
    return { accepted: true, reason: 'stable threshold match' }
  }
  if (stableCount >= STABILITY_REQUIRED && best.distance <= MATCH_STRONG_THRESHOLD && gap >= MATCH_MIN_GAP_WITH_OCR) {
    return { accepted: true, reason: 'stable relaxed match' }
  }
  if (stableCount >= 1 && best.distance <= MATCH_STRONG_SINGLE && gap >= MATCH_MIN_GAP_WITH_OCR) {
    return { accepted: true, reason: 'single strong frame' }
  }
  if (ocrSupport >= 0.72 && ocrConfidence >= OCR_MIN_CONFIDENCE && best.distance <= MATCH_STRONG_THRESHOLD) {
    return { accepted: true, reason: 'ocr verified best match' }
  }
  if (stableCount < STABILITY_REQUIRED) return { accepted: false, reason: 'insufficient stable votes' }
  if (best.distance > MATCH_STRONG_THRESHOLD) return { accepted: false, reason: `distance too high (${best.distance})` }
  if (gap < MATCH_MIN_GAP_WITH_OCR) return { accepted: false, reason: `gap too small (${gap})` }
  return { accepted: false, reason: 'best candidate not confident enough' }
}

function scoreFrameQuality(imageData, width, height) {
  const data = imageData.data
  const stepX = Math.max(1, Math.floor(width / 96))
  const stepY = Math.max(1, Math.floor(height / 96))
  let prevRow = null
  let laplaceEnergy = 0
  let brightnessSum = 0
  let brightnessSqSum = 0
  let samples = 0

  for (let y = 0; y < height; y += stepY) {
    let prevGray = null
    const row = []
    for (let x = 0; x < width; x += stepX) {
      const idx = (y * width + x) * 4
      const gray = Math.round(0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2])
      row.push(gray)
      brightnessSum += gray
      brightnessSqSum += gray * gray
      samples++

      if (prevGray != null) {
        laplaceEnergy += Math.abs(gray - prevGray)
      }
      if (prevRow && prevRow[row.length - 1] != null) {
        laplaceEnergy += Math.abs(gray - prevRow[row.length - 1])
      }
      prevGray = gray
    }
    prevRow = row
  }

  const mean = brightnessSum / Math.max(1, samples)
  const variance = brightnessSqSum / Math.max(1, samples) - mean * mean
  const stdev = Math.sqrt(Math.max(0, variance))
  const exposurePenalty = Math.abs(mean - 132) * 0.35
  return laplaceEnergy + stdev * 18 - exposurePenalty
}

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
  const [cameraPosition, setCameraPosition] = useState('rear')
  const [flashModes, setFlashModes] = useState([])
  const [flashMode, setFlashMode] = useState('off')
  const [cameraStarted, setCameraStarted] = useState(false)
  const [cameraRestartTick, setCameraRestartTick] = useState(0)

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
    if (!cvReady || !dbReady) return
    initScanner().catch(() => {})
  }, [cvReady, dbReady])

  useEffect(() => {
    let started = false

    ;(async () => {
      try {
        if (mountedRef.current) {
          setErrorMsg(null)
          setCameraStarted(false)
        }
        if (isNative) {
          await CameraPreview.start({
            position: cameraPosition,
            toBack: true,
            width: window.screen.width,
            height: window.screen.height,
            disableAudio: true,
            enableHighResolution: true,
            enableZoom: true,
            tapFocus: true,
          })
          const startedState = await CameraPreview.isCameraStarted().catch(() => ({ value: true }))
          if (!mountedRef.current) return
          setCameraStarted(!!startedState?.value)
          const supported = await CameraPreview.getSupportedFlashModes().catch(() => ({ result: [] }))
          if (!mountedRef.current) return
          setFlashModes(Array.isArray(supported?.result) ? supported.result : [])
          const desiredFlash = (supported?.result || []).includes(flashMode) ? flashMode : ((supported?.result || []).includes('off') ? 'off' : '')
          if (desiredFlash && mountedRef.current) setFlashMode(desiredFlash)
        } else {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: cameraPosition === 'rear' ? 'environment' : 'user' },
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
            setCameraStarted(true)
          } else {
            stream.getTracks().forEach(t => t.stop())
            return
          }
        }
        started = true
      } catch (e) {
        if (mountedRef.current) {
          setErrorMsg('Camera: ' + e.message)
          setCameraStarted(false)
        }
      }
    })()

    return () => {
      if (!started) return
      if (isNative) CameraPreview.stop().catch(() => {})
      else videoRef.current?.srcObject?.getTracks().forEach(t => t.stop())
    }
  }, [cameraPosition, cameraRestartTick, isNative])

  useEffect(() => {
    if (!cameraStarted) return
    if (isNative) {
      CameraPreview.setFlashMode({ flashMode }).catch(() => {})
      return
    }
    const track = videoRef.current?.srcObject?.getVideoTracks?.()?.[0]
    if (track) {
      track.applyConstraints({ advanced: [{ torch: flashMode === 'torch' || flashMode === 'on' }] }).catch(() => {})
    }
  }, [cameraStarted, flashMode, isNative])

  const handleSwitchCamera = useCallback(() => {
    setCameraPosition(prev => prev === 'rear' ? 'front' : 'rear')
    setScanResult(null)
  }, [])

  const handleFlashMode = useCallback(async (nextMode) => {
    setFlashMode(nextMode)
  }, [])

  const handleRestartCamera = useCallback(() => {
    setCameraRestartTick(t => t + 1)
    setScanResult(null)
  }, [])

  const recognizeCardName = useCallback(async (cardImageData) => {
    try {
      const worker = await initScanner()
      if (!worker || !cardImageData) return null
      const nameCanvas = createNameStripCanvas(cardImageData)
      const { data } = await worker.recognize(nameCanvas)
      const text = data.text?.trim()?.replace(/[^A-Za-z0-9 ',.\-’]/g, '') || ''
      return { text, confidence: data.confidence ?? 0 }
    } catch {
      return null
    }
  }, [])

  const captureFrame = useCallback(async () => {
    let imageData, w, h

    if (isNative) {
      const decodeSample = async (value) => {
        const img = await new Promise((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = reject
          image.src = 'data:image/jpeg;base64,' + value
        })
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0)
        const frameImageData = ctx.getImageData(0, 0, img.width, img.height)
        return {
          imageData: frameImageData,
          w: img.width,
          h: img.height,
          quality: scoreFrameQuality(frameImageData, img.width, img.height),
        }
      }

      const burst = []
      for (let i = 0; i < NATIVE_BURST_FRAMES; i++) {
        const { value } = await CameraPreview.captureSample({ quality: 92 })
        burst.push(await decodeSample(value))
        if (i < NATIVE_BURST_FRAMES - 1) await sleep(NATIVE_BURST_DELAY_MS)
      }
      const bestFrame = burst.sort((a, b) => b.quality - a.quality)[0]
      imageData = bestFrame.imageData
      w = bestFrame.w
      h = bestFrame.h
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
    let bestCardImage = null

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
          bestCardImage = cardImageData
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
        cardImageData: null,
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
      cardImageData: bestCardImage,
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
      let bestObservedCardImage = null
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
          bestObservedCardImage = result.cardImageData
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
      const preOcrAcceptance = shouldAcceptMatch({
        best: stableVote?.best ?? bestObserved,
        gap: bestObservedGap ?? 0,
        stableCount: stableVote?.count ?? 0,
        ocrSupport: 0,
        ocrConfidence: 0,
      })
      const needsOcr = !preOcrAcceptance.accepted && !!bestObservedCardImage && !!bestObserved
      const ocrResult = needsOcr ? await recognizeCardName(bestObservedCardImage) : null
      const ocrSupport = bestObserved ? nameSupportScore(ocrResult?.text, bestObserved.name) : 0
      const acceptance = shouldAcceptMatch({
        best: stableVote?.best ?? bestObserved,
        gap: bestObservedGap ?? 0,
        stableCount: stableVote?.count ?? 0,
        ocrSupport,
        ocrConfidence: ocrResult?.confidence ?? 0,
      })
      const match = acceptance.accepted ? (stableVote?.best ?? bestObserved) : null

      if (DEBUG && mountedRef.current) {
        setDebugInfo({
          stage: match
            ? `MATCHED ${stableVote?.count ?? 0}/${STABILITY_SAMPLES} (${bestObservedGap ?? '?'})`
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
          decision: acceptance.reason,
          ocrText: needsOcr ? (ocrResult?.text || '-') : '(skipped)',
          ocrConfidence: needsOcr ? (ocrResult ? `${ocrResult.confidence.toFixed(0)}%` : '-') : '-',
          ocrSupport: needsOcr ? `${Math.round(ocrSupport * 100)}%` : '-',
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
  }, [isReady, onMatch, recognizeCardName, scanSingleFrame, scanning])

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
                <div><b>Decision:</b> {debugInfo.decision}</div>
                <div><b>OCR:</b> {debugInfo.ocrText}</div>
                <div><b>OCR Conf:</b> {debugInfo.ocrConfidence}</div>
                <div><b>OCR Match:</b> {debugInfo.ocrSupport}</div>
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
          <div className={styles.controlBar}>
            <button className={styles.controlBtn} onClick={handleSwitchCamera}>
              {cameraPosition === 'rear' ? 'Rear Camera' : 'Front Camera'}
            </button>
            <button className={styles.controlBtn} onClick={handleRestartCamera}>
              Restart Camera
            </button>
            {flashModes.length > 0 && (
              <select
                className={styles.controlSelect}
                value={flashMode}
                onChange={e => handleFlashMode(e.target.value)}
              >
                {flashModes.map(mode => (
                  <option key={mode} value={mode}>{`Flash: ${mode}`}</option>
                ))}
              </select>
            )}
          </div>
          <div className={styles.controlHint}>
            {isNative
              ? `Camera ${cameraStarted ? 'active' : 'inactive'} · pinch preview to zoom · tap preview to focus`
              : `Camera ${cameraStarted ? 'active' : 'inactive'} · browser camera controls are limited`}
          </div>
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
