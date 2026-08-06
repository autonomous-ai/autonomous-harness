/**
 * Pi model catalog + thinking level → runtime-profile options.
 *
 * `pi --list-models` prints a fixed-width table on stdout (columns separated by runs of spaces):
 *
 *   provider  model               context  max-out  thinking  images
 *   vibe      minimax/minimax-m3  500K     65.5K    yes       no
 *
 * The `thinking` column is what makes pi's effort axis honest: only a model marked `yes` accepts a
 * reasoning depth, so effort rows are attached per model rather than assumed (verified live, pi 0.82).
 *
 * Pi separates the two axes in its UI, and both were driven end to end during the probe:
 *  - **model** — `/model <provider/model>` takes the target directly (its own autocomplete documents
 *    `<provider/model> — Select model (opens selector UI)`).
 *  - **thinking** — `/settings` → filter `thinking` → the "Thinking Level" list, a fixed ladder navigated
 *    with the arrow keys. There is no slash command for it.
 *
 * The idle footer carries **both**: `minimax/minimax-m3 • high`. That single line is the observation
 * source, and watching it flip `medium` → `high` is how the applied profile is confirmed.
 */

/** Pi's thinking ladder, in the order its settings list renders — the step count drives the arrow keys. */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const PI_EFFORTS = new Set<string>(['auto', ...PI_THINKING_LEVELS])

export interface PiModelTarget {
  /** `<provider>/<model>` as printed — also the argument for `/model`. */
  id: string
  provider: string
  /** The model column verbatim; it can itself contain a slash (`minimax/minimax-m3`). */
  model: string
  /** True when the `thinking` column says `yes`; only then are effort rows offered. */
  thinking: boolean
}

const HEADER_RE = /^\s*provider\s+model\s/i

/**
 * Parse `pi --list-models`. The header row and anything that does not have at least the provider, model
 * and thinking columns are skipped, so a future column or a wrapped warning line cannot invent a model.
 */
export function parsePiModelsOutput(output: string): PiModelTarget[] {
  const targets: PiModelTarget[] = []
  const seen = new Set<string>()
  for (const rawLine of output.split('\n')) {
    if (!rawLine.trim() || HEADER_RE.test(rawLine)) continue
    const cells = rawLine.trim().split(/\s{2,}/)
    if (cells.length < 5) continue
    const [provider, model] = cells
    if (!/^[\w.-]+$/.test(provider) || !model) continue
    // `thinking` is the second-to-last column (`images` closes the row).
    const thinking = /^yes$/i.test(cells[cells.length - 2] ?? '')
    const id = `${provider}/${model}`
    if (seen.has(id)) continue
    seen.add(id)
    targets.push({ id, provider, model, thinking })
  }
  return targets
}

/**
 * Model + thinking level out of pi's idle footer (`minimax/minimax-m3 • high`). Returns null rather than a
 * half-read pair, so a redraw mid-capture can never be mistaken for a profile change.
 */
export function parsePiFooterProfile(capture: string): { model: string; effort: string } | null {
  const lines = capture.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    // Two shapes in the wild: `minimax/minimax-m3 • high`, and `… • thinking off` once the level is off.
    const match = /(\S+)\s+•\s+(?:thinking\s+)?([a-z]+)\s*$/i.exec(lines[i].replace(/\s+$/, ''))
    if (!match) continue
    const effort = match[2].toLowerCase()
    if (!PI_EFFORTS.has(effort)) continue
    return { model: match[1], effort }
  }
  return null
}

/**
 * Steps to walk pi's "Thinking Level" list from one level to another: positive means Down. Null when
 * either end is not on the ladder, which the caller must treat as "do not drive the list blind".
 */
export function piThinkingSteps(from: string, to: string): number | null {
  const start = PI_THINKING_LEVELS.indexOf(from as typeof PI_THINKING_LEVELS[number])
  const end = PI_THINKING_LEVELS.indexOf(to as typeof PI_THINKING_LEVELS[number])
  if (start < 0 || end < 0) return null
  return end - start
}

/** The level pi marks as current in its Thinking Level list (`→ medium  Moderate reasoning`). */
export function parsePiThinkingSelection(capture: string): string | null {
  for (const line of capture.split('\n')) {
    const match = /^\s*[→>]\s+([a-z]+)\b/i.exec(line)
    if (!match) continue
    const level = match[1].toLowerCase()
    if (PI_EFFORTS.has(level) && level !== 'auto') return level
  }
  return null
}
