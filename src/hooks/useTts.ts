'use client'

import { useCallback, useEffect, useRef } from 'react'

export type TtsEngine = 'kokoro' | 'browser'

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

export const KOKORO_VOICES = [
  {
    id: 'af_heart',
    label: 'Heart',
    locale: 'American English',
    description: 'Warm female voice, grade A',
  },
  {
    id: 'af_bella',
    label: 'Bella',
    locale: 'American English',
    description: 'Expressive female voice, grade A-',
  },
  {
    id: 'af_nicole',
    label: 'Nicole',
    locale: 'American English',
    description: 'Calm female voice, grade B-',
  },
  {
    id: 'am_fenrir',
    label: 'Fenrir',
    locale: 'American English',
    description: 'Steady male voice, grade C+',
  },
  {
    id: 'am_michael',
    label: 'Michael',
    locale: 'American English',
    description: 'Balanced male voice, grade C+',
  },
  {
    id: 'bf_emma',
    label: 'Emma',
    locale: 'British English',
    description: 'Clear female voice, grade B-',
  },
  {
    id: 'bm_george',
    label: 'George',
    locale: 'British English',
    description: 'Measured male voice, grade C',
  },
] as const

export type KokoroVoiceId = (typeof KOKORO_VOICES)[number]['id']

export type SpeechBoundary = {
  charStart: number
  wordIndex: number
}

type TtsRequest = {
  text: string
  engine: TtsEngine
  rate: number
  pitch: number
  volume: number
  kokoroVoiceId: KokoroVoiceId
  browserVoice?: SpeechSynthesisVoice
  boundaryMap: SpeechBoundary[]
  browserStatus?: string
  onBoundary: (wordIndex: number) => void
  onEnd: () => void
  onError: () => void
  onStatus: (message: string) => void
}

type TtsPreloadRequest = {
  text: string
  engine: TtsEngine
  rate: number
  kokoroVoiceId: KokoroVoiceId
}

type BrowserWindowWithAudio = Window & {
  AudioContext?: typeof AudioContext
  webkitAudioContext?: typeof AudioContext
}

type KokoroWorkerMessage =
  | { id: number; type: 'status'; message: string }
  | { id: number; type: 'audio'; audioBuffer: ArrayBuffer }
  | { id: number; type: 'error'; message: string }

const KOKORO_VOICE_IDS = new Set<string>(KOKORO_VOICES.map((voice) => voice.id))

export function isKokoroVoiceId(value: unknown): value is KokoroVoiceId {
  return typeof value === 'string' && KOKORO_VOICE_IDS.has(value)
}

function isBrowserReady() {
  return typeof window !== 'undefined'
}

