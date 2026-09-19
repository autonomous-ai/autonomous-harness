import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PROCESS_ENGINES } from '../engines/types.js'
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import {
  ambiguousAgentProcess,
  bypassPermissionActive,
  engineProcessMatch,
  engineProcessMatchScore,
  LSTART_MARKER_RE,
  parseProcessRow,
  resumeSessionId,
  sendLiteralToTmux,
  sendToTmux,
  tmuxCaptureArgs,
} from './tmux.js'

const ownership = (cursor: string[] = [], grok: string[] = []): AgentCommandOwnershipSnapshot => ({
  cursorFileKeys: new Set(cursor),
  grokFileKeys: new Set(grok),
  conflictingFileKeys: new Set(cursor.filter((key) => grok.includes(key))),
  agentCandidates: [],
  cursorAgentCandidates: [],
  grokCandidates: [],
})

describe('tmux process primitives', () => {
  it('parses a process whose comm field contains spaces', () => {
    expect(parseProcessRow('4242 100 ⌘ Greeting Thu Jul 30 11:00:03 2026 cmd -r abcdef12-3456-7890-abcd-ef1234567890')).toEqual({
      pid: 4242,
      parentPid: 100,
      executable: '⌘ Greeting',
      startMarker: 'Thu Jul 30 11:00:03 2026',
      args: 'cmd -r abcdef12-3456-7890-abcd-ef1234567890',
    })
  })

  /**
   * Real `ps -axo pid=,ppid=,comm=,lstart=,args=` output captured on Ubuntu 24.04 (procps-ng 4.0.4),
   * not a macOS-shaped invention. Two things differ from macOS and both are load-bearing:
   *   - `comm` is a bare name, never a path (`/sbin/docker-init` reads back as `docker-init`);
   *   - `comm` is hard-capped at 15 bytes by TASK_COMM_LEN, so the binary really named
   *     `a-very-long-engine-name-binary` reads back as `a-very-long-eng`.
   * `tmux: server` also proves comm can still carry a space on Linux, which is why the parser anchors
   * on lstart rather than splitting comm as one token.
   */
  it('parses real Linux procps rows, including a 15-byte-truncated comm', () => {
    expect(parseProcessRow('    1     0 docker-init     Fri Aug 21 09:28:14 2026 /sbin/docker-init -- bash -lc')).toEqual({
      pid: 1,
      parentPid: 0,
      executable: 'docker-init',
      startMarker: 'Fri Aug 21 09:28:14 2026',
      args: '/sbin/docker-init -- bash -lc',
    })
    expect(parseProcessRow('   15     1 tmux: server    Fri Aug 21 09:28:14 2026 tmux new-session -d -s probe sleep 400')).toEqual({
      pid: 15,
      parentPid: 1,
      executable: 'tmux: server',
      startMarker: 'Fri Aug 21 09:28:14 2026',
      args: 'tmux new-session -d -s probe sleep 400',
    })
    const truncated = parseProcessRow(
      '   12     7 a-very-long-eng Fri Aug 21 09:28:14 2026 /tmp/a-very-long-engine-name-binary -e x')
    expect(truncated?.executable).toBe('a-very-long-eng')
    expect(Buffer.byteLength(truncated!.executable)).toBe(15)
  })

  /**
   * Linux procps substitutes `?` for any byte it cannot print in the current locale, and a daemon under
   * systemd/docker/ssh usually has no locale at all. Measured on Ubuntu 24.04: a Command Code pane reads
   * back as `??? <title>` in BOTH comm and args, so both halves of its marker fail and the reaper evicts
   * the live pane. processRows() now reads ps under LC_ALL=C.UTF-8 and repairs any surviving `?` row from
   * /proc, which is raw bytes. These two cases pin the before and the after.
   */
  /**
   * `lstart`'s shape belongs to LC_TIME, not to `ps`. Captured with
   * `LC_TIME=<locale> ps -axo pid=,ppid=,comm=,lstart=,args=` on macOS 15.5, one run per locale on the
   * same machine in the same second. Of sixteen locales tried only C, en_US and hu_HU parse at all; the
   * rest reorder the fields and yield ZERO rows out of ~590.
   *
   * Zero rows is the whole bug: processRows returns `[]`, not null, so "we looked and the machine is
   * empty" is indistinguishable from the truth, resolvePaneEngineProcess finds no engine under any pane,
   * and watchCreatedPane burns its full ten minutes before reporting START_TIMEOUT — "claude did not
   * expose an engine process within 10 minutes" — against a pane where claude is running and still
   * firing hooks. This is why processRows spawns ps under psEnv instead of inheriting the locale.
   */
  it('cannot parse an lstart column written by a locale that reorders it', () => {
    const rows = [
      '15160  2281 /Users/admin/.lo Tue 15 Sep 23:10:38 2026 /Users/admin/.local/bin/claude',
      '15160  2281 /Users/admin/.lo Di. 15 Sep. 23:10:38 2026 /Users/admin/.local/bin/claude',
      '15160  2281 /Users/admin/.lo mar. 15 sept. 23:10:38 2026 /Users/admin/.local/bin/claude',
      '15160  2281 /Users/admin/.lo \u706b  9/15 23:10:38 2026 /Users/admin/.local/bin/claude',
      '15160  2281 /Users/admin/.lo \u0432\u0442\u043e\u0440\u043d\u0438\u043a, 15 \u0441\u0435\u043d\u0442\u044f\u0431\u0440\u044f 2026 \u0433. 23:10:38 /Users/admin/.local/bin/claude',
    ]
    for (const row of rows) expect(parseProcessRow(row)).toBeNull()

    // The same process, same second, under the LC_TIME=C that psEnv guarantees.
    expect(parseProcessRow('15160  2281 /Users/admin/.lo Tue Sep 15 23:10:38 2026 /Users/admin/.local/bin/claude'))
      .toEqual({
        pid: 15160,
        parentPid: 2281,
        executable: '/Users/admin/.lo',
        startMarker: 'Tue Sep 15 23:10:38 2026',
        args: '/Users/admin/.local/bin/claude',
      })
  })

  /**
   * checkSessionRuntime adopts, rather than compares, any saved marker this rejects. It has to reject
   * localized stamps too: a marker recorded before psEnv landed (hu_HU parsed fine, `K szept. 15 …`) can
   * never equal the C-locale stamp read back for the same live process, and comparing them would evict a
   * live pane exactly once per session on upgrade.
   */
  it('recognises only a C-locale lstart stamp as a comparable start marker', () => {
    expect(LSTART_MARKER_RE.test('Tue Sep 15 23:10:38 2026')).toBe(true)
    expect(LSTART_MARKER_RE.test('Fri Aug 21 09:28:14 2026')).toBe(true)

    expect(LSTART_MARKER_RE.test('K szept. 15 23:10:38 2026')).toBe(false)   // hu_HU, parsed pre-fix
    expect(LSTART_MARKER_RE.test('Tue 15 Sep 23:10:38 2026')).toBe(false)    // en_AU
    expect(LSTART_MARKER_RE.test('Greeting Thu Jul 30 11:00:03 2026')).toBe(false) // pre-fix shifted comm
  })

  it('scores Command Code from the real bytes, and cannot from the mangled ones', () => {
    const mangled = parseProcessRow('  185   178 ??? harness-cli Fri Aug 21 09:34:20 2026 ??? harness-cli ubuntu probe')
    expect(engineProcessMatchScore(mangled!, 'commandcode')).toBe(0)

    const repaired = parseProcessRow('  185   178 ⌘ harness-cli Fri Aug 21 09:34:20 2026 ⌘ harness-cli ubuntu probe')
    expect(engineProcessMatchScore(repaired!, 'commandcode')).toBe(3)
  })

  it('recognises stable installed binary forms', () => {
    expect(engineProcessMatchScore({ executable: 'devin', args: 'devin' }, 'devin')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'muse-bin-0.1.0-R708.1', args: 'muse-bin-0.1.0-R708.1' }, 'muse')).toBe(3)
    expect(engineProcessMatchScore({ executable: '/Users/demo/.grok/bin/grok', args: 'grok' }, 'grok')).toBe(3)
  })

  it.each([
    ['codex', 'codex-aarch64-apple-darwin'],
    ['codex', 'codex-x86_64-unknown-linux-musl'],
    ['kilo', 'kilo-darwin-arm64'],
    ['kilo', 'kilo-linux-x64-baseline'],
    ['grok', 'grok-1.0.5-macos-aarch64'],
    ['grok', 'grok-linux-x86_64'],
  ] as const)('recognises the %s standalone release image %s', (engine, executable) => {
    expect(engineProcessMatchScore({ executable, args: executable }, engine)).toBe(3)
  })

  it('uses installed executable identity ahead of misleading argv names', () => {
    const allFiles = new Map([['codex', new Set(['codex-native'])]]) as AgentCommandOwnershipSnapshot['engineFileKeys']
    const commands: AgentCommandOwnershipSnapshot = {
      ...ownership(),
      engineFileKeys: allFiles,
      engineCandidates: new Map(),
    }
    const row = {
      executable: 'renamed-release-image',
      args: 'renamed-release-image --some-flag',
      imagePath: '/custom/native/renamed-release-image',
      imageFileKey: 'codex-native',
    }
    expect(engineProcessMatch(row, 'codex', commands)).toEqual({
      score: 4,
      evidence: 'file-identity',
      imagePath: '/custom/native/renamed-release-image',
    })
    expect(engineProcessMatchScore(row, 'claude', commands)).toBe(0)
  })

  it.each(PROCESS_ENGINES)('recognises a renamed native %s image from installed file identity', (engine) => {
    const key = `native-${engine}`
    const commands: AgentCommandOwnershipSnapshot = {
      ...ownership(),
      engineFileKeys: new Map([[engine, new Set([key])]]),
      engineCandidates: new Map(),
    }
    expect(engineProcessMatch({
      executable: 'vendor-rewritten-title',
      args: 'vendor-rewritten-title',
      imageFileKey: key,
    }, engine, commands)).toMatchObject({ score: 4, evidence: 'file-identity' })
  })

  it('rejects Antigravity IDE binaries even when their basename is agy', () => {
    expect(engineProcessMatchScore({
      executable: '/Applications/Antigravity.app/Contents/Resources/bin/agy',
      args: '/Applications/Antigravity.app/Contents/Resources/bin/agy',
    }, 'agy')).toBe(0)
  })

  it('recognises Claude native installer version targets without accepting a bare semver', () => {
    expect(engineProcessMatchScore({
      executable: '/Users/demo/.local/share/claude/versions/2.1.246',
      args: '/Users/demo/.local/share/claude/versions/2.1.246',
    }, 'claude')).toBe(3)
    expect(engineProcessMatchScore({
      executable: '2.1.246',
      args: '/home/demo/.local/share/claude/versions/2.1.246',
    }, 'claude')).toBe(3)
    expect(engineProcessMatchScore({ executable: '2.1.246', args: '2.1.246' }, 'claude')).toBe(0)
  })

  it('reads an engine through the ori launcher, before and after its exec', () => {
    // `ori claude` computes an environment and then execve's the vendor binary away, so for all but the
    // first ~100ms the pane row IS `claude` — that case must keep scoring exactly as a bare launch does.
    expect(engineProcessMatchScore({ executable: 'claude', args: '/Users/demo/.local/bin/claude --resume x' }, 'claude')).toBe(3)
    // The pre-exec window (and any future ori that spawns instead of exec'ing) resolves through the flags.
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori claude' }, 'claude')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'ori', args: '/Users/demo/.local/bin/ori claude --model anthropic/claude-sonnet-4.6 -p hi' }, 'claude')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori --log-level debug codex --full-auto' }, 'codex')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori opencode' }, 'opencode')).toBe(3)
    // Wrapping does not make it a different engine, and ori's own subcommands are not engines.
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori claude' }, 'codex')).toBe(0)
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori eval' }, 'claude')).toBe(0)
    expect(engineProcessMatchScore({ executable: 'ori', args: 'ori login' }, 'claude')).toBe(0)
  })

  it('assigns the colliding agent basename only from executable ownership', () => {
    const cursor = ownership(['cursor-file'], ['grok-file'])
    const grok = ownership(['cursor-file'], ['grok-file'])
    const cursorRow = { executable: 'agent', args: 'agent', imageFileKey: 'cursor-file' }
    const grokRow = { executable: 'agent', args: 'agent', imageFileKey: 'grok-file' }

    expect(engineProcessMatchScore(cursorRow, 'cursor', cursor)).toBe(4)
    expect(engineProcessMatchScore(cursorRow, 'grok', cursor)).toBe(0)
    expect(engineProcessMatchScore(grokRow, 'grok', grok)).toBe(4)
    expect(engineProcessMatchScore(grokRow, 'cursor', grok)).toBe(0)
    expect(engineProcessMatchScore({ executable: 'agent', args: 'agent' }, 'cursor', cursor)).toBe(0)
    const conflict = ownership(['same-file'], ['same-file'])
    expect(engineProcessMatchScore({ executable: 'agent', args: 'agent', imageFileKey: 'same-file' }, 'cursor', conflict)).toBe(0)
    expect(engineProcessMatchScore({ executable: 'agent', args: 'agent', imageFileKey: 'same-file' }, 'grok', conflict)).toBe(0)
  })

  it('does not treat a daemon role named agent as the colliding CLI command', () => {
    expect(ambiguousAgentProcess({
      executable: '/usr/sbin/distnoted',
      args: '/usr/sbin/distnoted agent',
    }, ownership())).toBe(false)
    expect(ambiguousAgentProcess({
      executable: '/usr/sbin/cfprefsd',
      args: '/usr/sbin/cfprefsd agent',
    }, ownership())).toBe(false)
  })

  it('extracts only explicit resume ids', () => {
    expect(resumeSessionId('cursor', 'agent --resume=53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('opencode', 'opencode -s ses_05e335115ffeM05DT5hJHeN3Vp'))
      .toBe('ses_05e335115ffeM05DT5hJHeN3Vp')
    expect(resumeSessionId('hermes', 'hermes --resume 20260728_115628_f2c86a'))
      .toBe('20260728_115628_f2c86a')
    expect(resumeSessionId('kilo', 'kilo --session ses_024a007fdffe11yG68JPxsHJly'))
      .toBe('ses_024a007fdffe11yG68JPxsHJly')
    expect(resumeSessionId('pi', 'pi --session-id 53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('commandcode', 'cmd --resume 53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('muse', 'muse resume 53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('amp', 'amp threads continue T-019fda49-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('T-019fda49-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('grok', 'grok -r 53d3843c-724e-47ff-ae3a-9fedfa328bba'))
      .toBe('53d3843c-724e-47ff-ae3a-9fedfa328bba')
    expect(resumeSessionId('commandcode', 'cmd -r Greeting')).toBeNull()
    expect(resumeSessionId('claude', 'claude --resume 53d3843c-724e-47ff-ae3a-9fedfa328bba')).toBeNull()
    expect(resumeSessionId('codex', 'codex resume 53d3843c-724e-47ff-ae3a-9fedfa328bba')).toBeNull()
    expect(resumeSessionId('devin', 'devin --resume 53d3843c-724e-47ff-ae3a-9fedfa328bba')).toBeNull()
  })

  it('reads bypass-permission mode from a live process argv via exact token match', () => {
    expect(bypassPermissionActive('claude', '/usr/local/bin/claude --permission-mode auto')).toBe(true)
    expect(bypassPermissionActive('claude', 'claude --permission-mode=auto --resume abc')).toBe(true)
    expect(bypassPermissionActive('codex', 'codex resume abc --approve-for-me')).toBe(true)
    // Launched before the auto modes: the old flags still count, and a relaunch uses the auto mode.
    expect(bypassPermissionActive('claude', '/usr/local/bin/claude --dangerously-skip-permissions'))
      .toBe(true)
    expect(bypassPermissionActive('codex', 'codex --dangerously-bypass-approvals-and-sandbox'))
      .toBe(true)
    expect(bypassPermissionActive('cursor', 'cursor-agent --force')).toBe(true)
    expect(bypassPermissionActive('opencode', 'opencode --auto')).toBe(true)
  })

  it('does not false-positive on a flag that only appears as a substring', () => {
    // The flag text can legitimately appear inside a prompt/argument; only an exact token counts.
    expect(bypassPermissionActive('claude', 'claude "please avoid --dangerously-skip-permissions for now"'))
      .toBe(false)
    expect(bypassPermissionActive('claude', 'claude --dangerously-skip-permissions-explained')).toBe(false)
  })

  it('reads false when the confirmed flag is absent', () => {
    expect(bypassPermissionActive('claude', 'claude --resume abc')).toBe(false)
    // Another mode, or "auto" that is not the mode's value.
    expect(bypassPermissionActive('claude', 'claude --permission-mode plan')).toBe(false)
    expect(bypassPermissionActive('claude', 'claude --permission-mode manual auto')).toBe(false)
    expect(bypassPermissionActive('claude', 'claude auto --permission-mode')).toBe(false)
  })

  it('always reads false for engines with no confirmed bypass flag — never guesses', () => {
    expect(bypassPermissionActive('pi', 'pi --dangerously-skip-permissions')).toBe(false)
    expect(bypassPermissionActive('hermes', 'hermes --dangerously-skip-permissions')).toBe(false)
    expect(bypassPermissionActive('devin', 'devin --dangerously-skip-permissions')).toBe(false)
  })

  it('maps neutral visible/history and ANSI capture options to tmux flags', () => {
    expect(tmuxCaptureArgs('%7', 60)).toEqual([
      'capture-pane', '-p', '-e', '-J', '-t', '%7', '-S', '-60',
    ])
    expect(tmuxCaptureArgs('%7', 60, { visible: true, ansi: false })).toEqual([
      'capture-pane', '-p', '-J', '-t', '%7',
    ])
  })

  it('carries prompt and literal bytes only over stdin, never child argv or diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-tmux-input-'))
    const argsFile = join(dir, 'args')
    const stdinFile = join(dir, 'stdin')
    const fakeTmux = join(dir, 'tmux')
    const sentinel = `prompt sentinel $' ${process.pid}`
    writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_INPUT_ARGS"
if [ "$1" = "load-buffer" ]; then
  cat >> "$TMUX_INPUT_STDIN"
  printf '\\n' >> "$TMUX_INPUT_STDIN"
fi
if [ "$1" = "paste-buffer" ] && [ "$TMUX_INPUT_FAIL_PASTE" = "1" ]; then
  printf 'synthetic paste failure\\n' >&2
  exit 2
fi
`)
    chmodSync(fakeTmux, 0o700)
    const previous = {
      path: process.env.PATH,
      args: process.env.TMUX_INPUT_ARGS,
      stdin: process.env.TMUX_INPUT_STDIN,
      fail: process.env.TMUX_INPUT_FAIL_PASTE,
    }
    const errors: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation((...values) => {
      errors.push(values.map(String).join(' '))
    })
    try {
      process.env.PATH = `${dir}:${previous.path ?? ''}`
      process.env.TMUX_INPUT_ARGS = argsFile
      process.env.TMUX_INPUT_STDIN = stdinFile
      expect(await sendLiteralToTmux('%7', sentinel)).toBe(true)
      expect(await sendToTmux('%7', sentinel)).toBe(true)
      process.env.TMUX_INPUT_FAIL_PASTE = '1'
      expect(await sendLiteralToTmux('%7', sentinel)).toBe(false)

      const argv = readFileSync(argsFile, 'utf8')
      expect(argv).not.toContain(sentinel)
      expect(readFileSync(stdinFile, 'utf8').split(sentinel)).toHaveLength(4)
      expect(errors.join('\n')).not.toContain(sentinel)
    } finally {
      error.mockRestore()
      if (previous.path === undefined) delete process.env.PATH
      else process.env.PATH = previous.path
      if (previous.args === undefined) delete process.env.TMUX_INPUT_ARGS
      else process.env.TMUX_INPUT_ARGS = previous.args
      if (previous.stdin === undefined) delete process.env.TMUX_INPUT_STDIN
      else process.env.TMUX_INPUT_STDIN = previous.stdin
      if (previous.fail === undefined) delete process.env.TMUX_INPUT_FAIL_PASTE
      else process.env.TMUX_INPUT_FAIL_PASTE = previous.fail
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
