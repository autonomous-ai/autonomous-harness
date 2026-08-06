/**
 * Hermes model catalog + reasoning effort → runtime-profile options.
 *
 * Hermes is the only one of the eight with no way to print its catalog: `hermes model` is interactive and
 * has no list flag. What it does have is the picker's own **disk cache** — the file `hermes model
 * --refresh` exists to wipe — so the catalog is read from there rather than by driving a TUI:
 *
 *   ~/.hermes/provider_models_cache.json
 *   { "copilot":   { "fp": …, "at": …, "models": ["gpt-5.4", …] },
 *     "anthropic": { "fp": …, "at": …, "models": ["claude-fable-5", …] } }
 *
 * Verified against the live picker (hermes 2026.07): its "Anthropic (13 models)" page lists exactly the
 * 13 ids this file holds, in the same order. The provider actually in use may be absent from the cache
 * (a `custom` gateway is configured here, and the picker shows it as its own one-model page), so the
 * model named by `config.yaml` is always offered too — see hermesConfigProfile.
 *
 * Both axes live in `~/.hermes/config.yaml`, and both are GLOBAL to the computer rather than per session:
 *
 *   model:  { default: minimax/minimax-m3, provider: custom }
 *   agent:  { reasoning_effort: medium }
 */

/** Levels hermes accepts for `agent.reasoning_effort`. */
export const HERMES_EFFORTS = new Set(['auto', 'low', 'medium', 'high'])
export const HERMES_EFFORT_LEVELS = ['low', 'medium', 'high'] as const

export interface HermesModelTarget {
  /** Model id as the picker lists it. */
  id: string
  /** Cache key of the provider page it belongs to (`anthropic`, `copilot`, …). */
  provider: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Read `provider_models_cache.json`. Each provider contributes its `models` array; anything that is not a
 * list of non-empty strings is skipped, so a half-written cache cannot invent models.
 */
export function parseHermesModelsCache(raw: unknown): HermesModelTarget[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const targets: HermesModelTarget[] = []
  const seen = new Set<string>()
  for (const [provider, blob] of Object.entries(raw as Record<string, unknown>)) {
    if (!blob || typeof blob !== 'object') continue
    const models = (blob as Record<string, unknown>).models
    if (!Array.isArray(models)) continue
    for (const entry of models) {
      const id = str(entry).trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      targets.push({ id, provider })
    }
  }
  return targets
}

/**
 * Model + reasoning effort out of `config.yaml`. Parsed by hand rather than with a YAML library: these are
 * two scalars at known paths, the adapter ships no YAML dependency, and the file is the user's — a parser
 * that only ever reads two keys cannot damage it.
 */
export function parseHermesConfig(yaml: string): { model: string | null; effort: string | null } {
  let section = ''
  let model: string | null = null
  let effort: string | null = null
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      section = line.replace(/:.*$/, '').trim()
      continue
    }
    // Only the top nesting level of a section, so a `models:` block elsewhere cannot be mistaken for it.
    const entry = /^\s{2}([a-z_]+):\s*(.+?)\s*$/i.exec(line)
    if (!entry) continue
    const value = entry[2].replace(/^["']|["']$/g, '')
    if (section === 'model' && entry[1] === 'default') model = value || null
    if (section === 'agent' && entry[1] === 'reasoning_effort') {
      const level = value.toLowerCase()
      effort = HERMES_EFFORTS.has(level) ? level : null
    }
  }
  return { model, effort }
}

/**
 * The model hermes shows in its status line (`⚕ minimax-m3 │ ctx -- │ …`). It is the SHORT name — the
 * config says `minimax/minimax-m3` while the status line says `minimax-m3` — so it is only used to notice
 * that a switch landed, never as the identity itself.
 */
export function hermesStatusModel(capture: string): string | null {
  const lines = capture.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /⚕\s*([^\s│|]+)/.exec(lines[i])
    if (match) return match[1]
  }
  return null
}

/** The row hermes marks with `❯` in a picker page, and every selectable row on that page. */
export function parseHermesPickerPage(capture: string): { rows: string[]; selected: string | null } | null {
  const lines = capture.split('\n')
  const top = lines.findLastIndex((line) => /Model Picker/i.test(line))
  if (top < 0) return null
  const rows: string[] = []
  let selected: string | null = null
  for (const line of lines.slice(top)) {
    // Rows live inside a box: `│ ❯ claude-fable-5    │`.
    const match = /^\s*│\s*(❯)?\s*(\S.*?)\s*│\s*$/.exec(line)
    if (!match) continue
    const label = match[2].replace(/\s*←\s*current\s*$/i, '').trim()
    if (!label || /^Current:/i.test(label)) continue
    rows.push(label)
    if (match[1]) selected = label
  }
  return rows.length ? { rows, selected } : null
}
