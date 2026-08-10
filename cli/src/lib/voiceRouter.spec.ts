import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the one-shot LLM runner so routeVoiceTask can be tested without spawning `claude`. The behavior is
// driven by a PLAIN per-test impl (routerImpl) rather than the vi.fn's own return, so a rejection is only ever
// consumed by routeVoiceTask's await — this avoids tinyspy's async settled-result tracking leaving an
// unhandled rejection once a resolved test has run on the same spy. The vi.fn is kept only for call counts.
const runRouterOneShot = vi.fn()
const runGrokOneShot = vi.fn()
let routerImpl: (o: unknown) => Promise<{ text: string; sessionId: null }> = async () => ({ text: '', sessionId: null })
vi.mock('./oneshot.js', () => ({
  runRouterOneShot: (...args: unknown[]) => { runRouterOneShot(...args); return routerImpl(args[0]) },
  runGrokOneShot: (...args: unknown[]) => { runGrokOneShot(...args); return routerImpl(args[0]) },
  configureRouterOneShot: vi.fn(),
  setRouterOneShotDeviceConnected: vi.fn(),
  shutdownRouterOneShot: vi.fn(),
}))

// Import AFTER the mock is registered.
const { buildRouterPrompt, parseRouteOutput, routeVoiceTask, pickAgentHeuristic, chooseRouterEngine, routerModelFor } = await import('./voiceRouter.js')
type RouterAgent = import('./voiceRouter.js').RouterAgent

const AGENTS: RouterAgent[] = [
  { id: '1', name: 'Frontend', recentSummary: 'dark mode + settings page', engine: 'claude' },
  { id: '2', name: 'Auth', recentSummary: 'JWT refresh, login rate-limit', engine: 'claude' },
  { id: '3', name: 'DevOps', engine: 'claude' },
]

describe('parseRouteOutput', () => {
  it('parses a clean JSON object', () => {
    const d = parseRouteOutput('{"agentId":"2","confidence":0.9,"reason":"login","needNewAgent":false}', AGENTS)
    expect(d).toEqual({ agentId: '2', confidence: 0.9, reason: 'login', needNewAgent: false })
  })

  it('extracts JSON from a markdown code fence', () => {
    const raw = '```json\n{"agentId":"1","confidence":0.8,"reason":"ui","needNewAgent":false}\n```'
    expect(parseRouteOutput(raw, AGENTS).agentId).toBe('1')
  })

  it('extracts JSON wrapped in prose', () => {
    const raw = 'Sure! Here is the routing: {"agentId":"3","confidence":0.7,"reason":"deploy","needNewAgent":false} — done.'
    expect(parseRouteOutput(raw, AGENTS).agentId).toBe('3')
  })

  it('clamps confidence to [0,1]', () => {
    expect(parseRouteOutput('{"agentId":"1","confidence":5,"reason":"x","needNewAgent":false}', AGENTS).confidence).toBe(1)
    expect(parseRouteOutput('{"agentId":"1","confidence":-2,"reason":"x","needNewAgent":false}', AGENTS).confidence).toBe(0)
  })

  it('coerces a string confidence', () => {
    expect(parseRouteOutput('{"agentId":"1","confidence":"0.55","reason":"x","needNewAgent":false}', AGENTS).confidence).toBeCloseTo(0.55)
  })

  it('falls back to the closest (first) agent when the id is NOT in the machine (and caps confidence)', () => {
    const d = parseRouteOutput('{"agentId":"99","confidence":0.95,"reason":"x"}', AGENTS)
    expect(d.agentId).toBe('1')
    expect(d.needNewAgent).toBe(false)
    expect(d.confidence).toBeLessThanOrEqual(0.3)
  })

  it('falls back to the closest (first) agent when agentId is empty — never "no agent"', () => {
    const d = parseRouteOutput('{"agentId":"","confidence":0.2,"reason":"no fit"}', AGENTS)
    expect(d.agentId).toBe('1')
    expect(d.needNewAgent).toBe(false)
  })

  it('ignores a stray needNewAgent:true — a valid pick always wins', () => {
    const d = parseRouteOutput('{"agentId":"2","confidence":0.5,"reason":"auth","needNewAgent":true}', AGENTS)
    expect(d.needNewAgent).toBe(false)
    expect(d.agentId).toBe('2')
  })

  it('falls back to the closest agent (never needNewAgent) on malformed / non-JSON output', () => {
    for (const raw of ['', 'not json at all', '{ broken', 'null', '{"agentId":']) {
      const d = parseRouteOutput(raw, AGENTS)
      expect(d.needNewAgent).toBe(false)
      expect(d.agentId).toBe('1')
      expect(d.confidence).toBe(0)
    }
  })

  it('caps an overlong reason', () => {
    const d = parseRouteOutput(`{"agentId":"1","confidence":0.5,"reason":"${'x'.repeat(500)}","needNewAgent":false}`, AGENTS)
    expect(d.reason.length).toBeLessThanOrEqual(120)
  })
})

