import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { readProcessEnv } from './processEnv.js'
import type { ProcessIdentity } from './terminalTypes.js'

/** A state-directory path, never a shell command or a credential. */
export function isCodexHome(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\x00-\x1f\x7f]/.test(value) && isAbsolute(value)
}

/** Resolve on the machine that will launch the agent, without reading auth.json. */
export function resolveCodexHome(value: unknown): string | null {
  if (!isCodexHome(value)) return null
  try {
    const directory = realpathSync(value)
    if (!isCodexHome(directory)) return null
    const info = statSync(directory)
    if (!info.isDirectory()) return null
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK)
    return directory
  } catch {
    return null
  }
}

/** Failed observation is unknown; it must not replace an already-selected home. */
export async function probeCodexHome(identity: ProcessIdentity): Promise<string | undefined> {
  const values = await readProcessEnv(identity)
  if (!values) return undefined
  const directory = values.CODEX_HOME || join(homedir(), '.codex')
  return isCodexHome(directory) ? directory : undefined
}
