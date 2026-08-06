/**
 * Claude → the provider protocol. **The single place** Claude's shape becomes the wire format.
 *
 * Two callers, one mapper:
 *   - the LIVE path, reading `--output-format stream-json` off the spawned process's stdout, and
 *   - the HISTORY path, reading Claude's own `.jsonl` transcripts.
 *
 * Both carry the same Anthropic message shape (content blocks). Writing two parsers is the reliable
 * way to make the live view and the post-refresh view disagree, so there is exactly one here; only
 * the live path adds partial-token deltas on top.
 *
 * Event kinds and fields are defined by `../../spec/README.md` §8 and validated by
 * `../../spec/schema/event.json`. Note there is no envelope any more: an event is one flat,
 * self-describing object, and the SAME objects serve the live stream and `agent.history` —
 * which is precisely why there is one mapper and not two.
 */
import type { ProviderEvent } from './types.js'

/** An Anthropic content block as it appears in both stdout events and JSONL lines. */
export interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

export interface AnthropicMessage {
  role?: string
  content?: unknown
}

/**
 * Does this message BEGIN a turn?
 *
 * A real user prompt carries a `user_message` event. A `user`-role message carrying only tool results
 * does NOT — it is the middle of an assistant's turn, wearing the user role because that is how the
 * Anthropic format returns tool output. A history window snaps back to one of these so a page can
 * never start between a `tool_start` and its `tool_end`.
 */
export const isTurnStart = (events: ProviderEvent[]): boolean =>
  events.some((e) => e.kind === 'user_message')

/** Tool results arrive as a string or as an array of text blocks; normalise to one string. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type?: string; text?: string } => !!b && typeof b === 'object')
    .map((b) => b.text ?? '')
    .join('')
}

const MAX_OUTPUT = 2000

/** One line for the client's collapsed tool row. */
function summarise(tool: string, output: string, isError: boolean): string {
  if (isError) return `${tool} failed`
  const firstLine = output.split('\n').find((l) => l.trim()) ?? ''
  if (!firstLine) return `${tool} returned nothing`
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine
}

/**
 * Map one Anthropic message to events.
 *
 * Unknown block types are SKIPPED, never thrown on: Claude's internal format is not a contract we
 * control, and a new block type must degrade to "not rendered", not to a broken turn.
 */
