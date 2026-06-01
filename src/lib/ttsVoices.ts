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

const KOKORO_VOICE_IDS = new Set<string>(KOKORO_VOICES.map((voice) => voice.id))

export function isKokoroVoiceId(value: unknown): value is KokoroVoiceId {
  return typeof value === 'string' && KOKORO_VOICE_IDS.has(value)
}
