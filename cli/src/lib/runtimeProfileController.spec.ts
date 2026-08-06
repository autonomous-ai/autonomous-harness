import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import { encodeRuntimeProfile, parseRuntimeProfile, RuntimeProfileManager } from './runtimeProfile.js'
import {
  inspectRuntimePane,
  parseCodexAdvancedRows,
  parseCodexEffortRows,
  parseCodexModelMenuRows,
  parseCodexModelRows,
  parseCursorModelPicker,
  parseCursorParameterRows,
  RuntimeProfileController,
} from './runtimeProfileController.js'

// The id inside a `runtime-v1:` string is the AGENT id ('h1' here) — a client only ever echoes back an id
// the catalog minted, and the catalog is agent-scoped. `setProfile` is still addressed with either id.
function session(engine: 'claude' | 'codex' | 'cursor'): RegisteredSession {
  return {
    sessionId: 's1', engine, launcherId: 'h1', agentId: 'h1', boundAt: 0, transcriptPath: '/tmp/s1.jsonl', projectDir: 'tmp', cwd: '/tmp',
    tmuxPane: '%1', source: null, title: null, model: null,
    cliVersion: engine === 'codex' ? '0.144.5' : engine === 'cursor' ? '2026.07.20-8cc9c0b' : '2.1.212', processIdentity: null,
    registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }
}

