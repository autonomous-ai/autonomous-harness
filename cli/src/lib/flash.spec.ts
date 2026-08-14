import { describe, expect, it } from 'vitest'
import { flashCommand, scriptUrl, type FlashDeps } from './flash.js'

/**
 * `harness flash` owns three things — which script, how to get it, and handing the user's flags over
 * untouched. Everything that decides whether a board survives the write lives in the shell script and
 * is deliberately NOT duplicated here, so these assertions stop at the wrapper.
 *
 * Nothing in this file may touch hardware. The one thing that cannot be proven here — that a real
 * board ends up running the firmware — is a manual gate, not a test.
 */

const SCRIPT = '#!/usr/bin/env bash\necho flasher\n'

function harness(over: Partial<FlashDeps> & { cache?: string | null } = {}) {
  const calls: { args: string[][]; written: string[]; logs: string[]; warns: string[] } =
    { args: [], written: [], logs: [], warns: [] }
  let cache = over.cache ?? null
  const deps: Partial<FlashDeps> = {
    fetchScript: over.fetchScript ?? (async () => SCRIPT),
    readCache: over.readCache ?? (() => cache),
    writeCache: over.writeCache ?? ((body) => { cache = body; calls.written.push(body) }),
    run: over.run ?? (async (_p, args) => { calls.args.push(args); return 0 }),
    log: (l) => calls.logs.push(l),
    warn: (l) => calls.warns.push(l),
  }
  return { deps, calls }
}

describe('harness flash — getting the script', () => {
  it('prefers the network copy and caches it', async () => {
    const { deps, calls } = harness()

    expect(await flashCommand([], deps)).toBe(0)
    expect(calls.written).toEqual([SCRIPT])
    // Says which copy it ran. A flasher that silently ran something other than the newest is exactly
    // what the server's `no-store` header exists to prevent.
    expect(calls.logs.join('\n')).toContain(scriptUrl())
    expect(calls.warns).toEqual([])
  })

  /** A bench with no connection is a real situation, so the cache is a fallback — but a LOUD one. */
  it('falls back to the cache when the network fails, and warns', async () => {
    const { deps, calls } = harness({
      fetchScript: async () => { throw new Error('getaddrinfo ENOTFOUND') },
      cache: SCRIPT,
    })

    expect(await flashCommand([], deps)).toBe(0)
    const warned = calls.warns.join('\n')
    expect(warned).toContain('CACHED')
    expect(warned).toContain('may be out of date')
    expect(calls.args).toHaveLength(1) // it still ran
  })

  it('refuses, with the manual commands, when there is no network and no cache', async () => {
    const { deps } = harness({
      fetchScript: async () => { throw new Error('offline') },
      cache: null,
    })

    await expect(flashCommand([], deps)).rejects.toThrow(/no cached copy/)
    await expect(flashCommand([], deps)).rejects.toThrow(/curl -fsSL/)
  })

  /**
   * A captive portal or an error page answers 200 with HTML. Writing that to the cache would poison
   * the fallback for every later run, so the shebang check happens before anything is stored — this
   * asserts the caller sees a failure rather than a "successful" flash of nothing.
   */
  it('treats a non-script response as a failure', async () => {
    const { deps, calls } = harness({
      fetchScript: async () => { throw new Error('response is not a shell script (proxy or error page?)') },
      cache: null,
    })

    await expect(flashCommand([], deps)).rejects.toThrow(/not a shell script/)
    expect(calls.written).toEqual([])
  })
})

describe('harness flash — handing over the flags', () => {
  /**
   * The wrapper does not parse the flasher's flags, so a flag it has never heard of has to reach the
   * script unchanged. This is what keeps the two from drifting when the script gains an option.
   */
  it('passes every argument through verbatim, including unknown ones', async () => {
    const { deps, calls } = harness()
    const args = ['--detect-only', '--port', '/dev/cu.usbmodem21301', '--totally-new-flag', 'x y']

    await flashCommand(args, deps)

    expect(calls.args[0]).toEqual(args)
  })

  /** `harness flash --detect-only` has to be usable in a shell condition, so the code is not swallowed. */
  it("returns the script's own exit code", async () => {
    const { deps } = harness({ run: async () => 3 })

    expect(await flashCommand(['--detect-only'], deps)).toBe(3)
  })

  it('explains itself when bash is missing rather than failing bare', async () => {
    const { deps } = harness({
      run: async () => { throw Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' }) },
    })

    await expect(flashCommand([], deps)).rejects.toThrow(/bash was not found/)
  })
})

describe('harness flash — where it points', () => {
  it('builds the URL from WEB_URL, so a local web app is used in dev', () => {
    // WEB_URL already falls back to loopback when BACKEND_WS_URL is local (config/env.ts), which is
    // why this command needs no environment variable of its own.
    expect(scriptUrl()).toMatch(/^https?:\/\/.+\/flash-circle\.sh$/)
  })
})
