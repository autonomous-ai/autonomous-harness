import { spawn } from 'child_process'
import { createServer } from 'http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'

const HOOK = fileURLToPath(new URL('../hook/notify.mjs', import.meta.url))
const servers: ReturnType<typeof createServer>[] = []
const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RunHookOpts {
  port: number
  tmuxPane?: string
  /** The launcher id `harness <engine>` exports. Defaults to a live-looking one; pass null to simulate a
   *  CLI the user started by hand (no machine → the hook must ignore the event entirely). */
  launcherId?: string | null
  engine?: 'claude' | 'codex' | 'cursor' | 'devin' | 'commandcode'
  env?: Record<string, string>
  dataDir?: string
  claudeProjectsDir?: string
  codexHome?: string
  cursorHome?: string
  devinHome?: string
  input?: Record<string, unknown>
}

function runHook(opts: RunHookOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    if (opts.env) Object.assign(env, opts.env)
    delete env.TMUX_PANE
    if (opts.tmuxPane) env.TMUX_PANE = opts.tmuxPane
    delete env.MACHINE_ID
    if (opts.launcherId !== null) env.MACHINE_ID = opts.launcherId ?? '11111111-2222-4333-8444-555555555555'
    const args = [HOOK, '--port', String(opts.port)]
    if (opts.engine && opts.engine !== 'claude') args.push('--engine', opts.engine)
    if (opts.dataDir) args.push('--data-dir', opts.dataDir)
    if (opts.claudeProjectsDir) args.push('--claude-projects-dir', opts.claudeProjectsDir)
    if (opts.codexHome) args.push('--codex-home', opts.codexHome)
    if (opts.cursorHome) args.push('--cursor-home', opts.cursorHome)
    if (opts.devinHome) args.push('--devin-home', opts.devinHome)
    const child = spawn(process.execPath, args, {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`notify.mjs exited ${code}`)))
    child.stdin.end(JSON.stringify(opts.input ?? {
      hook_event_name: 'SessionEnd',
      session_id: 'session-test',
      reason: 'logout',
    }))
  })
}

/** A throwaway localhost adapter that records every hook POST. */
async function collect(): Promise<{ port: number; requests: Array<{ url: string; body: Record<string, unknown> }> }> {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk.toString() })
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
      res.end('{}')
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  return { port: address.port, requests }
}

