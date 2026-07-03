/**
 * collectorOcr.js — collector-line OCR for printing disambiguation
 *
 * Modern cards (M15 frame, Aug 2014+) print two lines in the bottom-left:
 *
 *     0123/0281 R          ← collector number (often zero-padded) + rarity
 *     FDN • EN             ← printed set code + language
 *
 * Art-based hashing cannot tell same-art reprints apart; this line can. The
 * scanner OCRs the high-res strip (extracted from the full-res frame by the
 * vision worker) once per accepted scan and uses the result ONLY to
 *   1. switch the matched card to the exact printing (same name only), and
 *   2. auto-set the card language.
 * It never overrides the matched card name, so an OCR misread can't add a
 * wrong card. Pre-2014 frames have no printed set code — parsing fails and
 * the whole step is a silent no-op.
 *
 * Tesseract.js is lazy-loaded on first use with SELF-HOSTED assets under
 * public/ocr/ (worker, SIMD LSTM core, eng traineddata) — no CDN dependency
 * at runtime. Browsers without WASM SIMD simply get OCR disabled.
 */

// Printed language codes → app language values (CARD_LANGUAGES in CardScanner).
// Cards have printed both JP and JA over the years; Chinese uses CS/CT.
const PRINTED_LANGS = {
  EN: 'en', DE: 'de', FR: 'fr', IT: 'it', ES: 'es', SP: 'es', PT: 'pt',
  JA: 'ja', JP: 'ja', KO: 'ko', KR: 'ko', RU: 'ru',
  CS: 'zhs', ZHS: 'zhs', CT: 'zht', ZHT: 'zht',
}
const LANG_ALTERNATION = Object.keys(PRINTED_LANGS).sort((a, b) => b.length - a.length).join('|')
// `SET • EN` — the bullet comes back from OCR as almost anything (•·*®°e-),
// so allow a short non-alphanumeric gap between set code and language.
// Set codes are 3–6 alphanumerics containing at least one letter ('2XM',
// '40K' start with a digit).
const SET_TOKEN = '((?=[0-9]*[A-Z])[A-Z0-9]{3,6})'
const SET_LANG_RE = new RegExp(`(?:^|[^A-Z0-9])${SET_TOKEN}[^A-Z0-9\\n]{1,4}(${LANG_ALTERNATION})(?:[^A-Z0-9]|$)`, 'm')
// OCR sometimes swallows the bullet entirely → `MKMEN`. Split candidates from
// concatenated tokens too; bogus splits ("GREEN" → gre+EN) die harmlessly in
// the pack lookup + name guard downstream.
const SET_LANG_JOINED_RE = new RegExp(`(?:^|[^A-Z0-9])((?=[0-9]*[A-Z])[A-Z0-9]{3,4})(${LANG_ALTERNATION})(?:[^A-Z0-9]|$)`, 'gm')
const COLL_SLASH_RE = /(\d{1,4})\s*\/\s*\d{1,4}/

/** Strip leading zeros: printed `0123` is Scryfall collector_number `123`. */
export function normalizeCollectorNumber(value) {
  const m = String(value ?? '').trim().match(/^0*(\d+)([a-z★†]*)$/i)
  if (!m) return null
  return `${m[1]}${m[2].toLowerCase()}`
}

/**
 * Parse raw OCR text of the collector strip.
 * Returns { setCode, setCandidates, collNum, collCandidates, lang } —
 * parsing is lenient by design: every plausible set code and collector
 * number is returned (in confidence order) and the caller validates each
 * combination against the hash pack + the matched card name, so a noisy
 * token can't cause a wrong correction.
 */
export function parseCollectorLine(text) {
  const raw = String(text ?? '').toUpperCase()

  const setCandidates = []
  let lang = null
  const pushSet = code => {
    const norm = code.toLowerCase()
    if (!setCandidates.includes(norm)) setCandidates.push(norm)
  }
  const setLang = raw.match(SET_LANG_RE)
  if (setLang) {
    pushSet(setLang[1])
    lang = PRINTED_LANGS[setLang[2]] ?? null
  }
  for (const m of raw.matchAll(SET_LANG_JOINED_RE)) {
    pushSet(m[1])
    lang ??= PRINTED_LANGS[m[2]] ?? null
  }

  const collCandidates = []
  const pushColl = v => {
    const norm = normalizeCollectorNumber(v)
    if (norm && !collCandidates.includes(norm)) collCandidates.push(norm)
  }
  // 1. `123/281` slash form (2014–2019 frames)
  const slash = raw.match(COLL_SLASH_RE)
  if (slash) pushColl(slash[1])
  // 2. zero-padded tokens — a leading 0 is a strong collector-number signal
  //    (modern cards print `0123`); optional letter suffix ('23s' promos)
  for (const m of raw.matchAll(/\b0+(\d{1,3}[A-Z]?)\b/g)) pushColl(m[1])
  // 3. any remaining 2–4 digit token (skip 1-digit noise unless zero-padded)
  for (const m of raw.matchAll(/\b(\d{2,4})[A-Z]?\b/g)) pushColl(m[1])

  return {
    setCode: setCandidates[0] ?? null,
    setCandidates,
    collNum: collCandidates[0] ?? null,
    collCandidates,
    lang,
  }
}

