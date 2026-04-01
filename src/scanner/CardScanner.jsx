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
import { sfGet } from '../lib/scryfall'
import { databaseService } from './DatabaseService'
import {
  waitForOpenCV,
  detectCardCorners, warpCard, cropArtRegion, computePHash256, createNameStripCanvases,
} from './ScannerEngine'
import styles from './CardScanner.module.css'

const MATCH_THRESHOLD = 112
const MATCH_MIN_GAP = 12
const MATCH_STRONG_THRESHOLD = 124
const MATCH_STRONG_SINGLE = 96
const MATCH_MIN_GAP_WITH_OCR = 6
const MATCH_VERY_STRONG_DISTANCE = 56
const MATCH_COOLDOWN = 3000
const PRIMARY_CROP_VARIANTS = [
  { xOffset: 0, yOffset: 0 },
  { xOffset: 0, yOffset: -10 },
  { xOffset: 0, yOffset: 10 },
  { xOffset: 0, yOffset: 0, inset: 6 },
]
const FAST_PRIMARY_VARIANTS = [PRIMARY_CROP_VARIANTS[0]]
const STABILITY_SAMPLES = 3
const STABILITY_REQUIRED = 2
const SAMPLE_DELAY_MS = 80
const DEBUG = true
const NATIVE_CAPTURE_SETTLE_MS = 120
const OCR_MIN_CONFIDENCE = 32

const normalizeName = (value = '') =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function levenshteinDistance(a = '', b = '') {
  const rows = a.length + 1
  const cols = b.length + 1
  const dp = Array.from({ length: rows }, () => new Uint16Array(cols))
  for (let i = 0; i < rows; i++) dp[i][0] = i
  for (let j = 0; j < cols; j++) dp[0][j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      )
    }
  }
  return dp[a.length][b.length]
}

function stringSimilarity(a = '', b = '') {
  if (!a || !b) return 0
  if (a === b) return 1
  return 1 - levenshteinDistance(a, b) / Math.max(a.length, b.length)
}

function nameSupportScore(ocrText, candidateName) {
  const ocr = normalizeName(ocrText)
  const cand = normalizeName(candidateName)
  if (!ocr || !cand) return 0
  if (ocr === cand) return 1
  if (cand.includes(ocr) || ocr.includes(cand)) return 0.92

  const ocrWords = ocr.split(' ').filter(Boolean)
  const candWords = cand.split(' ').filter(Boolean)
  const wordSpaceScore = stringSimilarity(ocr, cand)
  const compactScore = stringSimilarity(ocr.replace(/ /g, ''), cand.replace(/ /g, ''))
  if (!ocrWords.length || !candWords.length) return Math.max(wordSpaceScore, compactScore)
  let hits = 0
  for (const word of ocrWords) {
    if (candWords.some(cw => cw === word || cw.startsWith(word) || word.startsWith(cw))) hits++
  }
  const tokenScore = hits / Math.max(ocrWords.length, candWords.length)
  return Math.max(tokenScore, compactScore, wordSpaceScore * 0.95)
}

function shouldAcceptMatch({ best, gap, stableCount, ocrSupport, ocrConfidence, sameNameCluster = false }) {
  if (!best) return { accepted: false, reason: 'no best candidate' }
  if (stableCount >= STABILITY_REQUIRED && best.distance <= MATCH_THRESHOLD && gap >= MATCH_MIN_GAP) {
    return { accepted: true, reason: 'stable threshold match' }
  }
  if (stableCount >= STABILITY_REQUIRED && sameNameCluster && best.distance <= MATCH_THRESHOLD) {
    return { accepted: true, reason: 'stable same-name printing cluster' }
  }
  if (stableCount >= STABILITY_REQUIRED && best.distance <= MATCH_STRONG_THRESHOLD && gap >= MATCH_MIN_GAP_WITH_OCR) {
    return { accepted: true, reason: 'stable relaxed match' }
  }
  if (stableCount >= 1 && sameNameCluster && best.distance <= MATCH_STRONG_THRESHOLD) {
    return { accepted: true, reason: 'same-name printing cluster' }
  }
  if (stableCount >= 1 && best.distance <= MATCH_STRONG_SINGLE && gap >= MATCH_MIN_GAP_WITH_OCR) {
    return { accepted: true, reason: 'single strong frame' }
  }
  if (ocrSupport >= 0.72 && ocrConfidence >= OCR_MIN_CONFIDENCE && best.distance <= MATCH_STRONG_THRESHOLD) {
    return { accepted: true, reason: 'ocr verified best match' }
  }
  if (best.distance <= MATCH_VERY_STRONG_DISTANCE && ocrSupport >= 0.58 && ocrConfidence >= OCR_MIN_CONFIDENCE) {
    return { accepted: true, reason: 'very strong visual match with moderate ocr support' }
  }
  if (stableCount < STABILITY_REQUIRED) return { accepted: false, reason: 'insufficient stable votes' }
  if (best.distance > MATCH_STRONG_THRESHOLD) return { accepted: false, reason: `distance too high (${best.distance})` }
  if (sameNameCluster) return { accepted: false, reason: 'same-name cluster still too weak' }
  if (gap < MATCH_MIN_GAP_WITH_OCR) return { accepted: false, reason: `gap too small (${gap})` }
  return { accepted: false, reason: 'best candidate not confident enough' }
}

