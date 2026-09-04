/**
 * `harness grid login` — the real CLI as a subprocess, against a fake backend and a fake `grid`.
 *
 * The fake `grid` is first on PATH and records the argv and the standard input it was handed. It
 * **refuses** argv without `--harness`: asserting that the harness asked for the hand-off is the one
 * thing a fake binary can honestly check, since it cannot exchange a token the way the real CLI does.
 */
import { spawn } from 'child_process'
import { createServer, type Server } from 'http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_SOURCE = join(CLI_ROOT, 'src', 'cli.ts')
const TSX = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const dirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/** Records what it was given, then behaves as the surrounding test's env vars tell it to.
 *  Extensionless, so Node runs it as CommonJS regardless of any package.json above it. */
const FAKE_GRID = `#!/usr/bin/env node
'use strict'
const { writeFileSync } = require('fs')
const args = process.argv.slice(2)
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })
process.stdin.on('end', () => {
  writeFileSync(process.env.FAKE_GRID_RECORD, JSON.stringify({ args, stdin, env: process.env }))
  if (!args.includes('--harness')) {
    process.stderr.write('fake grid: refusing argv that does not ask for the hand-off\\n')
    process.exitCode = 64
    return
  }
  if (process.env.FAKE_GRID_STDOUT) process.stdout.write(process.env.FAKE_GRID_STDOUT)
  process.exitCode = Number(process.env.FAKE_GRID_EXIT || '0')
})
`

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-cli-grid-'))
  dirs.push(root)
  return root
}

type GridOnPath = 'runnable' | 'absent' | 'not-executable'

/** A `grid` on PATH, in one of the three states the hand-off has to tell apart.
 *
 *  `not-executable` is the one that earns its keep: it is the only case where the PATH pre-check and
 *  the spawn disagree — the check refuses it as unrunnable, while a spawn would answer EACCES, which
 *  is NOT the ENOENT the fallback recognises. Without it, deleting the pre-check entirely leaves the
 *  absent case green, and the test named for it would be measuring nothing of its own. */
function fakeGridBin(root: string, state: GridOnPath): string {
  const dir = join(root, 'bin')
  mkdirSync(dir, { recursive: true })
  if (state === 'absent') return dir
  const script = join(dir, 'grid')
  writeFileSync(script, FAKE_GRID)
  chmodSync(script, state === 'runnable' ? 0o755 : 0o644)
  return dir
}

function recordFile(root: string): string { return join(root, 'grid-invocation.json') }

function readRecord(root: string): { args: string[]; stdin: string; env: Record<string, string> } {
  return JSON.parse(readFileSync(recordFile(root), 'utf8'))
}

function seedSession(root: string, overrides: Record<string, unknown> = {}): void {
  const authDir = join(root, 'auth')
  mkdirSync(authDir, { recursive: true })
  writeFileSync(join(authDir, 'session.json'), JSON.stringify({
    version: 1,
    accessToken: 'tok_seeded',
    refreshToken: 'refresh_seeded',
    expiresAt: Date.now() + 60 * 60_000, // an hour out — accessToken() must not attempt a refresh
    autonomousEnv: 'prod',
    computerId: 'a'.repeat(32),
    machineId: 'm_seeded',
    updatedAt: Date.now(),
    ...overrides,
  }))
}

function envFor(root: string, backendUrl?: string, extra: NodeJS.ProcessEnv = {}, grid: GridOnPath = 'runnable'): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    HARNESS_AUTH_DIR: join(root, 'auth'),
    ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_CLI_DIR: join(root, 'cli'),
    ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
    ADAPTER_UPDATE_DISABLE: 'true',
    // The fake goes FIRST so it wins over any real `grid` this machine has. Unless it is meant to be
    // unusable — then the rest of PATH is dropped entirely, or a developer's own installed `grid`
    // answers and the test measures their machine instead of the refusal (it did: a real CLI
    // predating `--harness` exited 2, which read as an outdated CLI rather than an absent one).
    PATH: grid === 'runnable'
      ? `${fakeGridBin(root, grid)}${delimiter}${process.env.PATH ?? ''}`
      : fakeGridBin(root, grid),
    FAKE_GRID_RECORD: recordFile(root),
    ...(backendUrl ? { BACKEND_WS_URL: backendUrl } : {}),
    ...extra,
  }
}

