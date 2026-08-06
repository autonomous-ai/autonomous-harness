/**
 * Devin model catalog → runtime-profile options.
 *
 * `devin models list` prints the account's whole catalog on stdout, grouped by family — no TUI scraping
 * needed, which makes it the sturdiest of the five late engines:
 *
 *   Available models (38 families)
 *
 *   Claude Opus 5 (claude-opus-5)
 *     aliases: opus
 *     claude-opus-5-medium        Claude Opus 5 Medium  [$5 / MTok In · $25 / MTok Out]
 *     claude-opus-5-max-fast      Claude Opus 5 Max Fast  [$10 / MTok In · $50 / MTok Out]
 *   GPT-5.6 Sol (gpt-5.6-sol)
 *     gpt-5-6-sol-none            GPT-5.6 Sol No Thinking  […]
 *
 * Two things make it fit the existing vocabulary almost unchanged (verified live, devin 3000.3.22):
 *
 *  - **Effort is baked into the model id** (`-low|-medium|-high|-xhigh|-max|-none`, optionally trailed by
 *    `-fast`) — exactly cursor's scheme, so a family + an effort is the natural split and the id is
 *    reconstructed at apply time from `DevinModelTarget.id`.
 *  - **Applying is a one-liner**: `/model <id>` takes the id directly and answers in the pane with
 *    `✓ Model set to <Display Name>` or `✗ Model not available`, so there is no picker to drive.
 *
 * A family whose id carries no effort token (`adaptive`, `swe-1-6-slow`, and the opaque
 * `MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL`) is offered as a single `auto` row.
 */

/** Effort levels devin encodes in a model id. `none` is its "No Thinking" row. */
export const DEVIN_EFFORTS = new Set(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'])

export interface DevinModelTarget {
  /** Exact argument for `/model <id>` — e.g. `claude-opus-5-max-fast`. */
  id: string
  /** Identity of the model itself, effort removed: `claude-opus-5`, or `claude-opus-5-fast`. */
  modelKey: string
  /** Human label without the effort words: `Claude Opus 5`, `Claude Opus 5 Fast`. */
  label: string
  effort: string
}

const FAMILY_RE = /^(\S.*?)\s+\(([^()\s]+)\)\s*$/
const ROW_RE = /^\s{2,}(\S+)\s{2,}(.+?)\s*$/
const EFFORT_TOKENS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
/** Suffixes devin appends for its premium-throughput tier; both render as "Fast" in the display name. */
const FAST_TOKENS = new Set(['fast', 'priority'])

/**
 * Split a devin model id into the model's own identity and its effort, using the family slug from the
 * heading as the anchor.
 *
 * Anchoring matters: guessing from the trailing token alone broke on the real catalog. `-fast` is not the
 * only modifier — OpenAI families use `-priority` for the same tier (`gpt-5-6-sol-low-priority`,
 * displayed "GPT-5.6 Sol Low Thinking Fast") — so a naive rule read three distinct models as one
 * effort-less row. Conversely a family can legitimately end in something that merely looks like a
 * modifier (`swe-1.6-slow`). Stripping the known family prefix first removes both guesses.
 *
 * Without a usable family (devin also emits opaque ids like `MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL`) the
 * id is kept whole at `auto`, which is the safe reading: one row, applied verbatim.
 */
export function splitDevinModelId(
  id: string,
  familySlug?: string | null,
): { modelKey: string; effort: string; fast: boolean } {
  const family = familySlug ? familySlug.replace(/\./g, '-') : ''
  if (family && id !== family && id.startsWith(`${family}-`)) {
    return split(family, id.slice(family.length + 1).split('-'))
  }
  if (family && id === family) return { modelKey: id, effort: 'auto', fast: false }

  // The slug does not always prefix its own ids — devin reorders words in some families
  // (`Claude Fable 5 (claude-fable-5)` numbers its models `claude-5-fable-medium`). Falling back to a
  // trailing-token read keeps those families split by effort; without it all five rows collapsed onto one
  // `auto` key and four of the five options vanished as duplicates.
  const parts = id.split('-')
  const trailingFast = parts.length > 1 && FAST_TOKENS.has(parts[parts.length - 1].toLowerCase())
  const head = trailingFast ? parts.slice(0, -1) : parts
  const last = head[head.length - 1]?.toLowerCase() ?? ''
  if (head.length > 1 && EFFORT_TOKENS.has(last)) {
    return split(head.slice(0, -1).join('-'), [last, ...(trailingFast ? [parts[parts.length - 1]] : [])])
  }
  return { modelKey: id, effort: 'auto', fast: trailingFast }
}

function split(family: string, suffix: string[]): { modelKey: string; effort: string; fast: boolean } {
  const effortAt = suffix.findIndex((token) => EFFORT_TOKENS.has(token.toLowerCase()))
  const modifiers = suffix.filter((_, index) => index !== effortAt)
  return {
    modelKey: modifiers.length ? `${family}-${modifiers.join('-')}` : family,
    effort: effortAt >= 0 ? suffix[effortAt].toLowerCase() : 'auto',
    fast: modifiers.some((token) => FAST_TOKENS.has(token.toLowerCase())),
  }
}

/**
 * Parse `devin models list`. Rows outside a family block, the `aliases:` lines and the header are ignored;
 * a malformed line can only cost its own row.
 */
export function parseDevinModelsOutput(output: string): DevinModelTarget[] {
  const targets: DevinModelTarget[] = []
  const seen = new Set<string>()
  let family: { label: string; slug: string } | null = null

  for (const rawLine of output.split('\n')) {
    if (!rawLine.trim()) continue
    if (!/^\s/.test(rawLine)) {
      // Column-0 lines are family headings; the counter line ("Available models (38 families)") looks like
      // one too, so it is dropped by the slug shape below.
      const heading = FAMILY_RE.exec(rawLine)
      family = heading && /^[a-z0-9][a-z0-9._-]*$/i.test(heading[2])
        ? { label: heading[1], slug: heading[2] }
        : null
      continue
    }
    if (!family) continue
    if (/^\s*aliases:/i.test(rawLine)) continue
    const row = ROW_RE.exec(rawLine)
    if (!row) continue
    const id = row[1]
    const display = row[2].replace(/\s*\[[^\]]*\]\s*$/, '').trim()
    const { effort } = splitDevinModelId(id, family.slug)
    if (seen.has(id)) continue
    seen.add(id)
    const label = devinModelLabel(display || family.label, effort)
    targets.push({ id, modelKey: slug(label), label, effort })
  }
  return targets
}

