import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  Bookmark,
  Check,
  Eye,
  FileText,
  Gauge,
  Headphones,
  Moon,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
  Square,
  Upload,
  Volume2,
} from 'lucide-react'
import JSZip from 'jszip'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

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
  profile: VoiceProfileId
  focusMode: boolean
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

type ExtractedBook = {
  title: string
  sourceType: SourceType
  text: string
  pdfDataUrl?: string
  pdfPages?: PdfPageInfo[]
  pdfRegions?: PdfTextRegion[]
  mathRegionCount?: number
}

const STORAGE_KEYS = {
  book: 'aural-reader.book',
  settings: 'aural-reader.settings',
  progress: 'aural-reader.progress',
  bookmarks: 'aural-reader.bookmarks',
}

const DEFAULT_TEXT = `Drop in a book and make the page speak with you.

This local reader is set up for txt, epub, and pdf files. Choose a voice, tune the speed, place bookmarks, and use focus mode when you want the text to take over the room.

Browser voices are the right first engine for a private prototype because they do not require accounts or API keys. For a later upgrade, cloud engines such as OpenAI, ElevenLabs, Google Cloud Text-to-Speech, Azure Speech, or Amazon Polly can be added behind the same controls when you want more natural narration or cloned/private voices.`

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
  profile: 'balanced',
  focusMode: false,
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
const PDF_CHUNK_WORD_LIMIT = 95
const PDF_EQUATION_PAUSE_MS = 1100
const PDF_IMPORT_YIELD_EVERY_PAGES = 3
const MAX_PERSISTED_BOOK_CHARS = 250_000
const DEBUG_PREFIX = '[AudioReader]'
const MATH_TEXT_PATTERN =
  /([=<>≤≥≈≠∑∫√∞±×÷∂∆∇πµΩα-ωΑ-Ω^_{}|])|(\d+\s*[+\-*/=]\s*\d)|(\b[a-z]\s*[=<>]\s*)/i

type PdfDocumentProxy = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>
type ImportProgress = (message: string) => void
type PdfLoadingProgress = { loaded: number; total: number }

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