type Run = { status: number | null; stdout: string; stderr: string }

/** Async spawn — REQUIRED whenever the child talks to a fake backend hosted in THIS process, which
 *  spawnSync would block the event loop of until the child exits, deadlocking both. */
function run(root: string, args: string[], backendUrl?: string, extra: NodeJS.ProcessEnv = {}, grid: GridOnPath = 'runnable'): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, CLI_SOURCE, ...args], {
      cwd: CLI_ROOT,
      env: envFor(root, backendUrl, extra, grid),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.once('exit', (status) => resolve({ status, stdout, stderr }))
  })
}

function ndjson(stdout: string): Record<string, unknown>[] {
  return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** The `/api/auth/*` + resolve-computer calls the harness sign-in makes — real network shape. */
function fakeBackend(handlers: {
  authorizeNative?: (body: any) => any
  exchange?: (body: any) => any
  resolveComputer?: (body: any) => any
  refresh?: (body: any) => { status: number; body: unknown }
}): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {}
        const send = (data: unknown): void => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: true, data }))
        }
        if (req.url === '/api/auth/authorize-native' && handlers.authorizeNative) { send(handlers.authorizeNative(body)); return }
        if (req.url === '/api/auth/exchange' && handlers.exchange) { send(handlers.exchange(body)); return }
        if (req.url === '/api/machines/resolve-computer' && handlers.resolveComputer) { send(handlers.resolveComputer(body)); return }
        if (req.url === '/api/auth/refresh' && handlers.refresh) {
          const answer = handlers.refresh(body)
          res.writeHead(answer.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(answer.body))
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: { message: 'not stubbed' } }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
  })
}

const signedInBackend = () => fakeBackend({ resolveComputer: () => ({ machine: { machineId: 'm_seeded' } }) })

describe('harness grid login — an already-signed-in computer', () => {
  it('hands the token over with no browser and one terminating result line', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await signedInBackend()

    const result = await run(root, ['grid', 'login', '--json'], base)

    expect(result.status).toBe(0)
    const lines = ndjson(result.stdout)
    // No authorize_url anywhere: an existing session must never reopen the browser.
    expect(lines).toEqual([{ type: 'result', status: 'success' }])
    expect(readRecord(root).args).toEqual(['login', '--harness', '--json'])
  }, 20_000)

  it('writes the token on standard input, and puts it in neither argv nor the environment', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await signedInBackend()

    await run(root, ['grid', 'login', '--json'], base)

    const record = readRecord(root)
    expect(record.stdin.trim()).toBe('tok_seeded')
    expect(JSON.stringify(record.args)).not.toContain('tok_seeded')
    expect(JSON.stringify(record.env)).not.toContain('tok_seeded')
  }, 20_000)

  it('lets the child\'s own output through on the human path, and asks it for no JSON', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await signedInBackend()

    const result = await run(root, ['grid', 'login'], base, { FAKE_GRID_STDOUT: 'Signed in as a@b.test.\n' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Signed in as a@b.test.')
    expect(readRecord(root).args).toEqual(['login', '--harness'])
  }, 20_000)

  it('carries the child\'s JSON answer out on the result line', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await signedInBackend()

    const result = await run(root, ['grid', 'login', '--json'], base,
      { FAKE_GRID_STDOUT: '{"signed_in":true,"email":"a@b.test","grids":[]}\n' })

    expect(result.status).toBe(0)
    expect(ndjson(result.stdout)).toEqual([
      { type: 'result', status: 'success', grid: { signed_in: true, email: 'a@b.test', grids: [] } },
    ])
  }, 20_000)
})

