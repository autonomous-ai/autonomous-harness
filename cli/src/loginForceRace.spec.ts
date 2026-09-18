/**
 * `harness login --force` beside a `harness start` — the desktop's daemon supervisor, in practice.
 *
 * A forced login stops the daemon and then waits, for as long as the person takes in the browser,
 * before it puts the new session on disk. The desktop app re-runs `harness start` whenever the
 * control port goes quiet, and `start` reads whatever session is on disk — for the whole of that
 * wait, the OLD account's. The daemon it spawned came up on the old account and stayed: the
 * `harness start` the login recommends afterwards found it "already running", `auth status` named
 * the new machine, the socket served the old one, and every local RPC got 4404 NO_PEER_LINK.
 *
 * Process-boundary tests, in the shape of cliCommand.spec.ts: a real `harness login --force --json`,
 * a real `harness start` landing mid-wait, a fake backend that records the token every call
 * carried, and a stand-in daemon (a child that idles until it is stopped) for the stop to kill.
 */
import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type IncomingMessage, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_SOURCE = join(CLI_ROOT, 'src', 'cli.ts')
const TSX = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const dirs: string[] = []
const servers: Server[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const server of servers.splice(0)) {
    // close() only stops NEW connections; the CLI's fetch keeps a pooled socket open.
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway HOME for one scenario; every path the CLI writes is under it. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-login-race-'))
  dirs.push(root)
  return root
}

function envFor(root: string, backendBase: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    HARNESS_AUTH_DIR: join(root, 'auth'),
    ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_CLI_DIR: join(root, 'cli'),
    ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
    ADAPTER_UPDATE_DISABLE: 'true',
    BACKEND_WS_URL: backendBase,
    // The daemon's control port. Nothing listens on 1, so a `start` in here can never take this
    // machine's real daemon for the one under test.
    PORT: '1',
    // The sign-in's grid half: no installer, no binary — it reports a missing `grid` and moves on,
    // rather than handing a made-up token to whatever `grid` this machine has on PATH.
    DISABLE_GRID_INSTALL: 'true',
    HARNESS_GRID_BIN: join(root, 'no-grid'),
  }
}

function seedSession(root: string, account: { accessToken: string; machineId: string }): void {
  mkdirSync(join(root, 'auth'), { recursive: true })
  writeFileSync(join(root, 'auth', 'session.json'), JSON.stringify({
    version: 1, refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000,
    autonomousEnv: 'prod', computerId: 'a'.repeat(32), updatedAt: Date.now(), ...account,
  }))
}

/** A daemon as `login --force` and `start` see one: a live process named by the pid file. It idles
 *  until it is stopped, which is all a stand-in has to do — the stop needs something to kill. */
function idleDaemon(root: string): { pid: number; exited: Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'data', 'adapter.pid'), `${child.pid}\n`)
  return { pid: child.pid ?? -1, exited: new Promise((resolve) => child.once('exit', () => resolve())) }
}

interface CliRun {
  stdout: () => string
  /** Exit status, once every stdio pipe has drained. */
  exit: Promise<number | null>
  /** Resolves once stdout satisfies `test`; rejects if the process ends without it ever doing so. */
  until: (test: (stdout: string) => boolean) => Promise<void>
}

function runCli(root: string, args: string[], backendBase: string): CliRun {
  const child = spawn(process.execPath, [TSX, CLI_SOURCE, ...args], {
    cwd: CLI_ROOT, env: envFor(root, backendBase), stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stdout = ''
  const watchers = new Set<() => void>()
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    for (const watch of [...watchers]) watch()
  })
  child.stderr.on('data', () => { /* drained: a full pipe would stall the child */ })
  const exit = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)))
  return {
    stdout: () => stdout,
    exit,
    until: (test) => new Promise((resolve, reject) => {
      const watch = (): void => {
        if (!test(stdout)) return
        watchers.delete(watch)
        resolve()
      }
      watchers.add(watch)
      watch()
      void exit.then(() => {
        if (!watchers.delete(watch)) return
        reject(new Error(`\`harness ${args.join(' ')}\` ended before its stdout matched:\n${stdout}`))
      })
    }),
  }
}

