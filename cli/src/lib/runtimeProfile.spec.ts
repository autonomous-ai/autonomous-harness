import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RegisteredSession } from './registry.js'
import {
  codexEffortAllowed,
  encodeRuntimeProfile,
  parseRuntimeProfile,
  parseCursorModelsOutput,
  RuntimeProfileManager,
  supportsNativeRuntimeControl,
} from './runtimeProfile.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function session(engine: 'claude' | 'codex' | 'cursor'): RegisteredSession {
  return {
    sessionId: 'session:1', engine, launcherId: 'h1', agentId: 'h1', boundAt: 0, transcriptPath: '/tmp/session.jsonl', projectDir: 'tmp', cwd: '/tmp',
    tmuxPane: '%1', source: null, title: null, model: null,
    cliVersion: engine === 'codex' ? '0.144.5' : engine === 'cursor' ? '2026.07.20-8cc9c0b' : '2.1.212', processIdentity: null,
    registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }
}

describe('RuntimeProfileManager', () => {
  it('limits Codex Max and Ultra to GPT-5.6 models', () => {
    expect(codexEffortAllowed('gpt-5.6-sol', 'max')).toBe(true)
    expect(codexEffortAllowed('gpt-5.6-terra', 'ultra')).toBe(true)
    expect(codexEffortAllowed('codex-auto-review', 'ultra')).toBe(true)
    expect(codexEffortAllowed('gpt-5.5', 'max')).toBe(false)
    expect(codexEffortAllowed('gpt-5.3-codex-spark', 'ultra')).toBe(false)
    expect(codexEffortAllowed('gpt-5.4', 'xhigh')).toBe(true)
  })

  it('round trips opaque session-scoped profiles', () => {
    const id = encodeRuntimeProfile({ sessionId: 'session:1', engine: 'codex', model: 'provider/model:v2', effort: 'xhigh' })
    expect(parseRuntimeProfile(id)).toEqual({
      id, sessionId: 'session:1', engine: 'codex', model: 'provider/model:v2', effort: 'xhigh',
    })
    expect(parseRuntimeProfile('runtime-v1:session%3A1:codex:gpt-5.6-sol@ultra')).toMatchObject({
      sessionId: 'session:1', engine: 'codex', model: 'gpt-5.6-sol', effort: 'ultra',
    })
    expect(parseRuntimeProfile('runtime-v1:%ZZ:codex:model@high')).toBeNull()

    // Every engine that can produce options must also parse them back. Widening the picker to a new
    // engine and forgetting this line is silent: the id round-trips through web and device fine, then
    // setProfile rejects it as INVALID_RUNTIME_PROFILE the moment someone picks a row.
    for (const engine of ['claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes', 'commandcode', 'devin', 'muse']) {
      expect(parseRuntimeProfile(`runtime-v1:s1:${engine}:some-model@high`)).toMatchObject({ engine })
    }
    expect(parseRuntimeProfile('runtime-v1:cursor-1:cursor:gpt-5.6-sol@none')).toMatchObject({
      engine: 'cursor', effort: 'none',
    })
  })

  it('parses Cursor catalog variants without hardcoding the account model list', () => {
    const entries = parseCursorModelsOutput([
      'Available models',
      '',
      'auto - Auto (current, default)',
      'gpt-5.6-sol-none - GPT-5.6 Sol 1M None',
      'gpt-5.6-sol-extra-high-fast - GPT-5.6 Sol Extra High Fast',
      'claude-opus-4-8-thinking-high - Opus 4.8 1M Thinking',
      'gpt-5.3-codex-low - Codex 5.3 Low',
      'gpt-5.3-codex - Codex 5.3',
      'Tip: ignored',
    ].join('\n'))

    expect(entries.map((entry) => ({
      rawId: entry.target.rawId,
      model: entry.target.modelKey,
      effort: entry.effort,
      context: entry.target.context,
      fast: entry.target.fast,
      thinking: entry.target.thinking,
    }))).toEqual([
      { rawId: 'auto', model: 'auto', effort: 'auto', context: null, fast: null, thinking: null },
      { rawId: 'gpt-5.6-sol-none', model: 'gpt-5.6-sol', effort: 'none', context: '1m', fast: false, thinking: false },
      { rawId: 'gpt-5.6-sol-extra-high-fast', model: 'gpt-5.6-sol-fast', effort: 'xhigh', context: null, fast: true, thinking: false },
      { rawId: 'claude-opus-4-8-thinking-high', model: 'claude-opus-4-8-thinking', effort: 'high', context: '1m', fast: false, thinking: true },
      { rawId: 'gpt-5.3-codex-low', model: 'gpt-5.3-codex', effort: 'low', context: null, fast: false, thinking: false },
      { rawId: 'gpt-5.3-codex', model: 'gpt-5.3-codex', effort: 'medium', context: null, fast: false, thinking: false },
    ])
  })

  it('offers no switching outside Claude and Codex', async () => {
    // View-only engines still SHOW what they run (the ingest paths do that); they just have nothing to
    // pick and nothing to drive. Both gates are asserted: an empty catalogue, and a refusal to control.
    const manager = new RuntimeProfileManager()
    for (const engine of ['cursor', 'commandcode', 'devin', 'pi', 'opencode', 'hermes'] as const) {
      const value = { ...session('cursor'), engine }
      expect(supportsNativeRuntimeControl(value)).toBe(false)
      await expect(manager.modelsForSession(value)).resolves.toEqual([])
    }
  })

  it('supports both captured Codex picker generations', () => {
    const value = session('codex')
    expect(supportsNativeRuntimeControl(value)).toBe(true)
    value.cliVersion = '0.145.0'
    expect(supportsNativeRuntimeControl(value)).toBe(true)
    value.cliVersion = '0.146.0'
    expect(supportsNativeRuntimeControl(value)).toBe(false)
  })

  it('surfaces a Cursor model from the transcript even before any effort is known', () => {
    // Regression: selectedModel() returns null unless BOTH axes are known, and Cursor's transcript
    // reports the model while the reasoning level exists only in the pane footer. The model was
    // therefore discarded whenever the footer had not been read yet, and the device showed no model
    // at all for a Cursor agent.
    const manager = new RuntimeProfileManager()
    const value = session('cursor')
    manager.hydrate(value, [])

    manager.ingest(value, JSON.stringify({ model: 'gpt-5.6-sol' }))

    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      engine: 'cursor',
      model: 'gpt-5.6-sol',
      effort: 'auto',
    })
  })

  it('observes Cursor Auto model and effort from the idle footer with context usage', () => {
    const manager = new RuntimeProfileManager()
    const value = session('cursor')
    manager.hydrate(value, [])

    manager.ingestPane(value, [
      'previous output',
      '→ Add a follow-up',
      '',
      'Auto · 12.7%                                                           Run Everything',
      '~/demo · main',
    ].join('\n'))

    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'auto',
      effort: 'auto',
    })
  })

  it('observes Cursor native-default models from usage and No Thinking footers', () => {
    const manager = new RuntimeProfileManager()
    const value = session('cursor')
    manager.hydrate(value, [])

    manager.ingestPane(value, [
      '→ Add a follow-up',
      '',
      'Haiku 4.5 · 12.8%                                             Run Everything',
      '~/demo · main',
    ].join('\n'))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'haiku-4.5',
      effort: 'auto',
    })

    manager.ingestPane(value, '→ Add a follow-up\nSonnet 4.5 No Thinking')
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'sonnet-4.5',
      effort: 'auto',
    })
  })

  it('keeps synthetic Cursor routing details out of the public runtime profile', () => {
    const manager = new RuntimeProfileManager()
    const value = session('cursor')
    manager.hydrate(value, [])

    manager.ingestPane(value, [
      '→ Add a follow-up',
      '',
      'Composer 2.5 · 15.7%                                             Run Everything',
      '~/demo · main',
    ].join('\n'))

    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'composer-2.5',
      effort: 'auto',
    })

    manager.ingestPane(value, '→ Add a follow-up\nComposer 2.5 1M Thinking Fast High')
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'composer-2.5-1m-thinking-fast',
      effort: 'high',
    })
  })

  it('observes Claude model from JSONL and effort from the live pane', () => {
    const manager = new RuntimeProfileManager()
    const value = session('claude')
    manager.hydrate(value, [JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8' } })])
    expect(manager.selectedModel(value)).toBeNull()

    manager.ingestPane(value, 'Opus 4.8 (1M context) with high effort\n❯ ')
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({
      model: 'opus', effort: 'high',
    })
  })

  it('hydrates Claude effort from effective settings and backfills the transcript CLI version', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'machine-runtime-'))
    cleanup.push(cwd)
    await mkdir(join(cwd, '.claude'))
    await writeFile(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ effortLevel: 'low' }))
    const manager = new RuntimeProfileManager()
    const value = { ...session('claude'), cwd, cliVersion: null }
    manager.hydrate(value, [JSON.stringify({
      type: 'assistant', version: '2.1.212', message: { model: 'claude-opus-4-8' },
    })])

    await manager.ingestConfig(value, true)

    expect(value.cliVersion).toBe('2.1.212')
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'opus', effort: 'low' })
  })

  it('keeps supported Claude effort on a local model change and falls back to auto otherwise', () => {
    const manager = new RuntimeProfileManager()
    const value = session('claude')
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Opus 4.8 with high effort\n❯ ', true)

    manager.ingest(value, JSON.stringify({ message: { content: [{ text: 'Set model to Sonnet 5' }] } }))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'sonnet', effort: 'high' })

    manager.ingest(value, JSON.stringify({ message: { content: [{ text: 'Set model to Haiku 4.5' }] } }))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'haiku', effort: 'auto' })
  })

  // Opus 5 shipped as a new family version AND as a 1M-context variant. Both had to stop resetting the
  // observed effort: the effort table used to hardcode `opus-4-[78]` and never stripped the `[1m]` suffix,
  // so `Opus 5 (1M context)` — and even `Opus 4.8 (1M context)` — looked effort-less and fell back to auto.
  it('keeps Claude effort across a switch to a new family version and to a 1M-context variant', () => {
    for (const setModel of ['Opus 5', 'Opus 5 (1M context)', 'Opus 4.8 (1M context)', 'Fable 5 (1M context)']) {
      const manager = new RuntimeProfileManager()
      const value = session('claude')
      manager.hydrate(value, [])
      manager.ingestPane(value, 'Opus 4.8 with high effort\n❯ ', true)

      manager.ingest(value, JSON.stringify({ message: { content: [{ text: `Set model to ${setModel}` }] } }))
      expect(parseRuntimeProfile(manager.selectedModel(value))?.effort, setModel).toBe('high')
    }
  })

  it('observes an Opus 5 pane status line (model + effort)', () => {
    const manager = new RuntimeProfileManager()
    const value = session('claude')
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Opus 5 (1M context) with high effort\n❯ ')
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'opus', effort: 'high' })
  })

  it('publishes Claude aliases in native picker order without provider-model duplicates', async () => {
    const manager = new RuntimeProfileManager()
    const value = session('claude')
    manager.hydrate(value, [JSON.stringify({
      type: 'assistant', message: { model: 'claude-opus-4-8' },
    })])
    manager.ingestPane(value, 'Opus 4.8 with high effort\n❯ ', true)

    const profiles = (await manager.modelsForSession(value))
      .map((option) => parseRuntimeProfile(option.id))
      .filter((profile): profile is NonNullable<typeof profile> => profile !== null)
    expect([...new Set(profiles.map((profile) => profile.model))]).toEqual([
      'default', 'opus', 'fable', 'sonnet', 'haiku',
    ])
    expect(profiles.filter((profile) => profile.model === 'sonnet').map((profile) => profile.effort)).toContain('ultracode')
    expect(profiles.filter((profile) => profile.model === 'haiku').map((profile) => profile.effort)).toEqual(['auto'])
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'opus' })

    value.cliVersion = '2.1.208'
    const olderProfiles = (await manager.modelsForSession(value))
      .map((option) => parseRuntimeProfile(option.id))
      .filter((profile): profile is NonNullable<typeof profile> => profile !== null)
    expect(olderProfiles.map((profile) => profile.effort)).not.toContain('ultracode')
  })

  it('observes Claude ultracode effort from JSONL and the live footer', () => {
    const manager = new RuntimeProfileManager()
    const value = session('claude')
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Opus 4.8 with high effort\n❯ ', true)

    manager.ingest(value, JSON.stringify({
      type: 'user', message: { content: '<local-command-stdout>Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration</local-command-stdout>' },
    }))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'opus', effort: 'ultracode' })

    manager.confirmEffort(value.sessionId, 'auto')
    manager.ingestPane(value, 'old output\n──────────────── ultracode ─\n❯\n────────────────', true)
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'opus', effort: 'ultracode' })
  })

  it('observes Codex model, effort, and plan mode from rollout settings', () => {
    const manager = new RuntimeProfileManager()
    const value = session('codex')
    manager.hydrate(value, [JSON.stringify({ type: 'session_meta', payload: { cli_version: '0.144.5' } })])
    manager.ingest(value, JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-5.6-sol', reasoning_effort: 'high', collaboration_mode: { mode: 'plan' } },
      },
    }))

    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high' })
    expect(manager.getState(value.sessionId).mode).toBe('plan')
    expect(value.cliVersion).toBe('0.144.5')
  })

  it('observes Codex ultra effort from rollout and pane state', () => {
    const manager = new RuntimeProfileManager()
    const value = session('codex')
    manager.hydrate(value, [])
    manager.ingest(value, JSON.stringify({
      type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'ultra' },
    }))
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ effort: 'ultra' })

    manager.ingestPane(value, '› \ngpt-5.6-sol ultra ·', true)
    expect(parseRuntimeProfile(manager.selectedModel(value))).toMatchObject({ effort: 'ultra' })
  })
})