function getChunk(text: string, startChar: number) {
  const remaining = text.slice(startChar)

  if (remaining.length <= CHUNK_LIMIT) return remaining

  const targetSlice = remaining.slice(0, CHUNK_LIMIT)
  const punctuationWindow = targetSlice.slice(CHUNK_TARGET)
  const punctuationMatch = punctuationWindow.search(/[.!?]\s+/)

  if (punctuationMatch >= 0) {
    return targetSlice.slice(0, CHUNK_TARGET + punctuationMatch + 1)
  }

  const paragraphBreak = targetSlice.lastIndexOf('\n\n')

  if (paragraphBreak > CHUNK_TARGET * 0.55) {
    return targetSlice.slice(0, paragraphBreak)
  }

  const lastSpace = targetSlice.lastIndexOf(' ')

  return targetSlice.slice(0, lastSpace > 0 ? lastSpace : CHUNK_LIMIT)
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
  onImageDetected,
  onJump,
  pageInfo,
  pdfDocument,
  registerActiveRegion,
}: {
  activeRegions: PdfTextRegion[]
  onImageDetected: (pageNumber: number) => void
  onJump: (wordIndex: number) => void
  pageInfo: PdfPageInfo
  pdfDocument: PdfDocumentProxy
  registerActiveRegion: (node: HTMLButtonElement | null) => void
}) {
  const pageRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const shouldForceRender = activeRegions.length > 0
  const [isNearViewport, setIsNearViewport] = useState(false)
  const [isRendered, setIsRendered] = useState(false)

  useEffect(() => {
    const pageNode = pageRef.current

    if (!pageNode) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsNearViewport(entry.isIntersecting)
      },
      { root: null, rootMargin: '900px 0px', threshold: 0.01 },
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
      const canvas = canvasRef.current

      if (!canvas) return

      setIsRendered(false)
      debugLog('PDF render: page start', { pageNumber: pageInfo.pageNumber })
      const page = await pdfDocument.getPage(pageInfo.pageNumber)
      const outputScale = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = page.getViewport({ scale: outputScale })
      const context = canvas.getContext('2d')

      if (!context || cancelled) return

      canvas.width = viewport.width
      canvas.height = viewport.height
      canvas.style.aspectRatio = `${pageInfo.width} / ${pageInfo.height}`
      await page.render({ canvas, canvasContext: context, viewport }).promise

      const imageOps = new Set([
        pdfjsLib.OPS.paintImageXObject,
        pdfjsLib.OPS.paintInlineImageXObject,
        pdfjsLib.OPS.paintXObject,
      ])
      const operatorList = await page.getOperatorList()

      if (!cancelled) {
        if (operatorList.fnArray.some((fn) => imageOps.has(fn))) {
          onImageDetected(pageInfo.pageNumber)
        }

        setIsRendered(true)
        debugLog('PDF render: page complete', {
          pageNumber: pageInfo.pageNumber,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
          hasImages: operatorList.fnArray.some((fn) => imageOps.has(fn)),
        })
      }
    }

    void renderPage().catch((error: unknown) => {
      debugError('PDF render: page failed', error)
    })

    return () => {
      cancelled = true
    }
  }, [
    isNearViewport,
    onImageDetected,
    pageInfo.height,
    pageInfo.pageNumber,
    pageInfo.width,
    pdfDocument,
    shouldForceRender,
  ])

  return (
    <section
      ref={pageRef}
      className={isRendered ? 'pdf-page is-rendered' : 'pdf-page'}
      style={{ aspectRatio: `${pageInfo.width} / ${pageInfo.height}` }}
      aria-label={`PDF page ${pageInfo.pageNumber}`}
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
          onClick={() => onJump(region.wordIndex)}
          aria-label={
            region.isVisual
              ? 'Visual page pause region'
              : region.isMath
                ? 'Equation pause region'
                : 'Current read region'
          }
        />
      ))}
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
    safeParse<ReaderBook>(localStorage.getItem(STORAGE_KEYS.book), DEFAULT_BOOK),
  )
  const [settings, setSettings] = useState<ReaderSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...safeParse<Partial<ReaderSettings>>(localStorage.getItem(STORAGE_KEYS.settings), {}),
  }))
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>(() =>
    safeParse<BookmarkEntry[]>(localStorage.getItem(STORAGE_KEYS.bookmarks), []),
  )
  const [currentWordIndex, setCurrentWordIndex] = useState(() =>
    safeParse<Record<string, number>>(localStorage.getItem(STORAGE_KEYS.progress), {})[
      safeParse<ReaderBook>(localStorage.getItem(STORAGE_KEYS.book), DEFAULT_BOOK).id
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
  const readerRef = useRef<HTMLDivElement | null>(null)
  const activeWordRef = useRef<HTMLSpanElement | null>(null)
  const activePdfRegionRef = useRef<HTMLButtonElement | null>(null)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const speakFromWordRef = useRef<(wordIndex: number) => void>(() => undefined)
  const pausedImagePagesRef = useRef<Set<number>>(new Set())
  const resumeIndexRef = useRef(0)
  const isStoppingRef = useRef(false)
  const importRunRef = useRef(0)

  const words = useMemo(() => splitWords(book.text), [book.text])
  const tokens = useMemo(
    () => (book.sourceType === 'pdf' ? [] : buildTokens(book.text, words)),
    [book.sourceType, book.text, words],
  )
  const progress = words.length > 0 ? Math.min((currentWordIndex / words.length) * 100, 100) : 0
  const currentWord = words[currentWordIndex]?.text ?? ''
  const minutesRemaining = estimateMinutesRemaining(words.length, currentWordIndex, settings.rate)
  const selectedVoice = voices.find((voice) => voice.voiceURI === settings.voiceURI) ?? voices[0]
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
  const activePdfPageNumber = activePdfRegions[0]?.pageNumber ?? pdfRegionsByWord.get(currentWordIndex)?.pageNumber ?? 1
  const visiblePdfPages = useMemo(() => {
    if (!book.pdfPages?.length) return []

    return book.pdfPages.filter(
      (pageInfo) => Math.abs(pageInfo.pageNumber - activePdfPageNumber) <= 1,
    )
  }, [activePdfPageNumber, book.pdfPages])
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
    (startWordIndex: number) => {
      const parts: string[] = []
      const boundaryMap: Array<{ charStart: number; wordIndex: number }> = []
      let charCursor = 0
      let cursor = startWordIndex

      while (
        cursor < words.length &&
        !isPdfMathWord(cursor) &&
        parts.length < PDF_CHUNK_WORD_LIMIT
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

  const firstWordOnPdfPage = useCallback(
    (pageNumber: number) =>
      book.pdfRegions?.find((region) => region.pageNumber === pageNumber)?.wordIndex ?? 0,
    [book.pdfRegions],
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
      const progressByBook = safeParse<Record<string, number>>(
        localStorage.getItem(STORAGE_KEYS.progress),
        {},
      )
      progressByBook[book.id] = wordIndex
      localStorage.setItem(STORAGE_KEYS.progress, JSON.stringify(progressByBook))
    },
    [book.id],
  )

  const speakFromWord = useCallback(
    (wordIndex: number) => {
      if (!('speechSynthesis' in window) || words.length === 0) {
        setStatus('Speech synthesis is not available in this browser')
        return
      }

      isStoppingRef.current = false
      window.speechSynthesis.cancel()

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

        const chunk = buildPdfSpeechChunk(safeWordIndex)

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

        const utterance = new SpeechSynthesisUtterance(chunk.text)
        utterance.rate = settings.rate
        utterance.pitch = settings.pitch
        utterance.volume = settings.volume

        if (selectedVoice) {
          utterance.voice = selectedVoice
          utterance.lang = selectedVoice.lang
        }

        utterance.onboundary = (event) => {
          if (typeof event.charIndex !== 'number') return

          const activeBoundary =
            chunk.boundaryMap.findLast((boundary) => boundary.charStart <= event.charIndex) ??
            chunk.boundaryMap[0]

          if (!activeBoundary) return

          resumeIndexRef.current = activeBoundary.wordIndex
          setCurrentWordIndex(activeBoundary.wordIndex)
        }

        utterance.onend = () => {
          if (isStoppingRef.current) return

          if (chunk.nextWordIndex < words.length) {
            speakFromWordRef.current(chunk.nextWordIndex)
          } else {
            setCurrentWordIndex(words.length - 1)
            setIsSpeaking(false)
            setIsPaused(false)
            setStatus('Finished')
          }
        }

        utterance.onerror = () => {
          if (isStoppingRef.current) return
          setIsSpeaking(false)
          setIsPaused(false)
          setStatus('Voice playback stopped')
        }

        utteranceRef.current = utterance
        resumeIndexRef.current = safeWordIndex
        setCurrentWordIndex(safeWordIndex)
        setIsSpeaking(true)
        setIsPaused(false)
        setStatus('Reading PDF text')
        window.speechSynthesis.speak(utterance)
        return
      }

      const startChar = words[safeWordIndex]?.start ?? 0
      const chunk = getChunk(book.text, startChar)

      if (!chunk.trim()) {
        setIsSpeaking(false)
        setStatus('Finished')
        return
      }

      const utterance = new SpeechSynthesisUtterance(chunk)
      utterance.rate = settings.rate
      utterance.pitch = settings.pitch
      utterance.volume = settings.volume

      if (selectedVoice) {
        utterance.voice = selectedVoice
        utterance.lang = selectedVoice.lang
      }

      utterance.onboundary = (event) => {
        if (typeof event.charIndex !== 'number') return

        const globalCharIndex = startChar + event.charIndex
        const nextWordIndex = findWordIndexFromChar(words, globalCharIndex)
        resumeIndexRef.current = nextWordIndex
        setCurrentWordIndex(nextWordIndex)
      }

      utterance.onend = () => {
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
      }

      utterance.onerror = () => {
        if (isStoppingRef.current) return
        setIsSpeaking(false)
        setIsPaused(false)
        setStatus('Voice playback stopped')
      }

      utteranceRef.current = utterance
      resumeIndexRef.current = safeWordIndex
      setCurrentWordIndex(safeWordIndex)
      setIsSpeaking(true)
      setIsPaused(false)
      setStatus('Reading')
      window.speechSynthesis.speak(utterance)
    },
    [
      book.pdfPages,
      book.pdfRegions?.length,
      book.sourceType,
      book.text,
      buildPdfSpeechChunk,
      findNextNarratablePdfWord,
      isPdfMathWord,
      pdfRegionsByWord,
      selectedVoice,
      settings.pitch,
      settings.rate,
      settings.volume,
      words,
    ],
  )

  useEffect(() => {
    speakFromWordRef.current = speakFromWord
  }, [speakFromWord])

  useEffect(() => {
    try {
      const persistedBook = getPersistableBook(book)
      localStorage.setItem(STORAGE_KEYS.book, JSON.stringify(persistedBook))
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
        localStorage.removeItem(STORAGE_KEYS.book)
      } catch (removeError) {
        debugError('Storage: failed to clear book key after quota error', removeError)
      }
    }
  }, [book])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.bookmarks, JSON.stringify(bookmarks))
  }, [bookmarks])

  useEffect(() => {
    persistProgress(currentWordIndex)
  }, [currentWordIndex, persistProgress])

  useEffect(() => {
    pausedImagePagesRef.current.clear()
  }, [book.id])

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

      if (event.code === 'Space') {
        event.preventDefault()
        if (isSpeaking && !isPaused) {
          window.speechSynthesis.pause()
          setIsPaused(true)
          setStatus('Paused')
        } else if (isSpeaking && isPaused) {
          window.speechSynthesis.resume()
          setIsPaused(false)
          setStatus('Reading')
        } else {
          speakFromWord(currentWordIndex)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentWordIndex, isPaused, isSpeaking, speakFromWord])

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
      pdfWorker: pdfWorkerUrl,
    })

    return () => {
      isStoppingRef.current = true
      window.speechSynthesis?.cancel()
      window.removeEventListener('error', handleWindowError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [])

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

      const nextBook: ReaderBook = {
        ...extracted,
        id: `${file.name}:${file.size}:${file.lastModified}`,
        importedAt: Date.now(),
      }

      isStoppingRef.current = true
      window.speechSynthesis.cancel()
      setBook(nextBook)
      setCurrentWordIndex(0)
      setIsSpeaking(false)
      setIsPaused(false)
      setVisualPausePage(null)
      setStatus(
        nextBook.sourceType === 'pdf' && nextBook.pdfRegions?.length === 0
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
      window.speechSynthesis.pause()
      setIsPaused(true)
      setStatus('Paused')
      return
    }

    if (isSpeaking && isPaused) {
      window.speechSynthesis.resume()
      setIsPaused(false)
      setStatus('Reading')
      return
    }

    speakFromWord(currentWordIndex)
  }

  function handleStop() {
    isStoppingRef.current = true
    window.speechSynthesis.cancel()
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
      window.speechSynthesis.cancel()
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

  function addBookmark() {
    const phrase = words
      .slice(currentWordIndex, currentWordIndex + 7)
      .map((word) => word.text)
      .join(' ')
    const bookmark: BookmarkEntry = {
      id: `${book.id}:${Date.now()}`,
      label: phrase || `Word ${currentWordIndex + 1}`,
      wordIndex: currentWordIndex,
      createdAt: Date.now(),
    }

    setBookmarks((current) => [bookmark, ...current])
    setStatus('Bookmark saved')
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

  return (
    <main className={settings.focusMode ? 'app app-focus' : 'app'}>
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
              value={settings.voiceURI}
              onChange={(event) =>
                setSettings((current) => ({ ...current, voiceURI: event.target.value }))
              }
            >
              {voices.length === 0 ? (
                <option value="">Browser default voice</option>
              ) : (
                voices.map((voice) => (
                  <option value={voice.voiceURI} key={voice.voiceURI}>
                    {voice.name} ({voice.lang})
                  </option>
                ))
              )}
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

        <section className="control-group" aria-labelledby="tools-heading">
          <div className="section-title">
            <Gauge aria-hidden="true" />
            <h2 id="tools-heading">Tools</h2>
          </div>
          <button type="button" className="tool-button" onClick={addBookmark}>
            <Bookmark aria-hidden="true" />
            <span>Add bookmark</span>
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
            <article ref={readerRef} className="reader-page pdf-reader" aria-label="Rendered PDF">
              <div className="pdf-window-toolbar">
                <button
                  type="button"
                  onClick={() => jumpToWord(firstWordOnPdfPage(Math.max(activePdfPageNumber - 1, 1)))}
                  disabled={activePdfPageNumber <= 1}
                >
                  Previous page
                </button>
                <span>
                  Page {activePdfPageNumber} of {pdfPageCount}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    jumpToWord(firstWordOnPdfPage(Math.min(activePdfPageNumber + 1, pdfPageCount)))
                  }
                  disabled={activePdfPageNumber >= pdfPageCount}
                >
                  Next page
                </button>
              </div>
              {visiblePdfPages.map((pageInfo) => (
                <PdfPageView
                  key={pageInfo.pageNumber}
                  activeRegions={activePdfRegions.filter(
                    (region) => region.pageNumber === pageInfo.pageNumber,
                  )}
                  onImageDetected={markPdfPageHasImages}
                  onJump={jumpToWord}
                  pageInfo={pageInfo}
                  pdfDocument={pdfDocument}
                  registerActiveRegion={(node) => {
                    activePdfRegionRef.current = node
                  }}
                />
              ))}
              <div className="pdf-window-note">
                Rendering pages {visiblePdfPages[0]?.pageNumber ?? activePdfPageNumber}-
                {visiblePdfPages.at(-1)?.pageNumber ?? activePdfPageNumber} for speed.
              </div>
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
            <article ref={readerRef} className="reader-page" aria-label="Book text">
              {tokens.map((token) =>
                token.kind === 'space' ? (
                  <span key={`s-${token.tokenIndex}`}>{token.value}</span>
                ) : (
                  <span
                    key={`w-${token.wordIndex}`}
                    ref={token.wordIndex === currentWordIndex ? activeWordRef : null}
                    className={token.wordIndex === currentWordIndex ? 'word is-current' : 'word'}
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
                    : (selectedVoice?.name ?? 'Default voice')}
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
    </main>
  )
}

export default App
