/**
 * Device turn-recap summarizer — self-contained port of the brain's `summarizeTurnText`
 * Summarizes one turn's assistant text into the
 * device's `recap\n\nsummary` shape (recap ≤15 words, summary ≤100) via a disposable one-shot
 * from the same CLI engine as the interactive session. Honors an AbortSignal so a newer turn can
 * supersede a stale recap.
 */

import { existsSync, mkdirSync } from 'fs'
import { unlink } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { env } from '../config/env.js'
import type { AgentEngine } from '../engines/types.js'
import {
  cleanupCursorOneShotSession,
  configureOneShotPool,
  runClaudeOneShot,
  runCodexOneShot,
  runCursorOneShot,
  runOpencodeOneShot,
  runPiOneShot,
  runHermesOneShot,
  runCommandCodeOneShot,
  runDevinOneShot,
  runMuseOneShot,
  setOneShotPoolActiveCounts,
  setOneShotPoolDeviceConnected,
  shutdownOneShotPool,
} from './oneshot.js'

const SUMMARY_MAX_WORDS = 120
const RECAP_MAX_WORDS = 15 // ~12-15 words; ONE complete sentence (20 overflowed the device tile).
const MAX_INPUT_CHARS = 50_000
const SUMMARY_SCRATCH = join(env.ADAPTER_DATA_DIR, 'summary-scratch')

function ensureSummaryScratch(): string {
  if (!existsSync(SUMMARY_SCRATCH)) mkdirSync(SUMMARY_SCRATCH, { recursive: true })
  return SUMMARY_SCRATCH
}

configureOneShotPool({
  cwd: ensureSummaryScratch(),
  claudeModel: env.SUMMARY_MODEL,
  codexModel: env.CODEX_SUMMARY_MODEL,
  cursorModel: env.CURSOR_SUMMARY_MODEL,
  opencodeModel: env.OPENCODE_SUMMARY_MODEL,
  piModel: env.PI_SUMMARY_MODEL,
  commandcodeModel: env.COMMANDCODE_SUMMARY_MODEL,
  effort: env.SUMMARY_EFFORT,
})

export function syncSummaryPoolSessions(sessions: Array<{ engine: AgentEngine }>): void {
  const counts = { claude: 0, codex: 0, cursor: 0, opencode: 0, pi: 0, commandcode: 0 }
  for (const session of sessions) {
    // Hermes, Devin and Muse take their recap prompt as argv (`muse exec <prompt>`), so they cannot be
    // pre-warmed the way a stdin-fed CLI can — no pooled worker for them.
    if (session.engine === 'hermes' || session.engine === 'devin' || session.engine === 'muse') continue
    counts[session.engine]++
  }
  setOneShotPoolActiveCounts(counts)
}

export function setSummaryPoolDeviceConnected(connected: boolean): void {
  setOneShotPoolDeviceConnected(connected)
}

export function shutdownSummaryPool(): void {
  shutdownOneShotPool()
}

/**
 * A coarse WRITING-SYSTEM fingerprint — deliberately not a language identifier. Naming languages meant a
 * hand-maintained word list per language and a drift check that only ever ran in one direction (it caught
 * "should be English, came back Vietnamese" but never the reverse). Comparing which scripts a text uses,
 * and how accented its Latin part is, catches "answered in a different language" for any pair of languages
 * with nothing to maintain.
 */
interface ScriptProfile {
  /** Share of letters per writing system, e.g. { Latin: 0.9, Han: 0.1 }. */
  shares: Record<string, number>
  /** Share of Latin letters carrying a diacritic — what separates Vietnamese/Polish/Turkish from English. */
  accented: number
  letters: number
}

