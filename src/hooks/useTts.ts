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

type KokoroModule = typeof import('kokoro-js')
type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>

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

const KOKORO_VOICE_IDS = new Set<string>(KOKORO_VOICES.map((voice) => voice.id))

export function isKokoroVoiceId(value: unknown): value is KokoroVoiceId {
  return typeof value === 'string' && KOKORO_VOICE_IDS.has(value)
}

function isBrowserReady() {
  return typeof window !== 'undefined'
}

function statusFromProgress(progress: unknown) {
  if (!progress || typeof progress !== 'object' || !('status' in progress)) return null

  const status = String((progress as { status?: unknown }).status ?? '')

  if (/download/i.test(status)) return 'Downloading local AI voice'
  if (/ready|done/i.test(status)) return 'Loading local AI voice'

  return null
}

export function useTts() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const boundaryFrameRef = useRef<number | null>(null)
  const playbackRunRef = useRef(0)
  const kokoroRef = useRef<Promise<KokoroInstance> | null>(null)

  const stopBoundaryClock = useCallback(() => {
    if (!isBrowserReady() || boundaryFrameRef.current === null) return

    window.cancelAnimationFrame(boundaryFrameRef.current)
    boundaryFrameRef.current = null
  }, [])

  const releaseAudio = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null

    if (audioUrlRef.current && isBrowserReady()) {
      window.URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    playbackRunRef.current += 1
    stopBoundaryClock()
    releaseAudio()

    if (isBrowserReady()) {
      window.speechSynthesis?.cancel()
    }
  }, [releaseAudio, stopBoundaryClock])

  const pause = useCallback(() => {
    if (!isBrowserReady()) return

    if (audioRef.current) {
      audioRef.current.pause()
      return
    }

    window.speechSynthesis?.pause()
  }, [])

  const resume = useCallback(() => {
    if (!isBrowserReady()) return

    if (audioRef.current) {
      void audioRef.current.play()
      return
    }

    window.speechSynthesis?.resume()
  }, [])

  const startEstimatedBoundaries = useCallback(
    (audio: HTMLAudioElement, boundaryMap: SpeechBoundary[], runId: number, onBoundary: TtsRequest['onBoundary']) => {
      stopBoundaryClock()

      if (boundaryMap.length === 0) return

      let lastWordIndex = -1

      const tick = () => {
        if (playbackRunRef.current !== runId || audioRef.current !== audio) return

        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0

        if (duration > 0) {
          const progress = Math.max(0, Math.min(audio.currentTime / duration, 0.999))
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

  const getKokoro = useCallback((onStatus: TtsRequest['onStatus'], runId: number) => {
    if (!kokoroRef.current) {
      kokoroRef.current = import('kokoro-js').then(({ KokoroTTS }) =>
        KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
          dtype: 'q8',
          device: 'wasm',
          progress_callback: (progress: unknown) => {
            if (playbackRunRef.current !== runId) return

            const message = statusFromProgress(progress)
            if (message) onStatus(message)
          },
        }),
      )
    }

    return kokoroRef.current
  }, [])

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
        const tts = await getKokoro(request.onStatus, runId)
        if (playbackRunRef.current !== runId) return

        request.onStatus('Generating audio')
        const audio = await tts.generate(request.text, {
          voice: request.kokoroVoiceId,
          speed: request.rate,
        })
        if (playbackRunRef.current !== runId) return

        const audioUrl = window.URL.createObjectURL(audio.toBlob())
        const player = new Audio(audioUrl)
        player.volume = request.volume

        audioRef.current = player
        audioUrlRef.current = audioUrl

        player.onloadedmetadata = () => {
          if (playbackRunRef.current !== runId) return
          startEstimatedBoundaries(player, request.boundaryMap, runId, request.onBoundary)
        }

        player.onended = () => {
          if (playbackRunRef.current !== runId) return

          stopBoundaryClock()
          releaseAudio()
          request.onEnd()
        }

        player.onerror = () => {
          if (playbackRunRef.current !== runId) return

          stopBoundaryClock()
          releaseAudio()
          request.onError()
        }

        request.onStatus('Reading')
        await player.play()
        startEstimatedBoundaries(player, request.boundaryMap, runId, request.onBoundary)
      } catch (error) {
        console.error('[AudioReader] Local AI voice failed', error)

        if (playbackRunRef.current !== runId) return

        request.onStatus('Local AI voice unavailable; using browser voice')
        speakWithBrowser(request, runId)
      }
    },
    [getKokoro, releaseAudio, speakWithBrowser, startEstimatedBoundaries, stopBoundaryClock],
  )

  const speak = useCallback(
    (request: TtsRequest) => {
      const runId = playbackRunRef.current + 1
      playbackRunRef.current = runId

      stopBoundaryClock()

      if (request.engine === 'kokoro') {
        void speakWithKokoro(request, runId)
        return
      }

      speakWithBrowser(request, runId)
    },
    [speakWithBrowser, speakWithKokoro, stopBoundaryClock],
  )

  useEffect(() => stop, [stop])

  return {
    pause,
    resume,
    speak,
    stop,
  }
}
