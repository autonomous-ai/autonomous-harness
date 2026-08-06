import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { codexToolDescriptor, readChildRollout, resolveChildRollout } from './subagent.js'

let root = ''

const line = (timestamp: string, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp, type, payload })

describe('Codex child rollout reader', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adapter-codex-child-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves a child rollout and converts its tools and aggregate stats', () => {
    const childId = '019f35c1-8017-7391-beb4-06a01ceda2bd'
    const dir = join(root, '2026', '07', '16')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2026-07-16T12-00-00-${childId}.jsonl`)
    writeFileSync(file, [
      line('2026-07-16T12:00:00.000Z', 'session_meta', { id: childId, source: { subagent: 'explorer' } }),
      line('2026-07-16T12:00:01.000Z', 'response_item', { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"npm test"}' }),
      line('2026-07-16T12:00:02.000Z', 'response_item', { type: 'function_call_output', call_id: 'call-1', output: 'passed' }),
      line('2026-07-16T12:00:03.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 456 } } }),
    ].join('\n'))

    expect(resolveChildRollout(childId, root)).toBe(file)
    expect(readChildRollout(file)).toEqual({
      events: [
        { type: 'tool_start', payload: { id: 'codex-child-call-1', tool: 'Bash', input: { command: 'npm test' } } },
        { type: 'tool_end', payload: { id: 'codex-child-call-1', tool: 'Bash', output: 'passed', isError: false, summary: 'passed' } },
      ],
      agentType: 'explorer',
      totalToolUseCount: 1,
      totalTokens: 456,
      totalDurationMs: 3_000,
    })
  })

  it('rejects unsafe child ids before walking the filesystem', () => {
    expect(resolveChildRollout('../../etc/passwd', root)).toBeNull()
  })

  it('extracts the inner tool and query from Codex custom exec wrappers', () => {
    expect(codexToolDescriptor(
      'exec',
      'const r = await tools.web__run({search_query:[{q:"BTC USD current price"}]}); text(r)',
    )).toEqual({ tool: 'WebSearch', input: { query: 'BTC USD current price' } })
    expect(codexToolDescriptor(
      'exec',
      'const r = await tools.web__run({finance:[{ticker:"BTC",type:"crypto"}]}); text(r)',
    )).toEqual({ tool: 'WebSearch', input: { query: '' } })
  })

  it('maps wrapped Codex plans to the Claude TodoWrite contract', () => {
    expect(codexToolDescriptor(
      'exec',
      'const r = await tools.update_plan({plan:[{step:"Research","status":"completed"},{step:"Report","status":"in_progress"}]}); text(r)',
    )).toEqual({
      tool: 'TodoWrite',
      input: {
        todos: [
          { content: 'Research', status: 'completed' },
          { content: 'Report', status: 'in_progress' },
        ],
      },
    })
  })
})
