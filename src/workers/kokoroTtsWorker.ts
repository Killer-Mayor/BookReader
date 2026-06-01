import type { GenerateOptions } from 'kokoro-js'

type KokoroWorkerRequest = {
  id: number
  speed: number
  text: string
  voice: NonNullable<GenerateOptions['voice']>
}

type KokoroWorkerMessage =
  | { id: number; type: 'status'; message: string }
  | { id: number; type: 'audio'; audioBuffer: ArrayBuffer }
  | { id: number; type: 'error'; message: string }

type WorkerScope = {
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<KokoroWorkerRequest>) => void,
  ) => void
  postMessage: (message: KokoroWorkerMessage, transfer?: Transferable[]) => void
}

const workerScope = globalThis as unknown as WorkerScope
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

let ttsPromise: Promise<Awaited<ReturnType<typeof import('kokoro-js')['KokoroTTS']['from_pretrained']>>> | null =
  null

function postStatus(id: number, message: string) {
  workerScope.postMessage({ id, type: 'status', message })
}

function progressStatus(progress: unknown) {
  if (!progress || typeof progress !== 'object' || !('status' in progress)) return null

  const status = String((progress as { status?: unknown }).status ?? '')

  if (/download/i.test(status)) return 'Downloading local AI voice'
  if (/ready|done/i.test(status)) return 'Loading local AI voice'

  return null
}

async function getKokoro(id: number) {
  if (!ttsPromise) {
    ttsPromise = import('kokoro-js').then(({ KokoroTTS }) =>
      KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (progress: unknown) => {
          const message = progressStatus(progress)
          if (message) postStatus(id, message)
        },
      }),
    )
  }

  return ttsPromise
}

workerScope.addEventListener('message', (event) => {
  const { id, speed, text, voice } = event.data

  void (async () => {
    try {
      postStatus(id, 'Loading local AI voice')
      const tts = await getKokoro(id)

      postStatus(id, 'Generating audio')
      const audio = await tts.generate(text, { voice, speed })
      const audioBuffer = await audio.toBlob().arrayBuffer()

      workerScope.postMessage({ id, type: 'audio', audioBuffer }, [audioBuffer])
    } catch (error) {
      workerScope.postMessage({
        id,
        type: 'error',
        message: error instanceof Error ? error.message : 'Local AI voice failed',
      })
    }
  })()
})
