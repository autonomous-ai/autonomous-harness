import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path'

export const HERDR_API_PROTOCOL = 19
export const HERDR_API_SCHEMA_VERSION = 1
export const HERDR_API_MAX_REQUEST_BYTES = 1024 * 1024
export const HERDR_API_MAX_RESPONSE_BYTES = 1024 * 1024

const HERDR_VERSION_RE = /^0\.8\.\d+(?:[-+].*)?$/
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface HerdrEndpointGeneration {
  device: number
  inode: number
}

export interface HerdrEndpoint {
  sessionName: string
  endpointId: string
  socketPath: string
  generation: HerdrEndpointGeneration
}

export type HerdrMutationKind = 'none' | 'single_enqueue' | 'single_key' | 'multi_enqueue' | 'other'

export type HerdrApiResult<T> =
  | { ok: true; result: T }
  | {
      ok: false
      dispatch: 'not_started' | 'rejected' | 'possibly_executed'
      code?: string
      reason: string
    }

export interface HerdrPong {
  type: 'pong'
  version: string
  protocol: number
  capabilities?: {
    live_handoff: boolean
    detached_server_daemon: boolean
  } | null
}

export interface HerdrApiClientOptions {
  timeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
}

export interface HerdrRequestOptions {
  mutation?: HerdrMutationKind
  signal?: AbortSignal
}

export class HerdrEndpointError extends Error {
  constructor(public readonly code: string) {
    super(`Herdr endpoint rejected (${code})`)
    this.name = 'HerdrEndpointError'
  }
}

function mode(value: number): number {
  return value & 0o7777
}

function pathComponents(path: string): string[] {
  const root = parse(path).root
  const relative = path.slice(root.length)
  const components = relative.split(sep).filter(Boolean)
  const paths = [root]
  for (const component of components) paths.push(resolve(paths.at(-1)!, component))
  return paths
}

async function checkedSocket(socketPath: string): Promise<HerdrEndpointGeneration> {
  if (!isAbsolute(socketPath)) throw new HerdrEndpointError('path_not_absolute')
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid === null) throw new HerdrEndpointError('uid_unavailable')

  const parent = dirname(socketPath)
  for (const path of pathComponents(parent)) {
    let stat
    try { stat = await lstat(path) } catch { throw new HerdrEndpointError('directory_unavailable') }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HerdrEndpointError('unsafe_directory_type')
    if (stat.uid !== uid && stat.uid !== 0) throw new HerdrEndpointError('unsafe_directory_owner')
    const permissions = mode(stat.mode)
    if ((permissions & 0o002) !== 0 || (stat.uid === 0 && (permissions & 0o020) !== 0)) {
      throw new HerdrEndpointError('unsafe_directory_mode')
    }
  }

  let parentStat
  try { parentStat = await lstat(parent) } catch { throw new HerdrEndpointError('parent_unavailable') }
  if (parentStat.uid !== uid) throw new HerdrEndpointError('unsafe_parent_owner')

  let socketStat
  try { socketStat = await lstat(socketPath) } catch { throw new HerdrEndpointError('socket_unavailable') }
  if (!socketStat.isSocket() || socketStat.isSymbolicLink()) throw new HerdrEndpointError('unsafe_socket_type')
  if (socketStat.uid !== uid) throw new HerdrEndpointError('unsafe_socket_owner')
  if (mode(socketStat.mode) !== 0o600) throw new HerdrEndpointError('unsafe_socket_mode')

  let canonical
  try { canonical = await realpath(socketPath) } catch { throw new HerdrEndpointError('socket_unavailable') }
  if (canonical !== resolve(socketPath)) throw new HerdrEndpointError('socket_not_canonical')
  return { device: socketStat.dev, inode: socketStat.ino }
}

export async function resolveHerdrEndpoint(input: {
  sessionName: string
  socketPath: string
}): Promise<HerdrEndpoint> {
  if (!SESSION_NAME_RE.test(input.sessionName)) throw new HerdrEndpointError('invalid_session_name')
  const generation = await checkedSocket(input.socketPath)
  const socketPath = await realpath(input.socketPath)
  const endpointId = createHash('sha256')
    .update('herdr\0')
    .update(input.sessionName)
    .update('\0')
    .update(socketPath)
    .digest('hex')
    .slice(0, 16)
  return { sessionName: input.sessionName, endpointId, socketPath, generation }
}

async function endpointGenerationMatches(endpoint: HerdrEndpoint): Promise<boolean> {
  try {
    const current = await checkedSocket(endpoint.socketPath)
    return current.device === endpoint.generation.device && current.inode === endpoint.generation.inode
  } catch {
    return false
  }
}

function failure(
  dispatch: 'not_started' | 'rejected' | 'possibly_executed',
  reason: string,
  code?: string,
): HerdrApiResult<never> {
  return { ok: false, dispatch, reason, ...(code ? { code } : {}) }
}

function structuredErrorDispatch(code: string, mutation: HerdrMutationKind): 'rejected' | 'possibly_executed' {
  if (mutation === 'none') return 'rejected'
  if (code === 'invalid_request' || code === 'invalid_params' || code === 'pane_not_found' || code === 'invalid_key') {
    return 'rejected'
  }
  if (code === 'pane_send_failed' && (mutation === 'single_enqueue' || mutation === 'single_key')) {
    return 'rejected'
  }
  return 'possibly_executed'
}

