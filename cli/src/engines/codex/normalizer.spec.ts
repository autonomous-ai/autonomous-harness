import { describe, expect, it, vi } from 'vitest'
import { CodexNormalizer, codexMessagesToEvents, codexTaskError, lastCodexTurnText, windowCodexLines } from './normalizer.js'
import type { CodexSubagentResolver } from './subagent.js'

const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload })

describe('Codex rollout normalizer', () => {
  const fixture = [
    line('session_meta', { id: 'codex-1', cli_version: '0.144.4', cwd: '/tmp/work' }),
    line('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
    line('event_msg', { type: 'user_message', message: 'Change the API' }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'duplicate' }] }),
    line('response_item', { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"npm test"}' }),
    line('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'tests passed' }),
    line('event_msg', { type: 'agent_message', message: 'The API is updated.' }),
    line('event_msg', { type: 'task_complete', turn_id: 'turn-1' }),
  ]

  it('emits one live lifecycle and never duplicates response_item assistant text', () => {
    const normalizer = new CodexNormalizer('live')
    const events = fixture.flatMap((raw) => normalizer.ingest(raw))
    expect(events.map((event) => event.type)).toEqual([
      'turn_started', 'tool_start', 'tool_end', 'text_delta', 'turn_ended',
    ])
    expect(events.find((event) => event.type === 'text_delta')?.payload).toEqual({ content: 'The API is updated.' })
    expect(events.find((event) => event.type === 'tool_start')?.payload).toEqual({
      id: 'call-1',
      tool: 'Bash',
      input: { command: 'npm test' },
    })
    expect(normalizer.turnOpen).toBe(false)
  })

  it('replays user/tool/assistant events and appends done', () => {
    const events = codexMessagesToEvents(fixture)
    expect(events[0]).toEqual({ type: 'user_message', payload: { content: 'Change the API' } })
    expect(events.at(-1)).toEqual({ type: 'done', payload: { result: 'success' } })
  })

  it('deduplicates the compacted + token_count + context_compacted sequence', () => {
    const records = [
      line('compacted', { message: 'hidden' }),
      line('event_msg', { type: 'token_count', info: { total_token_usage: {} } }),
      line('event_msg', { type: 'context_compacted' }),
    ]
    const normalizer = new CodexNormalizer('live')
    const events = records.flatMap((raw) => normalizer.ingest(raw))
    expect(events.map((event) => event.type)).toEqual(['context_compact'])
    expect(codexMessagesToEvents(records).filter((event) => event.type === 'context_compact')).toHaveLength(1)
  })

  it('does not crash when a tool search result has no output field', () => {
    const normalizer = new CodexNormalizer('live')
    const events = [
      line('response_item', { type: 'tool_search_call', call_id: 'search-1' }),
      line('response_item', { type: 'tool_search_output', call_id: 'search-1', tools: [] }),
    ].flatMap((raw) => normalizer.ingest(raw))

    expect(events).toEqual([
      { type: 'tool_start', payload: { id: 'search-1', tool: 'tool_search', input: {} } },
      { type: 'tool_end', payload: { id: 'search-1', tool: 'tool_search', output: '', isError: false, summary: 'tool_search completed' } },
    ])
  })

  it('unwraps custom exec web calls into WebSearch cards', () => {
    const normalizer = new CodexNormalizer('live')
    const events = [
      line('response_item', {
        type: 'custom_tool_call',
        call_id: 'web-1',
        name: 'exec',
        input: 'const r = await tools.web__run({search_query:[{q:"BTC current price"}]}); text(r)',
      }),
      line('response_item', {
        type: 'custom_tool_call_output',
        call_id: 'web-1',
        output: [{ type: 'input_text', text: 'Search results' }],
      }),
    ].flatMap((raw) => normalizer.ingest(raw))

    expect(events).toEqual([
      { type: 'tool_start', payload: { id: 'web-1', tool: 'WebSearch', input: { query: 'BTC current price' } } },
      { type: 'tool_end', payload: { id: 'web-1', tool: 'WebSearch', output: 'Search results', isError: false, summary: 'Search results' } },
    ])
  })

  it('normalizes update_plan and hides internal deferred-tool discovery', () => {
    const normalizer = new CodexNormalizer('live')
    const events = [
      line('response_item', {
        type: 'custom_tool_call',
        call_id: 'discover-1',
        name: 'exec',
        input: 'text(ALL_TOOLS.map(x => x.name).filter(n => /todo/i.test(n)).join("\\n"))',
      }),
      line('response_item', { type: 'custom_tool_call_output', call_id: 'discover-1', output: 'update_plan' }),
      line('response_item', {
        type: 'custom_tool_call',
        call_id: 'plan-1',
        name: 'exec',
        input: 'const r = await tools.update_plan({plan:[{step:"Research BTC",status:"completed"},{step:"Write report",status:"in_progress"}]}); text(r)',
      }),
      line('response_item', { type: 'custom_tool_call_output', call_id: 'plan-1', output: 'Plan updated' }),
    ].flatMap((raw) => normalizer.ingest(raw))

    expect(events).toEqual([
      {
        type: 'tool_start',
        payload: {
          id: 'plan-1',
          tool: 'TodoWrite',
          input: {
            todos: [
              { content: 'Research BTC', status: 'completed' },
              { content: 'Write report', status: 'in_progress' },
            ],
          },
        },
      },
      { type: 'tool_end', payload: { id: 'plan-1', tool: 'TodoWrite', output: 'Plan updated', isError: false, summary: 'Plan updated' } },
    ])
  })

  it('extracts the final user/assistant turn and uses stable line cursors', () => {
    expect(lastCodexTurnText(fixture)).toEqual({ userMessage: 'Change the API', assistantText: 'The API is updated.' })
    const window = windowCodexLines([...fixture, ...fixture], { limit: 4 })
    expect(window.oldestCursor).toMatch(/^codex:\d+$/)
    expect(window.hasMore).toBe(true)
  })

  it('maps Codex orchestration to a Task tree and deduplicates completion notifications', () => {
    const resolver: CodexSubagentResolver = () => ({
      events: [
        { type: 'tool_start', payload: { id: 'child-call', tool: 'Bash', input: { command: 'rg TODO' } } },
        { type: 'tool_end', payload: { id: 'child-call', tool: 'Bash', output: 'done', isError: false, summary: 'done' } },
      ],
      agentType: 'explorer',
      totalToolUseCount: 1,
      totalTokens: 321,
      totalDurationMs: 1_500,
    })
    const resolveSubagent = vi.fn(resolver)
    const childId = '019f35c1-8017-7391-beb4-06a01ceda2bd'
    const orchestration = [
      line('event_msg', { type: 'user_message', message: 'Inspect the code' }),
      line('response_item', {
        type: 'function_call',
        call_id: 'spawn-1',
        name: 'spawn_agent',
        arguments: JSON.stringify({ agent_type: 'explorer', message: 'description="API audit". Inspect the API.' }),
      }),
      line('response_item', {
        type: 'function_call_output',
        call_id: 'spawn-1',
        output: JSON.stringify({ agent_id: childId, nickname: 'Curie' }),
      }),
      line('response_item', {
        type: 'function_call',
        call_id: 'wait-1',
        name: 'wait_agent',
        arguments: JSON.stringify({ targets: [childId] }),
      }),
      line('response_item', {
        type: 'function_call_output',
        call_id: 'wait-1',
        output: JSON.stringify({ status: { [childId]: { completed: 'API audit complete' } } }),
      }),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: `<subagent_notification>\n${JSON.stringify({ agent_path: childId, status: { completed: 'API audit complete' } })}\n</subagent_notification>`,
        }],
      }),
      line('event_msg', { type: 'task_complete' }),
    ]

    const normalizer = new CodexNormalizer('live', resolveSubagent)
    const events = orchestration.flatMap((raw) => normalizer.ingest(raw))

    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      'tool_start',
      'tool_start',
      'tool_end',
      'tool_end',
      'turn_ended',
    ])
    expect(events[1]).toEqual({
      type: 'tool_start',
      payload: {
        id: 'spawn-1',
        tool: 'Task',
        input: {
          subagent_type: 'explorer',
          name: 'Curie',
          title: 'API audit',
          description: 'Inspect the API.',
        },
      },
    })
    expect(events[2]).toEqual({
      type: 'tool_start',
      payload: {
        id: 'child-call',
        tool: 'Bash',
        input: { command: 'rg TODO' },
        parentToolUseId: 'spawn-1',
      },
    })
    expect(events[3].payload).toMatchObject({ parentToolUseId: 'spawn-1' })
    expect(events[4].payload).toMatchObject({
      id: 'spawn-1',
      tool: 'Task',
      isError: false,
      subagent: {
        agentId: childId,
        agentType: 'explorer',
        totalToolUseCount: 1,
        totalTokens: 321,
        totalDurationMs: 1_500,
      },
    })
    expect(resolveSubagent).toHaveBeenCalledOnce()
    expect(resolveSubagent).toHaveBeenCalledWith(childId)
    expect(events.some((event) => event.type === 'tool_start' && ['spawn_agent', 'wait_agent'].includes(event.payload.tool))).toBe(false)
  })

  it('closes a Task with an error when Codex rejects the spawn', () => {
    const normalizer = new CodexNormalizer('live', () => null)
    const events = [
      line('response_item', {
        type: 'function_call',
        call_id: 'spawn-failed',
        name: 'spawn_agent',
        arguments: JSON.stringify({ agent_type: 'worker', message: 'Do the work' }),
      }),
      line('response_item', {
        type: 'function_call_output',
        call_id: 'spawn-failed',
        output: 'Provide either message or items, but not both',
      }),
    ].flatMap((raw) => normalizer.ingest(raw))

    expect(events.map((event) => event.type)).toEqual(['tool_start', 'tool_end'])
    expect(events[1].payload).toMatchObject({ id: 'spawn-failed', tool: 'Task', isError: true })
  })

  it('uses the same Task tree contract for transcript replay', () => {
    const childId = '019f35c1-8017-7391-beb4-06a01ceda2bd'
    const resolveSubagent: CodexSubagentResolver = () => ({
      events: [],
      agentType: 'worker',
      totalToolUseCount: 0,
      totalTokens: 10,
      totalDurationMs: 25,
    })
    const events = codexMessagesToEvents([
      line('response_item', { type: 'function_call', call_id: 'spawn-replay', name: 'spawn_agent', arguments: '{"agent_type":"worker","message":"Build it"}' }),
      line('response_item', { type: 'function_call_output', call_id: 'spawn-replay', output: JSON.stringify({ agent_id: childId }) }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<subagent_notification>\n${JSON.stringify({ agent_path: childId, status: { completed: 'Built' } })}\n</subagent_notification>` }] }),
    ], resolveSubagent)

    expect(events.map((event) => event.type)).toEqual(['tool_start', 'tool_end', 'done'])
    expect(events[0].payload).toMatchObject({ tool: 'Task' })
    expect(events[1].payload).toMatchObject({ tool: 'Task', subagent: { agentId: childId } })
  })

  it('keeps parallel Task ordering identical between live watch and F5 replay', () => {
    const prompt = 'Run three echo agents in parallel'
    const childIds = [
      '019f8dae-e306-7b13-8b19-04e381787092',
      '019f8dae-e592-7823-9ebf-64940ee02c5d',
      '019f8dae-e5f4-7c11-90d1-600854063b2c',
    ]
    const fixture = [
      line('event_msg', { type: 'user_message', message: prompt }),
      line('event_msg', { type: 'agent_message', message: 'Launching three agents.' }),
      ...childIds.flatMap((childId, index) => [
        line('response_item', {
          type: 'function_call',
          call_id: `spawn-${index + 1}`,
          name: 'spawn_agent',
          arguments: JSON.stringify({
            agent_type: 'worker',
            message: `description="echo ${index + 1}". Run echo ${index + 1}.`,
          }),
        }),
        line('response_item', {
          type: 'function_call_output',
          call_id: `spawn-${index + 1}`,
          output: JSON.stringify({ agent_id: childId }),
        }),
      ]),
      line('response_item', {
        type: 'function_call',
        call_id: 'wait-all',
        name: 'wait_agent',
        arguments: JSON.stringify({ targets: childIds }),
      }),
      line('response_item', {
        type: 'function_call_output',
        call_id: 'wait-all',
        output: JSON.stringify({
          status: Object.fromEntries(childIds.map((childId, index) => [
            childId,
            { completed: String(index + 1) },
          ])),
        }),
      }),
      line('event_msg', { type: 'agent_message', message: 'All three agents completed.' }),
      line('event_msg', { type: 'task_complete' }),
    ]
    const resolver: CodexSubagentResolver = (childId) => ({
      events: [{
        type: 'tool_start',
        payload: { id: `bash-${childId}`, tool: 'Bash', input: { command: 'echo' } },
      }, {
        type: 'tool_end',
        payload: {
          id: `bash-${childId}`,
          tool: 'Bash',
          output: 'done',
          isError: false,
          summary: 'done',
        },
      }],
      agentType: 'worker',
      totalToolUseCount: 1,
      totalTokens: 10,
      totalDurationMs: 20,
    })
    const liveNormalizer = new CodexNormalizer('live', resolver)
    const liveEvents = fixture.flatMap((raw) => liveNormalizer.ingest(raw))
    const replayEvents = codexMessagesToEvents(fixture, resolver)
    const visualOrder = (events: typeof liveEvents) => events.flatMap((event) => {
      if (event.type === 'turn_started') return [`user:${event.payload.userMessage}`]
      if (event.type === 'user_message') return [`user:${event.payload.content}`]
      if (event.type === 'text_delta') return [`text:${event.payload.content}`]
      if (event.type === 'tool_start' && event.payload.tool === 'Task') {
        return [`task:${String((event.payload.input as { title?: string }).title ?? '')}`]
      }
      return []
    })

    expect(visualOrder(liveEvents)).toEqual(visualOrder(replayEvents))
    expect(visualOrder(liveEvents)).toEqual([
      `user:${prompt}`,
      'text:Launching three agents.',
      'task:echo 1',
      'task:echo 2',
      'task:echo 3',
      'text:All three agents completed.',
    ])
  })
})

describe('Codex `/goal` turns', () => {
  // Shape taken verbatim from a real rollout (019f7ee1…): a `/goal x` submission emits NO
  // `event_msg/user_message` at all — codex records it only as this injected context, and re-injects
  // the identical block to drive each continuation turn.
  const goalCtx = (objective: string) =>
    line('response_item', {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: `<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n\n<objective>\n${objective}\n</objective>\n\nBudget:\n- Tokens used: 0\n</codex_internal_context>`,
      }],
    })
  const fixture = [
    line('event_msg', { type: 'task_started' }),
    goalCtx('lay gia BTC'),
    line('event_msg', { type: 'agent_message', message: 'done' }),
    line('event_msg', { type: 'task_complete' }),
    line('event_msg', { type: 'task_started' }),
    goalCtx('lay gia BTC'),
    line('event_msg', { type: 'agent_message', message: 'still going' }),
    line('event_msg', { type: 'task_complete' }),
  ]

  it('opens a turn on the goal context, labelling the submission verbatim', () => {
    const n = new CodexNormalizer('live')
    const events = fixture.flatMap((l) => n.ingest(l))
    const turns = events.filter((e) => e.type === 'turn_started' || e.type === 'turn_ended')

    // `/goal <objective>` must reproduce the injected prompt exactly — SessionInputController
    // fingerprints it, and a mismatch is what surfaced "The agent did not accept the message".
    expect(turns).toEqual([
      { type: 'turn_started', payload: { userMessage: '/goal lay gia BTC' } },
      { type: 'turn_ended', payload: {} },
      { type: 'turn_started', payload: { userMessage: 'Continuing goal: lay gia BTC' } },
      { type: 'turn_ended', payload: {} },
    ])
  })

  it('leads the recap with the goal instead of an empty prompt', () => {
    expect(lastCodexTurnText(fixture)).toEqual({
      userMessage: '/goal lay gia BTC',
      assistantText: 'still going',
    })
  })

  it('snaps a pagination window to the goal context', () => {
    const w = windowCodexLines(fixture, { limit: 3 })

    expect(w.window[0]).toBe(goalCtx('lay gia BTC'))
    expect(w.hasMore).toBe(true)
  })
})

describe('codex turn failure', () => {
  // Verbatim from a real rollout: the turn ends, but with no agent message and the reason tucked into
  // task_complete — which is why the web used to show a turn that finished having said nothing.
  const TASK_COMPLETE_ERROR = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: '019fb768-786b-7fd2-a6a2-be2dc690e580',
      last_agent_message: null,
      error: { message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 5th, 2026 11:09 AM." },
    },
  })

  it('reads the reason a turn failed', () => {
    expect(codexTaskError(TASK_COMPLETE_ERROR)).toMatch(/^You've hit your usage limit\./)
  })

  it('stays silent for a healthy turn, an interrupt, or anything else', () => {
    const ok = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'done' },
    })
    expect(codexTaskError(ok)).toBeNull()
    // A user interrupt is not a failure and carries no error of its own.
    expect(codexTaskError(JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted' } }))).toBeNull()
    expect(codexTaskError(JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }))).toBeNull()
    expect(codexTaskError('not json')).toBeNull()
  })

  it('still ends the turn — the announcement is extra, not a replacement', () => {
    const normalizer = new CodexNormalizer('live')
    normalizer.ingest(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Giá Ethereum mới nhất' } }))
    expect(normalizer.turnOpen).toBe(true)

    const events = normalizer.ingest(TASK_COMPLETE_ERROR)
    expect(events.some((e) => e.type === 'turn_ended')).toBe(true)
    expect(normalizer.turnOpen).toBe(false)
  })
})
