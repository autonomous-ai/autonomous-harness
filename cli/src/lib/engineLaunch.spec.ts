import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BYPASS_PERMISSION_FLAGS,
  buildEngineCommandArgv,
  buildEngineLaunchArgv,
  commandAvailableInInteractiveShell,
} from './engineLaunch.js'
import { ENGINES } from '../engines/types.js'
import { engineBin } from './engineBin.js'

describe('buildEngineLaunchArgv', () => {
  it('wraps zsh in its interactive login form and execs the resolved binary', () => {
    expect(buildEngineLaunchArgv('claude', {}, '/bin/zsh')).toEqual([
      '/bin/zsh', '-lic', 'exec "$@"', 'harness-engine', engineBin('claude'),
    ])
  })

  it('uses Ubuntu bash interactive startup files without making it a login shell', () => {
    expect(buildEngineLaunchArgv('claude', {}, '/bin/bash')).toEqual([
      '/bin/bash', '-ic', 'exec "$@"', 'harness-engine', engineBin('claude'),
    ])
  })

  it('falls back to direct execution when no absolute shell is available', () => {
    expect(buildEngineLaunchArgv('claude', {}, '')).toEqual([engineBin('claude')])
    expect(buildEngineLaunchArgv('claude', {}, 'zsh')).toEqual([engineBin('claude')])
  })

  it('appends the confirmed flag for engines with a known bypass flag', () => {
    expect(buildEngineCommandArgv('claude', { bypassPermission: true }))
      .toEqual([engineBin('claude'), '--dangerously-skip-permissions'])
    expect(buildEngineCommandArgv('codex', { bypassPermission: true }))
      .toEqual([engineBin('codex'), '--dangerously-bypass-approvals-and-sandbox'])
    expect(buildEngineCommandArgv('cursor', { bypassPermission: true }))
      .toEqual([engineBin('cursor'), '--force'])
    expect(buildEngineCommandArgv('opencode', { bypassPermission: true }))
      .toEqual([engineBin('opencode'), '--auto'])
  })

  it('is a no-op for engines with no confirmed flag, even when bypass is requested', () => {
    expect(buildEngineCommandArgv('pi', { bypassPermission: true })).toEqual([engineBin('pi')])
    expect(buildEngineCommandArgv('hermes', { bypassPermission: true })).toEqual([engineBin('hermes')])
  })

  it('has an entry (possibly null) for every known engine — no engine silently falls through', () => {
    for (const engine of ENGINES) {
      expect(Object.prototype.hasOwnProperty.call(BYPASS_PERMISSION_FLAGS, engine)).toBe(true)
    }
  })
})

const dirs: string[] = []
const originalProbePath = process.env.HARNESS_ENGINE_TEST_PATH

afterEach(() => {
  if (originalProbePath === undefined) delete process.env.HARNESS_ENGINE_TEST_PATH
  else process.env.HARNESS_ENGINE_TEST_PATH = originalProbePath
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function executable(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o700)
  return path
}

function bashProbeShell(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-engine-shell-'))
  dirs.push(dir)
  const shell = join(dir, 'bash')
  writeFileSync(shell, `#!/bin/sh
[ "$1" = '-ic' ] || exit 97
shift
script="$1"
shift
PATH="$HARNESS_ENGINE_TEST_PATH"
export PATH
exec /bin/sh -c "$script" "$@"
`)
  chmodSync(shell, 0o700)
  return shell
}

describe('commandAvailableInInteractiveShell', () => {
  it('uses the same bash interactive PATH that launches a new engine', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'harness-engine-bin-'))
    dirs.push(binDir)
    executable(binDir, 'kilo')
    process.env.HARNESS_ENGINE_TEST_PATH = binDir

    await expect(commandAvailableInInteractiveShell('kilo', bashProbeShell())).resolves.toBe(true)
    await expect(commandAvailableInInteractiveShell('missing-engine', bashProbeShell())).resolves.toBe(false)
  })
})
