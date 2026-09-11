import { env } from '../config/env.js'
import { transcribe as deepgramTranscribe } from './deepgram.js'
// Re-exported so the transport layer gates on the same list the provider enforces, without
// importing a provider module directly.
export { VOICE_LANGS, normalizeLang, type VoiceLang } from './deepgram.js'
import { transcribe as geminiTranscribe } from './gemini.js'

// Speech-to-text provider dispatch. The device sends raw linear16/mono PCM (8 or 16 kHz — it records
// at 8 kHz to halve the upload over its flaky WiFi); the concrete provider is selected by
// VOICE_PROVIDER so the voice endpoint stays provider-agnostic.

/** Hard cap on one utterance's PCM — ~10 min @ 16k or ~20 min @ 8k (the device records at 8k, so this
 *  covers a long Overview ramble). Callers buffer up to this and drop the rest rather than growing
 *  unbounded on a device that never sends its end frame. */
export const MAX_PCM = 20 * 1024 * 1024

/** Transcribe raw linear16/mono PCM at `sampleRate` Hz in `lang` (see VOICE_LANGS) using the configured
 * provider. Gemini auto-detects, so it ignores `lang`; Deepgram pins to it. */
export async function transcribe(pcm: Buffer, sampleRate = 16000, lang = 'en'): Promise<string> {
  switch (env.VOICE_PROVIDER) {
    case 'gemini':
      return geminiTranscribe(pcm, sampleRate)
    case 'deepgram':
    default:
      return deepgramTranscribe(pcm, sampleRate, lang)
  }
}
