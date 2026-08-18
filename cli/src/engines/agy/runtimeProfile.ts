/**
 * agy's model/effort surface.
 *
 * Two facts settled on the real CLI (1.1.14):
 *  - the idle footer reads `Gemini 3.7 Flash · high` — display name, then the effort word;
 *  - `agy models` prints `<slug>\t<Display Name>` and bakes the effort into most slugs
 *    (`gemini-3.7-flash-high`), the way Cursor does, while ALSO accepting a separate
 *    `--effort low|medium|high`. The slug is what `--model` takes, so the slug is what we report.
 */

const EFFORTS = new Set(['low', 'medium', 'high'])

/** `agy models` rows: `gemini-3.7-flash-high\tGemini 3.7 Flash (High)`. */
export function parseAgyModelsOutput(output: string): string[] {
  const models: string[] = []
  const seen = new Set<string>()
  for (const line of output.split('\n')) {
    // The first line is a progress notice ("Fetching available models..."), which has no tab.
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._:@/-]*)\t/.exec(line)
    const slug = match?.[1]
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    models.push(slug)
  }
  return models
}

/**
 * The idle footer, right-aligned on the last pane row: `Gemini 3.7 Flash · high`.
 *
 * Reported as the slug rather than the display name so the chip matches what `agy models` and
 * `--model` speak: `Gemini 3.7 Flash` + `high` is `gemini-3.7-flash-high`. Where the catalog has no
 * effort-suffixed slug (Claude models on agy do not), the base slug is still correct.
 */
export function parseAgyFooterProfile(capture: string): { model: string; effort: string } | null {
  const lines = capture.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    // The footer is right-aligned, so the pane row carries unrelated status text on the left ("esc to
    // cancel", "? for shortcuts"). Anchor on the run of whitespace that separates them, or the model
    // name swallows whatever the CLI happened to print beside it.
    const match = /(?:^|\s{2,})([A-Za-z][A-Za-z0-9.]*(?: [A-Za-z0-9.]+)*)\s+[·|]\s+(low|medium|high)\s*$/.exec(lines[i].trimEnd())
    if (!match) continue
    const effort = match[2].toLowerCase()
    if (!EFFORTS.has(effort)) continue
    const base = match[1].trim().toLowerCase().replace(/\s+/g, '-')
    if (!base || base.length < 3) continue
    return { model: `${base}-${effort}`, effort }
  }
  return null
}

/**
 * Is the pane sitting idle?
 *
 * agy's transcript carries no end-of-turn marker at all - the `Stop` hook is the only one - so after a
 * daemon restart a folded history leaves the turn open forever, and the device tile spins with nothing
 * left to close it (measured: `turn_heartbeat` every second, indefinitely).
 *
 * The pane does know. Its bottom row reads `? for shortcuts` when the composer is free and
 * `esc to cancel` while a turn, a question or a permission prompt is live. Checked only at attach; the
 * live lifecycle stays on USER_INPUT -> Stop.
 */
export function agyPaneIdle(capture: string): boolean {
  const tail = capture.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '').split('\n').filter((line) => line.trim()).slice(-4).join('\n')
  if (/esc to cancel/i.test(tail)) return false
  return /\?\s*for shortcuts/i.test(tail)
}
