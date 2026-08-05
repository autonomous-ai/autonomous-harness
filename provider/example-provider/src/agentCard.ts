/**
 * The Agent Card — HP-020 … HP-023.
 *
 * Unlike the reference provider's static card, this one is built FROM `agents.json`: the skills are
 * whatever directories the operator configured. The card is the whole capability negotiation, so
 * everything this provider can do has to be visible here (HP-001).
 */
import type { AgentEntry } from './config.js'

export const EXT = {
  WORKSPACE_FILES: 'https://harness.autonomous.ai/api/a2a/ext/workspace-files',
  WORKSPACE_WRITE: 'https://harness.autonomous.ai/api/a2a/ext/workspace-write',
  SESSION_RECAP: 'https://harness.autonomous.ai/api/a2a/ext/session-recap',
  VOICE: 'https://harness.autonomous.ai/api/a2a/ext/voice',
} as const

/**
 * Declared here:
 *   - `workspace-files` — the agent has a real working directory, so a file tree is meaningful.
 *   - `session-recap`   — Claude's transcripts give us recent turns for free.
 *
 *   - `workspace-write` — agents only. A new agent is a new directory under WORKSPACE_ROOT, which
 *     is why that root is separate from the agent directories themselves: creating one must never
 *     be able to write outside it.
 *
 * NOT declared:
 *   - `voice`           — Autonomous routes from skills[] by default; overriding buys nothing here.
 */
export function buildAgentCard(agents: AgentEntry[]): Record<string, unknown> {
  return {
    name: 'Claude (example provider)',
    description:
      'A real A2A provider backed by the local Claude Code CLI. Each skill is a configured working directory.',
    version: '0.1.0',

    // HP-021 — non-negotiable. Claude streams tokens and so does this provider.
    capabilities: { streaming: true, pushNotifications: false },

    // HP-011 — APIKey in a header is one of the two schemes Autonomous supports.
    securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } },

    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],

    // HP-023 — the agent list the user sees. `cwd` stays server-side: it is a filesystem path and
    // nothing the client needs.
    skills: agents.map((a) => ({ id: a.id, name: a.name, description: a.description })),

    // HP-022 — implemented-but-undeclared must read as absent, so this list is the contract.
    extensions: [
      { uri: EXT.WORKSPACE_FILES, description: 'Browse and read files in the agent working directory.' },
      { uri: EXT.SESSION_RECAP, description: 'Recent turn summaries, from Claude transcripts.' },
      {
        uri: EXT.WORKSPACE_WRITE,
        description: 'Create and remove agents. Each one is a directory under the workspace root.',
        // `sessions: false` — deleting or retitling a Claude transcript would mean writing into
        // ~/.claude, which is the user's own history and not ours to edit.
        params: { agents: true, sessions: false },
      },
    ],
  }
}
