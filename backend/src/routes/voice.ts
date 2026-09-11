/**
 * Transcription for the cabled dial.
 *
 *   POST /api/voice/stt?lang=vi    multipart, one part `file` (WAV) → { transcript, lang }
 *
 * ONE difference from routes/cursor.ts's endpoint, and it is the whole reason this file exists: this one
 * is authenticated by the caller's **SSO access token**, not by a shared secret. The `harness` CLI signs
 * in (`harness login`) and holds a real bearer token that refreshes itself; the dial holds no credential
 * at all and never talks to this service — it hands its audio down a USB cable to the daemon, and the
 * daemon is the one with an account.
 *
 * That matters beyond tidiness. The CLI ships from a PUBLIC repository, so a shared secret baked into it
 * is a secret nobody has. A bearer token is issued per person, expires, and can be revoked.
 *
 * NOT in the auth middleware's skip-list, deliberately: being absent from that list is what applies the
 * SSO gate, so `req.user` is populated here and an unauthenticated request never reaches this handler.
 */
import type { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'

import { VOICE_WAV_LANGS, transcribeWavWithDeepgram } from '../lib/deepgramWav.js'
import { sendError, sendSuccess } from '../utils/response.js'
import { logger } from '../utils/logger.js'

export const VOICE_STT_PATH = '/api/voice/stt'

/** ~25 MB — far above any dictation clip this serves, while still bounding one request's buffer. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/** The language the dial stated. Unknown values fall back rather than failing: a transcript in the wrong
 *  language is recoverable by the person; a 400 in the middle of a spoken turn is not. */
function pickLang(value: unknown): string {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return VOICE_WAV_LANGS.has(v) ? v : 'en'
}

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  // Registered inside this plugin's scope, not in server.ts: multipart parsing exists for this route and
  // nothing else, so no other endpoint's body handling changes by adding it.
  await app.register(multipart, { limits: { fileSize: MAX_AUDIO_BYTES, files: 1 } })

  app.post(VOICE_STT_PATH, async (req, reply) => {
    let file
    try {
      file = await req.file()
    } catch {
      sendError(reply, 'Expected a multipart/form-data upload', 'BAD_REQUEST', 400)
      return
    }
    if (!file) {
      sendError(reply, 'Missing audio file', 'BAD_REQUEST', 400)
      return
    }

    const audio = await file.toBuffer()
    if (audio.length === 0) {
      sendError(reply, 'Empty audio file', 'BAD_REQUEST', 400)
      return
    }

    const lang = pickLang((req.query as { lang?: unknown } | undefined)?.lang)
    try {
      const transcript = await transcribeWavWithDeepgram(audio, file.mimetype || 'audio/wav', lang)
      // The user is logged, the words are not. A transcript is the most private thing this service sees,
      // and the useful diagnostics — did it arrive, how big, what language, did it come back empty — do
      // not require keeping it.
      logger.info('voice-stt', {
        user: req.user?.sub,
        bytes: audio.length,
        lang,
        chars: transcript.length,
      })
      sendSuccess(reply, { transcript, lang })
    } catch (err) {
      logger.error('voice-stt failed', {
        user: req.user?.sub,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(reply, 'Transcription failed', 'STT_FAILED', 502)
    }
  })
}
