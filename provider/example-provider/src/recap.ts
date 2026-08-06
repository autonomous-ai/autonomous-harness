/**
 * Per-turn recap — what `agent.recap` hands back, and what rides the turn's own stream.
 *
 * The schema calls `recap` a *"headline-style summary of what the turn accomplished"*, and that is a
 * different thing from the session title: the title is what the user ASKED, the recap is what the
 * agent DID. This provider used to return the title, which meant the device tile read the user's own
 * prompt back at them.
 *
 * So a real recap is generated, by a **disposable one-shot** `claude --print`:
 *
 *  - no `--resume` — it must never touch the live session, or the summary itself lands in the
 *    transcript and the next turn's history contains a summary of the previous one;
 *  - a two-part answer, headline then blank line then body, which is the same contract the Autonomous
 *    product uses internally;
 *  - the caps are re-applied HERE, after the model returns, because a model asked for 15 words will
 *    sometimes give you 40.
 *
 * If the one-shot fails, times out, or is switched off, the turn's own output is excerpted instead.
 * A recap is a nicety: it must never be able to fail a turn that already succeeded.
 */
import { spawn } from 'node:child_process'

/** `recapEntry.recap` is capped at 200 by the schema; the device renders it on one line. */
export const RECAP_MAX_CHARS = 200
/** `recapEntry.body` is capped at 2000. */
export const BODY_MAX_CHARS = 2000

/** Long enough for a small model on a big turn, short enough that nothing waits on it. */
const SUMMARY_TIMEOUT_MS = 30_000

/**
 * Pinned for the same reason `DEFAULT_MODEL` is: a provider owns its model choice. A small, fast
 * model is the right one here — this is a one-line headline, not the work.
 */
export const DEFAULT_RECAP_MODEL = 'claude-haiku-4-5-20251001'

const PROMPT = `Summarise the assistant's turn below in TWO parts.

Part 1 — one line, at most 15 words: a newspaper headline for what the assistant ACCOMPLISHED. Not
what it was asked. Front-load the outcome. No trailing ellipsis, ever. No markdown, no quotes.

Then ONE blank line.

Part 2 — at most 120 words: what happened, in plain prose. No markdown, no bullet points.

Write in the same language the turn is written in. Output the two parts and nothing else.

--- THE TURN ---
`

export interface Recap {
  recap: string
  body: string
}

export interface SummariseOptions {
  claudeBin: string
  /** The agent's directory. The one-shot runs here so the model sees the same project context. */
  cwd: string
  /** The assistant's output for this turn. */
  turnText: string
  model?: string
  /** Skip the model entirely and go straight to the excerpt. */
  disabled?: boolean
}

/**
 * A recap for one turn. Never rejects, and never returns an empty headline: callers get either a real
 * summary, an excerpt of the turn, or null when the turn genuinely said nothing.
 */
export async function summariseTurn(opts: SummariseOptions): Promise<Recap | null> {
  const fallback = excerptRecap(opts.turnText)
  if (opts.disabled || !flatten(opts.turnText)) return fallback
  try {
    const raw = await oneShot(opts)
    return parseRecap(raw) ?? fallback
  } catch {
    // Deliberately silent about the cause here — the caller logs it with the taskId attached.
    return fallback
  }
}

/** Split the model's two-part answer on the FIRST blank line, then re-apply the caps. */
export function parseRecap(raw: string): Recap | null {
  const text = raw.trim()
  if (!text) return null
  const split = text.indexOf('\n\n')
  const head = split === -1 ? text : text.slice(0, split)
  const rest = split === -1 ? '' : text.slice(split + 2)
  const recap = cap(flatten(head), RECAP_MAX_CHARS)
  if (!recap) return null
  return { recap, body: cap(flatten(rest), BODY_MAX_CHARS) || recap }
}

/**
 * The no-model fallback: the turn's opening sentence as the headline, the turn as the body.
 *
 * An excerpt, not an invention. For an assistant reply the first sentence is very often the answer
 * itself, which makes this a genuinely useful tile rather than a placeholder.
 */
export function excerptRecap(turnText: string): Recap | null {
  const body = cap(flatten(turnText), BODY_MAX_CHARS)
  if (!body) return null
  const recap = cap(firstSentence(body), RECAP_MAX_CHARS)
  return recap ? { recap, body } : null
}

function oneShot(opts: SummariseOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      opts.claudeBin,
      // No --resume, no tools, no permissions flag: this reads text and writes text.
      ['--model', opts.model ?? DEFAULT_RECAP_MODEL, '--print'],
      { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env } },
    )
    let out = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('recap timed out')) }, SUMMARY_TIMEOUT_MS)
    child.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`claude exited ${code}`))
    })
    try {
      child.stdin?.end(`${PROMPT}${opts.turnText.slice(0, 50_000)}\n`)
    } catch (err) {
      clearTimeout(timer)
      reject(err)
    }
  })
}

/** Whitespace collapsed: the tile is one line, and newlines waste it. */
function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Hard cap at a word boundary where there is one, and NEVER with an ellipsis appended. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()
}

function firstSentence(text: string): string {
  const match = /[.!?](\s|$)/.exec(text)
  return match ? text.slice(0, match.index + 1) : text
}
