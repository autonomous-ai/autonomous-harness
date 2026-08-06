import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dataDir = ''

async function loadRegistryModule() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  process.env.CLAUDE_PROJECTS_DIR = dataDir
  process.env.CODEX_HOME = dataDir
  process.env.CURSOR_HOME = dataDir
  return import('./registry.js')
}

describe('registry remote display names', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-registry-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dataDir, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
    delete process.env.CLAUDE_PROJECTS_DIR
    delete process.env.CODEX_HOME
    delete process.env.CURSOR_HOME
  })

  it('persists renamed display names independently from session removal', async () => {
    const transcriptPath = join(dataDir, 'session-1.jsonl')
    writeFileSync(transcriptPath, '{}\n')

    const { registry, projectDisplayName } = await loadRegistryModule()
    registry.load()
    const registered = registry.register({ launcherId: 'h1', sessionId: 'session-1', transcriptPath, tmuxPane: '%1', cwd: '/tmp/demo' })
    expect(registered?.entry).toBeTruthy()
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toMatchObject([
      { sessionId: 'session-1', transcriptPath },
    ])

    const renamed = registry.rename('session-1', 'Production API')
    expect(renamed).toBeTruthy()
    expect(projectDisplayName(registered!.entry)).toBe('Production API')

    const persisted = JSON.parse(readFileSync(join(dataDir, 'agent-names.json'), 'utf-8')) as Record<string, string>
    expect(persisted).toEqual({ 'session-1': 'Production API' })

    registry.remove('session-1')
    expect(registry.get('session-1')).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([])
    expect(JSON.parse(readFileSync(join(dataDir, 'agent-names.json'), 'utf-8'))).toEqual({ 'session-1': 'Production API' })
  })

  it('loads persisted names for active sessions', async () => {
    const transcriptPath = join(dataDir, 'session-2.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    writeFileSync(join(dataDir, 'agent-names.json'), JSON.stringify({ 'session-2': 'Research box' }))
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify([{
      launcherId: 'h1',
      sessionId: 'session-2',
      transcriptPath,
      projectDir: 'tmp-demo',
      cwd: '/tmp/demo',
      tmuxPane: '%2',
      source: null,
      title: null,
      model: null,
      registeredAt: 1,
      updatedAt: 1,
    }]))

    const { registry, projectDisplayName } = await loadRegistryModule()
    registry.load()
    const session = registry.get('session-2')
    expect(session).toBeTruthy()
    expect(session?.engine).toBe('claude')
    expect(projectDisplayName(session!)).toBe('Research box')
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))[0]).toMatchObject({
      sessionId: 'session-2',
      engine: 'claude',
      tmuxPane: '%2',
    })
  })

  it('auto-follows the tmux pane title until renamed, then the manual name stays fixed', async () => {
    const transcriptPath = join(dataDir, 'session-title.jsonl')
    writeFileSync(transcriptPath, '{}\n')

    const { registry, projectDisplayName } = await loadRegistryModule()
    registry.load()
    const registered = registry.register({
      launcherId: 'h1',
      sessionId: 'session-title',
      transcriptPath,
      tmuxPane: '%7',
      cwd: '/tmp/demo',
      title: '📋 ✳ Clarify assistant identity',
    })
    expect(registered?.entry).toBeTruthy()
    expect(registered?.entry.title).toBe('Clarify assistant identity')
    // Un-renamed: display auto-follows the tmux title.
    expect(projectDisplayName(registered!.entry)).toBe('Clarify assistant identity')

    const updated = registry.updateTitle('session-title', '🧪 — * Ship settings page')
    expect(updated?.title).toBe('Ship settings page')
    expect(projectDisplayName(updated!)).toBe('Ship settings page')

    // After a manual rename the override wins and is FIXED — it must NOT drift back to the title.
    registry.rename('session-title', 'Manual name')
    expect(projectDisplayName(updated!)).toBe('Manual name')

    // A later tmux-title change (Claude rewrites it to the latest topic) does not move the display name.
    const retitled = registry.updateTitle('session-title', '⚡ New convo topic')
    expect(retitled?.title).toBe('New convo topic') // internal title still tracked
    expect(projectDisplayName(retitled!)).toBe('Manual name') // display stays fixed
  })

  it('only adds or updates agent-names.json entries', async () => {
    const transcriptPath = join(dataDir, 'session-3.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    writeFileSync(join(dataDir, 'agent-names.json'), JSON.stringify({ old: 'Keep me' }))

    const { registry } = await loadRegistryModule()
    registry.load()
    registry.register({ launcherId: 'h1', sessionId: 'session-3', transcriptPath, tmuxPane: '%3', cwd: '/tmp/demo' })
    registry.rename('session-3', 'New name')

    expect(JSON.parse(readFileSync(join(dataDir, 'agent-names.json'), 'utf-8'))).toEqual({
      old: 'Keep me',
      'session-3': 'New name',
    })
  })

  it('persists Codex engine metadata and rejects records without a valid pane', async () => {
    const sessionsDir = join(dataDir, 'sessions')
    const transcriptPath = join(sessionsDir, 'codex-session.jsonl')
    mkdirSync(sessionsDir)
    writeFileSync(transcriptPath, '{}\n')

    const { registry } = await loadRegistryModule()
    registry.load()
    registry.register({
      launcherId: 'h1',
      engine: 'codex',
      sessionId: 'codex-session',
      transcriptPath,
      tmuxPane: '%4',
      cwd: '/tmp/codex',
    })
    const valid = registry.get('codex-session')
    expect(valid?.engine).toBe('codex')

    const persisted = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    persisted.push({ ...persisted[0], sessionId: 'invalid-session', tmuxPane: 'not-a-pane' })
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify(persisted))

    registry.load()
    expect(registry.get('codex-session')?.engine).toBe('codex')
    expect(registry.get('invalid-session')).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toHaveLength(1)
  })

  it('repairs a Codex parent registry entry overwritten with a child rollout', async () => {
    const parentId = '019f7f1b-195d-70f2-861b-de5d54a3e141'
    const childId = '019f8dae-e5f4-7c11-90d1-600854063b2c'
    const sessionsDir = join(dataDir, 'sessions', '2026', '07', '23')
    mkdirSync(sessionsDir, { recursive: true })
    const parentPath = join(sessionsDir, `rollout-${parentId}.jsonl`)
    const childPath = join(sessionsDir, `rollout-${childId}.jsonl`)
    writeFileSync(parentPath, JSON.stringify({
      type: 'session_meta',
      payload: { id: parentId, source: 'cli' },
    }) + '\n')
    writeFileSync(childPath, JSON.stringify({
      type: 'session_meta',
      payload: {
        id: childId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
      },
    }) + '\n')
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify([{
      launcherId: 'h1',
      sessionId: parentId,
      engine: 'codex',
      transcriptPath: childPath,
      projectDir: '23',
      cwd: '/tmp/codex',
      tmuxPane: '%8',
      source: null,
      title: null,
      model: null,
      cliVersion: '0.144.6',
      processIdentity: null,
      registeredAt: 1,
      updatedAt: 1,
      lastHookAt: 1,
      lastTranscriptAt: 1,
    }]))

    const { registry } = await loadRegistryModule()
    registry.load()

    expect(registry.get(parentId)?.transcriptPath).toBe(parentPath)
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))[0].transcriptPath).toBe(parentPath)
    expect(registry.register({
      launcherId: 'h1',
      engine: 'codex',
      sessionId: parentId,
      transcriptPath: childPath,
      tmuxPane: '%8',
    })).toBeNull()
  })

  it('clears stale process identity for lowercase Cursor sessionStart hooks', async () => {
    const sessionId = '53d3843c-724e-47ff-ae3a-9fedfa328bba'
    const transcriptPath = join(
      dataDir,
      'projects',
      'workspace',
      'agent-transcripts',
      sessionId,
      `${sessionId}.jsonl`,
    )
    mkdirSync(join(transcriptPath, '..'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')
    const { registry } = await loadRegistryModule()
    registry.load()
    registry.register({
      launcherId: 'h1',
      engine: 'cursor',
      sessionId,
      transcriptPath,
      tmuxPane: '%3',
      processIdentity: { pid: 100, executable: 'agent', startMarker: 'old' },
      hookEvent: 'beforeSubmitPrompt',
    })

    const resumed = registry.register({
      launcherId: 'h1',
      engine: 'cursor',
      sessionId,
      transcriptPath,
      tmuxPane: '%3',
      hookEvent: 'sessionStart',
    })

    expect(resumed?.entry.processIdentity).toBeNull()
  })

  it('persists a pending Cursor session and attaches its exact transcript later', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    expect(registry.register({
      launcherId: 'h1',
      engine: 'cursor',
      sessionId: '12345678-1234-1234-1234-123456789abc',
      tmuxPane: '%5',
      cwd: '/tmp/cursor',
      cliVersion: '2026.07.20-8cc9c0b',
    })?.entry.transcriptPath).toBeNull()

    registry.load()
    expect(registry.get('12345678-1234-1234-1234-123456789abc')?.transcriptPath).toBeNull()

    const transcript = join(
      dataDir,
      'projects',
      'workspace',
      'agent-transcripts',
      '12345678-1234-1234-1234-123456789abc',
      '12345678-1234-1234-1234-123456789abc.jsonl',
    )
    mkdirSync(join(transcript, '..'), { recursive: true })
    writeFileSync(transcript, '{}\n')
    const attached = registry.register({
      launcherId: 'h1',
      engine: 'cursor',
      sessionId: '12345678-1234-1234-1234-123456789abc',
      transcriptPath: transcript,
      tmuxPane: '%5',
    })
    expect(attached?.entry.transcriptPath).toBe(transcript)
  })
})