function isDecisiveCandidate(best, gap) {
  if (!best) return false
  return (
    (best.distance <= MATCH_THRESHOLD && gap >= MATCH_MIN_GAP) ||
    (best.distance <= MATCH_STRONG_SINGLE && gap >= MATCH_MIN_GAP_WITH_OCR)
  )
}

function getStableVote(votes) {
  return [...votes.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return a.best.distance - b.best.distance
  })[0] ?? null
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
  const [hashLoadInfo, setHashLoadInfo] = useState(databaseService.status)
  const [flashModes, setFlashModes] = useState([])
  const [flashMode, setFlashMode] = useState('off')
  const [cameraStarted, setCameraStarted] = useState(false)
  const [cameraRestartTick, setCameraRestartTick] = useState(0)

  const isReady = cvReady && dbReady
  const availableFlashModes = flashModes.includes('torch')
    ? flashModes.filter(mode => mode === 'off' || mode === 'torch')
    : flashModes
  const hashProgressVisible = !!hashLoadInfo && (!databaseService.isFullyLoaded || preparing)
  const hashProgressLabel = hashLoadInfo?.phase
    ? `${hashLoadInfo.phase}${hashLoadInfo.totalCount ? ` ${hashLoadInfo.loadedCount?.toLocaleString?.() ?? 0}/${hashLoadInfo.totalCount.toLocaleString()}` : ''}`
    : null

  useEffect(() => {
    mountedRef.current = true

    ;(async () => {
      try {
        await databaseService.init(status => {
          if (!mountedRef.current) return
          setHashLoadInfo(status)
          setCardCount(status.loadedCount ?? 0)
        })
        const cvPromise = waitForOpenCV()

        await databaseService.waitUntilFullyLoaded()
        if (!mountedRef.current) return
        setDbReady(true)
        setCardCount(databaseService.cardCount)
        setHashLoadInfo(databaseService.status)

        if (databaseService.cardCount === 0) {
          await databaseService.sync(status => {
            if (!mountedRef.current) return
            setHashLoadInfo(status)
            setCardCount(status.loadedCount ?? 0)
          })
          await databaseService.waitUntilFullyLoaded()
          if (!mountedRef.current) return
          setCardCount(databaseService.cardCount)
          setDbReady(true)
          setHashLoadInfo(databaseService.status)
        }

        await cvPromise
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
            position: 'rear',
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
  }, [cameraRestartTick, isNative])

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

  const handleFlashMode = useCallback(async (nextMode) => {
    setFlashMode(nextMode)
  }, [])

  const handleRestartCamera = useCallback(async () => {
    setScanResult(null)
    if (isNative) {
      try {
        await CameraPreview.stop().catch(() => {})
      } catch {}
      await sleep(120)
    }
    setCameraRestartTick(t => t + 1)
  }, [isNative])

  const recognizeCardName = useCallback(async (cardImageData) => {
    try {
      const worker = await initScanner()
      if (!worker || !cardImageData) return null
      const variants = createNameStripCanvases(cardImageData)
      let bestResult = null
      for (const variant of variants) {
        const { data } = await worker.recognize(variant.canvas)
        const text = data.text?.trim()?.replace(/[^A-Za-z0-9 ',.\-]/g, '') || ''
        if (!text) continue
        const confidence = data.confidence ?? 0
        const score = confidence + Math.min(text.length, 24) * 1.25
        if (!bestResult || score > bestResult.score) {
          bestResult = { text, confidence, score, variant: variant.label }
        }
      }
      return bestResult ? { text: bestResult.text, confidence: bestResult.confidence, variant: bestResult.variant } : null
    } catch {
      return null
    }
  }, [])

  const resolveNewestPrintingFromOcr = useCallback(async (ocrText) => {
    if (!normalizeName(ocrText)) return null
    try {
      const resolved = await sfGet(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(ocrText)}`)
      if (!resolved?.name) return null

      const support = nameSupportScore(ocrText, resolved.name)
      if (support < 0.42) return null

      const prints = await sfGet(
        `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`!"${resolved.name}"`)}&unique=prints&order=released&dir=desc`
      )
      const newest = prints?.data?.[0] ?? resolved
      const imageUri = newest.image_uris?.normal
        || newest.image_uris?.large
        || newest.card_faces?.[0]?.image_uris?.normal
        || newest.card_faces?.[0]?.image_uris?.large
        || null

      return {
        id: newest.id,
        name: newest.name,
        setCode: newest.set,
        collNum: newest.collector_number,
        imageUri,
        releasedAt: newest.released_at ?? null,
        ocrSupport: support,
        source: 'ocr',
      }
    } catch {
      return null
    }
  }, [])



  const captureFrame = useCallback(async () => {
    let imageData, w, h

    if (isNative) {
      await sleep(NATIVE_CAPTURE_SETTLE_MS)

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

      const { value } = await CameraPreview.captureSample({ quality: 92 })
      const bestFrame = await decodeSample(value)
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
    let bestSource = corners ? 'corners' : 'no corners'
    let bestCardImage = null
    let ocrCardImage = null
    let bestGap = 0

    const updateBestMatch = (candidate, runnerUp, candidateCount, totalCount, variant, sourceLabel, cardImageData) => {
      if (!candidate) return false
      const gap = runnerUp ? runnerUp.distance - candidate.distance : 256
      if (!best || candidate.distance < best.distance) {
        best = candidate
        second = runnerUp
        bestStats = { candidateCount, totalCount }
        bestVariant = variant
        bestSource = sourceLabel
        bestCardImage = cardImageData
        bestGap = gap
      }
      return isDecisiveCandidate(best, bestGap)
    }

    const shouldExpandCropSearch = () => {
      if (!best) return true
      if (best.distance > MATCH_THRESHOLD) return true
      if (bestGap < MATCH_MIN_GAP) return true
      return false
    }

    const tryMatchCardImage = (cardImageData, sourceLabel, variants) => {
      for (const variant of variants) {
        const artCrop = cropArtRegion(cardImageData, variant)
        if (!artCrop) continue
        const hash = computePHash256(artCrop)
        if (!hash) continue
        const { best: candidate, second: runnerUp, candidateCount, totalCount } = databaseService.findBestTwoWithStats(hash)
        if (updateBestMatch(candidate, runnerUp, candidateCount, totalCount, variant, sourceLabel, cardImageData)) return
      }
    }

    if (corners) {
      const warped = warpCard(imageData, corners)
      if (warped) {
        ocrCardImage = warped
        tryMatchCardImage(warped, 'corners', FAST_PRIMARY_VARIANTS)
        if (shouldExpandCropSearch()) {
          tryMatchCardImage(warped, 'corners', PRIMARY_CROP_VARIANTS.slice(1))
        }
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
        cardImageData: ocrCardImage,
      }
    }

    const gap = second ? second.distance - best.distance : 256
    const sameNameCluster = !!(best?.name && second?.name && normalizeName(best.name) === normalizeName(second.name))
    return {
      status: best.distance <= MATCH_THRESHOLD && (gap >= MATCH_MIN_GAP || sameNameCluster) ? 'found' : 'notfound',
      stage: `dist ${best.distance}, gap ${gap}`,
      best,
      second,
      gap,
      sameNameCluster,
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
      let bestObservedSameNameCluster = false
      let ocrFallbackCardImage = null
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
          bestObservedSameNameCluster = !!result.sameNameCluster
        }
        if (!ocrFallbackCardImage && result.cardImageData) ocrFallbackCardImage = result.cardImageData

        if (result.status === 'found' && result.best) {
          const previous = votes.get(result.best.id) ?? { count: 0, best: result.best }
          votes.set(result.best.id, {
            count: previous.count + 1,
            best: result.best.distance < previous.best.distance ? result.best : previous.best,
          })
        }

        const stableVote = getStableVote(votes)

        if (stableVote?.count >= STABILITY_REQUIRED) break
        if (isDecisiveCandidate(result.best, result.gap ?? 0)) break
        if (i < STABILITY_SAMPLES - 1) await sleep(SAMPLE_DELAY_MS)
      }

      const stableVote = getStableVote(votes)
      const visualAcceptance = shouldAcceptMatch({
        best: stableVote?.best ?? bestObserved,
        gap: bestObservedGap ?? 0,
        stableCount: stableVote?.count ?? 0,
        ocrSupport: 0,
        ocrConfidence: 0,
        sameNameCluster: bestObservedSameNameCluster,
      })
      let match = visualAcceptance.accepted ? (stableVote?.best ?? bestObserved) : null
      const needsOcr = !match && !!(bestObservedCardImage || ocrFallbackCardImage)
      const ocrResult = needsOcr ? await recognizeCardName(bestObservedCardImage || ocrFallbackCardImage) : null
      const ocrSupport = bestObserved ? nameSupportScore(ocrResult?.text, bestObserved.name) : 0
      const ocrMatch = needsOcr && !!ocrResult?.text
        ? await resolveNewestPrintingFromOcr(ocrResult.text)
        : null
      if (!match && ocrMatch) match = ocrMatch

      if (DEBUG && mountedRef.current) {
        setDebugInfo({
          stage: match
            ? `${match.source === 'ocr' ? 'OCR' : 'MATCHED'} ${stableVote?.count ?? 0}/${STABILITY_SAMPLES} (${bestObservedGap ?? '?'})`
            : bestObserved
              ? `no match - ${bestObserved.distance}/${bestObservedGap ?? '?'}`
              : 'no match - no candidate',
          finalName: match?.name ?? '',
          visualName: bestObserved?.name ?? '',
          visualScore: bestObserved ? `${bestObserved.distance}/${bestObservedGap ?? '?'}` : '-',
          hashes: databaseService.cardCount,
          candidates: bestObservedCandidates,
          total: databaseService.cardCount,
          votes: stableVote?.count ? `${stableVote.count}/${STABILITY_REQUIRED}` : `0/${STABILITY_REQUIRED}`,
          frames: frameSummaries.join(' | '),
          source: match?.source ?? bestObservedSource ?? '-',
          visualSource: bestObservedSource ?? '-',
          cluster: bestObservedSameNameCluster ? 'same-name printings' : '-',
          decision: match?.source === 'ocr' ? 'ocr fallback newest printing' : visualAcceptance.reason,
          ocrText: needsOcr ? (ocrResult?.text || '-') : '(skipped)',
          ocrConfidence: needsOcr ? (ocrResult ? `${ocrResult.confidence.toFixed(0)}%` : '-') : '-',
          ocrSupport: needsOcr ? `${Math.round(ocrSupport * 100)}%` : '-',
          ocrVariant: needsOcr ? (ocrResult?.variant || '-') : '-',
          ocrResolved: ocrMatch ? `${ocrMatch.name} ${ocrMatch.setCode?.toUpperCase?.() ? `(${ocrMatch.setCode.toUpperCase()})` : ''}`.trim() : '-',
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
  }, [isReady, onMatch, recognizeCardName, resolveNewestPrintingFromOcr, scanSingleFrame, scanning])

  return (
    <div className={`${styles.root} ${isNative ? styles.rootNative : ''}`}>
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
          {hashProgressVisible && !errorMsg && (
            <div className={styles.progressCard}>
              <div className={styles.progressHead}>
                <span>Hashes</span>
                <span>{hashLoadInfo.progress ?? 0}%</span>
              </div>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${hashLoadInfo.progress ?? 0}%` }}
                />
              </div>
              <div className={styles.progressMeta}>
                {hashProgressLabel}
                {hashLoadInfo?.source ? ` · ${hashLoadInfo.source}` : ''}
              </div>
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
                <div><b>Final:</b> {debugInfo.finalName || '-'}</div>
                <div><b>Visual:</b> {debugInfo.visualName || '-'}</div>
                <div><b>Dist/Gap:</b> {debugInfo.visualScore}</div>
                <div><b>Votes:</b> {debugInfo.votes}</div>
                <div><b>Source:</b> {debugInfo.source}</div>
                <div><b>Visual Src:</b> {debugInfo.visualSource}</div>
                <div><b>Cluster:</b> {debugInfo.cluster}</div>
                <div><b>Decision:</b> {debugInfo.decision}</div>
                <div><b>Pool:</b> {debugInfo.candidates?.toLocaleString?.() ?? 0}/{debugInfo.total?.toLocaleString?.() ?? cardCount.toLocaleString()}</div>
                <div><b>OCR:</b> {debugInfo.ocrText}</div>
                <div><b>OCR Conf:</b> {debugInfo.ocrConfidence}</div>
                <div><b>OCR Support:</b> {debugInfo.ocrSupport}</div>
                <div><b>OCR Variant:</b> {debugInfo.ocrVariant}</div>
                <div><b>OCR Resolved:</b> {debugInfo.ocrResolved}</div>
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
            <button className={styles.controlBtn} onClick={handleRestartCamera}>
              Restart Camera
            </button>
            {availableFlashModes.length > 0 && (
              <select
                className={styles.controlSelect}
                value={flashMode}
                onChange={e => handleFlashMode(e.target.value)}
              >
                {availableFlashModes.map(mode => (
                  <option key={mode} value={mode}>
                    {mode === 'torch' ? 'Flash: on' : `Flash: ${mode}`}
                  </option>
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

