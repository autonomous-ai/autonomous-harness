# Orchestrator workspace

Work branch: `codex/orchestrator-workspace`. Keep the shared main checkout untouched.

## Experience

- Cmd-P opens a large freeform project prompt. Cmd-B remains single-agent routing;
  Shift-Cmd-P remains the command palette.
- One persistent director conversation on the right. Specialist viewers arrive on
  the left. Workers are ordinary daemon-managed tmux agents, inspectable on demand.
- The director discovers installed harnesses, composes work dynamically, and can
  fan out independent tasks or wait on a dependency graph. No CAD/video-only router.
- Each worker has its own folder. Downstream work receives verified, versioned
  artifact copies rather than racing another agent's live files.

## Implementation checkpoints

1. Durable daemon orchestration: idempotent creation, bounded parallelism, explicit
   completion/failure, dependency validation, cancellation, recovery, artifact checks.
2. Director/worker CLI tools over the existing local socket; reuse agent creation,
   input, cancellation, event streaming, and installed-harness metadata.
3. Native desktop launcher and workspace: streaming conversation, live viewers,
   inspect/retry/stop, reconnect and tab persistence. No extra worker chat panes.
4. Automated lifecycle, protocol, widget, and isolated end-to-end tests. Exercise
   fan-out/fan-in, failures, stale completions, duplicate requests, and recovery.
5. Review failures and UX, fix them, retest, commit and push incremental checkpoints.

## Boundaries

First implementation is same-machine: remote viewer transport is not implemented
by the underlying app. Do not auto-install harnesses or change engine permissions.
The launcher chooses the director engine and explicitly opts into unattended mode.
Closing a tab never kills an agent. Stopping a project is an explicit action.
Never claim idle means success or that a simulated model validates real CAD/render
quality. Record exact test coverage and remaining manual verification.

`output/orchestrator-workspace.html` is an interactive concept, not the feature.
