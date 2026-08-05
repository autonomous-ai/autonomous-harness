# Changelog

The spec is a compatibility contract (see §12 of `spec/README.md`), so every change here says whether
it is additive or breaking. Additive changes are safe for a deployed integration; breaking ones are
not, and get a new revision served alongside the old.

## [0.2.0] — 2026-08-05

**BREAKING.** The product vocabulary changed and this profile follows it. Safe to take now only
because 0.1.0 is one day old, is marked DRAFT, and nothing has been built against it yet — see the
note in `spec/README.md` §12. There is no compatibility shim: 0.1.0 is withdrawn, not deprecated.

The unit of work inside a machine is an **agent** everywhere now — in the product, on the internal
wire, and here. It used to be called a *project* on this profile and an *agent* on the internal wire,
which is exactly the ambiguity the rename removed.

- **Renamed methods**: `autonomous.CreateProject` → `autonomous.CreateAgent`,
  `autonomous.RenameProject` → `autonomous.RenameAgent`, `autonomous.DeleteProject` →
  `autonomous.DeleteAgent`.
- **Renamed request field**: `projectId` → `agentId` in every extension schema.
- **Renamed capability flag**: `AgentCard.extensions[].params.projects` → `params.agents` (HP-301).
- **Renamed `$defs`**: `projectCreateRequest` / `projectRenameRequest` / `projectDeleteRequest` /
  `projectResponse` → their `agent*` equivalents.
- **Prose**: the Autonomous entity a provider backs is a **machine**, not a *harness*. "Harness"
  remains the product name — the domain, the device and this repository keep it.
- **Added** a note under §2 on the one collision this creates: A2A calls *your endpoint* an agent,
  Autonomous calls *a skill on your card* an agent. `machine → agent → session` on our side reads
  `endpoint → skill → contextId` on yours.

Unchanged: every `HP-xxx` clause id, every extension URI, every schema `$id`. Those are opaque
identifiers (HP-003) and renaming them would break tooling for no gain.

## [0.1.0] — 2026-08-04

First public release.

- **Spec**: the provider profile of A2A v1.0.1 — 40 numbered clauses, six JSON Schemas, a worked
  example of a complete turn, and a coverage audit of the full client surface.
- **`reference-provider`**: scripted and deterministic, including the hostile scenarios (a stream cut
  with no terminal state, failure after partial output, a provider emitting no metadata at all), plus
  the conformance runner.
- **`example-provider`**: a real provider backed by the Claude Code CLI.

Nothing is deprecated, because nothing has shipped before this.