describe('hook notify tmux scope', () => {
  it('forwards Cursor Task/stop hooks, journals the launcher, and always prints JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cursor-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const cursorHome = join(dir, 'cursor')
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk.toString() })
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
        res.end('{}')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    const stdout = await runHook({
      port: address.port,
      tmuxPane: '%21',
      engine: 'cursor',
      dataDir,
      cursorHome,
      input: {
        hook_event_name: 'preToolUse',
        session_id: 'cursor-session',
        tool_name: 'Task',
        tool_use_id: 'call-1',
        tool_input: { description: 'Inspect', prompt: 'Read code', model: 'inherit' },
        user_email: 'must-not-leak@example.com',
      },
    })
    expect(stdout).toBe('{}\n')
    expect(requests).toEqual([{
      url: '/api/hook/tool-start',
      body: {
        sessionId: 'cursor-session',
        toolUseId: 'call-1',
        toolName: 'Task',
        input: { description: 'Inspect', prompt: 'Read code', model: 'inherit' },
      },
    }])
    expect(JSON.parse(readFileSync(join(dataDir, 'cursor-pending-tasks.json'), 'utf8'))).toMatchObject([{
      sessionId: 'cursor-session',
      toolUseId: 'call-1',
    }])

    requests.splice(0)
    await runHook({
      port: address.port,
      tmuxPane: '%21',
      engine: 'cursor',
      dataDir,
      cursorHome,
      input: {
        hook_event_name: 'stop',
        session_id: 'cursor-session',
        workspace_roots: ['/tmp/cursor-workspace'],
        cursor_version: '2026.07.20-8cc9c0b',
      },
    })
    expect(requests.map((request) => request.url)).toEqual([
      '/api/hook/session-start',
      '/api/hook/turn-stop',
    ])
    expect(() => readFileSync(join(dataDir, 'cursor-pending-tasks.json'), 'utf8')).toThrow()
  })

  it('ignores Cursor background agents without leaking them into the registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cursor-background-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const output = await runHook({
      port: 9,
      tmuxPane: '%22',
      engine: 'cursor',
      dataDir,
      cursorHome: join(dir, 'cursor'),
      input: {
        hook_event_name: 'sessionStart',
        session_id: 'background',
        is_background_agent: true,
      },
    })
    expect(output).toBe('{}\n')
    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
  })

  it('ignores Codex subagent rollouts instead of replacing the parent transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-codex-subagent-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const codexHome = join(dir, 'codex')
    const childId = '019f8dae-e5f4-7c11-90d1-600854063b2c'
    const parentId = '019f7f1b-195d-70f2-861b-de5d54a3e141'
    const transcriptPath = join(codexHome, 'sessions', '2026', '07', `rollout-${childId}.jsonl`)
    mkdirSync(join(transcriptPath, '..'), { recursive: true })
    writeFileSync(transcriptPath, JSON.stringify({
      type: 'session_meta',
      payload: {
        id: childId,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
      },
    }) + '\n')
    const requests: string[] = []
    const server = createServer((req, res) => {
      requests.push(req.url ?? '')
      req.resume()
      res.end('{}')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({
      port: address.port,
      tmuxPane: '%8',
      engine: 'codex',
      dataDir,
      codexHome,
      input: {
        hook_event_name: 'SessionStart',
        session_id: parentId,
        transcript_path: transcriptPath,
        cwd: '/tmp/codex',
      },
    })

    expect(requests).toEqual([])
    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
  })

  it('ignores every event when the CLI was not started by `harness <engine>` (no MACHINE_ID)', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk.toString() })
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
        res.end('{}')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    // In tmux, but launched by hand: the session has no owning machine, so it is not an agent.
    await runHook({ port: address.port, tmuxPane: '%42', launcherId: null })
    expect(requests).toEqual([])

    // Same event, launched through the machine → forwarded, carrying the launcher id.
    await runHook({ port: address.port, tmuxPane: '%42' })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/hook/session-end')
  })

  it('drops standalone SessionEnd but forwards tmux SessionEnd', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk.toString() })
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: JSON.parse(raw) as Record<string, unknown> })
        res.end('{}')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({ port: address.port })
    expect(requests).toEqual([])

    await runHook({ port: address.port, tmuxPane: '%42' })
    expect(requests).toEqual([{
      url: '/api/hook/session-end',
      body: { sessionId: 'session-test', reason: 'logout' },
    }])
  })

  it('falls back to registry.json when SessionStart cannot reach the adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-1.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9,
      tmuxPane: '%7',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-1',
        transcript_path: transcriptPath,
        cwd: '/tmp/demo',
        session_title: 'Demo',
        model: 'sonnet',
        cli_version: '1.0.0',
      },
    })

    const registry = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    expect(registry).toMatchObject([{
      sessionId: 'session-1',
      engine: 'claude',
      transcriptPath,
      projectDir: 'demo',
      cwd: '/tmp/demo',
      tmuxPane: '%7',
      title: 'Demo',
      model: 'sonnet',
      cliVersion: '1.0.0',
    }])
  })

  it('falls back with Codex engine under CODEX_HOME/sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-codex-'))
    tmpDirs.push(dir)
    const codexHome = join(dir, 'codex')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(codexHome, 'sessions', '2026', 'rollout.jsonl')
    mkdirSync(join(codexHome, 'sessions', '2026'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9,
      tmuxPane: '%8',
      engine: 'codex',
      dataDir,
      codexHome,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'codex-session',
        transcript_path: transcriptPath,
        cwd: '/tmp/codex',
      },
    })

    const registry = JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))
    expect(registry).toMatchObject([{ sessionId: 'codex-session', engine: 'codex', tmuxPane: '%8' }])
  })

  it('does not fallback when the adapter accepts the hook event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-online-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-online.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    const server = createServer((_req, res) => res.end('{}'))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

    await runHook({
      port: address.port,
      tmuxPane: '%9',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-online',
        transcript_path: transcriptPath,
      },
    })

    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf-8')).toThrow()
  })

  it('does not write fallback registry entries outside tmux or outside the transcript root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-invalid-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const outside = join(dir, 'outside.jsonl')
    mkdirSync(claudeProjectsDir, { recursive: true })
    writeFileSync(outside, '{}\n')

    await runHook({
      port: 9,
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'no-tmux',
        transcript_path: outside,
      },
    })
    await runHook({
      port: 9,
      tmuxPane: '%10',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'outside',
        transcript_path: outside,
      },
    })

    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf-8')).toThrow()
  })

  it('removes fallback registry entries on offline SessionEnd except clear', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-end-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify([{ sessionId: 'keep' }, { sessionId: 'ended' }]))

    await runHook({
      port: 9,
      tmuxPane: '%11',
      dataDir,
      input: { hook_event_name: 'SessionEnd', session_id: 'ended', reason: 'logout' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([{ sessionId: 'keep' }])

    await runHook({
      port: 9,
      tmuxPane: '%11',
      dataDir,
      input: { hook_event_name: 'SessionEnd', session_id: 'keep', reason: 'clear' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([{ sessionId: 'keep' }])
  })

  it('keeps fallback registry entries when SessionEnd cannot prove the tmux app exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-end-unknown-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const binDir = join(dir, 'bin')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify([{ sessionId: 'maybe-alive' }]))
    writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    await runHook({
      port: 9,
      tmuxPane: '%13',
      dataDir,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
      input: { hook_event_name: 'SessionEnd', session_id: 'maybe-alive', reason: 'logout' },
    })

    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([{ sessionId: 'maybe-alive' }])
  })

  it('drops stale registry entries when boot marker predates this boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-reboot-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'fresh.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(transcriptPath, '{}\n')
    writeFileSync(join(dataDir, 'registry-boot'), '1')
    writeFileSync(join(dataDir, 'registry.json'), JSON.stringify([{ sessionId: 'stale', tmuxPane: '%1' }]))

    await runHook({
      port: 9,
      tmuxPane: '%12',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'fresh',
        transcript_path: transcriptPath,
      },
    })

    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toMatchObject([
      { sessionId: 'fresh', tmuxPane: '%12' },
    ])
  })
})

