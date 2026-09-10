import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isCodexHome, resolveCodexHome } from './codexHome.js'
import { buildEngineLaunchArgv } from './engineLaunch.js'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'harness-codex-profile-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('local Codex account homes', () => {
  it('accepts an existing home without reading or replacing credentials', () => {
    const auth = join(directory, 'auth.json')
    writeFileSync(auth, 'private fixture, deliberately not JSON')
    expect(resolveCodexHome(directory)).toBe(realpathSync(directory))
    expect(resolveCodexHome(auth)).toBeNull()
    expect(resolveCodexHome(join(directory, 'missing'))).toBeNull()
  })

  it.each([null, '', 'codex2', '~/codex2', '/tmp/bad\npath', '/tmp/bad\0path', {}, []])(
    'refuses a malformed home: %j', (value) => { expect(isCodexHome(value)).toBe(false) },
  )

  it('launches two accounts independently and treats shell syntax in a path as data', () => {
    const executable = join(directory, 'fake-codex')
    writeFileSync(executable, '#!/bin/sh\nprintf "%s" "$CODEX_HOME"\n')
    chmodSync(executable, 0o700)
    const homes = [join(directory, 'account one'), join(directory, "account'$(touch unwanted)")]
    for (const codexHome of homes) {
      mkdirSync(codexHome)
      const argv = buildEngineLaunchArgv('codex', { codexHome }, '/bin/zsh')
      // Run the exact launch body through a clean shell, with a harmless engine
      // stand-in. This neither sources the developer's rc files nor starts Codex.
      argv[4] = executable
      const result = execFileSync('/bin/sh', ['-c', argv[2], ...argv.slice(3)], {
        cwd: directory,
        env: { ...process.env, CODEX_HOME: '/wrong/inherited/account' },
        encoding: 'utf8',
      })
      expect(result).toBe(codexHome)
    }
    expect(existsSync(join(directory, 'unwanted'))).toBe(false)
  })

  it('preserves the selected home on resume and in the direct-launch fallback', () => {
    const resumed = buildEngineLaunchArgv('codex', { codexHome: directory, resumeSessionId: 'session-two' }, '/bin/zsh')
    expect(resumed[2]).toContain(`export CODEX_HOME='${directory}'`)
    expect(resumed.slice(-2)).toEqual(['resume', 'session-two'])
    const direct = buildEngineLaunchArgv('codex', { codexHome: directory }, '')
    expect(direct.slice(0, 2)).toEqual(['env', `CODEX_HOME=${directory}`])
    expect(() => buildEngineLaunchArgv('claude', { codexHome: directory })).toThrow('only be used with Codex')
  })

  it('enters the selected workspace after shell startup without losing the account', () => {
    const cwd = join(directory, 'workspace with spaces')
    const codexHome = join(directory, 'work-account')
    mkdirSync(cwd)
    mkdirSync(codexHome)
    const executable = join(directory, 'fake-codex')
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n%s" "$CODEX_HOME" "$PWD"\n')
    chmodSync(executable, 0o700)
    const argv = buildEngineLaunchArgv('codex', { codexHome, cwd }, '/bin/zsh')
    argv[argv.length - 1] = executable
    const result = execFileSync('/bin/sh', ['-c', argv[2], ...argv.slice(3)], {
      cwd: directory,
      env: { ...process.env, CODEX_HOME: '/wrong/inherited/account' },
      encoding: 'utf8',
    })
    expect(result).toBe(`${codexHome}\n${cwd}`)
  })
})
