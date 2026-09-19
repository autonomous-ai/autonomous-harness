import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { PROCESS_ENGINES } from '../engines/types.js'
import { ENGINE_INSTALL } from './engineInstall.js'
import { buildEngineLaunchArgv } from './engineLaunch.js'

const OFFICIAL_COMMANDS = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  cursor: 'curl https://cursor.com/install -fsS | bash',
  opencode: 'npm install -g opencode-ai',
  pi: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
  hermes: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
  commandcode: 'npm i -g command-code',
  devin: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
  muse: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
  amp: 'curl -fsSL https://ampcode.com/install.sh | bash',
  kilo: 'npm install -g @kilocode/cli',
  grok: 'curl -fsSL https://x.ai/cli/install.sh | bash',
  agy: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  copilot: 'curl -fsSL https://gh.io/copilot-install | PREFIX="$HOME/.local" PATH="$HOME/.local/bin:$PATH" bash',
} as const

describe('ENGINE_INSTALL', () => {
  it('has one first-party recipe for every supported engine', () => {
    expect(Object.keys(ENGINE_INSTALL)).toEqual(PROCESS_ENGINES)
    expect(Object.fromEntries(
      Object.entries(ENGINE_INSTALL).map(([engine, recipe]) => [engine, recipe.command]),
    )).toEqual(OFFICIAL_COMMANDS)
    for (const recipe of Object.values(ENGINE_INSTALL)) {
      expect(recipe.source).toMatch(/^https:\/\//)
      expect(recipe.executable.names.length).toBeGreaterThan(0)
    }
  })

  it('uses Cursor’s unambiguous documented command and OpenCode stable', () => {
    expect(ENGINE_INSTALL.cursor.executable.names[0]).toBe('cursor-agent')
    expect(ENGINE_INSTALL.opencode.command).not.toContain('opencode2')
    expect(ENGINE_INSTALL.opencode.command).not.toContain('@beta')
  })

  it('uses Copilot’s standalone Linux installer and verifies the binary before launch', () => {
    expect(ENGINE_INSTALL.copilot.executable.npmGlobal).toBeUndefined()
    expect(ENGINE_INSTALL.copilot.executable.homeRelativePaths).toContain('.local/bin/copilot')
    expect(ENGINE_INSTALL.copilot.executable.probeArgs).toEqual(['--version'])
  })

  it('generates valid POSIX pane scripts for every recipe', () => {
    for (const engine of PROCESS_ENGINES) {
      const script = buildEngineLaunchArgv(
        engine,
        { installIfMissing: ENGINE_INSTALL[engine] },
        '/bin/sh',
      )[2]
      expect(() => execFileSync('/bin/sh', ['-n', '-c', script])).not.toThrow()
    }
  })
})
