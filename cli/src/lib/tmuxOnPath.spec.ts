import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TmuxBackend } from './tmuxBackend.js'
import { ensureTmuxOnPath, resolveViaLoginShell } from './tmuxOnPath.js'

const dirs: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A stand-in for the user's shell: it knows about `binDir`, the daemon's own PATH does not. */
function fakeShell(binDir: string): string {
  const dir = scratch('tmux-onpath-shell-')
  const shell = join(dir, 'sh')
  writeFileSync(shell, `#!/bin/sh
# Mimics "zsh -lic <script> $0 $1": drop the flag, run the script with the remaining positionals.
shift
# Hermetic: ONLY this dir, or the real tmux on the test machine leaks in and the
# "cannot find it either" case silently passes for the wrong reason.
PATH="${binDir}" exec /bin/sh -c "$@"
`)
  chmodSync(shell, 0o700)
  return shell
}

function fakeTmux(): string {
  const dir = scratch('tmux-onpath-bin-')
  const tmux = join(dir, 'tmux')
  writeFileSync(tmux, '#!/bin/sh\nexit 0\n')
  chmodSync(tmux, 0o700)
  return dir
}

describe('ensureTmuxOnPath', () => {
  it('adopts the directory the user\'s shell finds tmux in', async () => {
    const binDir = fakeTmux()
    const env: NodeJS.ProcessEnv = { PATH: '/nonexistent-for-this-test' }

    const outcome = await ensureTmuxOnPath(env, fakeShell(binDir))

    expect(outcome.state).toBe('adopted')
    if (outcome.state !== 'adopted') return
    expect(outcome.from).toBe(binDir)
    // The point of the whole exercise: every later execFile('tmux', …) now resolves.
    expect(env.PATH?.split(delimiter)[0]).toBe(binDir)
    expect(env.PATH).toContain('/nonexistent-for-this-test')
  })

  it('leaves an already-working PATH untouched', async () => {
    const binDir = fakeTmux()
    const env: NodeJS.ProcessEnv = { PATH: binDir }

    const outcome = await ensureTmuxOnPath(env, fakeShell(binDir))

    expect(outcome.state).toBe('present')
    // No duplicate entry: this runs on every start, so it has to be idempotent.
    expect(env.PATH).toBe(binDir)
  })

  it('reports absent when neither the daemon nor the shell can find tmux', async () => {
    const emptyBin = scratch('tmux-onpath-empty-')
    const env: NodeJS.ProcessEnv = { PATH: '/nonexistent-for-this-test' }

    const outcome = await ensureTmuxOnPath(env, fakeShell(emptyBin))

    expect(outcome.state).toBe('absent')
    expect(env.PATH).toBe('/nonexistent-for-this-test')
  })

  it('does not consult a shell it cannot trust', async () => {
    // A relative SHELL is not something to hand a command to.
    expect(await resolveViaLoginShell('tmux', 'sh')).toBeNull()
  })
  it('turns the reported failure into a working create', async () => {
    // A tmux that answers like the real one, in a directory the daemon's PATH does not list.
    const binDir = scratch('tmux-onpath-real-')
    const tmux = join(binDir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
case "$1" in
  new-session) printf '%%7\\n' ;;
esac
exit 0
`)
    chmodSync(tmux, 0o700)
    const shell = fakeShell(binDir)

    // Before: exactly what the machine reported after its reboot.
    process.env.PATH = '/nonexistent-for-this-test'
    const before = await new TmuxBackend().create({ cwd: '/tmp', label: 'harness-test' })
    expect(before.state).not.toBe('succeeded')
    if (before.state !== 'succeeded') expect(before.reason).toBe('tmux is unavailable')

    // After: the same call, once the daemon has been told where the user's shell finds tmux.
    expect((await ensureTmuxOnPath(process.env, shell)).state).toBe('adopted')
    const after = await new TmuxBackend().create({ cwd: '/tmp', label: 'harness-test' })

    expect(after).toEqual({
      state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%7' },
    })
  })
})
