/**
 * Prove a provider URL + credential before a machine is created.
 *
 * Without this step a wrong credential is indistinguishable from an outage — the machine is created,
 * looks fine, and only fails when somebody eventually types a message. That is the worst failure mode
 * in this design, and the whole reason the create flow blocks on a live check.
 *
 * ONE authenticated call does the whole job. `agent.list` proves the URL, the credential and that the
 * endpoint speaks this protocol at once, and it returns exactly what the create screen wants to show
 * next — so there is nothing to fetch beforehand.
 *
 * Four outcomes, four different sentences. They are different because each has a different fix:
 * change the URL, wait, pick a different provider, or paste the right credential.
 */
import { ProviderError, listAgents, type ProviderAgent } from './provider/client.js'
import { checkProviderUrl, ProviderUrlError } from './providerUrl.js'

export type ProbeFailure =
  | 'PROVIDER_URL_REFUSED'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_NOT_STREAMING'
  | 'PROVIDER_CREDENTIAL_REJECTED'

export class ProviderProbeError extends Error {
  constructor(message: string, readonly code: ProbeFailure) {
    super(message)
    this.name = 'ProviderProbeError'
  }
}

export interface ProbeResult {
  /** Normalised URL to store. */
  url: string
  /** Agent ids, so the UI can show what it just connected to. */
  agents: Array<{ id: string; name: string; description?: string }>
}

export async function probeProvider(rawUrl: string, credential: string): Promise<ProbeResult> {
  let url: string
  try {
    url = (await checkProviderUrl(rawUrl)).url
  } catch (err) {
    // The guard's own message names the actual problem (private address, bad scheme, no DNS), which
    // is more useful than a generic "invalid URL".
    throw new ProviderProbeError(err instanceof ProviderUrlError ? err.message : 'That is not a usable URL', 'PROVIDER_URL_REFUSED')
  }

  let agents: ProviderAgent[]
  try {
    agents = (await listAgents({ url, credential, timeoutMs: 10_000 })).agents ?? []
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'unauthenticated') {
      throw new ProviderProbeError('The provider rejected that credential', 'PROVIDER_CREDENTIAL_REJECTED')
    }
    // `protocol` errors mean it answered, but not the way this protocol says to — most often because
    // the URL points at something else entirely. That is a different fix from "wait for it to come
    // back", so it keeps its own code.
    if (err instanceof ProviderError && err.kind === 'protocol') {
      throw new ProviderProbeError('That endpoint did not answer as a provider', 'PROVIDER_NOT_STREAMING')
    }
    // A refusal means it IS a provider and it said no — to listing agents, of all things. Its own
    // sentence is the only thing here that tells the owner what to do about it.
    if (err instanceof ProviderError && err.kind === 'refused') {
      throw new ProviderProbeError(`The provider refused to list its agents: ${err.message}`, 'PROVIDER_NOT_STREAMING')
    }
    throw new ProviderProbeError(
      `Could not reach that provider${err instanceof Error && err.message ? `: ${err.message}` : ''}`,
      'PROVIDER_UNREACHABLE',
    )
  }

  const usable = agents.filter((a): a is ProviderAgent & { id: string } => typeof a?.id === 'string' && !!a.id)
  // An empty list is a real failure, not an empty state: the machine would be created and then have
  // nothing to talk to, which reads to the owner as a broken product rather than a bad endpoint.
  if (!usable.length) {
    throw new ProviderProbeError('That provider returned no agents to talk to', 'PROVIDER_NOT_STREAMING')
  }

  return {
    url,
    agents: usable.map((a) => ({ id: a.id, name: a.name ?? a.id, description: a.description })),
  }
}