describe('runtime pane parsing', () => {
  it('distinguishes dim placeholders from real drafts', () => {
    expect(inspectRuntimePane('codex', '\u001b[1m›\u001b[0m \u001b[2mWrite tests\u001b[0m')).toMatchObject({ idle: true, draft: false })
    expect(inspectRuntimePane('codex', '\u001b[1m›\u001b[0m write tests')).toMatchObject({ idle: false, draft: true })
    expect(inspectRuntimePane('claude', '\u001b[39m❯\u00a0\u001b[2mAsk about the codebase\u001b[0m')).toMatchObject({ idle: true, draft: false })
    expect(inspectRuntimePane('claude', '\u001b[39m❯\u00a0Ask about the codebase')).toMatchObject({ idle: false, draft: true })
    expect(inspectRuntimePane(
      'cursor',
      '\u001b[48;2;21;21;21m \u001b[2m→ \u001b[0;7mP\u001b[0;2mlan, search, build anything\u001b[0m',
    )).toMatchObject({ idle: true, draft: false })
  })

  it('reads devin and pi panes, whose composers look nothing like the others', () => {
    // Devin's marker is ❭ (U+276D), not claude's ❯ (U+276F) — reading it as claude's found no prompt at
    // all, and a pane with no prompt is never idle, so every switch would have been refused as BUSY.
    const devinPane = (composer: string) => [
      composer,
      '────────────────────────────',
      'SWE-1.6 Slow                       See all keyboard shortcuts: /shortcuts',
    ].join('\n')
    // Devin dims its placeholder the way claude does, so the same SGR rule separates it from a draft.
    expect(inspectRuntimePane('devin', devinPane('\u001b[39m❭ \u001b[2mAsk Devin to build features\u001b[0m')))
      .toMatchObject({ idle: true, draft: false })
    expect(inspectRuntimePane('devin', devinPane('\u001b[39m❭ fix the parser')))
      .toMatchObject({ idle: false, draft: true })

    // Pi draws no marker: its composer is the band between the last two rules, and the footer only
    // exists in the normal view.
    const piIdle = [
      '────────────────────────────',
      '',
      '────────────────────────────',
      '/private/tmp/rp-probe/pi',
      '0.0%/500k (auto)                          minimax/minimax-m3 • high',
    ].join('\n')
    expect(inspectRuntimePane('pi', piIdle)).toMatchObject({ idle: true, draft: false, dialog: false })
    expect(inspectRuntimePane('pi', piIdle.replace('\n\n', '\n/model something\n')))
      .toMatchObject({ idle: false, draft: true })
    expect(inspectRuntimePane('pi', [
      'Thinking Level',
      'Select reasoning depth for thinking-capable models',
      '→ medium      Moderate reasoning (~8k tokens)',
      '  Enter to select · Esc to go back',
    ].join('\n'))).toMatchObject({ idle: false, dialog: true })
  })

  it('ignores picker and Plan mode text left above the latest prompt', () => {
    const capture = 'Select Model and Effort\nPlan mode\n› old\ncompleted\n› \ngpt-5.6-sol high ·'
    expect(inspectRuntimePane('codex', capture)).toMatchObject({ idle: true, dialog: false, plan: false })
  })

  it('parses the version-gated Codex picker rows', () => {
    const menu = parseCodexModelMenuRows([
      'Select Model',
      'Pick a quick auto mode or browse all models.',
      '  1. codex-auto-review     Balanced agentic coding model for everyday work.',
      '› 2. All models (current)  Choose a specific model and reasoning level',
    ].join('\n'))
    expect(menu?.quickModels.get('codex-auto-review')).toBe('1')
    expect(menu?.allModelsRow).toBe('2')

    const models = parseCodexModelRows('Select Model and Effort\n  1. gpt-5.6-sol (default)          Latest frontier model.\n  2. gpt-5.6-terra\n› 3. gpt-5.6-luna (current)  Fast model.')
    expect(models?.get('gpt-5.6-sol')).toBe('1')
    expect(models?.get('gpt-5.6-terra')).toBe('2')
    expect(models?.get('gpt-5.6-luna')).toBe('3')
    const efforts = parseCodexEffortRows('Select Reasoning Level for gpt-5.6-sol\n  1. Low\n  2. High (default)\n  3. Extra high\n  4. More reasoning options')
    expect(efforts?.efforts.get('xhigh')).toBe('3')
    expect(efforts?.defaultRow).toBe('2')
    expect(efforts?.advancedRow).toBe('4')
    const advanced = parseCodexAdvancedRows('Advanced Reasoning\n› 1. Max (current)  Higher usage\n  2. Ultra          Highest usage')
    expect(advanced?.get('max')).toBe('1')
    expect(advanced?.get('ultra')).toBe('2')
  })

  it('treats both Codex model picker generations as active dialogs', () => {
    expect(inspectRuntimePane(
      'codex',
      'Select Model\nPick a quick auto mode or browse all models.\n› 2. All models (current)',
    )).toMatchObject({ idle: false, dialog: true })
    expect(inspectRuntimePane(
      'codex',
      'Select Model and Effort\n› 1. gpt-5.6-sol (current)',
    )).toMatchObject({ idle: false, dialog: true })
  })

  it('does not reuse picker rows left before a newer composer prompt', () => {
    const stale = 'Select Model and Effort\n  1. gpt-old\n› 1. gpt-old\n› \ngpt-current high ·'
    expect(parseCodexModelRows(stale)).toBeNull()
  })

  it('parses the gated Cursor picker and parameter rows by meaning', () => {
    const picker = [
      ' Available models                                    Max mode: OFF',
      ' Filter:',
      '    Auto',
      ' →  GPT-5.6 Sol              272K Medium (Tab to modify)',
      ' Type to filter • Enter to select • Tab to edit',
    ].join('\n')
    expect(parseCursorModelPicker(picker)).toEqual({ selectedFamily: 'GPT-5.6 Sol' })

    const parameters = [
      ' GPT-5.6 Sol — Edit Parameters',
      '  Context',
      '  → ● 272K ✓',
      '    ○ 1M',
      '  Reasoning',
      '    ○ None',
      '    ● Medium ✓',
      '    ○ Extra High',
      '    ◯ Fast',
    ].join('\n')
    expect(parseCursorParameterRows(parameters)).toEqual([
      { kind: 'context', value: '272k', selected: true, cursor: true, index: 0 },
      { kind: 'context', value: '1m', selected: false, cursor: false, index: 1 },
      { kind: 'reasoning', value: 'none', selected: false, cursor: false, index: 2 },
      { kind: 'reasoning', value: 'medium', selected: true, cursor: false, index: 3 },
      { kind: 'reasoning', value: 'xhigh', selected: false, cursor: false, index: 4 },
      { kind: 'fast', value: 'true', selected: false, cursor: false, index: 5 },
    ])
  })
})