export function useTts() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const audioGainRef = useRef<GainNode | null>(null)
  const audioBufferRef = useRef<AudioBuffer | null>(null)
  const audioRequestRef = useRef<TtsRequest | null>(null)
  const audioStartedAtRef = useRef(0)
  const audioPausedAtRef = useRef(0)
  const audioPauseInProgressRef = useRef(false)
  const audioRunRef = useRef(0)
  const boundaryFrameRef = useRef<number | null>(null)
  const playbackRunRef = useRef(0)
  const workerRef = useRef<Worker | null>(null)
  const workerRequestRef = useRef(0)
  const preloadedAudioRef = useRef<Map<string, Promise<ArrayBuffer>>>(new Map())

  const stopBoundaryClock = useCallback(() => {
    if (!isBrowserReady() || boundaryFrameRef.current === null) return

    window.cancelAnimationFrame(boundaryFrameRef.current)
    boundaryFrameRef.current = null
  }, [])

  const getAudioContext = useCallback(() => {
    if (!isBrowserReady()) return null

    if (!audioContextRef.current) {
      const audioWindow = window as BrowserWindowWithAudio
      const AudioContextConstructor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext

      if (!AudioContextConstructor) return null

      audioContextRef.current = new AudioContextConstructor()
    }

    if (audioContextRef.current.state === 'suspended') {
      void audioContextRef.current.resume()
    }

    return audioContextRef.current
  }, [])

  const stopWebAudio = useCallback((clearBuffer = true) => {
    audioPauseInProgressRef.current = false

    if (audioSourceRef.current) {
      audioSourceRef.current.onended = null

      try {
        audioSourceRef.current.stop()
      } catch {
        // A source can only be stopped once; ignore repeat stops during cleanup.
      }

      audioSourceRef.current.disconnect()
      audioSourceRef.current = null
    }

    audioGainRef.current?.disconnect()
    audioGainRef.current = null
    audioStartedAtRef.current = 0

    if (clearBuffer) {
      audioBufferRef.current = null
      audioRequestRef.current = null
      audioPausedAtRef.current = 0
      audioRunRef.current = 0
    }
  }, [])

  const releaseAudio = useCallback(() => {
    stopWebAudio()
    audioRef.current?.pause()
    audioRef.current = null

    if (audioUrlRef.current && isBrowserReady()) {
      window.URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
  }, [stopWebAudio])

  const stop = useCallback(() => {
    playbackRunRef.current += 1
    stopBoundaryClock()
    releaseAudio()

    if (isBrowserReady()) {
      window.speechSynthesis?.cancel()
    }
  }, [releaseAudio, stopBoundaryClock])

  const startEstimatedBoundaries = useCallback(
    (
      getCurrentTime: () => number,
      getDuration: () => number,
      boundaryMap: SpeechBoundary[],
      runId: number,
      onBoundary: TtsRequest['onBoundary'],
    ) => {
      stopBoundaryClock()

      if (boundaryMap.length === 0) return

      let lastWordIndex = -1

      const tick = () => {
        if (playbackRunRef.current !== runId) return

        const duration = getDuration()

        if (duration > 0) {
          const progress = Math.max(0, Math.min(getCurrentTime() / duration, 0.999))
          const boundaryIndex = Math.min(
            boundaryMap.length - 1,
            Math.floor(progress * boundaryMap.length),
          )
          const wordIndex = boundaryMap[boundaryIndex]?.wordIndex

          if (typeof wordIndex === 'number' && wordIndex !== lastWordIndex) {
            lastWordIndex = wordIndex
            onBoundary(wordIndex)
          }
        }

        boundaryFrameRef.current = window.requestAnimationFrame(tick)
      }

      tick()
    },
    [stopBoundaryClock],
  )

  const startWebAudio = useCallback(
    (buffer: AudioBuffer, offset: number, request: TtsRequest, runId: number) => {
      const context = getAudioContext()

      if (!context) {
        request.onError()
        return
      }

      stopWebAudio(false)
      audioBufferRef.current = buffer
      audioRequestRef.current = request
      audioRunRef.current = runId
      audioPausedAtRef.current = offset
      audioPauseInProgressRef.current = false

      const source = context.createBufferSource()
      const gain = context.createGain()
      const safeOffset = Math.max(0, Math.min(offset, Math.max(buffer.duration - 0.01, 0)))

      source.buffer = buffer
      gain.gain.value = request.volume
      source.connect(gain).connect(context.destination)

      audioSourceRef.current = source
      audioGainRef.current = gain
      audioStartedAtRef.current = context.currentTime - safeOffset

      source.onended = () => {
        if (audioPauseInProgressRef.current) {
          audioPauseInProgressRef.current = false
          return
        }

        if (playbackRunRef.current !== runId) return

        stopBoundaryClock()
        stopWebAudio()
        request.onEnd()
      }

      request.onStatus('Reading')
      source.start(0, safeOffset)
      startEstimatedBoundaries(
        () => Math.max(0, context.currentTime - audioStartedAtRef.current),
        () => buffer.duration,
        request.boundaryMap,
        runId,
        request.onBoundary,
      )
    },
    [getAudioContext, startEstimatedBoundaries, stopBoundaryClock, stopWebAudio],
  )

  const pause = useCallback(() => {
    if (!isBrowserReady()) return

    if (audioSourceRef.current && audioBufferRef.current) {
      const context = audioContextRef.current
      audioPausedAtRef.current = context
        ? Math.min(audioBufferRef.current.duration, context.currentTime - audioStartedAtRef.current)
        : audioPausedAtRef.current
      audioPauseInProgressRef.current = true
      stopBoundaryClock()

      try {
        audioSourceRef.current.stop()
      } catch {
        // A source can only be stopped once; ignore repeat pauses.
      }

      audioSourceRef.current.disconnect()
      audioSourceRef.current = null
      audioGainRef.current?.disconnect()
      audioGainRef.current = null
      return
    }

    if (audioRef.current) {
      audioRef.current.pause()
      return
    }

    window.speechSynthesis?.pause()
  }, [stopBoundaryClock])

  const resume = useCallback(() => {
    if (!isBrowserReady()) return

    if (audioBufferRef.current && audioRequestRef.current && !audioSourceRef.current) {
      startWebAudio(
        audioBufferRef.current,
        audioPausedAtRef.current,
        audioRequestRef.current,
        audioRunRef.current,
      )
      return
    }

    if (audioRef.current) {
      void audioRef.current.play()
      return
    }

    window.speechSynthesis?.resume()
  }, [startWebAudio])

  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      workerRef.current = new Worker(new URL('../workers/kokoroTtsWorker.ts', import.meta.url), {
        type: 'module',
      })
    }

    return workerRef.current
  }, [])

  const getKokoroCacheKey = useCallback(
    (request: TtsPreloadRequest) =>
      [request.kokoroVoiceId, request.rate.toFixed(3), request.text].join('\n'),
    [],
  )

  const requestKokoroAudio = useCallback(
    (
      request: TtsPreloadRequest,
      options: { runId?: number; onStatus?: (message: string) => void } = {},
    ) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        const worker = getWorker()
        const id = workerRequestRef.current + 1
        workerRequestRef.current = id

        const handleMessage = (event: MessageEvent<KokoroWorkerMessage>) => {
          const message = event.data

          if (message.id !== id) return

          if (message.type === 'status') {
            if (options.runId === undefined || playbackRunRef.current === options.runId) {
              options.onStatus?.(message.message)
            }
            return
          }

          worker.removeEventListener('message', handleMessage)
          worker.removeEventListener('error', handleError)

          if (message.type === 'audio') {
            resolve(message.audioBuffer)
            return
          }

          reject(new Error(message.message))
        }

        const handleError = (event: ErrorEvent) => {
          worker.removeEventListener('message', handleMessage)
          worker.removeEventListener('error', handleError)
          reject(event.error instanceof Error ? event.error : new Error(event.message))
        }

        worker.addEventListener('message', handleMessage)
        worker.addEventListener('error', handleError, { once: true })
        worker.postMessage({
          id,
          speed: request.rate,
          text: request.text,
          voice: request.kokoroVoiceId,
        })
      }),
    [getWorker],
  )

  const preload = useCallback(
    (request: TtsPreloadRequest) => {
      if (!isBrowserReady() || request.engine !== 'kokoro' || !request.text.trim()) return

      const cacheKey = getKokoroCacheKey(request)
      const cache = preloadedAudioRef.current

      if (cache.has(cacheKey)) return

      const generation = requestKokoroAudio(request)
      cache.set(cacheKey, generation)
      void generation.catch((error) => {
        cache.delete(cacheKey)
        console.warn('[AudioReader] Local AI preload failed', error)
      })

      if (cache.size > 3) {
        const oldestKey = cache.keys().next().value
        if (oldestKey) cache.delete(oldestKey)
      }
    },
    [getKokoroCacheKey, requestKokoroAudio],
  )

  const speakWithBrowser = useCallback((request: TtsRequest, runId: number) => {
    if (!isBrowserReady() || !('speechSynthesis' in window)) {
      request.onStatus('Speech synthesis is not available in this browser')
      request.onError()
      return
    }

    window.speechSynthesis.cancel()
    stopBoundaryClock()
    releaseAudio()

    const utterance = new SpeechSynthesisUtterance(request.text)
    utterance.rate = request.rate
    utterance.pitch = request.pitch
    utterance.volume = request.volume

    if (request.browserVoice) {
      utterance.voice = request.browserVoice
      utterance.lang = request.browserVoice.lang
    }

    utterance.onboundary = (event) => {
      if (playbackRunRef.current !== runId || typeof event.charIndex !== 'number') return

      const activeBoundary =
        request.boundaryMap.findLast((boundary) => boundary.charStart <= event.charIndex) ??
        request.boundaryMap[0]

      if (activeBoundary) request.onBoundary(activeBoundary.wordIndex)
    }

    utterance.onend = () => {
      if (playbackRunRef.current !== runId) return
      request.onEnd()
    }

    utterance.onerror = () => {
      if (playbackRunRef.current !== runId) return
      request.onError()
    }

    request.onStatus(request.browserStatus ?? 'Reading')
    window.speechSynthesis.speak(utterance)
  }, [releaseAudio, stopBoundaryClock])

  const speakWithKokoro = useCallback(
    async (request: TtsRequest, runId: number) => {
      if (!isBrowserReady()) {
        request.onError()
        return
      }

      releaseAudio()
      window.speechSynthesis?.cancel()
      request.onStatus('Loading local AI voice')

      try {
        const cacheKey = getKokoroCacheKey(request)
        const cachedAudio = preloadedAudioRef.current.get(cacheKey)
        const wavBuffer =
          cachedAudio ??
          requestKokoroAudio(request, {
            runId,
            onStatus: request.onStatus,
          })
        preloadedAudioRef.current.delete(cacheKey)
        const resolvedWavBuffer = await wavBuffer
        if (playbackRunRef.current !== runId) return

        const audioContext = getAudioContext()

        if (!audioContext) {
          request.onError()
          return
        }

        const audioBuffer = await audioContext.decodeAudioData(resolvedWavBuffer.slice(0))
        if (playbackRunRef.current !== runId) return

        if (audioContext.state === 'suspended') {
          await audioContext.resume()
        }

        startWebAudio(audioBuffer, 0, request, runId)
      } catch (error) {
        console.error('[AudioReader] Local AI voice failed', error)

        if (playbackRunRef.current !== runId) return

        request.onStatus('Local AI voice unavailable; using browser voice')
        speakWithBrowser(request, runId)
      }
    },
    [
      getAudioContext,
      getKokoroCacheKey,
      releaseAudio,
      requestKokoroAudio,
      speakWithBrowser,
      startWebAudio,
    ],
  )

  const speak = useCallback(
    (request: TtsRequest) => {
      const runId = playbackRunRef.current + 1
      playbackRunRef.current = runId

      stopBoundaryClock()

      if (request.engine === 'kokoro') {
        getAudioContext()
        void speakWithKokoro(request, runId)
        return
      }

      speakWithBrowser(request, runId)
    },
    [getAudioContext, speakWithBrowser, speakWithKokoro, stopBoundaryClock],
  )

  useEffect(() => stop, [stop])

  useEffect(
    () => () => {
      workerRef.current?.terminate()
      workerRef.current = null
    },
    [],
  )

  return {
    pause,
    preload,
    resume,
    speak,
    stop,
  }
}