/**
 * Devin's documented user-level hook locations include `~/.claude/settings.json`, so the machine's CLAUDE
 * hook can fire inside a Devin session and register it under the wrong engine. The claude arm bails out
 * on a payload whose session id is a Devin slug holding a live `session_locks/<id>.lock`.
 */
describe('hook notify Devin/claude disambiguation', () => {

  it('ignores a Devin session that fired the claude hook, but still registers a real claude session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-devin-'))
    tmpDirs.push(dir)
    const devinHome = join(dir, 'devin')
    const projectsDir = join(dir, 'projects')
    mkdirSync(join(devinHome, 'session_locks'), { recursive: true })
    writeFileSync(join(devinHome, 'session_locks', 'classy-tourmaline.lock'), '21988')
    mkdirSync(projectsDir, { recursive: true })
    const transcript = join(projectsDir, 'a3f1c2d4-0000-4000-8000-000000000001.jsonl')
    writeFileSync(transcript, '')

    const { port, requests } = await collect()

    // Devin's SessionStart, arriving on the claude-armed hook → dropped.
    await runHook({
      port,
      tmuxPane: '%30',
      dataDir: join(dir, 'data'),
      claudeProjectsDir: projectsDir,
      devinHome,
      input: { hook_event_name: 'SessionStart', session_id: 'classy-tourmaline', source: 'startup' },
    })
    expect(requests).toEqual([])

    // A genuine claude session is unaffected.
    await runHook({
      port,
      tmuxPane: '%30',
      dataDir: join(dir, 'data'),
      claudeProjectsDir: projectsDir,
      devinHome,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'a3f1c2d4-0000-4000-8000-000000000001',
        transcript_path: transcript,
        cwd: '/tmp/claude-workspace',
        source: 'startup',
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/hook/session-start')
    expect(requests[0].body).toMatchObject({ engine: 'claude', sessionId: 'a3f1c2d4-0000-4000-8000-000000000001' })
  })

  it('registers a Devin session with no transcript path and the hook process cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-devin2-'))
    tmpDirs.push(dir)
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%31',
      engine: 'devin',
      dataDir: join(dir, 'data'),
      devinHome: join(dir, 'devin'),
      input: { hook_event_name: 'SessionStart', session_id: 'blue-agustinia', source: 'startup' },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/hook/session-start')
    expect(requests[0].body).toMatchObject({
      engine: 'devin',
      sessionId: 'blue-agustinia',
      tmuxPane: '%31',
      cwd: process.cwd(),
    })
    expect(requests[0].body.transcriptPath).toBeUndefined()
  })

  it('routes a Devin Stop to turn-stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-devin3-'))
    tmpDirs.push(dir)
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%32',
      engine: 'devin',
      dataDir: join(dir, 'data'),
      devinHome: join(dir, 'devin'),
      input: { hook_event_name: 'Stop', session_id: 'blue-agustinia', stop_hook_active: false, prompt_id: 'p1' },
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/api/hook/turn-stop')
    expect(requests[0].body).toMatchObject({ sessionId: 'blue-agustinia' })
  })
})

