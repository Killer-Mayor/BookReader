import { NextResponse } from 'next/server'
import { KOKORO_MODEL_ID, isKokoroVoiceId } from '../../../../lib/ttsVoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type KokoroModule = typeof import('kokoro-js')
type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>

let ttsPromise: Promise<KokoroInstance> | null = null

async function getKokoro() {
  if (!ttsPromise) {
    ttsPromise = import('kokoro-js').then(({ KokoroTTS }) =>
      KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: 'q8',
        device: 'cpu',
      }),
    )
  }

  return ttsPromise
}

function clampSpeed(value: unknown) {
  const speed = Number(value)

  if (!Number.isFinite(speed)) return 1

  return Math.max(0.6, Math.min(speed, 1.8))
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      speed?: unknown
      text?: unknown
      voice?: unknown
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''

    if (!text) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 })
    }

    if (!isKokoroVoiceId(body.voice)) {
      return NextResponse.json({ error: 'Unsupported voice' }, { status: 400 })
    }

    const tts = await getKokoro()
    const audio = await tts.generate(text.slice(0, 1200), {
      voice: body.voice,
      speed: clampSpeed(body.speed),
    })
    const wav = audio.toWav()

    return new Response(wav, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'audio/wav',
      },
    })
  } catch (error) {
    console.error('[AudioReader] Local TTS failed', error)
    return NextResponse.json({ error: 'Local TTS failed' }, { status: 500 })
  }
}
