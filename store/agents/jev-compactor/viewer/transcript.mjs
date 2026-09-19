// transcript.mjs — read a REAL coding-agent transcript from the workspace and turn it into the block
// model the pane draws: user and assistant messages (never touched) and tool results (judged by Jev).
//
// Two line formats are read, one JSON object per line:
//   Claude Code   { type: "user"|"assistant", message: { content: string | blocks[] } }
//                 blocks: { type: "text" }, { type: "tool_use", id, name, input },
//                         { type: "tool_result", tool_use_id, content }
//   generic       { role: "user"|"assistant"|"tool", name?: "Read", input?: ..., content: "..." }
//
// Only a short head of each block is kept in memory (the preview Jev sees). Nothing here writes to
// disk, and nothing throws: every failure comes back as { ok: false, error }.
import { readFileSync, statSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'

export const MAX_BYTES = 64 * 1024 * 1024
export const PREVIEW_CHARS = 300
const TASK_CHARS = 600
const RESERVED = new Set(['session.json', 'compaction-plan.json'])

const KIND_OF = {
  Read: 'Read', NotebookRead: 'Read',
  Grep: 'Grep', Glob: 'Grep', LS: 'Grep',
  Bash: 'Bash', BashOutput: 'Bash',
  Edit: 'Edit', MultiEdit: 'Edit', Write: 'Edit', NotebookEdit: 'Edit',
  WebFetch: 'WebFetch', WebSearch: 'WebFetch',
}
export const kindOf = (name) => KIND_OF[name] ?? 'Tool'

const oneLine = (s, n) => String(s ?? '').replace(/[\s\u0000-\u001f]+/g, ' ').replace(/[«»]/g, '"').trim().slice(0, n)

/** The short thing a tool was pointed at: a file path, a command, a pattern, a URL. */
export function summarizeInput(input) {
  if (input == null) return ''
  if (typeof input !== 'object') return oneLine(input, 160)
  for (const k of ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'path', 'description', 'prompt']) {
    if (typeof input[k] === 'string' && input[k]) return oneLine(k === 'pattern' && typeof input.path === 'string' ? `${input[k]} in ${input.path}` : input[k], 160)
  }
  try { return oneLine(JSON.stringify(input), 160) } catch { return '' }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' && typeof p.text === 'string' ? p.text : p?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}
const sizeOf = (v) => { if (typeof v === 'string') return v.length; try { return JSON.stringify(v ?? '').length } catch { return 0 } }

/** Resolve `source` to a file inside the workspace, or say why not. Never throws. */
export function resolveSource(workspace, source) {
  try {
    if (typeof source !== 'string' || !source.trim() || source.includes('\0')) return { ok: false, error: 'source must be a file name inside the workspace' }
    const check = (root, abs) => {
      const rel = relative(root, abs)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return 'is outside the workspace'
      const parts = rel.split(/[\\/]/)
      if (parts[0].toLowerCase() === '.harness') return 'is under .harness, which is off limits'
      if (parts.length === 1 && RESERVED.has(parts[0].toLowerCase())) return 'is a file this harness writes, pick another name'
      return null
    }
    const abs = resolve(workspace, source.trim())
    const why = check(resolve(workspace), abs)
    if (why) return { ok: false, error: `source "${oneLine(source, 80)}" ${why}` }
    let st
    try { st = statSync(abs) } catch { return { ok: false, error: `source "${oneLine(source, 80)}" was not found in the workspace` } }
    if (!st.isFile()) return { ok: false, error: `source "${oneLine(source, 80)}" is not a file` }
    const whyReal = check(realpathSync(workspace), realpathSync(abs))   // a symlink must not lead outside either
    if (whyReal) return { ok: false, error: `source "${oneLine(source, 80)}" ${whyReal}` }
    if (st.size > MAX_BYTES) return { ok: false, error: `source is ${(st.size / 1048576).toFixed(1)} MB, the limit is 64 MB` }
    return { ok: true, file: abs, rel: relative(resolve(workspace), abs), bytes: st.size }
  } catch (e) {
    return { ok: false, error: `source could not be read: ${oneLine(e?.message ?? e, 120)}` }
  }
}

/** Parse transcript text into blocks. Never throws. Bad lines are skipped and counted. */
export function parseTranscript(text) {
  const stats = { lines: 0, skipped: 0, ignored: 0, messages: 0, toolResults: 0, unpairedUses: 0, unpairedResults: 0, claudeLines: 0, genericLines: 0 }
  const blocks = []
  const pending = new Map() // tool_use id -> block waiting for its result

  const message = (role, raw, line, meta) => {
    const t = String(raw ?? '')
    if (!t.trim()) return
    const head = t.trim()
    const candidate = role === 'user' && !meta && head.length >= 4 && !/^(<|\[Request interrupted|Caveat:)/.test(head)
    blocks.push({ role, kind: role, tool: null, input: '', chars: t.length, preview: oneLine(t, PREVIEW_CHARS), taskText: candidate ? oneLine(t, TASK_CHARS) : null, line })
    stats.messages++
  }
  const toolUse = (id, name, input, line) => {
    const tool = oneLine(name || 'Tool', 60) || 'Tool'
    const b = { role: 'tool', kind: kindOf(tool), tool, input: summarizeInput(input), chars: sizeOf(input), preview: '', taskText: null, line, paired: false }
    blocks.push(b)
    if (id != null) pending.set(String(id), b)
    return b
  }
  const toolResult = (id, content, line) => {
    const t = textOf(content)
    let b = id != null ? pending.get(String(id)) : null
    if (b) pending.delete(String(id))
    else { b = toolUse(null, 'Tool', null, line); stats.unpairedResults++ }
    b.paired = true
    b.chars += t.length
    b.preview = oneLine(t, PREVIEW_CHARS)
    stats.toolResults++
  }

  let lineNo = 0
  for (const rawLine of String(text ?? '').split('\n')) {
    lineNo++
    const s = rawLine.trim()
    if (!s) continue
    stats.lines++
    let o
    try { o = JSON.parse(s) } catch { stats.skipped++; continue }
    if (!o || typeof o !== 'object' || Array.isArray(o)) { stats.skipped++; continue }
    try {
      if ((o.type === 'user' || o.type === 'assistant') && o.message && typeof o.message === 'object') {
        if (o.isSidechain) { stats.ignored++; continue }   // a sub-agent's own thread is not in this context
        stats.claudeLines++
        const c = o.message.content
        if (typeof c === 'string') message(o.type, c, lineNo, !!o.isMeta)
        else if (Array.isArray(c)) {
          for (const part of c) {
            if (!part || typeof part !== 'object') continue
            if (part.type === 'text') message(o.type, part.text, lineNo, !!o.isMeta)
            else if (part.type === 'tool_use') toolUse(part.id, part.name, part.input, lineNo)
            else if (part.type === 'tool_result') toolResult(part.tool_use_id, part.content, lineNo)
          }
        } else stats.ignored++
      } else if (o.role === 'user' || o.role === 'assistant') {
        stats.genericLines++
        message(o.role, textOf(o.content), lineNo, false)
      } else if (o.role === 'tool') {
        stats.genericLines++
        toolUse(null, o.name, o.input, lineNo)
        blocks[blocks.length - 1].paired = true
        const t = textOf(o.content)
        blocks[blocks.length - 1].chars += t.length
        blocks[blocks.length - 1].preview = oneLine(t, PREVIEW_CHARS)
        stats.toolResults++
      } else stats.ignored++
    } catch { stats.skipped++ }
  }
  for (const b of blocks) if (b.role === 'tool' && !b.paired) { stats.unpairedUses++; b.preview = '(no result for this call in the transcript)' }
  // Estimate tokens as characters / 4.
  for (const b of blocks) b.tokens = Math.max(1, Math.ceil(b.chars / 4))
  return { blocks, stats }
}

/** Load and parse `source` from the workspace. Never throws. */
export function loadTranscript(workspace, source) {
  const where = resolveSource(workspace, source)
  if (!where.ok) return where
  try {
    const { blocks, stats } = parseTranscript(readFileSync(where.file, 'utf8'))
    if (!blocks.length) return { ok: false, error: `source "${where.rel}" has no user, assistant or tool lines this harness can read (${stats.skipped} bad lines)` }
    return { ok: true, rel: where.rel, bytes: where.bytes, blocks, stats }
  } catch (e) {
    return { ok: false, error: `source could not be read: ${oneLine(e?.message ?? e, 120)}` }
  }
}
