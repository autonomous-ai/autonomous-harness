import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { cursorMessagesToEvents } from './normalizer.js'
import { loadCursorReplayTaskLinks } from './subagent.js'

const runCursorE2e = process.env.RUN_CURSOR_E2E === '1'
const execFileAsync = promisify(execFile)
const adapterRoot = resolve(import.meta.dirname, '../../..')
const repoRoot = adapterRoot   // this package IS the repo root here
const cursorHome = join(homedir(), '.cursor')
const cursorHooksPath = join(cursorHome, 'hooks.json')
const hookScript = join(adapterRoot, 'hook', 'notify.mjs')
const tsxBin = join(adapterRoot, 'node_modules', '.bin', 'tsx')
const E2E_TIMEOUT_MS = 4 * 60_000

interface Envelope {
  t?: string
  frame?: {
    type?: string
    payload?: Record<string, unknown>
  }
}

interface RegistryEntry {
  id?: string
  sessionId?: string
  engine?: string
  transcriptPath?: string | null
  tmuxPane?: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not allocate a local port')
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => error ? reject(error) : resolveClose()))
  return address.port
}

async function waitUntil<T>(
  label: string,
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T
  do {
    last = await read()
    if (accept(last)) return last
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  } while (Date.now() < deadline)
  throw new Error(`timed out waiting for ${label}; latest=${JSON.stringify(last!)}`)
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const exited = once(child, 'exit').then(() => true)
  const graceful = await Promise.race([
    exited,
    new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ])
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit').catch(() => undefined)
  }
}

