/**
 * Command Code model catalog + reasoning effort → runtime-profile options.
 *
 * Switching Command Code from the device was built and REVERTED once (owner call, 2026-07-30) because
 * v1.4/1.5 offered no way to do it safely: the `/model` dialog ignored printable characters, so the only
 * route was arrow-driving a 49-row picker, and opening it mid-turn wedged the CLI. **v1.6.0 removes both
 * obstacles**, which is why this exists again — verified by hand on 1.6.0 before a line was written:
 *
 *   commandcode --list-models        → the whole catalog on stdout (50 models), no picker involved
 *   /model moonshotai/kimi-k2.6      → applied; config.json flipped to "moonshotai/Kimi-K2.6"
 *   /effort high                     → applied, or refused in words:
 *                                      "◼ Reasoning effort not supported for Kimi K2.6."
 *
 * So both axes are single commands with an argument, exactly like devin's — no picker is ever opened and
 * nothing has to be driven blind.
 *
 * Catalog shape:
 *
 *   Available models  ·  50 models
 *
 *   Open Source
 *
 *   deepseek/deepseek-v4-flash           fast hybrid-attention reasoning (default)
 *   moonshotai/kimi-k3                   long-horizon coding & knowledge work with 1M context
 *
 *   Anthropic
 *
 *   claude-sonnet-5                      best combo of speed & intelligence (recommended)
 *
 * Note the id may or may not carry a vendor prefix. The PROFILE stores the short name (the part after the
 * last `/`) because the device labels a model by splitting on `-`/`_` and never on `/`, and because that
 * is what `ingestCommandcode` already observes from the transcript. `/model` needs the full id back, so
 * the mapping is kept per session (see commandcodeTarget).
 */

/**
 * Levels offered per model. Command Code does not publish which models take which — `--list-models` says
 * nothing, and the per-model set really does differ (DeepSeek V4 Flash offers Default/high/max, Kimi K2.6
 * offers none). Offering the union and letting the CLI answer in words is the honest trade: a wrong pick
 * fails fast and explicitly instead of being silently ignored.
 */
export const COMMANDCODE_EFFORTS = new Set(['auto', 'low', 'medium', 'high', 'max'])
export const COMMANDCODE_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const

export interface CommandcodeModelTarget {
  /** Full id as `--list-models` prints it — the argument for `/model`. */
  id: string
  /** Id after the last `/` — what the profile stores and the device labels. */
  shortId: string
  /** Section heading it appeared under ("Open Source", "Anthropic", …). */
  section: string
  isDefault: boolean
}

const ROW_RE = /^(\S+)\s{2,}(.+?)\s*$/
const HEADER_RE = /^Available models\b/i

/** Parse `commandcode --list-models`. Section headings and the counter line are not models. */
export function parseCommandcodeModelsOutput(output: string): CommandcodeModelTarget[] {
  const targets: CommandcodeModelTarget[] = []
  const seen = new Set<string>()
  let section = ''
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim() || HEADER_RE.test(line)) continue
    const row = ROW_RE.exec(line)
    if (!row) {
      // A lone left-aligned phrase is a section heading; a model row always has a description column.
      section = line.trim()
      continue
    }
    const id = row[1]
    if (!/^[a-z0-9][\w.-]*(?:\/[\w.-]+)*$/i.test(id) || seen.has(id)) continue
    seen.add(id)
    targets.push({
      id,
      shortId: id.slice(id.lastIndexOf('/') + 1),
      section,
      isDefault: /\(default\)\s*$/.test(row[2]),
    })
  }
  return targets
}

/**
 * What Command Code printed in answer to `/effort <level>`. It refuses in words rather than silently, so
 * an unsupported level is reported as such instead of timing out.
 */
export function commandcodeEffortRefusal(capture: string): string | null {
  // Stop at the line end, not at the first `.` — model names carry dots ("Kimi K2.6"), and cutting there
  // truncated the message mid-name.
  const match = /◼?\s*(Reasoning effort not supported for .*)$/im.exec(capture)
  return match ? match[1].trim().replace(/\.$/, '') : null
}

/**
 * How many effort refusals a capture holds. A tmux capture carries scrollback, so "is there a refusal?"
 * answers yes off an old one; only an increase means THIS command was refused.
 */
export function countCommandcodeRefusals(capture: string): number {
  return capture.split('\n').filter((line) => commandcodeEffortRefusal(line) !== null).length
}

/**
 * The models line Command Code prints in its session banner (`# models: kimi-k2.6 · taste-1`). It names
 * the running model in SHORT form, which is the same form the profile stores.
 */
export function commandcodeBannerModel(capture: string): string | null {
  const lines = capture.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^#\s*models:\s*([^\s·]+)/.exec(lines[i].trim())
    if (match) return match[1]
  }
  return null
}
