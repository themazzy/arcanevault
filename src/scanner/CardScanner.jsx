/**
 * CardScanner — full-screen MTG card scanner
 *
 * Native: @capacitor-community/camera-preview renders behind the transparent WebView
 * Web:    getUserMedia() feeds a <video> element
 *
 * Scanned cards accumulate in a pending basket. User can adjust foil,
 * change printing, add manually, then save all at once to a chosen folder.
 *
 * ── Scan pipeline ─────────────────────────────────────────────────────────
 * captureFrame() → { imageData, srcCanvas, w, h, smallImageData, sw, sh }
 *   imageData      — full-res, for warpCard
 *   srcCanvas      — HTMLCanvasElement with full frame drawn, for cropCardFromReticle
 *   smallImageData — half-res (GPU-downscaled via drawImage), for detectCardCorners
 *   sw, sh         — small-image dimensions (≈ w/2, h/2)
 *
 * detectCardCorners() returns coords in small-image space.
 * Scale back to full-res: scaleX = w/sw, scaleY = h/sh, before calling warpCard().
 *
 * ── Auto-scan ─────────────────────────────────────────────────────────────
 * Toggle in gear menu; persisted to localStorage 'arcanevault_scanner_autoscan'.
 * Cooldowns: 1800 ms after match, 600 ms after miss.
 * Pauses automatically when any overlay is open (basket, add-flow, settings).
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'
import { CameraPreview } from '@capacitor-community/camera-preview'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { databaseService } from './DatabaseService'
import {
  waitForOpenCV,
  detectCardCorners, warpCard, cropArtRegion, cropCardFromReticle,
  computePHash256, computePHash256Foil, computePHash256Dark, computePHash256Color, rotateCard180,
} from './ScannerEngine'
import { useAuth } from '../components/Auth'
import { formatPriceMeta, getPriceWithMeta, sfGet } from '../lib/scryfall'
import { sb } from '../lib/supabase'
import { useSettings } from '../components/SettingsContext'
import styles from './CardScanner.module.css'
import { playMatchSound } from './scanSounds'

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
const SAMPLE_DELAY_MS     = 40
const DEBUG               = false
const NATIVE_CAPTURE_SETTLE_MS = 120
const PENDING_KEY         = 'arcanevault_scan_basket'
const SET_ICON_CACHE_KEY  = 'arcanevault_scan_set_icons'
const CARD_LANGUAGES = [
  ['en', 'EN'],
  ['de', 'DE'],
  ['fr', 'FR'],
  ['it', 'IT'],
  ['es', 'ES'],
  ['pt', 'PT'],
  ['ja', 'JA'],
  ['ko', 'KO'],
  ['ru', 'RU'],
  ['cs', 'TC'],
  ['ct', 'SC'],
]

// ── Module-level scratch canvas for pre-downscaled corner detection frames ───
let _smallFrameCanvas = null
let _smallFrameCtx   = null

function getSmallFrameCanvas(w, h) {
  if (!_smallFrameCanvas) {
    _smallFrameCanvas = document.createElement('canvas')
    _smallFrameCtx    = _smallFrameCanvas.getContext('2d', { willReadFrequently: true })
  }
  if (_smallFrameCanvas.width  !== w) _smallFrameCanvas.width  = w
  if (_smallFrameCanvas.height !== h) _smallFrameCanvas.height = h
  return { canvas: _smallFrameCanvas, ctx: _smallFrameCtx }
}

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

function loadSetIconCache() {
  try {
    const raw = localStorage.getItem(SET_ICON_CACHE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

function saveSetIconCache(cache) {
  try { localStorage.setItem(SET_ICON_CACHE_KEY, JSON.stringify(cache)) } catch {}
}

// Cache entries are { icon: string, name: string } — handle legacy string-only values
function getSetIcon(setIcons, code) {
  const v = setIcons[code]
  return typeof v === 'string' ? v : v?.icon ?? null
}
function getSetName(setIcons, code) {
  const v = setIcons[code]
  return typeof v === 'string' ? null : v?.name ?? null
}

let _uidCounter = Date.now()
function nextUid() { return String(++_uidCounter) }

const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG']
const CONDITION_DB = { NM: 'near_mint', LP: 'lightly_played', MP: 'moderately_played', HP: 'heavily_played', DMG: 'damaged' }
function cycleCondition(current) {
  const idx = CONDITIONS.indexOf(current)
  return CONDITIONS[(idx + 1) % CONDITIONS.length]
}

function getOwnedCardKey(c) {
  const printPart = c.card_print_id ? `print:${c.card_print_id}` : `set:${c.set_code}|${c.collector_number}`
  return [printPart, c.foil ? 1 : 0, c.language || 'en', c.condition || 'near_mint'].join('|')
}

async function batchSaveCards({ userId, cards, folderId, folderType }) {
  if (!cards.length || !folderId) return

  let aggregatedOwned = Array.from(
    cards.reduce((map, c) => {
      const row = {
        user_id: userId,
        name: c.name,
        set_code: c.setCode,
        collector_number: c.collNum,
        scryfall_id: c.id,
        foil: c.foil,
        qty: c.qty ?? 1,
        condition: CONDITION_DB[c.condition] || 'near_mint',
        language: c.language || 'en',
        currency: 'EUR',
      }
      const key = getOwnedCardKey(row)
      const prev = map.get(key)
      if (prev) {
        prev.qty += row.qty
        prev.name = row.name
        prev.scryfall_id = row.scryfall_id
      } else {
        map.set(key, row)
      }
      return map
    }, new Map()).values()
  )

  const scryfallIds = [...new Set(aggregatedOwned.map(c => c.scryfall_id).filter(Boolean))]
  if (scryfallIds.length) {
    const { data: printRows, error: printErr } = await sb
      .from('card_prints')
      .select('id,scryfall_id,set_code,collector_number,name')
      .in('scryfall_id', scryfallIds)
    if (printErr) throw new Error(printErr.message)

    const printByScryfallId = new Map((printRows || []).map(row => [row.scryfall_id, row]))
    aggregatedOwned = aggregatedOwned.map(row => {
      const print = row.scryfall_id ? printByScryfallId.get(row.scryfall_id) : null
      return print ? {
        ...row,
        card_print_id: print.id,
        name: print.name || row.name,
        set_code: print.set_code || row.set_code,
        collector_number: print.collector_number || row.collector_number,
      } : row
    })
  }

  if (folderType === 'list') {
    const aggregatedItems = Array.from(
      cards.reduce((map, c) => {
        const key = [c.setCode, c.collNum, c.foil ? 1 : 0].join('|')
        const prev = map.get(key)
        if (prev) {
          prev.qty += c.qty ?? 1
        } else {
          map.set(key, {
            folder_id: folderId,
            user_id: userId,
            name: c.name,
            set_code: c.setCode,
            collector_number: c.collNum,
            scryfall_id: c.id,
            foil: c.foil,
            qty: c.qty ?? 1,
          })
        }
        return map
      }, new Map()).values()
    )
    const items = aggregatedItems.map(c => ({
      folder_id: folderId,
      user_id: userId,
      name: c.name,
      set_code: c.set_code,
      collector_number: c.collector_number,
      scryfall_id: c.scryfall_id,
      foil: c.foil,
      qty: c.qty ?? 1,
    }))
    const { error } = await sb.from('list_items')
      .upsert(items, { onConflict: 'folder_id,set_code,collector_number,foil' })
    if (error) throw new Error(error.message)
    return
  }

  // Binder or deck — upsert owned cards first
  const owned = aggregatedOwned

  const setCodes = [...new Set(owned.map(c => c.set_code).filter(Boolean))]
  const cardPrintIds = [...new Set(owned.map(c => c.card_print_id).filter(Boolean))]
  const existingFilter = [
    setCodes.length ? `set_code.in.(${setCodes.join(',')})` : null,
    cardPrintIds.length ? `card_print_id.in.(${cardPrintIds.join(',')})` : null,
  ].filter(Boolean).join(',')
  let existingQuery = sb.from('cards')
    .select('id,set_code,collector_number,foil,language,condition,qty,card_print_id')
    .eq('user_id', userId)
  if (existingFilter) existingQuery = existingQuery.or(existingFilter)
  const { data: existing, error: existErr } = await existingQuery
  if (existErr) throw new Error(existErr.message)

  const existByKey = new Map((existing || []).map(c => [getOwnedCardKey(c), c]))
  const resolvedRows = owned.map(c => {
    const key = getOwnedCardKey(c)
    const prev = existByKey.get(key)
    return prev ? { ...prev, ...c, id: prev.id, qty: (prev.qty || 0) + c.qty } : c
  })

  const updateRows = resolvedRows.filter(row => row.id)
  const insertRows = resolvedRows.filter(row => !row.id)

  for (const row of updateRows) {
    const { id, ...patch } = row
    const { error: updateErr } = await sb.from('cards')
      .update(patch)
      .eq('id', id)
    if (updateErr) throw new Error(updateErr.message)
  }

  if (insertRows.length) {
    const { error: insertErr } = await sb.from('cards')
      .insert(insertRows)
    if (insertErr) throw new Error(insertErr.message)
  }

  // Re-query to get IDs
  let savedQuery = sb.from('cards')
    .select('id,set_code,collector_number,foil,language,condition,card_print_id')
    .eq('user_id', userId)
  if (existingFilter) savedQuery = savedQuery.or(existingFilter)
  const { data: saved, error: savedErr } = await savedQuery
  if (savedErr) throw new Error(savedErr.message)

  const savedByKey = new Map((saved || []).map(c => [getOwnedCardKey(c), c]))
  const table = folderType === 'deck' ? 'deck_allocations' : 'folder_cards'
  const fk    = folderType === 'deck' ? 'deck_id' : 'folder_id'

  const { data: existLinks, error: linksErr } = await sb.from(table).select('card_id,qty').eq(fk, folderId)
  if (linksErr) throw new Error(linksErr.message)
  const existLinkQty = new Map((existLinks || []).map(l => [l.card_id, l.qty || 1]))

  const links = owned.map(c => {
    const key = getOwnedCardKey(c)
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

// ── Animated toggle hook (open + close animations for overlay panels) ─────────

function useAnimatedToggle(duration = 180) {
  const [on, setOn] = useState(false)
  const [animClosing, setAnimClosing] = useState(false)
  const timerRef = useRef(null)

  const show = useCallback(() => {
    clearTimeout(timerRef.current)
    timerRef.current = null
    setAnimClosing(false)
    setOn(true)
  }, [])

  const hide = useCallback(() => {
    if (timerRef.current) return
    setAnimClosing(true)
    timerRef.current = setTimeout(() => {
      setOn(false)
      setAnimClosing(false)
      timerRef.current = null
    }, duration)
  }, [duration])

  const toggle = useCallback(() => {
    if (on && !animClosing) hide(); else if (!on && !animClosing) show()
  }, [on, animClosing, hide, show])

  useEffect(() => () => clearTimeout(timerRef.current), [])
  return { on, closing: animClosing, show, hide, toggle }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CardScanner({ onMatch, onClose }) {
  const { user } = useAuth()
  const { price_source } = useSettings()
  const isNative = Capacitor.isNativePlatform()

  const videoRef          = useRef(null)
  const canvasRef         = useRef(null)
  const mountedRef        = useRef(true)
  const autoScanRef = useRef(false)
  const scanningRef = useRef(false)
  const lastAutoScanIdRef = useRef(null)
  const lastSoundCardUidRef = useRef(null)
  const sessionStatsRef = useRef({ attempts: 0, hits: 0, totalMs: 0 })
  const [sessionStatsDisplay, setSessionStatsDisplay] = useState({ attempts: 0, hits: 0, totalMs: 0 })
  const manualSearchRequestRef = useRef(0)
  const setIconFetchesRef = useRef(new Set())

  // ── Scanner state ──────────────────────────────────────────────────────────
  const [cvReady, setCvReady]     = useState(false)
  const [dbReady, setDbReady]     = useState(false)
  const [preparing, setPreparing] = useState(true)
  const [errorMsg, setErrorMsg]   = useState(null)
  const [scanning, setScanning]   = useState(false)
  const [scanResult, setScanResult] = useState(null)   // 'found' | 'notfound' | null
  const [detectedCorners, setDetectedCorners] = useState(null) // [{x,y}×4] screen px or null
  const [cardCount, setCardCount] = useState(0)
  const [debugInfo, setDebugInfo] = useState(null)
  const [hashLoadInfo, setHashLoadInfo] = useState(databaseService.status)
  const [flashModes, setFlashModes] = useState([])
  const [flashMode, setFlashMode]   = useState('off')
  const [cameraStarted, setCameraStarted] = useState(false)
  const [cameraRestartTick, setCameraRestartTick] = useState(0)
  const [setIcons, setSetIcons] = useState(() => loadSetIconCache())
  const [latestPrintingData, setLatestPrintingData] = useState(null)
  const [latestLanguageOptions, setLatestLanguageOptions] = useState([['en', 'EN']])
  const [printingDataById, setPrintingDataById] = useState({})
  const [languageOptionsByOracleId, setLanguageOptionsByOracleId] = useState({})

  // ── Pending basket ─────────────────────────────────────────────────────────
  const [pendingCards, setPendingCards] = useState(() => loadPending())

  // ── Animated overlay toggles ───────────────────────────────────────────────
  const basketTgl     = useAnimatedToggle(180)
  const basketExpanded = basketTgl.on
  const basketClosing  = basketTgl.closing

  const manualTgl       = useAnimatedToggle(180)
  const manualSearchOpen    = manualTgl.on
  const manualSearchClosing = manualTgl.closing

  const addFlowTgl    = useAnimatedToggle(180)
  const addFlowOpen    = addFlowTgl.on
  const addFlowClosing = addFlowTgl.closing

  const settingsTgl   = useAnimatedToggle(180)
  const settingsOpen    = settingsTgl.on
  const settingsClosing = settingsTgl.closing

  const setPickerTgl  = useAnimatedToggle(180)
  const setPickerOpen    = setPickerTgl.on
  const setPickerClosing = setPickerTgl.closing

  // ── Printing picker ────────────────────────────────────────────────────────
  const [printingPickerFor, setPrintingPickerFor]         = useState(null)   // uid
  const [printingPickerResults, setPrintingPickerResults] = useState([])
  const [printingPickerLoading, setPrintingPickerLoading] = useState(false)
  const [printingPickerSearch, setPrintingPickerSearch]   = useState('')
  const [printingPickerClosing, setPrintingPickerClosing] = useState(false)
  const printingPickerTimerRef = useRef(null)

  // ── Manual search ──────────────────────────────────────────────────────────
  const [manualSearchQuery, setManualSearchQuery]   = useState('')
  const [manualSearchResults, setManualSearchResults] = useState([])
  const [manualSearchLoading, setManualSearchLoading] = useState(false)

  // ── Add flow (folder picker + save) ───────────────────────────────────────
  const [addFlowFolderType, setAddFlowFolderType] = useState('binder')
  const [addFlowFolders, setAddFlowFolders]       = useState([])
  const [addFlowFolderSearch, setAddFlowFolderSearch] = useState('')
  const [addFlowSelectedFolder, setAddFlowSelectedFolder] = useState(null)
  const [addFlowSaving, setAddFlowSaving]         = useState(false)
  const [addFlowError, setAddFlowError]           = useState(null)
  const [addFlowFoldersLoading, setAddFlowFoldersLoading] = useState(false)
  const [addFlowCreatingFolder, setAddFlowCreatingFolder] = useState(false)
  const [closing, setClosing] = useState(false)
  const [saveNotice, setSaveNotice] = useState(null)
  const latestPending = pendingCards[0] || null

  // ── Scanner settings ───────────────────────────────────────────────────────
  const [autoScan, setAutoScan] = useState(() => {
    try { return localStorage.getItem('arcanevault_scanner_autoscan') === '1' } catch { return false }
  })
  const [preferFoil, setPreferFoil] = useState(() => {
    try { return localStorage.getItem('arcanevault_scanner_prefer_foil') === '1' } catch { return false }
  })
  const [lockSet, setLockSet] = useState(() => {
    try { return localStorage.getItem('arcanevault_scanner_lock_set') === '1' } catch { return false }
  })
  const [scanSounds, setScanSounds] = useState(() => {
    try { return localStorage.getItem('arcanevault_scanner_sounds') !== '0' } catch { return true }
  })
  const [minPriceThreshold, setMinPriceThreshold] = useState(() => {
    try { return parseFloat(localStorage.getItem('arcanevault_scanner_min_price') || '0') || 0 } catch { return 0 }
  })
  const [lockedSets, setLockedSets] = useState(() => {
    try {
      const raw = localStorage.getItem('arcanevault_scanner_locked_sets')
      return raw ? new Set(JSON.parse(raw)) : new Set()
    } catch { return new Set() }
  })
  const [setPickerSets, setSetPickerSets] = useState([])   // [{ code, name, icon_svg_uri }]
  const [setPickerLoading, setSetPickerLoading] = useState(false)
  const [setPickerSearch, setSetPickerSearch] = useState('')

  const isReady = cvReady && dbReady && cameraStarted
  const anyOverlayOpen = basketExpanded || addFlowOpen || manualSearchOpen || settingsOpen || setPickerOpen || printingPickerFor !== null
  const availableFlashModes = flashModes.includes('torch')
    ? flashModes.filter(m => m === 'off' || m === 'torch')
    : flashModes
  const flashSupported = availableFlashModes.includes('torch') || availableFlashModes.includes('on')
  const flashEnabled = flashMode === 'torch' || flashMode === 'on'
  const hashProgressVisible = !!hashLoadInfo && hashLoadInfo.phase !== 'idle' && hashLoadInfo.phase !== 'ready'

  // Persist basket to localStorage whenever it changes
  useEffect(() => { savePending(pendingCards) }, [pendingCards])
  useEffect(() => { saveSetIconCache(setIcons) }, [setIcons])
  useEffect(() => {
    autoScanRef.current = autoScan
    try { localStorage.setItem('arcanevault_scanner_autoscan', autoScan ? '1' : '0') } catch {}
  }, [autoScan])
  useEffect(() => { scanningRef.current = scanning }, [scanning])
  useEffect(() => {
    try { localStorage.setItem('arcanevault_scanner_prefer_foil', preferFoil ? '1' : '0') } catch {}
  }, [preferFoil])
  useEffect(() => {
    try { localStorage.setItem('arcanevault_scanner_lock_set', lockSet ? '1' : '0') } catch {}
    if (!lockSet) setLockedSets(new Set())
  }, [lockSet])
  useEffect(() => {
    try { localStorage.setItem('arcanevault_scanner_sounds', scanSounds ? '1' : '0') } catch {}
  }, [scanSounds])
  useEffect(() => {
    try { localStorage.setItem('arcanevault_scanner_min_price', String(minPriceThreshold)) } catch {}
  }, [minPriceThreshold])
  useEffect(() => {
    try { localStorage.setItem('arcanevault_scanner_locked_sets', JSON.stringify([...lockedSets])) } catch {}
  }, [lockedSets])
  useEffect(() => {
    if (!saveNotice) return undefined
    const timer = setTimeout(() => setSaveNotice(null), 2200)
    return () => clearTimeout(timer)
  }, [saveNotice])

  // ── Scan sound — plays when price data arrives for a newly scanned card ─────
  useEffect(() => {
    if (!scanSounds) return
    if (!latestPending || !latestPrintingData) return
    if (lastSoundCardUidRef.current === latestPending.uid) return
    lastSoundCardUidRef.current = latestPending.uid
    const priceMeta = getPriceWithMeta(latestPrintingData, latestPending.foil, { price_source })
    playMatchSound(priceMeta?.value ?? 0)
  }, [scanSounds, latestPending, latestPrintingData, price_source])

  // ── Set picker — fetch all sets from Scryfall when picker opens ──────────────
  useEffect(() => {
    if (!setPickerOpen || setPickerSets.length > 0) return
    let cancelled = false
    setSetPickerLoading(true)
    ;(async () => {
      try {
        const data = await sfGet('/sets')
        if (cancelled) return
        const sets = (data?.data || [])
          .filter(s => s.set_type !== 'token' && s.set_type !== 'memorabilia' && s.card_count > 0)
          .map(s => ({ code: s.code, name: s.name, icon: s.icon_svg_uri, released: s.released_at }))
          .sort((a, b) => (b.released || '').localeCompare(a.released || ''))
        if (!cancelled) setSetPickerSets(sets)
        // Also seed our setIcons cache with names from the full list
        if (!cancelled) setSetIcons(prev => {
          const next = { ...prev }
          for (const s of sets) {
            if (!next[s.code] && s.icon) next[s.code] = { icon: s.icon, name: s.name }
          }
          return next
        })
      } catch { /* non-critical */ } finally {
        if (!cancelled) setSetPickerLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [setPickerOpen, setPickerSets.length])

  // ── Tracking frame corner detection ──────────────────────────────────────────
  // Web-only. Runs at ~15fps (every 2nd rAF frame) and emits the 4 detected card
  // corners in screen space so the SVG tracking overlay can snap to them.
  // Uses scanningRef so the loop doesn't restart on every scan cycle.
  useEffect(() => {
    if (isNative || !isReady || !cameraStarted || anyOverlayOpen) {
      setDetectedCorners(null)
      return
    }

    let frameCount = 0
    let animHandle = null
    let stopped = false

    const loop = () => {
      if (stopped) return
      frameCount++
      animHandle = requestAnimationFrame(loop)

      // ~15fps on a 30fps camera feed
      if (frameCount % 2 !== 0) return

      const vid = videoRef.current
      if (!vid?.videoWidth) return

      // Skip while a scan is actively running to avoid concurrent OpenCV calls.
      if (scanningRef.current) return

      const sw = Math.round(vid.videoWidth / 2)
      const sh = Math.round(vid.videoHeight / 2)
      const { ctx: smallCtx } = getSmallFrameCanvas(sw, sh)
      smallCtx.drawImage(vid, 0, 0, sw, sh)
      let smallImageData
      try { smallImageData = smallCtx.getImageData(0, 0, sw, sh) } catch { return }

      const corners = detectCardCorners(smallImageData, sw, sh)

      if (corners?.length === 4) {
        // Map corners: small-frame → full video → screen (object-fit: cover).
        const videoW = vid.videoWidth, videoH = vid.videoHeight
        const screenW = window.innerWidth, screenH = window.innerHeight
        const smallScaleX = videoW / sw
        const smallScaleY = videoH / sh
        const coverScale  = Math.max(screenW / videoW, screenH / videoH)
        const offsetX = (screenW - videoW * coverScale) / 2
        const offsetY = (screenH - videoH * coverScale) / 2
        setDetectedCorners(corners.map(p => ({
          x: p.x * smallScaleX * coverScale + offsetX,
          y: p.y * smallScaleY * coverScale + offsetY,
        })))
      } else {
        setDetectedCorners(null)
      }
    }

    animHandle = requestAnimationFrame(loop)
    return () => {
      stopped = true
      if (animHandle) cancelAnimationFrame(animHandle)
      setDetectedCorners(null)
    }
  }, [isNative, isReady, cameraStarted, anyOverlayOpen])

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
        await databaseService.waitUntilFullyLoaded()
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
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
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

  useEffect(() => {
    const missingSetCodes = [...new Set(pendingCards.map(card => card?.setCode).filter(Boolean))]
      .filter(setCode => !setIcons[setCode] && !setIconFetchesRef.current.has(setCode))
    if (!missingSetCodes.length) return
    let cancelled = false
    ;(async () => {
      for (const setCode of missingSetCodes) {
        setIconFetchesRef.current.add(setCode)
        try {
          const data = await sfGet(`/sets/${setCode}`)
          if (cancelled) return
          if (data?.icon_svg_uri) {
            setSetIcons(prev => (prev[setCode] ? prev : { ...prev, [setCode]: { icon: data.icon_svg_uri, name: data.name || setCode } }))
          }
        } finally {
          setIconFetchesRef.current.delete(setCode)
        }
      }
    })()
    return () => { cancelled = true }
  }, [pendingCards, setIcons])

  useEffect(() => {
    const missing = [...new Set((printingPickerResults || []).map(card => card?.set).filter(Boolean))]
      .filter(setCode => !setIcons[setCode] && !setIconFetchesRef.current.has(setCode))
    if (!missing.length) return
    let cancelled = false
    ;(async () => {
      for (const setCode of missing) {
        setIconFetchesRef.current.add(setCode)
        try {
          const data = await sfGet(`/sets/${setCode}`)
          if (cancelled) return
          if (data?.icon_svg_uri) {
            setSetIcons(prev => (prev[setCode] ? prev : { ...prev, [setCode]: { icon: data.icon_svg_uri, name: data.name || setCode } }))
          }
        } finally {
          setIconFetchesRef.current.delete(setCode)
        }
      }
    })()
    return () => { cancelled = true }
  }, [printingPickerResults, setIcons])

  useEffect(() => {
    const cardId = latestPending?.id
    if (!cardId) { setLatestPrintingData(null); return }
    let cancelled = false
    ;(async () => {
      const data = await sfGet(`/cards/${cardId}`)
      if (!cancelled) setLatestPrintingData(data || null)
    })()
    return () => { cancelled = true }
  }, [latestPending?.id])

  useEffect(() => {
    const missingIds = [...new Set(pendingCards.map(card => card?.id).filter(Boolean))]
      .filter(cardId => !printingDataById[cardId])
    if (!missingIds.length) return
    let cancelled = false
    ;(async () => {
      for (const cardId of missingIds) {
        const data = await sfGet(`/cards/${cardId}`)
        if (cancelled) return
        if (data) {
          setPrintingDataById(prev => (prev[cardId] ? prev : { ...prev, [cardId]: data }))
        }
      }
    })()
    return () => { cancelled = true }
  }, [pendingCards, printingDataById])

  useEffect(() => {
    if (!latestPending) {
      setLatestLanguageOptions([['en', 'EN']])
      return
    }

    let cancelled = false
    ;(async () => {
      const fallbackValue = latestPending.language || 'en'
      const fallback = CARD_LANGUAGES.filter(([value]) => value === fallbackValue)
      const defaultOptions = fallback.length ? fallback : [['en', 'EN']]

      if (!latestPrintingData?.oracle_id) {
        setLatestLanguageOptions(defaultOptions)
        return
      }

      try {
        const q = `oracleid:${latestPrintingData.oracle_id} unique:prints`
        const data = await sfGet(`/cards/search?q=${encodeURIComponent(q)}&order=released&dir=desc`)
        if (cancelled) return

        const available = new Set((data?.data || []).map(card => card?.lang).filter(Boolean))
        available.add(fallbackValue)

        const options = CARD_LANGUAGES.filter(([value]) => available.has(value))
        setLatestLanguageOptions(options.length ? options : defaultOptions)
      } catch {
        if (!cancelled) setLatestLanguageOptions(defaultOptions)
      }
    })()

    return () => { cancelled = true }
  }, [latestPending, latestPrintingData])

  useEffect(() => {
    const missingOracleIds = [...new Set(
      pendingCards
        .map(card => printingDataById[card.id]?.oracle_id)
        .filter(Boolean)
    )].filter(oracleId => !languageOptionsByOracleId[oracleId])
    if (!missingOracleIds.length) return
    let cancelled = false
    ;(async () => {
      for (const oracleId of missingOracleIds) {
        try {
          const q = `oracleid:${oracleId} unique:prints`
          const data = await sfGet(`/cards/search?q=${encodeURIComponent(q)}&order=released&dir=desc`)
          if (cancelled) return
          const available = new Set((data?.data || []).map(card => card?.lang).filter(Boolean))
          const options = CARD_LANGUAGES.filter(([value]) => available.has(value))
          setLanguageOptionsByOracleId(prev => (prev[oracleId]
            ? prev
            : { ...prev, [oracleId]: options.length ? options : [['en', 'EN']] }))
        } catch {
          if (cancelled) return
          setLanguageOptionsByOracleId(prev => (prev[oracleId] ? prev : { ...prev, [oracleId]: [['en', 'EN']] }))
        }
      }
    })()
    return () => { cancelled = true }
  }, [pendingCards, printingDataById, languageOptionsByOracleId])

  // ── Basket operations ──────────────────────────────────────────────────────

  const addToPending = useCallback((match, { foil = false } = {}) => {
    const entry = {
      uid:       nextUid(),
      id:        match.id,
      name:      match.name,
      setCode:   match.setCode,
      collNum:   match.collNum,
      imageUri:  match.imageUri,
      foil,
      qty:       1,
      language:  'en',
      condition: 'NM',
    }
    setPendingCards(prev => {
      // Deduplicate: if same card+foil+condition already in basket, increment qty
      const idx = prev.findIndex(c =>
        c.id === entry.id && c.foil === entry.foil &&
        (c.language || 'en') === entry.language &&
        (c.condition || 'NM') === entry.condition
      )
      if (idx !== -1) {
        const existing = prev[idx]
        const next = prev.filter((_, i) => i !== idx)
        next.unshift({ ...existing, qty: existing.qty + 1 })
        return next
      }
      return [entry, ...prev]
    })
  }, [])

  const removePending = useCallback((uid) => {
    setPendingCards(prev => prev.filter(c => c.uid !== uid))
  }, [])

  const updatePending = useCallback((uid, patch) => {
    setPendingCards(prev => prev.map(c => c.uid === uid ? { ...c, ...patch } : c))
  }, [])

  const adjustPendingQty = useCallback((uid, delta) => {
    setPendingCards(prev => prev.flatMap(card => {
      if (card.uid !== uid) return [card]
      const nextQty = (card.qty || 1) + delta
      return nextQty > 0 ? [{ ...card, qty: nextQty }] : []
    }))
  }, [])

  // ── Printing picker ────────────────────────────────────────────────────────

  const openPrintingPicker = useCallback(async (uid) => {
    const card = pendingCards.find(c => c.uid === uid)
    if (!card) return
    clearTimeout(printingPickerTimerRef.current)
    printingPickerTimerRef.current = null
    setPrintingPickerClosing(false)
    setPrintingPickerFor(uid)
    setPrintingPickerLoading(true)
    setPrintingPickerResults([])
    setPrintingPickerSearch('')
    try {
      const encodedName = encodeURIComponent(`!"${card.name}"`)
      const data = await sfGet(`/cards/search?q=${encodedName}&unique=prints&order=released&dir=desc`)
      if (mountedRef.current) setPrintingPickerResults(data?.data ?? [])
    } catch { /* ignore */ }
    if (mountedRef.current) setPrintingPickerLoading(false)
  }, [pendingCards])

  const closePrintingPicker = useCallback(() => {
    if (printingPickerTimerRef.current) return
    setPrintingPickerClosing(true)
    printingPickerTimerRef.current = setTimeout(() => {
      setPrintingPickerFor(null)
      setPrintingPickerResults([])
      setPrintingPickerSearch('')
      setPrintingPickerClosing(false)
      printingPickerTimerRef.current = null
    }, 180)
  }, [])

  const selectPrinting = useCallback((uid, sf) => {
    const imgUri = getCardImg(sf)
    updatePending(uid, {
      id:       sf.id,
      name:     sf.name,
      setCode:  sf.set,
      collNum:  sf.collector_number,
      imageUri: imgUri,
    })
    closePrintingPicker()
  }, [updatePending, closePrintingPicker])

  // ── Manual search ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!manualSearchOpen) return

    const q = manualSearchQuery.trim()
    if (q.length < 2) {
      manualSearchRequestRef.current += 1
      setManualSearchLoading(false)
      setManualSearchResults([])
      return
    }

    const requestId = manualSearchRequestRef.current + 1
    manualSearchRequestRef.current = requestId

    const timer = setTimeout(async () => {
      if (!mountedRef.current || manualSearchRequestRef.current !== requestId) return
      setManualSearchLoading(true)
      try {
        const data = await sfGet(`/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=name`)
        if (!mountedRef.current || manualSearchRequestRef.current !== requestId) return
        setManualSearchResults(data?.data?.slice(0, 20) ?? [])
      } catch {
        if (!mountedRef.current || manualSearchRequestRef.current !== requestId) return
        setManualSearchResults([])
      } finally {
        if (!mountedRef.current || manualSearchRequestRef.current !== requestId) return
        setManualSearchLoading(false)
      }
    }, 250)

    return () => clearTimeout(timer)
  }, [manualSearchOpen, manualSearchQuery])

  const addManualCard = useCallback((sf) => {
    addToPending({
      id:       sf.id,
      name:     sf.name,
      setCode:  sf.set,
      collNum:  sf.collector_number,
      imageUri: getCardImg(sf),
    })
    closePrintingPicker()
    addFlowTgl.hide()
    manualTgl.hide()
    manualSearchRequestRef.current += 1
    setManualSearchQuery('')
    setManualSearchResults([])
    setManualSearchLoading(false)
    basketTgl.hide()
  }, [addToPending, closePrintingPicker, addFlowTgl.hide, manualTgl.hide, basketTgl.hide])

  // ── Add flow ───────────────────────────────────────────────────────────────

  const openAddFlow = useCallback(async () => {
    addFlowTgl.show()
    setAddFlowSelectedFolder(null)
    setAddFlowError(null)
    setAddFlowFolderSearch('')
    setAddFlowCreatingFolder(false)
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
  }, [user, addFlowTgl.show])

  const createAddFlowFolder = useCallback(async () => {
    const rawName = addFlowFolderSearch.trim()
    if (!rawName || !user?.id || addFlowCreatingFolder) return

    const normalizedName = rawName.toLowerCase()
    const folderType = addFlowFolderType === 'deck' ? 'deck' : addFlowFolderType
    const existing = addFlowFolders.find(f =>
      f.type === folderType &&
      String(f.name || '').trim().toLowerCase() === normalizedName
    )
    if (existing) {
      setAddFlowSelectedFolder(existing.id)
      setAddFlowError(null)
      return
    }

    setAddFlowCreatingFolder(true)
    setAddFlowError(null)
    try {
      const { data, error } = await sb.from('folders')
        .insert({ user_id: user.id, type: folderType, name: rawName })
        .select('id,name,type')
        .single()
      if (error) throw new Error(error.message)
      if (!data) throw new Error('Failed to create folder')
      setAddFlowFolders(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
      setAddFlowSelectedFolder(data.id)
    } catch (e) {
      setAddFlowError(e.message)
    } finally {
      setAddFlowCreatingFolder(false)
    }
  }, [addFlowCreatingFolder, addFlowFolderSearch, addFlowFolderType, addFlowFolders, user])

  const saveAllPending = useCallback(async () => {
    if (!addFlowSelectedFolder || !pendingCards.length || !user?.id) return
    const folder = addFlowFolders.find(f => f.id === addFlowSelectedFolder)
    if (!folder) return
    setAddFlowSaving(true)
    setAddFlowError(null)
    try {
      const savedQty = pendingCards.reduce((sum, card) => sum + (card.qty || 1), 0)
      await batchSaveCards({
        userId: user.id,
        cards: pendingCards,
        folderId: addFlowSelectedFolder,
        folderType: folder.type,
      })
      setPendingCards([])
      addFlowTgl.hide()
      setAddFlowSelectedFolder(null)
      setSaveNotice(`Saved ${savedQty} card${savedQty !== 1 ? 's' : ''} to ${folder.name}`)
    } catch (e) {
      setAddFlowError(e.message)
    }
    setAddFlowSaving(false)
  }, [addFlowSelectedFolder, pendingCards, addFlowFolders, user, addFlowTgl.hide])

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
      const w = img.width, h = img.height
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      // Small frame for corner detection (GPU-downscaled)
      const sw = Math.round(w / 2), sh = Math.round(h / 2)
      const { ctx: smallCtx } = getSmallFrameCanvas(sw, sh)
      smallCtx.drawImage(img, 0, 0, sw, sh)
      const smallImageData = smallCtx.getImageData(0, 0, sw, sh)
      const imageData = ctx.getImageData(0, 0, w, h)
      return { imageData, srcCanvas: canvas, w, h, smallImageData, sw, sh }
    } else {
      const vid = videoRef.current
      if (!vid?.videoWidth) return null
      const w = vid.videoWidth, h = vid.videoHeight
      const canvas = canvasRef.current
      canvas.width = w; canvas.height = h
      const ctx2d = canvas.getContext('2d', { willReadFrequently: true })
      ctx2d.drawImage(vid, 0, 0)
      // Small frame for corner detection — GPU-accelerated drawImage to 50% size.
      // Replaces the OpenCV software resize inside detectCardCorners.
      const sw = Math.round(w / 2), sh = Math.round(h / 2)
      const { ctx: smallCtx } = getSmallFrameCanvas(sw, sh)
      smallCtx.drawImage(vid, 0, 0, sw, sh)
      const smallImageData = smallCtx.getImageData(0, 0, sw, sh)
      return { imageData: ctx2d.getImageData(0, 0, w, h), srcCanvas: canvas, w, h, smallImageData, sw, sh }
    }
  }, [isNative])

  const scanSingleFrame = useCallback(async ({ cornersOnly = false } = {}) => {
    const frame = await captureFrame()
    if (!frame) return { status: 'error', stage: 'no frame', best: null, second: null, candidateCount: 0, totalCount: 0 }

    const { imageData, srcCanvas, w, h, smallImageData, sw, sh } = frame
    // Corner detection runs on the pre-downscaled (sw×sh) frame — cheaper matFromImageData,
    // cheaper cvtColor, no OpenCV resize. Scale corners back to full-res coords for warpCard.
    const cornersSmall = detectCardCorners(smallImageData, sw, sh)
    const scaleX = w / sw, scaleY = h / sh
    const corners = cornersSmall?.map(p => ({ x: p.x * scaleX, y: p.y * scaleY })) ?? null

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
      // Color hash computed once per image (robust to small crop shifts).
      // Null if OpenCV isn't ready or art crop fails — matching gracefully degrades.
      let colorHash = null
      try {
        const defaultCrop = cropArtRegion(cardImg)
        if (defaultCrop) colorHash = computePHash256Color(defaultCrop)
      } catch { /* non-critical */ }

      for (const variant of variants) {
        const artCrop = cropArtRegion(cardImg, variant)
        if (!artCrop) continue
        const hash = computePHash256(artCrop)
        if (!hash) continue
        const { best: c, second: r, candidateCount, totalCount } = databaseService.findBestTwoWithStats(hash, colorHash)
        if (updateBest(c, r, candidateCount, totalCount, variant, sourceLabel)) return
        if (c && c.distance > MATCH_THRESHOLD) {
          // Foil fallback: aggressive glare suppression for blown highlights.
          try {
            const foilHash = computePHash256Foil(artCrop)
            if (foilHash) {
              const foilStats = databaseService.findBestTwoWithStats(foilHash, colorHash)
              if (updateBest(foilStats.best, foilStats.second, foilStats.candidateCount, foilStats.totalCount, variant, `${sourceLabel}+foil`)) return
            }
          } catch { /* non-critical */ }
          // Dark art fallback: stretch low dynamic range for dark-art cards (Swamp, etc).
          // computePHash256Dark returns null when mean brightness ≥ 80 (not dark art).
          try {
            const darkHash = computePHash256Dark(artCrop)
            if (darkHash) {
              const darkStats = databaseService.findBestTwoWithStats(darkHash, colorHash)
              if (updateBest(darkStats.best, darkStats.second, darkStats.candidateCount, darkStats.totalCount, variant, `${sourceLabel}+dark`)) return
            }
          } catch { /* non-critical */ }
        }
      }
    }

    if (corners) {
      const warped = warpCard(imageData, corners)
      if (warped) {
        tryMatch(warped, 'corners', FAST_PRIMARY_VARIANTS)
        if (shouldExpand()) tryMatch(warped, 'corners', PRIMARY_CROP_VARIANTS.slice(1))
        // 180° rotation fallback — cards held upside-down on a table are common.
        // Only runs when the upright pass didn't produce a decisive match.
        if (shouldExpand()) {
          const warped180 = rotateCard180(warped)
          tryMatch(warped180, 'corners+rot180', FAST_PRIMARY_VARIANTS)
          if (shouldExpand()) tryMatch(warped180, 'corners+rot180', PRIMARY_CROP_VARIANTS.slice(1))
        }
      }
    }
    // Reticle fallback: blind-crop the center of the frame. Useful for manual scan
    // when edge detection misses the card, but disabled in auto-scan (cornersOnly) to
    // prevent false positives from incidental objects in the reticle zone.
    if (!cornersOnly && shouldExpand()) {
      const reticle = cropCardFromReticle(srcCanvas ?? imageData, w, h, window.innerWidth, window.innerHeight)
      if (reticle) {
        tryMatch(reticle, 'reticle', FAST_PRIMARY_VARIANTS)
        if (shouldExpand()) tryMatch(reticle, 'reticle', PRIMARY_CROP_VARIANTS.slice(1))
        if (shouldExpand()) {
          const reticle180 = rotateCard180(reticle)
          tryMatch(reticle180, 'reticle+rot180', FAST_PRIMARY_VARIANTS)
          if (shouldExpand()) tryMatch(reticle180, 'reticle+rot180', PRIMARY_CROP_VARIANTS.slice(1))
        }
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
    const scanStart = Date.now()
    try {
      const votes = new Map()
      let bestObserved = null, bestObservedGap = null
      let bestObservedCandidates = null, bestObservedVariant = null
      let bestObservedSource = null, bestObservedSameNameCluster = false
      const frameSummaries = []
      const isAutoScan = autoScanRef.current

      for (let i = 0; i < STABILITY_SAMPLES; i++) {
        const result = await scanSingleFrame({ cornersOnly: isAutoScan })
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

      const elapsed = Date.now() - scanStart
      if (!match) {
        if (isAutoScan) lastAutoScanIdRef.current = null
        sessionStatsRef.current.attempts++
        sessionStatsRef.current.totalMs += elapsed
        setSessionStatsDisplay({ ...sessionStatsRef.current })
        setScanResult('notfound')
        return
      }

      // Lock-set filtering: reject matches not in the locked set list.
      if (lockSet && lockedSets.size > 0 && !lockedSets.has(match.setCode)) {
        sessionStatsRef.current.attempts++
        sessionStatsRef.current.totalMs += elapsed
        setSessionStatsDisplay({ ...sessionStatsRef.current })
        setScanResult('notfound')
        return
      }

      sessionStatsRef.current.attempts++
      sessionStatsRef.current.hits++
      sessionStatsRef.current.totalMs += elapsed
      setSessionStatsDisplay({ ...sessionStatsRef.current })
      setScanResult('found')
      // In auto-scan mode, skip adding if this is the same card as the last scan
      // (prevents quantity inflation when a card sits in frame across multiple cycles)
      const isDuplicate = isAutoScan && match.id === lastAutoScanIdRef.current
      if (!isDuplicate) {
        if (isAutoScan) lastAutoScanIdRef.current = match.id
        addToPending(match, { foil: preferFoil })
      }
      // In manual mode, close any open overlay — result shows in the bottom bar only
      if (!isAutoScan) basketTgl.hide()
      try { await Haptics.impact({ style: ImpactStyle.Medium }) } catch {}
      onMatch?.(match)
    } catch (e) {
      if (DEBUG && mountedRef.current) setDebugInfo(d => ({ ...(d||{}), decision: `error: ${e.message}` }))
      setScanResult('error')
    } finally {
      if (mountedRef.current) setScanning(false)
    }
  }, [isReady, scanning, scanSingleFrame, addToPending, onMatch, lockSet, lockedSets, preferFoil])

  // ── Auto-scan loop ────────────────────────────────────────────────────────
  // Re-runs whenever scanning goes idle. Schedules the next handleScan() call
  // after a cooldown: longer after a match so the user can see the result.
  // Pauses automatically when any overlay is open.
  // Must be defined after handleScan (useCallback const — TDZ applies).
  useEffect(() => {
    if (!autoScan || !isReady || scanning) return
    if (addFlowOpen || basketExpanded || manualSearchOpen || settingsOpen || setPickerOpen || printingPickerFor !== null) return
    const cooldown = scanResult === 'found' ? 1000 : 350
    const timer = setTimeout(() => { handleScan() }, cooldown)
    return () => clearTimeout(timer)
  }, [autoScan, isReady, scanning, addFlowOpen, basketExpanded, manualSearchOpen, settingsOpen, setPickerOpen, printingPickerFor, handleScan, scanResult])

  // ── Derived ────────────────────────────────────────────────────────────────

  const handleFlashToggle = useCallback(() => {
    if (!flashSupported) return
    setFlashMode(current => ((current === 'torch' || current === 'on') ? 'off' : (availableFlashModes.includes('torch') ? 'torch' : 'on')))
  }, [availableFlashModes, flashSupported])

  const filteredFolders = addFlowFolders.filter(f => {
    const typeMatch = addFlowFolderType === 'binder' ? f.type === 'binder'
      : addFlowFolderType === 'deck' ? (f.type === 'deck' || f.type === 'builder_deck')
      : f.type === 'list'
    if (!typeMatch) return false
    if (!addFlowFolderSearch.trim()) return true
    return f.name.toLowerCase().includes(addFlowFolderSearch.toLowerCase())
  })
  const createFolderLabel = addFlowFolderType === 'list' ? 'wishlist' : addFlowFolderType
  const canCreateAddFlowFolder = !!addFlowFolderSearch.trim() && !addFlowCreatingFolder
  const hasExactAddFlowMatch = addFlowFolders.some(f => {
    const typeMatch = addFlowFolderType === 'binder' ? f.type === 'binder'
      : addFlowFolderType === 'deck' ? (f.type === 'deck' || f.type === 'builder_deck')
      : f.type === 'list'
    if (!typeMatch) return false
    return String(f.name || '').trim().toLowerCase() === addFlowFolderSearch.trim().toLowerCase()
  })
  const latestSetIcon = latestPending?.setCode ? getSetIcon(setIcons, latestPending.setCode) : null
  const pendingTotalQty = pendingCards.reduce((sum, card) => sum + (card.qty || 1), 0)
  const showManualSearchEmpty = manualSearchOpen &&
    manualSearchQuery.trim().length >= 2 &&
    !manualSearchLoading &&
    manualSearchResults.length === 0
  const hasFoilVersion = !latestPending ? false : (
    latestPending.foil ||
    !latestPrintingData ||
    latestPrintingData?.finishes?.includes('foil') ||
    latestPrintingData?.prices?.eur_foil != null ||
    latestPrintingData?.prices?.usd_foil != null
  )
  const latestPriceMeta = latestPending && latestPrintingData
    ? getPriceWithMeta(latestPrintingData, latestPending.foil, { price_source })
    : null
  const scannedValueMeta = pendingCards.reduce((acc, card) => {
    const priceMeta = printingDataById[card.id]
      ? getPriceWithMeta(printingDataById[card.id], card.foil, { price_source })
      : null
    if (!priceMeta) return acc
    if (!acc) {
      return {
        symbol: priceMeta.symbol,
        value: priceMeta.value * (card.qty || 1),
      }
    }
    return {
      ...acc,
      value: acc.value + (priceMeta.value * (card.qty || 1)),
    }
  }, null)

  const handleClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    setTimeout(() => {
      onClose?.()
    }, 220)
  }, [closing, onClose])

  const CORNER_ROTATIONS = [0, 90, 180, 270]

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={`${styles.root} ${isNative ? styles.rootNative : ''} ${closing ? styles.rootClosing : styles.rootEntering}`}>
      {!isNative && (
        <>
          <video ref={videoRef} className={styles.video} playsInline muted />
          <canvas ref={canvasRef} className={styles.hiddenCanvas} />
        </>
      )}

      <div className={`${styles.overlay} ${isNative ? styles.overlayNative : ''} ${closing ? styles.overlayClosing : styles.overlayEntering}`}>
        {/* Top bar */}
        <div className={styles.topBar}>
          <div className={styles.statusRow}>
            {errorMsg && (
              <div className={styles.statusPill}>Error: {errorMsg}</div>
            )}
            {!errorMsg && hashProgressVisible && (
              <div className={styles.loadingPill}>
                <span>
                  {({
                    'connecting':          'Connecting…',
                    'checking cache':      'Connecting…',
                    'downloading hashes':  'Loading database',
                    'loading hashes':      'Loading database',
                    'building index':      'Building index',
                    'finalizing':          'Finalizing',
                  }[hashLoadInfo?.phase] ?? 'Loading…')}
                  {hashLoadInfo?.totalCount ? ` ${(hashLoadInfo.loadedCount ?? 0).toLocaleString()}/${hashLoadInfo.totalCount.toLocaleString()}` : ''}
                </span>
                <div className={styles.loadingPillBar}>
                  <div className={styles.loadingPillFill} style={{ width: `${hashLoadInfo?.progress ?? 0}%` }} />
                </div>
              </div>
            )}
            {!errorMsg && !hashProgressVisible && preparing && (
              <div className={styles.loadingPill}>Starting…</div>
            )}
          </div>
          <div className={styles.controlMenu}>
            <button
              className={`${styles.menuIconBtn} ${styles.menuCloseBtn}`}
              onClick={handleClose}
              title="Close"
              aria-label="Close"
            >
              ✕
            </button>
            <button
              className={`${styles.menuIconBtn} ${basketExpanded ? styles.menuIconBtnActive : ''}`}
              onClick={() => basketTgl.toggle()}
              title="Scanned cards"
              aria-label="Scanned cards"
            >
              <svg viewBox="0 0 24 24" className={styles.menuIcon} aria-hidden="true">
                <path d="M6 5h12M6 12h12M6 19h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              {pendingTotalQty > 0 && <span className={styles.menuCount}>{pendingTotalQty}</span>}
            </button>
            <button
              className={styles.menuIconBtn}
              onClick={() => {
                manualSearchRequestRef.current += 1
                setManualSearchQuery('')
                setManualSearchResults([])
                setManualSearchLoading(false)
                manualTgl.show()
              }}
              title="Manual add"
              aria-label="Manual add"
            >
              <svg viewBox="0 0 24 24" className={styles.menuIcon} aria-hidden="true">
                <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className={`${styles.menuIconBtn} ${flashEnabled ? styles.menuIconBtnActive : ''}`}
              onClick={handleFlashToggle}
              title={flashSupported ? (flashEnabled ? 'Flash on' : 'Flash off') : 'Flash unavailable'}
              aria-label={flashSupported ? (flashEnabled ? 'Flash on' : 'Flash off') : 'Flash unavailable'}
              disabled={!flashSupported}
            >
              <svg viewBox="0 0 24 24" className={styles.menuIcon} aria-hidden="true">
                <path d="M13 2L6 13h5l-1 9 8-12h-5l0-8z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              className={`${styles.menuIconBtn} ${settingsOpen ? styles.menuIconBtnActive : ''}`}
              onClick={() => settingsTgl.toggle()}
              title="Scanner settings"
              aria-label="Scanner settings"
            >
              <svg viewBox="0 0 24 24" className={styles.menuIcon} aria-hidden="true">
                <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.92c.04-.36.07-.72.07-1.08s-.03-.73-.07-1.08l2.32-1.82c.21-.16.27-.46.13-.7l-2.2-3.81c-.13-.24-.42-.32-.66-.24l-2.74 1.1c-.57-.44-1.18-.81-1.85-1.09L14.05 2.1A.54.54 0 0 0 13.5 1.6h-3c-.27 0-.5.19-.54.46l-.41 2.89c-.67.28-1.29.65-1.85 1.09L5 4.94c-.25-.09-.53 0-.66.24L2.14 9c-.14.23-.08.53.13.7l2.32 1.82C4.53 11.27 4.5 11.63 4.5 12s.03.73.07 1.08L2.27 14.9c-.21.17-.27.47-.13.7l2.2 3.81c.13.24.41.32.66.24l2.74-1.1c.57.44 1.18.81 1.85 1.09l.41 2.9c.04.26.27.46.54.46h3c.27 0 .5-.2.54-.46l.41-2.9c.67-.28 1.28-.65 1.85-1.09l2.74 1.1c.25.08.53 0 .66-.24l2.2-3.81c.14-.23.08-.53-.13-.7l-2.32-1.82z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>

        {/* Targeting reticle */}
        {pendingCards.length > 0 && (
          <div className={styles.scannedValueBadge}>
            <span className={styles.scannedValueBadgeLabel}>Scanned Value</span>
            <span className={styles.scannedValueBadgeAmount}>
              {scannedValueMeta ? `${scannedValueMeta.symbol}${scannedValueMeta.value.toFixed(2)}` : '—'}
            </span>
          </div>
        )}

        {/* Idle ring — visible while scanning with no card detected */}
        {!detectedCorners && !preparing && (
          <div className={styles.scanIdleRing} aria-hidden="true" />
        )}

        {/* Tracking frame SVG — corners snap to detected card at ~15fps */}
        <svg className={styles.trackingOverlay} aria-hidden="true">
          {detectedCorners && (
            <polygon
              className={`${styles.trackingPoly} ${scanResult === 'found' ? styles.trackingPolyMatch : ''}`}
              points={detectedCorners.map(p => `${p.x},${p.y}`).join(' ')}
            />
          )}
          {detectedCorners && detectedCorners.map((pt, i) => (
            <g key={i}
              className={`${styles.trackingCornerGroup} ${scanResult === 'found' ? styles.trackingCornerMatch : ''} ${scanning ? styles.trackingCornerScanning : ''}`}
              style={{ transform: `translate(${pt.x}px, ${pt.y}px) rotate(${CORNER_ROTATIONS[i]}deg)` }}
            >
              <path d="M0,0 L16,0 M0,0 L0,16" className={styles.trackingCorner} />
            </g>
          ))}
        </svg>

        {/* Status elements fixed at frame center — spinner, scan line, set lock badge */}
        <div className={styles.frameCenterContent}>
          {preparing && !errorMsg && !hashProgressVisible && <div className={styles.preparingSpinner}>+</div>}
          {scanning && <div className={styles.pausedLabel}>Scanning...</div>}
          {lockSet && lockedSets.size > 0 && (
            <div className={styles.lockedSetBadge}>
              <span className={styles.lockedSetIcon}>⬡</span>
              {lockedSets.size === 1
                ? [...lockedSets][0].toUpperCase()
                : `${lockedSets.size} sets`}
              <button className={styles.lockedSetClear} onClick={() => setLockedSets(new Set())} title="Clear locked sets">✕</button>
            </div>
          )}
          {lockSet && lockedSets.size === 0 && (
            <div className={styles.lockedSetBadge} style={{ opacity: 0.45 }}>
              <span className={styles.lockedSetIcon}>⬡</span>
              Scan to lock set
            </div>
          )}
        </div>

        {/* Debug strip */}
        {DEBUG && debugInfo && (
          <div className={styles.debugStrip}>
            {debugInfo.dist}d {debugInfo.gap}g {debugInfo.src} {debugInfo.votes}v | {debugInfo.decision}{debugInfo.name ? ` - ${debugInfo.name}` : ''}
          </div>
        )}
        {DEBUG && !debugInfo && (
          <div className={styles.debugStrip}>
            hashes: {cardCount.toLocaleString()} {databaseService.isFullyLoaded ? 'yes' : '...'} | CV: {cvReady ? 'yes' : '...'} | DB: {dbReady ? 'yes' : '...'}
          </div>
        )}

        {saveNotice && (
          <div className={styles.saveNotice} role="status" aria-live="polite">
            {saveNotice}
          </div>
        )}

        {/* Bottom bar */}
        <div className={styles.bottomBar}>
          {latestPending && (
            <div className={styles.latestCardBar}>
              <div className={styles.latestCardMain}>
                {latestPending.imageUri
                  ? <img src={latestPending.imageUri} className={styles.latestCardImg} alt={latestPending.name} />
                  : <div className={styles.latestCardImgPlaceholder}>{latestPending.name[0]}</div>
                }
                <div className={styles.latestCardInfo}>
                  <div className={styles.latestCardName} title={latestPending.name}>{latestPending.name}</div>
                  <div className={styles.latestCardMeta}>
                    {latestPending.setCode?.toUpperCase() || '—'}
                    {latestPending.collNum ? ` #${latestPending.collNum}` : ''}
                  </div>
                  <div className={styles.latestCardPrice}>
                    {latestPriceMeta && latestPriceMeta.value >= minPriceThreshold ? formatPriceMeta(latestPriceMeta) : '—'}
                  </div>
                </div>
              </div>
              <div className={styles.latestCardActions}>
                <div className={styles.latestQtyControls}>
                  <button
                    className={styles.latestQtyBtn}
                    onClick={() => adjustPendingQty(latestPending.uid, -1)}
                    title="Decrease quantity"
                    aria-label="Decrease quantity"
                  >
                    -
                  </button>
                  <div className={styles.latestQtyValue}>{latestPending.qty || 1}</div>
                  <button
                    className={styles.latestQtyBtn}
                    onClick={() => adjustPendingQty(latestPending.uid, 1)}
                    title="Increase quantity"
                    aria-label="Increase quantity"
                  >
                    +
                  </button>
                </div>
                <button
                  className={styles.latestActionIconBtn}
                  onClick={() => openPrintingPicker(latestPending.uid)}
                  title="Change printing"
                  aria-label="Change printing"
                >
                  {latestSetIcon
                    ? <img src={latestSetIcon} alt="" className={styles.latestSetIcon} />
                    : (
                      <svg viewBox="0 0 24 24" className={styles.latestActionIcon} aria-hidden="true">
                        <path d="M6 4h9l3 3v13H6z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                        <path d="M15 4v4h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                      </svg>
                    )}
                </button>
                <select
                  className={styles.latestLanguageSelect}
                  value={latestPending.language || 'en'}
                  onChange={e => updatePending(latestPending.uid, { language: e.target.value })}
                  title="Card language"
                  aria-label="Card language"
                  disabled={latestLanguageOptions.length <= 1}
                >
                  {latestLanguageOptions.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <button
                  className={`${styles.latestActionIconBtn} ${latestPending.foil ? styles.latestActionBtnActive : ''}`}
                  onClick={() => updatePending(latestPending.uid, { foil: !latestPending.foil })}
                  title={hasFoilVersion ? (latestPending.foil ? 'Foil on' : 'Foil off') : 'No foil version'}
                  aria-label={hasFoilVersion ? (latestPending.foil ? 'Foil on' : 'Foil off') : 'No foil version'}
                  disabled={!hasFoilVersion}
                >
                  <span className={styles.latestFoilIcon} aria-hidden="true">✦</span>
                </button>
                <button
                  className={`${styles.latestActionIconBtn} ${styles.conditionBtn} ${(latestPending.condition || 'NM') !== 'NM' ? styles.latestActionBtnActive : ''}`}
                  onClick={() => updatePending(latestPending.uid, { condition: cycleCondition(latestPending.condition || 'NM') })}
                  title={`Condition: ${latestPending.condition || 'NM'} — tap to cycle`}
                  aria-label={`Condition: ${latestPending.condition || 'NM'}`}
                >
                  {latestPending.condition || 'NM'}
                </button>
                <button
                  className={`${styles.latestActionIconBtn} ${styles.latestActionDanger}`}
                  onClick={() => removePending(latestPending.uid)}
                  title="Remove"
                  aria-label="Remove"
                >
                  <span className={styles.latestActionX} aria-hidden="true">✕</span>
                </button>
              </div>
            </div>
          )}

          {/* Scan button / auto-scan indicator */}
          <div className={styles.btnRow}>
            {isReady && !autoScan && (
              <button className={styles.primaryBtn} onClick={handleScan} disabled={scanning}>
                {scanning ? 'Scanning...' : 'Scan'}
              </button>
            )}
            {isReady && autoScan && (
              <div className={`${styles.autoScanBadge} ${scanning ? styles.autoScanBadgeActive : ''}`}>
                <span className={styles.autoScanDot} />
                {scanning ? 'Scanning…' : 'Auto-scan on'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Basket overlay */}
      {(basketExpanded || basketClosing) && pendingCards.length > 0 && (
        <div className={`${styles.overlayPanel}${basketClosing ? ` ${styles.overlayPanelClosing}` : ''}`}>
          <div className={styles.overlayPanelHeader}>
            <span className={styles.overlayPanelTitle}>
              Scanned Cards
              <span className={styles.overlayPanelTitleValue}>
                {scannedValueMeta ? `${scannedValueMeta.symbol}${scannedValueMeta.value.toFixed(2)}` : '—'}
              </span>
            </span>
            <span className={styles.overlayPanelCount}>{pendingTotalQty}</span>
            <button className={styles.closeBtn} onClick={() => basketTgl.hide()}>✕</button>
          </div>
          <div className={styles.historyList}>
            {pendingCards.map(card => {
              const historyPrintingData = printingDataById[card.id] || null
              const historySetIcon = card.setCode ? getSetIcon(setIcons, card.setCode) : null
              const historyOracleId = historyPrintingData?.oracle_id || null
              const fallbackLanguageValue = card.language || 'en'
              const fallbackLanguage = CARD_LANGUAGES.find(([value]) => value === fallbackLanguageValue)
              const historyLanguageOptions = historyOracleId
                ? (languageOptionsByOracleId[historyOracleId] || (fallbackLanguage ? [fallbackLanguage] : [['en', 'EN']]))
                : (fallbackLanguage ? [fallbackLanguage] : [['en', 'EN']])
              const historyHasFoilVersion = (
                card.foil ||
                !historyPrintingData ||
                historyPrintingData?.finishes?.includes('foil') ||
                historyPrintingData?.prices?.eur_foil != null ||
                historyPrintingData?.prices?.usd_foil != null
              )
              const historyPriceMeta = historyPrintingData
                ? getPriceWithMeta(historyPrintingData, card.foil, { price_source })
                : null

              return (
                <div key={card.uid} className={styles.historyItem}>
                  {card.imageUri
                    ? <img src={card.imageUri} className={styles.historyItemImg} alt={card.name} />
                    : <div className={styles.historyItemImgPlaceholder}>{card.name[0]}</div>
                  }
                  <div className={styles.historyItemBody}>
                    <div className={styles.historyItemInfo}>
                      <div className={styles.historyItemName}>{card.name}</div>
                      <div className={styles.historyItemMeta}>
                        {card.setCode?.toUpperCase()}
                        {card.collNum ? ` #${card.collNum}` : ''}
                        {card.language && card.language !== 'en' ? ` - ${card.language.toUpperCase()}` : ''}
                        {card.foil ? ' - Foil' : ''}
                      </div>
                      <div className={styles.historyItemPrice}>
                        {historyPriceMeta ? formatPriceMeta(historyPriceMeta) : '—'}
                      </div>
                    </div>
                    <div className={styles.historyItemActions}>
                      <div className={styles.historyQtyControls}>
                        <button
                          className={styles.historyQtyBtn}
                          onClick={() => adjustPendingQty(card.uid, -1)}
                          title="Decrease quantity"
                          aria-label="Decrease quantity"
                        >
                          -
                        </button>
                        <div className={styles.historyQtyValue}>{card.qty || 1}</div>
                        <button
                          className={styles.historyQtyBtn}
                          onClick={() => adjustPendingQty(card.uid, 1)}
                          title="Increase quantity"
                          aria-label="Increase quantity"
                        >
                          +
                        </button>
                      </div>
                      <button
                        className={styles.historyActionIconBtn}
                        onClick={() => openPrintingPicker(card.uid)}
                        title="Change printing"
                        aria-label="Change printing"
                      >
                        {historySetIcon
                          ? <img src={historySetIcon} alt="" className={styles.historySetIcon} />
                          : (
                            <svg viewBox="0 0 24 24" className={styles.historyActionIcon} aria-hidden="true">
                              <path d="M6 4h9l3 3v13H6z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                              <path d="M15 4v4h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                            </svg>
                          )}
                      </button>
                      <select
                        className={styles.historyLanguageSelect}
                        value={card.language || 'en'}
                        onChange={e => updatePending(card.uid, { language: e.target.value })}
                        title="Card language"
                        aria-label="Card language"
                        disabled={historyLanguageOptions.length <= 1}
                      >
                        {historyLanguageOptions.map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                      <button
                        className={`${styles.historyActionIconBtn} ${card.foil ? styles.latestActionBtnActive : ''}`}
                        onClick={() => updatePending(card.uid, { foil: !card.foil })}
                        title={historyHasFoilVersion ? (card.foil ? 'Foil on' : 'Foil off') : 'No foil version'}
                        aria-label={historyHasFoilVersion ? (card.foil ? 'Foil on' : 'Foil off') : 'No foil version'}
                        disabled={!historyHasFoilVersion}
                      >
                        <span className={styles.historyFoilIcon} aria-hidden="true">✦</span>
                      </button>
                      <button
                        className={`${styles.historyActionIconBtn} ${styles.conditionBtn} ${(card.condition || 'NM') !== 'NM' ? styles.latestActionBtnActive : ''}`}
                        onClick={() => updatePending(card.uid, { condition: cycleCondition(card.condition || 'NM') })}
                        title={`Condition: ${card.condition || 'NM'} — tap to cycle`}
                        aria-label={`Condition: ${card.condition || 'NM'}`}
                      >
                        {card.condition || 'NM'}
                      </button>
                      <button
                        className={`${styles.historyActionIconBtn} ${styles.latestActionDanger}`}
                        onClick={() => removePending(card.uid)}
                        title="Remove"
                        aria-label="Remove"
                      >
                        <span className={styles.historyActionX} aria-hidden="true">✕</span>
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          <div className={styles.historyFooter}>
            <button className={styles.historyAddBtn} onClick={openAddFlow}>
              Add {pendingTotalQty}
            </button>
          </div>
        </div>
      )}

      {/* Printing picker overlay */}
      {(printingPickerFor || printingPickerClosing) && (
        <div className={`${styles.overlayPanel}${printingPickerClosing ? ` ${styles.overlayPanelClosing}` : ''}`}>
          <div className={styles.overlayPanelHeader}>
            <span className={styles.overlayPanelTitle}>Choose Printing</span>
            <button className={styles.closeBtn} onClick={closePrintingPicker}>✕</button>
          </div>
          <div className={styles.searchInputRow}>
            <input
              className={styles.searchInput}
              placeholder="Filter by set name or code…"
              value={printingPickerSearch}
              onChange={e => setPrintingPickerSearch(e.target.value)}
              autoFocus
            />
          </div>
          {printingPickerLoading && <div className={styles.overlayPanelState}>Loading…</div>}
          <div className={styles.printingGrid}>
            {printingPickerResults.filter(sf => {
              if (!printingPickerSearch) return true
              const q = printingPickerSearch.toLowerCase()
              return (sf.set_name?.toLowerCase().includes(q)) || (sf.set?.toLowerCase().includes(q))
            }).map(sf => {
              const img = getCardImg(sf)
              const pickerCard = pendingCards.find(c => c.uid === printingPickerFor)
              const isActive = pickerCard?.id === sf.id
              const setIcon = sf.set ? getSetIcon(setIcons, sf.set) : null
              const regularPriceMeta = getPriceWithMeta(sf, false, { price_source })
              const foilPriceMeta = getPriceWithMeta(sf, true, { price_source })
              const activePriceMeta = getPriceWithMeta(sf, pickerCard?.foil, { price_source })
              return (
                <div
                  key={sf.id}
                  className={`${styles.printingCard} ${isActive ? styles.printingCardActive : ''}`}
                  onClick={() => selectPrinting(printingPickerFor, sf)}
                >
                  {img && <img src={img} className={styles.printingCardImg} alt={sf.name} />}
                  <div className={styles.printingCardLabel}>
                    {setIcon && <img src={setIcon} alt="" className={styles.printingCardSetIcon} />}
                    <span>{sf.set?.toUpperCase()} #{sf.collector_number}</span>
                  </div>
                  <div className={styles.printingCardPrice}>
                    {activePriceMeta ? formatPriceMeta(activePriceMeta) : '—'}
                  </div>
                  <div className={styles.printingCardPriceMeta}>
                    <span>R {regularPriceMeta ? formatPriceMeta(regularPriceMeta) : '—'}</span>
                    <span>F {foilPriceMeta ? formatPriceMeta(foilPriceMeta) : '—'}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Manual search overlay */}
      {(manualSearchOpen || manualSearchClosing) && (
        <div className={`${styles.overlayPanel}${manualSearchClosing ? ` ${styles.overlayPanelClosing}` : ''}`}>
          <div className={styles.overlayPanelHeader}>
            <span className={styles.overlayPanelTitle}>Add Card Manually</span>
            <button className={styles.closeBtn} onClick={() => { manualSearchRequestRef.current += 1; manualTgl.hide(); setManualSearchQuery(''); setManualSearchResults([]); setManualSearchLoading(false) }}>✕</button>
          </div>
          <div className={styles.searchInputRow}>
            <input
              className={styles.searchInput}
              placeholder="Search card name…"
              value={manualSearchQuery}
              onChange={e => setManualSearchQuery(e.target.value)}
              autoFocus
            />
          </div>
          {manualSearchLoading && <div className={styles.overlayPanelState}>Searching…</div>}
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
            {showManualSearchEmpty && (
              <div className={styles.overlayPanelEmpty}>No cards found</div>
            )}
          </div>
        </div>
      )}

      {/* Add flow overlay */}
      {(addFlowOpen || addFlowClosing) && (
        <div className={`${styles.overlayPanel}${addFlowClosing ? ` ${styles.overlayPanelClosing}` : ''}`}>
          <div className={styles.overlayPanelHeader}>
            <span className={styles.overlayPanelTitle}>
              Add {pendingCards.length} Card{pendingCards.length !== 1 ? 's' : ''}
              <span className={styles.overlayPanelTitleValue}>
                {scannedValueMeta ? `${scannedValueMeta.symbol}${scannedValueMeta.value.toFixed(2)}` : '—'}
              </span>
            </span>
            <button className={styles.closeBtn} onClick={() => addFlowTgl.hide()}>✕</button>
          </div>

          {/* Review list */}
          <div className={styles.reviewList}>
            {pendingCards.map(c => {
              const reviewPriceMeta = printingDataById[c.id]
                ? getPriceWithMeta(printingDataById[c.id], c.foil, { price_source })
                : null
              return (
              <div key={c.uid} className={styles.reviewItem}>
                {c.imageUri && <img src={c.imageUri} className={styles.reviewItemImg} alt={c.name} />}
                <div className={styles.reviewItemInfo}>
                  <span className={styles.reviewItemName}>{c.name}</span>
                  <span className={styles.reviewItemMeta}>{c.setCode?.toUpperCase()}{c.foil ? ' · Foil' : ''}{c.qty > 1 ? ` ×${c.qty}` : ''}</span>
                </div>
                <span className={styles.reviewItemPrice}>
                  {reviewPriceMeta ? formatPriceMeta(reviewPriceMeta) : '—'}
                </span>
              </div>
              )
            })}
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
          <button
            className={styles.inlineCreateBtn}
            onClick={createAddFlowFolder}
            disabled={!canCreateAddFlowFolder || hasExactAddFlowMatch}
          >
            {addFlowCreatingFolder ? `Creating ${createFolderLabel}…` : `+ Create new ${createFolderLabel}`}
          </button>

          {/* Folder list */}
          {addFlowFoldersLoading
            ? <div className={styles.overlayPanelState}>Loading…</div>
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
                  <div className={styles.overlayPanelEmpty}>No {addFlowFolderType}s found</div>
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

      {/* Scanner settings overlay */}
      {(settingsOpen || settingsClosing) && (
        <div className={`${styles.overlayPanel}${settingsClosing ? ` ${styles.overlayPanelClosing}` : ''}`}>
          <div className={styles.overlayPanelHeader}>
            <span className={styles.overlayPanelTitle}>Scanner Settings</span>
            <button className={styles.closeBtn} onClick={() => settingsTgl.hide()}>✕</button>
          </div>

          <div className={styles.settingsRow}>
            <div className={styles.settingsRowLabel}>
              <span className={styles.settingsRowTitle}>Auto-scan</span>
              <span className={styles.settingsRowDesc}>Scan continuously without pressing the button</span>
            </div>
            <button role="switch" aria-checked={autoScan}
              className={`${styles.toggle} ${autoScan ? styles.toggleOn : ''}`}
              onClick={() => setAutoScan(v => !v)}>
              <span className={styles.toggleThumb} />
            </button>
          </div>

          <div className={styles.settingsRow}>
            <div className={styles.settingsRowLabel}>
              <span className={styles.settingsRowTitle}>Prefer foils</span>
              <span className={styles.settingsRowDesc}>Scanned cards are pre-selected as foil when available</span>
            </div>
            <button role="switch" aria-checked={preferFoil}
              className={`${styles.toggle} ${preferFoil ? styles.toggleOn : ''}`}
              onClick={() => setPreferFoil(v => !v)}>
              <span className={styles.toggleThumb} />
            </button>
          </div>

          <div className={styles.settingsRow}>
            <div className={styles.settingsRowLabel}>
              <span className={styles.settingsRowTitle}>Scan sounds</span>
              <span className={styles.settingsRowDesc}>Play a tone when a card is matched — pitch varies by card value</span>
            </div>
            <button role="switch" aria-checked={scanSounds}
              className={`${styles.toggle} ${scanSounds ? styles.toggleOn : ''}`}
              onClick={() => setScanSounds(v => !v)}>
              <span className={styles.toggleThumb} />
            </button>
          </div>

          <div className={styles.settingsRow}>
            <div className={styles.settingsRowLabel}>
              <span className={styles.settingsRowTitle}>Min. price display</span>
              <span className={styles.settingsRowDesc}>Hide price on cards worth less than this amount (0 = always show)</span>
            </div>
            <div className={styles.settingsNumericInput}>
              <button className={styles.settingsNumericBtn} onClick={() => setMinPriceThreshold(v => Math.max(0, +(v - 0.5).toFixed(2)))}>−</button>
              <span className={styles.settingsNumericValue}>{minPriceThreshold === 0 ? 'Off' : `${minPriceThreshold.toFixed(2)}`}</span>
              <button className={styles.settingsNumericBtn} onClick={() => setMinPriceThreshold(v => +(v + 0.5).toFixed(2))}>+</button>
            </div>
          </div>

          <div className={styles.settingsRow}>
            <div className={styles.settingsRowLabel}>
              <span className={styles.settingsRowTitle}>Lock set</span>
              <span className={styles.settingsRowDesc}>
                Only cards from selected sets are accepted.
                {lockSet && (
                  <div className={styles.setChipRow}>
                    <button
                      className={styles.settingsInlineBtn}
                      onClick={() => { setPickerTgl.show(); settingsTgl.hide() }}
                    >
                      {lockedSets.size === 0 ? 'Choose sets…' : 'Edit sets…'}
                    </button>
                    {lockedSets.size > 0 && (
                      <>
                        {[...lockedSets].map(code => (
                          <span key={code} className={styles.setChip}>
                            {getSetIcon(setIcons, code) && <img src={getSetIcon(setIcons, code)} alt="" className={styles.setChipIcon} />}
                            {code.toUpperCase()}
                            <button className={styles.setChipRemove} onClick={() => setLockedSets(prev => { const next = new Set(prev); next.delete(code); return next })} title={`Remove ${code.toUpperCase()}`}>✕</button>
                          </span>
                        ))}
                        <button className={styles.settingsInlineBtn} onClick={() => setLockedSets(new Set())}>Clear all</button>
                      </>
                    )}
                  </div>
                )}
              </span>
            </div>
            <button role="switch" aria-checked={lockSet}
              className={`${styles.toggle} ${lockSet ? styles.toggleOn : ''}`}
              onClick={() => setLockSet(v => !v)}>
              <span className={styles.toggleThumb} />
            </button>
          </div>

          {sessionStatsDisplay.attempts > 0 && (
            <div className={styles.sessionStats}>
              <span className={styles.sessionStatsSectionLabel}>Session</span>
              <div className={styles.sessionStatsRow}>
                <span>{sessionStatsDisplay.hits} / {sessionStatsDisplay.attempts} matched</span>
                <span>{Math.round(sessionStatsDisplay.hits / sessionStatsDisplay.attempts * 100)}%</span>
              </div>
              <div className={styles.sessionStatsRow}>
                <span>Avg scan time</span>
                <span>{Math.round(sessionStatsDisplay.totalMs / sessionStatsDisplay.attempts)}ms</span>
              </div>
              <button
                className={styles.settingsInlineBtn}
                onClick={() => { sessionStatsRef.current = { attempts: 0, hits: 0, totalMs: 0 }; setSessionStatsDisplay({ attempts: 0, hits: 0, totalMs: 0 }) }}
                style={{ marginTop: 4 }}
              >
                Reset stats
              </button>
            </div>
          )}
        </div>
      )}

      {/* Set picker overlay */}
      {(setPickerOpen || setPickerClosing) && (
        <div className={`${styles.overlayPanel}${setPickerClosing ? ` ${styles.overlayPanelClosing}` : ''}`}>
          <div className={styles.overlayPanelHeader}>
            <span className={styles.overlayPanelTitle}>Lock Sets</span>
            <button className={styles.closeBtn} onClick={() => setPickerTgl.hide()}>✕</button>
          </div>
          <div className={styles.setPickerSearch}>
            <input
              className={styles.setPickerInput}
              type="text"
              placeholder="Search by name or set code…"
              value={setPickerSearch}
              onChange={e => setSetPickerSearch(e.target.value)}
              autoFocus
            />
          </div>
          {lockedSets.size > 0 && (
            <div className={styles.setPickerSelected}>
              {[...lockedSets].map(code => (
                <span key={code} className={styles.setChip}>
                  {getSetIcon(setIcons, code) && <img src={getSetIcon(setIcons, code)} alt="" className={styles.setChipIcon} />}
                  {code.toUpperCase()}
                  <button className={styles.setChipRemove} onClick={() => setLockedSets(prev => { const next = new Set(prev); next.delete(code); return next })}>✕</button>
                </span>
              ))}
              <button className={styles.settingsInlineBtn} onClick={() => setLockedSets(new Set())}>Clear all</button>
            </div>
          )}
          {setPickerLoading && <div className={styles.overlayPanelState}>Loading sets…</div>}
          <div className={styles.setPickerList}>
            {setPickerSets
              .filter(s => {
                const q = setPickerSearch.toLowerCase().trim()
                if (!q) return true
                return s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)
              })
              .map(s => {
                const isLocked = lockedSets.has(s.code)
                const icon = getSetIcon(setIcons, s.code) || s.icon
                return (
                  <button
                    key={s.code}
                    className={`${styles.setPickerRow} ${isLocked ? styles.setPickerRowLocked : ''}`}
                    onClick={() => setLockedSets(prev => {
                      const next = new Set(prev)
                      if (next.has(s.code)) next.delete(s.code)
                      else next.add(s.code)
                      return next
                    })}
                  >
                    {icon && <img src={icon} alt="" className={styles.setPickerRowIcon} />}
                    <span className={styles.setPickerRowName}>{s.name}</span>
                    <span className={styles.setPickerRowCode}>{s.code.toUpperCase()}</span>
                    {isLocked && <span className={styles.setPickerRowCheck}>✓</span>}
                  </button>
                )
              })
            }
          </div>
          <div className={styles.historyFooter}>
            <button className={styles.historyAddBtn} onClick={() => setPickerTgl.hide()}>
              Done {lockedSets.size > 0 ? `(${lockedSets.size} set${lockedSets.size !== 1 ? 's' : ''} locked)` : ''}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

