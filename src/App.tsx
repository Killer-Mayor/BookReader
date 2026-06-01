'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent } from 'react'
import {
  BookOpen,
  Bookmark,
  Check,
  Cloud,
  X,
  Eye,
  FileText,
  Gauge,
  Headphones,
  LogOut,
  Mail,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
  Square,
  Upload,
  Volume2,
  ZoomIn,
  ZoomOut,
  Navigation,
  Sun,
} from 'lucide-react'
import JSZip from 'jszip'
import {
  bookStorageBucket,
  getSupabaseClient,
  isSupabaseConfigured,
  type BackendUser,
  type RemoteBook,
  type RemoteBookmark,
  type RemoteProgress,
  type RemoteSettings,
} from './lib/supabase'
import {
  KOKORO_VOICES,
  isKokoroVoiceId,
  useTts,
  type KokoroVoiceId,
  type SpeechBoundary,
  type TtsEngine,
} from './hooks/useTts'

type SourceType = 'txt' | 'epub' | 'pdf'

type ReaderBook = {
  id: string
  title: string
  sourceType: SourceType
  text: string
  importedAt: number
  pdfDataUrl?: string
  pdfPages?: PdfPageInfo[]
  pdfRegions?: PdfTextRegion[]
  mathRegionCount?: number
}

type BookmarkEntry = {
  id: string
  label: string
  wordIndex: number
  createdAt: number
}

type ReaderSettings = {
  rate: number
  pitch: number
  volume: number
  voiceURI: string
  ttsEngine: TtsEngine
  kokoroVoiceId: KokoroVoiceId
  profile: VoiceProfileId
  focusMode: boolean
  theme: ReaderTheme
  textScale: number
  lineHeight: number
  fontFamily: ReaderFont
}

type WordSpan = {
  text: string
  start: number
  end: number
}

type PdfPageInfo = {
  pageNumber: number
  width: number
  height: number
  hasImages?: boolean
}

type PdfTextRegion = {
  wordIndex: number
  pageNumber: number
  left: number
  top: number
  width: number
  height: number
  isMath: boolean
  isVisual?: boolean
}

type Token =
  | { kind: 'word'; value: string; wordIndex: number }
  | { kind: 'space'; value: string; tokenIndex: number }

type VoiceProfileId = 'balanced' | 'deepFocus' | 'bright' | 'night'
type ReaderTheme = 'light' | 'sepia' | 'dark'
type ReaderFont = 'serif' | 'sans'

type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

type ExtractedBook = {
  title: string
  sourceType: SourceType
  text: string
  pdfDataUrl?: string
  pdfPages?: PdfPageInfo[]
  pdfRegions?: PdfTextRegion[]
  mathRegionCount?: number
}

type CloudStatus = 'disabled' | 'signed-out' | 'syncing' | 'ready' | 'error'

const STORAGE_KEYS = {
  book: 'aural-reader.book',
  settings: 'aural-reader.settings',
  progress: 'aural-reader.progress',
  bookmarks: 'aural-reader.bookmarks',
}

const DEFAULT_TEXT = `Drop in a book and make the page speak with you.

This local reader is set up for txt, epub, and pdf files. Choose a local AI voice, tune the speed, place bookmarks, and use focus mode when you want the text to take over the room.

Local AI voices run in your browser with a one-time model download. Browser voices are still available as a private fallback, and cloud engines such as OpenAI, ElevenLabs, Google Cloud Text-to-Speech, Azure Speech, or Amazon Polly can be added later behind the same controls.`

const DEFAULT_BOOK: ReaderBook = {
  id: 'welcome',
  title: 'Your Audio Reader',
  sourceType: 'txt',
  text: DEFAULT_TEXT,
  importedAt: Date.now(),
}

const DEFAULT_SETTINGS: ReaderSettings = {
  rate: 1,
  pitch: 1,
  volume: 0.9,
  voiceURI: '',
  ttsEngine: 'local',
  kokoroVoiceId: 'af_heart',
  profile: 'balanced',
  focusMode: false,
  theme: 'light',
  textScale: 1,
  lineHeight: 1.78,
  fontFamily: 'serif',
}

const READER_THEMES: Record<ReaderTheme, string> = {
  light: 'Light',
  sepia: 'Warm',
  dark: 'Dark',
}

const READER_FONTS: Record<ReaderFont, string> = {
  serif: 'Serif',
  sans: 'Sans',
}

const VOICE_PROFILES: Record<
  VoiceProfileId,
  { label: string; description: string; rate: number; pitch: number }
> = {
  balanced: {
    label: 'Balanced',
    description: 'Clean pace for everyday reading',
    rate: 1,
    pitch: 1,
  },
  deepFocus: {
    label: 'Deep focus',
    description: 'Slower and steadier for dense books',
    rate: 0.82,
    pitch: 0.86,
  },
  bright: {
    label: 'Bright',
    description: 'Crisper energy for light material',
    rate: 1.15,
    pitch: 1.08,
  },
  night: {
    label: 'Night',
    description: 'Soft pace for low-light sessions',
    rate: 0.9,
    pitch: 0.92,
  },
}

const CHUNK_TARGET = 1800
const CHUNK_LIMIT = 2800
const LOCAL_TTS_CHUNK_TARGET = 900
const LOCAL_TTS_CHUNK_LIMIT = 1400
const KOKORO_CHUNK_TARGET = 420
const KOKORO_CHUNK_LIMIT = 760
const PDF_CHUNK_WORD_LIMIT = 95
const LOCAL_TTS_PDF_CHUNK_WORD_LIMIT = 60
const KOKORO_PDF_CHUNK_WORD_LIMIT = 34
const PDF_EQUATION_PAUSE_MS = 1100
const PDF_IMPORT_YIELD_EVERY_PAGES = 3
const MAX_PERSISTED_BOOK_CHARS = 250_000
const DEBUG_PREFIX = '[AudioReader]'
const PDFJS_VERSION = '5.6.205'
const MATH_TEXT_PATTERN =
  /([=<>≤≥≈≠∑∫√∞±×÷∂∆∇πµΩα-ωΑ-Ω^_{}|])|(\d+\s*[+\-*/=]\s*\d)|(\b[a-z]\s*[=<>]\s*)/i

type PdfDocumentProxy = Awaited<ReturnType<PdfjsLib['getDocument']>['promise']>
type ImportProgress = (message: string) => void
type PdfLoadingProgress = { loaded: number; total: number }

let pdfjsLibPromise: Promise<PdfjsLib> | null = null

function getPdfModuleSrc() {
  return `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.mjs`
}

function getPdfWorkerSrc() {
  return `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.worker.min.mjs`
}

async function loadPdfjs() {
  if (!pdfjsLibPromise) {
    const importBrowserModule = new Function('url', 'return import(url)') as (
      url: string,
    ) => Promise<PdfjsLib>

    pdfjsLibPromise = importBrowserModule(getPdfModuleSrc()).then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = getPdfWorkerSrc()
      return pdfjsLib
    })
  }

  return pdfjsLibPromise
}

function debugLog(event: string, details?: unknown) {
  const elapsed = `${Math.round(performance.now())}ms`

  if (details === undefined) {
    console.info(DEBUG_PREFIX, elapsed, event)
    return
  }

  console.info(DEBUG_PREFIX, elapsed, event, details)
}

function debugError(event: string, error: unknown) {
  console.error(DEBUG_PREFIX, `${Math.round(performance.now())}ms`, event, error)
}

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function readStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback

  return safeParse<T>(window.localStorage.getItem(key), fallback)
}

function writeStorage(key: string, value: unknown) {
  if (typeof window === 'undefined') return

  window.localStorage.setItem(key, JSON.stringify(value))
}

function normalizeText(text: string) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function getPersistableBook(book: ReaderBook): ReaderBook {
  if (book.sourceType === 'pdf') {
    return {
      id: book.id,
      title: book.title,
      sourceType: 'pdf',
      text:
        'This PDF was opened in a previous browser session. Re-upload the file to restore the rendered pages and narration map.',
      importedAt: book.importedAt,
      mathRegionCount: book.mathRegionCount,
    }
  }

  if (book.text.length > MAX_PERSISTED_BOOK_CHARS) {
    return {
      id: book.id,
      title: book.title,
      sourceType: book.sourceType,
      text:
        'This book is too large to save fully in browser storage. Re-upload it to continue from saved progress.',
      importedAt: book.importedAt,
    }
  }

  return book
}

async function dataUrlToUint8Array(dataUrl: string) {
  const response = await fetch(dataUrl)
  return new Uint8Array(await response.arrayBuffer())
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

function titleFromFileName(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim()
}

function sourceTypeFromFile(file: File): SourceType | null {
  const lowerName = file.name.toLowerCase()

  if (lowerName.endsWith('.txt')) return 'txt'
  if (lowerName.endsWith('.epub')) return 'epub'
  if (lowerName.endsWith('.pdf')) return 'pdf'

  return null
}

function mimeTypeForSource(sourceType: SourceType) {
  if (sourceType === 'pdf') return 'application/pdf'
  if (sourceType === 'epub') return 'application/epub+zip'

  return 'text/plain'
}

function safeFileSegment(fileName: string) {
  return fileName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'book'
}

function isRemoteBookId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function isVoiceProfileId(value: unknown): value is VoiceProfileId {
  return typeof value === 'string' && value in VOICE_PROFILES
}

function isReaderTheme(value: unknown): value is ReaderTheme {
  return typeof value === 'string' && value in READER_THEMES
}

function isReaderFont(value: unknown): value is ReaderFont {
  return typeof value === 'string' && value in READER_FONTS
}

function isTtsEngine(value: unknown): value is TtsEngine {
  return value === 'local' || value === 'kokoro' || value === 'browser'
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Number(value)

  if (!Number.isFinite(numeric)) return fallback

  return Math.max(min, Math.min(numeric, max))
}

function normalizeReaderSettings(settings: Partial<ReaderSettings>): ReaderSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    rate: clampNumber(settings.rate, DEFAULT_SETTINGS.rate, 0.6, 1.8),
    pitch: clampNumber(settings.pitch, DEFAULT_SETTINGS.pitch, 0.5, 1.6),
    volume: clampNumber(settings.volume, DEFAULT_SETTINGS.volume, 0, 1),
    voiceURI: typeof settings.voiceURI === 'string' ? settings.voiceURI : DEFAULT_SETTINGS.voiceURI,
    ttsEngine: isTtsEngine(settings.ttsEngine) ? settings.ttsEngine : DEFAULT_SETTINGS.ttsEngine,
    kokoroVoiceId: isKokoroVoiceId(settings.kokoroVoiceId)
      ? settings.kokoroVoiceId
      : DEFAULT_SETTINGS.kokoroVoiceId,
    profile: isVoiceProfileId(settings.profile) ? settings.profile : DEFAULT_SETTINGS.profile,
    focusMode:
      typeof settings.focusMode === 'boolean' ? settings.focusMode : DEFAULT_SETTINGS.focusMode,
    theme: isReaderTheme(settings.theme) ? settings.theme : DEFAULT_SETTINGS.theme,
    textScale: clampNumber(settings.textScale, DEFAULT_SETTINGS.textScale, 0.85, 1.35),
    lineHeight: clampNumber(settings.lineHeight, DEFAULT_SETTINGS.lineHeight, 1.45, 2.15),
    fontFamily: isReaderFont(settings.fontFamily)
      ? settings.fontFamily
      : DEFAULT_SETTINGS.fontFamily,
  }
}

