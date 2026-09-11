import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

// Deepgram pre-recorded (batch) STT. We buffer the device's streamed PCM and send it as one
// request here. Audio is raw linear16 (16-bit LE) mono at 16 kHz — declared via query params.
// - nova-3: latest model. Every language below is on its supported list, so one model covers them all.
// - language: pinned to the speaker's language (chosen in the device Settings, sent per utterance) —
//   pinning is more accurate on short clips than auto-detect.
// - smart_format=false: keep it verbatim — smart_format rewrites numbers/dates and would mangle
//   spoken commands; we still punctuate for readability.
// Unlike Gemini, this is a dedicated ASR: it returns an empty transcript on silence instead of
// hallucinating a sentence.
// The languages the device's Settings > Voice picker offers, and the ONE place that list lives —
// `stt.ts` re-exports it and `deviceWs.ts` gates the inbound `voice_start` on it, so a language can
// never be offered on the device but silently rewritten here. Adding one is this line plus the
// firmware's LANGS table.
//
// An unrecognised code is coerced rather than passed through: Deepgram answers an unsupported
// `language` with a 400, which would lose the whole utterance instead of transcribing it imperfectly.
export const VOICE_LANGS = ['en', 'vi', 'es', 'fr', 'ja', 'it'] as const
export type VoiceLang = (typeof VOICE_LANGS)[number]
const ALLOWED_LANGS = new Set<string>(VOICE_LANGS)
/** Coerce anything to a supported code. Unknown/absent → 'en', matching the device's factory default. */
export function normalizeLang(lang: unknown): VoiceLang {
  return typeof lang === 'string' && ALLOWED_LANGS.has(lang) ? (lang as VoiceLang) : 'en'
}
const dgUrl = (sampleRate: number, lang: string) =>
  `https://api.deepgram.com/v1/listen?model=nova-3&language=${lang}&punctuate=true&smart_format=false&encoding=linear16&sample_rate=${sampleRate}&channels=1`

/** Transcribe raw linear16/mono PCM at `sampleRate` Hz in `lang` (see VOICE_LANGS). Returns '' if empty. */
export async function transcribe(pcm: Buffer, sampleRate = 16000, lang = 'en'): Promise<string> {
  if (!env.DEEPGRAM_API_KEY) throw new Error('DEEPGRAM_API_KEY not set')
  const language = normalizeLang(lang)
  const res = await fetch(dgUrl(sampleRate, language), {
    method: 'POST',
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/octet-stream',
    },
    body: pcm,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Deepgram HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    results?: {
      channels?: Array<{
        detected_language?: string
        language_confidence?: number
        alternatives?: Array<{ transcript?: string; confidence?: number }>
      }>
    }
  }
  const channel = data.results?.channels?.[0]
  const alt = channel?.alternatives?.[0]
  const transcript = (alt?.transcript ?? '').trim()
  logger.info('deepgram transcript', {
    chars: transcript.length,
    lang: channel?.detected_language,
    langConf: channel?.language_confidence,
    conf: alt?.confidence,
  })
  return transcript
}
