import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let codexHome = ''
let cursorHome = ''
let grokHome = ''
let hermesHome = ''
let commandcodeHome = ''
let devinConfigPath = ''

async function loadHooks() {
  vi.resetModules()
  process.env.CODEX_HOME = codexHome
  process.env.CURSOR_HOME = cursorHome
  process.env.GROK_HOME = grokHome
  process.env.HERMES_HOME = hermesHome
  process.env.COMMANDCODE_HOME = commandcodeHome
  process.env.DEVIN_CONFIG_PATH = devinConfigPath
  return import('./hooks.js')
}

describe('Codex hook installation', () => {
  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'adapter-codex-hooks-'))
    cursorHome = mkdtempSync(join(tmpdir(), 'adapter-cursor-hooks-'))
  })

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true })
    rmSync(cursorHome, { recursive: true, force: true })
    delete process.env.CODEX_HOME
    delete process.env.CURSOR_HOME
  })

  it('merges foreign hooks and installs the canonical catch hooks idempotently', async () => {
    const file = join(codexHome, 'hooks.json')
    writeFileSync(file, JSON.stringify({
      custom: { keep: true },
      hooks: {
        SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'foreign-start' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'foreign-prompt' }] }],
      },
    }))

    const { installCodexHooks } = await loadHooks()
    installCodexHooks(19473)
    const first = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(first)

    expect(parsed.custom).toEqual({ keep: true })
    expect(parsed.hooks.SessionStart).toHaveLength(2)
    expect(parsed.hooks.SessionStart[1]).toMatchObject({ matcher: 'startup|resume|clear|compact' })
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(2)
    expect(parsed.hooks.UserPromptSubmit[1]).not.toHaveProperty('matcher')
    expect(parsed.hooks.UserPromptSubmit[1].hooks[0].command).toContain('--engine codex')

    installCodexHooks(19473)
    expect(readFileSync(file, 'utf-8')).toBe(first)
  })

  it('installs into a custom CODEX_HOME profile, with a matching --codex-home baked in', async () => {
    const customProfile = mkdtempSync(join(tmpdir(), 'adapter-codex-profile-'))
    try {
      const { installCodexHooks } = await loadHooks()
      installCodexHooks(19473, customProfile)

      const profileFile = join(customProfile, 'hooks.json')
      const first = readFileSync(profileFile, 'utf-8')
      const parsed = JSON.parse(first)
      const cmd = parsed.hooks.SessionStart[0].hooks[0].command
      expect(cmd).toContain(`--codex-home '${customProfile}'`)

      // The default profile is untouched by installing into a different one.
      expect(existsSync(join(codexHome, 'hooks.json'))).toBe(false)

      // Idempotent: a second install into the same profile is a no-op.
      installCodexHooks(19473, customProfile)
      expect(readFileSync(profileFile, 'utf-8')).toBe(first)
    } finally {
      rmSync(customProfile, { recursive: true, force: true })
    }
  })

  it('leaves malformed user hook configuration untouched', async () => {
    const file = join(codexHome, 'hooks.json')
    writeFileSync(file, '{not-json')

    const { installCodexHooks } = await loadHooks()
    installCodexHooks(19473)

    expect(readFileSync(file, 'utf-8')).toBe('{not-json')
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)
  })

  it('merges Cursor lower-camel hooks and preserves foreign entries idempotently', async () => {
    const file = join(cursorHome, 'hooks.json')
    writeFileSync(file, JSON.stringify({
      version: 7,
      custom: true,
      hooks: { preToolUse: [{ command: 'foreign-task', failClosed: true }] },
    }))
    const { installCursorHooks } = await loadHooks()
    installCursorHooks(19473)
    const first = readFileSync(file, 'utf8')
    const parsed = JSON.parse(first)
    expect(parsed.version).toBe(7)
    expect(parsed.custom).toBe(true)
    expect(parsed.hooks.preToolUse).toHaveLength(2)
    expect(parsed.hooks.preToolUse[1]).toMatchObject({ failClosed: false })
    expect(parsed.hooks.preToolUse[1].command).toContain('--engine cursor')
    expect(Object.keys(parsed.hooks)).toEqual([
      'preToolUse', 'sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd',
    ])

    installCursorHooks(19473)
    expect(readFileSync(file, 'utf8')).toBe(first)
  })
})