function remoteBookmarkToLocal(bookmark: RemoteBookmark): BookmarkEntry {
  return {
    id: `${bookmark.book_id}:${bookmark.id}`,
    label: bookmark.label,
    wordIndex: bookmark.word_index,
    createdAt: Date.parse(bookmark.created_at),
  }
}

function remoteSettingsToLocal(settings: RemoteSettings): Partial<ReaderSettings> {
  return {
    rate: Number(settings.rate ?? DEFAULT_SETTINGS.rate),
    pitch: Number(settings.pitch ?? DEFAULT_SETTINGS.pitch),
    volume: Number(settings.volume ?? DEFAULT_SETTINGS.volume),
    voiceURI: settings.voice_uri ?? '',
    profile: isVoiceProfileId(settings.profile) ? settings.profile : DEFAULT_SETTINGS.profile,
    focusMode: settings.focus_mode ?? DEFAULT_SETTINGS.focusMode,
  }
}

function splitWords(text: string): WordSpan[] {
  return Array.from(text.matchAll(/\S+/g), (match) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }))
}

function buildTokens(text: string, words: WordSpan[]): Token[] {
  const tokens: Token[] = []
  let cursor = 0

  words.forEach((word, wordIndex) => {
    if (word.start > cursor) {
      tokens.push({
        kind: 'space',
        value: text.slice(cursor, word.start),
        tokenIndex: tokens.length,
      })
    }

    tokens.push({ kind: 'word', value: word.text, wordIndex })
    cursor = word.end
  })

  if (cursor < text.length) {
    tokens.push({
      kind: 'space',
      value: text.slice(cursor),
      tokenIndex: tokens.length,
    })
  }

  return tokens
}

function findWordIndexFromChar(words: WordSpan[], charIndex: number) {
  if (words.length === 0) return 0

  let low = 0
  let high = words.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const word = words[middle]

    if (charIndex < word.start) {
      high = middle - 1
    } else if (charIndex >= word.end) {
      low = middle + 1
    } else {
      return middle
    }
  }

  return Math.min(low, words.length - 1)
}

function getChunk(
  text: string,
  startChar: number,
  chunkTarget = CHUNK_TARGET,
  chunkLimit = CHUNK_LIMIT,
) {
  const remaining = text.slice(startChar)

  if (remaining.length <= chunkLimit) return remaining

  const targetSlice = remaining.slice(0, chunkLimit)
  const punctuationWindow = targetSlice.slice(chunkTarget)
  const punctuationMatch = punctuationWindow.search(/[.!?]\s+/)

  if (punctuationMatch >= 0) {
    return targetSlice.slice(0, chunkTarget + punctuationMatch + 1)
  }

  const paragraphBreak = targetSlice.lastIndexOf('\n\n')

  if (paragraphBreak > chunkTarget * 0.55) {
    return targetSlice.slice(0, paragraphBreak)
  }

  const lastSpace = targetSlice.lastIndexOf(' ')

  return targetSlice.slice(0, lastSpace > 0 ? lastSpace : chunkLimit)
}

function estimateMinutesRemaining(wordCount: number, currentWord: number, rate: number) {
  const baseWordsPerMinute = 165
  const remainingWords = Math.max(wordCount - currentWord, 0)
  const adjustedWpm = Math.max(baseWordsPerMinute * rate, 80)

  return Math.ceil(remainingWords / adjustedWpm)
}

function formatMinutes(minutes: number) {
  if (minutes <= 1) return '1 min'
  if (minutes < 60) return `${minutes} min`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

function isProbablyMathText(text: string) {
  const trimmed = text.trim()

  if (!trimmed) return false
  if (MATH_TEXT_PATTERN.test(trimmed)) return true

  const symbolCount = (trimmed.match(/[()[\]{}+\-*/=<>^_|]/g) ?? []).length
  const digitCount = (trimmed.match(/\d/g) ?? []).length

  return trimmed.length <= 16 && symbolCount + digitCount >= Math.max(3, trimmed.length * 0.55)
}

function getEpubPath(basePath: string, href: string) {
  const baseUrl = `https://reader.local/${basePath ? `${basePath}/` : ''}`
  const resolved = new URL(href, baseUrl)

  return decodeURIComponent(resolved.pathname.replace(/^\//, ''))
}

function textFromHtml(html: string) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll('script, style, nav, noscript').forEach((node) => node.remove())

  return normalizeText(document.body?.innerText ?? document.documentElement.textContent ?? '')
}

async function extractTxt(file: File): Promise<ExtractedBook> {
  debugLog('TXT import: reading file text', { name: file.name, size: file.size })
  const text = normalizeText(await file.text())
  debugLog('TXT import: complete', { characters: text.length })

  return {
    title: titleFromFileName(file.name),
    sourceType: 'txt',
    text,
  }
}

async function extractPdf(file: File, onProgress?: ImportProgress): Promise<ExtractedBook> {
  onProgress?.('Opening PDF')
  debugLog('PDF import: start', {
    name: file.name,
    size: file.size,
    type: file.type || 'unknown',
  })
  const buffer = await file.arrayBuffer()
  debugLog('PDF import: arrayBuffer loaded', { bytes: buffer.byteLength })
  const pdfjsLib = await loadPdfjs()
  const data = new Uint8Array(buffer.slice(0))
  const loadingTask = pdfjsLib.getDocument({ data })

  loadingTask.onProgress = (progress: PdfLoadingProgress) => {
    debugLog('PDF import: PDF.js loading progress', {
      loaded: progress.loaded,
      total: progress.total,
      percent: progress.total ? Math.round((progress.loaded / progress.total) * 100) : null,
    })
  }

  const pdf = await loadingTask.promise
  debugLog('PDF import: document opened', { pages: pdf.numPages })
  const pages: PdfPageInfo[] = []
  const regions: PdfTextRegion[] = []
  let text = ''
  let wordIndex = 0

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    onProgress?.(`Reading PDF page ${pageNumber} of ${pdf.numPages}`)
    debugLog('PDF import: page start', { pageNumber, totalPages: pdf.numPages })
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const startingWordIndex = wordIndex

    pages.push({
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      hasImages: false,
    })

    if (text) {
      text += '\n\n'
    }

    content.items.forEach((item) => {
      if (!('str' in item) || !item.str.trim()) return

      if (text && !/\s$/.test(text)) {
        text += ' '
      }

      const itemText = item.str.trim()
      const transform = pdfjsLib.Util.transform(viewport.transform, item.transform)
      const itemLeft = transform[4]
      const itemTop = transform[5] - item.height
      const itemWidth = Math.max(item.width, itemText.length * 2)
      const itemHeight = Math.max(item.height, 8)
      const mathItem = isProbablyMathText(itemText)

      Array.from(itemText.matchAll(/\S+/g)).forEach((match) => {
        const localStart = match.index ?? 0
        const localEnd = localStart + match[0].length
        const left = itemLeft + (itemWidth * localStart) / Math.max(itemText.length, 1)
        const width = Math.max(
          (itemWidth * (localEnd - localStart)) / Math.max(itemText.length, 1),
          itemHeight * 0.4,
        )

        regions.push({
          wordIndex,
          pageNumber,
          left,
          top: Math.max(itemTop, 0),
          width,
          height: itemHeight,
          isMath: mathItem || isProbablyMathText(match[0]),
        })

        wordIndex += 1
      })

      text += itemText
      if ('hasEOL' in item && item.hasEOL) {
        text += '\n'
      }
    })

    debugLog('PDF import: page complete', {
      pageNumber,
      textItems: content.items.length,
      wordsAdded: wordIndex - startingWordIndex,
      totalWords: wordIndex,
    })

    if (pageNumber % PDF_IMPORT_YIELD_EVERY_PAGES === 0) {
      debugLog('PDF import: yielding to browser', { pageNumber })
      await yieldToBrowser()
    }
  }

  const normalizedText = normalizeText(text)
  const mathRegionCount = regions.filter((region) => region.isMath).length
  debugLog('PDF import: extraction complete', {
    pages: pages.length,
    regions: regions.length,
    mathRegionCount,
    characters: normalizedText.length,
    hasSelectableText: !!normalizedText,
  })

  try {
    await pdf.destroy()
  } catch {
    // PDF.js may have already released the document after extraction.
  }

  return {
    title: titleFromFileName(file.name),
    sourceType: 'pdf',
    text:
      normalizedText ||
      'This PDF has no selectable text. The pages are preserved visually, but narration needs OCR.',
    pdfDataUrl: URL.createObjectURL(new Blob([buffer], { type: file.type || 'application/pdf' })),
    pdfPages: pages,
    pdfRegions: regions,
    mathRegionCount,
  }
}

function PdfPageView({
  activeRegions,
  forceInitialRender,
  onImageDetected,
  onStartFromWord,
  pageInfo,
  pdfDocument,
  registerActiveRegion,
}: {
  activeRegions: PdfTextRegion[]
  forceInitialRender: boolean
  onImageDetected: (pageNumber: number) => void
  onStartFromWord: (wordIndex: number) => void
  pageInfo: PdfPageInfo
  pdfDocument: PdfDocumentProxy
  registerActiveRegion: (node: HTMLButtonElement | null) => void
}) {
  const pageRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void; promise: Promise<unknown> } | null>(null)
  const renderInFlightRef = useRef(false)
  const shouldForceRender = activeRegions.length > 0 || forceInitialRender
  const [isNearViewport, setIsNearViewport] = useState(forceInitialRender)
  const [isRendered, setIsRendered] = useState(false)

  useEffect(() => {
    const pageNode = pageRef.current

    if (!pageNode) return
    const scrollRoot = pageNode.closest('.reader-page')

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsNearViewport(entry.isIntersecting)
      },
      {
        root: scrollRoot instanceof Element ? scrollRoot : null,
        rootMargin: '900px 0px',
        threshold: 0.01,
      },
    )

    observer.observe(pageNode)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    const shouldRender = isNearViewport || shouldForceRender

    if (!shouldRender) {
      const canvas = canvasRef.current

      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }

      window.setTimeout(() => setIsRendered(false), 0)
      return
    }

    async function renderPage() {
      while (renderInFlightRef.current) {
        await yieldToBrowser()
        if (cancelled) return
      }

      const canvas = canvasRef.current

      if (!canvas || cancelled) return

      renderInFlightRef.current = true

      setIsRendered(false)
      debugLog('PDF render: page start', { pageNumber: pageInfo.pageNumber })
      try {
        const pdfjsLib = await loadPdfjs()
        const page = await pdfDocument.getPage(pageInfo.pageNumber)
        if (cancelled) return

        const outputScale = Math.min(window.devicePixelRatio || 1, 2)
        const viewport = page.getViewport({ scale: outputScale })
        const context = canvas.getContext('2d')

        if (!context || cancelled) return

        canvas.width = viewport.width
        canvas.height = viewport.height
        canvas.style.aspectRatio = `${pageInfo.width} / ${pageInfo.height}`

        const renderTask = page.render({ canvas, canvasContext: context, viewport })
        renderTaskRef.current = renderTask
        await renderTask.promise

        if (!cancelled) {
          setIsRendered(true)
          debugLog('PDF render: page complete', {
            pageNumber: pageInfo.pageNumber,
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
          })
        }

        // Run image detection asynchronously in the background so it does not block rendering visibility
        void page.getOperatorList().then((operatorList) => {
          if (cancelled) return

          const imageOps = new Set([
            pdfjsLib.OPS.paintImageXObject,
            pdfjsLib.OPS.paintInlineImageXObject,
            pdfjsLib.OPS.paintXObject,
          ])

          if (operatorList.fnArray.some((fn) => imageOps.has(fn))) {
            onImageDetected(pageInfo.pageNumber)
          }
        }).catch((err) => {
          debugError('PDF render: background image detection failed', err)
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'RenderingCancelledException') {
          debugLog('PDF render: page cancelled', { pageNumber: pageInfo.pageNumber })
          return
        }

        throw error
      } finally {
        renderTaskRef.current = null
        renderInFlightRef.current = false
      }
    }

    void renderPage().catch((error: unknown) => {
      debugError('PDF render: page failed', error)
    })

    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
    }
  }, [
    isNearViewport,
    onImageDetected,
    pageInfo.height,
    pageInfo.pageNumber,
    pageInfo.width,
    pdfDocument,
    forceInitialRender,
    shouldForceRender,
  ])

  return (
    <section
      ref={pageRef}
      className="pdf-page-container"
      data-page-number={pageInfo.pageNumber}
      aria-label={`PDF page ${pageInfo.pageNumber}`}
    >
      <div 
        className={isRendered ? 'pdf-page is-rendered' : 'pdf-page'}
        style={{ aspectRatio: `${pageInfo.width} / ${pageInfo.height}` }}
      >
        <canvas ref={canvasRef} aria-hidden="true" />
        <div className="pdf-page-number">Page {pageInfo.pageNumber}</div>
        {activeRegions.map((region, index) => (
          <button
            type="button"
            key={`${region.wordIndex}-${index}`}
            ref={index === 0 ? registerActiveRegion : undefined}
            className={[
              'pdf-region',
              'is-active',
              region.isMath ? 'is-math' : '',
              region.isVisual ? 'is-visual' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{
              left: `${(region.left / pageInfo.width) * 100}%`,
              top: `${(region.top / pageInfo.height) * 100}%`,
              width: `${(region.width / pageInfo.width) * 100}%`,
              height: `${(region.height / pageInfo.height) * 100}%`,
            }}
            onClick={() => onStartFromWord(region.wordIndex)}
            aria-label={
              region.isVisual
                ? 'Visual page pause region'
                : region.isMath
                  ? 'Equation pause region'
                  : 'Current read region'
            }
          />
        ))}
      </div>
    </section>
  )
}

