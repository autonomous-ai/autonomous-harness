import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { access, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEngine } from '../engines/types.js'
import {
  agentCommandOwnershipSnapshot,
  ENGINE_CLI_COMMANDS,
  ENGINES,
  installedEngineBin,
} from './engineBin.js'
import {
  HERDR_API_PROTOCOL,
  HERDR_API_SCHEMA_VERSION,
  HerdrApiClient,
  resolveHerdrEndpoint,
  type HerdrApiResult,
  type HerdrEndpoint,
} from './herdrApiClient.js'
import { HerdrBackend } from './herdrBackend.js'
import { probeTerminalAgents } from './terminalAgentDiscovery.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { HerdrRuntimeRef } from './terminalTypes.js'
import { probeTmuxAgents } from './tmuxAgentDiscovery.js'

const exec = promisify(execFile)
const herdrBin = process.env.HERDR_BIN || 'herdr'
const enabled = process.env.RUN_REAL_HERDR === '1'
const installed = spawnSync(herdrBin, ['--version'], { encoding: 'utf8' }).status === 0
if (enabled && !installed) console.warn(`[herdr-real] skipped: ${herdrBin} is not installed`)
const realDescribe = enabled && installed ? describe : describe.skip

interface SessionListRow {
  name: string
  running: boolean
  session_dir: string
  socket_path: string
}

interface PaneInfo {
  pane_id: string
  terminal_id: string
  workspace_id: string
  tab_id: string
  cwd?: string
  title?: string
  terminal_title?: string
  terminal_title_stripped?: string
}

interface PaneProcessInfo {
  pane_id: string
  shell_pid?: number
  foreground_processes?: Array<{ pid: number; name: string; argv?: string[]; cmdline?: string }>
}

interface SessionFixture {
  name: string
  child: ChildProcess
  row: SessionListRow
  endpoint: HerdrEndpoint
  client: HerdrApiClient
}

const runId = `ah-u1-${process.pid}-${Date.now().toString(36)}`
const sessionNames = [`${runId}-a`, `${runId}-b`]
const sessions: SessionFixture[] = []
const tmuxSessions = new Set<string>()
const fixtureDir = join(tmpdir(), runId)
const ptyFixture = resolve(dirname(new URL(import.meta.url).pathname), '__fixtures__/herdr/pty-capture.mjs')
const ownership = agentCommandOwnershipSnapshot()
const engines: Array<[AgentEngine, string, string | null]> = ENGINES.map((engine) => [
  engine,
  ENGINE_CLI_COMMANDS[engine],
  installedEngineBin(engine, ownership),
])

function minimalEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries({
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'C.UTF-8',
    TERM: 'xterm-256color',
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

async function eventually<T>(read: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value !== null) return value
    } catch (error) { lastError = error }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw lastError ?? new Error('timed out waiting for real Herdr state')
}

async function sessionList(): Promise<SessionListRow[]> {
  const result = await exec(herdrBin, ['session', 'list', '--json'], {
    timeout: 2_000,
    maxBuffer: 512 * 1024,
    env: minimalEnv(),
  })
  const parsed = JSON.parse(result.stdout) as { sessions?: SessionListRow[] }
  return Array.isArray(parsed.sessions) ? parsed.sessions : []
}