const SCRIPTS: Array<[string, RegExp]> = [
  ['Han', /\p{Script=Han}/u],
  ['Hiragana', /\p{Script=Hiragana}/u],
  ['Katakana', /\p{Script=Katakana}/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Latin', /\p{Script=Latin}/u],
]

function scriptProfile(text: string): ScriptProfile {
  const counts: Record<string, number> = {}
  let letters = 0
  let accented = 0
  for (const ch of text || '') {
    if (!/\p{L}/u.test(ch)) continue
    const hit = SCRIPTS.find(([, re]) => re.test(ch))
    if (!hit) continue
    letters++
    counts[hit[0]] = (counts[hit[0]] || 0) + 1
    // NFD splits an accented letter into base + combining mark(s); a bare ASCII letter never does.
    if (hit[0] === 'Latin' && /\p{M}/u.test(ch.normalize('NFD'))) accented++
  }
  const shares: Record<string, number> = {}
  if (letters) for (const [k, v] of Object.entries(counts)) shares[k] = v / letters
  const latin = counts.Latin || 0
  return { shares, accented: latin ? accented / latin : 0, letters }
}

/**
 * True when `out` reads as a DIFFERENT language than `src`: it dropped (or invented) a writing system the
 * other side relies on, or its Latin text lost (or gained) diacritics wholesale. Thresholds are loose on
 * purpose — quoting a product name or a code identifier in another script must not trip it.
 */
function languageDrifted(src: string, out: string): boolean {
  const a = scriptProfile(src)
  const b = scriptProfile(out)
  if (a.letters < 12 || b.letters < 12) return false // too little signal to judge
  for (const [name] of SCRIPTS) {
    if (name === 'Latin') continue
    const sa = a.shares[name] || 0
    const sb = b.shares[name] || 0
    if (sa >= 0.15 && sb <= 0.02) return true // the source is written in it, the output is not
    if (sb >= 0.15 && sa <= 0.02) return true // the output switched into a script the source never used
  }
  const latinBoth = (a.shares.Latin || 0) >= 0.5 && (b.shares.Latin || 0) >= 0.5
  if (latinBoth && a.accented >= 0.08 && b.accented <= 0.02) return true
  if (latinBoth && b.accented >= 0.08 && a.accented <= 0.02) return true
  return false
}

/**
 * Cap the SUMMARY the way the recap is capped: never an ellipsis, always a finished sentence. Prefers to
 * cut at the last sentence terminator inside the budget — which works for any language that ends a sentence
 * with one — and only falls back to the clause/connector trim when there is none.
 */
function capComplete(text: string, max: number): string {
  let t = (text || '').replace(/…|\.{2,}/g, ' ').replace(/\s+/g, ' ').trim()
  const words = t.split(/\s+/)
  if (words.length > max) {
    const head = words.slice(0, max).join(' ')
    const m = [...head.matchAll(/[.!?。！？]/gu)].pop()
    t = m && m.index !== undefined && m.index > head.length * 0.4
      ? head.slice(0, m.index + 1)
      : head
  }
  if (!/[.!?。！？]$/u.test(t)) {
    let prev: string
    do { prev = t; t = t.replace(DANGLING_TAIL, '').replace(/[\s,;:–—-]+$/, '').trim() } while (t !== prev)
  }
  return t
}

// Trailing connectors (VN + EN) a recap must never END on — cutting here would leave it dangling
// ("…2-1, nhờ"). Stripped from the tail if a hard cut lands on one. Prefix with a separator rather
// than \b: JS \b is ASCII-only, so it fails on a Vietnamese word ending in a diacritic (e.g. "nhờ").
const DANGLING_TAIL =
  /[\s,;:–—-]+(nhờ|vì|do|bởi|để|và|hoặc|nhưng|mà|với|của|cho|khi|nếu|thì|theo|cùng|rằng|là|nên|and|or|but|with|because|since|so|to|for|of|in|on|at|the|a|an)[\s,;:–—-]*$/i

/**
 * Cap the RECAP to a clean newspaper-style headline: ONE line, ≤ max words, and NEVER any "…". The model is
 * told to write a complete headline within budget; this is the hard guard. If it overshoots we cut at the
 * last clause boundary and strip any dangling connector so it still ends on a complete point — but we do
 * NOT append an ellipsis (a headline reads as finished, not truncated).
 */
function capRecap(text: string, max: number): string {
  // Drop any ellipsis the model emitted (leading/trailing/mid) — headlines never carry "…".
  let t = text.replace(/…|\.{2,}/g, ' ').replace(/\s+/g, ' ').trim()
  const words = t.split(/\s+/)
  if (words.length > max) {
    let head = words.slice(0, max).join(' ')
    const b = Math.max(head.lastIndexOf(','), head.lastIndexOf(';'), head.lastIndexOf('. '))
    if (b > head.length * 0.5) head = head.slice(0, b)
    t = head
  }
  // Strip a dangling connector / trailing punctuation so the headline ends on a complete point. No "…".
  let prev: string
  do { prev = t; t = t.replace(DANGLING_TAIL, '').replace(/[\s,;:–—-]+$/, '').trim() } while (t !== prev)
  return t
}

// The CLI mangles a cwd into its projects-dir name (every non-alphanumeric → '-'); used to delete
// the throwaway one-shot transcript so it never lingers under the watched projects root.
function scratchTranscript(scratch: string, id: string): string {
  const mangled = scratch.replace(/[^a-zA-Z0-9]/g, '-')
  return join(homedir(), '.claude', 'projects', mangled, `${id}.jsonl`)
}

async function cleanupRecapSession(engine: AgentEngine, scratch: string, sessionId: string | null): Promise<void> {
  if (!sessionId) return
  if (engine === 'claude') {
    await unlink(scratchTranscript(scratch, sessionId)).catch(() => {})
    return
  }
  if (engine === 'cursor') await cleanupCursorOneShotSession(sessionId)
}

export async function summarizeTurnText(
  text: string,
  signal?: AbortSignal,
  userMessage?: string,
  engine: AgentEngine = 'claude',
): Promise<string | null> {
  let last = (text || '').trim()
  if (!last) return null
  if (last.length > MAX_INPUT_CHARS) last = last.slice(-MAX_INPUT_CHARS)

  // If we know the user's request for this turn, tell the recap to LEAD with the direct answer to it
  // (asked a price → give the price), not a generic characterization of the topic — the answer text
  // still comes from the assistant's message. Whitespace-flattened + capped so a long paste can't
  // dominate the prompt.
  const ask = (userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 400)
  const askBlock = ask
    ? `The user's request this turn was: «${ask}». Use this request as the turn's language signal ` +
      `and context, but take all facts from the assistant message below. Your recap MUST lead with the DIRECT answer to that ` +
      `exact request — the specific fact, number, decision or result they asked for (asked a price → the ` +
      `price; asked yes/no → the verdict; asked "how" → the key step), taken from the assistant's message ` +
      `below, then a few words of context. Do NOT lead with a generic characterization of the topic, and ` +
      `do NOT invent anything not in the message.\n\n`
    : ''

  // Kept in sync with the hosted runtime’s recap. Guards two failure
  // modes: (1) META-TASK LEAK — the summarizer writing its own intent ("I need to convert…") into the
  // recap instead of re-voicing the content; (2) WRONG LANGUAGE — the recap drifting away from the
  // source message's language.
  const prompt =
    `LANGUAGE RULE (most important): choose the output language ONLY from the user's request for this ` +
    `turn and the assistant message between the --- markers below. If both are in English, output English. ` +
    `If they use another language, output that language. If they mix languages, preserve that mix naturally. ` +
    `Never switch to a language that does not appear in the user's request or the assistant message. Ignore ` +
    `previous conversation, account locale, environment locale, and the language of these instructions.\n\n` +
    askBlock +
    `Between the --- markers below is a message the assistant already sent to the user. Re-voice its ` +
    `CONTENT back to the user, in the FIRST PERSON as that same assistant (its own "I"). You are ONLY ` +
    `restating what the message says — you are NOT performing any task and NOT describing this ` +
    `summarizing job. NEVER write a meta or intent sentence such as "I need to…", "I will ` +
    `summarize/convert/translate…", "let me…", or "the message is about…". Output ONLY these two parts ` +
    `separated by a blank line, with no headings, labels or preamble:\n` +
    `Part 1 (recap) — a NEWSPAPER HEADLINE for this turn: ONE punchy, self-contained line of at most ` +
    `${RECAP_MAX_WORDS} words. State the SINGLE most important thing the user needs from this turn — the ` +
    `direct answer, decision, result or recommendation to their request (what was said or done, NOT a plan ` +
    `of what you will do next, NOT a description of the topic) — and FRONT-LOAD it so the first few words ` +
    `alone carry the point (only the opening may be shown). Headline voice: active, specific, punchy; NO ` +
    `hedging or throat-clearing (never open with "I think…", "This is a close one…", "It is about…", ` +
    `"Regarding…") — conclusion first, then at most a few words of why; if the source hedges, still commit ` +
    `to its leaning up front. It MUST be COMPLETE within ${RECAP_MAX_WORDS} words: never cut off mid-idea, ` +
    `never end on a connector/preposition/unfinished clause, and NEVER use "…", "..." or any ellipsis or ` +
    `trailing dots. If you would run long, TIGHTEN the wording into a shorter headline — do not truncate. ` +
    `Do NOT enumerate long lists — give the gist (use counts like "4 forwards" instead of naming everyone). ` +
    `PLAIN TEXT ONLY: no emoji, markdown, tables, bullets or URLs.\n` +
    `Part 2 (after a blank line) — a fuller summary: present tense, condensed to the key ` +
    `points, markedly shorter than the original; scale to the source (a short message → a ` +
    `sentence or two, a long/detailed one → a short recap), never a full restatement, at most ` +
    `${SUMMARY_MAX_WORDS} words. Here you MAY include the important specifics/lists that the ` +
    `recap omitted. Like the recap it MUST read as finished: end on a COMPLETE sentence, never mid-idea or ` +
    `on a dangling connector, and NEVER use "…", "..." or any ellipsis or trailing dots. If you would run ` +
    `long, drop the least important detail — do not truncate.\n` +
    `LAY PART 2 OUT SO IT CAN BE READ. Use LINE BREAKS, and let the SOURCE decide where they go — there ` +
    `is no fixed template to fill:\n` +
    `  • material that already has its own lines KEEPS them — a poem or lyric one line per line, steps ` +
    `or a short list one per line. Never run such items together into a single sentence.\n` +
    `  • a shift to a DIFFERENT point starts a new line.\n` +
    `  • one continuous explanation of ONE thing stays as ONE block. Do not break for the sake of ` +
    `breaking; a wrongly chopped paragraph is worse than an unbroken one.\n` +
    `A LINE BREAK IS THE ONLY FORMATTING YOU HAVE. Still no markdown, no bullet characters, no "-" or ` +
    `"*" or "1." at the start of a line, no headings, no tables, no emoji — they are shown literally, ` +
    `as the characters you typed. Break the line and start the text.\n` +
    `For both parts, restate the substance itself; do NOT narrate the process (avoid ` +
    `"I wrote/did…").\n\n---\n${last}\n\n---\n` +
    `IMPORTANT: before you answer, re-check the user's request and source message. Write BOTH parts — ` +
    `INCLUDING the one-line recap — in their language and register. Do NOT translate or switch to any ` +
    `language absent from those two inputs. Keep technical terms, code, and product names as-is.`

  const scratch = ensureSummaryScratch()

  const t0 = Date.now()
  const model = engine === 'claude'
    ? env.SUMMARY_MODEL
    : engine === 'codex'
      ? env.CODEX_SUMMARY_MODEL
      : engine === 'cursor'
        ? env.CURSOR_SUMMARY_MODEL
        : engine === 'pi'
          ? env.PI_SUMMARY_MODEL
          : engine === 'hermes'
            ? env.HERMES_SUMMARY_MODEL
            : engine === 'commandcode'
              ? env.COMMANDCODE_SUMMARY_MODEL
              : engine === 'devin'
                ? env.DEVIN_SUMMARY_MODEL
                : engine === 'muse'
                  ? env.MUSE_SUMMARY_MODEL
                  : env.OPENCODE_SUMMARY_MODEL
  const effort = engine === 'cursor' ? 'model-defined' : env.SUMMARY_EFFORT
  console.log(`[recap] one-shot ${engine} · model=${model} · effort=${effort} · inputChars=${last.length}${ask ? ' · withAsk' : ''}`)
  const run = engine === 'claude'
    ? runClaudeOneShot
    : engine === 'codex'
      ? runCodexOneShot
      : engine === 'cursor'
        ? runCursorOneShot
        : engine === 'pi'
          ? runPiOneShot
          : engine === 'hermes'
            ? runHermesOneShot
            : engine === 'commandcode'
              ? runCommandCodeOneShot
              : engine === 'devin'
                ? runDevinOneShot
                : engine === 'muse'
                  ? runMuseOneShot
                  : runOpencodeOneShot
  let r = await run({ prompt, model, effort: env.SUMMARY_EFFORT, cwd: scratch, signal })
  console.log(`[recap] one-shot returned in ${Date.now() - t0}ms · rawLen=${(r.text || '').length}`)
  await cleanupRecapSession(engine, scratch, r.sessionId)
  // Language check without naming a language: compare the writing system of the output against the inputs
  // it was supposed to mirror. Works in both directions and for any language pair.
  if (languageDrifted(`${ask} ${last}`, r.text || '')) {
    console.warn('[recap] one-shot language drift detected · retrying')
    r = await run({
      prompt: prompt + `\n\nRETRY: your previous output was NOT in the same language as the user's request ` +
        `and the assistant message. Rewrite it in exactly that language — same script and same diacritics — ` +
        `preserving the required two-part format.`,
      model,
      effort: env.SUMMARY_EFFORT,
      cwd: scratch,
      signal,
    })
    await cleanupRecapSession(engine, scratch, r.sessionId)
  }

  // Cap the recap (complete-reading) and body independently.
  const trimmed = (r.text || '').trim()
  const nl = trimmed.indexOf('\n\n')
  const recap = capRecap((nl >= 0 ? trimmed.slice(0, nl) : trimmed).trim(), RECAP_MAX_WORDS)
  const body = capComplete((nl >= 0 ? trimmed.slice(nl + 2) : '').trim(), SUMMARY_MAX_WORDS)
  if (!recap) { console.warn('[recap] one-shot produced no usable recap (empty after cap)'); return null }
  return body ? `${recap}\n\n${body}` : recap
}
