import { execFileSync, spawn, spawnSync } from 'child_process'
import { createServer } from 'http'
import { createServer as createNetServer } from 'net'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

// Every case here spawns the real hook as a child process, and several spawn shell shims for tmux, ps
// and sqlite3 on top of that. On a loaded machine — this file runs alongside 88 others — that chain
// takes well over vitest's 5s default, and the failure looks like a product bug rather than what it is.
// The hook's own budget still bounds it; this only stops the harness from calling time first.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const HOOK = fileURLToPath(new URL('../hook/notify.mjs', import.meta.url))
const servers: ReturnType<typeof createServer>[] = []
const netServers: ReturnType<typeof createNetServer>[] = []
const tmpDirs: string[] = []

function writeLegacyStateFile(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o644 })
  chmodSync(path, 0o644)
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(netServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RunHookOpts {
  port: number
  tmuxPane?: string
  /** Legacy environment noise: process-owned hooks must behave the same with or without it. */
  launcherId?: string | null
  /** Install deterministic tmux/ps fixtures so an offline fallback can prove process ownership. */
  processEngine?: 'claude' | 'codex' | 'cursor' | 'hermes' | 'devin' | 'commandcode' | 'grok'
  /** Override the fixture's ps `comm` and full argv to exercise install-root-independent matching. */
  processExecutable?: string
  processArgs?: string
  engine?: 'claude' | 'codex' | 'cursor' | 'hermes' | 'devin' | 'commandcode' | 'grok'
  env?: Record<string, string>
  dataDir?: string
  claudeProjectsDir?: string
  codexHome?: string
  cursorHome?: string
  hermesHome?: string
  /** Fake Hermes SQLite source; null means the session row has not appeared. */
  hermesSource?: 'cli' | 'subagent' | null
  grokHome?: string
  devinHome?: string
  input?: Record<string, unknown>
}

function runHook(opts: RunHookOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    // The hook abandons its optional work (including the offline registry fallback) when its 4.5s
    // wall-clock budget runs out. Under a full parallel run that budget is spent on host load, not on
    // the hook, and the assertion below then reads a registry nobody wrote — measured as roughly one
    // failure in five full-suite runs. Give the child room so these specs test behaviour, not the load
    // on the machine running them.
    env.HARNESS_HOOK_DEADLINE_MS = '30000'
    if (opts.env) Object.assign(env, opts.env)
    delete env.TMUX_PANE
    if (opts.tmuxPane) env.TMUX_PANE = opts.tmuxPane
    delete env.MACHINE_ID
    if (opts.launcherId !== null) env.MACHINE_ID = opts.launcherId ?? '11111111-2222-4333-8444-555555555555'
    if (opts.processEngine) {
      const binDir = mkdtempSync(join(tmpdir(), 'adapter-hook-bin-'))
      tmpDirs.push(binDir)
      const executable = opts.processExecutable ?? (opts.processEngine === 'cursor' ? 'agent' : opts.processEngine)
      const processArgs = opts.processArgs ?? executable
      writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\necho 7000\n', { mode: 0o755 })
      writeFileSync(join(binDir, 'ps'), `#!/bin/sh\nprintf '%s\\n' '7000 1 zsh Mon Aug 10 10:00:00 2026 -zsh' '7001 7000 ${executable} Mon Aug 10 10:00:01 2026 ${processArgs}' '${process.pid} 7001 node Mon Aug 10 10:00:02 2026 hook-parent'\n`, { mode: 0o755 })
      if (opts.processEngine === 'cursor') {
        const target = join(binDir, 'cursor-agent-target')
        writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 })
        symlinkSync(target, join(binDir, 'agent'))
        symlinkSync(target, join(binDir, 'cursor-agent'))
      } else if (opts.processEngine === 'grok') {
        const target = join(binDir, 'grok-target')
        writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 })
        symlinkSync(target, join(binDir, 'agent'))
        symlinkSync(target, join(binDir, 'grok'))
      }
      if (opts.hermesSource !== undefined) {
        const rows = opts.hermesSource === null ? '[]' : JSON.stringify([{ source: opts.hermesSource }])
        writeFileSync(join(binDir, 'sqlite3'), `#!/bin/sh\nprintf '%s\\n' '${rows}'\n`, { mode: 0o755 })
      }
      env.PATH = `${binDir}:${env.PATH ?? ''}`
    }
    const args = [HOOK, '--port', String(opts.port)]
    if (opts.engine && opts.engine !== 'claude') args.push('--engine', opts.engine)
    if (opts.dataDir) args.push('--data-dir', opts.dataDir)
    if (opts.claudeProjectsDir) args.push('--claude-projects-dir', opts.claudeProjectsDir)
    if (opts.codexHome) args.push('--codex-home', opts.codexHome)
    if (opts.cursorHome) args.push('--cursor-home', opts.cursorHome)
    if (opts.hermesHome) args.push('--hermes-home', opts.hermesHome)
    if (opts.grokHome) args.push('--grok-home', opts.grokHome)
    if (opts.devinHome) args.push('--devin-home', opts.devinHome)
    const hookDataDir = opts.dataDir || process.env.ADAPTER_DATA_DIR
    if (hookDataDir) {
      mkdirSync(hookDataDir, { recursive: true, mode: 0o700 })
      try { writeFileSync(join(hookDataDir, 'hook-credential'), `${'a'.repeat(43)}\n`, { mode: 0o600, flag: 'wx' }) } catch { /* already exists */ }
    }
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