function socketFailure(writeAttempted: boolean, reason: string): HerdrApiResult<never> {
  return failure(writeAttempted ? 'possibly_executed' : 'not_started', reason)
}

function safeObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export class HerdrApiClient {
  private readonly timeoutMs: number
  private readonly maxRequestBytes: number
  private readonly maxResponseBytes: number

  constructor(
    readonly endpoint: HerdrEndpoint,
    options: HerdrApiClientOptions = {},
  ) {
    this.timeoutMs = Math.max(50, Math.min(10_000, options.timeoutMs ?? 2_000))
    this.maxRequestBytes = Math.max(128, Math.min(HERDR_API_MAX_REQUEST_BYTES, options.maxRequestBytes ?? HERDR_API_MAX_REQUEST_BYTES))
    this.maxResponseBytes = Math.max(128, Math.min(HERDR_API_MAX_RESPONSE_BYTES, options.maxResponseBytes ?? HERDR_API_MAX_RESPONSE_BYTES))
  }

  async ping(signal?: AbortSignal): Promise<HerdrApiResult<HerdrPong>> {
    const response = await this.request<HerdrPong>('ping', {}, { mutation: 'none', signal })
    if (!response.ok) return response
    const pong = response.result
    const capabilities = pong.capabilities
    if (
      pong.type !== 'pong'
      || !HERDR_VERSION_RE.test(pong.version)
      || pong.protocol !== HERDR_API_PROTOCOL
      || (capabilities != null && (
        typeof capabilities.live_handoff !== 'boolean'
        || typeof capabilities.detached_server_daemon !== 'boolean'
      ))
    ) {
      return failure('rejected', 'Herdr API protocol is incompatible', 'protocol_mismatch')
    }
    return response
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options: HerdrRequestOptions = {},
  ): Promise<HerdrApiResult<T>> {
    const mutation = options.mutation ?? 'none'
    if (options.signal?.aborted) return failure('not_started', 'Herdr API request was aborted')

    const id = randomUUID()
    let frame: Buffer
    try {
      frame = Buffer.from(`${JSON.stringify({ id, method, params })}\n`, 'utf8')
    } catch {
      return failure('not_started', 'Herdr API request could not be serialized')
    }
    if (frame.byteLength > this.maxRequestBytes) {
      return failure('not_started', 'Herdr API request exceeds the size limit')
    }
    if (!(await endpointGenerationMatches(this.endpoint))) {
      return failure('not_started', 'Herdr endpoint is unavailable or changed')
    }

    return new Promise<HerdrApiResult<T>>((resolveResult) => {
      let socket: Socket | null = null
      let writeAttempted = false
      let settled = false
      let response = Buffer.alloc(0)

      const finish = (result: HerdrApiResult<T>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        socket?.destroy()
        resolveResult(result)
      }
      const onAbort = (): void => finish(socketFailure(writeAttempted, 'Herdr API request was aborted'))
      const timer = setTimeout(() => finish(socketFailure(writeAttempted, 'Herdr API request timed out')), this.timeoutMs)
      options.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        socket = createConnection({ path: this.endpoint.socketPath })
      } catch {
        finish(failure('not_started', 'Herdr API connection could not be created'))
        return
      }

      socket.once('connect', () => {
        void endpointGenerationMatches(this.endpoint).then((matches) => {
          if (settled) return
          if (!matches) {
            finish(failure('not_started', 'Herdr endpoint changed before dispatch'))
            return
          }
          writeAttempted = true
          try {
            socket!.end(frame)
          } catch {
            finish(failure('possibly_executed', 'Herdr API request write failed'))
          }
        })
      })
      socket.on('data', (chunk: Buffer) => {
        if (settled) return
        response = Buffer.concat([response, chunk])
        if (response.byteLength > this.maxResponseBytes) {
          finish(socketFailure(writeAttempted, 'Herdr API response exceeds the size limit'))
          return
        }
        const newline = response.indexOf(0x0a)
        if (newline < 0) return
        if (response.subarray(newline + 1).toString('utf8').trim() !== '') {
          finish(socketFailure(writeAttempted, 'Herdr API returned multiple responses'))
          return
        }
        let parsed: unknown
        try { parsed = JSON.parse(response.subarray(0, newline).toString('utf8')) } catch {
          finish(socketFailure(writeAttempted, 'Herdr API returned malformed JSON'))
          return
        }
        if (!safeObject(parsed) || parsed.id !== id) {
          finish(socketFailure(writeAttempted, 'Herdr API response correlation failed'))
          return
        }
        if ('error' in parsed) {
          const body = parsed.error
          if (!safeObject(body) || typeof body.code !== 'string') {
            finish(socketFailure(writeAttempted, 'Herdr API returned a malformed error'))
            return
          }
          const dispatch = structuredErrorDispatch(body.code, mutation)
          finish(failure(dispatch, `Herdr API request failed (${body.code})`, body.code))
          return
        }
        if (!('result' in parsed)) {
          finish(socketFailure(writeAttempted, 'Herdr API response is missing a result'))
          return
        }
        finish({ ok: true, result: parsed.result as T })
      })
      socket.once('end', () => {
        if (!settled) finish(socketFailure(writeAttempted, 'Herdr API response ended early'))
      })
      socket.once('error', () => finish(socketFailure(writeAttempted, 'Herdr API transport failed')))
    })
  }
}
