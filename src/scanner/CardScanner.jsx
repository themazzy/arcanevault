/**
 * CardScanner — full-screen MTG card scanner
 *
 * Native: @capacitor-community/camera-preview renders behind the transparent WebView
 * Web:    getUserMedia() feeds a <video> element
 *
 * Scanned cards accumulate in a pending basket. User can adjust foil,
 * change printing, add manually, then save all at once to a chosen folder.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'
import { CameraPreview } from '@capacitor-community/camera-preview'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { databaseService } from './DatabaseService'
import {
  waitForOpenCV,
  detectCardCorners, warpCard, cropArtRegion, cropCardFromReticle, computePHash256,
} from './ScannerEngine'
import { Select } from '../components/UI'
import { useAuth } from '../components/Auth'
import { sfGet } from '../lib/scryfall'
import { sb } from '../lib/supabase'
import styles from './CardScanner.module.css'

const MATCH_THRESHOLD        = 122
const MATCH_MIN_GAP          = 8
const MATCH_STRONG_THRESHOLD = 134
const MATCH_STRONG_SINGLE    = 108
const PRIMARY_CROP_VARIANTS = [
  { xOffset: 0, yOffset: 0 },
  { xOffset: 0, yOffset: -10 },
  { xOffset: 0, yOffset: 10 },
  { xOffset: 0, yOffset: 0, inset: 6 },
]
const FAST_PRIMARY_VARIANTS = [PRIMARY_CROP_VARIANTS[0]]
const STABILITY_SAMPLES   = 3
const STABILITY_REQUIRED  = 2
const SAMPLE_DELAY_MS     = 80
const DEBUG               = true
const NATIVE_CAPTURE_SETTLE_MS = 120
const PENDING_KEY         = 'arcanevault_scan_basket'

// ── Pending basket helpers ────────────────────────────────────────────────────

function loadPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function savePending(cards) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(cards)) } catch {}
}

let _uidCounter = Date.now()
function nextUid() { return String(++_uidCounter) }

function getOwnedCardKey(c) {
  return [c.set_code, c.collector_number, c.foil ? 1 : 0, c.language || 'en', c.condition || 'near_mint'].join('|')
}

async function batchSaveCards({ userId, cards, folderId, folderType }) {
  if (!cards.length || !folderId) return

  if (folderType === 'list') {
    const items = cards.map(c => ({
      folder_id: folderId,
      user_id: userId,
      name: c.name,
      set_code: c.setCode,
      collector_number: c.collNum,
      scryfall_id: c.id,
      foil: c.foil,
      qty: c.qty ?? 1,
    }))
    const { error } = await sb.from('list_items')
      .upsert(items, { onConflict: 'folder_id,set_code,collector_number,foil' })
    if (error) throw new Error(error.message)
    return
  }

  // Binder or deck — upsert owned cards first
  const owned = cards.map(c => ({
    user_id: userId,
    name: c.name,
    set_code: c.setCode,
    collector_number: c.collNum,
    scryfall_id: c.id,
    foil: c.foil,
    qty: c.qty ?? 1,
    condition: 'near_mint',
    language: 'en',
    currency: 'EUR',
  }))

  const setCodes = [...new Set(owned.map(c => c.set_code))]
  const { data: existing, error: existErr } = await sb.from('cards')
    .select('id,set_code,collector_number,foil,language,condition,qty')
    .eq('user_id', userId)
    .in('set_code', setCodes)
  if (existErr) throw new Error(existErr.message)

  const existByKey = new Map((existing || []).map(c => [getOwnedCardKey({ ...c, set_code: c.set_code }), c]))
  const upsertRows = owned.map(c => {
    const key = getOwnedCardKey({ set_code: c.set_code, collector_number: c.collector_number, foil: c.foil, language: c.language, condition: c.condition })
    const prev = existByKey.get(key)
    return prev ? { ...prev, ...c, id: prev.id, qty: (prev.qty || 0) + c.qty } : c
  })

  const { error: upsertErr } = await sb.from('cards')
    .upsert(upsertRows, { onConflict: 'user_id,set_code,collector_number,foil,language,condition' })
  if (upsertErr) throw new Error(upsertErr.message)

  // Re-query to get IDs
  const { data: saved, error: savedErr } = await sb.from('cards')
    .select('id,set_code,collector_number,foil,language,condition')
    .eq('user_id', userId)
    .in('set_code', setCodes)
  if (savedErr) throw new Error(savedErr.message)

  const savedByKey = new Map((saved || []).map(c => [getOwnedCardKey({ ...c, set_code: c.set_code }), c]))
  const table = folderType === 'deck' ? 'deck_allocations' : 'folder_cards'
  const fk    = folderType === 'deck' ? 'deck_id' : 'folder_id'

  const { data: existLinks, error: linksErr } = await sb.from(table).select('card_id,qty').eq(fk, folderId)
  if (linksErr) throw new Error(linksErr.message)
  const existLinkQty = new Map((existLinks || []).map(l => [l.card_id, l.qty || 1]))

  const links = owned.map(c => {
    const key = getOwnedCardKey({ set_code: c.set_code, collector_number: c.collector_number, foil: c.foil, language: c.language, condition: c.condition })
    const sc = savedByKey.get(key)
    if (!sc) return null
    const base = { card_id: sc.id, qty: (existLinkQty.get(sc.id) || 0) + (c.qty ?? 1) }
    return folderType === 'deck'
      ? { ...base, deck_id: folderId, user_id: userId }
      : { ...base, folder_id: folderId }
  }).filter(Boolean)

  if (links.length) {
    const { error: linkErr } = await sb.from(table).upsert(links, { onConflict: `${fk},card_id` })
    if (linkErr) throw new Error(linkErr.message)
  }
}

// ── Detection helpers ─────────────────────────────────────────────────────────

const normalizeName = (value = '') =>
  value.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

function shouldAcceptMatch({ best, gap, stableCount, sameNameCluster = false }) {
  if (!best) return { accepted: false, reason: 'no best candidate' }
  if (stableCount >= STABILITY_REQUIRED && best.distance <= MATCH_THRESHOLD && gap >= MATCH_MIN_GAP)
    return { accepted: true, reason: 'stable threshold match' }
  if (stableCount >= STABILITY_REQUIRED && sameNameCluster && best.distance <= MATCH_THRESHOLD)
    return { accepted: true, reason: 'stable same-name printing cluster' }
  if (stableCount >= STABILITY_REQUIRED && best.distance <= MATCH_STRONG_THRESHOLD && gap >= MATCH_MIN_GAP)
    return { accepted: true, reason: 'stable relaxed match' }
  if (stableCount >= 1 && sameNameCluster && best.distance <= MATCH_STRONG_THRESHOLD)
    return { accepted: true, reason: 'same-name printing cluster' }
  if (stableCount >= 1 && best.distance <= MATCH_STRONG_SINGLE && gap >= MATCH_MIN_GAP)
    return { accepted: true, reason: 'single strong frame' }
  if (stableCount < STABILITY_REQUIRED) return { accepted: false, reason: 'insufficient stable votes' }
  if (best.distance > MATCH_STRONG_THRESHOLD) return { accepted: false, reason: `distance too high (${best.distance})` }
  if (gap < MATCH_MIN_GAP) return { accepted: false, reason: `gap too small (${gap})` }
  return { accepted: false, reason: 'best candidate not confident enough' }
}

function isDecisiveCandidate(best, gap) {
  if (!best) return false
  return (
    (best.distance <= MATCH_THRESHOLD && gap >= MATCH_MIN_GAP) ||
    (best.distance <= MATCH_STRONG_SINGLE && gap >= MATCH_MIN_GAP)
  )
}

function getStableVote(votes) {
  return [...votes.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return a.best.distance - b.best.distance
  })[0] ?? null
}


const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function getCardImg(sf) {
  if (!sf) return null
  if (sf.image_uris?.normal) return sf.image_uris.normal
  if (sf.card_faces?.[0]?.image_uris?.normal) return sf.card_faces[0].image_uris.normal
  return null
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CardScanner({ onMatch, onClose }) {
  const { user } = useAuth()
  const isNative = Capacitor.isNativePlatform()

  const videoRef    = useRef(null)
  const canvasRef   = useRef(null)
  const mountedRef  = useRef(true)

  // ── Scanner state ──────────────────────────────────────────────────────────
  const [cvReady, setCvReady]     = useState(false)
  const [dbReady, setDbReady]     = useState(false)
  const [preparing, setPreparing] = useState(true)
  const [errorMsg, setErrorMsg]   = useState(null)
  const [scanning, setScanning]   = useState(false)
  const [scanResult, setScanResult] = useState(null)   // 'found' | 'notfound' | null
  const [cardCount, setCardCount] = useState(0)
  const [debugInfo, setDebugInfo] = useState(null)
  const [hashLoadInfo, setHashLoadInfo] = useState(databaseService.status)
  const [flashModes, setFlashModes] = useState([])
  const [flashMode, setFlashMode]   = useState('off')
  const [cameraStarted, setCameraStarted] = useState(false)
  const [cameraRestartTick, setCameraRestartTick] = useState(0)

  // ── Pending basket ─────────────────────────────────────────────────────────
  const [pendingCards, setPendingCards] = useState(() => loadPending())
  const [basketExpanded, setBasketExpanded] = useState(false)

  // ── Printing picker ────────────────────────────────────────────────────────
  const [printingPickerFor, setPrintingPickerFor]         = useState(null)   // uid
  const [printingPickerResults, setPrintingPickerResults] = useState([])
  const [printingPickerLoading, setPrintingPickerLoading] = useState(false)

  // ── Manual search ──────────────────────────────────────────────────────────
  const [manualSearchOpen, setManualSearchOpen]     = useState(false)
  const [manualSearchQuery, setManualSearchQuery]   = useState('')
  const [manualSearchResults, setManualSearchResults] = useState([])
  const [manualSearchLoading, setManualSearchLoading] = useState(false)

  // ── Add flow (folder picker + save) ───────────────────────────────────────
  const [addFlowOpen, setAddFlowOpen]             = useState(false)
  const [addFlowFolderType, setAddFlowFolderType] = useState('binder')
  const [addFlowFolders, setAddFlowFolders]       = useState([])
  const [addFlowFolderSearch, setAddFlowFolderSearch] = useState('')
  const [addFlowSelectedFolder, setAddFlowSelectedFolder] = useState(null)
  const [addFlowSaving, setAddFlowSaving]         = useState(false)
  const [addFlowError, setAddFlowError]           = useState(null)
  const [addFlowFoldersLoading, setAddFlowFoldersLoading] = useState(false)

  const isReady = cvReady && dbReady
  const availableFlashModes = flashModes.includes('torch')
    ? flashModes.filter(m => m === 'off' || m === 'torch')
    : flashModes
  const hashProgressVisible = !!hashLoadInfo && (!databaseService.isFullyLoaded || preparing)

  // Persist basket to localStorage whenever it changes
  useEffect(() => { savePending(pendingCards) }, [pendingCards])

  // ── Init DB + OpenCV ───────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true
    ;(async () => {
      try {
        const cvPromise = waitForOpenCV()
        await databaseService.init(status => {
          if (!mountedRef.current) return
          setHashLoadInfo(status)
          setCardCount(status.loadedCount ?? 0)
        })
        if (!mountedRef.current) return
        setCardCount(databaseService.cardCount)
        setHashLoadInfo(databaseService.status)
        if (databaseService.cardCount > 0) setDbReady(true)

        if (databaseService.cardCount === 0) {
          await databaseService.sync(status => {
            if (!mountedRef.current) return
            setHashLoadInfo(status)
            setCardCount(status.loadedCount ?? 0)
          })
          await databaseService.waitUntilFullyLoaded()
          if (!mountedRef.current) return
          setCardCount(databaseService.cardCount)
          setHashLoadInfo(databaseService.status)
          if (databaseService.cardCount > 0) setDbReady(true)
        }

        await cvPromise
        if (!mountedRef.current) return
        setCvReady(true)
        setPreparing(false)
      } catch (e) {
        if (mountedRef.current) setErrorMsg(e.message)
      }
    })()
    return () => { mountedRef.current = false }
  }, [])

  // ── Camera start/stop ──────────────────────────────────────────────────────
  useEffect(() => {
    let started = false
    ;(async () => {
      try {
        if (mountedRef.current) { setErrorMsg(null); setCameraStarted(false) }
        if (isNative) {
          await CameraPreview.start({
            position: 'rear', toBack: true,
            width: window.screen.width, height: window.screen.height,
            disableAudio: true, enableHighResolution: true,
            enableZoom: true, tapFocus: true,
          })
          const startedState = await CameraPreview.isCameraStarted().catch(() => ({ value: true }))
          if (!mountedRef.current) return
          setCameraStarted(!!startedState?.value)
          const supported = await CameraPreview.getSupportedFlashModes().catch(() => ({ result: [] }))
          if (!mountedRef.current) return
          setFlashModes(Array.isArray(supported?.result) ? supported.result : [])
          const desiredFlash = (supported?.result || []).includes(flashMode)
            ? flashMode : ((supported?.result || []).includes('off') ? 'off' : '')
          if (desiredFlash && mountedRef.current) setFlashMode(desiredFlash)
        } else {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
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
              if (Object.keys(advanced).length) track.applyConstraints({ advanced: [advanced] }).catch(() => {})
            }
            setCameraStarted(true)
          } else {
            stream.getTracks().forEach(t => t.stop())
            return
          }
        }
        started = true
      } catch (e) {
        if (mountedRef.current) { setErrorMsg('Camera: ' + e.message); setCameraStarted(false) }
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
    if (isNative) { CameraPreview.setFlashMode({ flashMode }).catch(() => {}); return }
    const track = videoRef.current?.srcObject?.getVideoTracks?.()?.[0]
    if (track) track.applyConstraints({ advanced: [{ torch: flashMode === 'torch' || flashMode === 'on' }] }).catch(() => {})
  }, [cameraStarted, flashMode, isNative])

  // ── Basket operations ──────────────────────────────────────────────────────

  const addToPending = useCallback((match) => {
    const entry = {
      uid:      nextUid(),
      id:       match.id,
      name:     match.name,
      setCode:  match.setCode,
      collNum:  match.collNum,
      imageUri: match.imageUri,
      foil:     false,
      qty:      1,
    }
    setPendingCards(prev => {
      // Deduplicate: if same card+foil already in basket, increment qty
      const idx = prev.findIndex(c => c.id === entry.id && c.foil === entry.foil)
      if (idx !== -1) {
        const next = [...prev]
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 }
        return next
      }
      return [entry, ...prev]
    })
    setBasketExpanded(true)
  }, [])

  const removePending = useCallback((uid) => {
    setPendingCards(prev => prev.filter(c => c.uid !== uid))
  }, [])

  const updatePending = useCallback((uid, patch) => {
    setPendingCards(prev => prev.map(c => c.uid === uid ? { ...c, ...patch } : c))
  }, [])

  // ── Printing picker ────────────────────────────────────────────────────────

  const openPrintingPicker = useCallback(async (uid) => {
    const card = pendingCards.find(c => c.uid === uid)
    if (!card) return
    setPrintingPickerFor(uid)
    setPrintingPickerLoading(true)
    setPrintingPickerResults([])
    try {
      const encodedName = encodeURIComponent(`!"${card.name}"`)
      const data = await sfGet(`/cards/search?q=${encodedName}&unique=prints&order=released&dir=desc`)
      if (mountedRef.current) setPrintingPickerResults(data?.data ?? [])
    } catch { /* ignore */ }
    if (mountedRef.current) setPrintingPickerLoading(false)
  }, [pendingCards])

  const selectPrinting = useCallback((uid, sf) => {
    const imgUri = getCardImg(sf)
    updatePending(uid, {
      id:       sf.id,
      name:     sf.name,
      setCode:  sf.set,
      collNum:  sf.collector_number,
      imageUri: imgUri,
    })
    setPrintingPickerFor(null)
    setPrintingPickerResults([])
  }, [updatePending])

  // ── Manual search ──────────────────────────────────────────────────────────

  const handleManualSearch = useCallback(async (q) => {
    setManualSearchQuery(q)
    if (q.trim().length < 2) { setManualSearchResults([]); return }
    setManualSearchLoading(true)
    try {
      const data = await sfGet(`/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=name`)
      if (mountedRef.current) setManualSearchResults(data?.data?.slice(0, 20) ?? [])
    } catch { if (mountedRef.current) setManualSearchResults([]) }
    if (mountedRef.current) setManualSearchLoading(false)
  }, [])

  const addManualCard = useCallback((sf) => {
    const imgUri = getCardImg(sf)
    const entry = {
      uid:      nextUid(),
      id:       sf.id,
      name:     sf.name,
      setCode:  sf.set,
      collNum:  sf.collector_number,
      imageUri: imgUri,
      foil:     false,
      qty:      1,
    }
    setPendingCards(prev => [entry, ...prev])
    setManualSearchOpen(false)
    setManualSearchQuery('')
    setManualSearchResults([])
    setBasketExpanded(true)
  }, [])

  // ── Add flow ───────────────────────────────────────────────────────────────

  const openAddFlow = useCallback(async () => {
    setAddFlowOpen(true)
    setAddFlowSelectedFolder(null)
    setAddFlowError(null)
    setAddFlowFolderSearch('')
    setAddFlowFoldersLoading(true)
    try {
      const { data, error } = await sb.from('folders')
        .select('id,name,type')
        .eq('user_id', user?.id)
        .order('name')
      if (error) throw new Error(error.message)
      setAddFlowFolders(data ?? [])
    } catch (e) {
      setAddFlowError(e.message)
    }
    setAddFlowFoldersLoading(false)
  }, [user])

  const saveAllPending = useCallback(async () => {
    if (!addFlowSelectedFolder || !pendingCards.length || !user?.id) return
    const folder = addFlowFolders.find(f => f.id === addFlowSelectedFolder)
    if (!folder) return
    setAddFlowSaving(true)
    setAddFlowError(null)
    try {
      await batchSaveCards({
        userId: user.id,
        cards: pendingCards,
        folderId: addFlowSelectedFolder,
        folderType: folder.type,
      })
      setPendingCards([])
      setAddFlowOpen(false)
      setAddFlowSelectedFolder(null)
    } catch (e) {
      setAddFlowError(e.message)
    }
    setAddFlowSaving(false)
  }, [addFlowSelectedFolder, pendingCards, addFlowFolders, user])

  // ── Capture + scan logic ───────────────────────────────────────────────────

  const captureFrame = useCallback(async () => {
    if (isNative) {
      await sleep(NATIVE_CAPTURE_SETTLE_MS)
      const { value } = await CameraPreview.captureSample({ quality: 92 })
      const img = await new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = reject
        image.src = 'data:image/jpeg;base64,' + value
      })
      const canvas = document.createElement('canvas')
      canvas.width = img.width; canvas.height = img.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const imageData = ctx.getImageData(0, 0, img.width, img.height)
      return { imageData, w: img.width, h: img.height }
    } else {
      const vid = videoRef.current
      if (!vid?.videoWidth) return null
      const canvas = canvasRef.current
      canvas.width = vid.videoWidth; canvas.height = vid.videoHeight
      canvas.getContext('2d').drawImage(vid, 0, 0)
      return { imageData: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), w: canvas.width, h: canvas.height }
    }
  }, [isNative])

  const scanSingleFrame = useCallback(async () => {
    const frame = await captureFrame()
    if (!frame) return { status: 'error', stage: 'no frame', best: null, second: null, candidateCount: 0, totalCount: 0 }

    const { imageData, w, h } = frame
    const corners = detectCardCorners(imageData, w, h)

    let best = null, second = null
    let bestStats = { candidateCount: 0, totalCount: databaseService.cardCount }
    let bestVariant = null, bestSource = corners ? 'corners' : 'no corners'
    let bestGap = 0

    const updateBest = (candidate, runnerUp, candidateCount, totalCount, variant, sourceLabel) => {
      if (!candidate) return false
      const gap = runnerUp ? runnerUp.distance - candidate.distance : 256
      if (!best || candidate.distance < best.distance) {
        best = candidate; second = runnerUp
        bestStats = { candidateCount, totalCount }
        bestVariant = variant; bestSource = sourceLabel; bestGap = gap
      }
      return isDecisiveCandidate(best, bestGap)
    }

    const shouldExpand = () => !best || best.distance > MATCH_THRESHOLD || bestGap < MATCH_MIN_GAP

    const tryMatch = (cardImg, sourceLabel, variants) => {
      for (const variant of variants) {
        const artCrop = cropArtRegion(cardImg, variant)
        if (!artCrop) continue
        const hash = computePHash256(artCrop)
        if (!hash) continue
        const { best: c, second: r, candidateCount, totalCount } = databaseService.findBestTwoWithStats(hash)
        if (updateBest(c, r, candidateCount, totalCount, variant, sourceLabel)) return
      }
    }

    if (corners) {
      const warped = warpCard(imageData, corners)
      if (warped) {
        tryMatch(warped, 'corners', FAST_PRIMARY_VARIANTS)
        if (shouldExpand()) tryMatch(warped, 'corners', PRIMARY_CROP_VARIANTS.slice(1))
      }
    }
    if (shouldExpand()) {
      const reticle = cropCardFromReticle(imageData, w, h, window.innerWidth, window.innerHeight)
      if (reticle) {
        tryMatch(reticle, 'reticle', FAST_PRIMARY_VARIANTS)
        if (shouldExpand()) tryMatch(reticle, 'reticle', PRIMARY_CROP_VARIANTS.slice(1))
      }
    }

    if (!best) return { status: 'notfound', stage: 'no candidate', best: null, second: null, candidateCount: bestStats.candidateCount, totalCount: bestStats.totalCount, source: bestSource }

    const gap = second ? second.distance - best.distance : 256
    const sameNameCluster = !!(best?.name && second?.name && normalizeName(best.name) === normalizeName(second.name))
    return {
      status: best.distance <= MATCH_THRESHOLD && (gap >= MATCH_MIN_GAP || sameNameCluster) ? 'found' : 'notfound',
      stage: `dist ${best.distance}, gap ${gap}`,
      best, second, gap, sameNameCluster,
      candidateCount: bestStats.candidateCount, totalCount: bestStats.totalCount,
      variant: bestVariant, source: bestSource,
    }
  }, [captureFrame])

  const handleScan = useCallback(async () => {
    if (!isReady || scanning || !mountedRef.current) return
    setScanning(true)
    setScanResult(null)
    try {
      const votes = new Map()
      let bestObserved = null, bestObservedGap = null
      let bestObservedCandidates = null, bestObservedVariant = null
      let bestObservedSource = null, bestObservedSameNameCluster = false
      const frameSummaries = []

      for (let i = 0; i < STABILITY_SAMPLES; i++) {
        const result = await scanSingleFrame()
        frameSummaries.push(result.best ? `${i+1}:${result.best.distance}/${result.gap??'?'}` : `${i+1}:${result.stage}`)
        if (result.best && (!bestObserved || result.best.distance < bestObserved.distance)) {
          bestObserved = result.best
          bestObservedGap = result.second ? result.second.distance - result.best.distance : 256
          bestObservedCandidates = result.candidateCount
          bestObservedVariant = result.variant
          bestObservedSource = result.source
          bestObservedSameNameCluster = !!result.sameNameCluster
        }
        if (result.status === 'found' && result.best) {
          const prev = votes.get(result.best.id) ?? { count: 0, best: result.best }
          votes.set(result.best.id, {
            count: prev.count + 1,
            best: result.best.distance < prev.best.distance ? result.best : prev.best,
          })
        }
        const stableVote = getStableVote(votes)
        if (stableVote?.count >= STABILITY_REQUIRED) break
        if (isDecisiveCandidate(result.best, result.gap ?? 0)) break
        if (i < STABILITY_SAMPLES - 1) await sleep(SAMPLE_DELAY_MS)
      }

      const stableVote = getStableVote(votes)
      const acceptance = shouldAcceptMatch({
        best: stableVote?.best ?? bestObserved,
        gap: bestObservedGap ?? 0,
        stableCount: stableVote?.count ?? 0,
        sameNameCluster: bestObservedSameNameCluster,
      })
      const match = acceptance.accepted ? (stableVote?.best ?? bestObserved) : null

      if (DEBUG && mountedRef.current) {
        setDebugInfo({
          dist: bestObserved?.distance ?? '-',
          gap:  bestObservedGap ?? '-',
          src:  bestObservedSource ?? '-',
          votes: stableVote?.count ?? 0,
          decision: acceptance.reason,
          name: match?.name ?? '',
        })
      }

      if (!match) { setScanResult('notfound'); return }

      setScanResult('found')
      addToPending(match)
      try { await Haptics.impact({ style: ImpactStyle.Medium }) } catch {}
      onMatch?.(match)
    } catch (e) {
      if (DEBUG && mountedRef.current) setDebugInfo(d => ({ ...(d||{}), decision: `error: ${e.message}` }))
      setScanResult('error')
    } finally {
      if (mountedRef.current) setScanning(false)
    }
  }, [isReady, scanning, scanSingleFrame, addToPending, onMatch])

  // ── Derived ────────────────────────────────────────────────────────────────

  const handleRestartCamera = useCallback(async () => {
    setScanResult(null)
    if (isNative) { try { await CameraPreview.stop().catch(() => {}) } catch {} await sleep(120) }
    setCameraRestartTick(t => t + 1)
  }, [isNative])

  const handleFlashMode = useCallback((nextMode) => { setFlashMode(nextMode) }, [])

  const filteredFolders = addFlowFolders.filter(f => {
    const typeMatch = addFlowFolderType === 'binder' ? f.type === 'binder'
      : addFlowFolderType === 'deck' ? (f.type === 'deck' || f.type === 'builder_deck')
      : f.type === 'list'
    if (!typeMatch) return false
    if (!addFlowFolderSearch.trim()) return true
    return f.name.toLowerCase().includes(addFlowFolderSearch.toLowerCase())
  })

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={`${styles.root} ${isNative ? styles.rootNative : ''}`}>
      {!isNative && (
        <>
          <video ref={videoRef} className={styles.video} playsInline muted />
          <canvas ref={canvasRef} className={styles.hiddenCanvas} />
        </>
      )}

      <div className={`${styles.overlay} ${isNative ? styles.overlayNative : ''}`}>
        {/* Top bar */}
        <div className={styles.topBar}>
          <div className={styles.statusRow}>
            {errorMsg && (
              <div className={styles.statusPill}>Error: {errorMsg}</div>
            )}
            {!errorMsg && hashProgressVisible && (
              <div className={styles.loadingPill}>
                <span>{hashLoadInfo?.phase ?? 'Loading'} {hashLoadInfo?.totalCount ? `${(hashLoadInfo.loadedCount ?? 0).toLocaleString()}/${hashLoadInfo.totalCount.toLocaleString()}` : ''}</span>
                <div className={styles.loadingPillBar}>
                  <div className={styles.loadingPillFill} style={{ width: `${hashLoadInfo?.progress ?? 0}%` }} />
                </div>
              </div>
            )}
            {!errorMsg && !hashProgressVisible && preparing && (
              <div className={styles.loadingPill}>Starting…</div>
            )}
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Targeting reticle */}
        <div className={`${styles.targetFrame} ${scanResult === 'found' ? styles.targetLit : ''} ${scanning ? styles.targetPaused : ''}`}>
          <span className={`${styles.corner} ${styles.tl}`} />
          <span className={`${styles.corner} ${styles.tr}`} />
          <span className={`${styles.corner} ${styles.br}`} />
          <span className={`${styles.corner} ${styles.bl}`} />
          {preparing && !errorMsg && <div className={styles.preparingSpinner}>⟳</div>}
          {scanning && <div className={styles.pausedLabel}>Scanning…</div>}
          {isReady && !scanning && !preparing && <div className={styles.scanLine} />}
        </div>

        {/* Debug strip */}
        {DEBUG && debugInfo && (
          <div className={styles.debugStrip}>
            {debugInfo.dist}d {debugInfo.gap}g {debugInfo.src} {debugInfo.votes}v | {debugInfo.decision}{debugInfo.name ? ` · ${debugInfo.name}` : ''}
          </div>
        )}
        {DEBUG && !debugInfo && (
          <div className={styles.debugStrip}>
            hashes: {cardCount.toLocaleString()} {databaseService.isFullyLoaded ? '✓' : '...'} | CV: {cvReady ? '✓' : '...'} | DB: {dbReady ? '✓' : '...'}
          </div>
        )}

        {/* Bottom bar */}
        <div className={styles.bottomBar}>
          {/* Pending basket */}
          {pendingCards.length > 0 && (
            <div className={styles.basket}>
              <div className={styles.basketHeader} onClick={() => setBasketExpanded(v => !v)}>
                <span className={styles.basketTitle}>Pending</span>
                <span className={styles.basketCount}>{pendingCards.length}</span>
                <span className={`${styles.basketChevron} ${basketExpanded ? styles.basketChevronOpen : ''}`}>▼</span>
              </div>
              {basketExpanded && (
                <div className={styles.basketList}>
                  {pendingCards.map(card => (
                    <div key={card.uid} className={styles.basketItem}>
                      {card.imageUri
                        ? <img src={card.imageUri} className={styles.basketItemImg} alt={card.name} />
                        : <div className={styles.basketItemImgPlaceholder}>{card.name[0]}</div>
                      }
                      <div className={styles.basketItemInfo}>
                        <div className={styles.basketItemName}>{card.name}</div>
                        <div className={styles.basketItemMeta}>
                          {card.setCode?.toUpperCase()}{card.collNum ? ` #${card.collNum}` : ''}{card.qty > 1 ? ` ×${card.qty}` : ''}
                        </div>
                      </div>
                      <div className={styles.basketItemActions}>
                        <button
                          className={`${styles.basketFoilBtn} ${card.foil ? styles.basketFoilBtnActive : ''}`}
                          onClick={() => updatePending(card.uid, { foil: !card.foil })}
                        >
                          FOIL
                        </button>
                        <button
                          className={styles.basketPrintingBtn}
                          onClick={() => openPrintingPicker(card.uid)}
                          title="Change printing"
                        >
                          ⊞
                        </button>
                        <button
                          className={styles.basketRemoveBtn}
                          onClick={() => removePending(card.uid)}
                          title="Remove"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Camera controls */}
          <div className={styles.controlBar}>
            <button className={styles.controlBtn} onClick={handleRestartCamera}>↺ Camera</button>
            <button className={styles.controlBtn} onClick={() => setManualSearchOpen(true)}>+ Manual</button>
            {availableFlashModes.length > 0 && (
              <Select
                className={styles.controlSelect}
                value={flashMode}
                onChange={e => handleFlashMode(e.target.value)}
                title="Flash mode"
              >
                {availableFlashModes.map(mode => (
                  <option key={mode} value={mode}>
                    {mode === 'torch' ? 'Flash: on' : `Flash: ${mode}`}
                  </option>
                ))}
              </Select>
            )}
          </div>

          {/* Scan + Add buttons */}
          <div className={styles.btnRow}>
            {isReady && (
              <button className={styles.primaryBtn} onClick={handleScan} disabled={scanning}>
                {scanning ? 'Scanning…' : scanResult === 'found' ? '✓ Scan Again' : scanResult === 'notfound' ? 'Not Found – Retry' : 'Scan Card'}
              </button>
            )}
            {pendingCards.length > 0 && (
              <button className={styles.primaryBtn} onClick={openAddFlow} style={{ flex: '0 0 auto', minWidth: 100 }}>
                Add {pendingCards.length}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Printing picker overlay */}
      {printingPickerFor && (
        <div className={styles.overlayPanel}>
          <div className={styles.overlayPanelHeader}>
            <span className={styles.overlayPanelTitle}>Choose Printing</span>
            <button className={styles.closeBtn} onClick={() => { setPrintingPickerFor(null); setPrintingPickerResults([]) }}>✕</button>
          </div>
          {printingPickerLoading && <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.8rem' }}>Loading…</div>}
          <div className={styles.printingGrid}>
            {printingPickerResults.map(sf => {
              const img = getCardImg(sf)
              const isActive = pendingCards.find(c => c.uid === printingPickerFor)?.id === sf.id
              return (
                <div
                  key={sf.id}
                  className={`${styles.printingCard} ${isActive ? styles.printingCardActive : ''}`}
                  onClick={() => selectPrinting(printingPickerFor, sf)}
                >
                  {img && <img src={img} className={styles.printingCardImg} alt={sf.name} />}
                  <div className={styles.printingCardLabel}>{sf.set?.toUpperCase()} #{sf.collector_number}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Manual search overlay */}
      {manualSearchOpen && (
        <div className={styles.overlayPanel}>
          <div className={styles.overlayPanelHeader}>
            <span className={styles.overlayPanelTitle}>Add Card Manually</span>
            <button className={styles.closeBtn} onClick={() => { setManualSearchOpen(false); setManualSearchQuery(''); setManualSearchResults([]) }}>✕</button>
          </div>
          <div className={styles.searchInputRow}>
            <input
              className={styles.searchInput}
              placeholder="Search card name…"
              value={manualSearchQuery}
              onChange={e => handleManualSearch(e.target.value)}
              autoFocus
            />
          </div>
          {manualSearchLoading && <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.8rem' }}>Searching…</div>}
          <div className={styles.searchResultList}>
            {manualSearchResults.map(sf => {
              const img = getCardImg(sf)
              return (
                <div key={sf.id} className={styles.searchResultItem} onClick={() => addManualCard(sf)}>
                  {img && <img src={img} className={styles.searchResultImg} alt={sf.name} />}
                  <div className={styles.searchResultInfo}>
                    <div className={styles.searchResultName}>{sf.name}</div>
                    <div className={styles.searchResultMeta}>{sf.set?.toUpperCase()} · {sf.type_line}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Add flow overlay */}
      {addFlowOpen && (
        <div className={styles.overlayPanel}>
          <div className={styles.overlayPanelHeader}>
            <span className={styles.overlayPanelTitle}>Add {pendingCards.length} Card{pendingCards.length !== 1 ? 's' : ''}</span>
            <button className={styles.closeBtn} onClick={() => setAddFlowOpen(false)}>✕</button>
          </div>

          {/* Review list */}
          <div className={styles.reviewList}>
            {pendingCards.map(c => (
              <div key={c.uid} className={styles.reviewItem}>
                {c.imageUri && <img src={c.imageUri} className={styles.reviewItemImg} alt={c.name} />}
                <span className={styles.reviewItemName}>{c.name}</span>
                <span className={styles.reviewItemMeta}>{c.setCode?.toUpperCase()}{c.foil ? ' · Foil' : ''}{c.qty > 1 ? ` ×${c.qty}` : ''}</span>
              </div>
            ))}
          </div>

          {/* Folder type tabs */}
          <div className={styles.folderTypeTabs}>
            {[['binder', 'Binder'], ['deck', 'Deck'], ['list', 'Wishlist']].map(([t, label]) => (
              <button
                key={t}
                className={`${styles.folderTypeTab} ${addFlowFolderType === t ? styles.folderTypeTabActive : ''}`}
                onClick={() => { setAddFlowFolderType(t); setAddFlowSelectedFolder(null) }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Folder search */}
          <input
            className={styles.searchInput}
            placeholder={`Search ${addFlowFolderType}s…`}
            value={addFlowFolderSearch}
            onChange={e => setAddFlowFolderSearch(e.target.value)}
          />

          {/* Folder list */}
          {addFlowFoldersLoading
            ? <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.8rem' }}>Loading…</div>
            : (
              <div className={styles.folderList}>
                {filteredFolders.map(f => (
                  <div
                    key={f.id}
                    className={`${styles.folderItem} ${addFlowSelectedFolder === f.id ? styles.folderItemActive : ''}`}
                    onClick={() => setAddFlowSelectedFolder(f.id)}
                  >
                    <span className={styles.folderItemName}>{f.name}</span>
                    {addFlowSelectedFolder === f.id && <span className={styles.folderItemCheck}>✓</span>}
                  </div>
                ))}
                {filteredFolders.length === 0 && (
                  <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.75rem', padding: '8px 4px' }}>No {addFlowFolderType}s found</div>
                )}
              </div>
            )
          }

          {addFlowError && <div className={styles.addFlowError}>{addFlowError}</div>}

          <button
            className={styles.primaryBtn}
            disabled={!addFlowSelectedFolder || addFlowSaving}
            onClick={saveAllPending}
          >
            {addFlowSaving ? 'Saving…' : `Save to ${addFlowFolders.find(f => f.id === addFlowSelectedFolder)?.name ?? '…'}`}
          </button>
        </div>
      )}
    </div>
  )
}
