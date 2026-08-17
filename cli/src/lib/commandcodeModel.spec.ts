import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RegisteredSession } from './registry.js'

/**
 * Command Code agents were DISPLAY-ONLY between 2026-07-30 and CLI 1.6.0: switching had been built and
 * reverted because the /model dialog ignored typed input, so it could only be arrow-driven, and a 49-row
 * picker stalled the device's the device UI task into a watchdog reset. 1.6.0 added `--list-models` and gave
 * `/model` and `/effort` arguments, so the picker is back — behind a version gate, and with the chip
 * still required to name what the agent is actually running: model AND reasoning level.
 */
let commandcodeHome = ''

async function loadRuntimeProfile() {
  vi.resetModules()
  process.env.COMMANDCODE_HOME = commandcodeHome
  return import('./runtimeProfile.js')
}

const session = (): RegisteredSession => ({
  schemaVersion: 2,
  active: true,
  sessionId: 'session:1',
  engine: 'commandcode',
  launcherId: 'h1',
  agentId: 'h1',
  boundAt: 0,
  transcriptPath: '/tmp/session.jsonl',
  projectDir: 'tmp',
  cwd: '/tmp',
  tmuxPane: '%1',
  runtimes: [{ backend: 'tmux', paneId: '%1' }],
  primaryRuntimeKey: 'tmux\u0000%1',
  source: null,
  title: null,
  model: null,
  cliVersion: null,
  processIdentity: null,
  registeredAt: 1,
  updatedAt: 1,
  lastHookAt: 1,
  lastTranscriptAt: 1,
})

/** An assistant line as Command Code writes it: the model is top level, as a full gateway id. */
const assistantLine = (model: string): string =>
  JSON.stringify({ type: 'message', model, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })

/** Its global config — the ONLY place the reasoning level is recorded, keyed by full id. */
const writeConfig = (config: unknown): void =>
  writeFileSync(join(commandcodeHome, 'config.json'), JSON.stringify(config))

