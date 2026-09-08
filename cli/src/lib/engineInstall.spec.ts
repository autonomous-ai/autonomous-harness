import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { ENGINES } from '../engines/types.js'
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
  copilot: 'npm install -g @github/copilot',
} as const

describe('ENGINE_INSTALL', () => {
  it('has one first-party recipe for every supported engine', () => {
    expect(Object.keys(ENGINE_INSTALL)).toEqual(ENGINES)
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

  it('generates valid POSIX pane scripts for every recipe', () => {
    for (const engine of ENGINES) {
      const script = buildEngineLaunchArgv(
        engine,
        { installIfMissing: ENGINE_INSTALL[engine] },
        '/bin/sh',
      )[2]
      expect(() => execFileSync('/bin/sh', ['-n', '-c', script])).not.toThrow()
    }
  })
})
