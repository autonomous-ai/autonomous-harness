import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'

import { env } from '../config/env.js'
import { managedNodePath } from './nodeRuntime.js'
import { downloadVerified } from './selfUpdate.js'

/**
 * Provisioning the Node the CLI runs on, from inside the CLI.
 *
 * Until now only the shell installers ever wrote a runtime or a launcher, and nothing re-ran them —
 * so a computer installed before the product owned its Node keeps a launcher that execs a bare `node`
 * (or an absolute path to a system Node that may since have been removed), and stays broken until
 * somebody re-runs an installer by hand. Doing it here means `harness start` and the post-update
 * restart repair the machine themselves.
 *
 * Everything in this file is best-effort and returns rather than throws: a daemon must not fail to
 * start because a download failed. It keeps running on the interpreter it already has, and tries
 * again next start.
 */

/** `darwin-arm64` | `darwin-x64` | `linux-arm64` | `linux-x64`, or null off those platforms. */
function platformKey(): string | null {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  return os && arch ? `${os}-${arch}` : null
}

interface RuntimeArtifact {
  version: string
  url: string
  sha256: string
  size?: number
  archiveRoot: string
}

function artifactFor(document: unknown, key: string): RuntimeArtifact | null {
  const node = (document as { node?: Record<string, unknown> } | null)?.node
  const raw = node?.[key] as Partial<RuntimeArtifact> | undefined
  if (!raw || typeof raw.version !== 'string' || typeof raw.url !== 'string') return null
  if (typeof raw.sha256 !== 'string' || typeof raw.archiveRoot !== 'string') return null
  // Refuse a plaintext URL: this archive becomes the interpreter for everything the CLI runs.
  if (!raw.url.startsWith('https://')) return null
  return { version: raw.version, url: raw.url, sha256: raw.sha256, size: raw.size, archiveRoot: raw.archiveRoot }
}

function runs(node: string): boolean {
  try {
    execFileSync(node, ['--version'], { timeout: 15_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * The managed Node, installing it when this computer has not got one. Returns its path, or null when
 * no runtime could be provisioned — callers keep whatever interpreter they already have.
 *
 * Idempotent and cheap once installed: [managedNodePath] returning a path under the runtime directory
 * means the work is already done, and nothing is fetched.
 */
export async function ensureManagedRuntime(log: (message: string) => void = () => {}): Promise<string | null> {
  const existing = managedNodePath()
  if (existing.startsWith(env.ADAPTER_RUNTIME_DIR + sep)) return existing

  const key = platformKey()
  if (!key) return null

  try {
    const response = await fetch(env.ADAPTER_RUNTIME_METADATA_URL)
    if (!response.ok) return null
    const artifact = artifactFor(await response.json(), key)
    if (!artifact) return null

    const target = join(env.ADAPTER_RUNTIME_DIR, `node-${artifact.version}-${key}`)
    const node = join(target, 'bin', 'node')
    if (!existsSync(node)) {
      log(`▸ installing the Harness Node runtime (${artifact.version}, ${key})…`)
      // downloadVerified checks the sha256 but not the length, so check it here: a truncated body
      // that somehow collided would be caught by the hash anyway, but a mismatch here is the cheaper
      // and clearer failure.
      const bytes = await downloadVerified(artifact)
      if (artifact.size !== undefined && bytes.length !== artifact.size) return null

      mkdirSync(env.ADAPTER_RUNTIME_DIR, { recursive: true, mode: 0o700 })
      const staging = join(env.ADAPTER_RUNTIME_DIR, `.node-staging-${process.pid}-${Date.now()}`)
      try {
        mkdirSync(staging, { recursive: true, mode: 0o700 })
        const archive = join(staging, 'node.tar.gz')
        writeFileSync(archive, bytes)
        execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', staging], { timeout: 120_000, stdio: 'ignore' })
        const unpacked = join(staging, artifact.archiveRoot)
        if (!existsSync(join(unpacked, 'bin', 'node'))) return null
        // Another start may have won the race; theirs is as good as ours.
        if (!existsSync(target)) renameSync(unpacked, target)
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    }

    if (!runs(node)) return null
    // Written last, and only once the binary has answered: Desktop Harness and the hook installer
    // both read this file to decide what to execute, so it must never name something that cannot run.
    writeFileSync(join(env.ADAPTER_RUNTIME_DIR, 'current-node'), `${node}\n`, { mode: 0o600 })
    log(`  ✓ Node runtime ready → ${target}`)
    return node
  } catch {
    return null
  }
}

/** The trailing `exec …` line, which is the only line any launcher we ship varies. */
const EXEC_LINE = /^exec .*$/m

/**
 * Repoints the `harness` launcher at [node].
 *
 * Three launcher shapes have shipped — the public installer's two-liner, `install-cli.sh`'s, and its
 * `--no-updates` variant carrying a comment block and `ADAPTER_UPDATE_DISABLE=true`. All three end in
 * a single `exec … cli.js "$@"` line with everything else preamble, so replacing ONLY that line
 * handles all three and preserves a developer's pin for free: the interpreter is repaired, and the
 * promise that no release reaches that computer on its own is untouched.
 */
export function ensureLauncher(node: string, log: (message: string) => void = () => {}): void {
  try {
    const launcher = join(env.HARNESS_BIN_DIR, 'harness')
    const current = readFileSync(launcher, 'utf-8')
    const cli = join(env.ADAPTER_CLI_DIR, 'cli.js')
    const exec = EXEC_LINE.exec(current)
    // Only ever rewrite a launcher that runs OUR bundle. Anything else at this path belongs to
    // somebody else, and a missing launcher means the CLI is being run some other way — writing one
    // nobody asked for is a different feature.
    if (!exec || !exec[0].includes(cli)) return

    const next = current.replace(EXEC_LINE, `exec ${shellQuote(node)} ${shellQuote(cli)} "$@"`)
    if (next === current) return

    const temporary = `${launcher}.tmp-${process.pid}`
    writeFileSync(temporary, next, { mode: 0o755 })
    renameSync(temporary, launcher)
    log(`  ✓ repointed ${launcher} at ${node}`)
  } catch {
    // A read-only bin dir, a launcher owned by another user — none of it is worth failing a start.
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
