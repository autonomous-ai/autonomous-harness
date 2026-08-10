/**
 * Kilo model catalog → runtime-profile options.
 *
 * `kilo models` prints one `provider/model` per line on stdout and that is the whole catalog. Measured on
 * kilo 7.4.20 (299 lines, and it runs WITHOUT being logged in, unlike `kilo profile`):
 *
 *   kilo/~anthropic/claude-opus-latest        ← floating alias; note the `~`
 *   kilo/stepfun/step-3.7-flash:free          ← variant suffix; note the `:`
 *   kilo/ai21/jamba-large-1.7
 *
 * Every id measured here begins with the single provider `kilo` and carries the vendor as the first
 * segment of the MODEL, so the leaf-plus-provider filter below reduces to the leaf in practice.
 *
 * Kilo has no separate effort axis in the catalog — every option is `@auto`. It does expose a reasoning
 * `--variant` (`high`, `max`, `minimal`) on `kilo run`, and the real session on this machine recorded
 * `variant: 'medium'` on its message rows, so an effort axis DOES exist somewhere in the product; it is
 * simply not in this catalog and is not wired here.
 *
 * INHERITED, NOT MEASURED ON KILO: everything below about the interactive picker — that it is `/models`,
 * that its header reads `Select model`, that it ends at a `Connect provider` hint, that `●` marks the
 * running model, and that typing filters it. All of that was read off an opencode pane. Driving a picker
 * on unverified anchors is how the Command Code revert (2026-07-30) happened, so the rule that made it
 * safe there holds doubly here: type a filter and act only once exactly ONE row remains, never arrow
 * blindly. Confirm the anchors on a real kilo pane before trusting the switch path.
 */

export interface KiloModelTarget {
  /** `<provider>/<model>` exactly as `kilo models` prints it. */
  id: string
  provider: string
  model: string
  /** What the picker filter is fed: model words, then provider words to disambiguate. */
  filter: string
}

export interface KiloPickerRow {
  display: string
  provider: string
  /** Kilo marks the running model with `●`. */
  current: boolean
}

function words(value: string): string {
  return value.replace(/[^a-z0-9.]+/gi, ' ').trim().toLowerCase()
}

function squash(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '').toLowerCase()
}

/**
 * Parse `kilo models`; anything that is not a `provider/model` line is ignored.
 *
 * The character class carries `~` and `:`, which opencode's does not. Measured on kilo 7.4.20:
 * `kilo models` prints 299 ids and opencode's class matches only 276 of them. The 23 it drops are the
 * 11 `kilo/~vendor/model-latest` aliases (the floating "latest" pointers — the ones a person is most
 * likely to pick by name) and 12 `…:free` / `:discounted` / `:thinking` variants. Among the dropped was
 * `kilo/stepfun/step-3.7-flash:free`, the model the real session on this machine was actually running —
 * so with opencode's class the picker would have silently omitted the user's own current model, which is
 * exactly the no-error-no-log failure the model-picker site is known for.
 */
export function parseKiloModelsOutput(output: string): KiloModelTarget[] {
  const targets: KiloModelTarget[] = []
  const seen = new Set<string>()
  for (const rawLine of output.split('\n')) {
    const id = rawLine.trim()
    if (!/^[a-z0-9][\w.-]*\/[\w.~:/-]+$/i.test(id) || seen.has(id)) continue
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
export function parseKiloPickerRows(capture: string): KiloPickerRow[] | null {
  const lines = capture.split('\n').map((line) => line.replace(/\s+$/, ''))
  // LAST header, not the first: a capture carries scrollback, so an earlier opening of the same picker is
  // usually still up there — reading from it parsed a stale, differently-filtered row set.
  const header = lines.findLastIndex((line) => /\bSelect model\b/.test(line))
  if (header < 0) return null
  const end = lines.findIndex((line, index) => index > header && /Connect provider/i.test(line))
  const rows: KiloPickerRow[] = []
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
 * up — see setKilo.
 */
export function countKiloPickers(capture: string): number {
  return capture.split('\n').filter((line) => /\bSelect model\b/.test(line)).length
}

/** True when a picker row is the catalog entry we are trying to select. */
export function kiloRowMatches(target: KiloModelTarget, row: KiloPickerRow): boolean {
  const leaf = target.model.slice(target.model.lastIndexOf('/') + 1)
  return squash(row.display).startsWith(squash(leaf))
    && squash(`${row.display} ${row.provider}`).includes(squash(target.provider))
}

/**
 * Resolve kilo's composer footer back to a catalog id.
 *
 * This is a REWRITE of the opencode function it was copied from, not a rename. Opencode anchors on its
 * `Build`/`Plan` agent names; kilo's default agent is `code`, so the inherited version matched nothing on
 * every kilo pane and returned null forever — a blank model chip with no error, which is precisely how
 * this site is known to fail.
 *
 * Measured on a live pane, the composer footer is:
 *
 *   ┃  Code  · Auto Free Kilo Gateway
 *      ^agent   ^model display ^provider display
 *
 * so the anchor here is the PROVIDER label rather than the agent: `Kilo Gateway` is stable across agents,
 * while the agent name is user-configurable. The turn footer (`▣ Code · Auto Free · Step 3.7 Flash · 17.9s`)
 * is deliberately NOT used — it names the model the router RESOLVED to, whereas the chip has to report the
 * one the user selected, and those differ exactly when an `kilo-auto/*` alias is in play.
 *
 * Matching allows two spellings of the same entry, both measured:
 *   - the full model path with kilo's own prefix dropped — `kilo-auto/free` renders as "Auto Free";
 *   - the leaf alone — `stepfun/step-3.7-flash` renders as "Step 3.7 Flash".
 * Longest match wins, so a leaf that is a prefix of another cannot claim the row.
 *
 * A user on a different provider gets a footer this does not recognise, and the answer is null — a blank
 * chip, which is the correct way to say "not observed" rather than reporting a model that is not running.
 */
export function kiloFooterModelId(capture: string, catalog: KiloModelTarget[]): string | null {
  const line = capture.split('\n').map((l) => l.trim()).reverse()
    .find((l) => /·/.test(l) && PROVIDER_LABEL_RE.test(l))
  if (!line) return null
  // The model name is the span BETWEEN the agent separator and the provider label — not "the line with
  // the label removed". The footer is a full-width status bar and right-aligns the working directory onto
  // the same line, so stripping only the label leaves `Auto Free    /private/tmp/kilo-probe` and matches
  // nothing. Measured on a live pane; it is why this reads a span rather than doing a replace.
  const providerAt = line.search(PROVIDER_LABEL_RE)
  const display = squash(line.slice(line.indexOf('·') + 1, providerAt))
  if (!display) return null

  let best: { id: string; length: number } | null = null
  for (const entry of catalog) {
    for (const candidate of spellings(entry)) {
      if (candidate.length < 3 || candidate !== display) continue
      if (!best || candidate.length > best.length) best = { id: entry.id, length: candidate.length }
    }
  }
  return best?.id ?? null
}

/** The provider as the footer spells it, which is also what proves the line IS the composer footer. */
const PROVIDER_LABEL_RE = /kilo gateway/i

/** How one catalog entry can appear in the footer. See kiloFooterModelId for the measured examples. */
function spellings(entry: KiloModelTarget): string[] {
  const path = squash(entry.model)
  const leaf = squash(entry.model.slice(entry.model.lastIndexOf('/') + 1))
  const unprefixed = path.startsWith(squash(entry.provider)) ? path.slice(squash(entry.provider).length) : ''
  return [path, leaf, unprefixed].filter(Boolean)
}
