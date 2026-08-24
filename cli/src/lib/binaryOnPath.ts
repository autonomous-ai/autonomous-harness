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
  if (!command) return false
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const candidates = command.includes('/') || command.includes('\\')
    ? [command]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command))
  return candidates.some((candidate) => extensions.some((extension) => {
    try { accessSync(candidate + extension, constants.X_OK); return true } catch { return false }
  }))
}