describe('buildRouterPrompt', () => {
  it('includes the transcript, each agent name, and the recent summary (or a placeholder)', () => {
    const p = buildRouterPrompt('sửa lỗi đăng nhập', AGENTS)
    expect(p).toContain('sửa lỗi đăng nhập')
    expect(p).toContain('name="Frontend"')
    expect(p).toContain('name="Auth"')
    expect(p).toContain('JWT refresh, login rate-limit')
    expect(p).toContain('(no activity yet)') // DevOps has no recentSummary
    expect(p).toMatch(/JSON/i)
    // Must instruct the model to always pick — no "none"/decline option.
    expect(p).toMatch(/always .*(pick|choose).*one agent|no "none"/i)
  })
})

describe('routeVoiceTask', () => {
  beforeEach(() => { runRouterOneShot.mockReset(); runGrokOneShot.mockReset(); routerImpl = async () => ({ text: '', sessionId: null }) })

  it('returns needNewAgent for an empty machine WITHOUT calling the LLM', async () => {
    const d = await routeVoiceTask('anything', [])
    expect(d.needNewAgent).toBe(true)
    expect(runRouterOneShot).not.toHaveBeenCalled()
  })

  it('short-circuits to the only agent WITHOUT calling the LLM', async () => {
    const d = await routeVoiceTask('anything', [{ id: '7', name: 'Solo' }])
    expect(d).toEqual({ agentId: '7', confidence: 1, reason: 'only agent in machine', needNewAgent: false })
    expect(runRouterOneShot).not.toHaveBeenCalled()
  })

  it('calls the LLM for >1 agent and parses its output', async () => {
    routerImpl = async () => ({ text: '{"agentId":"2","confidence":0.88,"reason":"auth","needNewAgent":false}', sessionId: null })
    const d = await routeVoiceTask('login broken', AGENTS)
    expect(runRouterOneShot).toHaveBeenCalledOnce()
    expect(d.agentId).toBe('2')
    expect(d.confidence).toBeCloseTo(0.88)
  })

  it('still picks the closest agent (never needNewAgent) when the LLM returns garbage', async () => {
    routerImpl = async () => ({ text: 'I cannot decide', sessionId: null })
    const d = await routeVoiceTask('login broken', AGENTS)
    expect(d.needNewAgent).toBe(false)
    expect(d.agentId).toBe('1')
  })

  it('falls back to a heuristic pick (never throws) when the one-shot TIMES OUT', async () => {
    routerImpl = async () => { throw new Error('claude one-shot timed out after 12000ms') }
    const d = await routeVoiceTask('fix the auth login please', AGENTS)
    expect(d.needNewAgent).toBe(false)
    expect(d.agentId).toBe('2')                 // "auth"/"login" → the Auth agent by name/recent match
    expect(d.confidence).toBeLessThanOrEqual(0.4)
  })

  it('RE-THROWS an AbortError (caller cancelled) rather than papering over it', async () => {
    routerImpl = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
    await expect(routeVoiceTask('anything', AGENTS)).rejects.toThrow('aborted')
  })
})

describe('pickAgentHeuristic', () => {
  it('matches the agent NAME (diacritic/case-insensitive)', () => {
    expect(pickAgentHeuristic('mở trang FRONTEND lên', AGENTS).agentId).toBe('1')
    expect(pickAgentHeuristic('auth bị lỗi', AGENTS).agentId).toBe('2')
  })

  it('uses recent activity when the name does not appear', () => {
    expect(pickAgentHeuristic('sửa dark mode', AGENTS).agentId).toBe('1')  // recent: "dark mode + settings"
  })

  it('returns the first agent (never needNewAgent) when nothing matches', () => {
    const d = pickAgentHeuristic('xyzzy nothing relevant', AGENTS)
    expect(d.agentId).toBe('1')
    expect(d.needNewAgent).toBe(false)
    expect(d.confidence).toBeLessThanOrEqual(0.3)
  })
})

/**
 * Which CLI classifies the route. It used to be Claude and only Claude, so a machine without it never
 * routed at all: the warm spawn failed on a loop and every voice fell through to name matching, whose
 * capped confidence can never clear the backend's 0.75 auto-dispatch threshold. The live agent list is the
 * evidence — a running agent proves its CLI exists and is logged in.
 */
