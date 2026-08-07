/**
 * Amp history, read from AMP's OWN store rather than from ours.
 *
 * The live stream is fed by the adapter's plugin, which writes a JSONL transcript because Amp keeps no
 * conversation on disk. That file is a good enough record of what the plugin SAW — and a bad answer for
 * history, which is what this module exists to fix. It only ever contains turns that happened while a
 * current plugin was loaded: a thread that ran before the integration existed, or in a pane whose plugin
 * predates a fix, is missing from it forever, and nothing local can rebuild those turns.
 *
 * Amp does persist them, on its server, and hands them back complete: `amp threads export <threadId>`
 * returns every message with its content blocks, including the tools Amp runs server-side that no client
 * event ever reports. That is the authoritative history, so that is what `session_get` serves.
 *
 * The cost is a network round trip of roughly 1.5s per request, which history can afford and a live
 * stream cannot — hence the split: Amp's store for the past, the plugin's JSONL for the present.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { env } from '../../config/env.js'
import type { SessionEvent } from '../../lib/normalize.js'
import { ampToolInput, ampToolName, ampToolOutput, clip } from './normalizer.js'

const execFileAsync = promisify(execFile)

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500
/** One thread of a long session is comfortably inside this; the default 1MB is not. */
const MAX_BUFFER = 32 * 1024 * 1024
const EXPORT_TIMEOUT_MS = 20_000
/** `T-019fda29-9c6c-750e-acf0-47d06e200759` — checked before it ever reaches argv. */
const THREAD_ID_RE = /^T-[0-9a-fA-F-]{8,64}$/

function obj(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The messages Amp holds for one thread, or null when they cannot be fetched.
 *
 * Null is a real answer and callers must handle it: the export is a network call and Amp's client gives
 * up on its own after ~30s (see `runAmpOneShot`, where the same flakiness forced a retry).
 */
export async function readAmpThread(threadId: string): Promise<JsonObject[] | null> {
  // The id reaches here from a REGISTERED session, but it still goes on a command line — so it is
  // validated by shape rather than trusted, the same rule `validTranscriptPath` applies to paths.
  if (!THREAD_ID_RE.test(threadId)) return null
  let stdout: string
  try {
    ({ stdout } = await execFileAsync(env.AMP_PATH || 'amp', ['threads', 'export', threadId], {
      maxBuffer: MAX_BUFFER,
      timeout: EXPORT_TIMEOUT_MS,
      env: { ...process.env, AMP_DISABLE_PLUGINS: '1' },
    }))
  } catch (err) {
    console.warn(`[amp] threads export failed for ${threadId.slice(0, 12)}: ${err instanceof Error ? err.message : err}`)
    return null
  }
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { return null }
  const messages = obj(parsed)?.messages
  return Array.isArray(messages) ? messages.map((m) => obj(m)).filter((m): m is JsonObject => m !== null) : null
}

/** A tool result's payload. Amp's export nests it one level deeper than the live event does. */
function exportedToolOutput(block: JsonObject): string {
  const run = obj(block.run)
  // `{run:{result:…}}` in the export; `{output:…}`/`{content:[…]}` bare on the live path.
  return ampToolOutput(run && 'result' in run ? run.result : (block.run ?? block.content ?? block.output))
}

/**
 * One exported thread → the same event vocabulary the live stream produces.
 *
 * Block shapes are measured, not assumed: user text is `{type:'text',text}`, assistant reasoning is
 * `{type:'thinking',thinking}` (note the field name differs from `text`), a call is
 * `{type:'tool_use',id,name,input}` and its result is `{type:'tool_result',toolUseID,run}` — the pairing
 * key is `toolUseID`, camelCase, and NOT the `tool_use_id` other engines use.
 */
export function ampThreadToEvents(messages: JsonObject[]): SessionEvent[] {
  const events: SessionEvent[] = []
  const toolNames = new Map<string, string>()
  let thinkingCounter = 0

  for (const message of messages) {
    const role = str(message.role)
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const raw of blocks) {
      const block = obj(raw)
      if (!block) continue
      const type = str(block.type)
      if (type === 'text') {
        const text = str(block.text)
        if (!text) continue
        events.push(role === 'user'
          ? { type: 'user_message', payload: { content: text } }
          : { type: 'text_delta', payload: { content: text } })
      } else if (type === 'thinking') {
        // Reasoning is often withheld — an OpenAI-backed turn exports `thinking: ""` with only an opaque
        // id. Emitting an empty bubble would be worse than emitting nothing.
        const text = str(block.thinking).trim()
        if (!text) continue
        events.push({
          type: 'thinking_delta',
          payload: { content: clip(text, MAX_THINKING), thinkingId: `thinking-amp-${thinkingCounter++}` },
        })
      } else if (type === 'tool_use') {
        const id = str(block.id)
        if (!id) continue
        const tool = ampToolName(str(block.name))
        toolNames.set(id, tool)
        events.push({ type: 'tool_start', payload: { id, tool, input: ampToolInput(tool, block.input) } })
      } else if (type === 'tool_result') {
        const id = str(block.toolUseID) || str(block.tool_use_id)
        if (!id) continue
        const tool = toolNames.get(id) ?? 'Tool'
        toolNames.delete(id)
        const output = exportedToolOutput(block)
        const isError = obj(block.run)?.status === 'error'
        events.push({
          type: 'tool_end',
          payload: { id, tool, output: clip(output, MAX_OUTPUT), isError, summary: isError ? 'error' : '' },
        })
      }
    }
  }
  events.push({ type: 'done', payload: { result: 'success' } })
  return events
}
