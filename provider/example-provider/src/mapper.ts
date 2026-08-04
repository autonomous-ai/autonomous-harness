/**
 * Claude → A2A. **The single place** Claude's shape becomes the wire format.
 *
 * Two callers, one mapper:
 *   - the LIVE path, reading `--output-format stream-json` off the spawned process's stdout, and
 *   - the HISTORY path, reading Claude's own `.jsonl` transcripts.
 *
 * Both carry the same Anthropic message shape (content blocks). Writing two parsers is the reliable
 * way to make the live view and the post-refresh view disagree, so there is exactly one here; only
 * the live path adds partial-token deltas on top.
 *
 * Metadata keys are defined by `../spec/README.md` §7 and validated by
 * `docs/specs/schema/part-metadata.json`.
 */
import type { Part, PartMetadata } from './types.js'

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

const meta = (kind: NonNullable<PartMetadata['autonomous.ai/kind']>, extra: PartMetadata = {}): PartMetadata => ({
  'autonomous.ai/kind': kind,
  ...extra,
})

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
 * Map one Anthropic message to Parts.
 *
 * Unknown block types are SKIPPED, never thrown on: Claude's internal format is not a contract we
 * control, and a new block type must degrade to "not rendered", not to a broken turn.
 */
export function messageToParts(message: AnthropicMessage | undefined): Part[] {
  const blocks = message?.content
  if (typeof blocks === 'string') {
    return blocks.trim() ? [{ text: blocks, metadata: meta(message?.role === 'user' ? 'user_message' : 'text_delta') }] : []
  }
  if (!Array.isArray(blocks)) return []

  const parts: Part[] = []
  for (const raw of blocks) {
    const block = raw as ContentBlock
    switch (block.type) {
      case 'text':
        if (block.text?.trim()) {
          parts.push({ text: block.text, metadata: meta(message?.role === 'user' ? 'user_message' : 'text_delta') })
        }
        break

      case 'thinking':
        if (block.thinking?.trim()) {
          parts.push({ text: block.thinking, metadata: meta('thinking_delta') })
        }
        break

      case 'tool_use':
        parts.push({
          text: '',
          metadata: meta('tool_start', {
            'autonomous.ai/toolCallId': block.id ?? '',
            'autonomous.ai/tool': block.name ?? 'tool',
            'autonomous.ai/toolInput': block.input,
          }),
        })
        break

      case 'tool_result': {
        const output = toolResultText(block.content)
        const isError = block.is_error === true
        parts.push({
          text: output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}…` : output,
          metadata: meta('tool_end', {
            'autonomous.ai/toolCallId': block.tool_use_id ?? '',
            // The tool NAME lives on the matching tool_use block, not here. Callers that have the
            // pairing fill it in; on its own the result only knows the id.
            'autonomous.ai/tool': '',
            'autonomous.ai/isError': isError,
            'autonomous.ai/summary': summarise('tool', output, isError),
          }),
        })
        break
      }

      // 'image' and anything else: deliberately not rendered. See the doc comment.
      default:
        break
    }
  }
  return parts
}

/**
 * Fill in tool names on `tool_end` parts by pairing them with earlier `tool_start` parts.
 *
 * Necessary because a `tool_result` block carries only `tool_use_id`. Run this over a whole
 * transcript, or over the accumulated parts of a live turn.
 */
export function pairToolNames(parts: Part[]): Part[] {
  const names = new Map<string, string>()
  for (const p of parts) {
    const m = p.metadata
    if (m?.['autonomous.ai/kind'] === 'tool_start' && m['autonomous.ai/toolCallId']) {
      names.set(m['autonomous.ai/toolCallId'], m['autonomous.ai/tool'] ?? 'tool')
    }
  }
  return parts.map((p) => {
    const m = p.metadata
    if (m?.['autonomous.ai/kind'] !== 'tool_end') return p
    const id = m['autonomous.ai/toolCallId'] ?? ''
    const tool = names.get(id)
    if (!tool) return p
    return {
      ...p,
      metadata: {
        ...m,
        'autonomous.ai/tool': tool,
        'autonomous.ai/summary': summarise(tool, p.text ?? '', m['autonomous.ai/isError'] === true),
      },
    }
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
  | { kind: 'parts'; parts: Part[] }
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
          return { kind: 'parts', parts: [{ text: delta.text, metadata: meta('text_delta') }] }
        }
        if (delta?.type === 'thinking_delta' && delta.thinking) {
          return { kind: 'parts', parts: [{ text: delta.thinking, metadata: meta('thinking_delta') }] }
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
      return tools.length ? { kind: 'parts', parts: messageToParts({ role: 'assistant', content: tools }) } : { kind: 'ignore' }
    }

    case 'user': {
      const blocks = Array.isArray(line.message?.content) ? (line.message?.content as ContentBlock[]) : []
      const results = blocks.filter((b) => b.type === 'tool_result')
      return results.length ? { kind: 'parts', parts: messageToParts({ role: 'user', content: results }) } : { kind: 'ignore' }
    }

    case 'result':
      return { kind: 'done', failed: line.is_error === true || line.subtype === 'error', detail: line.result }

    case 'error':
      return { kind: 'done', failed: true, detail: line.result ?? 'claude reported an error' }

    default:
      return { kind: 'ignore' }
  }
}