describe('RuntimeProfileController', () => {
  it('sets Claude model and effort only after transcript confirmations', async () => {
    const value = session('claude')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Sonnet 5 with low effort\n❯ ', true)
    value.cliVersion = null // simulate an old persisted registry entry after manager hydration
    const commands: string[] = []
    const release = vi.fn()
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => 'Opus 4.8 with high effort\n❯ ',
      sendText: async (_pane, command) => {
        commands.push(command)
        if (command.startsWith('/model ')) {
          manager.ingest(value, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Set model to Opus 4.8' }] } }))
        } else {
          manager.ingest(value, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Set effort level to high' }] } }))
        }
        return true
      },
      sendLiteral: async () => true,
      sendKey: async () => true,
      acquireInput: () => release,
    })
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'claude', model: 'opus', effort: 'high' })

    await controller.setProfile('s1', target)

    expect(commands).toEqual(['/model opus', '/effort high'])
    expect(manager.selectedModel(value)).toBe(target)
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not reset unchanged auto effort after switching from Haiku to Sonnet', async () => {
    const value = session('claude')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [JSON.stringify({
      type: 'user', message: { content: '<local-command-stdout>Set model to Haiku 4.5</local-command-stdout>' },
    })])
    expect(manager.selectedModel(value)).toBe(encodeRuntimeProfile({
      sessionId: 'h1', engine: 'claude', model: 'haiku', effort: 'auto',
    }))
    const commands: string[] = []
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => '\u001b[39m\u276f\u00a0\u001b[2mAsk about the codebase\u001b[0m',
      sendText: async (_pane, command) => {
        commands.push(command)
        const output = command.startsWith('/model ')
          ? 'Set model to \u001b[1mSonnet 5\u001b[22m and saved as your default for new sessions'
          : 'Effort level set to auto'
        manager.ingest(value, JSON.stringify({
          type: 'user', message: { content: `<local-command-stdout>${output}</local-command-stdout>` },
        }))
        return true
      },
      sendLiteral: async () => true,
      sendKey: async () => true,
      acquireInput: () => () => undefined,
    })
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'claude', model: 'sonnet', effort: 'auto' })

    await controller.setProfile('s1', target)

    expect(commands).toEqual(['/model sonnet'])
    expect(manager.selectedModel(value)).toBe(target)
  })

  it('sets Claude ultracode effort through its native command value', async () => {
    const value = session('claude')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Sonnet 5 with high effort\n❯ ', true)
    const commands: string[] = []
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => '\u001b[39m\u276f\u00a0\u001b[2mAsk about the codebase\u001b[0m',
      sendText: async (_pane, command) => {
        commands.push(command)
        const output = command.startsWith('/model ')
          ? 'Set model to Sonnet 5 and saved as your default for new sessions'
          : 'Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration'
        manager.ingest(value, JSON.stringify({
          type: 'user', message: { content: `<local-command-stdout>${output}</local-command-stdout>` },
        }))
        return true
      },
      sendLiteral: async () => true,
      sendKey: async () => true,
      acquireInput: () => () => undefined,
    })
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'claude', model: 'sonnet', effort: 'ultracode' })

    await controller.setProfile('s1', target)

    expect(commands).toEqual(['/effort ultracode'])
    expect(manager.selectedModel(value)).toBe(target)
  })

  it('does not touch tmux when the requested profile is already current', async () => {
    const value = session('claude')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [])
    manager.ingestPane(value, 'Sonnet 5 with high effort\n❯ ', true)
    const validateRuntime = vi.fn(async () => true)
    const sendText = vi.fn(async () => true)
    const acquireInput = vi.fn(() => () => undefined)
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime,
      capture: async () => '\u001b[39m\u276f\u00a0\u001b[2mAsk about the codebase\u001b[0m',
      sendText,
      sendLiteral: async () => true,
      sendKey: async () => true,
      acquireInput,
    })
    const current = encodeRuntimeProfile({ sessionId: 'h1', engine: 'claude', model: 'sonnet', effort: 'high' })

    await controller.setProfile('s1', current)

    expect(validateRuntime).not.toHaveBeenCalled()
    expect(acquireInput).not.toHaveBeenCalled()
    expect(sendText).not.toHaveBeenCalled()
  })

  it('rejects remote Codex changes while the native session is in Plan mode', async () => {
    const value = session('codex')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [JSON.stringify({
      type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'high', collaboration_mode: { mode: 'plan' } },
    })])
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-5.6-sol', effort: 'low' })
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'GPT-5.6-Sol / Low' }])
    const controller = new RuntimeProfileController({
      manager, getSession: () => value, validateRuntime: async () => true,
      capture: async () => '› \ngpt-5.6-sol high ·', sendText: vi.fn(), sendLiteral: vi.fn(), sendKey: vi.fn(), acquireInput: vi.fn(),
    })

    await expect(controller.setProfile('s1', target)).rejects.toMatchObject({ code: 'PLAN_SCOPE_AMBIGUOUS' })
  })

  it('selects Codex Ultra through the Advanced Reasoning submenu', async () => {
    const value = session('codex')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [JSON.stringify({
      type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
    })])
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' })
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'GPT-5.6-Sol / Ultra' }])
    let phase: 'idle' | 'models' | 'efforts' | 'advanced' = 'idle'
    const keys: string[] = []
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => {
        if (phase === 'models') return 'Select Model and Effort\n  1. gpt-5.6-sol (current)'
        if (phase === 'efforts') return 'Select Reasoning Level for gpt-5.6-sol\n  5. More reasoning options'
        if (phase === 'advanced') return 'Advanced Reasoning\n  1. Max\n  2. Ultra'
        return '› \ngpt-5.6-sol high ·'
      },
      sendText: async () => { phase = 'models'; return true },
      sendLiteral: async () => true,
      sendKey: async (_pane, key) => {
        keys.push(key)
        if (phase === 'models' && key === '1') phase = 'efforts'
        else if (phase === 'efforts' && key === '5') phase = 'advanced'
        else if (phase === 'advanced' && key === '2') {
          phase = 'idle'
          manager.ingest(value, JSON.stringify({
            type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'ultra' },
          }))
        }
        return true
      },
      acquireInput: () => () => undefined,
    })

    await controller.setProfile('s1', target)

    expect(keys).toEqual(['1', '5', '2'])
    expect(manager.selectedModel(value)).toBe(target)
  })

  it('selects an explicit Codex model through the 0.145 All models pre-menu', async () => {
    const value = session('codex')
    value.cliVersion = '0.145.0'
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [JSON.stringify({
      type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
    })])
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'gpt-5.6-terra', effort: 'low' })
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'GPT-5.6-Terra / Low' }])
    let phase: 'idle' | 'menu' | 'models' | 'efforts' = 'idle'
    const keys: string[] = []
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => {
        if (phase === 'menu') {
          return 'Select Model\nPick a quick auto mode or browse all models.\n  1. codex-auto-review\n› 2. All models (current)'
        }
        if (phase === 'models') {
          return 'Select Model and Effort\n  1. gpt-5.6-sol (current)\n  2. gpt-5.6-terra'
        }
        if (phase === 'efforts') return 'Select Reasoning Level for gpt-5.6-terra\n  1. Low\n  2. High (default)'
        return '› \ngpt-5.6-sol high ·'
      },
      sendText: async () => { phase = 'menu'; return true },
      sendLiteral: async () => true,
      sendKey: async (_pane, key) => {
        keys.push(key)
        if (phase === 'menu' && key === '2') phase = 'models'
        else if (phase === 'models' && key === '2') phase = 'efforts'
        else if (phase === 'efforts' && key === '1') {
          phase = 'idle'
          manager.ingest(value, JSON.stringify({
            type: 'turn_context', payload: { model: 'gpt-5.6-terra', reasoning_effort: 'low' },
          }))
        }
        return true
      },
      acquireInput: () => () => undefined,
    })

    await controller.setProfile('s1', target)

    expect(keys).toEqual(['2', '2', '1'])
    expect(manager.selectedModel(value)).toBe(target)
  })

  it('selects a Codex quick profile directly from the 0.145 pre-menu', async () => {
    const value = session('codex')
    value.cliVersion = '0.145.0'
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [JSON.stringify({
      type: 'turn_context', payload: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
    })])
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'codex', model: 'codex-auto-review', effort: 'high' })
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'GPT-5.6-Terra / High' }])
    let phase: 'idle' | 'menu' | 'efforts' = 'idle'
    const keys: string[] = []
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => {
        if (phase === 'menu') {
          return 'Select Model\nPick a quick auto mode or browse all models.\n  1. codex-auto-review\n› 2. All models (current)'
        }
        if (phase === 'efforts') {
          return 'Select Reasoning Level for codex-auto-review\n  1. Low\n  2. Medium (default)\n  3. High'
        }
        return '› \ngpt-5.6-sol high ·'
      },
      sendText: async () => { phase = 'menu'; return true },
      sendLiteral: async () => true,
      sendKey: async (_pane, key) => {
        keys.push(key)
        if (phase === 'menu' && key === '1') phase = 'efforts'
        else if (phase === 'efforts' && key === '3') {
          phase = 'idle'
          manager.ingest(value, JSON.stringify({
            type: 'turn_context', payload: { model: 'codex-auto-review', reasoning_effort: 'high' },
          }))
        }
        return true
      },
      acquireInput: () => () => undefined,
    })

    await controller.setProfile('s1', target)

    expect(keys).toEqual(['1', '3'])
    expect(manager.selectedModel(value)).toBe(target)
  })

  it('refuses to drive an engine the owner made view-only', async () => {
    // Switching is Claude and Codex only (owner, 2026-07-31). This replaces two tests that drove Cursor's
    // picker end to end: setCursor and the other per-engine drivers are still in the code, deliberately —
    // this policy has already flipped twice — but nothing can reach them while the gate is shut, so what
    // is worth asserting now is the refusal, and that it costs the user's pane nothing.
    const value = session('cursor')
    const manager = new RuntimeProfileManager()
    manager.hydrate(value, [])
    const target = encodeRuntimeProfile({ sessionId: 'h1', engine: 'cursor', model: 'claude-4.5-sonnet', effort: 'auto' })
    vi.spyOn(manager, 'modelsForSession').mockResolvedValue([{ id: target, displayName: 'Sonnet 4.5 / Auto' }])
    const sendKey = vi.fn().mockResolvedValue(true)
    const sendText = vi.fn().mockResolvedValue(true)
    const controller = new RuntimeProfileController({
      manager,
      getSession: () => value,
      validateRuntime: async () => true,
      capture: async () => '→ Add a follow-up',
      sendText,
      sendKey,
      sendLiteral: vi.fn().mockResolvedValue(true),
      acquireInput: () => () => undefined,
    })

    await expect(controller.setProfile('s1', target)).rejects.toMatchObject({ code: 'UNSUPPORTED_CLI_VERSION' })
    expect(sendKey).not.toHaveBeenCalled()
    expect(sendText).not.toHaveBeenCalled()
  })
})
