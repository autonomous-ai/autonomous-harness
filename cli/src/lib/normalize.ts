/**
 * Claude-Code JSONL → web ServerEvent normalizer.
 *
 * Self-contained port of the hosted runtime’s replay normalizer
 * (`the hosted runtime`: transformCCMessageToSessionMessage,
 * sessionMessagesToEvents, stripContextSummary/stripSystemBlocks + tool-summary)
 * — this package has no dependency outside itself.
 *
 * Two entry points:
 *  - messagesToEvents(rawLines)      → full SessionEvent[] replay for `session_get`.
 *  - lineToEvents(rawLine, state)    → incremental events for live tailing, PLUS a derived
 *    turn lifecycle (turn_started / turn_ended) so a prompt typed directly in the terminal
 *    renders identically to one sent from the web (mirror-all).
 */

// ── Event shapes (match the server’s SessionEvent contract SessionEvent + live turn frames) ──────

export interface SubagentSummary {
  agentId?: string
  agentType?: string
  totalTokens?: number
  totalDurationMs?: number
  totalToolUseCount?: number
}

export type SessionEvent =
  | { type: 'user_message'; payload: { content: string; images?: Array<{ media_type: string; data: string }> } }
  | { type: 'thinking_delta'; payload: { content: string; thinkingId?: string } }
  | { type: 'thinking_title'; payload: { thinkingId?: string; title: string } }
  | { type: 'text_delta'; payload: { content: string } }
  | { type: 'tool_start'; payload: { id: string; tool: string; input: unknown; parentToolUseId?: string } }
  | { type: 'tool_end'; payload: { id: string; tool: string; output: string; isError: boolean; summary: string; parentToolUseId?: string; subagent?: SubagentSummary; durationSeconds?: number } }
  | { type: 'context_compact'; payload: { message: string; trigger?: string } }
  | { type: 'done'; payload: { result: string } }

/** Live-stream events: replay events + the derived turn lifecycle. */
export type LiveEvent =
  | SessionEvent
  | { type: 'turn_started'; payload: { userMessage: string } }
  | { type: 'turn_ended'; payload: { aborted?: true } }   // aborted = killed by an interrupt, no recap
  // An ASYNC sub-agent actually finished. `id` is the spawning tool_use id, so it pairs with the
  // `tool_start`/`tool_end` of the same sub-agent (see taskNotificationEvent).
  | { type: 'subagent_finished'; payload: { id: string; status: string; summary?: string } }

export interface LastTurnText {
  userMessage: string
  assistantText: string
}

interface RawContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image'
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | Array<{ type: string; text?: string }>
  is_error?: boolean
  source?: { type: string; media_type: string; data: string }
}

interface NormalizedMessage {
  type: 'user' | 'assistant'
  message?: { role: 'user' | 'assistant'; content: RawContentBlock[] }
  toolUseResult?: SubagentSummary & { status?: string; durationSeconds?: number }
  /** Raw Anthropic stop_reason from the assistant line (drives turn_ended). */
  stopReason?: string | null
}

const MAX_OUTPUT = 2000
const MAX_THINKING = 500
const MAX_DIFF_SIDE = 1500
const PREVIEW_LINES = 8

// ── Text cleanup (ported verbatim) ────────────────────────────────────────────────────────────────

/** Strip the compaction-injected context summary; null if the whole message was summary. */
export function stripContextSummary(text: string): string | null {
  const endMarker = '<!-- END CONTEXT SUMMARY -->'
  const idx = text.indexOf(endMarker)
  if (idx === -1) return text
  let remaining = text.slice(idx + endMarker.length)
  remaining = remaining.replace(/^\s*---\s*Now,?\s*continuing.*?:\s*/is, '')
  remaining = remaining.trim()
  return remaining || null
}

/** Strip system-injected blocks not meant for UI display. */
export function stripSystemBlocks(text: string): string {
  return text
    .replace(/<task-notification>[\s\S]*?<\/task-notification>\s*/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '')
    .replace(/<goal-context>[\s\S]*?<\/goal-context>\s*/g, '')
    .replace(/<dev-server-context>[\s\S]*?<\/dev-server-context>\s*/g, '')
    .replace(/<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>\s*/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>\s*/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>\s*/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>\s*/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>\s*/g, '')
    .replace(/Read the output file to retrieve the result:[^\n]*/g, '')
    .trim()
}