describe('registry model coercion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-registry-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dataDir, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
    delete process.env.CLAUDE_PROJECTS_DIR
    delete process.env.CODEX_HOME
    delete process.env.CURSOR_HOME
  })

  // Claude Code's hooks report `model` as {id, display_name}. Persisting that object took the daemon down
  // at STARTUP (runtimeProfile called .toLowerCase() on it) — and no restart could heal it, because the bad
  // value was already on disk.
  it('stores the id when the hook reports a model object', async () => {
    const transcriptPath = join(dataDir, 'm1.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    const { registry } = await loadRegistryModule()
    registry.load()
    registry.register({
      launcherId: 'h1',
      sessionId: 'm1', transcriptPath, tmuxPane: '%1', cwd: '/tmp/demo',
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' } as unknown as string,
    })
    expect(registry.get('m1')?.model).toBe('claude-opus-4-8')
  })

  it('keeps a plain string and drops anything else', async () => {
    const transcriptPath = join(dataDir, 'm2.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    const { registry } = await loadRegistryModule()
    registry.load()
    registry.register({ launcherId: 'h1', sessionId: 'm2', transcriptPath, tmuxPane: '%1', cwd: '/tmp/demo', model: 'gpt-5.6-sol' })
    expect(registry.get('m2')?.model).toBe('gpt-5.6-sol')
    // A SECOND launcher, not the same one: one launcher owns one pane owns one agent, so registering
    // another session under 'h1' would be a rotation (which inherits the previous model) rather than the
    // fresh record this coercion check needs.
    registry.register({ launcherId: 'h2', sessionId: 'm3', transcriptPath, tmuxPane: '%2', cwd: '/tmp/demo', model: 42 as unknown as string })
    expect(registry.get('m3')?.model).toBeNull()
  })
})