async function installTemporaryCursorHooks(port: number, dataDir: string): Promise<void> {
  let settings: Record<string, unknown> = {}
  if (existsSync(cursorHooksPath)) {
    settings = JSON.parse(await readFile(cursorHooksPath, 'utf8')) as Record<string, unknown>
  }
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks as Record<string, unknown>
    : {}
  const command = [
    'node',
    shellQuote(hookScript),
    '--port', String(port),
    '--data-dir', shellQuote(dataDir),
    '--claude-projects-dir', shellQuote(join(dataDir, 'claude-projects')),
    '--codex-home', shellQuote(join(dataDir, 'codex')),
    '--cursor-home', shellQuote(cursorHome),
    '--engine', 'cursor',
  ].join(' ')
  for (const event of ['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'stop', 'sessionEnd']) {
    const current = Array.isArray(hooks[event]) ? hooks[event] as Array<Record<string, unknown>> : []
    hooks[event] = [
      ...current.filter((entry) => typeof entry.command !== 'string' || !entry.command.includes('notify.mjs')),
      { command, failClosed: false },
    ]
  }
  settings = { ...settings, version: typeof settings.version === 'number' ? settings.version : 1, hooks }
  await mkdir(dirname(cursorHooksPath), { recursive: true })
  await writeFile(cursorHooksPath, `${JSON.stringify(settings, null, 2)}\n`)
}

describe.skipIf(!runCursorE2e)('Cursor local HTTP/WS/tmux E2E', () => {
  it('runs TodoWrite and Task through the real Cursor CLI without changing the wire protocol', async () => {
    await execFileAsync('agent', ['--version'])
    await execFileAsync('tmux', ['-V'])

    const temp = await mkdtemp(join(tmpdir(), 'machine-cursor-e2e-'))
    const dataDir = join(temp, 'adapter-data')
    const authDir = join(temp, 'auth')
    const registryPath = join(dataDir, 'registry.json')
    const tmuxSession = `machine-cursor-e2e-${process.pid}`
    const hookPort = await freePort()
    const frames: Envelope[] = []
    const logs: string[] = []
    const originalHooks = existsSync(cursorHooksPath) ? await readFile(cursorHooksPath) : null
    const originalHooksMode = originalHooks ? (await stat(cursorHooksPath)).mode : null
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(wss, 'listening')
    const address = wss.address()
    if (!address || typeof address === 'string') throw new Error('fake backend did not bind')
    let socket: WebSocket | null = null
    wss.on('connection', (connected) => {
      socket = connected
      connected.on('message', (raw) => {
        try { frames.push(JSON.parse(raw.toString()) as Envelope) } catch { /* ignore app ping */ }
      })
    })

    let adapter: ChildProcess | null = null
    try {
      await installTemporaryCursorHooks(hookPort, dataDir)
      await mkdir(authDir, { recursive: true, mode: 0o700 })
      await writeFile(join(authDir, 'session.json'), JSON.stringify({
        version: 1,
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 3_600_000,
        autonomousEnv: 'prod',
        computerId: 'cursor-e2e-computer',
        machineId: 'cursor-e2e-machine',
        updatedAt: Date.now(),
      }) + '\n', { mode: 0o600 })
      adapter = spawn(tsxBin, ['src/cli.ts', '__run'], {
        cwd: adapterRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          HARNESS_AUTH_DIR: authDir,
          ADAPTER_COMPUTER_ID: 'cursor-e2e-computer',
          ADAPTER_DATA_DIR: dataDir,
          BACKEND_WS_URL: `ws://127.0.0.1:${address.port}`,
          WEB_URL: 'http://127.0.0.1:3000',
          PORT: String(hookPort),
          DISABLE_HOOK_INSTALL: 'true',
          ADAPTER_UPDATE_DISABLE: 'true',
          RECAP_FORCE: 'false',
          TMUX_REAP_INTERVAL_MS: '1000',
          CLAUDE_PROJECTS_DIR: join(temp, 'claude-projects'),
          CODEX_HOME: join(temp, 'codex'),
          CURSOR_HOME: cursorHome,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      adapter.stdout?.on('data', (chunk) => logs.push(chunk.toString()))
      adapter.stderr?.on('data', (chunk) => logs.push(chunk.toString()))

      await waitUntil(
        'adapter health',
        async () => fetch(`http://127.0.0.1:${hookPort}/api/health`).then((res) => res.ok).catch(() => false),
        Boolean,
      )
      const backendSocket = await waitUntil<WebSocket | null>(
        'adapter backend websocket',
        () => socket,
        (value) => value?.readyState === WebSocket.OPEN,
      )
      if (!backendSocket) throw new Error('adapter backend websocket disappeared')

      await execFileAsync('tmux', [
        'new-session', '-d', '-s', tmuxSession, '-c', repoRoot,
        'agent', '--trust', '--model', 'auto',
        'Reply exactly CURSOR_BOOTSTRAP_OK. Do not use tools or edit files.',
      ])

      const synced = await waitUntil<Envelope | undefined>(
        'Cursor agent_synced frame',
        () => frames.find((item) =>
          item.t === 'up'
          && item.frame?.type === 'agent_synced'),
        Boolean,
        45_000,
      )
      if (!synced) throw new Error('Cursor agent_synced frame disappeared')
      expect(synced.frame?.payload?.__e2e).toBeTruthy()
      const agent = await waitUntil<RegistryEntry | undefined>(
        'Cursor session in local adapter status',
        async () => {
          const status = await fetch(`http://127.0.0.1:${hookPort}/api/status`).then((res) => res.json()) as {
            sessions?: RegistryEntry[]
          }
          return status.sessions?.find((session) => session.engine === 'cursor')
        },
        Boolean,
      )
      if (!agent) throw new Error('Cursor session disappeared from local adapter status')
      expect(agent.id).toBeTruthy()
      expect(agent.tmuxPane).toMatch(/^%\d+$/)

      await waitUntil(
        'bootstrap Cursor turn_ended frame',
        () => frames.some((item) => item.t === 'up' && item.frame?.type === 'turn_ended'),
        Boolean,
        90_000,
      )
      const remoteStartIndex = frames.length
      backendSocket.send(JSON.stringify({
        t: 'down',
        connId: 'e2e-web',
        frame: {
          type: 'message',
          payload: {
            agentId: agent.id,
            dbSessionId: agent.id,
            content: [
              'You must use TodoWrite and exactly one Task subagent.',
              'Create two todos. The subagent must use Read to inspect package.json and report its package name.',
              'Complete both todos, do not edit files, and finish with exactly CURSOR_E2E_OK.',
            ].join(' '),
          },
        },
      }))

      await waitUntil(
        'encrypted Cursor turn_started frame',
        () => frames.slice(remoteStartIndex)
          .some((item) => item.t === 'up' && item.frame?.type === 'turn_started'),
        Boolean,
        45_000,
      )
      await waitUntil(
        'encrypted Cursor turn_ended frame',
        () => frames.slice(remoteStartIndex)
          .some((item) => item.t === 'up' && item.frame?.type === 'turn_ended'),
        Boolean,
        3 * 60_000,
      )
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000))

      const entries = JSON.parse(await readFile(registryPath, 'utf8')) as RegistryEntry[]
      const registered = entries.find((entry) => entry.sessionId === agent.id)
      expect(registered).toMatchObject({ engine: 'cursor', tmuxPane: agent.tmuxPane })
      expect(registered?.transcriptPath).toBeTruthy()

      const transcript = await readFile(registered!.transcriptPath!, 'utf8')
      const lines = transcript.split('\n').filter(Boolean)
      const links = await loadCursorReplayTaskLinks(cursorHome, agent.id!)
      const events = cursorMessagesToEvents(lines, agent.id!, links)
      const starts = events.filter((event) => event.type === 'tool_start')
      const ends = events.filter((event) => event.type === 'tool_end')
      const todoStarts = starts.filter((event) => event.payload.tool === 'TodoWrite')
      const finalTodos = todoStarts.at(-1)?.payload.input as { todos?: Array<{ status?: string }> } | undefined
      const remoteUsers = events.filter((event) =>
        event.type === 'user_message'
        && event.payload.content.includes('You must use TodoWrite and exactly one Task subagent.'))

      expect(events.some((event) => event.type === 'user_message')).toBe(true)
      expect(remoteUsers).toHaveLength(1)
      expect(events.some((event) => event.type === 'text_delta'
        && event.payload.content.includes('CURSOR_E2E_OK'))).toBe(true)
      expect(todoStarts.length).toBeGreaterThanOrEqual(2)
      expect(finalTodos?.todos?.length).toBe(2)
      expect(finalTodos?.todos?.every((todo) => todo.status === 'completed')).toBe(true)
      expect(starts.some((event) => event.payload.tool === 'Task')).toBe(true)
      expect(ends.some((event) => event.payload.tool === 'Task')).toBe(true)
      expect(starts.some((event) => event.payload.parentToolUseId)).toBe(true)
      expect(frames.some((item) => item.frame?.type === 'tool_start')).toBe(true)
      expect(frames.some((item) => item.frame?.type === 'tool_end')).toBe(true)
      const liveFrameTypes = frames.slice(remoteStartIndex)
        .filter((item) => item.t === 'up')
        .map((item) => item.frame?.type)
      expect(liveFrameTypes.indexOf('turn_started')).toBeGreaterThanOrEqual(0)
      expect(liveFrameTypes.indexOf('tool_start')).toBeGreaterThan(liveFrameTypes.indexOf('turn_started'))
    } catch (error) {
      const pane = await execFileAsync('tmux', ['capture-pane', '-p', '-t', tmuxSession, '-S', '-80'])
        .then(({ stdout }) => stdout)
        .catch(() => '<tmux session unavailable>')
      throw new Error([
        error instanceof Error ? error.stack ?? error.message : String(error),
        '--- adapter log ---',
        logs.join('').slice(-20_000),
        '--- websocket frame types ---',
        frames.map((item) => `${item.t ?? '?'}:${item.frame?.type ?? '?'}`).join('\n').slice(-10_000),
        '--- agent_synced frames ---',
        JSON.stringify(frames.filter((item) => item.frame?.type === 'agent_synced'), null, 2).slice(-20_000),
        '--- cursor pane ---',
        pane,
      ].join('\n'))
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', tmuxSession]).catch(() => undefined)
      if (adapter) await stopChild(adapter)
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolveClose) => wss.close(() => resolveClose()))
      if (originalHooks) {
        await writeFile(cursorHooksPath, originalHooks, { mode: originalHooksMode ?? undefined })
      } else {
        await rm(cursorHooksPath, { force: true })
      }
      await rm(temp, { recursive: true, force: true })
    }
  }, E2E_TIMEOUT_MS)
})
