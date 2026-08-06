/**
 * The agent list, and where the credential goes.
 *
 * There is nothing to discover: one URL, one credential header, eight methods. `agent.list` IS how a
 * client learns what this provider offers, and because it is authenticated, two credentials can
 * legitimately see two different lists — which is exactly why the list was never something a public
 * document could carry.
 *
 * Read from `config` on every call rather than snapshotted, so an agent created a moment ago is
 * addressable by its very next `agent.send`.
 */
import type { Config } from './config.js'
import type { Agent } from './types.js'

export const CREDENTIAL_HEADER = 'authorization'

/** The agent list, from configuration, scoped to the tenant the credential selects. */
export const agentsOf = (config: Config): Agent[] =>
  config.agents.map((a) => ({ id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}) }))
