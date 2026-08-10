import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dataDir = ''
let execErr: Error | null = null
let execOut = ''
let execResponder: ((cmd: string, args: string[]) => { err?: Error; stdout?: string }) | null = null

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    const response = execResponder?.(cmd, args)
    cb(response?.err ?? execErr, response?.stdout ?? execOut)
  }),
}))

async function loadModules() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  process.env.CLAUDE_PROJECTS_DIR = dataDir
  return {
    ...(await import('./registry.js')),
    ...(await import('./tmux.js')),
    launcherSessions: (await import('./launcherSessions.js')).launcherSessions,
  }
}

describe('tmux reaper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-tmux-'))
    execErr = null
    execOut = ''
    execResponder = null
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dataDir, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
    delete process.env.CLAUDE_PROJECTS_DIR
  })

  it('keeps registry entries when tmux pane listing fails', async () => {
    const transcriptPath = join(dataDir, 'session-1.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    const { registry, startTmuxReaper } = await loadModules()
    registry.load()
    registry.register({ launcherId: 'h1', sessionId: 'session-1', transcriptPath, tmuxPane: '%1', cwd: '/tmp/demo' })

    execErr = new Error('tmux unavailable')
    const removed: string[] = []
    const timer = startTmuxReaper(1000, (id) => { removed.push(id); registry.remove(id) })
    await vi.advanceTimersByTimeAsync(3000)
    clearInterval(timer)

    expect(removed).toEqual([])
    expect(registry.has('session-1')).toBe(true)
  })

  it('reads cleaned tmux pane titles by pane id', async () => {
    const { listPaneTitles } = await loadModules()
    execOut = '%0\t✳ Clarify assistant identity\n%2\t autonomous-code \nnot-pane\tIgnored\n'

    const titles = await listPaneTitles()

    expect(Object.fromEntries(titles)).toEqual({
      '%0': 'Clarify assistant identity',
      '%2': 'autonomous-code',
    })
  })

  it('removes a session after the pane is missing from valid tmux output twice', async () => {
    const transcriptPath = join(dataDir, 'session-2.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    const { registry, startTmuxReaper } = await loadModules()
    registry.load()
    registry.register({ launcherId: 'h1', sessionId: 'session-2', transcriptPath, tmuxPane: '%2', cwd: '/tmp/demo' })

    execOut = '%9\n'
    const removed: string[] = []
    const timer = startTmuxReaper(1000, (id) => { removed.push(id); registry.remove(id) })
    await vi.advanceTimersByTimeAsync(2500)
    clearInterval(timer)

    expect(removed).toEqual(['session-2'])
    expect(registry.has('session-2')).toBe(false)
  })

  it('never evicts a session whose launcher is still connected', async () => {
    // An agent exists exactly as long as its launcher's socket is open (launcherSessions.ts). That socket
    // is a fact the daemon holds; `tmux` and `ps` are subprocesses that time out — and one already cost a
    // live Command Code pane, which renames its own argv mid-life. The strong signal must win.
    const transcriptPath = join(dataDir, 'session-3.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    const { registry, startTmuxReaper, launcherSessions } = await loadModules()
    registry.load()
    registry.register({ launcherId: '11111111-2222-4333-8444-555555555555', sessionId: 'session-3', transcriptPath, tmuxPane: '%3', cwd: '/tmp/demo' })
    launcherSessions.open(
      { launcherId: '11111111-2222-4333-8444-555555555555', engine: 'claude', tmuxPane: '%3', cwd: '/tmp/demo' },
      { close: () => {}, send: () => {} },
    )

    execOut = '%9\n' // tmux says the pane is gone — the weaker claim
    const removed: string[] = []
    const timer = startTmuxReaper(1000, (id) => { removed.push(id); registry.remove(id) })
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(timer)

    expect(removed).toEqual([])
    expect(registry.has('session-3')).toBe(true)
    launcherSessions.close('11111111-2222-4333-8444-555555555555')
  })

  it('prefers the stable Codex CLI over a matching app-server helper', async () => {
    const { engineProcessMatchScore } = await loadModules()

    const cliScore = engineProcessMatchScore(
      { executable: '/usr/local/bin/codex', args: 'codex --yolo --profile minimax' },
      'codex',
    )
    const helperScore = engineProcessMatchScore(
      {
        executable: '/Applications/Co',
        args: '/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://',
      },
      'codex',
    )

    expect(cliScore).toBeGreaterThan(helperScore)
    expect(helperScore).toBeGreaterThan(0)
  })

  it('matches Command Code by its ⌘ title after the TUI overwrites its own argv', async () => {
    const { engineProcessMatchScore } = await loadModules()

    // Real `ps` output: the entrypoint is gone within a second of launch, first replaced by the boot
    // title and then by the session title. Missing these makes a live pane fail validateSessionRuntime.
    const bootTitle = engineProcessMatchScore({ executable: '⌘', args: '⌘ Command Code · cc-fresh' }, 'commandcode')
    const sessionTitle = engineProcessMatchScore({ executable: '⌘', args: '⌘ E2E OK' }, 'commandcode')
    const entrypoint = engineProcessMatchScore(
      { executable: '/usr/local/bin/node', args: 'node /usr/local/lib/node_modules/command-code/dist/index.mjs' },
      'commandcode',
    )

    expect(bootTitle).toBe(3)
    expect(sessionTitle).toBe(3)
    expect(entrypoint).toBe(3)
    expect(engineProcessMatchScore({ executable: 'claude', args: 'claude' }, 'commandcode')).toBe(0)
  })

  it('parses a ps row whose comm contains spaces', async () => {
    const { parseProcessRow } = await loadModules()

    // Command Code's rewritten argv, exactly as `ps -axo pid=,ppid=,comm=,lstart=,args=` prints it.
    expect(parseProcessRow('47692 70597 ⌘ Greeting     Thu Jul 30 11:00:03 2026     ⌘ Greeting')).toEqual({
      pid: 47692,
      parentPid: 70597,
      executable: '⌘ Greeting',
      startMarker: 'Thu Jul 30 11:00:03 2026',
      args: '⌘ Greeting',
    })
    // A single-token comm is unchanged — every other engine goes down this path.
    expect(parseProcessRow('900 1 /usr/bin/node Thu Jul 30 09:15:00 2026 node cli.js --resume x')).toEqual({
      pid: 900,
      parentPid: 1,
      executable: '/usr/bin/node',
      startMarker: 'Thu Jul 30 09:15:00 2026',
      args: 'node cli.js --resume x',
    })
    expect(parseProcessRow('not a process row')).toBeNull()
  })

  it('keeps a live Command Code pane when the TUI renames the session', async () => {
    const { registry, startTmuxReaper } = await loadModules()
    registry.load()
    registry.register({ launcherId: 'h1', engine: 'commandcode', sessionId: 'cc-1', tmuxPane: '%3', cwd: '/tmp/demo' })

    // Same process throughout — only the argv title changes, which is what Command Code does once it
    // has named the session. Before the lstart-anchored parse this shifted `startMarker` and the reaper
    // declared the pane "gone" ~10s later, while it was still serving turns.
    let title = '⌘ Command Code · opencode-agent1'
    execResponder = (cmd, args) => {
      if (cmd === 'ps') return { stdout: `4242 1 ${title}     Thu Jul 30 11:00:03 2026     ${title}\n` }
      if (args[0] === 'display-message') return { stdout: '4242\n' }
      return { stdout: '%3\n' } // list-panes
    }

    const removed: string[] = []
    const timer = startTmuxReaper(1000, (id) => { removed.push(id); registry.remove(id) })
    await vi.advanceTimersByTimeAsync(1500) // identity captured under the boot title
    title = '⌘ Greeting'
    await vi.advanceTimersByTimeAsync(4000) // four more ticks — twice the reaper's miss limit
    clearInterval(timer)

    expect(removed).toEqual([])
    expect(registry.has('cc-1')).toBe(true)
    expect(registry.get('cc-1')?.processIdentity?.startMarker).toBe('Thu Jul 30 11:00:03 2026')
  })

  it('keeps a session when the process probe itself fails, and evicts once it answers', async () => {
    const { registry, startTmuxReaper } = await loadModules()
    registry.load()
    registry.register({ launcherId: 'h1', engine: 'commandcode', sessionId: 'cc-3', tmuxPane: '%3', cwd: '/tmp/demo' })

    // `ps` / `tmux display-message` are subprocesses with 2-3s timeouts. A timeout says nothing about
    // whether the pane's CLI is alive, so it must not spend a reaper miss — this is what dropped a live
    // Command Code pane with "no commandcode process under pane %3".
    let psFails = true
    execResponder = (cmd, args) => {
      if (cmd === 'ps') {
        return psFails
          ? { err: new Error('spawn ps ETIMEDOUT') }
          : { stdout: '4242 1 ⌘ Greeting     Thu Jul 30 11:00:03 2026     ⌘ Greeting\n' }
      }
      if (args[0] === 'display-message') return { stdout: '4242\n' }
      return { stdout: '%3\n' }
    }

    const removed: string[] = []
    const timer = startTmuxReaper(1000, (id) => { removed.push(id); registry.remove(id) })
    await vi.advanceTimersByTimeAsync(6000) // six failed probes — twice would have been fatal before
    expect(removed).toEqual([])
    expect(registry.has('cc-3')).toBe(true)

    // …and the tolerance is only for the unknown: once ps answers and the pane really is empty, it goes.
    psFails = false
    await vi.advanceTimersByTimeAsync(1500)
    expect(registry.get('cc-3')?.processIdentity?.pid).toBe(4242) // adopted the process it can now see

    execResponder = (cmd, args) => {
      if (cmd === 'ps') return { stdout: '999 1 zsh Thu Jul 30 11:00:03 2026 -zsh\n' }
      if (args[0] === 'display-message') return { stdout: '4242\n' }
      return { stdout: '%3\n' }
    }
    await vi.advanceTimersByTimeAsync(3000)
    clearInterval(timer)

    expect(removed).toEqual(['cc-3'])
  })

  it('adopts a legacy identity written by the pre-fix parser instead of evicting', async () => {
    const { registry, startTmuxReaper } = await loadModules()
    registry.load()
    registry.register({ launcherId: 'h1', engine: 'commandcode', sessionId: 'cc-2', tmuxPane: '%3', cwd: '/tmp/demo' })
    // What the old parser persisted: comm truncated to `⌘`, the title swallowed into the start time.
    registry.updateProcessIdentity('cc-2', {
      pid: 4242,
      executable: '⌘',
      startMarker: 'Greeting     Thu Jul 30 11:00:03',
    })

    execResponder = (cmd, args) => {
      if (cmd === 'ps') return { stdout: '4242 1 ⌘ Greeting     Thu Jul 30 11:00:03 2026     ⌘ Greeting\n' }
      if (args[0] === 'display-message') return { stdout: '4242\n' }
      return { stdout: '%3\n' }
    }

    const removed: string[] = []
    const timer = startTmuxReaper(1000, (id) => { removed.push(id); registry.remove(id) })
    await vi.advanceTimersByTimeAsync(3000)
    clearInterval(timer)

    expect(removed).toEqual([])
    expect(registry.get('cc-2')?.processIdentity).toEqual({
      pid: 4242,
      executable: '⌘ Greeting',
      startMarker: 'Thu Jul 30 11:00:03 2026',
    })
  })

  it('matches Devin by its bare argv and by the versioned entrypoint', async () => {
    const { engineProcessMatchScore } = await loadModules()

    // `ps -o command=` on a live pane prints exactly `devin` — the symlink name, no path, no args.
    expect(engineProcessMatchScore({ executable: 'devin', args: 'devin' }, 'devin')).toBe(3)
    expect(engineProcessMatchScore(
      { executable: '/Users/x/.local/share/devin/cli/_versions/3000.2.17/bin/devin', args: 'devin -r' },
      'devin',
    )).toBe(3)
    expect(engineProcessMatchScore({ executable: 'claude', args: 'claude' }, 'devin')).toBe(0)
  })

  it('scores muse through the launcher that execs into a versioned binary', async () => {
    const { engineProcessMatchScore } = await loadModules()
    // `~/.local/bin/muse` is a bash launcher that `exec`s `muse-bin-<version>`, so the pane process is
    // usually the versioned name — measured on 0.1.0-R708.1. Without this branch muse falls through to
    // the claude matcher, fails runtime validation, and the reaper evicts every live muse session.
    expect(engineProcessMatchScore({ executable: 'muse', args: 'muse' }, 'muse')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'muse-bin-0.1.0-R708.1', args: 'muse-bin-0.1.0-R708.1' }, 'muse')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'claude', args: 'claude' }, 'muse')).toBe(0)
  })

  it('matches the Grok binary and its installed path', async () => {
    const { engineProcessMatchScore } = await loadModules()
    expect(engineProcessMatchScore({ executable: 'grok', args: 'grok --always-approve' }, 'grok')).toBe(3)
    expect(engineProcessMatchScore({ executable: '/Users/demo/.grok/bin/grok', args: 'grok' }, 'grok')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'claude', args: 'claude' }, 'grok')).toBe(0)
  })

  it('extracts resume session ids per engine, and only when the value looks like an id', async () => {
    const { resumeSessionId } = await loadModules()

    // Both cursor spellings.
    expect(resumeSessionId('cursor', 'agent --resume=53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('cursor', 'agent --resume 53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('cursor', 'agent --model sonnet')).toBeNull()

    // Real argv captured on 2026-08-03 from panes the daemon had failed to list.
    expect(resumeSessionId('opencode', 'opencode -s ses_05e335115ffeM05DT5hJHeN3Vp'))
      .toBe('ses_05e335115ffeM05DT5hJHeN3Vp')
    expect(resumeSessionId('hermes', 'python3.11 hermes --resume 20260728_115628_f2c86a'))
      .toBe('20260728_115628_f2c86a')

    // `-r` on Command Code takes an id OR a human title — a title is not a session id.
    expect(resumeSessionId('commandcode', 'cmd -r 1348716c-421f-417f-99ef-cd6096ed248a'))
      .toBe('1348716c-421f-417f-99ef-cd6096ed248a')
    expect(resumeSessionId('commandcode', 'cmd -r Greeting')).toBeNull()
    expect(resumeSessionId('grok', 'grok --resume 98ee3dac-175e-46cb-9cee-cf41cafe70d2'))
      .toBe('98ee3dac-175e-46cb-9cee-cf41cafe70d2')
    expect(resumeSessionId('grok', 'grok -r 98ee3dac-175e-46cb-9cee-cf41cafe70d2'))
      .toBe('98ee3dac-175e-46cb-9cee-cf41cafe70d2')

    // `--continue` carries no id on any engine: nothing to adopt, and nothing to invent.
    expect(resumeSessionId('opencode', 'opencode --continue')).toBeNull()
    expect(resumeSessionId('hermes', 'hermes --continue')).toBeNull()
    // Claude and codex are handled by their own SessionStart hooks, so argv is not read for them.
    expect(resumeSessionId('claude', 'claude --resume 53d3843c-724e-47ff-ae3a-9fedfa328bba')).toBeNull()
  })

  it('discovers an idle Cursor resume from its tmux process tree', async () => {
    const { discoverTmuxResumes } = await loadModules()
    execResponder = (cmd, args) => {
      if (cmd === 'tmux' && args[0] === 'list-panes') {
        return { stdout: '%23\t63442\t/tmp/cursor-project\n' }
      }
      if (cmd === 'ps') {
        return {
          stdout: [
            '63442 1 zsh Thu Jul 23 14:18:50 2026 -zsh',
            '64095 63442 /Users/demo/.local/bin/agent Thu Jul 23 14:18:57 2026 /Users/demo/.local/share/cursor-agent/versions/2026.07.20/index.js --resume=53d3843c-724e-47ff-ae3a-9fedfa328bba',
          ].join('\n'),
        }
      }
      return { err: new Error(`unexpected command: ${cmd}`) }
    }

    await expect(discoverTmuxResumes()).resolves.toEqual([{
      engine: 'cursor',
      sessionId: '53d3843c-724e-47ff-ae3a-9fedfa328bba',
      tmuxPane: '%23',
      cwd: '/tmp/cursor-project',
      processIdentity: {
        pid: 64095,
        executable: '/Users/demo/.local/bin/agent',
        startMarker: 'Thu Jul 23 14:18:57 2026',
      },
    }])
  })

  it('discovers a resumed session for a non-cursor engine too', async () => {
    const { discoverTmuxResumes } = await loadModules()
    execResponder = (cmd, args) => {
      if (cmd === 'tmux' && args[0] === 'list-panes') {
        return { stdout: '%3\t70597\t/tmp/oc\n' }
      }
      if (cmd === 'ps') {
        return {
          stdout: [
            '70597 1 zsh Fri Jul 31 16:57:00 2026 -zsh',
            '45656 70597 opencode Fri Jul 31 16:57:01 2026 opencode -s ses_05e335115ffeM05DT5hJHeN3Vp',
          ].join('\n'),
        }
      }
      return { err: new Error(`unexpected command: ${cmd}`) }
    }

    await expect(discoverTmuxResumes()).resolves.toEqual([{
      engine: 'opencode',
      sessionId: 'ses_05e335115ffeM05DT5hJHeN3Vp',
      tmuxPane: '%3',
      cwd: '/tmp/oc',
      processIdentity: {
        pid: 45656,
        executable: 'opencode',
        startMarker: 'Fri Jul 31 16:57:01 2026',
      },
    }])
  })

  it('ignores a session resumed in more than one tmux pane', async () => {
    const { discoverTmuxResumes } = await loadModules()
    execResponder = (cmd, args) => {
      if (cmd === 'tmux' && args[0] === 'list-panes') {
        return { stdout: '%23\t63442\t/tmp/one\n%24\t63443\t/tmp/two\n' }
      }
      if (cmd === 'ps') {
        return {
          stdout: [
            '64095 63442 agent Thu Jul 23 14:18:57 2026 agent --resume=53d3843c-724e-47ff-ae3a-9fedfa328bba',
            '64096 63443 agent Thu Jul 23 14:19:57 2026 agent --resume=53d3843c-724e-47ff-ae3a-9fedfa328bba',
          ].join('\n'),
        }
      }
      return { err: new Error(`unexpected command: ${cmd}`) }
    }

    await expect(discoverTmuxResumes()).resolves.toEqual([])
  })
})
