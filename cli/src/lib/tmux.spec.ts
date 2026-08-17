import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import {
  ambiguousAgentProcess,
  engineProcessMatchScore,
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

  it('recognises stable installed binary forms', () => {
    expect(engineProcessMatchScore({ executable: 'devin', args: 'devin' }, 'devin')).toBe(3)
    expect(engineProcessMatchScore({ executable: 'muse-bin-0.1.0-R708.1', args: 'muse-bin-0.1.0-R708.1' }, 'muse')).toBe(3)
    expect(engineProcessMatchScore({ executable: '/Users/demo/.grok/bin/grok', args: 'grok' }, 'grok')).toBe(3)
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