/**
 * A Command Code session announces itself BEFORE its transcript exists, so the path used to arrive only
 * with the first Stop hook — after the first turn had already failed for want of a watcher.
 */
describe('a Command Code session without a transcript path', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-registry-cc-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    delete process.env.COMMANDCODE_HOME
  })

  it('gets the deterministic one derived from its cwd', async () => {
    process.env.COMMANDCODE_HOME = dataDir
    const { registry } = await loadRegistryModule()
    registry.load()
    const registered = registry.register({
      launcherId: 'h1',
      engine: 'commandcode',
      sessionId: 'ae93cc89-0dff-452a-a875-33b1516bbc80',
      tmuxPane: '%9',
      cwd: '/Users/me/Working/Tmux/Agent-6',
    })
    // The file does not exist yet — that is the whole point. The watcher opens at offset 0 and chokidar
    // delivers the lines when the CLI finally writes them.
    expect(registered?.entry.transcriptPath).toBe(
      join(dataDir, 'projects', 'users-me-working-tmux-agent-6', 'ae93cc89-0dff-452a-a875-33b1516bbc80.jsonl'),
    )
  })

  it('keeps a path the CLI reported over the derived one', async () => {
    process.env.COMMANDCODE_HOME = dataDir
    const { registry } = await loadRegistryModule()
    registry.load()
    const reported = join(dataDir, 'projects', 'somewhere-else', 'reported.jsonl')
    mkdirSync(join(dataDir, 'projects', 'somewhere-else'), { recursive: true })
    writeFileSync(reported, '')
    const registered = registry.register({
      launcherId: 'h1',
      engine: 'commandcode',
      sessionId: 'reported',
      tmuxPane: '%9',
      cwd: '/Users/me/Working/Tmux/Agent-6',
      transcriptPath: reported,
    })
    expect(registered?.entry.transcriptPath).toBe(reported)
  })
})

