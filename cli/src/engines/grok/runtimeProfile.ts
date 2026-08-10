/** Grok's idle footer: `Grok 4.5 (medium) · always-approve`. */
export function parseGrokFooterProfile(capture: string): { model: string; effort: string } | null {
  const lines = capture.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /\b(Grok\s+[0-9][A-Za-z0-9 ._-]*)\s+\((low|medium|high|xhigh)\)\s*[·|]/i.exec(lines[i])
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
