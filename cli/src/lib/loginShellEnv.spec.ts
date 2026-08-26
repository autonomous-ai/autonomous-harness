import { afterEach, describe, expect, it } from 'vitest'
import {
  loginShellEnvironment,
  oneShotParentEnv,
  resetLoginShellEnvironmentCache,
  warmLoginShellEnvironment,
} from './loginShellEnv.js'

const realShell = process.env.SHELL

afterEach(() => {
  if (realShell === undefined) delete process.env.SHELL
  else process.env.SHELL = realShell
  delete process.env.HARNESS_LOGIN_SHELL_PROBE
  resetLoginShellEnvironmentCache()
})

describe('loginShellEnvironment', () => {
  /**
   * The property the pi fix rests on: the daemon's own environment always wins, so every variable it
   * already has keeps its value and nothing that works today can change. The shell only fills gaps.
   */
  it('never lets the shell override a variable the daemon already has', () => {
    process.env.HARNESS_LOGIN_SHELL_PROBE = 'from-daemon'
    resetLoginShellEnvironmentCache()
    warmLoginShellEnvironment()

    expect(oneShotParentEnv().HARNESS_LOGIN_SHELL_PROBE).toBe('from-daemon')
  })

  it('never spawns a shell on the one-shot path — only an explicit warm-up does', () => {
    resetLoginShellEnvironmentCache()
    // Reading before warming must be free: a ~1s synchronous spawn inside a recap raced a 200ms
    // timeout in devinTrust.spec and would stall a live turn just the same.
    expect(loginShellEnvironment()).toEqual({})
    expect(oneShotParentEnv().PATH).toBe(process.env.PATH)
  })

  it('still carries the daemon environment when no shell can be consulted', () => {
    delete process.env.SHELL
    resetLoginShellEnvironmentCache()

    expect(warmLoginShellEnvironment()).toEqual({})
    expect(oneShotParentEnv().PATH).toBe(process.env.PATH)
  })

  it('refuses a relative or bogus SHELL rather than spawning it', () => {
    process.env.SHELL = 'zsh'                     // not absolute
    resetLoginShellEnvironmentCache()
    expect(warmLoginShellEnvironment()).toEqual({})
  })

  it('caches, so a recap never pays for the probe twice', () => {
    resetLoginShellEnvironmentCache()
    expect(warmLoginShellEnvironment()).toBe(warmLoginShellEnvironment())
  })

  // Reads ~/.zshrc etc., so it only runs where a real shell exists — the environment this fixes.
  it.skipIf(process.platform === 'win32' || !realShell?.startsWith('/'))(
    'captures variables an interactive login shell exports', () => {
      resetLoginShellEnvironmentCache()
      const captured = warmLoginShellEnvironment()

      // A login shell always exports these two; if neither came back, the capture is not working.
      expect(Object.keys(captured).length).toBeGreaterThan(0)
      expect(captured.PATH ?? captured.HOME).toBeDefined()
    },
  )
})
