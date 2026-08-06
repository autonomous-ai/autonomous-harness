/**
 * Engine errors, rewritten for a 1.9" round screen.
 *
 * A CLI writes for someone sitting at a terminal: it links to a settings page, quotes a trace id, tells
 * you to check the pane. None of that is actionable on a device — the reader cannot follow a URL, and a
 * long sentence pushes the one fact that matters off the card. So each rule here keeps the WHAT and the
 * WHEN and drops the rest, rather than truncating, which cuts the end — where the useful part usually is.
 */

const AGENT_DID_NOT_ACCEPT = 'The agent did not accept the message. Please try again.'

/**
 * Codex, when the account runs out. Verified against a real rollout (`task_complete.error.message`):
 *   "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more
 *    credits or try again at Aug 5th, 2026 11:09 AM."
 * Two facts survive — that it is a usage limit, and when it clears. The purchase link cannot be followed
 * from the device, so it goes.
 */
const CODEX_USAGE_LIMIT = /you'?ve hit your usage limit/i
const TRY_AGAIN_AT = /try again at\s+([^.]+(?:\.[^.\s]+)*?)\s*\.?\s*$/i

/** Any http(s) link, together with the "Visit …" lead-in that introduces one. */
const URL_CLAUSE = /\s*(?:visit|see|go to|open)?\s+https?:\/\/\S+/gi

export function deviceErrorText(message: string, engine?: string | null): string {
  if (message === AGENT_DID_NOT_ACCEPT && engine === 'claude') {
    return "Claude didn't start. Check the terminal, then try again."
  }
  if (CODEX_USAGE_LIMIT.test(message)) {
    const when = TRY_AGAIN_AT.exec(message)?.[1]?.trim()
    return when ? `Codex usage limit reached — try again ${when}.` : 'Codex usage limit reached.'
  }
  // Nothing engine-specific matched: still drop what the device can never act on.
  const stripped = message
    .replace(URL_CLAUSE, '')
    .replace(/\s*\(trace ID:\s*[0-9a-f]+\)/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,])/g, '$1')
    .trim()
  return stripped || message
}
