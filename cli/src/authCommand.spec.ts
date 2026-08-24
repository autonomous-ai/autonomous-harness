import { spawn, spawnSync } from 'child_process'
import { createServer, type Server } from 'http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
    // http.Server#close() only stops NEW connections — it waits forever for any keep-alive socket the
    // CLI's own `fetch` left open (undici pools connections for reuse) unless those are force-closed too.
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-cli-auth-'))
  dirs.push(root)
  return root
}

function seedSession(root: string): void {
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
  }))
}

function envFor(root: string, backendUrl?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    HARNESS_AUTH_DIR: join(root, 'auth'),
    ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_CLI_DIR: join(root, 'cli'),
    ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
    ADAPTER_UPDATE_DISABLE: 'true',
    ...(backendUrl ? { BACKEND_WS_URL: backendUrl } : {}),
  }
}

function runSync(root: string, args: string[], backendUrl?: string) {
  return spawnSync(process.execPath, [TSX, CLI_SOURCE, ...args], {
    cwd: CLI_ROOT,
    encoding: 'utf8',
    env: envFor(root, backendUrl),
  })
}

/** Async spawn — REQUIRED (not spawnSync) whenever the child talks back to a fake backend hosted in
 *  this same test process: spawnSync blocks this process's entire event loop until the child exits,
 *  so a fake server living here could never answer the child's request and the pair would deadlock. */
function runAsync(root: string, args: string[], backendUrl?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, CLI_SOURCE, ...args], { cwd: CLI_ROOT, env: envFor(root, backendUrl) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.once('exit', (status) => resolve({ status, stdout, stderr }))
  })
}

/** A minimal fake backend for the two `/api/auth/*` + resolve-computer calls `harness login`/
 *  `auth status` make — real network shape, canned answers, so the CLI's own code runs unmodified. */
function fakeBackend(handlers: {
  authorizeNative?: (body: any) => any
  exchange?: (body: any) => any
  resolveComputer?: (body: any) => any
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

describe('harness auth status --json', () => {
  it('reports loggedIn:false with no saved session, and never touches the network', () => {
    const root = tempRoot()
    const result = runSync(root, ['auth', 'status', '--json'], 'http://127.0.0.1:1') // port 1: would fail fast if ever called
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual({ loggedIn: false })
  })

  it('falls back to human text without --json', () => {
    const root = tempRoot()
    const result = runSync(root, ['auth', 'status'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Not signed in')
  })

  it('reports loggedIn:true from a saved, non-expiring session without a network round trip', () => {
    const root = tempRoot()
    seedSession(root)
    const result = runSync(root, ['auth', 'status', '--json'], 'http://127.0.0.1:1')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual({
      loggedIn: true,
      computerId: 'a'.repeat(32),
      machineId: 'm_seeded',
      autonomousEnv: 'prod',
      expiresAt: expect.any(Number),
    })
  })
})

describe('harness login --json', () => {
  it('already-signed-in short-circuit emits a single success result line', async () => {
    const root = tempRoot()
    seedSession(root)
    const { base } = await fakeBackend({
      resolveComputer: () => ({ machine: { machineId: 'm_seeded' } }),
    })
    const result = await runAsync(root, ['login', '--json'], base)
    expect(result.status).toBe(0)
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([{ type: 'result', status: 'success', alreadySignedIn: true }])
  })

  it('emits a BACKEND_ERROR result line (not a stack trace) when authorize-native is unreachable', async () => {
    const root = tempRoot()
    const result = await runAsync(root, ['login', '--json'], 'http://127.0.0.1:1')
    expect(result.status).toBe(1)
    const lines = result.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines).toEqual([{ type: 'result', status: 'error', code: 'BACKEND_ERROR', message: expect.any(String) }])
  })

  it('drives the full loopback flow: emits authorize_url, then a success result once the callback lands', async () => {
    const root = tempRoot()
    let capturedRedirectUri = ''
    const { base } = await fakeBackend({
      authorizeNative: (body) => { capturedRedirectUri = body.redirectUri; return { authorizeUrl: 'https://sso.example.test/authorize?tx=abc', tx: 'tx_abc' } },
      exchange: () => ({ token: 'tok_new', refreshToken: 'refresh_new', expiresIn: 3600, autonomousEnv: 'prod' }),
      resolveComputer: () => ({ machine: { machineId: 'm_new' } }),
    })

    const child = spawn(process.execPath, [TSX, CLI_SOURCE, 'login', '--json'], {
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
    expect(capturedRedirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    // Simulate the browser completing SSO: hit this CLI's own loopback callback server.
    await fetch(`${capturedRedirectUri}?code=code_123&state=state_456`)

    const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    expect(exitCode).toBe(0)
    // Drain any trailing buffered line after exit.
    if (stdout.trim()) lines.push(JSON.parse(stdout.trim()))
    expect(lines[1]).toEqual({ type: 'result', status: 'success' })
  }, 15_000)
})