describe('harness grid login — a signed-out computer', () => {
  it('runs the whole loopback sign-in first, then hands the new token over', async () => {
    const root = tempRoot()
    let capturedRedirectUri = ''
    const { base } = await fakeBackend({
      authorizeNative: (body) => { capturedRedirectUri = body.redirectUri; return { authorizeUrl: 'https://sso.example.test/authorize?tx=abc', tx: 'tx_abc' } },
      exchange: () => ({ token: 'tok_new', refreshToken: 'refresh_new', expiresIn: 3600, autonomousEnv: 'prod' }),
      resolveComputer: () => ({ machine: { machineId: 'm_new' } }),
    })

    const child = spawn(process.execPath, [TSX, CLI_SOURCE, 'grid', 'login', '--json'], {
      cwd: CLI_ROOT,
      env: envFor(root, base),
    })
    let stdout = ''
    const lines: Record<string, unknown>[] = []
    const gotUrl = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        while (stdout.includes('\n')) {
          const idx = stdout.indexOf('\n')
          const line = stdout.slice(0, idx).trim()
          stdout = stdout.slice(idx + 1)
          if (line) { lines.push(JSON.parse(line)); resolve() }
        }
      })
    })

    await gotUrl
    expect(lines[0]).toEqual({ type: 'authorize_url', url: 'https://sso.example.test/authorize?tx=abc' })

    // Simulate the browser completing SSO against this CLI's own loopback callback server.
    await fetch(`${capturedRedirectUri}?code=code_123&state=state_456`)

    const status = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    if (stdout.trim()) lines.push(JSON.parse(stdout.trim()))
    expect(status).toBe(0)
    // Two lines total: the sign-in's authorize_url, and ONE terminating result — not one per half.
    expect(lines).toEqual([
      { type: 'authorize_url', url: 'https://sso.example.test/authorize?tx=abc' },
      { type: 'result', status: 'success' },
    ])
    expect(readRecord(root).stdin.trim()).toBe('tok_new')
  }, 30_000)
})

describe('harness grid login — when the hand-off fails', () => {
  it('propagates the child\'s exit code', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await signedInBackend()

    const result = await run(root, ['grid', 'login', '--json'], base, { FAKE_GRID_EXIT: '7' })

    expect(result.status).toBe(7)
    expect(ndjson(result.stdout)).toEqual([
      { type: 'result', status: 'error', code: 'GRID_LOGIN_FAILED', message: expect.any(String) },
    ])
  }, 20_000)

  /** ⚠️ Not a shape today's `grid` produces: it refuses on STDERR (`cli/json_error.py` prints there,
   *  and a `SystemExit` string goes there too), and that stream is inherited, so a refusal already
   *  reaches the caller untouched. What this pins is the seam's own property — captured stdout is
   *  never SWALLOWED — which is what stops a child that does write there from vanishing under the
   *  one mode whose whole point is that a client can read the answer. */
  it('does not swallow what the child put on stdout before failing', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await signedInBackend()

    const result = await run(root, ['grid', 'login', '--json'], base,
      { FAKE_GRID_EXIT: '7', FAKE_GRID_STDOUT: '{"error":{"message":"no such grid"}}\n' })

    expect(result.status).toBe(7)
    expect(ndjson(result.stdout)).toEqual([{
      type: 'result',
      status: 'error',
      code: 'GRID_LOGIN_FAILED',
      message: expect.any(String),
      grid: { error: { message: 'no such grid' } },
    }])
  }, 20_000)

  it('reads exit code 2 as an outdated grid CLI, not as a network failure', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await signedInBackend()

    const result = await run(root, ['grid', 'login', '--json'], base, { FAKE_GRID_EXIT: '2' })

    expect(result.status).toBe(2)
    const [line] = ndjson(result.stdout)
    expect(line).toMatchObject({ type: 'result', status: 'error', code: 'GRID_CLI_OUTDATED' })
    expect(String(line.message)).toContain('too old')
  }, 20_000)

  it('says the same thing in the human text', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await signedInBackend()

    const result = await run(root, ['grid', 'login'], base, { FAKE_GRID_EXIT: '2' })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('too old')
  }, 20_000)

  it('reports a missing grid CLI when there is none on PATH', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await signedInBackend()

    const result = await run(root, ['grid', 'login', '--json'], base, {}, 'absent')

    expect(result.status).toBe(1)
    expect(ndjson(result.stdout)).toEqual([
      { type: 'result', status: 'error', code: 'GRID_CLI_MISSING', message: expect.any(String) },
    ])
  }, 20_000)

  it('reports a grid it cannot RUN as missing too, rather than as a failed sign-in', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await signedInBackend()

    const result = await run(root, ['grid', 'login', '--json'], base, {}, 'not-executable')

    // The case above would stay green with the PATH pre-check deleted, because a spawn into an
    // empty PATH answers ENOENT and the fallback maps that to the same code. This one would not: a
    // present-but-unrunnable file is EACCES, which the fallback does NOT recognise, so without the
    // pre-check it would surface as GRID_LOGIN_FAILED.
    expect(result.status).toBe(1)
    expect(ndjson(result.stdout)).toEqual([
      { type: 'result', status: 'error', code: 'GRID_CLI_MISSING', message: expect.any(String) },
    ])
  }, 20_000)
})

