import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ts, sid, preview, installTimestampedConsole, logFrame,
  adoptLegacyLog, prepareLogFile, trimLogFile, LOG_MAX_BYTES,
} from './log.js'

describe('log helpers', () => {
  afterEach(() => vi.restoreAllMocks())

  it('formats ts() as YYYY-MM-DD HH:MM:SS.mmm', () => {
    expect(ts(new Date(2026, 6, 24, 9, 5, 3, 7))).toBe('2026-07-24 09:05:03.007')
    expect(ts()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)
  })

  it('shortens session ids', () => {
    expect(sid('69aaaa14-89e9-7e21-871a-ee6ea943fc95')).toBe('69aaaa14')
  })

  describe('logFrame', () => {
    const lastLine = (spy: ReturnType<typeof vi.spyOn>) => String(spy.mock.calls.at(-1)?.[0] ?? '')

    it('prints direction, audience, type and the opaque ids that make a frame identifiable', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      logFrame('→', 'web', {
        type: 'agent_synced',
        payload: {
          agentId: '26f49435-71e8-4461-ac59-65c0e854b374',
          agent: { engine: 'claude', selectedModel: 'runtime-v1:x:claude:anthropic%2Fclaude-sonnet-5@xhigh' },
        },
      })
      const line = lastLine(spy)
      expect(line).toContain('[frame] → web agent_synced')
      expect(line).toContain('agentId=26f49435')
      expect(line).toContain('engine=claude')
      expect(line).toContain('agent.selectedModel=runtime-v1:x:claude:anthropic%2Fclaude-sonnet-5@xhigh')
    })

    it('never prints a payload body — this log is the one place frames are in the clear', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      logFrame('←', 'conn:74dab280', {
        type: 'message',
        payload: {
          sessionId: '9e9f7954-1111-2222-3333-444455556666',
          text: 'my private prompt about the acquisition',
          token: 'sk-or-v1-secret',
          images: ['data:image/png;base64,AAAA'],
        },
      })
      const line = lastLine(spy)
      expect(line).toContain('sessionId=9e9f7954')
      expect(line).not.toContain('private prompt')
      expect(line).not.toContain('sk-or-v1-secret')
      expect(line).not.toContain('base64')
    })

    it('summarizes a catalog by size, not by contents', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      logFrame('→', 'conn:1', { type: 'models_list_result', payload: { models: [{ id: 'a' }, { id: 'b' }] } })
      expect(lastLine(spy)).toContain('models=2')
      logFrame('→', 'conn:1', { type: 'models_list_result', payload: { models: [] } })
      expect(lastLine(spy)).toContain('models=0')
    })
  })

  it('flattens whitespace and caps preview with an ellipsis', () => {
    expect(preview('  hello\n\n  world  ')).toBe('hello world')
    expect(preview('abcdef', 3)).toBe('abc…')
    expect(preview('')).toBe('')
  })

  it('prepends a timestamp yet preserves the original args (waitForReady marker intact)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // Capture the wrapper by re-reading console.log AFTER install.
    installTimestampedConsole()
    console.log('[backend] connected → wss://x')
    const line = spy.mock.calls.at(-1)!.join(' ')
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[backend\] connected/)
    expect(line).toContain('[backend] connected') // substring the self-update readiness check scans
  })
})

describe('log file cap', () => {
  let dir: string
  let file: string
  let legacy: string
  const line = (i: number): string => `line-${String(i).padStart(6, '0')} ${'x'.repeat(80)}\n`

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adapter-log-'))
    file = join(dir, 'harness.log')
    legacy = join(dir, 'machine.log')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const fill = (bytes: number): number => {
    let out = ''
    let i = 0
    while (out.length < bytes) out += line(i++)
    writeFileSync(file, out)
    return i
  }

  it('leaves a file under the cap alone', () => {
    fill(2_000)
    const before = readFileSync(file, 'utf-8')
    expect(trimLogFile(file, 10_000)).toBe(false)
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('is a no-op when there is no log yet', () => {
    expect(trimLogFile(join(dir, 'nope.log'))).toBe(false)
  })

  it('drops the OLDEST half and keeps the newest lines, at a line boundary', () => {
    const cap = 40_000
    const written = fill(cap * 2)
    expect(trimLogFile(file, cap)).toBe(true)

    const after = readFileSync(file, 'utf-8')
    expect(statSync(file).size).toBeLessThanOrEqual(cap)
    // Newest line survived, oldest is gone.
    expect(after).toContain(`line-${String(written - 1).padStart(6, '0')}`)
    expect(after).not.toContain('line-000000')
    // First line is the trim marker; the second is a WHOLE line, not a fragment.
    const lines = after.split('\n')
    expect(lines[0]).toMatch(/\[log\] trimmed — dropped the oldest \d+ MB \(cap 0 MB\)$/)
    expect(lines[1]).toMatch(/^line-\d{6} x+$/)
  })

  it('keeps an O_APPEND writer landing at the end — no sparse hole', () => {
    // The daemon holds the log as its stdout fd across a trim; this is the property that makes an
    // in-place rewrite safe (a non-append fd would resume at its old offset and leave NUL bytes).
    const cap = 40_000
    fill(cap * 2)
    const fd = openSync(file, 'a')
    try {
      expect(trimLogFile(file, cap)).toBe(true)
      writeSync(fd, 'after-the-trim\n')
    } finally {
      closeSync(fd)
    }
    const after = readFileSync(file)
    expect(after.toString('utf-8').trimEnd().endsWith('after-the-trim')).toBe(true)
    expect(after.includes(0)).toBe(false)
    expect(after.length).toBeLessThanOrEqual(cap)
  })

  it('caps at 10 MB by default', () => {
    expect(LOG_MAX_BYTES).toBe(10 * 1024 * 1024)
  })

  it('adopts a legacy log by RENAME, so an open fd keeps writing to the same file', () => {
    writeFileSync(legacy, 'old-history\n')
    const inode = statSync(legacy).ino
    const fd = openSync(legacy, 'a')   // stands in for a daemon started before the rename
    try {
      adoptLegacyLog(file, legacy)
      writeSync(fd, 'written-after-rename\n')
    } finally {
      closeSync(fd)
    }
    expect(existsSync(legacy)).toBe(false)
    expect(statSync(file).ino).toBe(inode)
    expect(readFileSync(file, 'utf-8')).toBe('old-history\nwritten-after-rename\n')
  })

  it('never clobbers an existing log, and shrugs off a missing legacy one', () => {
    writeFileSync(file, 'current\n')
    writeFileSync(legacy, 'stale\n')
    adoptLegacyLog(file, legacy)
    expect(readFileSync(file, 'utf-8')).toBe('current\n')
    expect(readFileSync(legacy, 'utf-8')).toBe('stale\n')   // left for the user to delete

    rmSync(legacy)
    expect(() => adoptLegacyLog(file, legacy)).not.toThrow()
  })

  it('prepareLogFile adopts then trims in one pass', () => {
    let out = ''
    while (out.length < 30_000) out += line(out.length)
    writeFileSync(legacy, out)
    prepareLogFile(file, legacy, 10_000)
    expect(existsSync(legacy)).toBe(false)
    expect(statSync(file).size).toBeLessThanOrEqual(10_000)
  })
})
