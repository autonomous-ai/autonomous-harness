/**
 * Muse Code runtime profile.
 *
 * Everything the chip needs is in `~/.config/muse/settings.json`, a flat JSON document — no pane
 * scraping, no catalog fetch. Verified content (muse 0.1.0-R708.1):
 *   {"schema_version":1,"provider":"meta","model":"muse-spark-1.2-contributor"}
 * `reasoning_effort` is absent until the user changes it; muse's own `--help` documents the default
 * as `high`, so an absent key is reported as that rather than as "unknown".
 */

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'])

export function parseMuseSettings(text: string | null): { model: string | null; effort: string | null } {
  if (!text) return { model: null, effort: null }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { model: null, effort: null } }
  const obj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const model = typeof obj.model === 'string' && obj.model ? obj.model : null
  const raw = typeof obj.reasoning_effort === 'string' ? obj.reasoning_effort.toLowerCase() : ''
  return { model, effort: EFFORTS.has(raw) ? raw : (model ? 'high' : null) }
}