describe('harness grid login — when the harness session itself is broken', () => {
  it('names the harness sign-in, not the grid one, when the refresh token is invalid', async () => {
    const root = tempRoot()
    seedSession(root, { expiresAt: Date.now() - 60_000 })
    const { base } = await fakeBackend({
      resolveComputer: () => ({ machine: { machineId: 'm_seeded' } }),
      refresh: () => ({ status: 401, body: { success: false, error: { code: 'REFRESH_TOKEN_INVALID', message: 'nope' } } }),
    })

    const result = await run(root, ['grid', 'login', '--json'], base)

    expect(result.status).toBe(1)
    const [line] = ndjson(result.stdout)
    expect(line).toMatchObject({ type: 'result', status: 'error', code: 'AUTH_ERROR' })
    expect(String(line.message)).toContain('harness login')
  }, 20_000)
})

describe('harness grid login — the sign-in half it inherits', () => {
  it('refreshes an expired token and hands over the NEW one, never the stale one', async () => {
    const root = tempRoot()
    seedSession(root, { expiresAt: Date.now() - 60_000 })
    const { base } = await fakeBackend({
      resolveComputer: () => ({ machine: { machineId: 'm_seeded' } }),
      refresh: () => ({ status: 200, body: { success: true, data: { token: 'tok_refreshed', refreshToken: 'refresh_2', expiresIn: 3600 } } }),
    })

    const result = await run(root, ['grid', 'login', '--json'], base)

    // The whole of this command's answer to "the harness token expired" is that it asks the session
    // manager rather than reading the file: a token read off disk would be `tok_seeded`, and the
    // hand-off would trade a credential the control plane has already stopped accepting.
    expect(result.status).toBe(0)
    expect(readRecord(root).stdin.trim()).toBe('tok_refreshed')
  }, 20_000)

  it('--force reaches the sign-in, so a session on disk does not short-circuit it', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await fakeBackend({
      authorizeNative: () => ({ authorizeUrl: 'https://sso.example.test/authorize?tx=forced', tx: 'tx_forced' }),
      resolveComputer: () => ({ machine: { machineId: 'm_seeded' } }),
    })

    const child = spawn(process.execPath, [TSX, CLI_SOURCE, 'grid', 'login', '--force', '--json'], {
      cwd: CLI_ROOT,
      env: envFor(root, base),
    })
    const first = await new Promise<Record<string, unknown>>((resolve) => {
      let buffered = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString()
        const idx = buffered.indexOf('\n')
        if (idx >= 0) resolve(JSON.parse(buffered.slice(0, idx).trim()))
      })
    })
    child.kill() // it would otherwise wait five minutes for a callback nothing is going to send

    // A seeded session is present, so WITHOUT --force reaching loginCommand this would short-circuit
    // and the first line would be the terminating result instead.
    expect(first).toEqual({ type: 'authorize_url', url: 'https://sso.example.test/authorize?tx=forced' })
  }, 20_000)

  it('codes a backend failure in the sign-in half rather than crashing out of --json', async () => {
    const root = tempRoot()
    seedSession(root)
    // Nothing stubbed: resolve-computer answers 404, the way a backend having a bad minute would.
    const { base } = await fakeBackend({})

    const result = await run(root, ['grid', 'login', '--json'], base)

    // The stream must stay NDJSON. Unguarded this produced a stack trace and NO result line at all.
    expect(result.status).toBe(1)
    expect(ndjson(result.stdout)).toEqual([
      { type: 'result', status: 'error', code: 'BACKEND_ERROR', message: expect.any(String) },
    ])
    expect(result.stderr).not.toContain('Failed to start adapter')
  }, 20_000)
})

describe('the harness grid namespace', () => {
  it('refuses a subcommand it does not have', async () => {
    const root = tempRoot()
    seedSession(root)

    const result = await run(root, ['grid', 'nonsense'], 'http://127.0.0.1:1')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unknown command: grid nonsense')
  }, 20_000)
})