async function extractEpub(file: File): Promise<ExtractedBook> {
  debugLog('EPUB import: start', { name: file.name, size: file.size, type: file.type || 'unknown' })
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const containerXml = await zip.file('META-INF/container.xml')?.async('text')

  if (!containerXml) {
    throw new Error('This EPUB is missing its container file.')
  }

  const parser = new DOMParser()
  const containerDoc = parser.parseFromString(containerXml, 'application/xml')
  const opfPath = containerDoc.querySelector('rootfile')?.getAttribute('full-path')

  if (!opfPath) {
    throw new Error('This EPUB does not point to a package file.')
  }

  const opfXml = await zip.file(opfPath)?.async('text')

  if (!opfXml) {
    throw new Error('This EPUB package file could not be read.')
  }

  const opfDoc = parser.parseFromString(opfXml, 'application/xml')
  const basePath = opfPath.split('/').slice(0, -1).join('/')
  const manifest = new Map<string, string>()

  opfDoc.querySelectorAll('manifest item').forEach((item) => {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')

    if (id && href) {
      manifest.set(id, getEpubPath(basePath, href))
    }
  })

  const title =
    opfDoc.querySelector('metadata title')?.textContent?.trim() || titleFromFileName(file.name)

  const itemRefs = Array.from(opfDoc.querySelectorAll('spine itemref'))
    .map((item) => item.getAttribute('idref') ?? '')
    .filter(Boolean)

  const chapters: string[] = []

  for (const idRef of itemRefs) {
    const path = manifest.get(idRef)
    const entry = path ? zip.file(path) : null

    if (!entry) continue

    const html = await entry.async('text')
    const chapterText = textFromHtml(html)

    if (chapterText) {
      chapters.push(chapterText)
    }
  }

  if (chapters.length === 0) {
    throw new Error('No readable chapters were found in this EPUB.')
  }

  debugLog('EPUB import: complete', {
    chapters: chapters.length,
    characters: chapters.join('\n\n').length,
  })

  return {
    title,
    sourceType: 'epub',
    text: normalizeText(chapters.join('\n\n')),
  }
}

async function extractBook(file: File, onProgress?: ImportProgress): Promise<ExtractedBook> {
  const sourceType = sourceTypeFromFile(file)
  debugLog('Import: detected source type', {
    name: file.name,
    size: file.size,
    type: file.type || 'unknown',
    sourceType,
  })

  if (!sourceType) {
    throw new Error('Please upload a .txt, .epub, or .pdf file.')
  }

  if (sourceType === 'txt') return extractTxt(file)
  if (sourceType === 'pdf') return extractPdf(file, onProgress)

  return extractEpub(file)
}