describe('hook notify Command Code re-registration', () => {
  // Command Code's hook set is PreToolUse/PostToolUse/Stop/SessionStart — Stop doubles as its only catch
  // hook, so it must register as well as close the turn. Without that, a session dropped from the registry
  // stays invisible on web/device until the user quits and relaunches the CLI.
  it('re-registers on Stop, with the transcript path, before closing the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cc-'))
    tmpDirs.push(dir)
    const transcript = join(dir, '53955d6d.jsonl')
    writeFileSync(transcript, '{}\n')
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%3',
      engine: 'commandcode',
      dataDir: join(dir, 'data'),
      input: {
        hook_event_name: 'Stop',
        session_id: '53955d6d',
        transcript_path: transcript,
        cwd: '/tmp/demo',
        session_title: 'Greeting',
      },
    })

    expect(requests.map((r) => r.url)).toEqual(['/api/hook/session-start', '/api/hook/turn-stop'])
    expect(requests[0].body).toMatchObject({
      engine: 'commandcode',
      hookEvent: 'Stop',
      sessionId: '53955d6d',
      transcriptPath: transcript,
      tmuxPane: '%3',
      cwd: '/tmp/demo',
      title: 'Greeting',
    })
    expect(requests[1].body).toMatchObject({ sessionId: '53955d6d' })
  })

  it('omits a transcript path that does not exist yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cc2-'))
    tmpDirs.push(dir)
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%3',
      engine: 'commandcode',
      dataDir: join(dir, 'data'),
      input: { hook_event_name: 'Stop', session_id: '53955d6d', transcript_path: join(dir, 'nope.jsonl') },
    })

    expect(requests).toHaveLength(2)
    expect(requests[0].body.transcriptPath).toBeUndefined()
  })

  it('leaves the claude Stop path as a turn-stop only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-cc3-'))
    tmpDirs.push(dir)
    const transcript = join(dir, 'projects', 'demo', 'abc.jsonl')
    mkdirSync(join(dir, 'projects', 'demo'), { recursive: true })
    writeFileSync(transcript, '{}\n')
    const { port, requests } = await collect()

    await runHook({
      port,
      tmuxPane: '%4',
      dataDir: join(dir, 'data'),
      claudeProjectsDir: join(dir, 'projects'),
      input: { hook_event_name: 'Stop', session_id: 'abc', transcript_path: transcript },
    })

    expect(requests.map((r) => r.url)).toEqual(['/api/hook/turn-stop'])
  })
})
