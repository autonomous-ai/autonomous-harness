import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

// Gemini batch STT for the device voice endpoint. The device streams raw linear16/16k/mono PCM;
// Gemini's inline audio wants a container, so we prepend a 44-byte WAV header and send audio/wav.

const CHANNELS = 1
const BITS = 16

// Minimal canonical WAV (PCM) header for the given data length at `sampleRate` Hz.
function wavHeader(dataLen: number, sampleRate: number): Buffer {
  const byteRate = (sampleRate * CHANNELS * BITS) / 8
  const blockAlign = (CHANNELS * BITS) / 8
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataLen, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16) // fmt chunk size
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(CHANNELS, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(byteRate, 28)
  h.writeUInt16LE(blockAlign, 32)
  h.writeUInt16LE(BITS, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataLen, 40)
  return h
}

// Instruction goes in systemInstruction (not the user turn) so the model treats it as a rule,
// not content to reason about — this keeps thinking-capable models from echoing deliberation.
const SYSTEM =
  'You transcribe audio to plain text. Output ONLY the exact words spoken, as a single line of ' +
  'plain text. Absolutely do NOT add timestamps, time codes, "-->" ranges, SRT or WebVTT/caption ' +
  'formatting, speaker names, brackets, or notes. Do NOT apologize, refuse, or explain — even if ' +
  'the audio is short, noisy, or unclear, just write the words you hear. If you truly hear no ' +
  'words at all, output nothing (an empty response).'

// Belt-and-suspenders: strip caption artifacts the model sometimes emits despite the instruction
// (SRT/VTT timestamps, cue numbers, the WEBVTT header) so they never reach the agent as a turn.
function cleanTranscript(raw: string): string {
  return raw
    .replace(/^﻿?WEBVTT.*$/gim, '')
    // "00:00:00,000 --> 00:00:01,000" (also ':' or '.' as the ms separator)
    .replace(/\d{1,2}:\d{2}:\d{2}[.,:]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,:]\d{1,3}.*$/gim, '')
    .replace(/^\s*\d+\s*$/gm, '') // lone SRT cue numbers
    .replace(/\s+/g, ' ')
    .trim()
}

/** Transcribe raw linear16/mono PCM at `sampleRate` Hz via Gemini. Returns the transcript ('' if none). */
export async function transcribe(pcm: Buffer, sampleRate = 16000): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set')
  const wav = Buffer.concat([wavHeader(pcm.length, sampleRate), pcm])
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_STT_MODEL}:generateContent` +
    `?key=${env.GEMINI_API_KEY}`

  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [
      {
        parts: [
          { text: 'Transcribe:' },
          { inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } },
        ],
      },
    ],
    // thinkingBudget 0 disables 2.5 "thinking" — STT needs none, and it keeps latency low and
    // stops the model from deliberating/refusing instead of just transcribing.
    generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
  })

  // Retry transient overload (503/UNAVAILABLE, 429) with backoff — flash-lite spikes are common.
  let res!: Response
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
    if (res.ok || (res.status !== 503 && res.status !== 429)) break
    const backoff = 400 * 2 ** attempt // 400, 800, 1600 ms
    logger.warn('gemini transient error — retrying', { status: res.status, attempt, backoff })
    await new Promise((r) => setTimeout(r, backoff))
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
  }
  const rawText = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought) // drop reasoning parts from thinking models
    .map((p) => p.text ?? '')
    .join('')
  const transcript = cleanTranscript(rawText)
  logger.info('gemini transcript', { chars: transcript.length, model: env.GEMINI_STT_MODEL })
  return transcript
}