/**
 * Expand OCR set-code candidates against the list of real set codes:
 * exact matches keep their priority; unknown candidates contribute their
 * edit-distance-1 neighbours (single OCR misreads like FON → fdn).
 * Everything is still validated by pack lookup + name guard downstream.
 */
export function expandSetCandidates(parsedSets, knownSets) {
  const known = new Set(knownSets)
  const out = []
  const push = s => { if (!out.includes(s)) out.push(s) }
  for (const cand of parsedSets) {
    if (known.has(cand)) { push(cand); continue }
    for (const set of known) {
      if (withinEditDistance1(cand, set)) push(set)
    }
  }
  return out
}

function withinEditDistance1(a, b) {
  if (a === b) return true
  const la = a.length, lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) {
    let diff = 0
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) diff++
    return diff === 1
  }
  const [shorter, longer] = la < lb ? [a, b] : [b, a]
  let i = 0, j = 0, skipped = false
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) { i++; j++; continue }
    if (skipped) return false
    skipped = true
    j++
  }
  return true
}

// ── Tesseract plumbing (browser) ─────────────────────────────────────────────

let _workerPromise = null
let _ocrDisabled = false
let _queue = Promise.resolve()

async function ensureOcrWorker() {
  if (_ocrDisabled) return null
  if (_workerPromise) return _workerPromise
  _workerPromise = (async () => {
    const { createWorker, PSM } = await import('tesseract.js')
    const base = `${import.meta.env.BASE_URL}ocr/`
    // oem 1 = LSTM only; core pinned to the SIMD LSTM build we self-host.
    const worker = await createWorker('eng', 1, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}core/tesseract-core-simd-lstm.wasm.js`,
      langPath: `${base}lang/`,
      gzip: true,
    })
    await worker.setParameters({
      // Without a DPI hint tesseract assumes ~25 dpi for the strip and mangles
      // its internal scaling ("Invalid resolution" warning).
      user_defined_dpi: '300',
    })
    return { worker, PSM }
  })()
  _workerPromise.catch(() => {
    _ocrDisabled = true
    _workerPromise = null
  })
  return _workerPromise
}

function stripToCanvas(strip) {
  const canvas = document.createElement('canvas')
  canvas.width = strip.width
  canvas.height = strip.height
  const ctx = canvas.getContext('2d')
  const imageData = new ImageData(new Uint8ClampedArray(strip.data), strip.width, strip.height)
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

// Recognize with per-call page-seg mode + whitelist, serialized on the single
// Tesseract worker (setParameters is worker-global, so it must sit inside the
// same queue slot as the recognize it configures).
function recognizeText(strip, { psm, whitelist }) {
  const run = async () => {
    if (!strip?.data?.length) return null
    const ready = await ensureOcrWorker().catch(() => null)
    if (!ready) return null
    const { worker, PSM } = ready
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: psm === 'line' ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK,
        // LSTM only partially honors the whitelist — parsing is noise-tolerant
        // regardless, but this still trims the worst confusions.
        tessedit_char_whitelist: whitelist,
      })
      const { data } = await worker.recognize(stripToCanvas(strip))
      return data?.text ?? ''
    } catch {
      return null
    }
  }
  _queue = _queue.then(run, run)
  return _queue
}

/**
 * OCR a collector strip ({ data, width, height }, preprocessed by the vision
 * worker) and parse it. Returns { setCode, collNum, lang } or null when OCR
 * is unavailable/failed. Calls are serialized (single Tesseract worker).
 */
export async function recognizeCollectorStrip(strip) {
  const text = await recognizeText(strip, {
    psm: 'block',
    whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/•* ',
  })
  if (text == null) return null
  return { ...parseCollectorLine(text), raw: text }
}

/**
 * OCR a title-bar strip. Returns the raw text (caller fuzzy-matches it
 * against the card-name index) or null when OCR is unavailable/failed.
 */
export function recognizeTitleStrip(strip) {
  // No whitelist: names need lowercase + punctuation, and the fuzzy name
  // match downstream absorbs stray symbols (mana cost at the right edge).
  return recognizeText(strip, { psm: 'line', whitelist: '' })
}

/**
 * Warm the Tesseract engine (worker + core + traineddata) ahead of the first
 * recognition — otherwise the first hash-miss rescue stalls a scan for the
 * multi-second engine init. Assets are same-origin/SW-cached. Best-effort.
 */
export function prewarmOcr() {
  ensureOcrWorker().catch(() => {})
}