async function startSession(name: string): Promise<SessionFixture> {
  const child = spawn(herdrBin, ['--session', name, 'server'], {
    env: minimalEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  child.stdout?.on('data', (chunk) => { diagnostics += String(chunk).slice(0, 4_096) })
  child.stderr?.on('data', (chunk) => { diagnostics += String(chunk).slice(0, 4_096) })
  const row = await eventually(async () => {
    if (child.exitCode !== null) throw new Error(`Herdr test server exited ${child.exitCode}: ${diagnostics}`)
    return (await sessionList()).find((candidate) => candidate.name === name && candidate.running) ?? null
  })
  const endpoint = await resolveHerdrEndpoint({ sessionName: name, socketPath: row.socket_path })
  const client = new HerdrApiClient(endpoint, { timeoutMs: 2_000 })
  const ping = await client.ping()
  if (!ping.ok) throw new Error(`Herdr test server ping failed: ${ping.reason}`)
  const fixture = { name, child, row, endpoint, client }
  sessions.push(fixture)
  return fixture
}

async function call<T>(
  client: HerdrApiClient,
  method: string,
  params: Record<string, unknown> = {},
  mutation: 'none' | 'single_enqueue' | 'single_key' | 'multi_enqueue' | 'other' = 'none',
): Promise<T> {
  const result = await client.request<T>(method, params, { mutation })
  if (!result.ok) throw new Error(`${method} failed: ${result.code ?? result.dispatch}`)
  return result.result
}

async function createWorkspace(fixture: SessionFixture, label: string): Promise<PaneInfo> {
  const result = await call<{ type: 'workspace_created'; root_pane: PaneInfo }>(
    fixture.client,
    'workspace.create',
    { cwd: process.cwd(), focus: false, label, env: {} },
    'other',
  )
  return result.root_pane
}

async function panes(fixture: SessionFixture): Promise<PaneInfo[]> {
  return (await call<{ type: 'pane_list'; panes: PaneInfo[] }>(fixture.client, 'pane.list')).panes
}

async function processInfo(fixture: SessionFixture, paneId: string): Promise<PaneProcessInfo> {
  return (await call<{ type: 'pane_process_info'; process_info: PaneProcessInfo }>(
    fixture.client,
    'pane.process_info',
    { pane_id: paneId },
  )).process_info
}

async function stopSession(fixture: SessionFixture): Promise<void> {
  await exec(herdrBin, ['--session', fixture.name, 'server', 'stop'], {
    timeout: 3_000,
    env: minimalEnv(),
  }).catch(() => {})
  if (fixture.child.exitCode === null) fixture.child.kill('SIGTERM')
  await new Promise<void>((resolvePromise) => {
    if (fixture.child.exitCode !== null) { resolvePromise(); return }
    const timer = setTimeout(() => { fixture.child.kill('SIGKILL'); resolvePromise() }, 2_000)
    fixture.child.once('exit', () => { clearTimeout(timer); resolvePromise() })
  })
  await exec(herdrBin, ['session', 'delete', fixture.name], {
    timeout: 3_000,
    env: minimalEnv(),
  }).catch(() => {})
}

async function waitForFile(path: string): Promise<void> {
  await eventually(async () => access(path).then(() => true).catch(() => null), 10_000)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function captureSubmission(
  fixture: SessionFixture,
  runtime: HerdrRuntimeRef,
  name: string,
  payload: string,
): Promise<Buffer> {
  const output = join(fixtureDir, `${name}.json`)
  const ready = join(fixtureDir, `${name}.ready`)
  await rm(output, { force: true })
  await rm(ready, { force: true })
  const command = `node ${shellQuote(ptyFixture)} ${shellQuote(output)} ${shellQuote(ready)}`
  await call(fixture.client, 'pane.send_input', {
    pane_id: runtime.paneId,
    text: command,
    keys: ['Enter'],
  }, 'single_enqueue')
  try {
    await waitForFile(ready)
  } catch (error) {
    const capture = await fixture.client.request<{ type: 'pane_read'; read: { text: string } }>('pane.read', {
      pane_id: runtime.paneId,
      source: 'recent_unwrapped',
      lines: 30,
      format: 'text',
      strip_ansi: true,
    })
    throw new Error(`PTY fixture did not become ready: ${capture.ok ? capture.result.read.text : capture.reason}`, { cause: error })
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  const submitted = await new HerdrBackend(fixture.endpoint).submitText(runtime, payload)
  expect(submitted).toEqual({ state: 'succeeded', dispatch: 'executed' })
  await waitForFile(output)
  const result = JSON.parse(await readFile(output, 'utf8')) as {
    base64: string
    bracketedStarts: number
    bracketedEnds: number
    carriageReturnsAfterPaste: number
  }
  expect(result.bracketedStarts).toBe(1)
  expect(result.bracketedEnds).toBe(1)
  expect(result.carriageReturnsAfterPaste).toBe(1)
  return Buffer.from(result.base64, 'base64')
}

realDescribe.sequential('real Herdr 0.8 socket backend', () => {
  let first: SessionFixture
  let second: SessionFixture
  let firstPane: PaneInfo
  let secondPane: PaneInfo

  const runtime = (fixture: SessionFixture, pane: PaneInfo): HerdrRuntimeRef => ({
    backend: 'herdr',
    endpointId: fixture.endpoint.endpointId,
    sessionName: fixture.name,
    terminalId: pane.terminal_id,
    paneId: pane.pane_id,
  })

  beforeAll(async () => {
    await exec('mkdir', ['-p', fixtureDir])
    first = await startSession(sessionNames[0])
    second = await startSession(sessionNames[1])
  }, 20_000)

  afterAll(async () => {
    for (const name of tmuxSessions) {
      await exec('tmux', ['kill-session', '-t', name], { timeout: 2_000 }).catch(() => {})
    }
    await Promise.all([...sessions].reverse().map(stopSession))
    await rm(fixtureDir, { recursive: true, force: true })
  }, 20_000)

  it('negotiates protocol/schema and distinguishes successful empty inventory', async () => {
    const schema = await exec(herdrBin, ['api', 'schema', '--json'], {
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
      env: minimalEnv(),
    })
    const generated = JSON.parse(schema.stdout) as { protocol: number; schema_version: number }
    expect(generated).toMatchObject({ protocol: HERDR_API_PROTOCOL, schema_version: HERDR_API_SCHEMA_VERSION })
    await expect(panes(first)).resolves.toEqual([])
    await expect(panes(second)).resolves.toEqual([])
  })

  it('namespaces duplicate routes and exposes stable endpoint-scoped identity', async () => {
    firstPane = await createWorkspace(first, 'harness-u1-a')
    secondPane = await createWorkspace(second, 'harness-u1-b')
    expect(firstPane.pane_id).toBe('w1:p1')
    expect(secondPane.pane_id).toBe('w1:p1')
    expect(first.endpoint.endpointId).not.toBe(second.endpoint.endpointId)
    expect(firstPane.terminal_id).not.toBe(secondPane.terminal_id)
    const [a, b] = await Promise.all([
      processInfo(first, firstPane.pane_id),
      processInfo(second, secondPane.pane_id),
    ])
    expect(a.shell_pid).toBeGreaterThan(1)
    expect(b.shell_pid).toBeGreaterThan(1)
    expect(a.shell_pid).not.toBe(b.shell_pid)
    expect(firstPane.cwd).toBe(process.cwd())
    const inventory = await new HerdrBackend(first.endpoint).inventory()
    expect(inventory.state).toBe('available')
    if (inventory.state === 'available') {
      expect(inventory.roots.some((root) => root.runtime.backend === 'herdr'
        && root.runtime.terminalId === firstPane.terminal_id && root.rootPid === a.shell_pid)).toBe(true)
    }
  })

  it('creates, notifies, and closes a test-owned workspace through the shared backend contract', async () => {
    const backend = new HerdrBackend(first.endpoint)
    const created = await backend.create({ cwd: process.cwd(), label: 'harness-lifecycle' })
    expect(created.state).toBe('succeeded')
    if (created.state !== 'succeeded') return
    await expect(backend.notify(created.runtime, 'Harness test', 'Lifecycle message'))
      .resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    await expect(backend.kill(created.runtime))
      .resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    await expect(eventually(async () => (await panes(first)).some(
      (pane) => pane.terminal_id === created.runtime.terminalId,
    ) ? null : true)).resolves.toBe(true)
  })

  it('types literally, presses logical keys, and captures ANSI without implicit focus', async () => {
    const backend = new HerdrBackend(first.endpoint)
    const current = runtime(first, firstPane)
    const marker = join(fixtureDir, 'literal-executed')
    await expect(backend.typeLiteral(current, `touch ${shellQuote(marker)}`)).resolves.toEqual({
      state: 'succeeded', dispatch: 'executed',
    })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    await expect(access(marker)).rejects.toBeTruthy()
    await expect(backend.sendKey(current, 'enter')).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    await waitForFile(marker)

    await call(first.client, 'pane.send_input', {
      pane_id: firstPane.pane_id,
      text: `printf '\\033[31mHERDR_ANSI_CAPTURE\\033[0m\\n'; printf '\\033]0;HERDR_U1_TITLE\\007'`,
      keys: ['Enter'],
    }, 'single_enqueue')
    const read = await eventually(async () => {
      const result = await backend.capture(current, { mode: 'recent_unwrapped', historyLines: 100, ansi: true })
      return result.state === 'succeeded' && result.value.includes('HERDR_ANSI_CAPTURE') ? result.value : null
    })
    expect(read).toMatch(/\u001b\[[0-9;]*mHERDR_ANSI_CAPTURE\u001b\[0m/)
    const titled = await eventually(async () => {
      const result = await call<{ type: 'pane_info'; pane: PaneInfo }>(first.client, 'pane.get', { pane_id: firstPane.pane_id })
      return result.pane.terminal_title_stripped === 'HERDR_U1_TITLE' ? result.pane : null
    })
    expect(titled.terminal_title_stripped).toBe('HERDR_U1_TITLE')
    await expect(backend.setTitle(current, 'Harness Herdr title')).resolves.toEqual({
      state: 'succeeded', dispatch: 'executed',
    })
    const titles = await backend.titles()
    expect(titles.state).toBe('succeeded')
    if (titles.state === 'succeeded') expect(titles.value.get(terminalRouteKey(current))).toBe('Harness Herdr title')
  })

  for (const [engine, bin, path] of engines) {
    if (!path) console.warn(`[herdr-real] unavailable matrix row: ${engine} (${bin} has no verified installed executable)`)
    const matrixIt = path ? it : it.skip
    matrixIt(`discovers ${engine} once and process-only deletion preserves its terminal`, async () => {
      const pane = await createWorkspace(first, `matrix-${engine}`)
      const current = runtime(first, pane)
      const backend = new HerdrBackend(first.endpoint)
      await expect(backend.submitText(current, shellQuote(path!))).resolves.toEqual({
        state: 'succeeded', dispatch: 'executed',
      })

      const discovered = await eventually(async () => {
        const result = await probeTerminalAgents([backend], ['herdr'], [first.name], -1)
        const inPane = result.agents.filter((candidate) => candidate.runtimes.some(
          (candidateRuntime) => terminalRouteKey(candidateRuntime) === terminalRouteKey(current),
        ))
        return inPane.length === 1 && inPane[0].engine === engine ? inPane[0] : null
      }, 20_000)
      const capture = await backend.capture(current, { mode: 'recent_unwrapped', historyLines: 30, ansi: false })
      expect(discovered, `${bin} was not discovered in ${current.paneId}\n${capture.state === 'succeeded' ? capture.value : capture.reason}`).not.toBeNull()

      const pid = discovered.processIdentity.pid
      process.kill(pid, 'SIGTERM')
      const gone = await eventually(async () => {
        try { process.kill(pid, 0) } catch { return true }
        return null
      }, 2_000).catch(() => false)
      if (!gone) {
        try { process.kill(pid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }

      const absent = await eventually(async () => {
        const result = await probeTerminalAgents([backend], ['herdr'], [first.name], -1)
        return result.agents.some((candidate) => candidate.processIdentity.pid === pid) ? null : true
      }, 5_000)
      expect(absent, `${bin} remained discoverable after its exact saved PID was terminated`).toBe(true)
      const paneAfterDelete = await first.client.request<{ type: 'pane_info'; pane: PaneInfo }>(
        'pane.get', { pane_id: current.paneId },
      )
      expect(paneAfterDelete.ok).toBe(true)
      if (paneAfterDelete.ok) expect(paneAfterDelete.result.pane.terminal_id).toBe(current.terminalId)
    }, 35_000)
  }

  it.each([
    ['short', 'u1 short input'],
    ['multiline', 'line one\nline two\nline three\nline four'],
    ['long', '0123456789abcdef'.repeat(1_792)],
  ])('submits %s text byte-for-byte exactly once through one API request', async (name, payload) => {
    const bytes = await captureSubmission(first, runtime(first, firstPane), name, payload)
    expect(bytes).toEqual(Buffer.from(`\u001b[200~${payload}\u001b[201~\r`))
    expect(Buffer.byteLength(payload)).toBe(name === 'long' ? 28_672 : Buffer.byteLength(payload))

    const processArgs = (await exec('ps', ['-axo', 'args='], { timeout: 2_000 })).stdout
    expect(processArgs).not.toContain(payload)
    const serverLog = join(first.row.session_dir, 'herdr-server.log')
    const log = await readFile(serverLog, 'utf8').catch(() => '')
    expect(log).not.toContain(payload)
  }, 20_000)

  it('preserves terminal identity across a workspace move and records alias behavior', async () => {
    const before = firstPane
    const moved = await call<{ type: 'pane_move'; move_result: { pane: PaneInfo; previous_pane_id: string } }>(
      first.client,
      'pane.move',
      {
        pane_id: before.pane_id,
        destination: { type: 'new_workspace', label: 'harness-u1-moved', tab_label: 'harness-u1-moved' },
        focus: false,
      },
      'other',
    )
    firstPane = moved.move_result.pane
    expect(firstPane.pane_id).not.toBe(before.pane_id)
    expect(firstPane.terminal_id).toBe(before.terminal_id)
    expect((await processInfo(first, firstPane.pane_id)).shell_pid).toBeGreaterThan(1)

    const oldRouteImmediately = await first.client.request<{ type: 'pane_info'; pane: PaneInfo }>(
      'pane.get', { pane_id: before.pane_id },
    )
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000))
    const oldRouteAfterTenSeconds = await first.client.request<{ type: 'pane_info'; pane: PaneInfo }>(
      'pane.get', { pane_id: before.pane_id },
    )
    console.log('[herdr-real] route alias', JSON.stringify({
      immediate: oldRouteImmediately.ok,
      afterTenSeconds: oldRouteAfterTenSeconds.ok,
      oldRoute: before.pane_id,
      currentRoute: firstPane.pane_id,
    }))
    expect(oldRouteImmediately.ok).toBe(true)
  }, 20_000)

  it('keeps the direct inventory/process probe below half the 5s reconcile interval', async () => {
    const samples: Record<string, number[]> = { '1': [], '10': [], '50': [] }
    let count = (await panes(second)).length
    for (const target of [1, 10, 50]) {
      while (count < target) {
        await createWorkspace(second, `bench-${count + 1}`)
        count++
      }
      for (let sample = 0; sample < 10; sample++) {
        const started = performance.now()
        const listed = await panes(second)
        await Promise.all(listed.map((pane) => processInfo(second, pane.pane_id)))
        samples[String(target)].push(performance.now() - started)
      }
    }
    const p95 = Object.fromEntries(Object.entries(samples).map(([key, values]) => {
      const ordered = values.toSorted((a, b) => a - b)
      return [key, ordered[Math.ceil(ordered.length * 0.95) - 1]]
    })) as Record<string, number>
    const safeMinimumMs = Math.max(250, Math.ceil((Math.max(...Object.values(p95)) * 2) / 50) * 50)
    console.log('[herdr-real] reconcile benchmark', JSON.stringify({ p95Ms: p95, safeMinimumMs }))
    expect(p95['50']).toBeLessThan(2_500)
  }, 60_000)

  it('classifies stopped transport as unavailable rather than an empty snapshot', async () => {
    const isolated = await startSession(`${runId}-availability`)
    await expect(panes(isolated)).resolves.toEqual([])
    await stopSession(isolated)
    sessions.splice(sessions.indexOf(isolated), 1)
    const unavailable: HerdrApiResult<unknown> = await isolated.client.request('pane.list', {})
    expect(unavailable).toMatchObject({ ok: false, dispatch: 'not_started' })
  })

  it('observes both real nested multiplexer topologies without duplicate engine ownership', async () => {
    const amp = (await exec('/bin/sh', ['-lc', 'command -v amp'], { timeout: 2_000 })).stdout.trim()
    expect(amp).not.toBe('')

    const innerTmux = `${runId}-tmux-in-herdr`
    tmuxSessions.add(innerTmux)
    await call(first.client, 'pane.send_input', {
      pane_id: firstPane.pane_id,
      text: `tmux new-session -d -s ${shellQuote(innerTmux)} ${shellQuote(amp)}`,
      keys: ['Enter'],
    }, 'single_enqueue')
    const tmuxAgent = await eventually(async () => {
      const result = await probeTmuxAgents()
      if (!result.ok) return null
      return result.agents.find((agent) => agent.engine === 'amp' && agent.processIdentity.pid > 0) ?? null
    }, 20_000)
    const outerHerdr = await processInfo(first, firstPane.pane_id)
    expect(outerHerdr.foreground_processes?.some((process) => process.pid === tmuxAgent.processIdentity.pid)).toBe(false)

    const outerTmux = `${runId}-herdr-in-tmux`
    tmuxSessions.add(outerTmux)
    await exec('tmux', ['new-session', '-d', '-s', outerTmux], { timeout: 5_000 })
    const outerPane = (await exec('tmux', ['list-panes', '-t', outerTmux, '-F', '#{pane_id}'], { timeout: 2_000 })).stdout.trim()
    await exec('tmux', ['send-keys', '-t', outerPane, '-l', '--', `${herdrBin} --session ${second.name}`], { timeout: 2_000 })
    await exec('tmux', ['send-keys', '-t', outerPane, 'Enter'], { timeout: 2_000 })
    await call(second.client, 'pane.send_input', {
      pane_id: secondPane.pane_id,
      text: shellQuote(amp),
      keys: ['Enter'],
    }, 'single_enqueue')
    const herdrAmp = await eventually(async () => {
      const info = await processInfo(second, secondPane.pane_id)
      return info.foreground_processes?.find((process) => process.name === 'amp') ?? null
    }, 20_000)
    const observed = await probeTmuxAgents()
    expect(observed.ok && observed.agents.some((agent) => agent.tmuxPane === outerPane && agent.processIdentity.pid === herdrAmp.pid)).toBe(false)
    console.log('[herdr-real] nested topology', JSON.stringify({
      tmuxInsideHerdr: { enginePid: tmuxAgent.processIdentity.pid, locators: ['tmux'] },
      herdrInsideTmux: { enginePid: herdrAmp.pid, locators: ['herdr'] },
    }))
  }, 45_000)
})
