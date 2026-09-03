import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_SOURCE = join(CLI_ROOT, 'src', 'cli.ts')
const TSX = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const dirs: string[] = []
const MACHINE_ID = 'a'.repeat(32)

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/**
 * Run the CLI with an isolated HOME, and point the backend at a port nothing listens on.
 *
 * That unreachable address is the assertion mechanism, not a detail: a command that refuses locally
 * must succeed at refusing WITHOUT reaching the network, so any code path that tries to talk to the
 * backend fails loudly here instead of quietly passing.
 */
function run(args: string[], session?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'harness-machines-'))
  dirs.push(root)
  const authDir = join(root, 'auth')
  if (session) {
    mkdirSync(authDir, { recursive: true })
    writeFileSync(join(authDir, 'session.json'), JSON.stringify(session), { mode: 0o600 })
  }
  return spawnSync(process.execPath, [TSX, CLI_SOURCE, ...args], {
    cwd: CLI_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      HARNESS_AUTH_DIR: authDir,
      ADAPTER_DATA_DIR: join(root, 'data'),
      ADAPTER_CLI_DIR: join(root, 'cli'),
      ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
      ADAPTER_UPDATE_DISABLE: 'true',
      BACKEND_WS_URL: 'ws://127.0.0.1:9',
    },
  })
}

const signedIn = {
  version: 1,
  accessToken: 'test-access-token',
  autonomousEnv: 'prod',
  computerId: 'computer-under-test',
  machineId: MACHINE_ID,
  updatedAt: Date.now(),
}

describe('harness machines delete', () => {
  it('refuses to delete THIS computer\'s machine, without reaching the backend', () => {
    const result = run(['machines', 'delete', MACHINE_ID], signedIn)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('THIS computer\'s machine')
    expect(result.stderr).toContain('harness logout')
    // The unreachable backend would surface as a connect error; its absence is the proof that the
    // refusal happened locally, before any token refresh or list fetch.
    expect(result.stderr).not.toContain('ECONNREFUSED')
    expect(result.stderr).not.toContain('fetch failed')
  })

  it('refuses on the short id the list prints, not just the full one', () => {
    const result = run(['machines', 'delete', MACHINE_ID.slice(0, 8)], signedIn)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('THIS computer\'s machine')
  })

  it('asks for an id rather than guessing one', () => {
    const result = run(['machines', 'delete'], signedIn)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage: harness machines delete')
  })

  it('reports being signed out instead of failing against the backend', () => {
    const result = run(['machines'])

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain('Not signed in')
  })
})
