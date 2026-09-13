import { execFile } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export type AgentProject = {
  name: string
  cwd: string
  root: string | null
  remote: string | null
  branch: string | null
}

/** Compare remote repositories without publishing embedded credentials or transport syntax. */
export function canonicalRepository(raw: string | null): string | null {
  if (!raw) return null
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$/.exec(raw)
  try {
    const url = new URL(scp && !raw.includes('://') ? `ssh://${scp[1]}/${scp[2]}` : raw)
    if (!['ssh:', 'https:', 'http:', 'git:'].includes(url.protocol) || !url.hostname) return null
    let path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
    if (!path || /[\x00-\x20]/.test(path)) return null
    const host = url.hostname.toLowerCase()
    if (host === 'github.com' || host === 'bitbucket.org') path = path.toLowerCase()
    const defaultPort = url.protocol === 'ssh:' ? '22' : url.protocol === 'git:' ? '9418' : ''
    const port = url.port === defaultPort ? '' : url.port
    return `${host}${port ? `:${port}` : ''}/${path}`
  } catch { return null }
}

/** Bounded subprocesses, no shell, network, or repository mutation. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], {
      timeout: 1500, maxBuffer: 16 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout.trim() || null
  } catch { return null }
}

// Agent list and push frames share this cache. Only four folders run Git at once.
const cache = new Map<string, { at: number; value: Promise<AgentProject> }>()
let running = 0
const waiting: Array<() => void> = []
async function inspect(cwd: string): Promise<AgentProject> {
  if (running >= 4) await new Promise<void>(resolve => waiting.push(resolve))
  else running++
  try {
    const root = await git(cwd, ['rev-parse', '--show-toplevel'])
    if (!root) return { name: basename(cwd) || cwd, cwd, root: null, remote: null, branch: null }
    const remote = await git(cwd, ['config', '--get', 'remote.origin.url'])
    const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    return { name: basename(root), cwd, root, remote: canonicalRepository(remote), branch }
  } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

export function agentProject(cwd: string | null, now = Date.now()): Promise<AgentProject | null> {
  if (!cwd || !isAbsolute(cwd) || cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(cwd)) return Promise.resolve(null)
  const found = cache.get(cwd)
  if (found && now - found.at < 15_000) return found.value
  if (cache.size >= 256) cache.delete(cache.keys().next().value!)
  const value = inspect(cwd)
  cache.set(cwd, { at: now, value })
  return value
}
