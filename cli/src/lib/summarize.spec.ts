import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  runClaude: vi.fn(),
  runCodex: vi.fn(),
  runCursor: vi.fn(),
  runGrok: vi.fn(),
  cleanupCursor: vi.fn(),
  setCounts: vi.fn(),
  resolveKey: vi.fn(),
  complete: vi.fn(),
}))

vi.mock('../config/env.js', () => ({
  env: {
    ADAPTER_DATA_DIR: '/tmp/machine-adapter-summarize-spec',
    CURSOR_HOME: '/tmp/machine-adapter-summarize-spec/cursor',
    SUMMARY_MODEL: 'sonnet',
    CODEX_SUMMARY_MODEL: 'gpt-5.5',
    CURSOR_SUMMARY_MODEL: 'auto',
    GROK_SUMMARY_MODEL: 'grok-4.5',
    SUMMARY_EFFORT: 'low',
    ORI_SUMMARY_MODEL: 'deepseek/deepseek-v4-flash',
  },
}))

vi.mock('./openrouter.js', () => ({
  resolveOpenRouterKey: mocks.resolveKey,
  openRouterComplete: mocks.complete,
}))

vi.mock('./oneshot.js', () => ({
  cleanupCursorOneShotSession: mocks.cleanupCursor,
  configureOneShotPool: mocks.configure,
  runClaudeOneShot: mocks.runClaude,
  runCodexOneShot: mocks.runCodex,
  runCursorOneShot: mocks.runCursor,
  runGrokOneShot: mocks.runGrok,
  setOneShotPoolActiveCounts: mocks.setCounts,
  setOneShotPoolDeviceConnected: vi.fn(),
  shutdownOneShotPool: vi.fn(),
}))

import { summarizeTurnText, syncSummaryPoolSessions } from './summarize.js'

beforeEach(() => {
  mocks.runClaude.mockReset()
  mocks.runCodex.mockReset()
  mocks.runCursor.mockReset()
  mocks.runGrok.mockReset()
  mocks.cleanupCursor.mockReset()
  mocks.cleanupCursor.mockResolvedValue(undefined)
  mocks.setCounts.mockReset()
  mocks.resolveKey.mockReset()
  mocks.complete.mockReset()
})

describe('gateway recap', () => {
  const gateway = { kind: 'ori' as const, apiKey: 'sk-or-v1-process' }

  it('calls OpenRouter directly and never spawns a vendor one-shot', async () => {
    // The point of the whole path: an `ori claude` user may hold no Anthropic credential at all, so the
    // engine one-shot would spawn a CLI that cannot authenticate and the recap would never arrive.
    mocks.resolveKey.mockResolvedValue('sk-or-v1-process')
    mocks.complete.mockResolvedValue('Recap works through the gateway.\n\nThe turn recapped without a vendor login.')

    await expect(summarizeTurnText(
      'Wired the gateway recap path.',
      undefined,
      'Does the gateway recap work?',
      'claude',
      gateway,
    )).resolves.toBe('Recap works through the gateway.\n\nThe turn recapped without a vendor login.')

    expect(mocks.complete).toHaveBeenCalledTimes(1)
    expect(mocks.complete.mock.calls[0][0]).toMatchObject({
      model: 'deepseek/deepseek-v4-flash',
      apiKey: 'sk-or-v1-process',
    })
    expect(mocks.runClaude).not.toHaveBeenCalled()
  })

  it('falls back to the engine one-shot when no key resolves', async () => {
    mocks.resolveKey.mockResolvedValue(null)
    mocks.runClaude.mockResolvedValue({ text: 'Engine recap.\n\nThe engine path still runs.', sessionId: null })

    await expect(summarizeTurnText('Did the work.', undefined, 'Status?', 'claude', gateway))
      .resolves.toBe('Engine recap.\n\nThe engine path still runs.')

    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.runClaude).toHaveBeenCalledTimes(1)
    expect(mocks.runClaude.mock.calls[0][0]).toMatchObject({ model: 'sonnet' })
  })

  it('leaves a normal vendor agent on its own engine one-shot', async () => {
    mocks.runClaude.mockResolvedValue({ text: 'Engine recap.\n\nNothing changed here.', sessionId: null })

    await expect(summarizeTurnText('Did the work.', undefined, 'Status?', 'claude')).resolves.toBeTruthy()

    expect(mocks.resolveKey).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
  })
})

describe('Cursor recap', () => {
  it('uses a Cursor one-shot with the configured Cursor model', async () => {
    mocks.runCursor.mockResolvedValue({
      text: 'Cursor recap works.\n\nThe Cursor turn now produces a persisted device recap.',
      sessionId: 'cursor-recap-session',
    })

    await expect(summarizeTurnText(
      'Implemented Cursor recap support.',
      undefined,
      'Does Cursor recap work?',
      'cursor',
    )).resolves.toBe(
      'Cursor recap works.\n\nThe Cursor turn now produces a persisted device recap.',
    )

    expect(mocks.runCursor).toHaveBeenCalledOnce()
    expect(mocks.runCursor.mock.calls[0][0]).toMatchObject({
      model: 'auto',
      effort: 'low',
    })
    expect(mocks.runClaude).not.toHaveBeenCalled()
    expect(mocks.runCodex).not.toHaveBeenCalled()
    expect(mocks.cleanupCursor).toHaveBeenCalledWith('cursor-recap-session')
  })

  it('includes Cursor, OpenCode, Kilo and Pi sessions when sizing recap workers', () => {
    syncSummaryPoolSessions([
      { engine: 'claude' },
      { engine: 'codex' },
      { engine: 'cursor' },
      { engine: 'cursor' },
      { engine: 'opencode' },
      // Kilo IS poolable: `kilo run` takes its prompt on stdin and ends at EOF, so a worker can be warmed
      // before the prompt exists — the property hermes and devin lack.
      { engine: 'kilo' },
      { engine: 'pi' },
      { engine: 'commandcode' },
      { engine: 'hermes' }, // not poolable (prompt is argv) — must NOT be counted
      { engine: 'devin' },  // likewise: piping a prompt to `devin -p` panics the CLI
    ])

    expect(mocks.setCounts).toHaveBeenCalledWith({ claude: 1, codex: 1, cursor: 2, opencode: 1, kilo: 1, pi: 1, commandcode: 1 })
  })
})

