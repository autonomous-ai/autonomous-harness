/**
 * What a harness is called before anything better is known, and what its new project folder is called.
 *
 * A harness is named by who it is and when it started — "Codex harness 9-17 15:26", "Blender harness
 * 9-17 15:30" — and its folder the same way, `~/harnesses/codex-2026-09-17-15-26`. That replaced
 * `harness-N`, which said nothing and had to be counted: a name and a folder numbered by two counters
 * drifted apart (a tab named harness-43 over a terminal in harness-42) and stayed apart.
 *
 * It is a stand-in. Once the engine titles the session, the title is the name (registry.ts,
 * projectDisplayName), and a rename fixes a name for good.
 */
import type { AgentEngine } from '../engines/types.js'

/** The app's own words for each engine (desktop/lib/widgets/engine_identity.dart). */
const ENGINE_LABELS: Record<AgentEngine, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  pi: 'Pi',
  hermes: 'Hermes',
  commandcode: 'Command Code',
  devin: 'Devin',
  muse: 'Muse',
  amp: 'Amp',
  kilo: 'Kilo',
  grok: 'Grok',
  agy: 'Antigravity',
  copilot: 'Copilot',
  terminal: 'Terminal',
}

export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine as AgentEngine] ?? engine
}

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * "Codex harness 9-17 15:26" — local time on a 24-hour clock. No zero where it says nothing (month,
 * day and hour: "9-3 9:05"); minutes and seconds always two digits, as a clock reads.
 */
export function automaticAgentName(label: string, at: Date, withSeconds = false): string {
  const clock = `${at.getHours()}:${pad(at.getMinutes())}${withSeconds ? `:${pad(at.getSeconds())}` : ''}`
  return `${label.trim() || 'Agent'} harness ${at.getMonth() + 1}-${at.getDate()} ${clock}`
}

/**
 * A name Harness gave, as opposed to one somebody chose: `<agent> harness M-D HH:MM[:SS]`, or the
 * `harness-N` / `agent-N` of earlier daemons. Only these give way to the engine's session title.
 */
const AUTOMATIC_NAME_RE = /^(?:(?:harness|agent)-[1-9]\d*|.+ harness \d{1,2}-\d{1,2} \d{1,2}:\d{2}(?::\d{2})?)$/

export function isAutomaticName(name: string | null | undefined): boolean {
  return !!name && AUTOMATIC_NAME_RE.test(name)
}

/** "codex-2026-09-03-09-05": the label in lowercase words, then the local date and time, every part
 *  two digits so a folder listing sorts in the order the harnesses were made. */
export function projectFolderName(label: string, at: Date, withSeconds = false): string {
  const slug = label.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'harness'
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}${withSeconds ? `-${pad(at.getSeconds())}` : ''}`
  return `${slug}-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${time}`
}