describe('Grok hook installation', () => {
  beforeEach(() => {
    grokHome = mkdtempSync(join(tmpdir(), 'adapter-grok-hooks-'))
  })

  afterEach(() => {
    rmSync(grokHome, { recursive: true, force: true })
    delete process.env.GROK_HOME
  })

  it('installs camelCase lifecycle hooks without the early Stop signal', async () => {
    const { installGrokHooks } = await loadHooks()
    installGrokHooks(18473)
    const file = join(grokHome, 'hooks', 'harness.json')
    const first = readFileSync(file, 'utf8')
    const out = JSON.parse(first) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(Object.keys(out.hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'StopFailure', 'UserPromptSubmit'])
    expect(out.hooks).not.toHaveProperty('Stop')
    expect(out.hooks.SessionStart[0].hooks[0].command).toContain('--engine grok')
    expect(out.hooks.SessionStart[0].hooks[0].command).toContain(`--grok-home '${grokHome}'`)

    installGrokHooks(18473)
    expect(readFileSync(file, 'utf8')).toBe(first)
  })

  it('leaves malformed Grok hook JSON untouched', async () => {
    const file = join(grokHome, 'hooks', 'harness.json')
    mkdirSync(join(grokHome, 'hooks'), { recursive: true })
    writeFileSync(file, '{not-json')
    const { installGrokHooks } = await loadHooks()
    installGrokHooks(18473)
    expect(readFileSync(file, 'utf8')).toBe('{not-json')
  })
})

describe('Command Code hook installation', () => {
  let file = ''

  beforeEach(() => {
    commandcodeHome = mkdtempSync(join(tmpdir(), 'adapter-commandcode-hooks-'))
    file = join(commandcodeHome, 'settings.json')
  })

  afterEach(() => {
    rmSync(commandcodeHome, { recursive: true, force: true })
    delete process.env.COMMANDCODE_HOME
  })

  it('installs SessionStart/PreToolUse/Stop, preserves foreign hooks, and is idempotent', async () => {
    writeFileSync(file, JSON.stringify({
      model: 'taste-1',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/usr/local/bin/my-own.sh' }] }] },
    }))

    const { installCommandCodeHooks } = await loadHooks()
    installCommandCodeHooks(18473)

    const out = JSON.parse(readFileSync(file, 'utf8')) as {
      model: string
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(out.model).toBe('taste-1')                       // untouched
    expect(Object.keys(out.hooks).sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop'])
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe('/usr/local/bin/my-own.sh') // foreign kept
    expect(out.hooks.SessionStart[1].hooks[0].command).toContain('--engine commandcode')
    expect(out.hooks.Stop[0].hooks[0].command).toContain('notify.mjs')
    // PreToolUse is this engine's ONLY live turn-open signal — it has no UserPromptSubmit and flushes its
    // transcript when the turn ends, so without this hook the device never shows a working state.
    expect(out.hooks.PreToolUse[0].hooks[0].command).toContain('--engine commandcode')

    const first = readFileSync(file, 'utf8')
    installCommandCodeHooks(18473)
    expect(readFileSync(file, 'utf8')).toBe(first)
  })

  it('collapses duplicate machine blocks left by an older path/port', async () => {
    const stale = (port: number) => ({ hooks: [{ type: 'command', command: `node '/old/notify.mjs' --port ${port} --engine commandcode` }] })
    writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [stale(19918), stale(19919)], Stop: [stale(19918)] } }))

    const { installCommandCodeHooks } = await loadHooks()
    installCommandCodeHooks(18473)

    const out = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, unknown[]> }
    expect(out.hooks.SessionStart).toHaveLength(1) // both stale entries collapsed into the canonical one
    expect(out.hooks.Stop).toHaveLength(1)
    expect(JSON.stringify(out)).not.toContain('19918')
  })

  it('leaves a malformed settings file untouched', async () => {
    writeFileSync(file, '{ not json')
    const { installCommandCodeHooks } = await loadHooks()
    installCommandCodeHooks(18473)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })
})

/**
 * Devin reads Claude's hook schema verbatim, but its hooks nest inside the user's GENERAL config
 * (`~/.config/devin/config.json`) next to `devin.org_id`, `theme_mode`, … — so the installer must merge,
 * never rewrite the file.
 */
