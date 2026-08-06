import { readFileSync } from 'fs'
import type { SessionEvent } from '../../lib/normalize.js'
import { resolveCodexRollout } from './rollout.js'

type JsonObject = Record<string, unknown>

export interface CodexSubagentInfo {
  events: Array<Extract<SessionEvent, { type: 'tool_start' | 'tool_end' }>>
  agentType: string
  totalToolUseCount: number
  totalTokens: number
  totalDurationMs: number
}

export type CodexSubagentResolver = (threadId: string) => CodexSubagentInfo | null

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function parseObject(value: unknown): JsonObject {
  if (object(value)) return value as JsonObject
  if (typeof value !== 'string') return {}
  try { return object(JSON.parse(value)) ?? { raw: value } } catch { return { raw: value } }
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part
      const p = object(part)
      return p && typeof p.text === 'string' ? p.text : ''
    }).filter(Boolean).join('\n')
  }
  const obj = object(value)
  if (obj && typeof obj.text === 'string') return obj.text
  try { return JSON.stringify(value ?? '') } catch { return String(value ?? '') }
}

function commandText(args: JsonObject): string {
  const value = args.cmd ?? args.command
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(String).join(' ')
  return text(value || args)
}

function jsStringProperty(source: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:\\b${escapedKey}\\b|["']${escapedKey}["'])\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`).exec(source)
  if (!match) return ''
  const quoted = match[1]
  if (quoted.startsWith('"')) {
    try { return JSON.parse(quoted) as string } catch { return quoted.slice(1, -1) }
  }
  return quoted.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
}

function wrappedExecDescriptor(source: string): { tool: string; input: unknown } | null {
  const match = /\btools\.([a-zA-Z0-9_$]+)\s*\(/.exec(source)
  if (!match) return null
  const wrappedTool = match[1]
  switch (wrappedTool) {
    case 'web__run':
      return { tool: 'WebSearch', input: { query: jsStringProperty(source, 'q') } }
    case 'exec_command':
      return { tool: 'Bash', input: { command: jsStringProperty(source, 'cmd') || jsStringProperty(source, 'command') } }
    case 'apply_patch':
      return { tool: 'ApplyPatch', input: { patch: source } }
    case 'update_plan': {
      const todos = (source.match(/\{[^{}]*\}/g) ?? []).flatMap((entry) => {
        const content = jsStringProperty(entry, 'step')
        const status = jsStringProperty(entry, 'status')
        return content ? [{ content, status: status || 'pending' }] : []
      })
      return { tool: 'TodoWrite', input: { todos } }
    }
    default:
      return { tool: wrappedTool, input: { script: source } }
  }
}

/** Codex may use exec only to inspect deferred tool metadata; this is not user-visible work. */
export function isCodexInternalToolCall(name: string, rawInput: unknown): boolean {
  return name === 'exec'
    && typeof rawInput === 'string'
    && /\bALL_TOOLS\b/.test(rawInput)
    && !/\btools\.[a-zA-Z0-9_$]+\s*\(/.test(rawInput)
}

/** Codex rollout function name -> the existing Claude-style tool vocabulary used by web/device. */
export function codexToolDescriptor(name: string, rawInput: unknown): { tool: string; input: unknown } {
  if (name === 'exec' && typeof rawInput === 'string') {
    const wrapped = wrappedExecDescriptor(rawInput)
    if (wrapped) return wrapped
  }
  const args = parseObject(rawInput)
  switch (name) {
    case 'exec_command':
    case 'shell':
    case 'local_shell':
    case 'unified_exec':
      return { tool: 'Bash', input: { command: commandText(args) } }
    case 'apply_patch':
      return { tool: 'ApplyPatch', input: args }
    case 'web_search':
    case 'web':
      return { tool: 'WebSearch', input: { query: typeof args.query === 'string' ? args.query : '' } }
    case 'update_plan': {
      // Codex's plan tool ≙ Claude's TodoWrite: {plan:[{status,step}]} → {todos:[{content,status}]}.
      // Statuses are identical (pending|in_progress|completed), so the web TodoTracker consumes it as-is.
      const plan = Array.isArray(args.plan) ? args.plan : []
      const todos = plan.flatMap((entry) => {
        const o = object(entry)
        const content = typeof o?.step === 'string' ? o.step : ''
        const status = typeof o?.status === 'string' ? o.status : 'pending'
        return content ? [{ content, status }] : []
      })
      return { tool: 'TodoWrite', input: { todos } }
    }
    default:
      return { tool: name || 'tool', input: object(rawInput) ? rawInput : (typeof rawInput === 'string' ? rawInput : args) }
  }
}

/** Backward-compatible name used by the subagent resolver/tests. */
export const resolveChildRollout = resolveCodexRollout

/** Read the child transcript only after it completed, matching the hosted runtime's aggregation semantics. */
export function readChildRollout(file: string): CodexSubagentInfo | null {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return null }

  const calls: Array<{ id: string; tool: string; input: unknown }> = []
  const outputs = new Map<string, { output: string; isError: boolean }>()
  let agentType = 'agent'
  let totalTokens = 0
  let firstTs: number | null = null
  let lastTs: number | null = null

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let record: JsonObject
    try { record = object(JSON.parse(line)) ?? {} } catch { continue }
    const parsedTs = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
    if (Number.isFinite(parsedTs)) {
      firstTs ??= parsedTs
      lastTs = parsedTs
    }
    const payload = object(record.payload) ?? {}
    const payloadType = typeof payload.type === 'string' ? payload.type : ''

    if (record.type === 'session_meta') {
      const source = object(payload.source)
      const fromSource = source && typeof source.subagent === 'string' ? source.subagent : ''
      agentType = fromSource
        || (typeof payload.agent_nickname === 'string' ? payload.agent_nickname : '')
        || (typeof payload.agent_role === 'string' ? payload.agent_role : '')
        || 'agent'
      continue
    }

    if (record.type === 'event_msg' && payloadType === 'token_count') {
      const info = object(payload.info)
      const usage = object(info?.total_token_usage)
      if (typeof usage?.total_tokens === 'number') totalTokens = usage.total_tokens
      continue
    }

    if (record.type !== 'response_item') continue
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call' || payloadType === 'tool_search_call') {
      const id = (typeof payload.call_id === 'string' && payload.call_id)
        || (typeof payload.id === 'string' && payload.id)
        || `child-call-${calls.length}`
      const name = typeof payload.name === 'string'
        ? payload.name
        : (payloadType === 'tool_search_call' ? 'tool_search' : 'tool')
      if (isCodexInternalToolCall(name, payload.arguments ?? payload.input)) continue
      const descriptor = codexToolDescriptor(name, payload.arguments ?? payload.input)
      calls.push({ id, tool: descriptor.tool, input: descriptor.input })
      continue
    }

    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output' || payloadType === 'tool_search_output') {
      const id = (typeof payload.call_id === 'string' && payload.call_id)
        || (typeof payload.id === 'string' && payload.id)
      if (id) outputs.set(id, {
        output: text(payload.output),
        isError: payload.is_error === true || payload.status === 'failed',
      })
    }
  }

  const events: CodexSubagentInfo['events'] = []
  for (const call of calls) {
    const stableId = `codex-child-${call.id}`
    const result = outputs.get(call.id) ?? { output: '', isError: false }
    events.push({ type: 'tool_start', payload: { id: stableId, tool: call.tool, input: call.input } })
    events.push({
      type: 'tool_end',
      payload: {
        id: stableId,
        tool: call.tool,
        output: result.output,
        isError: result.isError,
        summary: result.output.split('\n').find(Boolean)?.slice(0, 120) || `${call.tool} completed`,
      },
    })
  }

  return {
    events,
    agentType,
    totalToolUseCount: calls.length,
    totalTokens,
    totalDurationMs: firstTs !== null && lastTs !== null ? Math.max(0, lastTs - firstTs) : 0,
  }
}

export const resolveCodexSubagent: CodexSubagentResolver = (threadId) => {
  const file = resolveChildRollout(threadId)
  return file ? readChildRollout(file) : null
}
