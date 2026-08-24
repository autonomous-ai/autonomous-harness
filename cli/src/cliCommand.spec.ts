import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_SOURCE = join(CLI_ROOT, 'src', 'cli.ts')
const TSX = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const dirs: string[] = []

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function run(...args: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'harness-cli-command-'))
  dirs.push(root)
  return spawnSync(process.execPath, [TSX, CLI_SOURCE, ...args], {
    cwd: CLI_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      HARNESS_AUTH_DIR: join(root, 'auth'),
      ADAPTER_DATA_DIR: join(root, 'data'),
      ADAPTER_CLI_DIR: join(root, 'cli'),
      ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
      ADAPTER_UPDATE_DISABLE: 'true',
    },
  })
}

describe('CLI login/start command contract', () => {
  it('does not start or open SSO when start has no saved session', () => {
    const result = run('start')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Not signed in. Run: harness login')
    expect(result.stdout).not.toContain('Sign in to Harness in your browser')
  })

  it('rejects the removed join command with the two-step migration', () => {
    const result = run('join')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('`harness join` has been removed.')
    expect(result.stderr).toContain('`harness login`, then `harness start`')
  })

  it('returns a nonzero status for an unknown command', () => {
    const result = run('not-a-command')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unknown command: not-a-command')
  })
})
