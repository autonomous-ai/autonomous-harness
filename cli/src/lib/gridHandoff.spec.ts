/**
 * Which `grid` the sign-in hand-off runs.
 *
 * The hand-off carries the account token, so it has to run the SAME binary every other grid call
 * resolves to (`gridExec.ts`): the developer override, then the managed runtime, then PATH. A
 * hand-off that asked PATH on its own would sign in with one `grid` while models ran on another —
 * two versions writing one `~/.grid`. The token seam itself (stdin, never argv) is covered end to end
 * in `gridCommand.spec.ts`; this file is only about WHICH child gets it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root = ''
let runtimeDir = ''
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, HARNESS_GRID_BIN: process.env.HARNESS_GRID_BIN, ADAPTER_RUNTIME_DIR: process.env.ADAPTER_RUNTIME_DIR }

/** `gridExec.ts` reads `env.ADAPTER_RUNTIME_DIR` at import time, so the module is loaded fresh per case. */
async function load() {
  vi.resetModules()
  process.env.ADAPTER_RUNTIME_DIR = runtimeDir
  return import('./gridHandoff.js')
}

/** A `grid` that records its argv and (on `login`) its standard input, under `label`. A shell script
 *  rather than a Node one, with `/bin/cat` by absolute path: several cases below run with an EMPTY
 *  PATH, where `#!/usr/bin/env node` — or a bare `cat` — would fail for a reason that has nothing to
 *  do with the resolution under test. */
function fakeGrid(dir: string, label: string): string {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'grid')
  writeFileSync(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${join(root, `${label}.args`)}"`,
    `printf '%s' "\${GRID_NO_UPDATE_CHECK-unset}" > "${join(root, `${label}.update-check`)}"`,
    `[ "$1" = login ] && /bin/cat > "${join(root, `${label}.stdin`)}"`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  return bin
}

function ran(label: string): boolean { return existsSync(join(root, `${label}.args`)) }
function argsOf(label: string): string[] { return readFileSync(join(root, `${label}.args`), 'utf8').trim().split('\n') }
function updateCheckSeenBy(label: string): string { return readFileSync(join(root, `${label}.update-check`), 'utf8') }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'grid-handoff-'))
  runtimeDir = join(root, 'runtime')
  mkdirSync(runtimeDir)
  // Nothing on PATH unless a case puts something there — never this machine's own `grid`.
  mkdirSync(join(root, 'empty-bin'))
  process.env.PATH = join(root, 'empty-bin')
  // The resolver's last fallback is `$HOME/.local/bin/grid` (grid's own installer's path), so a
  // developer machine that has one must not leak into "nothing to run".
  process.env.HOME = root
  delete process.env.HARNESS_GRID_BIN
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe('handOffToGrid — which grid it runs', () => {
  it('runs the grid HARNESS_GRID_BIN names, with nothing on PATH', async () => {
    const override = fakeGrid(join(root, 'elsewhere'), 'override')
    process.env.HARNESS_GRID_BIN = override
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_1', { json: true })

    expect(result.code).toBe('OK')
    expect(argsOf('override')).toEqual(['login', '--harness', '--json'])
    expect(readFileSync(join(root, 'override.stdin'), 'utf8')).toBe('tok_1\n')
    // grid's own "a newer version is out — run `grid update`" must never reach a binary the
    // harness pins: `update` would overwrite it in place. Off for every child this daemon spawns.
    expect(updateCheckSeenBy('override')).toBe('1')
  })

  it('prefers the managed runtime over a grid on PATH', async () => {
    fakeGrid(join(root, 'path-bin'), 'path')
    process.env.PATH = join(root, 'path-bin')
    const managed = fakeGrid(join(runtimeDir, 'grid-0.3.47-darwin-arm64'), 'managed')
    writeFileSync(join(runtimeDir, 'current-grid'), `${managed}\n`)
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_2', { json: true })

    expect(result.code).toBe('OK')
    expect(argsOf('managed')).toEqual(['login', '--harness', '--json'])
    expect(ran('path')).toBe(false)
  })

  it('reports GRID_CLI_MISSING when neither the managed runtime nor PATH has one', async () => {
    const { handOffToGrid } = await load()

    const result = await handOffToGrid('tok_3', { json: true })

    expect(result).toMatchObject({ code: 'GRID_CLI_MISSING', exitCode: 1 })
    expect(result.message).toContain('grid')
  })
})

/**
 * The watchdog. `grid login --harness` makes two control-plane round trips, and a connection that is
 * accepted and then answered by nobody used to leave this promise pending for good — a `harness
 * login` that never returned, and a daemon reconcile that never settled.
 */
describe('handOffToGrid — a child that never answers', () => {
  /** A `grid` that reads the token and then hangs, the shape of a black-holed control plane.
   *
   *  It IGNORES SIGTERM on purpose: that is the case the watchdog's `SIGKILL` exists for, and a fake
   *  that died politely would let a child which cannot be asked to stop pass as one that can. (The
   *  signal itself is not observable through this module's result — the kill and the settle happen
   *  together — so what this pins is that a TERM-immune child still ends the call.) */
  function hangingGrid(dir: string): string {
    mkdirSync(dir, { recursive: true })
    const bin = join(dir, 'grid')
    writeFileSync(bin, ['#!/bin/sh', "trap '' TERM", '/bin/cat > /dev/null', 'sleep 60', ''].join('\n'), { mode: 0o755 })
    return bin
  }

  it('kills it and reports a timeout rather than awaiting forever', async () => {
    process.env.HARNESS_GRID_BIN = hangingGrid(join(root, 'hangs'))
    const { handOffToGrid } = await load()

    const started = Date.now()
    const result = await handOffToGrid('tok_hang', { json: true, timeoutMs: 300 })

    // It returned at all — the property the whole watchdog exists for.
    expect(Date.now() - started).toBeLessThan(10_000)
    // Classified as the ordinary failure rather than a new code, so every caller's existing
    // handling applies unchanged (the same choice `gridExec` makes for its own timeout).
    expect(result).toMatchObject({ code: 'GRID_LOGIN_FAILED', exitCode: 1 })
    expect(result.message).toContain('did not answer')
  }, 20_000)

  it('does not arm the timeout against a child that answers promptly', async () => {
    fakeGrid(join(root, 'prompt-bin'), 'prompt')
    process.env.HARNESS_GRID_BIN = join(root, 'prompt-bin', 'grid')
    const { handOffToGrid } = await load()

    // A timeout far shorter than the case would take if the timer were not cleared on success.
    const result = await handOffToGrid('tok_fast', { json: true, timeoutMs: 5_000 })

    expect(result.code).toBe('OK')
    expect(argsOf('prompt')).toEqual(['login', '--harness', '--json'])
  })
})