describe('Devin hook installation', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adapter-devin-hooks-'))
    devinConfigPath = join(dir, 'config.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DEVIN_CONFIG_PATH
  })

  it('merges into the user config, keeps foreign hooks, and is idempotent', async () => {
    writeFileSync(devinConfigPath, JSON.stringify({
      version: 1,
      devin: { org_id: 'org-9fc31c99' },
      theme_mode: 'dark',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/usr/local/bin/my-own.sh' }] }] },
    }))

    const { installDevinHooks } = await loadHooks()
    installDevinHooks(18473)

    const out = JSON.parse(readFileSync(devinConfigPath, 'utf8')) as {
      version: number
      devin: { org_id: string }
      theme_mode: string
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(out.version).toBe(1)                       // unrelated settings survive
    expect(out.devin.org_id).toBe('org-9fc31c99')
    expect(out.theme_mode).toBe('dark')
    expect(Object.keys(out.hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe('/usr/local/bin/my-own.sh') // foreign kept
    expect(out.hooks.SessionStart[1].hooks[0].command).toContain('--engine devin')
    expect(out.hooks.Stop[0].hooks[0].command).toContain('notify.mjs')

    const first = readFileSync(devinConfigPath, 'utf8')
    installDevinHooks(18473)
    expect(readFileSync(devinConfigPath, 'utf8')).toBe(first)
  })

  it('collapses duplicate machine blocks left by an older path/port', async () => {
    const stale = (port: number) => ({ hooks: [{ type: 'command', command: `node '/old/notify.mjs' --port ${port} --engine devin` }] })
    writeFileSync(devinConfigPath, JSON.stringify({ hooks: { SessionStart: [stale(19918), stale(19919)], Stop: [stale(19918)] } }))

    const { installDevinHooks } = await loadHooks()
    installDevinHooks(18473)

    const out = JSON.parse(readFileSync(devinConfigPath, 'utf8')) as { hooks: Record<string, unknown[]> }
    expect(out.hooks.SessionStart).toHaveLength(1)
    expect(out.hooks.Stop).toHaveLength(1)
    expect(JSON.stringify(out)).not.toContain('19918')
  })

  it('creates the config when the user has none, and leaves a malformed one untouched', async () => {
    const { installDevinHooks } = await loadHooks()
    installDevinHooks(18473)
    expect(JSON.parse(readFileSync(devinConfigPath, 'utf8')).hooks.SessionStart).toHaveLength(1)

    writeFileSync(devinConfigPath, '{ not json')
    const again = await loadHooks()
    again.installDevinHooks(18473)
    expect(readFileSync(devinConfigPath, 'utf8')).toBe('{ not json')
  })
})

/**
 * Hermes is the only engine whose hooks live in the user's MAIN config (YAML, not a dedicated JSON
 * file), so the installer owns a delimited block instead of rebuilding a JSON array. A duplicate
 * top-level `hooks:` key is silently resolved by YAML to the LAST one, which once pinned live sessions
 * to a stale block — these tests lock the collapse behaviour in.
 */
describe('Hermes hook installation', () => {
  const USER_CONFIG = 'model:\n  default: minimax/minimax-m3\n  provider: custom\n'
  let file = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'adapter-hermes-hooks-'))
    file = join(hermesHome, 'config.yaml')
    writeFileSync(file, USER_CONFIG)
  })

  afterEach(() => {
    rmSync(hermesHome, { recursive: true, force: true })
    delete process.env.HERMES_HOME
  })

  const blockCount = (text: string): number => (text.match(/^hooks:/gm) ?? []).length
  const ports = (text: string): string[] => [...new Set([...text.matchAll(/--port (\d+)/g)].map((m) => m[1]))]

  it('appends one managed block, preserves the user config, and allowlists the command', async () => {
    const { installHermesHooks } = await loadHooks()
    installHermesHooks(18473)

    const out = readFileSync(file, 'utf8')
    expect(blockCount(out)).toBe(1)
    expect(out).toContain('model:\n  default: minimax/minimax-m3') // user config untouched
    expect(out).toContain('on_session_start:')
    expect(out).toContain('pre_llm_call:') // the beacon: on_session_start does not fire on resume

    // Hermes silently skips a hook whose exact (event, command) pair is not allowlisted.
    const allow = JSON.parse(readFileSync(join(hermesHome, 'shell-hooks-allowlist.json'), 'utf8')) as {
      approvals: Array<{ event: string; command: string }>
    }
    const cmd = /- command: "(.*?)"/.exec(out)![1]
    expect(allow.approvals.map((a) => a.event).sort()).toEqual(['on_session_start', 'pre_llm_call'])
    for (const a of allow.approvals) expect(a.command).toBe(cmd)
  })

  it('collapses to a SINGLE block when the port changes (no duplicate hooks: key)', async () => {
    const { installHermesHooks } = await loadHooks()
    installHermesHooks(18473)
    installHermesHooks(19999)

    const out = readFileSync(file, 'utf8')
    expect(blockCount(out)).toBe(1)
    expect(ports(out)).toEqual(['19999']) // the stale port is gone, not merely appended past
  })

  it('absorbs an orphaned block left by an earlier buggy install', async () => {
    // Shape produced by the old marker-only rewrite: a bare `hooks:` mapping with our command.
    const orphan = "\nhooks:\n  pre_llm_call:\n    - command: \"node '/old/notify.mjs' --port 19918 --engine hermes\"\n      timeout: 10\n"
    writeFileSync(file, `${USER_CONFIG}${orphan}`)

    const { installHermesHooks } = await loadHooks()
    installHermesHooks(18473)

    const out = readFileSync(file, 'utf8')
    expect(blockCount(out)).toBe(1)
    expect(out).not.toContain('19918')
    expect(out).toContain('model:\n  default: minimax/minimax-m3')
  })

  it('is idempotent', async () => {
    const { installHermesHooks } = await loadHooks()
    installHermesHooks(18473)
    const first = readFileSync(file, 'utf8')
    installHermesHooks(18473)
    expect(readFileSync(file, 'utf8')).toBe(first)
  })

  it('leaves a user-owned hooks: block untouched', async () => {
    const mine = `${USER_CONFIG}\nhooks:\n  pre_tool_call:\n    - command: "/usr/local/bin/my-guard.sh"\n      timeout: 5\n`
    writeFileSync(file, mine)

    const { installHermesHooks } = await loadHooks()
    installHermesHooks(18473)

    expect(readFileSync(file, 'utf8')).toBe(mine)
    expect(existsSync(join(hermesHome, 'shell-hooks-allowlist.json'))).toBe(false)
  })
})

