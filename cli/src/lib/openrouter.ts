/**
 * One direct OpenRouter call, for the daemon's OWN small LLM jobs (turn recap, voice routing) on agents
 * that run through the gateway.
 *
 * Every other engine path in this file's neighbourhood spawns the user's vendor CLI, which works because
 * that CLI is logged in. A `ori claude` user may have no Anthropic account at all — their credential is
 * an OpenRouter key — so the vendor one-shot has nothing to spend and the recap silently never arrives.
 * Both jobs are a couple of hundred tokens of text condensation, so the answer is not "spawn a different
 * agent" but "make the request ourselves": no process, no pool slot, no vendor login, one HTTPS call.
 *
 * The key never leaves this module except in an Authorization header to openrouter.ai, and is redacted
 * from every message this module can produce.
 */

import { readFile } from 'node:fs/promises'
import { env } from '../config/env.js'
import type { GatewayRuntime } from './gatewayRuntime.js'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
/**
 * Matches the vendor one-shot's 60s (`oneshot.ts`), and for the same reason: this call REPLACES that
 * one, so a recap must not become less reliable by being routed through a gateway.
 *
 * It was 20s until a live run proved that wrong. OpenRouter spreads one model id across providers, and
 * the same `deepseek/deepseek-v4-flash` request measured 1.6s, 8.4s and >20s within ten minutes — the
 * 20s attempt aborted a recap that had already been paid for. A recap is asynchronous (the card arrives
 * when it arrives), so waiting is cheap and giving up early is not. Callers on a real deadline pass
 * their own: the voice router uses 12s, under the backend's 15s RPC budget.
 */
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_TOKENS = 512

/** `ori login` writes { createdAt, key: 'sk-or-…', userId }. */
interface OriCredentials {
  key?: unknown
}

/** Strip anything that looks like a key from text that may be logged. */
export function redactKeys(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
}

/**
 * Read `ori login`'s credentials, every time.
 *
 * This used to cache the parsed key and re-read only when `mtimeMs` changed. That is safe on APFS,
 * whose mtime has nanosecond resolution — 8 rapid rewrites produce 8 distinct stamps — and unsafe
 * everywhere else: the same probe on overlayfs yields 4 distinct stamps out of 8, and on tmpfs exactly
 * 1. So on Linux a key rotation written within the filesystem's timestamp granularity was invisible,
 * and the daemon went on spending a revoked key until something else touched the file. There is nothing
 * to trade away by dropping the cache: both callers follow this with an HTTPS request whose timeout is
 * 60 SECONDS, so re-reading a ~100-byte file costs nothing measurable.
 */
async function keyFromCredentialsFile(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(env.ORI_CREDENTIALS_PATH, 'utf8')) as OriCredentials
    return typeof parsed.key === 'string' && parsed.key.trim() ? parsed.key.trim() : null
  } catch {
    // Absent, unreadable or corrupt is a normal state (no ori installed) — not an error worth logging.
    return null
  }
}

/**
 * First hit wins: the daemon's own env, then the key the AGENT's process was given, then `ori login`'s
 * file. The middle one matters most — it is per-agent, so a machine mixing gateway and vendor agents
 * bills each recap to whatever that agent already runs on.
 */
export async function resolveOpenRouterKey(gateway?: GatewayRuntime): Promise<string | null> {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const fromProcess = gateway?.apiKey?.trim()
  if (fromProcess) return fromProcess
  return keyFromCredentialsFile()
}

export interface OpenRouterCompletionOptions {
  prompt: string
  model: string
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
  maxTokens?: number
  temperature?: number
}

/**
 * The completion text, or null when the call could not produce one.
 *
 * Null rather than throw: both callers already degrade gracefully (the recap logs and skips the card, the
 * router falls back to name matching), and a gateway hiccup must never fail the turn or the RPC. An
 * abort from the CALLER is re-thrown, so a superseded recap stays superseded.
 */
export async function openRouterComplete(options: OpenRouterCompletionOptions): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const onCallerAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter attributes usage in the user's activity export by these two.
        'HTTP-Referer': 'https://harness.autonomous.ai',
        'X-Title': 'Harness',
      },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: options.prompt }],
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options.temperature ?? 0,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = redactKeys((await res.text().catch(() => '')).slice(0, 300))
      if (res.status === 402) console.warn('[openrouter] out of credits — top up at https://openrouter.ai/settings/credits')
      else console.warn(`[openrouter] ${options.model} failed with HTTP ${res.status}${body ? `: ${body}` : ''}`)
      return null
    }

    const payload = await res.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = payload.choices?.[0]?.message?.content
    const text = typeof content === 'string' ? content.trim() : ''
    return text || null
  } catch (err) {
    if (options.signal?.aborted) throw err   // the caller cancelled: don't paper over it
    console.warn(`[openrouter] ${options.model} call failed: ${redactKeys(err instanceof Error ? err.message : String(err))}`)
    return null
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCallerAbort)
  }
}
