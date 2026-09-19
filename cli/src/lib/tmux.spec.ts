import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PROCESS_ENGINES } from '../engines/types.js'
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import {
  ambiguousAgentProcess,
  argvTokens,
  bypassPermissionActive,
  engineProcessMatch,
  engineProcessMatchScore,
  faithfulArgsFromCmdline,
  LSTART_MARKER_RE,
  parseProcessRow,
  quoteArgvElement,
  repairInteropRowFromCmdline,
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

  /**
   * WSL interop: an engine resolved from a distro pane through `command -v` can be a WINDOWS binary
   * relayed by `/init` — live on Windows 11 + Ubuntu: `comm=node.exe`,
   * `args="/init \0 C:\...\node.exe \0 node.exe \0 C:\...\@openai\codex\bin\codex.js"` (node's
   * process.title rewrite duplicates the interpreter after the script path). The matcher used to see
   * `node.exe` + entrypoint `/init` and score 0, so the TUI ran fine while the launch stayed "failed"
   * and the terminal refused input. processRows() rewrites the row from /proc cmdline; the interpreter
   * regex now accepts `.exe`. These pins hold the two halves apart — an unchanged `ps args` row with
   * `/init` first must NOT be rewritten (no /proc evidence to back it), the repaired row must score.
   */
  it('scores a WSL-interop engine relayed through /init', () => {
    const psRow = parseProcessRow(
      ' 1037  1036 node.exe Thu Sep 17 08:20:11 2026 /init C:\\Program Files\\nodejs\\node.exe node.exe'
        + ' C:\\Users\\mcspd\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js')
    // parseProcessRow alone cannot expose the engine: interpreter is `node.exe`, entrypoint `/init`.
    expect(engineProcessMatchScore(psRow!, 'codex')).toBe(0)

    // processRows() swaps in the /proc cmdline argv (leading /init dropped, duplicate node.exe
    // title-rewrite token removed, space-bearing paths double-quoted) — the same shape
    // engineProcessMatch is scored on here.
    const repairedArgs = '"C:\\Program Files\\nodejs\\node.exe"'
      + ' C:\\Users\\mcspd\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js'
    expect(engineProcessMatchScore({ executable: 'node.exe', args: repairedArgs }, 'codex')).toBe(2)
  })

  /**
   * The extraction itself, pinned host-independently (review finding P1): the
   * critical path runs INSIDE WSL/Linux — `path.basename` there would not
   * split the `C:\...` backslashes, the duplicate `node.exe` would survive as
   * the apparent entrypoint, and the row scores 0 again. Runs on any host.
   */
  it('repairInteropRowFromCmdline unwraps /init and quotes spaced Windows paths', () => {
    const fixed = repairInteropRowFromCmdline(
      [
        '/init',
        'C:\\Program Files\\nodejs\\node.exe',
        'node.exe',
        'C:\\Program Files\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js',
      ].join('\0'),
      'node.exe',
    )
    expect(fixed.executable).toBe('node.exe')
    // Backslashes inside quoted tokens are doubled (review cycle-4 P2): argvTokens() collapses
    // `\\` unconditionally, so quoting must double EVERY backslash for the round trip to be
    // token-faithful — `C:\Program Files\...` serializes as `"C:\\Program Files\\..."`.
    expect(fixed.args).toBe(
      '"C:\\\\Program Files\\\\nodejs\\\\node.exe" "C:\\\\Program Files\\\\nodejs\\\\node_modules\\\\@openai\\\\codex\\\\bin\\\\codex.js"',
    )
    // The duplicate bare `node.exe` (node's process.title rewrite) is dropped:
    // `node.exe` appears once as executable inside nodejs/, and a second time
    // only as part of `node_modules` in the entrypoint path. Splitting on the
    // full `nodejs\\node.exe` token shows exactly one interpreter occurrence.
    expect((fixed.args ?? '').split('nodejs\\\\node.exe').length - 1).toBe(1)
    // And the repaired row still reaches the engine entrypoint.
    expect(
      engineProcessMatchScore(
        { executable: fixed.executable!, args: fixed.args! },
        'codex',
      ),
    ).toBe(2)
  })

  it('repairInteropRowFromCmdline leaves non-interop rows alone', () => {
    expect(repairInteropRowFromCmdline('bash\0-l\0', 'bash')).toEqual({})
    expect(repairInteropRowFromCmdline('', null)).toEqual({})
    expect(repairInteropRowFromCmdline('/init\0', 'init')).toEqual({})
  })

  /**
   * The interop repair itself, pinned host-independently because it once shipped a P1 that only
   * Linux-host tests could have caught: `path.basename` on Linux does not split `\\`, so the
   * interpreter-title dedup never fired for the real `C:\…\node.exe` argv inside WSL and the
   * entrypoint walk stopped on the bare duplicate.
   */
  describe('repairInteropRowFromCmdline', () => {
    const NUL = String.fromCharCode(0)

    const windowsArgv = '/init\0C:\\Program Files\\nodejs\\node.exe\0node.exe'
      + '\0C:\\Users\\mcspd\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js'

    it('drops the interpreter-title duplicate behind a WINDOWS interpreter path', () => {
      expect(repairInteropRowFromCmdline(windowsArgv, 'node.exe')).toEqual({
        args: '"C:\\\\Program Files\\\\nodejs\\\\node.exe"'
          + ' C:\\Users\\mcspd\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js',
        executable: 'node.exe',
      })
    })

    it('double-quotes space-bearing tokens so argvTokens() re-splits them as one', () => {
      expect(repairInteropRowFromCmdline(
        '/init\0C:\\Program Files\\nodejs\\node.exe\0C:\\Program Files\\my engine\\cli.js\0--flag',
        null,
      )).toEqual({
        // Quoted tokens carry doubled backslashes (review cycle-4 P2 round-trip rule).
        args: '"C:\\\\Program Files\\\\nodejs\\\\node.exe" "C:\\\\Program Files\\\\my engine\\\\cli.js" --flag',
        executable: 'node.exe',
      })
    })

    it('prefers a real comm name over the relayed interpreter basename', () => {
      expect(repairInteropRowFromCmdline(['/init', '/home/demo/.local/bin/claude'].join(NUL), 'claude'))
        .toEqual({ args: '/home/demo/.local/bin/claude', executable: 'claude' })
      // Review cycle-3 P2: `comm` naming the RELAY (`init`/`/init`) ties the cmdline to nothing —
      // a native docker-init row can carry it too — so it never qualifies a rewrite on its own.
      expect(repairInteropRowFromCmdline(['/init', '/home/demo/.local/bin/claude'].join(NUL), '/init'))
        .toEqual({})
      expect(repairInteropRowFromCmdline(['/init', '/home/demo/.local/bin/claude'].join(NUL), 'init'))
        .toEqual({})
    })

    /**
     * Review cycle-3 P2: `comm` is 15-byte capped on Linux, so it may qualify as a TRUNCATION of
     * the relayed basename — but only a strict one: comm shorter than the basename AND a prefix of
     * it AND exactly 15 bytes. An arbitrary short prefix like `co` over `codex` establishes
     * nothing about interop and must leave the row untouched.
     */
    it('qualifies comm only as an exact name or a 15-byte truncation of the basename', () => {
      // Arbitrary prefix: not a truncation, no qualification.
      expect(repairInteropRowFromCmdline(['/init', '/usr/local/bin/codex', '--version'].join(NUL), 'co')).toEqual({})
      // Genuine 15-byte truncation (measured shape on Ubuntu 24.04) qualifies.
      expect(repairInteropRowFromCmdline(
        ['/init', '/opt/a-very-long-engine-name-binary', '--version'].join(NUL),
        'a-very-long-eng',
      )).toEqual({ args: '/opt/a-very-long-engine-name-binary --version', executable: 'a-very-long-eng' })
      // A comm SHORTER than 15 bytes that merely prefixes the basename is not evidence of
      // truncation — it could be any unrelated short name.
      expect(repairInteropRowFromCmdline(['/init', '/usr/local/bin/codex', '--version'].join(NUL), 'cod')).toEqual({})
    })

    /**
     * Review cycle-2 P2: an exact `/init` argv[0] alone must not qualify a row as a WSL-interop
     * relay. On a native Linux host `/init` is a real program (docker-init) whose cmdline can name
     * any child — rewriting it made `engineProcessMatch` report Codex (score 3) for
     * `/init\0/usr/local/bin/codex\0--version`, so a genuine Linux relay could be selected as the
     * engine instead of its child. Windows-argv evidence (drive-letter path, `.exe`) or a
     * Windows-binary comm is required before the rewrite fires.
     */
    it('leaves native Linux /init rows untouched even when they name an engine child', () => {
      const nativeInit = ['/init', '/usr/local/bin/codex', '--version'].join('\0')
      expect(repairInteropRowFromCmdline(nativeInit, 'docker-init')).toEqual({})
      expect(repairInteropRowFromCmdline(nativeInit, 'bash')).toEqual({})
      expect(repairInteropRowFromCmdline(nativeInit, null)).toEqual({})
      // WSL-interop evidence present -> the rewrite fires even for a POSIX-looking program path:
      // comm naming the relayed program's own basename ties cmdline to the process. An UNRELATED
      // comm (node.exe over a codex path) is exactly the spoof shape and stays untouched unless
      // the argv itself is Windows-shaped.
      expect(repairInteropRowFromCmdline(nativeInit, 'codex')).toEqual({
        args: '/usr/local/bin/codex --version',
        executable: 'codex',
      })
      expect(repairInteropRowFromCmdline(nativeInit, 'node.exe')).toEqual({})
      // Review cycle-4 P2: a `.exe`-shaped CHILD path must not outweigh contradictory comm
      // evidence either — a native Linux init wrapper around a `.exe`-named binary is exactly
      // this shape, and rewriting it made engineProcessMatch score 3 for the wrapper's child.
      expect(repairInteropRowFromCmdline(
        ['/init', '/usr/local/bin/opencode.exe', '--version'].join(NUL),
        'docker-init',
      )).toEqual({})
      // The same argv with NO comm (or a relay-neutral comm) still qualifies on argv shape alone.
      expect(repairInteropRowFromCmdline(
        ['/init', '/usr/local/bin/opencode.exe', '--version'].join(NUL),
        null,
      )).toEqual({ args: '/usr/local/bin/opencode.exe --version', executable: 'opencode.exe' })
      expect(repairInteropRowFromCmdline(
        ['/init', '/usr/local/bin/opencode.exe', '--version'].join(NUL),
        'init',
      )).toEqual({ args: '/usr/local/bin/opencode.exe --version', executable: 'opencode.exe' })
      expect(repairInteropRowFromCmdline(['/init', 'C:\\tools\\codex.exe', '--version'].join(NUL), null)).toEqual({
        args: 'C:\\tools\\codex.exe --version',
        executable: 'codex.exe',
      })
    })

    /**
     * Review cycle-4 P2: only the TERMINATING NUL field may be stripped. Legitimate empty
     * argv elements in the middle of the relayed command line are real boundaries
     * (`prog '' more` is three arguments, not two) and must survive the repair — which also
     * requires the serializer to emit `""` for an empty token, since an unquoted empty
     * element re-splits to ZERO tokens.
     */
    it('preserves interior empty argv elements through the round trip', () => {
      const interpreterPath = 'C:\\Program Files\\nodejs\\node.exe'
      const relayed = repairInteropRowFromCmdline(
        ['/init', interpreterPath, '', 'hello'].join(NUL),
        'node.exe',
      )
      expect(argvTokens(relayed.args!)).toEqual([interpreterPath, '', 'hello'])
      // The terminating NUL artifact is still stripped; the spaced path stays quoted (with
      // doubled backslashes per the round-trip rule) and the plain arg stays bare.
      expect(repairInteropRowFromCmdline(
        ['/init', interpreterPath, 'arg'].join(NUL) + NUL,
        'node.exe',
      ).args).toBe('"C:\\\\Program Files\\\\nodejs\\\\node.exe" arg')
    })

    /**
     * Review cycle-4 P2: the quote -> argvTokens round trip must be faithful for INTERNAL
     * doubled backslash runs too. argvTokens() collapses `\\` unconditionally inside double
     * quotes, so quote() must double EVERY backslash in a quoted token — not only runs that
     * touch a quote or the token end. A spaced UNC path came back with its runs halved.
     */
    it('round-trips internal doubled backslash runs token-faithfully', () => {
      const interpreterPath = 'C:\\\\Program Files\\\\nodejs\\\\node.exe'
      const unc = 'C:' + '\\\\' + '\\\\' + 'UNC share ' + '\\\\' + '\\\\' + ' y z'
      const relayed = repairInteropRowFromCmdline(['/init', interpreterPath, unc].join(NUL), 'node.exe')
      expect(argvTokens(relayed.args!)).toEqual([interpreterPath, unc])
      expect(bypassPermissionActive('codex', relayed.args!)).toBe(false)
    })

    /**
     * Review cycle-5 P2: the strip-ALL trailing-empty loop deleted legitimate empty FINAL
     * arguments. A cmdline read is the execve argv region — every element stored
     * NUL-terminated — so split() yields all elements plus exactly ONE artifact empty after
     * the final NUL, no matter how long the trailing NUL run is:
     * `/init\0prog\0x\0\0\0` is `prog x '' ''`, not `x` with three artifacts.
     */
    it('strips exactly one trailing artifact and keeps legitimate empty final elements', () => {
      // One terminating NUL: one artifact, nothing else lost.
      expect(repairInteropRowFromCmdline(
        ['/init', 'node.exe', 'x'].join(NUL) + NUL,
        'node.exe',
      ).args).toBe('node.exe x')
      // `/init\0node.exe\0x\0\0\0` — the kernel region of `prog x '' ''`: each element
      // carries its own terminating NUL, so the join needs the final one appended.
      const tailEmpties = repairInteropRowFromCmdline(
        ['/init', 'node.exe', 'x', '', ''].join(NUL) + NUL,
        'node.exe',
      )
      expect(argvTokens(tailEmpties.args!)).toEqual(['node.exe', 'x', '', ''])
      // A genuinely empty FINAL argument with a single terminator survives as one `""`.
      const finalEmpty = repairInteropRowFromCmdline(
        ['/init', 'node.exe', 'x', ''].join(NUL) + NUL,
        'node.exe',
      )
      expect(argvTokens(finalEmpty.args!)).toEqual(['node.exe', 'x', ''])
      // No trailing NUL at all (read stopped at buffer end): strip nothing.
      const unterminated = repairInteropRowFromCmdline(
        ['/init', 'node.exe', 'x'].join(NUL),
        'node.exe',
      )
      expect(argvTokens(unterminated.args!)).toEqual(['node.exe', 'x'])
    })
  })

  /**
   * Review cycle-8 P2: ordinary rows (no `?` mangle, no interop relay) used to keep flattened
   * `ps` text even with /proc readable, losing the boundaries of spaced arguments.
   * `repairMangledRows` now re-serializes ordinary rows through `faithfulArgsFromCmdline`;
   * rows with no /proc evidence stay flattened. Pinned through the pure pieces on every host.
   */
  describe('faithfulArgsFromCmdline', () => {
    it('serializes ordinary /proc argv with the shared quoting dialect', () => {
      expect(faithfulArgsFromCmdline('codex\0--flag')).toBe('codex --flag')
      expect(faithfulArgsFromCmdline('codex\0fix the bug')).toBe('codex "fix the bug"')
      expect(faithfulArgsFromCmdline('codex\0C:\\Program Files\\x\\y.exe'))
        .toBe('codex "C:\\\\Program Files\\\\x\\\\y.exe"')
    })

    it('strips exactly one trailing NUL artifact and refuses empty evidence', () => {
      expect(faithfulArgsFromCmdline('codex\0--flag\0')).toBe('codex --flag')
      expect(faithfulArgsFromCmdline('')).toBeNull()
    })

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

  /**
   * Review cycle-5 P1 (security): a bare `--` option terminator ends the option section in
   * every engine's CLI grammar — everything after it is a POSITIONAL, however flag-shaped.
   * Boundary-faithful tokenization (cycles 2-4) made a flag-shaped positional SURVIVE as a
   * token, so a relayed prompt `-- --dangerously-bypass-approvals-and-sandbox` read as an
   * active bypass flag and cli.ts persisted it for the relaunch. The flag must appear
   * BEFORE the terminator to count, for every engine with a confirmed flag.
   */
  it.each([
    ['claude', '--dangerously-skip-permissions'],
    ['codex', '--dangerously-bypass-approvals-and-sandbox'],
    ['cursor', '--force'],
    ['opencode', '--auto'],
  ] as const)('does not count a flag-shaped positional after `--` for %s', (engine, flag) => {
    expect(bypassPermissionActive(engine, `engine -- ${flag}`)).toBe(false)
    expect(bypassPermissionActive(engine, `engine -- prompt about ${flag}`)).toBe(false)
    // Before the terminator it still counts.
    expect(bypassPermissionActive(engine, `engine ${flag} -- prompt`)).toBe(true)
    // No terminator at all: unchanged behavior.
    expect(bypassPermissionActive(engine, `engine ${flag}`)).toBe(true)
  })

  it('still reads flags when no `--` terminator is present', () => {
    expect(bypassPermissionActive('codex', 'codex --dangerously-bypass-approvals-and-sandbox')).toBe(true)
    expect(bypassPermissionActive('codex', 'codex --model gpt-5 --dangerously-bypass-approvals-and-sandbox')).toBe(true)
  })

  it('does not false-positive on a flag that only appears as a substring', () => {
    // The flag text can legitimately appear inside a prompt/argument; only an exact token counts.
    expect(bypassPermissionActive('claude', 'claude "please avoid --dangerously-skip-permissions for now"'))
      .toBe(false)
    expect(bypassPermissionActive('claude', 'claude --dangerously-skip-permissions-explained')).toBe(false)
  })

  /**
   * Review cycle-2 P1 (security): the WSL-interop repair re-quotes relayed argv by escaping
   * embedded double quotes as `\"`. The old argvTokens() regex split on those escapes, so ONE
   * relayed prompt argument — 'Explain " --dangerously-bypass-approvals-and-sandbox " please' —
   * re-tokenized with the flag standing alone, and bypassPermissionActive() flipped false → true.
   * cli.ts persists that state (registry.setBypassPermission) and reads it on relaunch, so prompt
   * text could enable bypass mode for the next session. argvTokens() must treat `\"` inside a
   * double-quoted token as a literal quote, exactly what quote() emits.
   */
  it('does not let an escaped quote inside a relayed prompt enable bypass mode', () => {
    const promptArg = 'Explain " --dangerously-bypass-approvals-and-sandbox " please'
    // quote()'s exact output shape for an element carrying spaces and double quotes.
    const relayedArgs = '"C:\\Program Files\\nodejs\\node.exe"'
      + ' C:\\Users\\mcspd\\AppData\\Roaming\\npm/node_modules/@openai/codex/bin/codex.js'
      + ` "${promptArg.replace(/"/g, '\\"')}"`
    expect(bypassPermissionActive('codex', relayedArgs)).toBe(false)
  })

  it('argvTokens treats \\" inside a double-quoted token as a literal quote', () => {
    expect(argvTokens('codex "say \\"hi\\" now"')).toEqual(['codex', 'say "hi" now'])
    // Unchanged behaviour for the plain cases the matcher relies on.
    expect(argvTokens('codex "hello world" --flag')).toEqual(['codex', 'hello world', '--flag'])
    expect(argvTokens("claude 'pick --dangerously-skip-permissions' x")).toEqual(
      ['claude', 'pick --dangerously-skip-permissions', 'x'])
    // A Windows path with spaces stays one token, and backslashes are not escapes outside quotes.
    expect(argvTokens('"C:\\Program Files\\nodejs\\node.exe" --version'))
      .toEqual(['C:\\Program Files\\nodejs\\node.exe', '--version'])
  })

  /**
   * Review cycle-4 P1 (security): the `?`-mangled-row branch — a localeless `ps` substitutes
   * `?` for every unprintable byte, and a PROMPT ending in `?` lands one in row.args — used to
   * NUL->space-join /proc cmdline with NO quoting and return before the interop repair ran.
   * The joined string re-tokenized with the flag standing alone and
   * bypassPermissionActive('codex', args) flipped to true from prompt text alone, and /init
   * stayed the entrypoint so relay discovery died with it. The branch must re-serialize the
   * raw argv through the same CRT-dialect quoting as the repair.
   *
   * readProcField is Linux-only (`/proc`), so the branch itself cannot run on this host — the
   * test pins the QUOTING CONTRACT through quoteArgvElement, the exact serializer the branch
   * joins with: re-splitting its output must reproduce the original argv elements verbatim.
   */
  it('does not let a ?-mangled cmdline re-split prompt text into flags (quoteArgvElement contract)', () => {
    // The cmdline argv of the repro: a prompt ending in `?` whose text names the bypass flag.
    const promptArg = 'Should I use --dangerously-bypass-approvals-and-sandbox ?'
    const cmdlineArgv = ['C:\\Program Files\\nodejs\\node.exe', 'codex.js', promptArg]
    const joined = cmdlineArgv.map(quoteArgvElement).join(' ')
    expect(argvTokens(joined)).toEqual(cmdlineArgv)
    expect(bypassPermissionActive('codex', joined)).toBe(false)
    // The old shape — the same argv NUL->space-joined bare — DID flip (documents the defect).
    const legacyJoin = cmdlineArgv.join(' ')
    expect(bypassPermissionActive('codex', legacyJoin)).toBe(true)
  })

  /**
   * Review cycle-3 P1 (security): the relayed argv round trip — quote() inside
   * repairInteropRowFromCmdline -> argvTokens() — must be token-faithful for EVERY element, or
   * prompt/argument text re-tokenizes into standalone flags and bypassPermissionActive() flips.
   * Two shapes closed the loop beyond cycle-2's escaped-double-quote repro:
   *   1. a token carrying SINGLE quotes around a flag was serialized bare-with-single-quotes;
   *      argvTokens stripped them and the flag stood alone.
   *   2. a token ending in a backslash emitted `...\"`, whose escape rule swallowed the closing
   *      quote and exposed the NEXT argument's flag text as standalone tokens.
   * Each case pins the round trip itself: repair -> re-split must return the ORIGINAL argv.
   */
  it('preserves argv boundaries through the repair quoting round trip', () => {
    const NUL = String.fromCharCode(0)
    const relayout = (elements: string[]) =>
      repairInteropRowFromCmdline(['/init', ...elements].join(NUL), 'node.exe')
    const interpreterPath = 'C:\\Program Files\\nodejs\\node.exe'

    // 1. Single-quoted flag argument: quote() double-quotes the whole element, the inner single
    //    quotes are literal content, and the flag NEVER stands alone as its own token.
    const singleQuoted = relayout([interpreterPath, "'--dangerously-bypass-approvals-and-sandbox'"])
    expect(argvTokens(singleQuoted.args!))
      .toEqual([interpreterPath, "'--dangerously-bypass-approvals-and-sandbox'"])
    expect(bypassPermissionActive('codex', singleQuoted.args!)).toBe(false)

    // 2. A prompt argument with embedded double quotes escapes as \" and round-trips exactly.
    const promptArg = 'Explain " --dangerously-bypass-approvals-and-sandbox " please'
    const relayed = relayout([interpreterPath, promptArg])
    expect(bypassPermissionActive('codex', relayed.args!)).toBe(false)
    expect(argvTokens(relayed.args!)).toEqual([interpreterPath, promptArg])

    // 3. Trailing-backslash token: backslashes double before the closing quote, so the quote
    //    survives as a boundary and no neighbouring text merges into the token.
    const backslashTail = relayout([interpreterPath, 'C:\\Dir\\', 'plain'])
    expect(argvTokens(backslashTail.args!)).toEqual([interpreterPath, 'C:\\Dir\\', 'plain'])

    // 4. The reviewer's repro shape: a space-bearing token ending in a backslash followed by a
    //    prompt whose text contains the flag — boundaries must hold so it stays prompt text.
    const repro = relayout([
      interpreterPath,
      'C:\\Dir With Space\\',
      'explain --dangerously-bypass-approvals-and-sandbox please',
    ])
    expect(bypassPermissionActive('codex', repro.args!)).toBe(false)
    expect(argvTokens(repro.args!)).toEqual([
      interpreterPath,
      'C:\\Dir With Space\\',
      'explain --dangerously-bypass-approvals-and-sandbox please',
    ])
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

  /**
   * Review cycle-6 P1 (security): resumeSessionId's regex searched INSIDE quoted prompt
   * arguments, so one prompt 'Explain --session ses_OTHER now' supplied a false resume session
   * that discovery bound a relaunch to. The token form requires the flag as a STANDALONE token
   * with the id as the NEXT token, and stops at a bare `--` terminator.
   */
  it('does not read a session id out of prompt text', () => {
    // Quoted prompt argument: the flag text is inside ONE token, never a standalone flag.
    expect(resumeSessionId(
      'opencode', '"/usr/local/bin/opencode" "Explain --session ses_OTHER now"',
    )).toBeNull()
    // After the `--` option terminator everything is positional prompt text.
    expect(resumeSessionId('opencode', 'opencode -- Explain --session ses_OTHER now')).toBeNull()
    expect(resumeSessionId('cursor', 'agent -- --resume 53d3843c-724e-47ff-ae3a-9fedfa328bba')).toBeNull()
    // A real flag still binds.
    expect(resumeSessionId('opencode', 'opencode --session ses_05e335115ffeM05DT5hJHeN3Vp'))
      .toBe('ses_05e335115ffeM05DT5hJHeN3Vp')
  })

  /** Review cycle-6 P2: codex.exe/claude.exe native names scored 0 while opencode.exe scored. */
  it.each(['claude', 'codex'] as const)('recognises native Windows %s.exe basenames', (engine) => {
    expect(engineProcessMatchScore({ executable: `${engine}.exe`, args: `${engine}.exe --version` }, engine))
      .toBeGreaterThan(0)
  })

  /**
   * Review cycle-9 P2: the both-separator basename over-corrected the Windows port — `\` is a
   * legal filename character in POSIX paths, so a Linux script literally named `not\codex`
   * came out as basename `codex` and scored as a Codex match; discovery could claim an
   * unrelated process. The dialect is read from the path itself: drive-letter/UNC paths split
   * on both separators, POSIX paths on `/` only.
   */
  it('does not split a POSIX path on a backslash that is part of a filename', () => {
    expect(engineProcessMatchScore({
      executable: '/tmp/not\\codex',
      args: '/tmp/not\\codex --version',
    }, 'codex')).toBe(0)
    // The Windows dialect still splits on both separators.
    expect(engineProcessMatchScore({
      executable: 'C:\\tools\\not\\codex.exe',
      args: 'C:\\tools\\not\\codex.exe --version',
    }, 'codex')).toBeGreaterThan(0)
    expect(engineProcessMatchScore({
      executable: '\\\\nas\\share\\not\\codex.exe',
      args: '\\\\nas\\share\\not\\codex.exe --version',
    }, 'codex')).toBeGreaterThan(0)
  })

  it('maps neutral visible/history and ANSI capture options to tmux flags', () => {
    expect(tmuxCaptureArgs('%7', 60)).toEqual([
      'capture-pane', '-p', '-e', '-J', '-t', '%7', '-S', '-60',
    ])
    expect(tmuxCaptureArgs('%7', 60, { visible: true, ansi: false })).toEqual([
      'capture-pane', '-p', '-J', '-t', '%7',
    ])
  })

  // POSIX host artifact: the fake tmux is a `#!/bin/sh` script, which Windows cannot exec through
  // execFile, and the PATH injection below uses a `:` separator that Windows never matches.
  it.skipIf(process.platform === 'win32')('carries prompt and literal bytes only over stdin, never child argv or diagnostics', async () => {
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
