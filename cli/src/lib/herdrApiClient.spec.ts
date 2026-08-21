import { createServer, type Server } from 'node:net'
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
import {
  HERDR_API_PROTOCOL,
  HERDR_API_SCHEMA_VERSION,
  HerdrApiClient,
  HerdrEndpointError,
  resolveHerdrEndpoint,
  type HerdrEndpoint,
} from './herdrApiClient.js'

const dirs: string[] = []
const servers: Server[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(homedir(), '.harness-herdr-api-test-'))
  dirs.push(dir)
  await chmod(dir, 0o700)
  return dir
}

async function socketServer(
  handle: (request: Record<string, unknown>, socket: import('node:net').Socket) => void,
): Promise<{ endpoint: HerdrEndpoint; socketPath: string }> {
  const dir = await tempDir()
  const socketPath = join(dir, 'herdr.sock')
  const server = createServer((socket) => {
    let input = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      input += chunk
      const newline = input.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>
      handle(request, socket)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  await chmod(socketPath, 0o600)
  return {
    socketPath,
    endpoint: await resolveHerdrEndpoint({ sessionName: 'test', socketPath }),
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('HerdrApiClient', () => {
  it('uses one bounded NDJSON request and validates the response id', async () => {
    let observed: Record<string, unknown> | null = null
    const { endpoint } = await socketServer((request, socket) => {
      observed = request
      socket.end(`${JSON.stringify({
        id: request.id,
        result: {
          type: 'pong',
          version: '0.8.0',
          protocol: HERDR_API_PROTOCOL,
          capabilities: { live_handoff: true, detached_server_daemon: true },
        },
      })}\n`)
    })

    const result = await new HerdrApiClient(endpoint).ping()

    expect(result).toEqual({
      ok: true,
      result: {
        type: 'pong',
        version: '0.8.0',
        protocol: HERDR_API_PROTOCOL,
        capabilities: { live_handoff: true, detached_server_daemon: true },
      },
    })
    expect(observed).toMatchObject({ method: 'ping', params: {} })
    expect(typeof (observed as Record<string, unknown> | null)?.id).toBe('string')
  })

  it('classifies validation, connect, and pre-write abort failures as not started', async () => {
    const dir = await tempDir()
    const missing = join(dir, 'missing.sock')
    await expect(resolveHerdrEndpoint({ sessionName: 'missing', socketPath: missing }))
      .rejects.toBeInstanceOf(HerdrEndpointError)

    const { endpoint } = await socketServer((_request, socket) => socket.end())
    const controller = new AbortController()
    controller.abort()
    await expect(new HerdrApiClient(endpoint).request('pane.send_input', {
      pane_id: 'w1:p1',
      text: 'secret-prompt',
      keys: ['Enter'],
    }, { mutation: 'single_enqueue', signal: controller.signal })).resolves.toMatchObject({
      ok: false,
      dispatch: 'not_started',
    })
  })

  it('classifies a lost response after write as possibly executed without leaking request text', async () => {
    const { endpoint } = await socketServer((_request, socket) => socket.destroy())
    const result = await new HerdrApiClient(endpoint, { timeoutMs: 250 }).request('pane.send_input', {
      pane_id: 'w1:p1',
      text: 'unique-secret-prompt',
      keys: ['Enter'],
    }, { mutation: 'single_enqueue' })

    expect(result).toMatchObject({ ok: false, dispatch: 'possibly_executed' })
    expect(JSON.stringify(result)).not.toContain('unique-secret-prompt')
    expect(JSON.stringify(result)).not.toContain(endpoint.socketPath)
  })

  it('classifies only proven single-enqueue rejections as rejected', async () => {
    const { endpoint } = await socketServer((request, socket) => {
      socket.end(`${JSON.stringify({
        id: request.id,
        error: { code: 'pane_send_failed', message: 'queue full' },
      })}\n`)
    })
    const client = new HerdrApiClient(endpoint)

    await expect(client.request('pane.send_input', {
      pane_id: 'w1:p1', text: 'hello', keys: ['Enter'],
    }, { mutation: 'single_enqueue' })).resolves.toMatchObject({
      ok: false,
      dispatch: 'rejected',
      code: 'pane_send_failed',
    })
    await expect(client.request('pane.send_keys', {
      pane_id: 'w1:p1', keys: ['Down', 'Enter'],
    }, { mutation: 'multi_enqueue' })).resolves.toMatchObject({
      ok: false,
      dispatch: 'possibly_executed',
      code: 'pane_send_failed',
    })
  })

  it('treats malformed, mismatched, and oversized post-write responses as ambiguous', async () => {
    const cases = [
      (request: Record<string, unknown>, socket: import('node:net').Socket) => socket.end('{bad json}\n'),
      (_request: Record<string, unknown>, socket: import('node:net').Socket) => socket.end('{"id":"wrong","result":{"type":"ok"}}\n'),
      (request: Record<string, unknown>, socket: import('node:net').Socket) => socket.end(`${JSON.stringify({ id: request.id, result: { type: 'ok', padding: 'x'.repeat(2_000) } })}\n`),
    ]
    for (const handle of cases) {
      const { endpoint } = await socketServer(handle)
      const result = await new HerdrApiClient(endpoint, { maxResponseBytes: 1_024 }).request(
        'pane.send_input',
        { pane_id: 'w1:p1', text: 'hello', keys: ['Enter'] },
        { mutation: 'single_enqueue' },
      )
      expect(result).toMatchObject({ ok: false, dispatch: 'possibly_executed' })
    }
  })

  it('rejects oversized requests before connecting', async () => {
    let requests = 0
    const { endpoint } = await socketServer((_request, socket) => { requests++; socket.end() })
    const result = await new HerdrApiClient(endpoint, { maxRequestBytes: 256 }).request(
      'pane.send_input',
      { pane_id: 'w1:p1', text: 'x'.repeat(512), keys: ['Enter'] },
      { mutation: 'single_enqueue' },
    )
    expect(result).toMatchObject({ ok: false, dispatch: 'not_started' })
    expect(requests).toBe(0)
  })

  /**
   * Skipped when the suite itself runs as root (common in a container). `checkedSocket` rejects a
   * root-OWNED directory that is group-writable — `(stat.uid === 0 && permissions & 0o020)` — because
   * under root ownership the group bit really does let another account plant a socket. The rule is
   * correct; it is this case's premise ("the owner is a normal account") that does not hold as root.
   * Same precedent as the getuid()===0 guard in lib/fsBrowse.spec.ts.
   */
  it.skipIf(isRoot)('accepts an owner-owned 0775 socket parent under the local account-owner trust model', async () => {
    const root = await tempDir()
    const parent = join(root, 'herdr')
    await mkdir(parent, { mode: 0o775 })
    await chmod(parent, 0o775)
    const socketPath = join(parent, 'herdr.sock')
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    await chmod(socketPath, 0o600)

    await expect(resolveHerdrEndpoint({ sessionName: 'shared-group', socketPath })).resolves.toMatchObject({
      sessionName: 'shared-group', socketPath,
    })
  })

  it('rejects symlinked, permissive, and changed endpoint artifacts', async () => {
    const { endpoint, socketPath } = await socketServer((request, socket) => {
      socket.end(`${JSON.stringify({ id: request.id, result: { type: 'ok' } })}\n`)
    })
    const linkPath = join(await tempDir(), 'linked.sock')
    await symlink(socketPath, linkPath)
    await expect(resolveHerdrEndpoint({ sessionName: 'linked', socketPath: linkPath }))
      .rejects.toBeInstanceOf(HerdrEndpointError)

    await chmod(socketPath, 0o666)
    await expect(resolveHerdrEndpoint({ sessionName: 'permissive', socketPath }))
      .rejects.toBeInstanceOf(HerdrEndpointError)
    await chmod(socketPath, 0o600)

    const parent = join(await tempDir(), 'unsafe')
    await mkdir(parent, { mode: 0o777 })
    await chmod(parent, 0o777)
    const unsafeSocket = join(parent, 'herdr.sock')
    const unsafeServer = createServer()
    servers.push(unsafeServer)
    await new Promise<void>((resolve) => unsafeServer.listen(unsafeSocket, resolve))
    await chmod(unsafeSocket, 0o600)
    await expect(resolveHerdrEndpoint({ sessionName: 'unsafe', socketPath: unsafeSocket }))
      .rejects.toBeInstanceOf(HerdrEndpointError)

    const before = await lstat(socketPath)
    expect(endpoint.generation).toEqual({ device: before.dev, inode: before.ino })
  })

  it('pins the generated v0.8 schema and live protocol tuple', () => {
    expect(HERDR_API_PROTOCOL).toBe(19)
    expect(HERDR_API_SCHEMA_VERSION).toBe(1)
  })
})
