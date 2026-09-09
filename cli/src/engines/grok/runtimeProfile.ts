/**
 * Which model a Grok pane is running, read off the composer box it prints the answer on.
 *
 * Grok has moved this cell twice, and the shapes it has to survive were all measured on live panes
 * (2026-09-09):
 *
 *     ╰──────────────────── Grok 4.6 (xhigh) ─╯                 xAI's own model, with an effort
 *     ╰──── DeepSeek-V4-Flash-0731 · always-approve ─╯          a GRID model, on autonomous.ai
 *     ╰──────────── DeepSeek-V4-Flash-0731 ─╯                   the same, with nothing after it
 *     Grok 4.5 (medium) · always-approve                        older builds' standalone footer
 *
 * ⚠️ **The anchor is the BOX, not the word "Grok".** Keying on the vendor's name looked safe while
 * every model was one of xAI's, and it silently stopped being safe the moment an agent was pointed at
 * a grid: `DeepSeek-V4-Flash-0731` matches no `Grok …` pattern, so the scan fell through the box edge
 * and kept walking UP the pane until it reached the words "Grok 4.6, reasoning xhigh" inside the
 * TRANSCRIPT — a sentence the model had written about itself. Measured: a pane whose edge read
 * `DeepSeek-V4-Flash-0731` reported `grok-4.6`. Reading prose as configuration is worse than reading
 * nothing, because the app then states the wrong model with full confidence — the exact disagreement
 * the desktop's model pill exists to settle.
 *
 * So the box edge is matched FIRST and by its frame, which is a fact about the layout, and the model
 * is whatever that cell holds. `(effort)` is optional because a grid model has none. The old
 * standalone footer stays as a fallback for a machine on an older grok, and keeps its `Grok`-anchored
 * shape: with no box around it, the vendor's name is the only thing proving the line is chrome rather
 * than prose.
 */
export function parseGrokFooterProfile(capture: string): { model: string; effort: string } | null {
  const lines = capture.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '').split('\n')
  // The composer box's bottom edge, nearest the prompt: `╰──… <model> [(effort)] [· …] ─╯`.
  for (let i = lines.length - 1; i >= 0; i--) {
    const edge = /^\s*╰[─╌]*\s*([A-Za-z0-9][A-Za-z0-9 ._-]*?)\s*(?:\((low|medium|high|xhigh)\))?\s*(?:·[^╯]*?)?\s*[─╌]*╯\s*$/i
      .exec(lines[i])
    if (!edge) continue
    return {
      model: edge[1].trim().toLowerCase().replace(/\s+/g, '-'),
      // A grid model carries no effort of its own, and `auto` is what the rest of the profile calls
      // "the engine decides" — the same value pi and kilo report when their footer names no level.
      effort: (edge[2] ?? 'auto').toLowerCase(),
    }
  }
  // Older builds, which printed the cell as a line of its own with no box around it.
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /\b(Grok\s+[0-9][A-Za-z0-9 ._-]*?)\s+\((low|medium|high|xhigh)\)\s*(?:[·|]|$)/i
      .exec(lines[i])
    if (!match) continue
    return {
      model: match[1].trim().toLowerCase().replace(/\s+/g, '-'),
      effort: match[2].toLowerCase(),
    }
  }
  return null
}

/** `grok models` rows: `  * grok-4.5 (default)`. */
export function parseGrokModelsOutput(output: string): string[] {
  const models: string[] = []
  const seen = new Set<string>()
  for (const line of output.split('\n')) {
    const model = /^\s*\*\s+([^\s]+)(?:\s+\(default\))?\s*$/.exec(line)?.[1]
    if (!model || seen.has(model)) continue
    seen.add(model)
    models.push(model)
  }
  return models
}