// Built-in CLI commands that only drive the local TUI and never dispatch an agent turn. Surfacing
// them as a user prompt would open a turn nothing ever closes (device tile stuck busy), so they stay
// invisible — same as before. Anything else (a custom `~/.claude/commands/*.md`, `/goal`, `/review`,
// a plugin skill) DOES run a turn and must be visible.
const LOCAL_ONLY_COMMANDS = new Set([
  'add-dir', 'agents', 'bug', 'clear', 'compact', 'config', 'context', 'copy', 'cost', 'desktop',
  'doctor', 'effort', 'exit', 'export', 'help', 'hooks', 'ide', 'login', 'logout', 'mcp', 'memory',
  'model', 'output-style', 'permissions', 'privacy-settings', 'quit', 'release-notes',
  'reload-plugins', 'resume', 'skills', 'statusline', 'status', 'terminal-setup', 'todos',
  'upgrade', 'vim',
])

/**
 * `<command-name>/goal</command-name>…<command-args>x</command-args>` → `/goal x`.
 *
 * Claude Code records a slash command ONLY as these tags (the expansion it actually sends to the
 * model is written as a separate `isMeta` line, which we suppress). `stripSystemBlocks` erases the
 * tags, so without this the whole line normalizes to "" → `realUserText` returns null → NO
 * `turn_started` is ever emitted for a command prompt. That broke the device's goal mode: the
 * injected `/goal <text>` ran fine in the terminal, but `SessionInputController` never saw the turn
 * open and reported "The agent did not accept the message" after its submit retries — and the recap
 * had no user message to lead with.
 */
