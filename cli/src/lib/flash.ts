/**
 * `harness flash` — re-flash a plugged-in CIRCLE device over USB.
 *
 * This is a WRAPPER, deliberately. The flasher itself is a 415-line shell script published at
 * `<WEB_URL>/flash-circle.sh`, and it stays the single source of truth for everything that decides
 * whether a board survives the write: the chip it will talk to, the app offset, the otadata and NVS
 * regions, the flash mode/size/frequency, and the sha256 checks on both esptool and the firmware.
 * Re-implementing that here would put those numbers in two places, and the failure mode of a
 * disagreement is a bricked board that needs a USB cable and a person to recover.
 *
 * So this file owns three things and nothing else: WHICH script to run, HOW to get it, and getting the
 * user's flags to it untouched.
 *
 * Flags are passed through verbatim rather than parsed. `--detect-only`, `--port`, `--yes`,
 * `--version`, `--erase-nvs`, `--no-verify` and `--no-flash` therefore work without this file knowing
 * they exist — and a flag added to the script later works the day it ships, instead of the day someone
 * remembers to widen a list here.
 */

import { spawn } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { env } from '../config/env.js'

/**
 * The script caches its own downloads (esptool, firmware) under `~/.harness/flasher` via
 * `HARNESS_FLASHER_CACHE`. Keeping our copy of the script in the same directory is deliberate: one
 * place holds everything the flasher owns, so "delete this folder" is a complete reset.
 */
const CACHE_DIR = process.env.HARNESS_FLASHER_CACHE || join(homedir(), '.harness', 'flasher')
const CACHED_SCRIPT = join(CACHE_DIR, 'flash-circle.sh')
const FETCH_TIMEOUT_MS = 20_000

export interface FlashDeps {
  /** Overridden in tests; the real one is `fetch`. */
  fetchScript: (url: string) => Promise<string>
  readCache: () => string | null
  writeCache: (body: string) => void
  run: (scriptPath: string, args: string[]) => Promise<number>
  log: (line: string) => void
  warn: (line: string) => void
}

export function scriptUrl(): string {
  return `${env.WEB_URL.replace(/\/+$/, '')}/flash-circle.sh`
}

async function realFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // The server already answers `no-store` for a reason it states out loud: an operator must never be
    // handed a stale flasher after a fix has shipped. Say the same thing from this side so a proxy in
    // between cannot decide otherwise.
    headers: { 'cache-control': 'no-cache' },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const body = await res.text()
  // A captive portal or an error page returns 200 with HTML. Running that under bash does nothing
  // useful and reports it confusingly, so check it is a script before it is ever written to disk.
  if (!body.startsWith('#!')) throw new Error('response is not a shell script (proxy or error page?)')
  return body
}

function realRun(scriptPath: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    // `inherit`, not a pipe. The script prints progress as it goes and asks for confirmation on
    // /dev/tty; capturing its output would hide the first and break the second.
    const child = spawn('bash', [scriptPath, ...args], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

const defaults: FlashDeps = {
  fetchScript: realFetch,
  readCache: () => {
    try { return readFileSync(CACHED_SCRIPT, 'utf-8') } catch { return null }
  },
  writeCache: (body) => {
    mkdirSync(dirname(CACHED_SCRIPT), { recursive: true })
    writeFileSync(CACHED_SCRIPT, body, { mode: 0o755 })
  },
  run: realRun,
  log: (line) => console.log(line),
  warn: (line) => console.error(line),
}

/**
 * Fetch-then-fall-back, and always say which one happened.
 *
 * The network copy wins whenever it can be had, because a flasher fix has to reach the person holding
 * the board. The cache exists only so a flash is still possible on a machine that is offline — which
 * is a real situation at a bench — and using it is reported, never silent.
 */
async function resolveScript(deps: FlashDeps): Promise<{ body: string; source: 'fetched' | 'cached' }> {
  const url = scriptUrl()
  try {
    const body = await deps.fetchScript(url)
    deps.writeCache(body)
    return { body, source: 'fetched' }
  } catch (err) {
    const cached = deps.readCache()
    const why = err instanceof Error ? err.message : String(err)
    if (cached === null) {
      throw new Error(
        `could not download the flasher from ${url} (${why}), and no cached copy exists.\n`
        + 'With a working connection you can always run it by hand:\n'
        + `  curl -fsSL ${url} -o flash-circle.sh\n`
        + '  bash flash-circle.sh',
      )
    }
    deps.warn(`!  could not reach ${url} (${why})`)
    deps.warn(`!  running the CACHED flasher from ${CACHED_SCRIPT} — it may be out of date`)
    return { body: cached, source: 'cached' }
  }
}

/**
 * Run the published circle flasher with `args` passed straight through.
 *
 * Returns the script's own exit code so `harness flash --detect-only` is usable in a shell condition:
 * the script exits non-zero when it finds no board, and that has to survive the wrapper.
 */
export async function flashCommand(args: string[], overrides: Partial<FlashDeps> = {}): Promise<number> {
  const deps: FlashDeps = { ...defaults, ...overrides }
  const { source } = await resolveScript(deps)
  deps.log(`>> circle flasher (${source === 'fetched' ? scriptUrl() : `cached: ${CACHED_SCRIPT}`})`)
  try {
    return await deps.run(CACHED_SCRIPT, args)
  } catch (err) {
    // The only way `spawn` itself fails here in practice. Every macOS and Linux ships bash; a machine
    // without it cannot run the flasher at all, so say what to do instead of just failing.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(
        'bash was not found on PATH, and the flasher is a bash script.\n'
        + `Install bash, or run it yourself on a machine that has one:\n`
        + `  curl -fsSL ${scriptUrl()} -o flash-circle.sh\n`
        + '  bash flash-circle.sh',
      )
    }
    throw err
  }
}
