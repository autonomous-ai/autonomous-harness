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

// The gateway path: a machine whose agents run through OpenRouter classifies with one direct call.
const resolveOpenRouterKey = vi.fn()
const openRouterComplete = vi.fn()
vi.mock('./openrouter.js', () => ({
  resolveOpenRouterKey: (...args: unknown[]) => resolveOpenRouterKey(...args),
  openRouterComplete: (...args: unknown[]) => openRouterComplete(...args),
}))

// Import AFTER the mock is registered.
const { buildRouterPrompt, parseRouteOutput, routeVoiceTask, pickAgentHeuristic, chooseRouterEngine, routerModelFor, ROUTE_SCORED_ROWS, CONTINUITY_WINDOW_MS } = await import('./voiceRouter.js')
type RouterAgent = import('./voiceRouter.js').RouterAgent

const AGENTS: RouterAgent[] = [
  { id: '1', name: 'Frontend', recentSummary: 'dark mode + settings page', engine: 'claude' },
  { id: '2', name: 'Auth', recentSummary: 'JWT refresh, login rate-limit', engine: 'claude' },
  { id: '3', name: 'DevOps', engine: 'claude' },
]

describe('parseRouteOutput', () => {
  it('parses a clean JSON object', () => {
    const d = parseRouteOutput('{"agentId":"2","confidence":0.9,"reason":"login","needNewAgent":false}', AGENTS)
    expect(d).toMatchObject({ agentId: '2', confidence: 0.9, reason: 'login', needNewAgent: false })
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

describe('the second world war, then the first', () => {
  // The exact sequence from the desk, 2026-09-09: WW2 was routed to the history agent, and 19 seconds
  // later "…thứ nhất…" was routed to an agent about the World Cup with 0.4 confidence. Three separate
  // defects lined up, and each one is pinned below.
  const HISTORY = '562d0376'
  const WORLDCUP = '58998f92'
  const WW1 = 'Chiến tranh thế giới thứ nhất kết thúc vào năm nào?'

  /** As the agents looked at that moment: names are previous questions, recaps are bare answers. */
  const DESK: RouterAgent[] = [
    { id: WORLDCUP, name: 'Worldcup dc to chuc may lan roi', recentSummary: 'World Cup được tổ chức mấy lần rồi', engine: 'claude' },
    { id: HISTORY, name: 'Thomas Edison vs Nikola Tesla', recentSummary: 'Chiến tranh thế giới thứ hai kết thúc vào năm nào?', engine: 'claude' },
    { id: 'dbae0db4', name: 'Ai sang tác bài thơ Bình ngô đại cáo', recentSummary: 'ai sáng tác bài thơ đó', engine: 'claude' },
  ]

  it('follows the conversation when the recap is only the answer', () => {
    // What the router used to see for the history agent was the RECAP of that turn — the model answered
    // "1945.", so that is what the recap said, and it shares nothing with the next question.
    const answersOnly = DESK.map((agent) =>
      agent.id === HISTORY ? { ...agent, recentSummary: '1945.' } : agent)
    expect(pickAgentHeuristic(WW1, answersOnly).agentId).not.toBe(HISTORY)   // the bug, preserved

    // With the QUESTION on record instead, the same matcher lands on the history agent.
    expect(pickAgentHeuristic(WW1, DESK).agentId).toBe(HISTORY)
  })

  it('does not let function words decide it', () => {
    // "thế giới" and "năm" appear in both the question and the World Cup agent's history. They are the
    // most common words in the sentence and they carried the whole ranking.
    const stripped = DESK.map((agent) =>
      agent.id === HISTORY ? { ...agent, recentSummary: '1945.' } : agent)
    const decision = pickAgentHeuristic(WW1, stripped)
    // Nothing genuinely matches now, so it must not claim a match — 0.2 is "closest agent", not a hit.
    expect(decision.confidence).toBe(0.2)
    expect(decision.reason).toContain('closest agent')
  })

  it('carries a follow-up back to the agent just spoken to, even with nothing else to go on', () => {
    // A follow-up that shares no content words at all with anything on the desk.
    const bare = 'còn cái thứ nhất thì sao'
    expect(pickAgentHeuristic(bare, DESK, { agentId: HISTORY, agoMs: 19_000 }).agentId).toBe(HISTORY)
    // …and lets go once the conversation has plainly ended.
    const stale = pickAgentHeuristic(bare, DESK, { agentId: HISTORY, agoMs: 45 * 60_000 })
    expect(stale.agentId).not.toBe(HISTORY)
  })

  it('does not let continuity beat an agent the words actually name', () => {
    const named = pickAgentHeuristic('worldcup tổ chức mấy lần', DESK, { agentId: HISTORY, agoMs: 5_000 })
    expect(named.agentId).toBe(WORLDCUP)
  })

  it('tells the model what it was just talking to, and stops when the window closes', () => {
    const fresh = buildRouterPrompt(WW1, DESK, { agentId: HISTORY, agoMs: 19_000 })
    expect(fresh).toContain(`id=${HISTORY} 19s ago`)
    const stale = buildRouterPrompt(WW1, DESK, { agentId: HISTORY, agoMs: CONTINUITY_WINDOW_MS + 1 })
    expect(stale).not.toContain('Continuity:')
  })

  it('stops teaching the model that agent names are job titles', () => {
    // Every agent on this desk is named after the first thing it was asked. The old prompt insisted
    // names were roles like "Frontend"/"Auth", which describes nobody here.
    const prompt = buildRouterPrompt(WW1, DESK)
    expect(prompt).toContain('it is not always a role')
    expect(prompt).toContain('recently asked')
  })
})

describe('a bar on every row', () => {
  // The picker offers every agent that was weighed. A row with no number on it reads as one the router
  // rejected, so "we only scored the top three" is a bug you can see from across the room.
  const SIX: RouterAgent[] = [
    { id: '1', name: 'Frontend', recentSummary: 'dark mode', engine: 'claude' },
    { id: '2', name: 'Auth', recentSummary: 'JWT refresh', engine: 'claude' },
    { id: '3', name: 'DevOps', engine: 'claude' },
    { id: '4', name: 'Billing', engine: 'claude' },
    { id: '5', name: 'Search', engine: 'claude' },
    { id: '6', name: 'Mobile', engine: 'claude' },
  ]

  it('scores five rows in all — the pick and four — however many the model sends', () => {
    const alternates = ['2', '3', '4', '5', '6'].map((id, i) => `{"agentId":"${id}","confidence":${0.5 - i * 0.05}}`)
    const decision = parseRouteOutput(
      `{"agentId":"1","confidence":0.6,"reason":"x","alternates":[${alternates.join(',')}]}`,
      SIX,
    )
    // Four alternates beside the pick. The sixth agent still appears in the picker — it simply carries
    // no bar, which says "not ranked", not "rejected".
    expect(decision.scores?.map((score) => score.agentId)).toEqual(['2', '3', '4', '5'])
  })

  it('still drops what it should — unknown ids, repeats of the pick, and junk numbers', () => {
    const decision = parseRouteOutput(
      '{"agentId":"1","confidence":0.6,"reason":"x","alternates":['
      + '{"agentId":"2","confidence":0.5},'
      + '{"agentId":"99","confidence":0.4},'   // not on this machine
      + '{"agentId":"1","confidence":0.9},'    // the pick again
      + '{"agentId":"2","confidence":0.3},'    // a repeat
      + '{"agentId":"3","confidence":"nope"}'  // not a number
      + ']}',
      SIX,
    )
    expect(decision.scores).toEqual([{ agentId: '2', confidence: 0.5 }])
  })

  it('draws the same number of bars when the name matcher stands in', () => {
    const decision = pickAgentHeuristic('sua dark mode', SIX)
    // The picker must not change shape depending on which half of the router answered — and every score
    // stays under the winner, which is what the cap at 0.4 protects: these draw a bar, they never cross
    // a dispatch threshold.
    expect(decision.scores).toHaveLength(ROUTE_SCORED_ROWS - 1)
    for (const score of decision.scores ?? []) {
      expect(score.confidence).toBeGreaterThan(0)
      expect(score.confidence).toBeLessThan(decision.confidence)
    }
  })

  it('asks the model for exactly as many as the picker will draw', () => {
    const prompt = buildRouterPrompt('fix the login screen', SIX)
    expect(prompt).toContain(`up to ${ROUTE_SCORED_ROWS - 1}`)
    // The three caps drifted apart once — the prompt asked for two while the name matcher scored three —
    // and the only symptom was bars missing from a list nobody thought to count.
    expect(prompt).not.toContain('up to 2')
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
    expect(d).toMatchObject({ agentId: '7', confidence: 1, reason: 'only agent in machine', needNewAgent: false })
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

describe('routeVoiceTask through an OpenRouter gateway', () => {
  const gatewayAgents: RouterAgent[] = [
    { id: '1', name: 'Frontend', engine: 'claude', gateway: 'ori' },
    { id: '2', name: 'Auth', engine: 'claude', gateway: 'ori' },
  ]

  beforeEach(() => {
    runRouterOneShot.mockReset(); runGrokOneShot.mockReset()
    routerImpl = async () => ({ text: '', sessionId: null })
    resolveOpenRouterKey.mockReset(); openRouterComplete.mockReset()
  })

  it('classifies with one direct call instead of warming a vendor one-shot', async () => {
    resolveOpenRouterKey.mockResolvedValue('sk-or-v1-test')
    openRouterComplete.mockResolvedValue('{"agentId":"2","confidence":0.9,"reason":"auth","needNewAgent":false}')

    const d = await routeVoiceTask('login broken', gatewayAgents)

    expect(d.agentId).toBe('2')
    expect(openRouterComplete).toHaveBeenCalledOnce()
    expect(runRouterOneShot).not.toHaveBeenCalled()
  })

  it('falls through to the engine one-shot when the gateway cannot answer', async () => {
    resolveOpenRouterKey.mockResolvedValue('sk-or-v1-test')
    openRouterComplete.mockResolvedValue(null)
    routerImpl = async () => ({ text: '{"agentId":"1","confidence":0.7,"reason":"ui"}', sessionId: null })

    const d = await routeVoiceTask('dark mode', gatewayAgents)

    expect(d.agentId).toBe('1')
    expect(runRouterOneShot).toHaveBeenCalledOnce()
  })

  it('takes the direct call on ANY machine that has a key, not just a gateway one', async () => {
    // Widened deliberately. The engine path spawns a whole agent runtime to answer a twenty-word
    // classification — about 15s here against a 20s ceiling, and a third of them never come back. A
    // machine holding a key should not pay that just because none of its agents runs on the gateway.
    resolveOpenRouterKey.mockResolvedValue('sk-or-v1-test')
    openRouterComplete.mockResolvedValue('{"agentId":"2","confidence":0.9,"reason":"auth"}')

    const d = await routeVoiceTask('login broken', AGENTS)

    expect(d.agentId).toBe('2')
    expect(openRouterComplete).toHaveBeenCalledOnce()
    expect(runRouterOneShot).not.toHaveBeenCalled()
  })

  it('still spawns the engine when there is no key to call with', async () => {
    // The common case, and the one that must not change: no credential, so nothing to call directly.
    resolveOpenRouterKey.mockResolvedValue(null)
    routerImpl = async () => ({ text: '{"agentId":"2","confidence":0.9,"reason":"auth"}', sessionId: null })

    const d = await routeVoiceTask('login broken', AGENTS)

    expect(d.agentId).toBe('2')
    expect(openRouterComplete).not.toHaveBeenCalled()
    expect(runRouterOneShot).toHaveBeenCalledOnce()
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

describe('the runners-up carry a fit, and only for display', () => {
  const agents = [
    { id: 'a1', name: 'auth api' },
    { id: 'a2', name: 'payment api' },
    { id: 'a3', name: 'web' },
  ]

  it('reads alternates the model ranked', () => {
    const decision = parseRouteOutput(
      '{"agentId":"a1","confidence":0.44,"reason":"close","alternates":[{"agentId":"a2","confidence":0.3},{"agentId":"a3","confidence":0.12}]}',
      agents,
    )
    expect(decision.agentId).toBe('a1')
    expect(decision.scores).toEqual([
      { agentId: 'a2', confidence: 0.3 },
      { agentId: 'a3', confidence: 0.12 },
    ])
  })

  it('drops an alternate the machine does not have, and the winner repeated', () => {
    // A bar drawn for an agent that is not there is worse than no bar: the person would pick it.
    const decision = parseRouteOutput(
      '{"agentId":"a1","confidence":0.4,"alternates":[{"agentId":"ghost","confidence":0.9},{"agentId":"a1","confidence":0.4},{"agentId":"a2","confidence":"high"},{"agentId":"a3","confidence":0.2}]}',
      agents,
    )
    expect(decision.scores).toEqual([{ agentId: 'a3', confidence: 0.2 }])
  })

  it('an answer with no alternates is still an answer', () => {
    const decision = parseRouteOutput('{"agentId":"a2","confidence":0.9}', agents)
    expect(decision.agentId).toBe('a2')
    expect(decision.scores).toEqual([])
  })

  it('the heuristic ranks under its own winner and never over the cap', () => {
    // The 0.4 cap is what stops a router that could not run from ever dispatching on its own, so the
    // runners-up have to sit BELOW it — they are a picture of a ranking, not a threshold.
    const decision = pickAgentHeuristic('fix the payment api retry', [
      { id: 'a1', name: 'auth api' },
      { id: 'a2', name: 'payment api' },
      { id: 'a3', name: 'web' },
    ])
    expect(decision.agentId).toBe('a2')
    expect(decision.confidence).toBe(0.4)
    for (const score of decision.scores ?? []) {
      expect(score.confidence).toBeLessThan(0.4)
      expect(score.confidence).toBeGreaterThan(0)
    }
  })

  it('with nothing matching, the winner is still the first agent', () => {
    // Unchanged behaviour, pinned: the sort must not quietly reorder a no-match list.
    const decision = pickAgentHeuristic('zzz qqq', agents)
    expect(decision.agentId).toBe('a1')
    expect(decision.confidence).toBe(0.2)
  })

  it('the label of how it was decided rides on the decision', () => {
    // An unsure model and a router that could not run both land low ON PURPOSE. Without this they are
    // the same thing on screen, and they need different sentences.
    const only = pickAgentHeuristic('anything', [{ id: 'solo', name: 'solo' }])
    expect(only.agentId).toBe('solo')
  })
})