function commandPromptText(text: string): string | null {
  const name = text.match(/<command-name>\s*([^<]*?)\s*<\/command-name>/)?.[1]
  if (!name) return null
  const bare = name.replace(/^\//, '').trim()
  if (!bare || LOCAL_ONLY_COMMANDS.has(bare.toLowerCase())) return null
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? ''
  return args ? `/${bare} ${args}` : `/${bare}`
}

/** Short title heuristic for a thinking block (first 3-8 words of the first line). */
function extractThinkingTitle(thinking: string): string | null {
  const trimmed = thinking.trim()
  if (!trimmed || trimmed.length < 10) return null
  const firstLine = trimmed.split('\n')[0].replace(/^[\s#*\->]+/, '').trim()
  if (!firstLine) return null
  const words = firstLine.split(/\s+/).slice(0, 8)
  if (words.length < 2) return null
  let title = words.join(' ').replace(/[.,:;!?]+$/, '')
  if (title.length > 60) title = title.slice(0, 57) + '...'
  return title
}

/** The short ⎿ label shown after a tool finishes (e.g. "Read 247 lines"). */
function computeToolSummary(toolName: string, rawOutput: string, isError: boolean): string {
  if (isError) return rawOutput.split('\n')[0]?.slice(0, 80) || 'Error'
  switch (toolName) {
    case 'Bash': {
      const match = rawOutput.match(/^Exit code (\d+)/)
      return match ? `Exit ${match[1]}` : 'Done'
    }
    case 'Read': {
      const lineCount = (rawOutput.match(/^\s*\d+→/gm) || []).length
      return lineCount > 0 ? `Read ${lineCount} lines` : 'Read'
    }
    case 'Write':
    case 'WriteFile':
      return rawOutput.includes('successfully') ? 'Written' : rawOutput.slice(0, 60)
    case 'Edit':
    case 'EditFile':
      return rawOutput.includes('successfully') ? 'Updated' : rawOutput.slice(0, 60)
    case 'Glob': {
      const count = rawOutput.trim() ? rawOutput.trim().split('\n').length : 0
      return `${count} file${count !== 1 ? 's' : ''}`
    }
    case 'Grep': {
      const count = rawOutput.trim() ? rawOutput.trim().split('\n').length : 0
      return `${count} match${count !== 1 ? 'es' : ''}`
    }
    case 'WebFetch':
    case 'WebSearch':
      return 'Fetched'
    case 'TodoRead':
    case 'TodoWrite':
      return 'Done'
    default:
      return rawOutput.split('\n')[0]?.slice(0, 80) || 'Done'
  }
}

// ── Raw JSONL line → normalized message (port of transformCCMessageToSessionMessage) ─────────────

function smartWriteInput(input: Record<string, unknown>): Record<string, unknown> {
  const raw = input.content as string
  const lines = raw.split('\n')
  const preview = lines.slice(0, PREVIEW_LINES).join('\n')
  return {
    ...input,
    content: undefined,
    content_stats: {
      lines: lines.length,
      chars: raw.length,
      preview: preview + (lines.length > PREVIEW_LINES ? '\n…' : ''),
    },
  }
}

function smartEditInput(input: Record<string, unknown>): Record<string, unknown> {
  const truncSide = (s: unknown): unknown => {
    if (typeof s !== 'string') return s
    if (s.length <= MAX_DIFF_SIDE) return s
    const half = Math.floor(MAX_DIFF_SIDE / 2)
    return s.slice(0, half) + '\n…\n' + s.slice(s.length - half)
  }
  return { ...input, old_string: truncSide(input.old_string), new_string: truncSide(input.new_string) }
}

function mapContentItem(item: unknown): RawContentBlock {
  const c = (item ?? {}) as Record<string, unknown> // a null content block must not throw on `.type`
  const type = (c.type || 'text') as RawContentBlock['type']

  if (type === 'image') {
    return { type: 'image', source: c.source as RawContentBlock['source'] }
  }

  let resultContent = c.content as RawContentBlock['content']
  if (type === 'tool_result' && typeof resultContent === 'string' && resultContent.length > MAX_OUTPUT) {
    resultContent = resultContent.slice(0, MAX_OUTPUT) + '\n…[truncated]'
  }

  let toolInput = c.input as Record<string, unknown> | undefined
  const toolName = c.name as string | undefined
  if (type === 'tool_use' && toolInput) {
    if ((toolName === 'Write' || toolName === 'WriteFile') && typeof toolInput.content === 'string' && toolInput.content.length > 500) {
      toolInput = smartWriteInput(toolInput)
    } else if (
      (toolName === 'Edit' || toolName === 'EditFile') &&
      (((toolInput.old_string as string)?.length ?? 0) > MAX_DIFF_SIDE || ((toolInput.new_string as string)?.length ?? 0) > MAX_DIFF_SIDE)
    ) {
      toolInput = smartEditInput(toolInput)
    }
  }

  return {
    type,
    text: c.text as string | undefined,
    thinking: c.thinking as string | undefined,
    id: c.id as string | undefined,
    name: toolName,
    input: toolInput,
    tool_use_id: c.tool_use_id as string | undefined,
    content: resultContent,
    is_error: c.is_error as boolean | undefined,
  }
}

/** Parse one raw JSONL entry into a normalized user/assistant message (null for other types). */
export function transformLine(rawMessage: Record<string, unknown>): NormalizedMessage | null {
  const type = rawMessage.type as string
  if (type !== 'user' && type !== 'assistant') return null

  const messageObj = rawMessage.message as Record<string, unknown> | undefined
  let messageContent: RawContentBlock[] | undefined

  if (messageObj) {
    const role = messageObj.role as string
    const content = messageObj.content
    if (role === 'user' || role === 'assistant') {
      if (typeof content === 'string') {
        messageContent = [{ type: 'text', text: content }]
      } else if (Array.isArray(content)) {
        messageContent = content.length > 0 ? content.map(mapContentItem) : [{ type: 'text', text: '' }]
      } else if (content === null || content === undefined) {
        messageContent = [{ type: 'text', text: '' }]
      }
    }
  } else if (type === 'user') {
    const directContent = rawMessage.content
    if (typeof directContent === 'string') {
      messageContent = [{ type: 'text', text: directContent }]
    } else if (Array.isArray(directContent)) {
      messageContent = directContent.map(mapContentItem)
    }
  }

  let toolUseResult: NormalizedMessage['toolUseResult']
  if (rawMessage.tool_use_result || rawMessage.toolUseResult) {
    const tr = (rawMessage.tool_use_result || rawMessage.toolUseResult) as Record<string, unknown>
    toolUseResult = {
      status: (tr.status || 'complete') as string,
      agentId: (tr.agentId ?? tr.agent_id) as string | undefined,
      agentType: (tr.agentType ?? tr.agent_type) as string | undefined,
      totalTokens: tr.totalTokens as number | undefined,
      totalDurationMs: tr.totalDurationMs as number | undefined,
      totalToolUseCount: tr.totalToolUseCount as number | undefined,
      // WebSearch carries its search time here (the CLI's "Did 1 search in Ns" line).
      durationSeconds: typeof tr.durationSeconds === 'number' ? tr.durationSeconds : undefined,
    }
  }

  const role = (messageObj?.role || (type === 'user' ? 'user' : 'assistant')) as 'user' | 'assistant'

  if (role === 'user' && messageContent) {
    for (const block of messageContent) {
      if (block.type !== 'text' || !block.text) continue
      // A typed slash command survives as `/name args`; everything else is stripped as before.
      block.text = commandPromptText(block.text) ?? stripSystemBlocks(block.text)
    }
  }

  if (messageContent === undefined) messageContent = [{ type: 'text', text: '' }]

  return {
    type: type as 'user' | 'assistant',
    message: { role, content: messageContent },
    toolUseResult,
    stopReason: (messageObj?.stop_reason as string | null | undefined) ?? null,
  }
}

// ── Shared per-message event emission ─────────────────────────────────────────────────────────────

// Auto-fix / platform prompts filtered from replay (sent by the platform, not the user).
const SYSTEM_PROMPT_PATTERNS = [
  'The dev server is running but the app has an error:',
  'Please fix this code issue. Check the page component, routing, and any compile errors.',
  '<!-- CONTEXT SUMMARY',
  'This session is being continued from a previous conversation',
  '<local-command-stdout>Compacted',
]

function isSystemPrompt(content: RawContentBlock[]): boolean {
  const text = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text!).join('')
  return SYSTEM_PROMPT_PATTERNS.some((p) => text.includes(p))
}

/** A REAL user prompt (not a tool_result echo, not a platform prompt). Returns the cleaned text or null. */
/**
 * An ESC interrupt (terminal, or a Stop from the web/device) is written to the transcript as a plain user
 * line — `type:'user'`, `userType:'external'`, no `isMeta`, no flag of ANY kind — so its text is the only
 * thing distinguishing it from something the user typed. Treating it as a prompt opened a brand-new turn at
 * the instant a turn was cancelled, and the device then counted seconds forever on a turn no assistant
 * would ever answer. Covers the `for tool use` variant too. A user who literally types this loses one turn
 * card; that is the cheaper failure.
 */
const INTERRUPT_MARKER = /^\[Request interrupted by user[^\]]*\]$/

/** The user-authored text of a line, before interrupt markers are judged. null = not a user prompt. */
function userTextRaw(msg: NormalizedMessage): string | null {
  if (msg.type !== 'user' || !msg.message) return null
  const content = msg.message.content
  if (isSystemPrompt(content)) return null
  if (content.some((c) => c.type === 'tool_result')) return null
  const parts: string[] = []
  for (const block of content) {
    if (block.type !== 'text' || !block.text) continue
    let cleaned = stripContextSummary(block.text)
    if (cleaned) cleaned = stripSystemBlocks(cleaned)
    if (cleaned && !cleaned.match(/^\[Image: original \d+x\d+/)) parts.push(cleaned)
  }
  const text = parts.join('\n')
  return text || null
}

/**
 * An async sub-agent's REAL completion. Claude's `Agent` tool returns in milliseconds with
 * "Async agent launched successfully." — that `tool_result` is a launch ack, not a result, and taking it
 * for one made the device tick a sub-agent off the moment it started. The actual finish arrives much
 * later as a `type:"user"` record the CLI injects into the parent transcript:
 *
 *   <task-notification><task-id>…</task-id><tool-use-id>toolu_018wkW…</tool-use-id>
 *   <output-file>…</output-file><status>completed</status><summary>Agent "…" finished…
 *
 * `stripSystemBlocks` erases the whole block, so it correctly starts no turn — but that also meant the
 * only signal a sub-agent had finished was being thrown away. Read it here, keyed by tool-use-id.
 *
 * Takes the RAW record, not a NormalizedMessage: `transformLine` already ran the strip (line ~304), so by
 * then the text block is empty and there is nothing left to parse.
 */
function taskNotificationEvent(raw: Record<string, unknown>): LiveEvent | null {
  if (raw.type !== 'user') return null
  const content = (raw.message as { content?: unknown } | undefined)?.content ?? raw.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((b) => (typeof b === 'string' ? b : (b as RawContentBlock)?.type === 'text' ? String((b as RawContentBlock).text ?? '') : ''))
      .join('\n')
  }
  if (!text.includes('<task-notification>')) return null
  const id = text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim()
  if (!id) return null
  const status = text.match(/<status>([^<]+)<\/status>/)?.[1]?.trim() || 'completed'
  const summary = text.match(/<summary>([\s\S]*?)(?:<\/summary>|$)/)?.[1]?.trim()
  return { type: 'subagent_finished', payload: { id, status, ...(summary ? { summary } : {}) } }
}

/** True for the synthetic line an interrupt leaves behind. It ends a turn; it never starts one. */
function isInterruptLine(msg: NormalizedMessage): boolean {
  const text = userTextRaw(msg)
  return text !== null && INTERRUPT_MARKER.test(text)
}

// Every caller of this asks "is this a prompt the user made?" — turn slicing for replay and the recap's
// user-message source as well as the live turn lifecycle — and an interrupt marker is not one of those.
function realUserText(msg: NormalizedMessage): string | null {
  const text = userTextRaw(msg)
  if (text === null || INTERRUPT_MARKER.test(text)) return null
  return text
}

/**
 * Extract the last real user prompt and the assistant text that followed it from
 * raw Claude JSONL. This is the recap source of truth: it matches replay parsing
 * rules, skips tool_result echoes / platform prompts / compact metadata, and only
 * summarizes assistant text blocks.
 */
export function lastTurnTextFromRawLines(rawLines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantParts: string[] = []

  for (const line of rawLines) {
    if (!line.trim()) continue
    let raw: Record<string, unknown>
    try { raw = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const compact = compactEventFromRaw(raw)
    if (compact !== undefined) continue

    const msg = transformLine(raw)
    if (!msg?.message) continue

    const userText = realUserText(msg)
    if (userText !== null) {
      userMessage = userText
      assistantParts = []
      continue
    }

    if (msg.type !== 'assistant') continue
    const text = msg.message.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('')
      .trim()
    if (text) assistantParts.push(text)
  }

  const assistantText = assistantParts.join('\n\n').trim()
  return assistantText ? { userMessage, assistantText } : null
}

/** Aggregates computed from a sub-agent's OWN transcript. Async/background agents never get totals
 *  in the launcher's toolUseResult (it only records `{isAsync, status:'async_launched', agentId}` at
 *  launch) — the real numbers live in `<session>/subagents/agent-<id>.jsonl`. totalTokens mirrors the
 *  CLI's definition: input + output + cache_read + cache_creation summed over assistant turns. */
export function subagentStatsFromRawLines(rawLines: string[]): { totalToolUseCount: number; totalDurationMs?: number; totalTokens?: number } {
  let toolCount = 0
  let tokens = 0
  let first: number | undefined
  let last: number | undefined
  for (const line of rawLines) {
    if (!line.trim()) continue
    let raw: Record<string, unknown>
    try { raw = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (!raw || typeof raw !== 'object') continue
    const ts = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN
    if (!Number.isNaN(ts)) { if (first === undefined) first = ts; last = ts }
    if (raw.type !== 'assistant') continue
    const msg = raw.message as { content?: unknown; usage?: Record<string, unknown> } | undefined
    if (!msg) continue
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) if ((b as { type?: string }).type === 'tool_use') toolCount++
    }
    const u = msg.usage
    if (u) {
      tokens += (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
        + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
    }
  }
  return {
    totalToolUseCount: toolCount,
    totalDurationMs: first !== undefined && last !== undefined && last > first ? last - first : undefined,
    totalTokens: tokens || undefined,
  }
}

/** Emit tool_end events for a user message's tool_result blocks. */
function toolResultEvents(msg: NormalizedMessage, toolIdToName: Map<string, string>): SessionEvent[] {
  const events: SessionEvent[] = []
  if (!msg.message) return events
  for (const block of msg.message.content) {
    if (block.type !== 'tool_result') continue
    const toolUseId = block.tool_use_id || ''
    const isError = block.is_error === true
    let rawOutput = ''
    if (typeof block.content === 'string') {
      rawOutput = block.content
    } else if (Array.isArray(block.content)) {
      rawOutput = block.content.filter((c) => c.type === 'text' && c.text).map((c) => c.text!).join('')
    }
    const toolName = toolIdToName.get(toolUseId) || ''
    const summary = computeToolSummary(toolName, rawOutput, isError)
    if (rawOutput.length > MAX_OUTPUT) rawOutput = rawOutput.slice(0, MAX_OUTPUT) + '\n…[truncated]'
    const agg = msg.toolUseResult
    const subagent = agg?.agentId
      ? { agentId: agg.agentId, agentType: agg.agentType, totalTokens: agg.totalTokens, totalDurationMs: agg.totalDurationMs, totalToolUseCount: agg.totalToolUseCount }
      : undefined
    events.push({
      type: 'tool_end',
      payload: {
        id: toolUseId, tool: toolName, output: rawOutput, isError, summary,
        ...(subagent ? { subagent } : {}),
        ...(typeof agg?.durationSeconds === 'number' ? { durationSeconds: agg.durationSeconds } : {}),
      },
    })
  }
  return events
}

/** Emit thinking/text/tool_start events for an assistant message's blocks. */
function assistantEvents(
  msg: NormalizedMessage,
  toolIdToName: Map<string, string>,
  thinkingIdPrefix: string,
  thinkingCounterStart = 0,
): SessionEvent[] {
  const events: SessionEvent[] = []
  if (!msg.message) return events
  let thinkingCounter = thinkingCounterStart
  for (const block of msg.message.content) {
    if (block.type === 'thinking' && block.thinking) {
      const thinkingId = `${thinkingIdPrefix}${thinkingCounter++}`
      const thinkingContent = block.thinking.length > MAX_THINKING
        ? block.thinking.slice(0, MAX_THINKING) + '\n…[truncated]'
        : block.thinking
      events.push({ type: 'thinking_delta', payload: { content: thinkingContent, thinkingId } })
      const title = extractThinkingTitle(block.thinking)
      if (title) events.push({ type: 'thinking_title', payload: { thinkingId, title } })
    } else if (block.type === 'text' && block.text) {
      events.push({ type: 'text_delta', payload: { content: block.text } })
    } else if (block.type === 'tool_use') {
      const toolId = block.id || ''
      const toolName = block.name || ''
      toolIdToName.set(toolId, toolName)
      let toolInput = block.input
      if (toolInput && typeof toolInput === 'object') {
        const inputCopy = { ...(toolInput as Record<string, unknown>) }
        for (const [key, val] of Object.entries(inputCopy)) {
          if (typeof val === 'string' && val.length > MAX_OUTPUT) {
            inputCopy[key] = val.slice(0, MAX_OUTPUT) + '\n…[truncated]'
          }
        }
        toolInput = inputCopy
      }
      events.push({ type: 'tool_start', payload: { id: toolId, tool: toolName, input: toolInput } })
    }
  }
  return events
}

// ── Compaction lines ────────────────────────────────────────────────────────────────────────────
//
// When a tmux claude session compacts (auto or `/compact`), it does an IN-FILE compact: the JSONL
// keeps the SAME sessionId and is append-only (pre-compact history stays on disk), so the byte-offset
// tail streams straight through — there is no dead file to re-point at and no truncation to re-read.
// The compact only injects a few bookkeeping lines we must handle so the stream stays clean:
//   • `system` / `subtype:"compact_boundary"` (+ `compactMetadata.trigger`) → one `context_compact`
//     indicator (purely a UI hint; the actual stream continuity is already guaranteed by the tail).
//   • the injected `isCompactSummary` user line (the big "This session is being continued…" summary)
//     and any `isMeta` bookkeeping line → suppressed via the AUTHORITATIVE flags (not a fragile
//     English-string match), so the summary is never rendered as a giant fake user turn / new turn.
//
// Returns the events to emit for a compact line (possibly `[]` to suppress it), or `undefined` when
// `raw` is not a compact line and should fall through to the normal user/assistant path.
export function compactEventFromRaw(raw: Record<string, unknown>): SessionEvent[] | undefined {
  if (raw.type === 'system' && raw.subtype === 'compact_boundary') {
    const meta = raw.compactMetadata as { trigger?: string } | undefined
    return [{
      type: 'context_compact',
      payload: {
        message: 'Context was compacted — the previous conversation has been summarized to free up space.',
        ...(meta?.trigger ? { trigger: meta.trigger } : {}),
      },
    }]
  }
  if (raw.isCompactSummary === true) return []
  if (raw.isMeta === true) {
    // NOT all isMeta user lines are bookkeeping. A `/loop` iteration is a REAL prompt that Claude
    // submits on the user's behalf every time the loop fires, and it is written as isMeta — so blanket
    // suppression made every iteration after the first invisible: no turn_started, therefore no recap,
    // therefore nothing on the device, while the loop kept running perfectly in the terminal.
    //
    // The discriminator is `promptSource`, which Claude sets authoritatively (same principle as the
    // flags above — never an English-string match):
    //   'typed'   + no isMeta → the human typed it
    //   'system'  + isMeta    → submitted programmatically: a loop iteration. This IS a turn.
    //   (absent)  + isMeta    → real bookkeeping: a compact summary, or a slash command's expansion
    //                           text. Still suppressed, so one `/goal` is not three user turns.
    if (raw.type === 'user' && raw.promptSource === 'system') return undefined
    return []
  }
  return undefined
}

// ── Full replay (session_get) ─────────────────────────────────────────────────────────────────────

/** Convert a whole session's raw JSONL lines to replay events (same render path as streaming). */
export function messagesToEvents(rawLines: string[]): SessionEvent[] {
  const events: SessionEvent[] = []
  const toolIdToName = new Map<string, string>()
  let thinkingCounter = 0
  let inAutoFixSequence = false

  for (const line of rawLines) {
    if (!line.trim()) continue
    let raw: Record<string, unknown>
    try { raw = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const compact = compactEventFromRaw(raw)
    if (compact) { events.push(...compact); continue } // compact boundary → indicator; summary/meta → suppressed
    const msg = transformLine(raw)
    if (!msg?.message) continue

    if (msg.type === 'user') {
      const content = msg.message.content
      if (isSystemPrompt(content)) { inAutoFixSequence = true; continue }
      const hasToolResult = content.some((c) => c.type === 'tool_result')
      const hasUserText = content.some((c) => c.type === 'text' && c.text?.trim())
      if (inAutoFixSequence && hasToolResult && !hasUserText) continue
      if (inAutoFixSequence) inAutoFixSequence = false

      if (!hasToolResult) {
        const textParts: string[] = []
        const images: Array<{ media_type: string; data: string }> = []
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            let cleaned = stripContextSummary(block.text)
            if (cleaned) cleaned = stripSystemBlocks(cleaned)
            if (cleaned && !cleaned.match(/^\[Image: original \d+x\d+/)) textParts.push(cleaned)
          } else if (block.type === 'image' && block.source) {
            images.push({ media_type: block.source.media_type, data: block.source.data })
          }
        }
        const textContent = textParts.join('\n')
        if (textContent || images.length > 0) {
          events.push({ type: 'user_message', payload: { content: textContent, ...(images.length > 0 ? { images } : {}) } })
        }
        continue
      }

      events.push(...toolResultEvents(msg, toolIdToName))
      continue
    }

    // assistant
    if (inAutoFixSequence) continue
    const before = events.length
    events.push(...assistantEvents(msg, toolIdToName, 'thinking-hist-', thinkingCounter))
    // keep the per-session thinking counter monotonic across messages
    thinkingCounter += events.slice(before).filter((e) => e.type === 'thinking_delta').length
  }

  events.push({ type: 'done', payload: { result: 'success' } })
  return events
}

/**
 * Turn-snapped pagination window over raw JSONL lines, for `session_get` with `{limit, before}`.
 * `before` = uuid of the oldest line the client already holds (exclusive upper bound). Returns the
 * line slice to feed `messagesToEvents` plus cursor metadata.
 *
 * The window START is snapped back to a real user-prompt line so a window never splits an assistant
 * turn's `tool_use` from its `tool_result`: `messagesToEvents` is stateful (`toolIdToName` carries a
 * tool_use id → name across lines so the later tool_result renders the tool name), so a mid-turn cut
 * would drop tool names. A user-prompt line never sits between a tool_use and its tool_result, so
 * snapping there keeps every turn whole.
 */
export function windowRawLines(
  rawLines: string[],
  opts: { limit: number; before?: string },
): { window: string[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  // Per-line uuid + whether the line is a real user-prompt turn start (parse each line once).
  const meta = rawLines.map((line) => {
    if (!line.trim()) return { uuid: null as string | null, turnStart: false }
    let raw: Record<string, unknown>
    try { raw = JSON.parse(line) as Record<string, unknown> } catch { return { uuid: null as string | null, turnStart: false } }
    const uuid = (raw.uuid ?? raw.id ?? raw.message_id ?? null) as string | null
    const msg = transformLine(raw)
    const turnStart = msg ? realUserText(msg) !== null : false
    return { uuid, turnStart }
  })

  let endIndex = rawLines.length
  if (opts.before) {
    const ci = meta.findIndex((m) => m.uuid === opts.before)
    // Cursor no longer in the file (should not happen — the transcript is append-only) → signal a
    // full reload rather than returning a wrong window.
    if (ci < 0) return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    endIndex = ci // exclusive: the client already holds this line
  }

  let start = Math.max(0, endIndex - opts.limit)
  while (start > 0 && !meta[start].turnStart) start--

  return {
    window: rawLines.slice(start, endIndex),
    hasMore: start > 0,
    oldestCursor: meta[start]?.uuid ?? null,
  }
}

// ── Live tailing (watcher lines) with derived turn lifecycle ──────────────────────────────────────

export interface TurnState {
  turnOpen: boolean
  toolIdToName: Map<string, string>
  /** tool_use ids started but not yet resolved by a tool_result. */
  pendingTools: Set<string>
  thinkingCounter: number
}

export function newTurnState(): TurnState {
  return { turnOpen: false, toolIdToName: new Map(), pendingTools: new Set(), thinkingCounter: 0 }
}

/**
 * Fold a transcript that already exists into a fresh normalizer, and say whether what came out is
 * HISTORY (to be swallowed) or the LIVE conversation (to be emitted).
 *
 * Attaching to a session normally means catching up on turns the user has already seen elsewhere, so the
 * events are dropped and only a turn left half-open is replayed. That assumption breaks when the agent
 * exists BEFORE its session: the first prompt is what makes the engine open the transcript, so by the
 * time anything binds it, the whole first turn — question, tools and answer — can already be on disk.
 * Folded as history it is lost silently, and silently is literal: no `turn_started` means no
 * `turn_ended` and no recap either, so nothing in the log records that a turn ever happened.
 *
 * `live` picks the destination. It also forces `turnOpen` to false, because the caller's mid-turn rescue
 * ("replay the last turn_started") would otherwise emit that event a second time on top of the events
 * returned here.
 */
export function foldTranscript(
  ingest: (line: string) => LiveEvent[],
  lines: string[],
  turnOpenAfter: () => boolean,
  opts: { live: boolean },
): { history: LiveEvent[]; live: LiveEvent[]; turnOpen: boolean } {
  const folded: LiveEvent[] = []
  for (const line of lines) folded.push(...ingest(line))
  return {
    history: opts.live ? [] : folded,
    live: opts.live ? folded : [],
    turnOpen: !opts.live && turnOpenAfter(),
  }
}

// Terminal assistant stop reasons that close a turn. `tool_use` is deliberately absent (the turn
// continues into the tool). `pause_turn` is absent too — it may legitimately resume; the Stop hook
// (which only fires when the agent is truly done) is the authoritative catch-all for that case.
// `max_tokens`/`refusal` are included so a turn that ends on them still closes from the JSONL alone.
const TERMINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal'])

/**
 * Convert ONE appended JSONL line into live events. Derives turn_started/turn_ended from content:
 *  - a real user prompt  → (turn_ended if one was open) + turn_started{userMessage}
 *  - assistant blocks    → thinking/text/tool_start (tool ids tracked as pending)
 *  - user tool_results   → tool_end (resolves pending ids)
 *  - assistant stop_reason in TERMINAL_STOP_REASONS with no pending tools → turn_ended
 */
export function lineToEvents(rawLine: string, state: TurnState): LiveEvent[] {
  if (!rawLine.trim()) return []
  let raw: Record<string, unknown>
  try { raw = JSON.parse(rawLine) as Record<string, unknown> } catch { return [] }
  // A valid-JSON but non-object line (the literal `null`, a number, a bare string) would make the
  // property access in compactEventFromRaw / transformLine throw — and on the unguarded watcher path
  // that kills the daemon. Any non-object line has nothing to emit.
  if (!raw || typeof raw !== 'object') return []
  // Compaction: emit the boundary indicator; suppress the injected summary/meta lines. The turn state
  // is left untouched, so an auto-compact that fires MID-TURN keeps the open turn open (the assistant
  // continuation after the boundary just streams under it) instead of the summary opening a fake turn.
  const compact = compactEventFromRaw(raw)
  if (compact) return compact
  // Sub-agent finished. Deliberately does NOT touch the turn state: the parent turn already closed on the
  // launch ack, and this record is not a prompt.
  const finished = taskNotificationEvent(raw)
  if (finished) return [finished]
  const msg = transformLine(raw)
  if (!msg?.message) return []

  const events: LiveEvent[] = []

  if (msg.type === 'user') {
    // Interrupt: close the open turn and start NOTHING. This is also the only signal for an ESC pressed
    // straight in the terminal — no cancel frame reaches the adapter there — so the turn has to end here.
    if (isInterruptLine(msg)) {
      if (!state.turnOpen) return []
      state.turnOpen = false
      state.pendingTools.clear()
      return [{ type: 'turn_ended', payload: { aborted: true } }]
    }
    const userText = realUserText(msg)
    if (userText !== null) {
      // New prompt (typed in the terminal OR injected from the web) — starts a turn.
      if (state.turnOpen) events.push({ type: 'turn_ended', payload: {} })
      state.turnOpen = true
      state.pendingTools.clear()
      events.push({ type: 'turn_started', payload: { userMessage: userText } })
      return events
    }
    // tool_result echoes: resolve pending tools.
    const ends = toolResultEvents(msg, state.toolIdToName)
    for (const e of ends) {
      if (e.type === 'tool_end') state.pendingTools.delete(e.payload.id)
    }
    events.push(...ends)
    return events
  }

  // assistant
  const before = events.length
  events.push(...assistantEvents(msg, state.toolIdToName, 'thinking-live-', state.thinkingCounter))
  state.thinkingCounter += events.slice(before).filter((e) => e.type === 'thinking_delta').length
  for (const e of events) {
    if (e.type === 'tool_start') state.pendingTools.add(e.payload.id)
  }

  const stop = msg.stopReason
  if (state.turnOpen && stop && TERMINAL_STOP_REASONS.has(stop) && state.pendingTools.size === 0) {
    state.turnOpen = false
    events.push({ type: 'turn_ended', payload: {} })
  }
  return events
}