describe('agent identity: the launcher owns the agent, the session is bound to it', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-registry-id-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dataDir, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
    delete process.env.CLAUDE_PROJECTS_DIR
    delete process.env.CODEX_HOME
    delete process.env.CURSOR_HOME
  })

  function transcript(name: string): string {
    const p = join(dataDir, `${name}.jsonl`)
    writeFileSync(p, '{}\n')
    return p
  }

  it('resolves a record by EITHER id', async () => {
    // Web and device address turn control with a bare sessionId (`cancel`, `question_response`) and
    // everything else with the agentId; both have to land on the same record.
    const { registry } = await loadRegistryModule()
    registry.load()
    const res = registry.register({ launcherId: 'agent-1', sessionId: 's1', transcriptPath: transcript('s1'), tmuxPane: '%1', cwd: '/tmp/demo' })
    expect(res?.entry.agentId).toBe('agent-1')
    expect(registry.resolve('agent-1')?.sessionId).toBe('s1')
    expect(registry.resolve('s1')?.agentId).toBe('agent-1')
    expect(registry.byAgent('s1')).toBeUndefined()
    expect(registry.bySession('agent-1')).toBeUndefined()
  })

  it('a rotation rebinds the SAME agent instead of creating a second one', async () => {
    // `/clear` in claude (and `/new` in opencode) ends one session id and starts another in the same pane
    // under the same launcher. That is one agent with a new session underneath, not two agents.
    const { registry } = await loadRegistryModule()
    registry.load()
    registry.register({ launcherId: 'agent-1', sessionId: 's1', transcriptPath: transcript('s1'), tmuxPane: '%1', cwd: '/tmp/demo' })
    const rot = registry.register({ launcherId: 'agent-1', sessionId: 's2', transcriptPath: transcript('s2'), tmuxPane: '%1', cwd: '/tmp/demo' })

    expect(rot?.rebound).toBe('s1')
    expect(rot?.isNew).toBe(true)          // the SESSION is new — the caller still announces it
    expect(registry.list()).toHaveLength(1)
    expect(registry.byAgent('agent-1')?.sessionId).toBe('s2')
    expect(registry.bySession('s1')).toBeUndefined()   // the dead session no longer resolves
    expect(registry.resolve('agent-1')?.boundAt).toBe(Date.now())
  })

  it('a re-register of the same session is not a rotation', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    registry.register({ launcherId: 'agent-1', sessionId: 's1', transcriptPath: transcript('s1'), tmuxPane: '%1', cwd: '/tmp/demo' })
    const again = registry.register({ launcherId: 'agent-1', sessionId: 's1', transcriptPath: transcript('s1'), tmuxPane: '%1', cwd: '/tmp/demo' })
    expect(again?.isNew).toBe(false)
    expect(again?.rebound).toBeNull()
    expect(registry.list()).toHaveLength(1)
  })

  it('one engine session cannot belong to two agents', async () => {
    // `claude --resume <id>` in a second pane: the newest bind wins and the loser is dropped rather than
    // left pointing at a session it no longer owns.
    const { registry } = await loadRegistryModule()
    registry.load()
    registry.register({ launcherId: 'agent-1', sessionId: 's1', transcriptPath: transcript('s1'), tmuxPane: '%1', cwd: '/tmp/demo' })
    registry.register({ launcherId: 'agent-2', sessionId: 's1', transcriptPath: transcript('s1'), tmuxPane: '%2', cwd: '/tmp/demo' })
    expect(registry.list()).toHaveLength(1)
    expect(registry.resolve('s1')?.agentId).toBe('agent-2')
    expect(registry.byAgent('agent-1')).toBeUndefined()
  })

  it('accepts a payload from an OLD launcher, which knows only launcherId', async () => {
    // A launcher started before this build owns the tty and cannot upgrade itself, so it keeps sending
    // the v1 `open` frame and its hook keeps posting `launcherId` alone — for hours. That id IS the agent
    // id, so nothing new is required on the wire: the daemon just reinterprets what it already receives.
    const { registry } = await loadRegistryModule()
    registry.load()
    const res = registry.register({ launcherId: 'old-launcher', sessionId: 's1', transcriptPath: transcript('s1'), tmuxPane: '%1', cwd: '/tmp/demo' })
    expect(res?.entry.agentId).toBe('old-launcher')
    expect(registry.resolve('old-launcher')?.sessionId).toBe('s1')
    // …and its rotation still lands on the same agent.
    const rot = registry.register({ launcherId: 'old-launcher', sessionId: 's2', transcriptPath: transcript('s2'), tmuxPane: '%1', cwd: '/tmp/demo' })
    expect(rot?.rebound).toBe('s1')
    expect(registry.list()).toHaveLength(1)
  })

  it('creates an agent at launcher open, before any engine session exists', async () => {
    // `harness <engine>` must put an agent on screen the moment it is typed — the engine has not picked a
    // session yet, and for a resumed one it may never report a NEW id at all.
    const { registry, projectDisplayName } = await loadRegistryModule()
    registry.load()
    const opened = registry.openAgent({ agentId: 'agent-1', engine: 'claude', tmuxPane: '%1', cwd: '/tmp/demo' })
    expect(opened?.isNew).toBe(true)
    expect(opened?.entry.sessionId).toBe('')
    expect(registry.unbound().map((s) => s.agentId)).toEqual(['agent-1'])
    expect(registry.resolve('agent-1')?.agentId).toBe('agent-1')
    expect(projectDisplayName(opened!.entry)).toContain('demo')   // nameable while unbound

    // The engine reports its session later — same agent, now bound.
    const bound = registry.register({ launcherId: 'agent-1', sessionId: 's1', transcriptPath: transcript('s1'), tmuxPane: '%1', cwd: '/tmp/demo' })
    expect(bound?.entry.agentId).toBe('agent-1')
    expect(registry.list()).toHaveLength(1)
    expect(registry.unbound()).toHaveLength(0)
    expect(registry.resolve('s1')?.agentId).toBe('agent-1')
  })

  it('re-opening the same launcher keeps the session it had already bound', async () => {
    // A launcher reconnects after a daemon restart / self-update with the SAME id — that is not a new
    // agent, and it must not lose its binding.
    const { registry } = await loadRegistryModule()
    registry.load()
    registry.openAgent({ agentId: 'agent-1', engine: 'claude', tmuxPane: '%1', cwd: '/tmp/demo' })
    registry.register({ launcherId: 'agent-1', sessionId: 's1', transcriptPath: transcript('s1'), tmuxPane: '%1', cwd: '/tmp/demo' })
    const again = registry.openAgent({ agentId: 'agent-1', engine: 'claude', tmuxPane: '%1', cwd: '/tmp/demo' })
    expect(again?.isNew).toBe(false)
    expect(again?.entry.sessionId).toBe('s1')
    expect(registry.list()).toHaveLength(1)
  })

  it('an unbound agent survives a daemon restart', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    registry.openAgent({ agentId: 'agent-1', engine: 'claude', tmuxPane: '%1', cwd: '/tmp/demo' })
    const { registry: reloaded } = await loadRegistryModule()
    reloaded.load()
    expect(reloaded.byAgent('agent-1')?.sessionId).toBe('')
    expect(reloaded.unbound()).toHaveLength(1)
  })

  it('keeps a name given before the agent had a session', async () => {
    // Names live under the ENGINE session id — that is what survives the launcher and comes back on a
    // resume, since the agent id is minted fresh each launch. An agent renamed while still unbound has
    // its name parked under the agent id, and the bind must carry it over.
    const { registry, projectDisplayName } = await loadRegistryModule()
    registry.load()
    registry.openAgent({ agentId: 'agent-1', engine: 'claude', tmuxPane: '%1', cwd: '/tmp/demo' })
    expect(registry.rename('agent-1', 'Backend fix')).toBeTruthy()
    expect(projectDisplayName(registry.byAgent('agent-1')!)).toBe('Backend fix')

    const bound = registry.register({ launcherId: 'agent-1', sessionId: 's1', transcriptPath: transcript('s1'), tmuxPane: '%1', cwd: '/tmp/demo' })
    registry.inheritName('agent-1', 's1')
    expect(projectDisplayName(bound!.entry)).toBe('Backend fix')

    // …and a LATER agent that resumes the same session inherits it, because the key is the session.
    registry.removeAgent('agent-1')
    const resumed = registry.register({ launcherId: 'agent-2', sessionId: 's1', transcriptPath: transcript('s1'), tmuxPane: '%1', cwd: '/tmp/demo' })
    expect(projectDisplayName(resumed!.entry)).toBe('Backend fix')
  })

  it('loads a pre-agentId snapshot by reading launcherId as the agent id', async () => {
    // No migration file and no version gate: every record already carried the launcher uuid, and that
    // uuid IS the agent id.
    const path = transcript('legacy')
    const now = Date.now()
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify([{
      sessionId: 'legacy-session', engine: 'claude', launcherId: 'legacy-agent', transcriptPath: path,
      projectDir: 'x', cwd: '/tmp/demo', tmuxPane: '%3', source: null, title: null, model: null,
      cliVersion: null, processIdentity: null, registeredAt: now, updatedAt: now,
      lastHookAt: now, lastTranscriptAt: now,
    }]))
    const { registry } = await loadRegistryModule()
    registry.load()
    expect(registry.byAgent('legacy-agent')?.sessionId).toBe('legacy-session')
    expect(registry.resolve('legacy-session')?.agentId).toBe('legacy-agent')
    // …and it is written back with BOTH ids, so rolling back to the previous build still loads it.
    const saved = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8')) as Array<Record<string, unknown>>
    expect(saved[0]).toMatchObject({ agentId: 'legacy-agent', launcherId: 'legacy-agent' })
  })
})