/**
 * A hook command is executed later, by the ENGINE, in a shell whose PATH we do not control — an app
 * started from Finder inherits launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin`. Since the product ships
 * its own Node under ~/.harness/runtime, a computer with no `node` on PATH is the normal case, and a
 * command line beginning with the bare word `node` fails there with "node: command not found".
 */
describe('the Node interpreter baked into hook commands', () => {
  let runtimeDir = ''

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'adapter-codex-node-'))
    hermesHome = mkdtempSync(join(tmpdir(), 'adapter-hermes-node-'))
    runtimeDir = mkdtempSync(join(tmpdir(), 'adapter-runtime-'))
  })

  afterEach(() => {
    for (const dir of [codexHome, hermesHome, runtimeDir]) rmSync(dir, { recursive: true, force: true })
    delete process.env.CODEX_HOME
    delete process.env.HERMES_HOME
    delete process.env.ADAPTER_RUNTIME_DIR
  })

  /** The first shell word of the emitted command, unquoted. */
  function interpreterOf(command: string): string {
    const [, quoted] = /^'((?:[^']|'\\'')*)'/.exec(command) ?? []
    return quoted ?? command.split(' ')[0]
  }

  it('names an absolute, runnable interpreter and never the bare word node', async () => {
    const file = join(codexHome, 'hooks.json')
    const { installCodexHooks } = await loadHooks()
    installCodexHooks(18473)

    const out = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const command = out.hooks.SessionStart[0].hooks[0].command
    const interpreter = interpreterOf(command)

    expect(interpreter).not.toBe('node')
    expect(interpreter.startsWith('/')).toBe(true)
    expect(existsSync(interpreter)).toBe(true)
  })

  it('prefers the managed runtime over the interpreter this process runs on', async () => {
    // Stand in for a runtime provisioned AFTER this daemon started: the hooks must follow
    // current-node, not process.execPath, or a Node upgrade would never reach them.
    const upgraded = join(runtimeDir, 'node-v99', 'bin', 'node')
    mkdirSync(join(runtimeDir, 'node-v99', 'bin'), { recursive: true })
    writeFileSync(upgraded, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(runtimeDir, 'current-node'), `${upgraded}\n`)
    process.env.ADAPTER_RUNTIME_DIR = runtimeDir

    const file = join(codexHome, 'hooks.json')
    const { installCodexHooks } = await loadHooks()
    installCodexHooks(18473)

    const out = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(interpreterOf(out.hooks.SessionStart[0].hooks[0].command)).toBe(upgraded)
  })

  it('falls back to this process when current-node names something unrunnable', async () => {
    writeFileSync(join(runtimeDir, 'current-node'), `${join(runtimeDir, 'node-gone', 'bin', 'node')}\n`)
    process.env.ADAPTER_RUNTIME_DIR = runtimeDir

    const file = join(codexHome, 'hooks.json')
    const { installCodexHooks } = await loadHooks()
    installCodexHooks(18473)

    const out = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    // A hook naming an interpreter that cannot run is strictly worse than one naming the interpreter
    // we are demonstrably running on.
    expect(interpreterOf(out.hooks.SessionStart[0].hooks[0].command)).toBe(process.execPath)
  })

  it('refuses a current-node pointing outside the runtime directory', async () => {
    writeFileSync(join(runtimeDir, 'current-node'), '/bin/sh\n')
    process.env.ADAPTER_RUNTIME_DIR = runtimeDir

    const file = join(codexHome, 'hooks.json')
    const { installCodexHooks } = await loadHooks()
    installCodexHooks(18473)

    const out = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(interpreterOf(out.hooks.SessionStart[0].hooks[0].command)).toBe(process.execPath)
  })

  // The repair path for every machine already carrying the broken form. It works because each
  // installer recognises its own entries by the notify.mjs substring and rewrites on ANY command
  // drift — a changed interpreter is the same kind of drift as a changed path or port.
  it('replaces an already-installed hook that still runs a bare node', async () => {
    const file = join(codexHome, 'hooks.json')
    writeFileSync(file, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: "node '/Users/someone/.harness/cli/notify.mjs' --port 18473 --engine codex" }] }],
      },
    }))

    const { installCodexHooks } = await loadHooks()
    installCodexHooks(18473)

    const out = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const commands = out.hooks.SessionStart.flatMap((block) => block.hooks.map((h) => h.command))
    expect(commands).toHaveLength(1)
    expect(commands[0].startsWith('node ')).toBe(false)
    expect(interpreterOf(commands[0]).startsWith('/')).toBe(true)
  })
})