describe('chooseRouterEngine', () => {
  it('prefers Claude when the user actually has a Claude agent', () => {
    expect(chooseRouterEngine([{ engine: 'codex' }, { engine: 'claude' }, { engine: 'commandcode' }])).toBe('claude')
  })

  it('picks by priority when there is no Claude agent', () => {
    expect(chooseRouterEngine([{ engine: 'commandcode' }, { engine: 'codex' }])).toBe('codex')
    expect(chooseRouterEngine([{ engine: 'commandcode' }])).toBe('commandcode')
    expect(chooseRouterEngine([{ engine: 'opencode' }, { engine: 'cursor' }])).toBe('cursor')
  })

  it('returns null when nothing can serve the router', () => {
    // Hermes and Devin take the prompt as argv, so they cannot be warmed or run as a one-shot here.
    expect(chooseRouterEngine([{ engine: 'hermes' }, { engine: 'devin' }])).toBeNull()
    expect(chooseRouterEngine([])).toBeNull()
  })

  it('uses Grok when it is the only routable CLI', () => {
    expect(chooseRouterEngine([{ engine: 'grok' }, { engine: 'hermes' }])).toBe('grok')
  })
})

describe('routeVoiceTask engine selection', () => {
  beforeEach(() => { runRouterOneShot.mockReset(); runGrokOneShot.mockReset(); routerImpl = async () => ({ text: '', sessionId: null }) })

  it('classifies with the engine the agents run on', async () => {
    routerImpl = async () => ({ text: '{"agentId":"2","confidence":0.9,"reason":"auth"}', sessionId: null })
    const codexAgents: RouterAgent[] = [
      { id: '1', name: 'Frontend', engine: 'codex' },
      { id: '2', name: 'Auth', engine: 'codex' },
    ]
    const d = await routeVoiceTask('login broken', codexAgents)
    expect(runRouterOneShot).toHaveBeenCalledOnce()
    expect(runRouterOneShot.mock.calls[0][0]).toBe('codex')   // NOT claude
    expect(d.agentId).toBe('2')
  })

  it('lets a non-Claude engine use the model the user already selected', async () => {
    // Naming a model per engine sent Codex a frontier model for a 20-word classification, and any id the
    // user's account or CLI version rejects fails the one-shot — which drops the route back to name
    // matching, silently. The selected model is the one model guaranteed to run.
    expect(routerModelFor('codex')).toBe('')
    expect(routerModelFor('commandcode')).toBe('')
    expect(routerModelFor('cursor')).toBe('')
    routerImpl = async () => ({ text: '{"agentId":"1","confidence":0.9,"reason":"x"}', sessionId: null })
    await routeVoiceTask('anything', [
      { id: '1', name: 'A', engine: 'codex' },
      { id: '2', name: 'B', engine: 'codex' },
    ])
    expect((runRouterOneShot.mock.calls[0][1] as { model?: string }).model).toBe('')
  })

  it('routes a Grok-only machine through the isolated direct one-shot', async () => {
    routerImpl = async () => ({ text: '{"agentId":"2","confidence":0.9,"reason":"auth"}', sessionId: null })
    const agents: RouterAgent[] = [
      { id: '1', name: 'Frontend', engine: 'grok' },
      { id: '2', name: 'Auth', engine: 'grok' },
    ]
    await expect(routeVoiceTask('login broken', agents)).resolves.toMatchObject({ agentId: '2' })
    expect(runGrokOneShot).toHaveBeenCalledOnce()
    expect(runRouterOneShot).not.toHaveBeenCalled()
  })

  it('keeps Claude on its own small model', () => {
    // Haiku is on every Claude plan and routing has a 12s budget; Opus for a classification is waste.
    expect(routerModelFor('claude')).toBe('haiku')
  })

  it('goes straight to the heuristic — no spawn — when no agent can serve it', async () => {
    const argvOnly: RouterAgent[] = [
      { id: '1', name: 'Frontend', engine: 'hermes' },
      { id: '2', name: 'Auth', recentSummary: 'login rate-limit', engine: 'devin' },
    ]
    const d = await routeVoiceTask('fix the auth login please', argvOnly)
    expect(runRouterOneShot).not.toHaveBeenCalled()   // a doomed spawn on every voice is the thing to avoid
    expect(d.agentId).toBe('2')                       // still a real pick, by name/recent match
    expect(d.confidence).toBeLessThanOrEqual(0.4)     // and never enough to auto-dispatch
  })
})