describe('a Command Code agent', () => {
  beforeEach(() => {
    commandcodeHome = mkdtempSync(join(tmpdir(), 'adapter-commandcode-'))
  })

  afterEach(() => {
    rmSync(commandcodeHome, { recursive: true, force: true })
  })

  it('shows the running model and its configured reasoning level', async () => {
    const { parseRuntimeProfile, RuntimeProfileManager } = await loadRuntimeProfile()
    writeConfig({
      model: 'deepseek/deepseek-v4-flash',
      reasoningEffort: { 'deepseek/deepseek-v4-flash': 'high' },
    })
    const manager = new RuntimeProfileManager()
    const target = session()
    manager.ingest(target, assistantLine('deepseek/deepseek-v4-flash'))
    await manager.ingestConfig(target, true)

    const profile = parseRuntimeProfile(manager.selectedModel(target))
    // Short name, not "deepseek/deepseek-v4-flash": the device labels by splitting on -/_ and never "/",
    // so a vendor prefix reads as "Deepseek/deepseek V4 Flash" on the round screen.
    expect(profile?.model).toBe('deepseek-v4-flash')
    expect(profile?.effort).toBe('high')
  })

  it('keeps the level after the next assistant line', async () => {
    // Regression: the transcript path used to stamp effort='auto' on every line, wiping the configured
    // level a second after it was read, so the chip flipped back to Auto on the next reply.
    const { parseRuntimeProfile, RuntimeProfileManager } = await loadRuntimeProfile()
    writeConfig({ model: 'x/y', reasoningEffort: { 'moonshotai/kimi-k3': 'medium' } })
    const manager = new RuntimeProfileManager()
    const target = session()
    manager.ingest(target, assistantLine('moonshotai/kimi-k3'))
    await manager.ingestConfig(target, true)
    manager.ingest(target, assistantLine('moonshotai/kimi-k3'))

    expect(parseRuntimeProfile(manager.selectedModel(target))?.effort).toBe('medium')
  })

  it('falls back to Auto when the model has no level set', async () => {
    const { parseRuntimeProfile, RuntimeProfileManager } = await loadRuntimeProfile()
    writeConfig({ model: 'deepseek/deepseek-v4-flash', reasoningEffort: { 'qwen/qwen3.7-plus': 'low' } })
    const manager = new RuntimeProfileManager()
    const target = session()
    manager.ingest(target, assistantLine('deepseek/deepseek-v4-flash'))
    await manager.ingestConfig(target, true)

    expect(parseRuntimeProfile(manager.selectedModel(target))?.effort).toBe('auto')
  })

  it('names the config model before the agent has answered once', async () => {
    const { parseRuntimeProfile, RuntimeProfileManager } = await loadRuntimeProfile()
    writeConfig({ model: 'moonshotai/kimi-k3', reasoningEffort: {} })
    const manager = new RuntimeProfileManager()
    const target = session()
    await manager.ingestConfig(target, true)

    // A fresh agent has no transcript line to read; the config's model is what it will run.
    expect(parseRuntimeProfile(manager.selectedModel(target))?.model).toBe('kimi-k3')
  })

  it('re-reads the level when the model changes', async () => {
    // The level is stored PER MODEL. Switching to a model with no level of its own kept showing the
    // previous model's — the chip read "Kimi K3 · High" when Kimi K3 has no level set at all.
    const { parseRuntimeProfile, RuntimeProfileManager } = await loadRuntimeProfile()
    writeConfig({ model: 'deepseek/deepseek-v4-flash', reasoningEffort: { 'deepseek/deepseek-v4-flash': 'high' } })
    const manager = new RuntimeProfileManager()
    const target = session()
    manager.ingest(target, assistantLine('deepseek/deepseek-v4-flash'))
    await manager.ingestConfig(target, true)
    expect(parseRuntimeProfile(manager.selectedModel(target))?.effort).toBe('high')

    manager.ingest(target, assistantLine('moonshotai/kimi-k3'))
    await new Promise((resolve) => setTimeout(resolve, 20))   // the re-read ingest() fires is async
    const profile = parseRuntimeProfile(manager.selectedModel(target))
    expect(profile?.model).toBe('kimi-k3')
    expect(profile?.effort).toBe('auto')
  })

  it('offers nothing to pick when the catalogue cannot be read', async () => {
    // Deliberately hide the CLI: a catalogue that cannot be read must leave the device with nothing to
    // open rather than a half-list — and this test must not depend on what is installed on the computer.
    const realPath = process.env.PATH
    process.env.PATH = commandcodeHome
    try {
      const { RuntimeProfileManager } = await loadRuntimeProfile()
      const manager = new RuntimeProfileManager()
      const target = session()
      manager.ingest(target, assistantLine('moonshotai/kimi-k3'))
      await expect(manager.modelsForSession(target)).resolves.toEqual([])
    } finally {
      process.env.PATH = realPath
    }
  })

  it('is never switchable, whatever the CLI version says', async () => {
    // Switching is Claude and Codex only (owner, 2026-07-31). 1.6.0 does take `/model` as a plain command,
    // so the driver would work — the gate is policy, not capability, which is why version is irrelevant.
    const { supportsNativeRuntimeControl } = await loadRuntimeProfile()
    expect(supportsNativeRuntimeControl({ ...session(), cliVersion: '1.6.0' })).toBe(false)
    expect(supportsNativeRuntimeControl({ ...session(), cliVersion: '1.5.0' })).toBe(false)
    expect(supportsNativeRuntimeControl({ ...session(), cliVersion: null })).toBe(false)
  })

  it('keeps the transcript schema version out of the CLI version', async () => {
    const { RuntimeProfileManager } = await loadRuntimeProfile()
    const manager = new RuntimeProfileManager()
    const target = session()
    // Command Code stamps `"version": 3` on its session header — a SCHEMA number. Reading it as a CLI
    // version would invent a "3.0.0" build that no gate should ever act on.
    manager.ingest(target, JSON.stringify({ type: 'session', version: 3, id: 'x', cwd: '/tmp' }))
    expect(target.cliVersion).toBeNull()
  })
})
