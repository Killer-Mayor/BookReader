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
}

type PdfTextRegion = {
  wordIndex: number
  pageNumber: number
  left: number
  top: number
  width: number
  height: number
  isMath: boolean
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
const MATH_TEXT_PATTERN =
  /([=<>≤≥≈≠∑∫√∞±×÷∂∆∇πµΩα-ωΑ-Ω^_{}|])|(\d+\s*[+\-*/=]\s*\d)|(\b[a-z]\s*[=<>]\s*)/i

type PdfDocumentProxy = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>

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

function arrayBufferToDataUrl(buffer: ArrayBuffer, mimeType: string) {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''

  for (let cursor = 0; cursor < bytes.length; cursor += chunkSize) {
    const chunk = bytes.subarray(cursor, cursor + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return `data:${mimeType};base64,${window.btoa(binary)}`
}

async function dataUrlToUint8Array(dataUrl: string) {
  const response = await fetch(dataUrl)
  return new Uint8Array(await response.arrayBuffer())
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
  return {
    title: titleFromFileName(file.name),
    sourceType: 'txt',
    text: normalizeText(await file.text()),
  }
}

async function extractPdf(file: File): Promise<ExtractedBook> {
  const data = new Uint8Array(await file.arrayBuffer())
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const pages: string[] = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')

    if (pageText.trim()) {
      pages.push(pageText)
    }
  }

  return {
    title: titleFromFileName(file.name),
    sourceType: 'pdf',
    text: normalizeText(pages.join('\n\n')),
  }
}

async function extractEpub(file: File): Promise<ExtractedBook> {
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

  return {
    title,
    sourceType: 'epub',
    text: normalizeText(chapters.join('\n\n')),
  }
}

async function extractBook(file: File): Promise<ExtractedBook> {
  const sourceType = sourceTypeFromFile(file)

  if (!sourceType) {
    throw new Error('Please upload a .txt, .epub, or .pdf file.')
  }

  if (sourceType === 'txt') return extractTxt(file)
  if (sourceType === 'pdf') return extractPdf(file)

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
  const readerRef = useRef<HTMLDivElement | null>(null)
  const activeWordRef = useRef<HTMLSpanElement | null>(null)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const speakFromWordRef = useRef<(wordIndex: number) => void>(() => undefined)
  const resumeIndexRef = useRef(0)
  const isStoppingRef = useRef(false)

  const words = useMemo(() => splitWords(book.text), [book.text])
  const tokens = useMemo(() => buildTokens(book.text, words), [book.text, words])
  const progress = words.length > 0 ? Math.min((currentWordIndex / words.length) * 100, 100) : 0
  const currentWord = words[currentWordIndex]?.text ?? ''
  const minutesRemaining = estimateMinutesRemaining(words.length, currentWordIndex, settings.rate)
  const selectedVoice = voices.find((voice) => voice.voiceURI === settings.voiceURI) ?? voices[0]
  const filteredBookmarks = bookmarks.filter((bookmark) => bookmark.id.startsWith(`${book.id}:`))
  const searchMatchIndex = useMemo(() => {
    if (!query.trim()) return -1

    return book.text.toLowerCase().indexOf(query.toLowerCase())
  }, [book.text, query])

  const jumpToWord = useCallback((wordIndex: number) => {
    const safeWordIndex = Math.max(0, Math.min(wordIndex, Math.max(words.length - 1, 0)))
    setCurrentWordIndex(safeWordIndex)
    setIsPaused(false)
    setStatus('Position updated')

    requestAnimationFrame(() => {
      activeWordRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
      book.text,
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
    localStorage.setItem(STORAGE_KEYS.book, JSON.stringify(book))
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
    if (!activeWordRef.current || !isSpeaking) return

    activeWordRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentWordIndex, isSpeaking])

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
    return () => {
      isStoppingRef.current = true
      window.speechSynthesis?.cancel()
    }
  }, [])

  async function handleFile(file: File) {
    try {
      setStatus('Importing book')
      const extracted = await extractBook(file)

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
      setStatus('Book imported')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Import failed')
    } finally {
      setIsDraggingFile(false)
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
                <p>{formatMinutes(minutesRemaining)} left at this speed</p>
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
                <span>{selectedVoice?.name ?? 'Default voice'}</span>
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
