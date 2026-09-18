import { describe, expect, it } from 'vitest'

import { buildEngineCommandArgv, MAX_FIRST_PROMPT_CHARS } from './engineLaunch.js'
import { forkName, handoffPrompt, planFork } from './forkAgent.js'

const memory = { asks: ['make the tests green', 'add a login form'], recaps: ['3 tests fixed', 'form added with validation'], lastAnswer: 'All green now.' }

describe('planFork', () => {
  it('forks Claude and Codex natively, with the argv each CLI documents', () => {
    const claude = planFork({ engine: 'claude', sessionId: 's-1', name: 'Kinh Te', cwd: '/w' }, memory, null)
    expect(claude).toEqual({ ok: true, level: 'native', forkSessionId: 's-1' })
    // `claude --resume <id> --fork-session`: the flag rides after the id, ahead of the first prompt.
    const argv = buildEngineCommandArgv('claude', { forkSessionId: 's-1', firstPrompt: 'go' })
    expect(argv.slice(-4)).toEqual(['--resume', 's-1', '--fork-session', 'go'])
    // `codex fork <id> [PROMPT]`: a subcommand, first after the binary.
    expect(buildEngineCommandArgv('codex', { forkSessionId: 's-2', firstPrompt: 'go' }).slice(0, 3)).toEqual(['codex', 'fork', 's-2'])
    expect(buildEngineCommandArgv('codex', { forkSessionId: 's-2', firstPrompt: 'go' }).at(-1)).toBe('go')
  })

  it('refuses a native fork of a session the engine has not named yet', () => {
    const plan = planFork({ engine: 'claude', sessionId: '', name: 'Fresh', cwd: null }, memory, null)
    expect(plan).toMatchObject({ ok: false, error: 'FORK_NO_SESSION' })
  })

  it('hands off through a first prompt when the engine takes one but cannot fork', () => {
    const plan = planFork({ engine: 'opencode', sessionId: 'x', name: 'Ops', cwd: '/srv' }, memory, 'ship it')
    expect(plan.ok && plan.level).toBe('handoff')
    if (!plan.ok || plan.level !== 'handoff') return
    // Oldest first, the person's words and the result side by side, the task last.
    expect(plan.firstPrompt.indexOf('add a login form')).toBeLessThan(plan.firstPrompt.indexOf('make the tests green'))
    expect(plan.firstPrompt).toContain('Result: 3 tests fixed')
    expect(plan.firstPrompt).toContain('Its last full answer:\nAll green now.')
    expect(plan.firstPrompt.endsWith('Your task now: ship it')).toBe(true)
    expect(plan.firstPrompt).toContain('fork of the agent "Ops" in /srv')
  })

  it('refuses an engine with neither a fork nor a first prompt, and says why', () => {
    const plan = planFork({ engine: 'cursor', sessionId: 'x', name: 'C', cwd: null }, memory, null)
    expect(plan).toMatchObject({ ok: false, error: 'FORK_UNSUPPORTED' })
    expect(!plan.ok && plan.detail).toContain('cursor')
  })

  it('a fork never becomes a plain resume', () => {
    // Two processes on one session is the failure this whole module exists to avoid.
    expect(buildEngineCommandArgv('claude', { forkSessionId: 's-1', resumeSessionId: 's-1' })).toContain('--fork-session')
    // An engine without a fork gets no session argument at all from a fork request.
    expect(buildEngineCommandArgv('cursor', { forkSessionId: 's-1' })).toEqual(buildEngineCommandArgv('cursor', {}))
  })
})

describe('handoffPrompt', () => {
  it('drops the oldest turns first to fit the wire', () => {
    const big = { asks: Array.from({ length: 40 }, (_, i) => `ask ${i} ${'x'.repeat(80)}`), recaps: Array.from({ length: 40 }, (_, i) => `recap ${i}`), lastAnswer: 'y'.repeat(300) }
    const text = handoffPrompt({ engine: 'opencode', sessionId: 'x', name: 'N', cwd: null }, big, null)
    expect(text.length).toBeLessThanOrEqual(MAX_FIRST_PROMPT_CHARS)
    expect(text).toContain('ask 0 ')        // the newest (index 0) survives
    expect(text).not.toContain('ask 39 ')   // the oldest goes first
    expect(text).toContain('Continue from there.')
  })

  it('asks for a one-line state check when there is no task', () => {
    const text = handoffPrompt({ engine: 'opencode', sessionId: 'x', name: 'N', cwd: null }, { asks: [], recaps: [] }, '  ')
    expect(text).toContain('say in one line what you understand the current state to be')
  })
})

describe('forkName', () => {
  it('is the source name with " - fork"', () => {
    expect(forkName('Kinh Te')).toBe('Kinh Te - fork')
    expect(forkName('  ')).toBe('Agent - fork')
  })
})