const EFFORT_WORDS: Record<string, string> = {
  none: '(?:No\\s+Thinking|None)',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

/**
 * The model's human name, taken from devin's own display column with the effort hoisted out — so
 * `GPT-5.6 Sol Low Thinking Fast` at effort `low` reads `GPT-5.6 Sol Fast`.
 *
 * The display, not the family heading, is what distinguishes the variants devin packs into one family:
 * `GLM-5.2 High`, `GLM-5.2 Max`, `GLM-5.2 High 1M` all sit under "GLM-5.2", and labelling them by family
 * left three rows that read identically. Only the effort word the *id* proved is removed, which is what
 * keeps a family genuinely named after one (`Qwen 3.6 Max Preview`) intact.
 */
export function devinModelLabel(display: string, effort: string): string {
  const word = EFFORT_WORDS[effort]
  if (!word) return display
  return display
    .replace(new RegExp(`\\b${word}\\b(?:\\s+Thinking)?`, 'i'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim() || display
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || label
}

/** The `✓ Model set to <name>` / `✗ Model not available` line devin prints after `/model <id>`. */
export function devinModelCommandResult(capture: string): 'ok' | 'unavailable' | null {
  if (/✗\s*Model not available/i.test(capture)) return 'unavailable'
  if (/✓\s*Model set to\s+\S/i.test(capture)) return 'ok'
  return null
}

/**
 * Model shown in devin's idle footer — the bottom-left cell, e.g. `SWE-1.6 Slow`. It is the only
 * per-session record of the current model (the ATIF transcript only exists with `--export`), so it is what
 * `ingestPane` observes and what confirms an applied profile.
 */
export function devinFooterModel(capture: string): string | null {
  const lines = capture
    .replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '')   // defensive: callers strip ANSI, a raw capture would not match
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
  // Scan UP, and require the footer's shape. Taking the last non-empty line was wrong: devin renders its
  // slash-command menu BELOW the footer, so with `/model` open the "footer" read as
  // "● /model [adaptive|…] - Interactively choose a model", and nothing resolved.
  for (let i = lines.length - 1, scanned = 0; i >= 0 && scanned < 12; i--) {
    const line = lines[i]
    if (!line.trim()) continue
    scanned++
    if (/^[─—\-]+$/.test(line.trim())) continue // the rule above the footer
    // The footer is one row of TWO cells separated by padding: the model on the left, a hint on the right.
    // The hint ROTATES ("See all keyboard shortcuts…", "Type while the agent works…"), so it cannot be the
    // anchor — the two-cell structure is, and it is also what tells the footer apart from an overlay line.
    // A left cell that names no known model is rejected upstream, in devinModelKeyForLabel.
    const cells = line.split(/\s{3,}/).map((cell) => cell.trim()).filter(Boolean)
    if (cells.length < 2) continue
    return cells[0] || null
  }
  return null
}