function App() {
  const [book, setBook] = useState<ReaderBook>(() =>
    readStorage<ReaderBook>(STORAGE_KEYS.book, DEFAULT_BOOK),
  )
  const [settings, setSettings] = useState<ReaderSettings>(() =>
    normalizeReaderSettings(readStorage<Partial<ReaderSettings>>(STORAGE_KEYS.settings, {})),
  )
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>(() =>
    readStorage<BookmarkEntry[]>(STORAGE_KEYS.bookmarks, []),
  )
  const [currentWordIndex, setCurrentWordIndex] = useState(() =>
    readStorage<Record<string, number>>(STORAGE_KEYS.progress, {})[
      readStorage<ReaderBook>(STORAGE_KEYS.book, DEFAULT_BOOK).id
    ] ?? 0,
  )
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const [status, setStatus] = useState('Ready')
  const [query, setQuery] = useState('')
  const [pdfDocument, setPdfDocument] = useState<PdfDocumentProxy | null>(null)
  const [pdfRenderStatus, setPdfRenderStatus] = useState('')
  const [visualPausePage, setVisualPausePage] = useState<number | null>(null)
  const [focusControlsVisible, setFocusControlsVisible] = useState(true)
  const [pdfZoom, setPdfZoom] = useState(1)
  const [pdfPageInput, setPdfPageInput] = useState('')
  const [cloudUser, setCloudUser] = useState<BackendUser | null>(null)
  const [cloudEmail, setCloudEmail] = useState('')
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>(
    isSupabaseConfigured ? 'signed-out' : 'disabled',
  )
  const [cloudMessage, setCloudMessage] = useState(
    isSupabaseConfigured ? 'Sign in to sync across devices' : 'Supabase env vars are not configured',
  )
  const [remoteBooks, setRemoteBooks] = useState<RemoteBook[]>([])
  const { pause: pauseTts, preload: preloadTts, resume: resumeTts, speak: speakTts, stop: stopTts } =
    useTts()
  const readerRef = useRef<HTMLDivElement | null>(null)
  const activeWordRef = useRef<HTMLSpanElement | null>(null)
  const activePdfRegionRef = useRef<HTMLButtonElement | null>(null)
  const speakFromWordRef = useRef<(wordIndex: number) => void>(() => undefined)
  const pausedImagePagesRef = useRef<Set<number>>(new Set())
  const focusHideTimerRef = useRef<number | null>(null)
  const resumeIndexRef = useRef(0)
  const isStoppingRef = useRef(false)
  const importRunRef = useRef(0)

  const supabase = useMemo(() => getSupabaseClient(), [])
  const words = useMemo(() => splitWords(book.text), [book.text])
  const tokens = useMemo(
    () => (book.sourceType === 'pdf' ? [] : buildTokens(book.text, words)),
    [book.sourceType, book.text, words],
  )
  const progress = words.length > 0 ? Math.min((currentWordIndex / words.length) * 100, 100) : 0
  const currentWord = words[currentWordIndex]?.text ?? ''
  const minutesRemaining = estimateMinutesRemaining(words.length, currentWordIndex, settings.rate)
  const selectedVoice = voices.find((voice) => voice.voiceURI === settings.voiceURI) ?? voices[0]
  const selectedKokoroVoice =
    KOKORO_VOICES.find((voice) => voice.id === settings.kokoroVoiceId) ?? KOKORO_VOICES[0]
  const selectedVoiceValue =
    settings.ttsEngine === 'local'
      ? `local:${settings.kokoroVoiceId}`
      : settings.ttsEngine === 'kokoro'
      ? `kokoro:${settings.kokoroVoiceId}`
      : `browser:${settings.voiceURI}`
  const selectedVoiceLabel =
    settings.ttsEngine === 'local'
      ? `${selectedKokoroVoice.label} local (${selectedKokoroVoice.locale})`
      : settings.ttsEngine === 'kokoro'
      ? `${selectedKokoroVoice.label} (${selectedKokoroVoice.locale})`
      : (selectedVoice?.name ?? 'Default voice')
  const filteredBookmarks = bookmarks.filter((bookmark) => bookmark.id.startsWith(`${book.id}:`))
  const pdfPageCount = book.pdfPages?.length ?? 0
  const pdfRegionsByWord = useMemo(
    () => new Map((book.pdfRegions ?? []).map((region) => [region.wordIndex, region])),
    [book.pdfRegions],
  )
  const activePdfRegions = useMemo(() => {
    if (visualPausePage) {
      const pageInfo = book.pdfPages?.find((page) => page.pageNumber === visualPausePage)

      if (pageInfo) {
        return [
          {
            wordIndex: currentWordIndex,
            pageNumber: pageInfo.pageNumber,
            left: pageInfo.width * 0.06,
            top: pageInfo.height * 0.06,
            width: pageInfo.width * 0.88,
            height: pageInfo.height * 0.88,
            isMath: false,
            isVisual: true,
          },
        ]
      }
    }

    const region = pdfRegionsByWord.get(currentWordIndex)

    if (!region) return []

    if (!region.isMath) return [region]

    const regions = [region]

    for (let cursor = currentWordIndex + 1; cursor < words.length; cursor += 1) {
      const nextRegion = pdfRegionsByWord.get(cursor)

      if (!nextRegion?.isMath || nextRegion.pageNumber !== region.pageNumber) break
      regions.push(nextRegion)
    }

    return regions
  }, [book.pdfPages, currentWordIndex, pdfRegionsByWord, visualPausePage, words.length])
  const isPdfVisualReader = book.sourceType === 'pdf' && !!pdfDocument && pdfPageCount > 0
  const searchMatchIndex = useMemo(() => {
    if (!query.trim()) return -1

    return book.text.toLowerCase().indexOf(query.toLowerCase())
  }, [book.text, query])

  const isPdfMathWord = useCallback(
    (wordIndex: number) => book.sourceType === 'pdf' && !!pdfRegionsByWord.get(wordIndex)?.isMath,
    [book.sourceType, pdfRegionsByWord],
  )

  const findNextNarratablePdfWord = useCallback(
    (startIndex: number) => {
      for (let cursor = startIndex; cursor < words.length; cursor += 1) {
        if (!isPdfMathWord(cursor)) return cursor
      }

      return words.length
    },
    [isPdfMathWord, words.length],
  )

  const buildPdfSpeechChunk = useCallback(
    (startWordIndex: number, wordLimit = PDF_CHUNK_WORD_LIMIT) => {
      const parts: string[] = []
      const boundaryMap: Array<{ charStart: number; wordIndex: number }> = []
      let charCursor = 0
      let cursor = startWordIndex

      while (
        cursor < words.length &&
        !isPdfMathWord(cursor) &&
        parts.length < wordLimit
      ) {
        const word = words[cursor].text
        const prefix = parts.length === 0 ? '' : ' '

        boundaryMap.push({
          charStart: charCursor + prefix.length,
          wordIndex: cursor,
        })
        parts.push(word)
        charCursor += prefix.length + word.length
        cursor += 1

        if (/[.!?]$/.test(word) && parts.length > 28) break
      }

      return {
        boundaryMap,
        nextWordIndex: cursor,
        text: parts.join(' '),
      }
    },
    [isPdfMathWord, words],
  )

  const buildTextSpeechBoundaryMap = useCallback(
    (startWordIndex: number, startChar: number, chunkLength: number): SpeechBoundary[] => {
      const boundaryMap: SpeechBoundary[] = []
      const chunkEnd = startChar + chunkLength

      for (let cursor = startWordIndex; cursor < words.length; cursor += 1) {
        const word = words[cursor]

        if (!word || word.start >= chunkEnd) break
        if (word.end <= startChar) continue

        boundaryMap.push({
          charStart: Math.max(0, word.start - startChar),
          wordIndex: cursor,
        })
      }

      return boundaryMap
    },
    [words],
  )

  const markPdfPageHasImages = useCallback((pageNumber: number) => {
    setBook((current) => {
      if (current.sourceType !== 'pdf' || !current.pdfPages?.length) return current

      const page = current.pdfPages.find((candidate) => candidate.pageNumber === pageNumber)

      if (!page || page.hasImages) return current

      return {
        ...current,
        pdfPages: current.pdfPages.map((candidate) =>
          candidate.pageNumber === pageNumber ? { ...candidate, hasImages: true } : candidate,
        ),
      }
    })
  }, [])

  const revealFocusControls = useCallback(() => {
    if (!settings.focusMode) return

    setFocusControlsVisible(true)

    if (focusHideTimerRef.current) {
      window.clearTimeout(focusHideTimerRef.current)
    }

    focusHideTimerRef.current = window.setTimeout(() => {
      setFocusControlsVisible(false)
    }, 3200)
  }, [settings.focusMode])

  const jumpToWord = useCallback((wordIndex: number) => {
    const safeWordIndex = Math.max(0, Math.min(wordIndex, Math.max(words.length - 1, 0)))
    setCurrentWordIndex(safeWordIndex)
    setIsPaused(false)
    setStatus('Position updated')

    requestAnimationFrame(() => {
      const activeNode = activeWordRef.current ?? activePdfRegionRef.current
      activeNode?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [words.length])

  const persistProgress = useCallback(
    (wordIndex: number) => {
      const progressByBook = readStorage<Record<string, number>>(STORAGE_KEYS.progress, {})
      progressByBook[book.id] = wordIndex
      writeStorage(STORAGE_KEYS.progress, progressByBook)
    },
    [book.id],
  )

  const speakFromWord = useCallback(
    (wordIndex: number) => {
      if (typeof window === 'undefined' || words.length === 0) {
        return
      }

      if (settings.ttsEngine === 'browser' && !('speechSynthesis' in window)) {
        setStatus('Speech synthesis is not available in this browser')
        return
      }

      isStoppingRef.current = false
      stopTts()

      const safeWordIndex = Math.max(0, Math.min(wordIndex, words.length - 1))

      if (book.sourceType === 'pdf' && book.pdfRegions?.length) {
        const currentRegion = pdfRegionsByWord.get(safeWordIndex)
        const currentPage = currentRegion
          ? book.pdfPages?.find((page) => page.pageNumber === currentRegion.pageNumber)
          : undefined

        if (
          currentPage?.hasImages &&
          !pausedImagePagesRef.current.has(currentPage.pageNumber)
        ) {
          pausedImagePagesRef.current.add(currentPage.pageNumber)
          resumeIndexRef.current = safeWordIndex
          setVisualPausePage(currentPage.pageNumber)
          setCurrentWordIndex(safeWordIndex)
          setIsSpeaking(true)
          setIsPaused(false)
          setStatus('Visual pause')

          window.setTimeout(() => {
            setVisualPausePage(null)
            if (isStoppingRef.current) return
            speakFromWordRef.current(safeWordIndex)
          }, PDF_EQUATION_PAUSE_MS)

          return
        }

        setVisualPausePage(null)

        if (isPdfMathWord(safeWordIndex)) {
          const nextWordIndex = findNextNarratablePdfWord(safeWordIndex + 1)

          resumeIndexRef.current = safeWordIndex
          setCurrentWordIndex(safeWordIndex)
          setIsSpeaking(true)
          setIsPaused(false)
          setStatus('Equation pause')

          window.setTimeout(() => {
            if (isStoppingRef.current) return

            if (nextWordIndex < words.length) {
              speakFromWordRef.current(nextWordIndex)
            } else {
              setIsSpeaking(false)
              setIsPaused(false)
              setStatus('Finished')
            }
          }, PDF_EQUATION_PAUSE_MS)

          return
        }

        const chunk = buildPdfSpeechChunk(
          safeWordIndex,
          settings.ttsEngine === 'local'
            ? LOCAL_TTS_PDF_CHUNK_WORD_LIMIT
            : settings.ttsEngine === 'kokoro'
              ? KOKORO_PDF_CHUNK_WORD_LIMIT
              : PDF_CHUNK_WORD_LIMIT,
        )

        if (!chunk.text.trim()) {
          const nextWordIndex = findNextNarratablePdfWord(safeWordIndex + 1)

          if (nextWordIndex < words.length) {
            speakFromWordRef.current(nextWordIndex)
          } else {
            setIsSpeaking(false)
            setStatus('Finished')
          }

          return
        }

        resumeIndexRef.current = safeWordIndex
        setCurrentWordIndex(safeWordIndex)
        setIsSpeaking(true)
        setIsPaused(false)
        speakTts({
          text: chunk.text,
          engine: settings.ttsEngine,
          rate: settings.rate,
          pitch: settings.pitch,
          volume: settings.volume,
          kokoroVoiceId: settings.kokoroVoiceId,
          browserVoice: selectedVoice,
          boundaryMap: chunk.boundaryMap,
          browserStatus: 'Reading PDF text',
          onBoundary: (activeWordIndex) => {
            resumeIndexRef.current = activeWordIndex
            setCurrentWordIndex(activeWordIndex)
          },
          onEnd: () => {
            if (isStoppingRef.current) return

            if (chunk.nextWordIndex < words.length) {
              speakFromWordRef.current(chunk.nextWordIndex)
            } else {
              setCurrentWordIndex(words.length - 1)
              setIsSpeaking(false)
              setIsPaused(false)
              setStatus('Finished')
            }
          },
          onError: () => {
            if (isStoppingRef.current) return
            setIsSpeaking(false)
            setIsPaused(false)
            setStatus('Voice playback stopped')
          },
          onStatus: setStatus,
        })

        if (settings.ttsEngine !== 'browser' && chunk.nextWordIndex < words.length) {
          const nextChunk = buildPdfSpeechChunk(
            chunk.nextWordIndex,
            settings.ttsEngine === 'local'
              ? LOCAL_TTS_PDF_CHUNK_WORD_LIMIT
              : KOKORO_PDF_CHUNK_WORD_LIMIT,
          )

          if (nextChunk.text.trim()) {
            preloadTts({
              text: nextChunk.text,
              engine: settings.ttsEngine,
              rate: settings.rate,
              kokoroVoiceId: settings.kokoroVoiceId,
            })
          }
        }

        return
      }

      const startChar = words[safeWordIndex]?.start ?? 0
      const chunk =
        settings.ttsEngine === 'local'
          ? getChunk(book.text, startChar, LOCAL_TTS_CHUNK_TARGET, LOCAL_TTS_CHUNK_LIMIT)
          : settings.ttsEngine === 'kokoro'
            ? getChunk(book.text, startChar, KOKORO_CHUNK_TARGET, KOKORO_CHUNK_LIMIT)
          : getChunk(book.text, startChar)

      if (!chunk.trim()) {
        setIsSpeaking(false)
        setStatus('Finished')
        return
      }

      const boundaryMap = buildTextSpeechBoundaryMap(safeWordIndex, startChar, chunk.length)

      resumeIndexRef.current = safeWordIndex
      setCurrentWordIndex(safeWordIndex)
      setIsSpeaking(true)
      setIsPaused(false)
      speakTts({
        text: chunk,
        engine: settings.ttsEngine,
        rate: settings.rate,
        pitch: settings.pitch,
        volume: settings.volume,
        kokoroVoiceId: settings.kokoroVoiceId,
        browserVoice: selectedVoice,
        boundaryMap,
        browserStatus: 'Reading',
        onBoundary: (nextWordIndex) => {
          resumeIndexRef.current = nextWordIndex
          setCurrentWordIndex(nextWordIndex)
        },
        onEnd: () => {
          if (isStoppingRef.current) return

          const nextChar = startChar + chunk.length
          const nextWordIndex = findWordIndexFromChar(words, nextChar + 1)

          if (nextWordIndex < words.length - 1 && nextChar < book.text.length - 1) {
            speakFromWordRef.current(nextWordIndex)
          } else {
            setCurrentWordIndex(words.length - 1)
            setIsSpeaking(false)
            setIsPaused(false)
            setStatus('Finished')
          }
        },
        onError: () => {
          if (isStoppingRef.current) return
          setIsSpeaking(false)
          setIsPaused(false)
          setStatus('Voice playback stopped')
        },
        onStatus: setStatus,
      })

      if (settings.ttsEngine !== 'browser') {
        const nextChar = startChar + chunk.length
        const nextWordIndex = findWordIndexFromChar(words, nextChar + 1)

        if (nextWordIndex < words.length - 1 && nextChar < book.text.length - 1) {
          const nextStartChar = words[nextWordIndex]?.start ?? nextChar
          const nextChunk =
            settings.ttsEngine === 'local'
              ? getChunk(book.text, nextStartChar, LOCAL_TTS_CHUNK_TARGET, LOCAL_TTS_CHUNK_LIMIT)
              : getChunk(book.text, nextStartChar, KOKORO_CHUNK_TARGET, KOKORO_CHUNK_LIMIT)

          if (nextChunk.trim()) {
            preloadTts({
              text: nextChunk,
              engine: settings.ttsEngine,
              rate: settings.rate,
              kokoroVoiceId: settings.kokoroVoiceId,
            })
          }
        }
      }
    },
    [
      book.pdfPages,
      book.pdfRegions?.length,
      book.sourceType,
      book.text,
      buildPdfSpeechChunk,
      buildTextSpeechBoundaryMap,
      findNextNarratablePdfWord,
      isPdfMathWord,
      pdfRegionsByWord,
      preloadTts,
      selectedVoice,
      settings.kokoroVoiceId,
      settings.pitch,
      settings.rate,
      settings.ttsEngine,
      settings.volume,
      speakTts,
      stopTts,
      words,
    ],
  )

  useEffect(() => {
    speakFromWordRef.current = speakFromWord
  }, [speakFromWord])

  const loadRemoteBooks = useCallback(async () => {
    if (!supabase || !cloudUser) return

    setCloudStatus('syncing')
    setCloudMessage('Loading your cloud library')

    const { data, error } = await supabase
      .from('books')
      .select(
        'id,title,source_type,file_path,file_name,file_size,file_last_modified,created_at,last_opened_at',
      )
      .order('last_opened_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })

    if (error) {
      debugError('Cloud: failed to load books', error)
      setCloudStatus('error')
      setCloudMessage('Could not load cloud library')
      return
    }

    setRemoteBooks((data ?? []) as RemoteBook[])
    setCloudStatus('ready')
    setCloudMessage(data?.length ? 'Cloud sync is ready' : 'Cloud sync is ready for your first book')
  }, [cloudUser, supabase])

  const loadRemoteSettings = useCallback(async () => {
    if (!supabase || !cloudUser) return

    const { data, error } = await supabase
      .from('reader_settings')
      .select('rate,pitch,volume,voice_uri,profile,focus_mode')
      .eq('user_id', cloudUser.id)
      .maybeSingle()

    if (error) {
      debugError('Cloud: failed to load reader settings', error)
      return
    }

    if (data) {
      setSettings((current) => ({
        ...normalizeReaderSettings({
          ...current,
          ...remoteSettingsToLocal(data as RemoteSettings),
        }),
      }))
    }
  }, [cloudUser, supabase])

  useEffect(() => {
    if (!supabase) {
      return
    }

    let cancelled = false

    void supabase.auth.getSession().then(({ data, error }) => {
      if (cancelled) return

      if (error) {
        debugError('Cloud: auth lookup failed', error)
      }

      const user = data.session?.user ?? null

      setCloudUser(user)
      setCloudStatus(user ? 'ready' : 'signed-out')
      setCloudMessage(user ? 'Cloud sync is ready' : 'Sign in to sync across devices')
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return

      setCloudUser(session?.user ?? null)
      setCloudStatus(session?.user ? 'ready' : 'signed-out')
      setCloudMessage(session?.user ? 'Cloud sync is ready' : 'Sign in to sync across devices')
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [supabase])

  useEffect(() => {
    if (!supabase || !cloudUser) {
      return
    }

    const timeout = window.setTimeout(() => {
      void loadRemoteBooks()
      void loadRemoteSettings()
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [cloudUser, loadRemoteBooks, loadRemoteSettings, supabase])

  useEffect(() => {
    try {
      const persistedBook = getPersistableBook(book)
      writeStorage(STORAGE_KEYS.book, persistedBook)
      debugLog('Storage: persisted book shell', {
        id: book.id,
        sourceType: book.sourceType,
        originalCharacters: book.text.length,
        persistedCharacters: persistedBook.text.length,
        persistedRegions: persistedBook.pdfRegions?.length ?? 0,
      })
    } catch (error) {
      debugError('Storage: failed to persist book shell', error)

      try {
        window.localStorage.removeItem(STORAGE_KEYS.book)
      } catch (removeError) {
        debugError('Storage: failed to clear book key after quota error', removeError)
      }
    }
  }, [book])

  useEffect(() => {
    writeStorage(STORAGE_KEYS.settings, settings)

    if (!supabase || !cloudUser) return

    const timeout = window.setTimeout(() => {
      setCloudStatus('syncing')
      void supabase
        .from('reader_settings')
        .upsert({
          user_id: cloudUser.id,
          rate: settings.rate,
          pitch: settings.pitch,
          volume: settings.volume,
          voice_uri: settings.voiceURI || null,
          profile: settings.profile,
          focus_mode: settings.focusMode,
          updated_at: new Date().toISOString(),
        })
        .then(({ error }) => {
          if (error) {
            debugError('Cloud: failed to sync settings', error)
            setCloudStatus('error')
            setCloudMessage('Settings sync failed')
            return
          }

          setCloudStatus('ready')
          setCloudMessage('Settings synced')
        })
    }, 900)

    return () => window.clearTimeout(timeout)
  }, [cloudUser, settings, supabase])

  useEffect(() => {
    writeStorage(STORAGE_KEYS.bookmarks, bookmarks)
  }, [bookmarks])

  useEffect(() => {
    persistProgress(currentWordIndex)
  }, [currentWordIndex, persistProgress])

  useEffect(() => {
    if (!supabase || !cloudUser || !isRemoteBookId(book.id)) return

    const pageNumber = pdfRegionsByWord.get(currentWordIndex)?.pageNumber ?? null
    const timeout = window.setTimeout(() => {
      setCloudStatus('syncing')
      void supabase
        .from('reading_progress')
        .upsert({
          user_id: cloudUser.id,
          book_id: book.id,
          word_index: currentWordIndex,
          page_number: pageNumber,
          updated_at: new Date().toISOString(),
        })
        .then(({ error }) => {
          if (error) {
            debugError('Cloud: failed to sync progress', error)
            setCloudStatus('error')
            setCloudMessage('Progress sync failed')
            return
          }

          setCloudStatus('ready')
          setCloudMessage('Progress synced')
        })
    }, 1200)

    return () => window.clearTimeout(timeout)
  }, [book.id, cloudUser, currentWordIndex, pdfRegionsByWord, supabase])

  useEffect(() => {
    pausedImagePagesRef.current.clear()
  }, [book.id])

  useEffect(() => {
    if (!settings.focusMode) {
      if (focusHideTimerRef.current) {
        window.clearTimeout(focusHideTimerRef.current)
        focusHideTimerRef.current = null
      }

      window.setTimeout(() => setFocusControlsVisible(true), 0)
      return
    }

    window.setTimeout(revealFocusControls, 0)

    return () => {
      if (focusHideTimerRef.current) {
        window.clearTimeout(focusHideTimerRef.current)
        focusHideTimerRef.current = null
      }
    }
  }, [revealFocusControls, settings.focusMode])

  useEffect(() => {
    if (settings.ttsEngine !== 'local') return

    preloadTts({
      text: 'Ready.',
      engine: 'local',
      rate: settings.rate,
      kokoroVoiceId: settings.kokoroVoiceId,
    })
  }, [preloadTts, settings.kokoroVoiceId, settings.rate, settings.ttsEngine])

  useEffect(() => {
    const updateVoices = () => {
      const availableVoices = window.speechSynthesis?.getVoices() ?? []
      setVoices(availableVoices)

      if (!settings.voiceURI && availableVoices.length > 0) {
        const preferred =
          availableVoices.find((voice) => /samantha|natural|premium|enhanced/i.test(voice.name)) ??
          availableVoices.find((voice) => voice.lang.startsWith('en')) ??
          availableVoices[0]

        setSettings((current) => ({ ...current, voiceURI: preferred.voiceURI }))
      }
    }

    updateVoices()
    window.speechSynthesis?.addEventListener('voiceschanged', updateVoices)

    return () => {
      window.speechSynthesis?.removeEventListener('voiceschanged', updateVoices)
    }
  }, [settings.voiceURI])

  useEffect(() => {
    const activeNode = activeWordRef.current ?? activePdfRegionRef.current

    if (!activeNode || !isSpeaking) return

    activeNode.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentWordIndex, isSpeaking])

  useEffect(() => {
    let cancelled = false

    async function loadPdfDocument() {
      if (book.sourceType !== 'pdf' || !book.pdfDataUrl) {
        setPdfDocument(null)
        setPdfRenderStatus('')
        return
      }

      try {
        setPdfRenderStatus('Loading rendered PDF')
        debugLog('PDF view: loading rendered document', {
          title: book.title,
          pages: pdfPageCount,
          urlKind: book.pdfDataUrl.startsWith('blob:') ? 'blob' : 'data',
        })
        const pdfjsLib = await loadPdfjs()
        const loadingTask = pdfjsLib.getDocument({ data: await dataUrlToUint8Array(book.pdfDataUrl) })

        loadingTask.onProgress = (progress: PdfLoadingProgress) => {
          debugLog('PDF view: PDF.js loading progress', {
            loaded: progress.loaded,
            total: progress.total,
            percent: progress.total ? Math.round((progress.loaded / progress.total) * 100) : null,
          })
        }

        const pdf = await loadingTask.promise

        if (cancelled) {
          await pdf.destroy()
          return
        }

        setPdfDocument(pdf)
        setPdfRenderStatus('PDF layout preserved')
        debugLog('PDF view: document ready', { pages: pdf.numPages })
      } catch (error) {
        debugError('PDF view: document failed to load', error)
        if (!cancelled) {
          setPdfDocument(null)
          setPdfRenderStatus('Could not render the saved PDF view')
        }
      }
    }

    void loadPdfDocument()

    return () => {
      cancelled = true
    }
  }, [book.pdfDataUrl, book.sourceType, book.title, pdfPageCount])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
        return
      }

      if (event.key === 'Escape' && settings.focusMode) {
        event.preventDefault()
        setSettings((current) => ({ ...current, focusMode: false }))
      }

      if (event.code === 'Space') {
        event.preventDefault()
        if (isSpeaking && !isPaused) {
          pauseTts()
          setIsPaused(true)
          setStatus('Paused')
        } else if (isSpeaking && isPaused) {
          resumeTts()
          setIsPaused(false)
          setStatus('Reading')
        } else {
          speakFromWord(currentWordIndex)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentWordIndex, isPaused, isSpeaking, pauseTts, resumeTts, settings.focusMode, speakFromWord])

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      debugError('Window error', {
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        error: event.error,
      })
    }
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      debugError('Unhandled promise rejection', event.reason)
    }

    window.addEventListener('error', handleWindowError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)

    debugLog('App mounted', {
      userAgent: navigator.userAgent,
      pdfWorker: 'loaded on first PDF use',
    })

    return () => {
      isStoppingRef.current = true
      stopTts()
      window.removeEventListener('error', handleWindowError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [stopTts])

  async function saveImportedBookToCloud(file: File, extracted: ExtractedBook) {
    if (!supabase || !cloudUser) return null

    setCloudStatus('syncing')
    setCloudMessage('Uploading original book file')

    const filePath = `${cloudUser.id}/${crypto.randomUUID()}-${safeFileSegment(file.name)}`
    const { error: uploadError } = await supabase.storage
      .from(bookStorageBucket)
      .upload(filePath, file, {
        contentType: file.type || mimeTypeForSource(extracted.sourceType),
        upsert: false,
      })

    if (uploadError) {
      throw uploadError
    }

    const { data, error } = await supabase
      .from('books')
      .insert({
        user_id: cloudUser.id,
        title: extracted.title,
        source_type: extracted.sourceType,
        file_path: filePath,
        file_name: file.name,
        file_size: file.size,
        file_last_modified: file.lastModified,
        last_opened_at: new Date().toISOString(),
      })
      .select(
        'id,title,source_type,file_path,file_name,file_size,file_last_modified,created_at,last_opened_at',
      )
      .single()

    if (error) {
      await supabase.storage.from(bookStorageBucket).remove([filePath])
      throw error
    }

    setCloudStatus('ready')
    setCloudMessage('Book saved to cloud')
    return data as RemoteBook
  }

  async function handleCloudSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!supabase || !cloudEmail.trim()) return

    setCloudStatus('syncing')
    setCloudMessage('Sending sign-in link')

    const { error } = await supabase.auth.signInWithOtp({
      email: cloudEmail.trim(),
      options: {
        emailRedirectTo: window.location.origin,
      },
    })

    if (error) {
      debugError('Cloud: sign-in failed', error)
      setCloudStatus('error')
      setCloudMessage(error.message)
      return
    }

    setCloudStatus('signed-out')
    setCloudMessage('Check your email for the sign-in link')
  }

  async function handleCloudSignOut() {
    if (!supabase) return

    setCloudStatus('syncing')
    setCloudMessage('Signing out')

    const { error } = await supabase.auth.signOut()

    if (error) {
      debugError('Cloud: sign-out failed', error)
      setCloudStatus('error')
      setCloudMessage(error.message)
      return
    }

    setCloudUser(null)
    setRemoteBooks([])
    setCloudStatus('signed-out')
    setCloudMessage('Signed out of cloud sync')
  }

  async function openRemoteBook(remoteBook: RemoteBook) {
    if (!supabase || !cloudUser) return

    try {
      setStatus(`Opening ${remoteBook.title}`)
      setCloudStatus('syncing')
      setCloudMessage('Downloading book')
      handleStop()

      const { data: fileBlob, error: downloadError } = await supabase.storage
        .from(bookStorageBucket)
        .download(remoteBook.file_path)

      if (downloadError) throw downloadError
      if (!fileBlob) throw new Error('Cloud book file was empty.')

      const file = new File([fileBlob], remoteBook.file_name, {
        type: mimeTypeForSource(remoteBook.source_type),
        lastModified: remoteBook.file_last_modified ?? Date.now(),
      })
      const extracted = await extractBook(file, (message) => {
        setStatus(message)
        debugLog('Cloud: open progress', { bookId: remoteBook.id, message })
      })
      const { data: remoteProgress, error: progressError } = await supabase
        .from('reading_progress')
        .select('book_id,word_index,page_number')
        .eq('book_id', remoteBook.id)
        .maybeSingle()
      const { data: remoteBookmarks, error: bookmarksError } = await supabase
        .from('bookmarks')
        .select('id,book_id,label,word_index,created_at')
        .eq('book_id', remoteBook.id)
        .order('created_at', { ascending: false })

      if (progressError) {
        debugError('Cloud: failed to load progress for book', progressError)
      }

      if (bookmarksError) {
        debugError('Cloud: failed to load bookmarks for book', bookmarksError)
      }

      const progressRow = remoteProgress as RemoteProgress | null
      const localBookmarks = ((remoteBookmarks ?? []) as RemoteBookmark[]).map(remoteBookmarkToLocal)
      const remoteWordCount = splitWords(extracted.text).length
      const nextBook: ReaderBook = {
        ...extracted,
        id: remoteBook.id,
        title: remoteBook.title,
        importedAt: Date.parse(remoteBook.created_at),
      }

      setBook(nextBook)
      setCurrentWordIndex(
        Math.max(0, Math.min(progressRow?.word_index ?? 0, Math.max(remoteWordCount - 1, 0))),
      )
      setBookmarks((current) => [
        ...localBookmarks,
        ...current.filter((bookmark) => !bookmark.id.startsWith(`${remoteBook.id}:`)),
      ])
      setVisualPausePage(null)
      setIsSpeaking(false)
      setIsPaused(false)

      await supabase
        .from('books')
        .update({ last_opened_at: new Date().toISOString() })
        .eq('id', remoteBook.id)
      await loadRemoteBooks()

      setCloudStatus('ready')
      setCloudMessage('Cloud book opened')
      setStatus('Book opened from cloud')
    } catch (error) {
      debugError('Cloud: failed to open book', error)
      setCloudStatus('error')
      setCloudMessage('Could not open cloud book')
      setStatus(error instanceof Error ? error.message : 'Could not open cloud book')
    }
  }

  async function handleFile(file: File) {
    const importRun = importRunRef.current + 1
    importRunRef.current = importRun

    try {
      debugLog('Upload: file selected', {
        importRun,
        name: file.name,
        size: file.size,
        type: file.type || 'unknown',
        lastModified: file.lastModified,
      })
      setStatus('Importing book')
      setPdfRenderStatus('')
      await yieldToBrowser()

      const extracted = await extractBook(file, (message) => {
        if (importRunRef.current === importRun) {
          debugLog('Upload: progress', { importRun, message })
          setStatus(message)
        }
      })

      if (importRunRef.current !== importRun) {
        debugLog('Upload: stale import ignored', { importRun, activeImport: importRunRef.current })
        return
      }

      if (!extracted.text) {
        throw new Error('No readable text was found in this file.')
      }

      let remoteBook: RemoteBook | null = null

      if (supabase && cloudUser) {
        try {
          remoteBook = await saveImportedBookToCloud(file, extracted)
          await loadRemoteBooks()
        } catch (cloudError) {
          debugError('Cloud: failed to save imported book', cloudError)
          setCloudStatus('error')
          setCloudMessage('Book imported locally; cloud upload failed')
        }
      }

      const nextBook: ReaderBook = {
        ...extracted,
        id: remoteBook?.id ?? `${file.name}:${file.size}:${file.lastModified}`,
        importedAt: Date.now(),
      }

      isStoppingRef.current = true
      stopTts()
      setBook(nextBook)
      setCurrentWordIndex(0)
      setIsSpeaking(false)
      setIsPaused(false)
      setVisualPausePage(null)
      setStatus(
        remoteBook
          ? 'Book imported and synced'
          : nextBook.sourceType === 'pdf' && nextBook.pdfRegions?.length === 0
            ? 'PDF imported visually; no selectable text'
            : 'Book imported',
      )
      debugLog('Upload: book committed to state', {
        importRun,
        id: nextBook.id,
        sourceType: nextBook.sourceType,
        characters: nextBook.text.length,
        pages: nextBook.pdfPages?.length ?? null,
        regions: nextBook.pdfRegions?.length ?? null,
        mathRegionCount: nextBook.mathRegionCount ?? null,
      })
    } catch (error) {
      debugError('Upload: import failed', error)
      if (importRunRef.current === importRun) {
        setStatus(error instanceof Error ? error.message : 'Import failed')
      }
    } finally {
      if (importRunRef.current === importRun) {
        setIsDraggingFile(false)
      }
    }
  }

  function handlePlayPause() {
    if (isSpeaking && !isPaused) {
      pauseTts()
      setIsPaused(true)
      setStatus('Paused')
      return
    }

    if (isSpeaking && isPaused) {
      resumeTts()
      setIsPaused(false)
      setStatus('Reading')
      return
    }

    speakFromWord(currentWordIndex)
  }

  function handleStop() {
    isStoppingRef.current = true
    stopTts()
    setIsSpeaking(false)
    setIsPaused(false)
    setVisualPausePage(null)
    setStatus('Stopped')
  }

  function handleSkip(delta: number) {
    const nextIndex = Math.max(0, Math.min(currentWordIndex + delta, Math.max(words.length - 1, 0)))
    const wasReading = isSpeaking && !isPaused

    if (isSpeaking) {
      isStoppingRef.current = true
      stopTts()
      setIsSpeaking(false)
      setIsPaused(false)
    }

    jumpToWord(nextIndex)

    if (wasReading) {
      window.setTimeout(() => speakFromWord(nextIndex), 120)
    }
  }

  function applyProfile(profile: VoiceProfileId) {
    const preset = VOICE_PROFILES[profile]
    setSettings((current) => ({
      ...current,
      profile,
      rate: preset.rate,
      pitch: preset.pitch,
    }))
  }

  function startReadingAtWord(wordIndex: number) {
    const safeWordIndex = Math.max(0, Math.min(wordIndex, Math.max(words.length - 1, 0)))

    speakFromWord(safeWordIndex)
    requestAnimationFrame(() => {
      const activeNode = activeWordRef.current ?? activePdfRegionRef.current
      activeNode?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  function findPdfRegionAtPoint(pageNumber: number, pdfX: number, pdfY: number) {
    const pageRegions = book.pdfRegions?.filter((region) => region.pageNumber === pageNumber) ?? []
    let closestRegion: PdfTextRegion | null = null
    let minDistance = Infinity

    for (const region of pageRegions) {
      const horizontalPadding = Math.max(region.height * 0.7, 4)
      const verticalPadding = Math.max(region.height * 0.5, 3)
      const left = region.left - horizontalPadding
      const right = region.left + region.width + horizontalPadding
      const top = region.top - verticalPadding
      const bottom = region.top + region.height + verticalPadding
      const dx = pdfX < left ? left - pdfX : pdfX > right ? pdfX - right : 0
      const dy = pdfY < top ? top - pdfY : pdfY > bottom ? pdfY - bottom : 0
      const distance = Math.hypot(dx, dy)

      if (distance < minDistance) {
        minDistance = distance
        closestRegion = region
      }
    }

    return minDistance <= 2 ? closestRegion : null
  }

  function handlePdfClick(event: ReactMouseEvent) {
    const target = event.target as Element

    if (target.closest('.pdf-toolbar, button, input, select')) return

    const pageNode = target.closest('.pdf-page-container') as HTMLElement | null
    const pageSurface = target.closest('.pdf-page') as HTMLElement | null
    if (!pageNode || !pageSurface) return
    const pageNumber = Number(pageNode.dataset.pageNumber)
    if (!pageNumber) return
    const rect = pageSurface.getBoundingClientRect()
    const relativeX = event.clientX - rect.left
    const relativeY = event.clientY - rect.top

    const pageInfo = book.pdfPages?.find((p) => p.pageNumber === pageNumber)
    if (!pageInfo) return

    const pdfX = (relativeX / rect.width) * pageInfo.width
    const pdfY = (relativeY / rect.height) * pageInfo.height
    const closestRegion = findPdfRegionAtPoint(pageNumber, pdfX, pdfY)

    if (closestRegion) {
      startReadingAtWord(closestRegion.wordIndex)
    }
  }

  function getVisibleWordIndex() {
    if (isPdfVisualReader) {
      const pages = Array.from(document.querySelectorAll('.pdf-page-container'))
      let bestPageNumber = 1
      let minDistance = Infinity

      for (const page of pages) {
        const rect = page.getBoundingClientRect()
        const centerY = window.innerHeight / 2
        const pageCenter = rect.top + rect.height / 2
        const distance = Math.abs(pageCenter - centerY)

        if (distance < minDistance) {
          minDistance = distance
          bestPageNumber = Number((page as HTMLElement).dataset.pageNumber) || bestPageNumber
        }
      }

      const region = book.pdfRegions?.find((r) => r.pageNumber === bestPageNumber)
      return region ? region.wordIndex : currentWordIndex
    } else {
      const wordNodes = Array.from(document.querySelectorAll('.word'))
      let bestIndex = currentWordIndex
      let minDistance = Infinity

      for (const word of wordNodes) {
        const rect = word.getBoundingClientRect()
        const distance = Math.abs(rect.top - window.innerHeight / 2)

        if (distance < minDistance) {
          minDistance = distance
          const indexAttr = word.getAttribute('data-word-index')
          if (indexAttr) {
            bestIndex = Number(indexAttr)
          }
        }
      }

      return bestIndex
    }
  }

  function playFromCurrentView() {
    const targetWordIndex = getVisibleWordIndex()
    startReadingAtWord(targetWordIndex)
  }

  function handleJumpToPage() {
    const targetPage = Number(pdfPageInput)
    if (!targetPage || isNaN(targetPage)) return
    const safePage = Math.max(1, Math.min(targetPage, Math.max(pdfPageCount, 1)))
    const region = book.pdfRegions?.find((r) => r.pageNumber === safePage)
    const pageNode = document.querySelector(`[data-page-number="${safePage}"]`)

    pageNode?.scrollIntoView({ behavior: 'smooth', block: 'start' })

    if (region) {
      jumpToWord(region.wordIndex)
    }

    setPdfPageInput('')
  }

  function addBookmark() {
    const targetWordIndex = getVisibleWordIndex()
    const phrase = words
      .slice(targetWordIndex, targetWordIndex + 7)
      .map((word) => word.text)
      .join(' ')
    const bookmark: BookmarkEntry = {
      id: `${book.id}:${Date.now()}`,
      label: phrase || `Word ${targetWordIndex + 1}`,
      wordIndex: targetWordIndex,
      createdAt: Date.now(),
    }

    setBookmarks((current) => [bookmark, ...current])
    setStatus('Bookmark saved')

    if (supabase && cloudUser && isRemoteBookId(book.id)) {
      void supabase
        .from('bookmarks')
        .insert({
          user_id: cloudUser.id,
          book_id: book.id,
          word_index: bookmark.wordIndex,
          label: bookmark.label,
        })
        .select('id,book_id,label,word_index,created_at')
        .single()
        .then(({ data, error }) => {
          if (error) {
            debugError('Cloud: failed to sync bookmark', error)
            setCloudStatus('error')
            setCloudMessage('Bookmark saved locally; cloud sync failed')
            return
          }

          const remoteBookmark = data as RemoteBookmark | null
          if (remoteBookmark) {
            setBookmarks((current) =>
              current.map((candidate) =>
                candidate.id === bookmark.id ? remoteBookmarkToLocal(remoteBookmark) : candidate,
              ),
            )
          }

          setCloudStatus('ready')
          setCloudMessage('Bookmark synced')
        })
    }
  }

  function clearBook() {
    handleStop()
    setBook(DEFAULT_BOOK)
    setCurrentWordIndex(0)
    setVisualPausePage(null)
    setStatus('Loaded welcome text')
  }

  function goToSearchMatch() {
    if (searchMatchIndex < 0) return

    jumpToWord(findWordIndexFromChar(words, searchMatchIndex))
  }

  const appClassName = [
    'app',
    `theme-${settings.theme}`,
    settings.focusMode ? 'app-focus' : '',
    settings.focusMode && !focusControlsVisible ? 'focus-controls-hidden' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const textReaderStyle = {
    '--reader-text-scale': settings.textScale,
    '--reader-line-height': settings.lineHeight,
    '--reader-font-family':
      settings.fontFamily === 'serif'
        ? "Georgia, 'Times New Roman', serif"
        : "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  } as CSSProperties

  return (
    <main className={appClassName} onPointerDown={revealFocusControls} onPointerMove={revealFocusControls}>
      <aside className="side-panel">
        <div className="brand-lockup">
          <Headphones aria-hidden="true" />
          <div>
            <h1>Audio Reader</h1>
            <p>Private local narration</p>
          </div>
        </div>

        <label
          className={isDraggingFile ? 'drop-zone is-dragging' : 'drop-zone'}
          onDragOver={(event) => {
            event.preventDefault()
            setIsDraggingFile(true)
          }}
          onDragLeave={() => setIsDraggingFile(false)}
          onDrop={(event) => {
            event.preventDefault()
            const [file] = Array.from(event.dataTransfer.files)
            if (file) void handleFile(file)
          }}
        >
          <Upload aria-hidden="true" />
          <span>Upload .txt, .epub, or .pdf</span>
          <input
            type="file"
            accept=".txt,.epub,.pdf,text/plain,application/epub+zip,application/pdf"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleFile(file)
              event.currentTarget.value = ''
            }}
          />
        </label>

        <section className="control-group cloud-group" aria-labelledby="cloud-heading">
          <div className="section-title">
            <Cloud aria-hidden="true" />
            <h2 id="cloud-heading">Cloud sync</h2>
          </div>
          <p className={`cloud-status cloud-status-${cloudStatus}`}>{cloudMessage}</p>

          {cloudStatus === 'disabled' ? (
            <p className="cloud-help">Add Supabase env vars on Vercel to sync books and progress.</p>
          ) : cloudUser ? (
            <>
              <div className="cloud-account">
                <span>{cloudUser.email ?? 'Signed in'}</span>
                <button type="button" onClick={handleCloudSignOut} title="Sign out">
                  <LogOut aria-hidden="true" />
                </button>
              </div>
              <div className="cloud-actions">
                <button type="button" onClick={loadRemoteBooks} disabled={cloudStatus === 'syncing'}>
                  <RefreshCw aria-hidden="true" />
                  <span>Refresh</span>
                </button>
              </div>
              {remoteBooks.length === 0 ? (
                <p className="cloud-help">Uploaded books will appear here after sync.</p>
              ) : (
                <div className="cloud-book-list">
                  {remoteBooks.map((remoteBook) => (
                    <button
                      type="button"
                      key={remoteBook.id}
                      onClick={() => void openRemoteBook(remoteBook)}
                    >
                      <span>{remoteBook.title}</span>
                      <small>
                        {remoteBook.source_type.toUpperCase()}
                        {remoteBook.file_size
                          ? ` · ${(remoteBook.file_size / 1024 / 1024).toFixed(1)} MB`
                          : ''}
                      </small>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <form className="cloud-signin" onSubmit={handleCloudSignIn}>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={cloudEmail}
                  onChange={(event) => setCloudEmail(event.target.value)}
                />
              </label>
              <button type="submit" disabled={!cloudEmail.trim() || cloudStatus === 'syncing'}>
                <Mail aria-hidden="true" />
                <span>Send link</span>
              </button>
            </form>
          )}
        </section>

        <section className="control-group" aria-labelledby="playback-heading">
          <div className="section-title">
            <Volume2 aria-hidden="true" />
            <h2 id="playback-heading">Playback</h2>
          </div>

          <div className="transport">
            <button type="button" className="icon-button" onClick={() => handleSkip(-80)} title="Back">
              <SkipBack aria-hidden="true" />
            </button>
            <button type="button" className="play-button" onClick={handlePlayPause}>
              {isSpeaking && !isPaused ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              <span>{isSpeaking && !isPaused ? 'Pause' : 'Play'}</span>
            </button>
            <button type="button" className="icon-button" onClick={() => handleSkip(80)} title="Forward">
              <SkipForward aria-hidden="true" />
            </button>
            <button type="button" className="icon-button" onClick={handleStop} title="Stop">
              <Square aria-hidden="true" />
            </button>
          </div>

          <label className="field">
            <span>Voice</span>
            <select
              value={selectedVoiceValue}
              onChange={(event) => {
                const value = event.target.value

                if (value.startsWith('local:')) {
                  const voiceId = value.slice('local:'.length)

                  if (!isKokoroVoiceId(voiceId)) return

                  setSettings((current) => ({
                    ...current,
                    ttsEngine: 'local',
                    kokoroVoiceId: voiceId,
                  }))
                  return
                }

                if (value.startsWith('kokoro:')) {
                  const voiceId = value.slice('kokoro:'.length)

                  if (!isKokoroVoiceId(voiceId)) return

                  setSettings((current) => ({
                    ...current,
                    ttsEngine: 'kokoro',
                    kokoroVoiceId: voiceId,
                  }))
                  return
                }

                setSettings((current) => ({
                  ...current,
                  ttsEngine: 'browser',
                  voiceURI: value.startsWith('browser:') ? value.slice('browser:'.length) : '',
                }))
              }}
            >
              <optgroup label="Local server voices">
                {KOKORO_VOICES.map((voice) => (
                  <option value={`local:${voice.id}`} key={voice.id}>
                    {voice.label} ({voice.locale}) - {voice.description}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Browser AI voices">
                {KOKORO_VOICES.map((voice) => (
                  <option value={`kokoro:${voice.id}`} key={voice.id}>
                    {voice.label} ({voice.locale}) - {voice.description}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Browser voices">
                {voices.length === 0 ? (
                  <option value="browser:">Browser default voice</option>
                ) : (
                  voices.map((voice) => (
                    <option value={`browser:${voice.voiceURI}`} key={voice.voiceURI}>
                      {voice.name} ({voice.lang})
                    </option>
                  ))
                )}
              </optgroup>
            </select>
          </label>

          <label className="field">
            <span>Voice style</span>
            <select
              value={settings.profile}
              onChange={(event) => applyProfile(event.target.value as VoiceProfileId)}
            >
              {Object.entries(VOICE_PROFILES).map(([id, profile]) => (
                <option value={id} key={id}>
                  {profile.label} - {profile.description}
                </option>
              ))}
            </select>
          </label>

          <div className="slider-grid">
            <label>
              <span>Speed {settings.rate.toFixed(2)}x</span>
              <input
                type="range"
                min="0.6"
                max="1.8"
                step="0.05"
                value={settings.rate}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    rate: Number(event.target.value),
                    profile: 'balanced',
                  }))
                }
              />
            </label>
            <label>
              <span>Pitch {settings.pitch.toFixed(2)}</span>
              <input
                type="range"
                min="0.5"
                max="1.6"
                step="0.05"
                value={settings.pitch}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    pitch: Number(event.target.value),
                    profile: 'balanced',
                  }))
                }
              />
            </label>
            <label>
              <span>Volume {Math.round(settings.volume * 100)}%</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={settings.volume}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    volume: Number(event.target.value),
                  }))
                }
              />
            </label>
          </div>
        </section>

        <section className="control-group" aria-labelledby="appearance-heading">
          <div className="section-title">
            {settings.theme === 'dark' ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
            <h2 id="appearance-heading">Reading mode</h2>
          </div>

          <label className="field">
            <span>Theme</span>
            <select
              value={settings.theme}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  theme: event.target.value as ReaderTheme,
                }))
              }
            >
              {Object.entries(READER_THEMES).map(([theme, label]) => (
                <option value={theme} key={theme}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Font</span>
            <select
              value={settings.fontFamily}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  fontFamily: event.target.value as ReaderFont,
                }))
              }
            >
              {Object.entries(READER_FONTS).map(([font, label]) => (
                <option value={font} key={font}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <div className="slider-grid">
            <label>
              <span>Text size {Math.round(settings.textScale * 100)}%</span>
              <input
                type="range"
                min="0.85"
                max="1.35"
                step="0.05"
                value={settings.textScale}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    textScale: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              <span>Line spacing {settings.lineHeight.toFixed(2)}</span>
              <input
                type="range"
                min="1.45"
                max="2.15"
                step="0.05"
                value={settings.lineHeight}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    lineHeight: Number(event.target.value),
                  }))
                }
              />
            </label>
          </div>
        </section>

        <section className="control-group" aria-labelledby="tools-heading">
          <div className="section-title">
            <Gauge aria-hidden="true" />
            <h2 id="tools-heading">Tools</h2>
          </div>
          <button type="button" className="tool-button" onClick={addBookmark}>
            <Bookmark aria-hidden="true" />
            <span>Add bookmark</span>
          </button>
          <button type="button" className="tool-button" onClick={playFromCurrentView}>
            <Play aria-hidden="true" />
            <span>Play from view</span>
          </button>
          <button
            type="button"
            className={settings.theme === 'dark' ? 'tool-button is-active' : 'tool-button'}
            onClick={() =>
              setSettings((current) => ({
                ...current,
                theme: current.theme === 'dark' ? 'light' : 'dark',
              }))
            }
          >
            {settings.theme === 'dark' ? <Check aria-hidden="true" /> : <Moon aria-hidden="true" />}
            <span>Dark mode</span>
          </button>
          <button
            type="button"
            className={settings.focusMode ? 'tool-button is-active' : 'tool-button'}
            onClick={() =>
              setSettings((current) => ({ ...current, focusMode: !current.focusMode }))
            }
          >
            {settings.focusMode ? <Check aria-hidden="true" /> : <Moon aria-hidden="true" />}
            <span>Focus mode</span>
          </button>
          <button type="button" className="tool-button" onClick={clearBook}>
            <RotateCcw aria-hidden="true" />
            <span>Reset sample</span>
          </button>
        </section>
      </aside>

      <section className="reader-shell">
        <header className="reader-header">
          <div>
            <p className="eyebrow">{book.sourceType.toUpperCase()} reader</p>
            <h2>{book.title}</h2>
          </div>
          <div className="search-box">
            <Search aria-hidden="true" />
            <input
              type="search"
              placeholder="Find text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') goToSearchMatch()
              }}
            />
            <button type="button" onClick={goToSearchMatch} disabled={searchMatchIndex < 0}>
              Find
            </button>
          </div>
        </header>

        <div className="progress-rail" aria-label={`Reading progress ${Math.round(progress)}%`}>
          <span style={{ width: `${progress}%` }} />
        </div>

        <div className="reader-layout">
          {isPdfVisualReader ? (
            <article 
              ref={readerRef} 
              className="reader-page pdf-reader" 
              aria-label="Rendered PDF"
              onClick={handlePdfClick}
              style={
                {
                  '--pdf-zoom': pdfZoom,
                  '--reader-text-scale': settings.textScale,
                  '--reader-line-height': settings.lineHeight,
                } as CSSProperties
              }
            >
              <div className="pdf-toolbar">
                <button
                  type="button"
                  onClick={() => setPdfZoom((z) => Math.max(0.5, z - 0.25))}
                  title="Zoom out"
                >
                  <ZoomOut aria-hidden="true" />
                  <span>Zoom out</span>
                </button>
                <span className="pdf-zoom-value">{Math.round(pdfZoom * 100)}%</span>
                <button
                  type="button"
                  onClick={() => setPdfZoom((z) => Math.min(2.5, z + 0.25))}
                  title="Zoom in"
                >
                  <ZoomIn aria-hidden="true" />
                  <span>Zoom in</span>
                </button>

                <div className="page-input">
                  <Navigation aria-hidden="true" />
                  <input
                    type="number"
                    placeholder="Page"
                    min={1}
                    max={pdfPageCount}
                    value={pdfPageInput}
                    onChange={(e) => setPdfPageInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleJumpToPage()
                    }}
                  />
                  <span className="page-count">of {pdfPageCount}</span>
                  <button type="button" onClick={handleJumpToPage}>
                    Go
                  </button>
                </div>
              </div>
              {book.pdfPages?.map((pageInfo) => (
                <PdfPageView
                  key={pageInfo.pageNumber}
                  activeRegions={activePdfRegions.filter(
                    (region) => region.pageNumber === pageInfo.pageNumber,
                  )}
                  forceInitialRender={pageInfo.pageNumber <= 2}
                  onImageDetected={markPdfPageHasImages}
                  onStartFromWord={startReadingAtWord}
                  pageInfo={pageInfo}
                  pdfDocument={pdfDocument}
                  registerActiveRegion={(node) => {
                    activePdfRegionRef.current = node
                  }}
                />
              ))}
            </article>
          ) : book.sourceType === 'pdf' ? (
            <article ref={readerRef} className="reader-page pdf-reader" aria-label="Loading PDF">
              <div className="pdf-loading-state">
                <FileText aria-hidden="true" />
                <h3>{pdfRenderStatus || status || 'Preparing PDF view'}</h3>
                <p>
                  Imported {pdfPageCount.toLocaleString()} pages and {words.length.toLocaleString()}{' '}
                  words. The rendered page view is loading now.
                </p>
              </div>
            </article>
          ) : (
            <article
              ref={readerRef}
              className="reader-page"
              aria-label="Book text"
              style={textReaderStyle}
            >
              {tokens.map((token) =>
                token.kind === 'space' ? (
                  <span key={`s-${token.tokenIndex}`}>{token.value}</span>
                ) : (
                  <span
                    key={`w-${token.wordIndex}`}
                    ref={token.wordIndex === currentWordIndex ? activeWordRef : null}
                    className={token.wordIndex === currentWordIndex ? 'word is-current' : 'word'}
                    data-word-index={token.wordIndex}
                    onClick={() => jumpToWord(token.wordIndex)}
                  >
                    {token.value}
                  </span>
                ),
              )}
            </article>
          )}

          <aside className="visual-panel" aria-label="Reading tracker">
            <div className="status-card">
              <div className="meter">
                <svg viewBox="0 0 120 120" aria-hidden="true">
                  <circle cx="60" cy="60" r="51" />
                  <circle
                    cx="60"
                    cy="60"
                    r="51"
                    pathLength="100"
                    style={{ strokeDasharray: `${progress} 100` }}
                  />
                </svg>
                <strong>{Math.round(progress)}%</strong>
              </div>
              <div>
                <p className="status">{status}</p>
                <h3>{currentWord || 'Ready'}</h3>
                <p>
                  {book.sourceType === 'pdf' && pdfRenderStatus
                    ? pdfRenderStatus
                    : `${formatMinutes(minutesRemaining)} left at this speed`}
                </p>
              </div>
            </div>

            <div className={isSpeaking && !isPaused ? 'voice-bars is-active' : 'voice-bars'}>
              {Array.from({ length: 18 }).map((_, index) => (
                <span key={index} style={{ animationDelay: `${index * 70}ms` }} />
              ))}
            </div>

            <div className="stats-grid">
              <div>
                <FileText aria-hidden="true" />
                <span>{words.length.toLocaleString()} words</span>
              </div>
              <div>
                <Eye aria-hidden="true" />
                <span>{currentWordIndex.toLocaleString()} read</span>
              </div>
              <div>
                <BookOpen aria-hidden="true" />
                <span>
                  {book.sourceType === 'pdf'
                    ? `${book.pdfPages?.length ?? 0} pages, ${book.mathRegionCount ?? 0} math stops`
                    : selectedVoiceLabel}
                </span>
              </div>
            </div>

            <div className="bookmark-panel">
              <div className="panel-title">
                <h3>Bookmarks</h3>
                <button type="button" onClick={addBookmark} title="Add bookmark">
                  <Plus aria-hidden="true" />
                </button>
              </div>

              {filteredBookmarks.length === 0 ? (
                <p className="empty-state">No bookmarks yet.</p>
              ) : (
                <div className="bookmark-list">
                  {filteredBookmarks.map((bookmark) => (
                    <button
                      type="button"
                      key={bookmark.id}
                      onClick={() => jumpToWord(bookmark.wordIndex)}
                    >
                      <span>{bookmark.label}</span>
                      <small>{Math.round((bookmark.wordIndex / words.length) * 100)}%</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      </section>

      {settings.focusMode ? (
        <div className="focus-dock" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className="icon-button" onClick={() => handleSkip(-80)} title="Back">
            <SkipBack aria-hidden="true" />
          </button>
          <button type="button" className="play-button" onClick={handlePlayPause}>
            {isSpeaking && !isPaused ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            <span>{isSpeaking && !isPaused ? 'Pause' : 'Play'}</span>
          </button>
          <button type="button" className="icon-button" onClick={() => handleSkip(80)} title="Forward">
            <SkipForward aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" onClick={handleStop} title="Stop">
            <Square aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setSettings((current) => ({ ...current, focusMode: false }))}
            title="Exit focus mode"
          >
            <X aria-hidden="true" />
          </button>
          <label>
            <span>{settings.rate.toFixed(2)}x</span>
            <input
              type="range"
              min="0.6"
              max="1.8"
              step="0.05"
              value={settings.rate}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  rate: Number(event.target.value),
                  profile: 'balanced',
                }))
              }
            />
          </label>
        </div>
      ) : null}
    </main>
  )
}

export default App
