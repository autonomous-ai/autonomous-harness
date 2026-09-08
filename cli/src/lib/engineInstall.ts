/**
 * Official install recipes for every engine Harness can launch.
 *
 * The command is shown in Desktop before Create is pressed, then runs inside the tmux pane on the
 * target machine. Keep every line tied to first-party documentation: a plausible package name that
 * installs successfully but does not provide the expected executable is worse than no recipe.
 */

import type { AgentEngine } from '../engines/types.js'

/** How to find the executable after the installer returns. */
export interface EngineInstallExecutable {
  /** Executable names published by the vendor, in preference order. */
  readonly names: readonly string[]
  /** Paths relative to the target user's home, used before a freshly edited PATH can be reloaded. */
  readonly homeRelativePaths?: readonly string[]
  /** Fixed system paths used by a vendor installer in a special mode, such as a root install. */
  readonly absolutePaths?: readonly string[]
  /** Resolve each name below `npm prefix -g` when the install method is npm. */
  readonly npmGlobal?: boolean
}

export interface EngineInstallRecipe {
  /** The first-party line a person would paste into a POSIX shell. */
  readonly command: string
  /** First-party documentation used to verify the command. */
  readonly source: string
  /** Ordered, source-owned ways to locate the binary after installation. */
  readonly executable: EngineInstallExecutable
}

/**
 * Exhaustive on purpose. Adding an engine without deciding how it is installed must fail typecheck
 * rather than silently creating another unsupported row in Desktop.
 */
export const ENGINE_INSTALL: Readonly<Record<AgentEngine, EngineInstallRecipe>> = {
  claude: {
    command: 'npm install -g @anthropic-ai/claude-code',
    source: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
    executable: { names: ['claude'], npmGlobal: true, homeRelativePaths: ['.local/bin/claude'] },
  },
  codex: {
    command: 'npm install -g @openai/codex',
    source: 'https://github.com/openai/codex',
    executable: { names: ['codex'], npmGlobal: true, homeRelativePaths: ['.local/bin/codex'] },
  },
  cursor: {
    command: 'curl https://cursor.com/install -fsS | bash',
    source: 'https://docs.cursor.com/en/cli/installation',
    // `cursor-agent` is deliberately the canonical name. Grok also installs `agent`; using that
    // shared alias here could turn a requested Cursor pane into a Grok pane.
    executable: { names: ['cursor-agent'], homeRelativePaths: ['.local/bin/cursor-agent'] },
  },
  opencode: {
    command: 'npm install -g opencode-ai',
    source: 'https://opencode.ai/docs',
    executable: { names: ['opencode'], npmGlobal: true, homeRelativePaths: ['.opencode/bin/opencode'] },
  },
  pi: {
    // pi.dev publishes the scoped package with --ignore-scripts. The unscoped package is unrelated
    // and does not provide the `pi` executable.
    command: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    source: 'https://pi.dev/',
    executable: { names: ['pi'], npmGlobal: true },
  },
  hermes: {
    command: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    source: 'https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/quickstart.md',
    executable: {
      names: ['hermes'],
      homeRelativePaths: ['.local/bin/hermes'],
      absolutePaths: ['/usr/local/bin/hermes'],
    },
  },
  commandcode: {
    command: 'npm i -g command-code',
    source: 'https://commandcode.ai/docs',
    executable: { names: ['cmd', 'command-code'], npmGlobal: true },
  },
  devin: {
    command: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
    source: 'https://cli.devin.ai/reference/commands',
    executable: { names: ['devin'], homeRelativePaths: ['.local/bin/devin'] },
  },
  muse: {
    command: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
    source: 'https://ai.meta.com/llama/',
    executable: { names: ['muse'], homeRelativePaths: ['.local/bin/muse'] },
  },
  amp: {
    command: 'curl -fsSL https://ampcode.com/install.sh | bash',
    source: 'https://ampcode.com/docs/cli',
    executable: { names: ['amp'], homeRelativePaths: ['.local/bin/amp', '.amp/bin/amp'] },
  },
  kilo: {
    command: 'npm install -g @kilocode/cli',
    source: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
    executable: {
      names: ['kilo', 'kilocode'],
      npmGlobal: true,
      homeRelativePaths: ['.kilo/bin/kilo', '.local/bin/kilo'],
    },
  },
  grok: {
    command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    source: 'https://docs.x.ai/build/overview',
    executable: { names: ['grok'], homeRelativePaths: ['.grok/bin/grok', '.local/bin/grok'] },
  },
  agy: {
    command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    source: 'https://antigravity.google/docs/cli/install/',
    executable: { names: ['agy'], homeRelativePaths: ['.local/bin/agy'] },
  },
  copilot: {
    command: 'npm install -g @github/copilot',
    source: 'https://docs.github.com/en/copilot/get-started/cli-quickstart',
    executable: { names: ['copilot'], npmGlobal: true, homeRelativePaths: ['.local/bin/copilot'] },
  },
}

export function engineInstallRecipe(engine: AgentEngine): EngineInstallRecipe {
  return ENGINE_INSTALL[engine]
}

export const INSTALLABLE_ENGINES: ReadonlySet<AgentEngine> = new Set(
  Object.keys(ENGINE_INSTALL) as AgentEngine[],
)