/**
 * Hermes silently skips any hook whose exact (event, command) pair is not approved, so the installer
 * records its own. Every command change mints five new pairs; without pruning, the approvals file
 * grows by five entries for every port change, moved install and Node upgrade, forever.
 */
describe('Hermes hook allowlist', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'adapter-hermes-allow-'))
    writeFileSync(join(hermesHome, 'config.yaml'), 'model: test\n')
  })

  afterEach(() => {
    rmSync(hermesHome, { recursive: true, force: true })
    delete process.env.HERMES_HOME
  })

  it('drops its own stale approvals and keeps foreign ones', async () => {
    const allowlist = join(hermesHome, 'shell-hooks-allowlist.json')
    writeFileSync(allowlist, JSON.stringify({
      approvals: [
        { event: 'on_session_start', command: "node '/old/notify.mjs' --port 19918 --engine hermes" },
        { event: 'pre_llm_call', command: "node '/old/notify.mjs' --port 19918 --engine hermes" },
        { event: 'on_session_start', command: '/usr/local/bin/somebody-elses-hook.sh' },
      ],
    }))

    const { installHermesHooks } = await loadHooks()
    installHermesHooks(18473)

    const out = JSON.parse(readFileSync(allowlist, 'utf8')) as { approvals: Array<{ event: string; command: string }> }
    expect(out.approvals.some((a) => a.command.includes('/old/notify.mjs'))).toBe(false)
    expect(out.approvals.some((a) => a.command === '/usr/local/bin/somebody-elses-hook.sh')).toBe(true)
    // Exactly one approval per event, and it is the command actually written into config.yaml.
    const installed = /- command: "(.*?)"/.exec(readFileSync(join(hermesHome, 'config.yaml'), 'utf8'))![1]
      .replace(/\\(.)/g, '$1')
    const ours = out.approvals.filter((a) => a.command.includes('notify.mjs'))
    expect(ours.every((a) => a.command === installed)).toBe(true)
    expect(new Set(ours.map((a) => a.event)).size).toBe(ours.length)
  })
})