describe('Grok recap', () => {
  it('uses an isolated direct Grok one-shot with the configured model', async () => {
    mocks.runGrok.mockResolvedValue({
      text: 'Grok recap works.\n\nThe Grok turn now produces a persisted device recap.',
      sessionId: 'grok-recap-session',
    })

    await expect(summarizeTurnText(
      'Implemented Grok recap support.',
      undefined,
      'Does Grok recap work?',
      'grok',
    )).resolves.toBe('Grok recap works.\n\nThe Grok turn now produces a persisted device recap.')

    expect(mocks.runGrok).toHaveBeenCalledOnce()
    expect(mocks.runGrok.mock.calls[0][0]).toMatchObject({ model: 'grok-4.5', effort: 'low' })
    expect(mocks.runClaude).not.toHaveBeenCalled()
    expect(mocks.runCodex).not.toHaveBeenCalled()
    expect(mocks.runCursor).not.toHaveBeenCalled()
  })
})

describe('language fidelity', () => {
  const VI_SOURCE = 'Đội tuyển Việt Nam đã thắng trận chung kết với tỉ số hai một trước Thái Lan tối qua tại sân Mỹ Đình.'
  const VI_ASK = 'Trận đấu tối qua kết quả thế nào?'

  it('retries when the recap comes back in another language than the source', async () => {
    // The old check only fired for "should be English, came back Vietnamese"; this is the reverse, which
    // is what users actually hit — talking Vietnamese and getting an English recap.
    mocks.runClaude
      .mockResolvedValueOnce({ text: 'Vietnam won the final two one.\n\nVietnam beat Thailand two one last night.', sessionId: 's1' })
      .mockResolvedValueOnce({ text: 'Việt Nam thắng chung kết 2-1.\n\nViệt Nam hạ Thái Lan 2-1 tối qua tại Mỹ Đình.', sessionId: 's2' })

    const out = await summarizeTurnText(VI_SOURCE, undefined, VI_ASK, 'claude')

    expect(mocks.runClaude).toHaveBeenCalledTimes(2)
    expect(mocks.runClaude.mock.calls[1][0].prompt).toContain('RETRY')
    expect(out).toContain('Việt Nam thắng chung kết')
  })

  it('does not retry when the recap keeps the source language', async () => {
    mocks.runClaude.mockResolvedValue({
      text: 'Việt Nam thắng chung kết 2-1.\n\nViệt Nam hạ Thái Lan 2-1 tối qua tại sân Mỹ Đình.',
      sessionId: 's1',
    })

    await summarizeTurnText(VI_SOURCE, undefined, VI_ASK, 'claude')
    expect(mocks.runClaude).toHaveBeenCalledOnce()
  })

  it('does not retry an English turn answered in English', async () => {
    mocks.runClaude.mockResolvedValue({
      text: 'Vietnam won the final two one.\n\nVietnam beat Thailand two one last night at My Dinh stadium.',
      sessionId: 's1',
    })

    await summarizeTurnText(
      'Vietnam won the final against Thailand two one last night at the My Dinh stadium.',
      undefined,
      'How did the match go last night?',
      'claude',
    )
    expect(mocks.runClaude).toHaveBeenCalledOnce()
  })

  it('tolerates a technical term in another script inside a matching recap', async () => {
    // A quoted identifier or product name must not read as a language switch.
    mocks.runClaude.mockResolvedValue({
      text: 'Đã sửa lỗi ở hàm parseConfig.\n\nMình đã sửa hàm parseConfig trong module loader và thêm kiểm tra đầu vào.',
      sessionId: 's1',
    })

    await summarizeTurnText(
      'Mình đã sửa hàm parseConfig trong module loader và thêm kiểm tra đầu vào cho tham số.',
      undefined,
      'Sửa xong chưa?',
      'claude',
    )
    expect(mocks.runClaude).toHaveBeenCalledOnce()
  })
})

describe('summary completeness', () => {
  it('strips any ellipsis and ends the summary on a finished sentence', async () => {
    const longBody = Array.from({ length: 60 }, (_, i) => `detail number ${i} here.`).join(' ')
    mocks.runClaude.mockResolvedValue({
      text: `Work is done.\n\n${longBody} and then it trails off…`,
      sessionId: 's1',
    })

    const out = await summarizeTurnText('A long English message about the work.', undefined, 'Status?', 'claude')
    const body = out!.split('\n\n')[1]

    expect(body).not.toContain('…')
    expect(body).not.toMatch(/\.\.\./)
    expect(body).toMatch(/[.!?]$/)
  })

  it('keeps a summary that is already within budget untouched', async () => {
    mocks.runClaude.mockResolvedValue({ text: 'All good.\n\nThe deploy finished and the service is healthy.', sessionId: 's1' })
    const out = await summarizeTurnText('The deploy finished and the service is healthy.', undefined, 'Done?', 'claude')
    expect(out!.split('\n\n')[1]).toBe('The deploy finished and the service is healthy.')
  })
})
