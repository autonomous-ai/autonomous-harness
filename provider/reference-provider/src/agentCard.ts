/**
 * The Agent Card — HP-020 through HP-023.
 *
 * This is the whole capability negotiation. A client reads this and knows what the provider can do;
 * nothing else in the protocol advertises capability (HP-001).
 */

export const AGENT_CARD = {
  name: 'Autonomous Reference Provider',
  description:
    'A minimal, deterministic provider used to validate the machine provider profile. It runs no model — every reply is scripted.',
  version: '0.1.0',

  // HP-021: non-negotiable. The product renders assistant output token by token.
  capabilities: { streaming: true, pushNotifications: false },

  // HP-011: APIKey and HTTPAuth bearer are the schemes Autonomous supports today.
  securitySchemes: {
    apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
  },

  defaultInputModes: ['text/plain', 'image/png', 'image/jpeg'],
  defaultOutputModes: ['text/plain'],

  // HP-023: skills are the agent list shown to the user.
  skills: [
    {
      id: 'acme-reporting',
      name: 'Acme reporting',
      description: "Acme's ad accounts — spend, pacing, and alerting.",
    },
    {
      id: 'globex-q3',
      name: 'Globex Q3',
      description: 'Quarterly rollup for Globex.',
    },
  ],

  // HP-022: implemented-but-undeclared MUST be treated as absent, so this list is the contract.
  // `workspace-files` and `workspace-write` are deliberately NOT declared — the reference provider
  // exercises the degradation path as well as the happy path.
  extensions: [
    {
      uri: 'https://harness.autonomous.ai/api/a2a/ext/session-recap',
      description: 'Short per-turn summaries for device tile restore.',
    },
  ],
} as const

export type AgentCard = typeof AGENT_CARD

/** Skill ids, for validating an agent reference without trusting the caller. */
export const SKILL_IDS: readonly string[] = AGENT_CARD.skills.map((s) => s.id)
