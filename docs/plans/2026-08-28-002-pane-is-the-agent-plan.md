# Pane is the agent: stop gating creation and terminal on process discovery

Status: proposed · 2026-08-28

## Context

Creating an agent from the desktop app fails, and a listed agent sometimes cannot render its
terminal. Both symptoms have one cause: **two separate code paths gate on the same thing — being
able to identify the engine PROCESS inside the pane** — while the product model is that the unit is
the pane. If an agent is in the list, clicking it must show its terminal, whatever state the engine
is in.

Measured on 2026-08-28 (all numbers from this machine, `resolvePaneEngineProcess` used as the
oracle):

| fact | value |
|---|---|
| `zsh -lic` startup before `exec` of the engine | ~0.9s |
| engine first identifiable — grok / codex / claude | 1.38s / 1.41s / 1.52s (another run: ~1.19–1.22s) |
| old discovery budget in `onCreateAgent` | 150+400+800 = **1.35s** |
| claude identifiable while its trust dialog is on screen | **yes, at 1.10s** |

So the engine lands within ±200ms of the old deadline: the failure is a flaky race, not a broken
engine. A create that "failed" leaves a working pane that the 5s reconcile registers moments later —
observed live (agent `d372 · tmp`).

Two findings shape this plan:

1. **A blocking first-run prompt does not hide the engine.** Discovery matches on `ps` argv, not on
   screen content, and `registry.openProcessAgent` needs no `sessionId`/transcript. Claude sitting at
   "Do you trust this folder?" is fully discoverable. Codex sitting at its update prompt was NOT —
   there the pane held a `node` process that is not codex's entrypoint (`engineProcessMatchScore`
   covers every real codex install layout; only a non-entrypoint child misses).
2. **Opening a terminal requires the same match.** `TmuxBackend.openStream` calls `validate()` first,
   which is `resolvePaneEngineProcess(pane, engine)` plus an exact pid/startMarker comparison. A pane
   that is alive but whose engine is unmatchable (crashed, replaced, unusual install) renders
   "TERMINAL FROZEN" instead of its contents — the user cannot see or fix what happened.

Intended outcome: an agent that exists in the list always renders its pane, and creating an agent
succeeds as soon as the pane is running the engine, regardless of how long discovery takes.

## Design principle

Streaming and injection deserve different thresholds, and today they share one.

- **Streaming + raw keys** address the **pane** (`tmux send-keys -t %N`, `capture-pane -t %N`). Pane
  ids are monotonic and never reused within a server, so the pane id alone is a safe address. If the
  pane is gone, `TmuxControlStream.open` already fails on `paneMeta()`.
- **Lease-based injection** (`submitText`/`typeLiteral`, the composer's `message` path) types into
  whatever process owns the pane. That one must keep validating.

## Change 1 — a listed agent always renders its terminal (core)

`cli/src/lib/tmuxBackend.ts` — `openStream` (line ~208):

Drop the hard `validate()` gate. Open the stream on pane existence alone; `TmuxControlStream.open`
already rejects a missing pane and a multi-pane window. Keep the identity check as non-fatal
information if we want it in a log line, never as a refusal.

Do **not** touch the other `validate()` call sites — they are unaffected by this change and must stay
strict:

- `cli/src/cli.ts:960` (via `terminalBackendCoordinator.validate`) — reaper liveness
- `cli/src/lib/terminalBackendCoordinator.ts:165` — `validateLease`
- `cli/src/lib/terminalBackendCoordinator.ts:238,274` — lease dispatch fallback

Leave `terminalBackendCoordinator.openStream`'s `if (!session.active)` guard (line 193) as is: a
dormant agent is filtered out of `registry.active()` and therefore is not in the list, so it is
outside this change's premise. Revisit only if a pane is observed freezing on dormancy while open.

## Change 2 — creation stops losing the startup race (already written, uncommitted)

`cli/src/cli.ts` — `backend.onCreateAgent`. Already implemented and tested in the working tree:

- discovery budget 1.35s → **8s**, probes at 150 → 450 → 1050 → 1800 → 2550 … (`delayMs` doubling,
  capped at 750ms). The app's own RPC timeout is 20s, so this stays well inside it.
- **early exit** when the pane is dead — a failed engine reports in ~160ms rather than waiting out
  the budget.
- the failure `detail` (shipped earlier) keeps naming which of the four states the pane was in.

## Change 3 — pane-based registration (larger, do only if Change 1+2 leave a real gap)

Only needed for an engine that never becomes matchable at all. Requires two edits, not one, and the
second is the risky half:

1. `cli/src/lib/registry.ts` — a creator that accepts `processIdentity: null`. `openProcessAgent`
   hard-rejects it today (`if (!runtimes.length || !validProcessIdentity(processIdentity)) return null`),
   but the surrounding model already supports it: the field is `ProcessIdentity | null`,
   `strictPersistedRow` accepts an explicit `null` so the row survives restart, `index()` simply skips
   `processIndex`, and `openProcessAgent`'s `routeAgent` lookup deliberately tolerates
   `!agent?.processIdentity` so discovery can **backfill** identity later. `projectFrame` /
   `toProject` never read `processIdentity`, and `sessionId: ''` already yields a valid Agent payload.
2. `cli/src/lib/terminalAgentReconciler.ts` (~line 167) — today an agent whose runtime is present but
   whose process is unmatched falls to the final `else` → `onDormant` → `cli.ts` sends
   `agent_deleted`, so a pane-registered agent would appear and then vanish within 5s. It must treat
   "pane alive, identity not yet known" as alive.

Step 2 touches the eviction logic that carries a documented history of evicting live agents. Do it as
its own change, with its own verification, never bundled with Change 1.

## Verification

Change 1:
1. `cd cli && npx tsc --noEmit && npx vitest run` (baseline is 1389 passing / 51 skipped).
2. Manual, isolated so it cannot touch the user's own tmux server:
   `TMUX_TMPDIR=$(mktemp -d)`, create a pane running a NON-engine command (`sleep 600`), register
   nothing, and call `TmuxBackend.openStream` on it — it must now succeed and stream, where it
   previously failed with `no <engine> process under tmux pane`.
3. Regression: with a real engine in the pane, the stream still opens and a keyframe arrives.
4. Confirm injection still refuses a mismatched process: `validateLease` behaviour unchanged.

Change 2 (already verified, re-run after any edit):
- Poll `resolvePaneEngineProcess` on the new schedule for claude/codex/grok — each must be found
  (measured 1214 / 1215 / 1189 ms), and a pane whose command exits immediately must break out in
  ~160ms rather than 8s.

End-to-end, on the machine that reproduces it:
- New agent → Claude → a folder that has never been trusted. The dialog must close without an error,
  the agent must appear, and clicking it must render the pane showing the trust prompt. Answer it in
  the terminal. Note that some Claude builds default to `❯ No, exit` — read the screen before typing.

## Non-goals

Auto-answering or pre-empting an engine's first-run prompt (trust folder, update, login). The agent is
created, its terminal is shown, and the user acts. Choosing for them is not recoverable: a stray Enter
on a build that defaults to "No, exit" kills the engine.
