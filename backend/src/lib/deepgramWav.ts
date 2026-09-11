// Transcribing a WAV upload with Deepgram — the one path every voice surface shares.
//
// Lifted out of routes/cursor.ts so the dial's own endpoint (routes/voice.ts) cannot end up with a second
// copy of a decision that was MEASURED rather than chosen. The model-per-language map below cost a real
// afternoon to establish; two copies of it is how one of them silently stops matching.
import { env } from '../config/env.js'

/**
 * A TWIN of VOICE_LANGS in lib/deepgram.ts, copied rather than imported.
 *
 * That module opens a network connection and owns the device's voice path; importing it here would put
 * this file's blast radius back onto the path it was written to stay clear of. Six short strings are a
 * cheaper price than that coupling — but they ARE a twin, so a language added there belongs here too.
 */
export const VOICE_WAV_LANGS = new Set(['en', 'vi', 'es', 'fr', 'ja', 'it'])

/** The language the audio is in, or `en` when the caller named one this path does not serve. */
export function pickWavLang(raw: unknown): string {
  const lang = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return VOICE_WAV_LANGS.has(lang) ? lang : 'en'
}

/**
 * Deepgram, called directly rather than through lib/deepgram.ts, because that module's `transcribe()`
 * declares `encoding=linear16&sample_rate=…&channels=1` — a headerless PCM stream, which is exactly what
 * a WAV is not. A WAV opens with a 44-byte RIFF header and states its own rate; declaring those params
 * would feed the header in as audio and pin the wrong sample rate.
 *
 * So the query carries no encoding hints at all and the file goes up under its real Content-Type. Deepgram
 * reads the container and honours whatever rate and channel count the app actually recorded at.
 */
export async function transcribeWavWithDeepgram(audio: Buffer, contentType: string, lang: string): Promise<string> {
  if (!env.DEEPGRAM_API_KEY) throw new Error('DEEPGRAM_API_KEY not set')
  // Model per language, and this is measured, not assumed. On a real 5s Vietnamese WAV, nova-3 with
  // `language=vi` returns an EMPTY transcript — no error, confidence 0.0, correct duration in the
  // metadata, just nothing. nova-2 transcribes the same file almost perfectly. nova-3 does handle `en`
  // (verified on an English WAV), so it stays for English, where it is the better model.
  // `language=multi` on nova-3 was also tried and came back as garbled cross-script noise.
  const model = lang === 'vi' ? 'nova-2' : 'nova-3'
  const url = `https://api.deepgram.com/v1/listen?model=${model}&language=${lang}&punctuate=true&smart_format=false`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'Content-Type': contentType },
    body: new Uint8Array(audio),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Deepgram HTTP ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }> }> }
  }
  const alt = data.results?.channels?.[0]?.alternatives?.[0]
  return (alt?.transcript ?? '').trim()
}