export function messageToEvents(message: AnthropicMessage | undefined): ProviderEvent[] {
  const blocks = message?.content
  if (typeof blocks === 'string') {
    return blocks.trim() ? [{ kind: message?.role === 'user' ? 'user_message' : 'text_delta', text: blocks }] : []
  }
  if (!Array.isArray(blocks)) return []

  const events: ProviderEvent[] = []
  for (const raw of blocks) {
    const block = raw as ContentBlock
    switch (block.type) {
      case 'text':
        if (block.text?.trim()) {
          events.push({ kind: message?.role === 'user' ? 'user_message' : 'text_delta', text: block.text })
        }
        break

      case 'thinking':
        if (block.thinking?.trim()) {
          events.push({ kind: 'thinking_delta', text: block.thinking })
        }
        break

      case 'tool_use':
        events.push({
          kind: 'tool_start',
          toolId: block.id ?? '',
          tool: block.name ?? 'tool',
          input: block.input,
        })
        break

      case 'tool_result': {
        const output = toolResultText(block.content)
        const isError = block.is_error === true
        events.push({
          kind: 'tool_end',
          toolId: block.tool_use_id ?? '',
          // The tool NAME lives on the matching tool_use block, not here. Callers that have the
          // pairing fill it in; on its own the result only knows the id.
          tool: '',
          // `ok: false` is the failure signal. Note the inversion from Claude's `is_error`.
          ok: !isError,
          output: output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}…` : output,
          summary: summarise('tool', output, isError),
        })
        break
      }

      // 'image' and anything else: deliberately not rendered. See the doc comment.
      default:
        break
    }
  }
  return events
}

/**
 * Fill in tool names on `tool_end` events by pairing them with earlier `tool_start` events.
 *
 * Necessary because a `tool_result` block carries only `tool_use_id`. Run this over a whole
 * transcript, or over the accumulated events of a live turn.
 */
export function pairToolNames(events: ProviderEvent[]): ProviderEvent[] {
  const names = new Map<string, string>()
  for (const e of events) {
    if (e.kind === 'tool_start' && e.toolId) names.set(e.toolId, e.tool ?? 'tool')
  }
  return events.map((e) => {
    if (e.kind !== 'tool_end') return e
    const tool = names.get(e.toolId ?? '')
    if (!tool) return e
    return { ...e, tool, summary: summarise(tool, e.output ?? '', e.ok === false) }
  })
}

// ── The live path: `--output-format stream-json` ─────────────────────────────────────────────────

/** One line of Claude's stdout. Only the fields this provider reads. */
export interface StreamLine {
  type?: string
  subtype?: string
  session_id?: string
  message?: AnthropicMessage
  event?: {
    type?: string
    content_block?: ContentBlock
    delta?: { type?: string; text?: string; thinking?: string }
  }
  is_error?: boolean
  result?: string
}

export type StreamOutcome =
  | { kind: 'events'; events: ProviderEvent[] }
  | { kind: 'done'; failed: boolean; detail?: string }
  | { kind: 'ignore' }

/**
 * The Claude session id, for `--resume` on the next turn.
 *
 * Deliberately SEPARATE from `streamLineToOutcome`: **nearly every line carries `session_id`**, so
 * folding this into the mapper as an early return silently swallows every event. (It did, until a
 * recorded real turn caught it — a hand-written fixture would not have carried the field.)
 */
export function sessionIdOf(line: StreamLine): string | undefined {
  return typeof line.session_id === 'string' && line.session_id ? line.session_id : undefined
}

/**
 * Map one stdout line.
 *
 * `--include-partial-messages` means text and thinking arrive twice: once as deltas, and again in
 * the complete `assistant` message. This emits the DELTAS for smooth streaming and takes only
 * `tool_use` from the complete message — otherwise every sentence renders twice.
 */
export function streamLineToOutcome(line: StreamLine): StreamOutcome {
  switch (line.type) {
    case 'stream_event': {
      const event = line.event
      if (event?.type === 'content_block_delta') {
        const delta = event.delta
        if (delta?.type === 'text_delta' && delta.text) {
          return { kind: 'events', events: [{ kind: 'text_delta', text: delta.text }] }
        }
        if (delta?.type === 'thinking_delta' && delta.thinking) {
          return { kind: 'events', events: [{ kind: 'thinking_delta', text: delta.thinking }] }
        }
        return { kind: 'ignore' }
      }
      // NOTE: `content_block_start` also announces tool_use, but its `input` is still empty at that
      // point (arguments stream in as input_json_delta). Taking it here AND from the complete
      // `assistant` message renders every tool twice — a recorded turn showed 2 tool_start against
      // 1 tool_end. The complete message is the single source for tools.
      return { kind: 'ignore' }
    }

    case 'assistant': {
      // Deltas already covered text and thinking; take only the tool calls.
      const blocks = Array.isArray(line.message?.content) ? (line.message?.content as ContentBlock[]) : []
      const tools = blocks.filter((b) => b.type === 'tool_use')
      return tools.length ? { kind: 'events', events: messageToEvents({ role: 'assistant', content: tools }) } : { kind: 'ignore' }
    }

    case 'user': {
      const blocks = Array.isArray(line.message?.content) ? (line.message?.content as ContentBlock[]) : []
      const results = blocks.filter((b) => b.type === 'tool_result')
      return results.length ? { kind: 'events', events: messageToEvents({ role: 'user', content: results }) } : { kind: 'ignore' }
    }

    case 'result':
      return { kind: 'done', failed: line.is_error === true || line.subtype === 'error', detail: line.result }

    case 'error':
      return { kind: 'done', failed: true, detail: line.result ?? 'claude reported an error' }

    default:
      return { kind: 'ignore' }
  }
}