interface BackendCall { path: string; bearer: string | undefined }
type BackendAnswer = { data: unknown } | { status: number; error: string }

/** The three control-plane calls a sign-in and a start make, answered by `answer`, and every call's
 *  path and bearer token kept — which session a process acted on is the token it presented. */
function fakeBackend(
  answer: (req: IncomingMessage, body: Record<string, unknown>) => BackendAnswer,
): Promise<{ base: string; calls: BackendCall[] }> {
  const calls: BackendCall[] = []
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        calls.push({ path: req.url ?? '', bearer: req.headers.authorization })
        const out = answer(req, raw ? JSON.parse(raw) as Record<string, unknown> : {})
        if ('data' in out) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: out.data }))
          return
        }
        res.writeHead(out.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: { message: out.error } }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls })
    })
  })
}

describe('login --force beside a start that lands mid-sign-in', () => {
  it('never lets the start act on the account the login is replacing', async () => {
    const root = tempRoot()
    seedSession(root, { accessToken: 'tok_old', machineId: 'm_old' })
    const daemon = idleDaemon(root)
    let redirectUri = ''
    let resolvedForNew = 0
    const backend = await fakeBackend((req, body) => {
      switch (req.url) {
        case '/api/auth/authorize-native':
          redirectUri = String(body.redirectUri)
          return { data: { authorizeUrl: 'https://sso.example.test/authorize?tx=t', tx: 't' } }
        case '/api/auth/exchange':
          return { data: { token: 'tok_new', refreshToken: 'refresh_new', expiresIn: 3600, autonomousEnv: 'prod' } }
        case '/api/machines/resolve-computer':
          // The login's own resolve — the first to carry the new token — is answered. Every other
          // resolve is refused: a `start` that got past it would boot a daemon inside this test
          // (a repo run has no bundle to spawn, so it runs the daemon inline), and which session it
          // acted on is already on record in the token it presented.
          if (req.headers.authorization === 'Bearer tok_new' && resolvedForNew++ === 0) {
            return { data: { machine: { machineId: 'm_new' } } }
          }
          return { status: 503, error: 'no daemon in this test' }
        default:
          return { status: 404, error: 'not stubbed' }
      }
    })

    const login = runCli(root, ['login', '--force', '--json'], backend.base)
    await login.until((out) => out.includes('"authorize_url"'))
    // The browser is "open": the old daemon is gone and the session on disk is still the old account.
    await daemon.exited

    // The desktop supervisor sees a quiet control port and runs `harness start`. Let it get as far
    // as it will — to the backend and out (the bug), or to the spawn lock (the fix) — before the
    // person finishes in the browser.
    const start = runCli(root, ['start'], backend.base)
    await Promise.race([start.exit, start.until((out) => out.includes('waiting for it to finish'))])
    await fetch(`${redirectUri}?code=code_1&state=state_1`)

    expect(await login.exit).toBe(0)
    await start.exit

    // Nothing acted on the old account once its daemon was stopped: the start resolved its machine
    // with the NEW session or not at all.
    const resolves = backend.calls.filter((call) => call.path === '/api/machines/resolve-computer')
    expect(resolves.map((call) => call.bearer)).not.toContain('Bearer tok_old')
    expect(start.stdout()).toContain('the daemon is being signed in')
    // The login's pinned contract holds: exactly one result line, and a success.
    const results = login.stdout().trim().split('\n').map((line) => JSON.parse(line) as { type: string })
      .filter((line) => line.type === 'result')
    expect(results).toEqual([expect.objectContaining({ type: 'result', status: 'success' })])
    expect(JSON.parse(readFileSync(join(root, 'auth', 'session.json'), 'utf8')))
      .toMatchObject({ accessToken: 'tok_new', machineId: 'm_new' })
  }, 30_000)
})
