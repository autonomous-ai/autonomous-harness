/**
 * OpenCode model catalog → runtime-profile options.
 *
 * `opencode models` prints one `provider/model` per line on stdout, and that is the whole catalog:
 *
 *   opencode/ling-3.0-flash-free
 *   opencode-go/kimi-k3
 *   vibe/minimax/minimax-m3
 *
 * OpenCode has **no effort axis** — every option is `@auto`, and the label is the model alone.
 *
 * Switching is a picker (`/models`), but unlike Command Code's it accepts typed input, which is what
 * makes it safe to drive: type a filter, and act only once the list has narrowed to exactly ONE row.
 * Never arrow blindly through it — that is what the Command Code revert (2026-07-30) was about.
 * The filter matches across the model AND provider columns, which is how two rows that share a model
 * name (`MiniMax-M3` on OpenCode Go vs `MiniMax M3 (vibe)` on Vibe Gateway) are told apart.
 */

export interface OpencodeModelTarget {
  /** `<provider>/<model>` exactly as `opencode models` prints it. */
  id: string
  provider: string
  model: string
  /** What the picker filter is fed: model words, then provider words to disambiguate. */
  filter: string
}

export interface OpencodePickerRow {
  display: string
  provider: string
  /** OpenCode marks the running model with `●`. */
  current: boolean
}

function words(value: string): string {
  return value.replace(/[^a-z0-9.]+/gi, ' ').trim().toLowerCase()
}

function squash(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '').toLowerCase()
}

/** Parse `opencode models`; anything that is not a `provider/model` line is ignored. */
export function parseOpencodeModelsOutput(output: string): OpencodeModelTarget[] {
  const targets: OpencodeModelTarget[] = []
  const seen = new Set<string>()
  for (const rawLine of output.split('\n')) {
    const id = rawLine.trim()
    if (!/^[a-z0-9][\w.-]*\/[\w./-]+$/i.test(id) || seen.has(id)) continue
    seen.add(id)
    const slash = id.indexOf('/')
    const provider = id.slice(0, slash)
    const model = id.slice(slash + 1)
    // The picker shows the model's LAST segment (`minimax/minimax-m3` renders as "MiniMax M3"), so the
    // filter is built from that plus the provider.
    const leaf = model.slice(model.lastIndexOf('/') + 1)
    targets.push({ id, provider, model, filter: `${words(leaf)} ${words(provider)}`.trim() })
  }
  return targets
}

/**
 * Rows currently listed by the `/models` picker. The list is bounded above by its own header and below by
 * the "Connect provider" hint; reading only between them keeps the composer and the banner out.
 */
export function parseOpencodePickerRows(capture: string): OpencodePickerRow[] | null {
  const lines = capture.split('\n').map((line) => line.replace(/\s+$/, ''))
  // LAST header, not the first: a capture carries scrollback, so an earlier opening of the same picker is
  // usually still up there — reading from it parsed a stale, differently-filtered row set.
  const header = lines.findLastIndex((line) => /\bSelect model\b/.test(line))
  if (header < 0) return null
  const end = lines.findIndex((line, index) => index > header && /Connect provider/i.test(line))
  const rows: OpencodePickerRow[] = []
  for (const line of lines.slice(header + 1, end < 0 ? lines.length : end)) {
    const text = line.trim()
    if (!text) continue
    const current = text.startsWith('●')
    const cells = text.replace(/^●\s*/, '').split(/\s{3,}/).map((cell) => cell.trim()).filter(Boolean)
    // A model row is TWO cells — model and provider. Counting by position instead put the filter box
    // (one cell, the text just typed) in the row set, so a list narrowed to one model read as two rows
    // and every switch was refused. Provider group headings are single-cell too, and drop out here.
    if (cells.length < 2) continue
    rows.push({ display: cells[0], provider: cells[1], current })
  }
  return rows
}

/**
 * How many times the `/models` picker appears in a capture. A tmux capture includes scrollback, so the
 * only way to tell "the picker I just opened" from "a picker I opened a minute ago" is that the count went
 * up — see setOpencode.
 */
export function countOpencodePickers(capture: string): number {
  return capture.split('\n').filter((line) => /\bSelect model\b/.test(line)).length
}

/** True when a picker row is the catalog entry we are trying to select. */
export function opencodeRowMatches(target: OpencodeModelTarget, row: OpencodePickerRow): boolean {
  const leaf = target.model.slice(target.model.lastIndexOf('/') + 1)
  return squash(row.display).startsWith(squash(leaf))
    && squash(`${row.display} ${row.provider}`).includes(squash(target.provider))
}

/**
 * Resolve OpenCode's footer (`Build · MiniMax M3 (vibe) Vibe Gateway (Minimax)`) back to a catalog id.
 * Both halves are needed: the model name alone is ambiguous across providers, and the provider alone
 * cannot name a model. The longest model match wins so `MiMo V2.5 Pro` never resolves to `mimo-v2.5`.
 */
export function opencodeFooterModelId(capture: string, catalog: OpencodeModelTarget[]): string | null {
  const line = capture.split('\n').map((l) => l.trim()).reverse()
    .find((l) => /·/.test(l) && /\b(Build|Plan)\b/i.test(l))
  if (!line) return null
  const tail = squash(line.slice(line.indexOf('·') + 1))
  if (!tail) return null

  let best: { id: string; length: number } | null = null
  for (const entry of catalog) {
    const leaf = squash(entry.model.slice(entry.model.lastIndexOf('/') + 1))
    if (!leaf || !tail.startsWith(leaf)) continue
    if (!tail.includes(squash(entry.provider))) continue
    if (!best || leaf.length > best.length) best = { id: entry.id, length: leaf.length }
  }
  return best?.id ?? null
}
