import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TmuxBackend } from './tmuxBackend.js'

const originalPath = process.env.PATH
const dirs: string[] = []

afterEach(() => {
  process.env.PATH = originalPath
  delete process.env.TMUX_BACKEND_CALLS
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('TmuxBackend lifecycle', () => {
  it('creates a detached session and kills the session resolved from its root pane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-lifecycle-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
case "$1" in
  new-session) printf '%%42\\n' ;;
  display-message) printf '$7\\n' ;;
esac
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls
    const backend = new TmuxBackend()

    const created = await backend.create({ cwd: '/tmp/work', label: 'harness-test' })
    expect(created).toEqual({
      state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%42' },
    })
    if (created.state !== 'succeeded') return
    await expect(backend.kill(created.runtime)).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      // `remain-on-exit` is chained into the SAME invocation, not sent after it: an engine that
      // exits immediately would otherwise take its session down before a follow-up call landed,
      // and its error text with it.
      'new-session -d -P -F #{pane_id} -c /tmp/work -s harness-test ; set-option -w remain-on-exit on',
      'set-option -t %42 mouse on',
      'display-message -p -t %42 #{session_id}',
      'kill-session -t $7',
    ])
  })

  it('carries tmux\'s own refusal into the failure reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-refusal-'))
    dirs.push(dir)
    const tmux = join(dir, 'tmux')
    // What a real tmux does when the session name is taken: exit 1, reason on stderr, nothing on
    // stdout. Swallowing that turned every distinct cause into one bare SPAWN_FAILED.
    writeFileSync(tmux, `#!/bin/sh
printf 'duplicate session: harness-test\\n' >&2
exit 1
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`

    const created = await new TmuxBackend().create({ cwd: '/tmp/work', label: 'harness-test' })

    expect(created.state).not.toBe('succeeded')
    if (created.state === 'succeeded') return
    expect(created.reason).toContain('duplicate session: harness-test')
  })

  it('still reports a missing tmux as unavailable rather than a refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-absent-'))
    dirs.push(dir)
    // An empty directory as the ENTIRE path: nothing named tmux is resolvable, so execFile ENOENTs.
    process.env.PATH = dir

    const created = await new TmuxBackend().create({ cwd: '/tmp/work', label: 'harness-test' })

    expect(created.state).not.toBe('succeeded')
    if (created.state === 'succeeded') return
    expect(created.reason).toBe('tmux is unavailable')
  })

  it('re-arms remain-on-exit on an already-live pane for holdOpen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-holdopen-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls

    await expect(new TmuxBackend().holdOpen({ backend: 'tmux', paneId: '%9' }))
      .resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(readFileSync(calls, 'utf8').trim()).toBe('set-option -w -t %9 remain-on-exit on')
  })

  it('respawns a pane in place with -k, an optional cwd, and the exact argv, no shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-respawn-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls

    const backend = new TmuxBackend()
    await expect(backend.respawn({ backend: 'tmux', paneId: '%9' }, ['claude', '--resume', 'abc; rm -rf /'], '/tmp/work'))
      .resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    await expect(backend.respawn({ backend: 'tmux', paneId: '%9' }, ['claude'], null))
      .resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      // The `;` inside an argv element is never shell-interpreted — it lands as one literal token.
      'respawn-pane -k -t %9 -c /tmp/work claude --resume abc; rm -rf /',
      'respawn-pane -k -t %9 claude',
    ])
  })

  it('displays a bounded message in the addressed pane without a shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmux-backend-notify-'))
    dirs.push(dir)
    const calls = join(dir, 'calls')
    const tmux = join(dir, 'tmux')
    writeFileSync(tmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_BACKEND_CALLS"
`)
    chmodSync(tmux, 0o700)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`
    process.env.TMUX_BACKEND_CALLS = calls

    await expect(new TmuxBackend().notify(
      { backend: 'tmux', paneId: '%7' },
      'Build status',
      'Ready; touch /tmp/must-not-run',
    )).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(readFileSync(calls, 'utf8').trim()).toBe(
      'display-message -t %7 -- Build status: Ready; touch /tmp/must-not-run',
    )
  })
})