describe('hook notify terminal scope', () => {
  it('refuses a symlinked hook credential instead of authenticating with its target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-credential-link-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const target = join(dir, 'credential-target')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(target, `${'a'.repeat(43)}\n`, { mode: 0o600 })
    symlinkSync(target, join(dataDir, 'hook-credential'))
    const { port, requests } = await collect()

    await runHook({ port, tmuxPane: '%42', dataDir })

    expect(requests).toEqual([])
  })

  it('rejects a hook credential FIFO without blocking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-credential-fifo-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { mode: 0o700 })
    const credential = join(dataDir, 'hook-credential')
    execFileSync('mkfifo', [credential])

    const result = spawnSync(process.execPath, [HOOK, '--port', '9', '--data-dir', dataDir], {
      encoding: 'utf8',
      env: { ...process.env, TMUX_PANE: '%42' },
      input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'fifo', reason: 'logout' }),
      timeout: 1_500,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(statSync(credential).isFIFO()).toBe(true)
  })

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
        engine: 'cursor',
        tmuxPane: '%21',
        runtimeHints: [{ backend: 'tmux', paneId: '%21' }],
        callerPid: expect.any(Number),
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

  it('forwards tmux events regardless of legacy MACHINE_ID', async () => {
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

    await runHook({ port: address.port, tmuxPane: '%42', launcherId: null })
    expect(requests).toHaveLength(1)

    await runHook({ port: address.port, tmuxPane: '%42' })
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.url)).toEqual(['/api/hook/session-end', '/api/hook/session-end'])
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
      body: {
        sessionId: 'session-test',
        reason: 'logout',
        engine: 'claude',
        tmuxPane: '%42',
        runtimeHints: [{ backend: 'tmux', paneId: '%42' }],
        callerPid: expect.any(Number),
      },
    }])
  })

  it('falls back to registry.json when SessionStart cannot reach the adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-1.jsonl')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeLegacyStateFile(join(dataDir, 'registry.json'), '[]')
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9,
      tmuxPane: '%7',
      processEngine: 'claude',
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
    expect(statSync(dataDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dataDir, 'registry.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, 'registry-boot')).mode & 0o777).toBe(0o600)
  })

  it('leaves a corrupt offline registry byte-identical instead of replacing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-corrupt-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-corrupt.jsonl')
    const registryFile = join(dataDir, 'registry.json')
    const corrupt = '[{"schemaVersion":2'
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(transcriptPath, '{}\n')
    writeFileSync(registryFile, corrupt, { mode: 0o600 })

    await runHook({
      port: 9,
      tmuxPane: '%70',
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-corrupt',
        transcript_path: transcriptPath,
        cwd: '/tmp/demo',
      },
    })

    expect(readFileSync(registryFile, 'utf8')).toBe(corrupt)
  })

  it('leaves malformed current, future, and legacy rows byte-identical while offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-offline-invalid-v2-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-invalid-v2.jsonl')
    const registryFile = join(dataDir, 'registry.json')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    for (const bytes of [
      JSON.stringify([{ schemaVersion: 2, agentId: 'damaged' }]),
      JSON.stringify([{ schemaVersion: '3', agentId: 'future' }]),
      JSON.stringify([{}]),
      JSON.stringify([7]),
      JSON.stringify([{ agentId: 'legacy-agent' }]),
    ]) {
      writeFileSync(registryFile, bytes, { mode: 0o600 })
      await runHook({
        port: 9,
        tmuxPane: '%71',
        processEngine: 'claude',
        dataDir,
        claudeProjectsDir,
        input: {
          hook_event_name: 'SessionStart',
          session_id: 'session-invalid-v2',
          transcript_path: transcriptPath,
          cwd: '/tmp/demo',
        },
      })
      expect(readFileSync(registryFile, 'utf8')).toBe(bytes)
    }
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
      processEngine: 'codex',
      processExecutable: 'node',
      processArgs: 'node /nix/store/codex-cli/lib/node_modules/@openai/codex/bin/codex.js',
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

  /**
   * Skipped when the suite itself runs as root (common in a container). `checkedSocket` rejects a
   * root-OWNED directory that is group-writable — `(stat.uid === 0 && permissions & 0o020)` — because
   * under root ownership the group bit really does let another account plant a socket. The rule is
   * correct; it is this case's premise ("the owner is a normal account") that does not hold as root.
   * Same precedent as the getuid()===0 guard in lib/fsBrowse.spec.ts.
   */
  it.skipIf(isRoot)('uses only a configured, validated Herdr endpoint for daemon-down registration', async () => {
    const dir = mkdtempSync(join(homedir(), '.adapter-hook-herdr-'))
    tmpDirs.push(dir)
    chmodSync(dir, 0o775)
    const dataDir = join(dir, 'data')
    const claudeProjectsDir = join(dir, 'claude-projects')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'herdr-session.jsonl')
    const socketPath = join(dir, 'herdr.sock')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o755)
    writeFileSync(transcriptPath, '{}\n')
    const server = createNetServer((socket) => {
      let raw = ''
      socket.on('data', (chunk) => { raw += chunk.toString('utf8') })
      socket.on('end', () => {
        const request = JSON.parse(raw.trim()) as { id: string; method: string }
        const result = request.method === 'ping'
          ? { type: 'pong', version: '0.8.0', protocol: 19 }
          : request.method === 'pane.get'
            ? { type: 'pane_info', pane: { pane_id: 'w1:p1', terminal_id: 'terminal-1' } }
            : { type: 'pane_process_info', process_info: { pane_id: 'w1:p1', shell_pid: 7000 } }
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`)
      })
    })
    netServers.push(server)
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    chmodSync(socketPath, 0o600)
    const socket = statSync(socketPath)
    writeFileSync(join(dataDir, 'terminal-config.json'), `${JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      backends: ['herdr'],
      herdrEndpoints: [{
        sessionName: 'test', endpointId: 'endpoint-test', socketPath,
        generation: { device: socket.dev, inode: socket.ino },
      }],
    })}\n`, { mode: 0o600 })
    chmodSync(join(dataDir, 'terminal-config.json'), 0o644)

    await runHook({
      port: 9,
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      env: { HERDR_PANE_ID: 'w1:p1', HERDR_SESSION: 'test', HERDR_SOCKET_PATH: socketPath },
      input: {
        hook_event_name: 'SessionStart', session_id: 'herdr-session', transcript_path: transcriptPath, cwd: '/tmp/demo',
      },
    })

    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))).toMatchObject([{
      schemaVersion: 2,
      active: true,
      sessionId: 'herdr-session',
      primaryRuntimeKey: 'herdr\u0000endpoint-test\u0000w1:p1',
      runtimes: [{
        backend: 'herdr', endpointId: 'endpoint-test', sessionName: 'test', terminalId: 'terminal-1', paneId: 'w1:p1',
      }],
    }])
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))[0]).not.toHaveProperty('tmuxPane')
    expect(statSync(join(dataDir, 'terminal-config.json')).mode & 0o777).toBe(0o600)
  })

  it('rejects a world-writable Herdr endpoint parent during daemon-down registration', async () => {
    const dir = mkdtempSync(join(homedir(), '.adapter-hook-herdr-world-writable-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const claudeProjectsDir = join(dir, 'claude-projects')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'herdr-session.jsonl')
    const socketPath = join(dir, 'herdr.sock')
    mkdirSync(join(claudeProjectsDir, 'demo'), { recursive: true })
    mkdirSync(dataDir, { mode: 0o700 })
    writeFileSync(transcriptPath, '{}\n')
    let requestCount = 0
    const server = createNetServer((socket) => {
      requestCount++
      socket.end()
    })
    netServers.push(server)
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    chmodSync(socketPath, 0o600)
    const socket = statSync(socketPath)
    writeFileSync(join(dataDir, 'terminal-config.json'), `${JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      backends: ['herdr'],
      herdrEndpoints: [{
        sessionName: 'test', endpointId: 'endpoint-test', socketPath,
        generation: { device: socket.dev, inode: socket.ino },
      }],
    })}\n`, { mode: 0o600 })
    chmodSync(dir, 0o777)

    await runHook({
      port: 9,
      processEngine: 'claude',
      dataDir,
      claudeProjectsDir,
      env: { HERDR_PANE_ID: 'w1:p1', HERDR_SESSION: 'test', HERDR_SOCKET_PATH: socketPath },
      input: {
        hook_event_name: 'SessionStart', session_id: 'herdr-session', transcript_path: transcriptPath, cwd: '/tmp/demo',
      },
    })

    expect(requestCount).toBe(0)
    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
  })

  it('rejects a group-writable Herdr config without changing or trusting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-herdr-unsafe-config-'))
    tmpDirs.push(dir)
    const dataDir = join(dir, 'data')
    const config = join(dataDir, 'terminal-config.json')
    mkdirSync(dataDir, { mode: 0o700 })
    writeFileSync(config, `${JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      backends: ['herdr'],
      herdrEndpoints: [],
    })}\n`, { mode: 0o600 })
    chmodSync(config, 0o660)

    await runHook({
      port: 9,
      processEngine: 'claude',
      dataDir,
      env: { HERDR_PANE_ID: 'w1:p1', HERDR_SESSION: 'test', HERDR_SOCKET_PATH: join(dir, 'herdr.sock') },
      input: { hook_event_name: 'SessionStart', session_id: 'unsafe-config' },
    })

    expect(statSync(config).mode & 0o777).toBe(0o660)
    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
  })

  it('does not treat engine names in unrelated process arguments as an offline agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-process-false-positive-'))
    tmpDirs.push(dir)
    const claudeProjectsDir = join(dir, 'claude-projects')
    const dataDir = join(dir, 'data')
    const transcriptPath = join(claudeProjectsDir, 'demo', 'session-false.jsonl')
    mkdirSync(join(transcriptPath, '..'), { recursive: true })
    writeFileSync(transcriptPath, '{}\n')

    await runHook({
      port: 9,
      tmuxPane: '%81',
      processEngine: 'claude',
      processExecutable: 'python3',
      processArgs: 'python3 /work/runner.py compare claude codex agent hermes',
      dataDir,
      claudeProjectsDir,
      input: {
        hook_event_name: 'SessionStart',
        session_id: 'session-false',
        transcript_path: transcriptPath,
      },
    })

    expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
  })

  it('offline Hermes fallback binds only source=cli and rejects delegation children or unknown rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-hermes-source-'))
    tmpDirs.push(dir)
    const hermesHome = join(dir, 'hermes')
    const cliData = join(dir, 'cli-data')
    const common = {
      port: 9,
      tmuxPane: '%82',
      engine: 'hermes' as const,
      processEngine: 'hermes' as const,
      processExecutable: 'python3',
      processArgs: 'python3 /opt/venvs/hermes/lib/python3.12/site-packages/hermes-agent/hermes',
      hermesHome,
    }

    await runHook({
      ...common,
      dataDir: cliData,
      hermesSource: 'cli',
      input: { hook_event_name: 'on_session_start', session_id: '20260810_120000_a1b2c3' },
    })
    expect(JSON.parse(readFileSync(join(cliData, 'registry.json'), 'utf8'))).toMatchObject([{
      sessionId: '20260810_120000_a1b2c3', engine: 'hermes', tmuxPane: '%82',
    }])

    for (const [name, source] of [['child', 'subagent'], ['unknown', null]] as const) {
      const dataDir = join(dir, `${name}-data`)
      await runHook({
        ...common,
        dataDir,
        hermesSource: source,
        input: { hook_event_name: 'on_session_start', session_id: `20260810_12000${name === 'child' ? '1' : '2'}_a1b2c3` },
      })
      expect(() => readFileSync(join(dataDir, 'registry.json'), 'utf8')).toThrow()
    }
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

  it('leaves offline registry ownership unchanged on SessionEnd', async () => {
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
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([{ sessionId: 'keep' }, { sessionId: 'ended' }])

    await runHook({
      port: 9,
      tmuxPane: '%11',
      dataDir,
      input: { hook_event_name: 'SessionEnd', session_id: 'keep', reason: 'clear' },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf-8'))).toEqual([{ sessionId: 'keep' }, { sessionId: 'ended' }])
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
    chmodSync(dataDir, 0o755)
    writeFileSync(transcriptPath, '{}\n')
    writeLegacyStateFile(join(dataDir, 'registry-boot'), '1')
    writeLegacyStateFile(join(dataDir, 'registry.json'), JSON.stringify([{ sessionId: 'stale', tmuxPane: '%1' }]))

    await runHook({
      port: 9,
      tmuxPane: '%12',
      processEngine: 'claude',
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

describe('hook notify Grok lifecycle', () => {
  it('resolves updates.jsonl, registers lifecycle events, and uses only StopFailure as a close fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-grok-'))
    tmpDirs.push(dir)
    const grokHome = join(dir, 'grok')
    const cwd = '/tmp/grok workspace'
    const sessionId = '8184b11d-175e-46cb-9cee-cf41cafe70d2'
    const transcript = join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl')
    mkdirSync(join(transcript, '..'), { recursive: true })
    writeFileSync(transcript, '{}\n')
    const { port, requests } = await collect()

    await runHook({
      port, tmuxPane: '%44', engine: 'grok', grokHome,
      input: { hookEventName: 'session_start', sessionId, cwd, model: 'grok-4.5', cliVersion: '1.0.0' },
    })
    expect(requests).toEqual([{
      url: '/api/hook/session-start',
      body: expect.objectContaining({
        engine: 'grok', hookEvent: 'SessionStart', sessionId, transcriptPath: transcript,
        cwd, tmuxPane: '%44', model: 'grok-4.5', cliVersion: '1.0.0',
      }),
    }])

    requests.splice(0)
    await runHook({ port, tmuxPane: '%44', engine: 'grok', grokHome, input: { hookEventName: 'stop', sessionId, cwd } })
    expect(requests).toEqual([])
    await runHook({ port, tmuxPane: '%44', engine: 'grok', grokHome, input: { hookEventName: 'stop_failure', sessionId, cwd } })
    expect(requests).toEqual([{
      url: '/api/hook/turn-stop',
      body: {
        sessionId,
        transcriptPath: transcript,
        status: 'error',
        engine: 'grok',
        tmuxPane: '%44',
        runtimeHints: [{ backend: 'tmux', paneId: '%44' }],
        callerPid: expect.any(Number),
      },
    }])
  })

  it('writes an offline fallback registry entry under the trusted Grok root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-hook-grok-offline-'))
    tmpDirs.push(dir)
    const grokHome = join(dir, 'grok')
    const dataDir = join(dir, 'data')
    const cwd = '/tmp/grok-offline'
    const sessionId = '98ee3dac-175e-46cb-9cee-cf41cafe70d2'
    const transcript = join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl')
    mkdirSync(join(transcript, '..'), { recursive: true })
    writeFileSync(transcript, '{}\n')

    await runHook({
      port: 9, tmuxPane: '%45', engine: 'grok', processEngine: 'grok',
      processExecutable: 'agent', processArgs: 'agent', grokHome, dataDir,
      input: { hookEventName: 'session_start', sessionId, cwd },
    })
    expect(JSON.parse(readFileSync(join(dataDir, 'registry.json'), 'utf8'))).toMatchObject([{
      sessionId, engine: 'grok', transcriptPath: transcript, projectDir: 'grok-offline', cwd, tmuxPane: '%45',
    }])

    const rejectedDataDir = join(dir, 'cursor-owned-agent-data')
    await runHook({
      port: 9, tmuxPane: '%46', engine: 'grok', processEngine: 'cursor',
      processExecutable: 'agent', processArgs: 'agent', grokHome, dataDir: rejectedDataDir,
      input: { hookEventName: 'session_start', sessionId, cwd },
    })
    expect(() => readFileSync(join(rejectedDataDir, 'registry.json'), 'utf8')).toThrow()
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
