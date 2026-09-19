/**
 * Is `command` runnable — an executable at that path, or a name resolvable on PATH?
 *
 * Resolved by reading PATH rather than by spawning: callers use it on the startup path and in error
 * reporting, where launching a process to ask would be both slower and noisier.
 *
 * The same shape already lives in `herdrBinaryAvailable` (lib/herdrSessions.ts), which keeps its own
 * copy because it is exported API with its own tests.
 */
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export function binaryOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveBinaryOnPath(command, env) !== null
}

/** The same lookup, answering WHERE — the first executable PATH entry that has it, or null. */
export function resolveBinaryOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!command) return null
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const candidates = command.includes('/') || command.includes('\\')
    ? [command]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command))
  for (const candidate of candidates) {
    for (const extension of extensions) {
      try { accessSync(candidate + extension, constants.X_OK); return candidate + extension } catch { /* next */ }
    }
  }
  return null
}
