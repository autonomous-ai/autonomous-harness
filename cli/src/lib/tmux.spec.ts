import { describe, expect, it } from 'vitest'
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import { engineProcessMatchScore, parseProcessRow, resumeSessionId } from './tmux.js'

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
})
