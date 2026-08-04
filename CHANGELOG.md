# Changelog

The spec is a compatibility contract (see §12 of `spec/README.md`), so every change here says whether
it is additive or breaking. Additive changes are safe for a deployed integration; breaking ones are
not, and get a new revision served alongside the old.

## [0.1.0] — 2026-08-04

First public release.

- **Spec**: the provider profile of A2A v1.0.1 — 40 numbered clauses, six JSON Schemas, a worked
  example of a complete turn, and a coverage audit of the full client surface.
- **`reference-provider`**: scripted and deterministic, including the hostile scenarios (a stream cut
  with no terminal state, failure after partial output, a provider emitting no metadata at all), plus
  the conformance runner.
- **`example-provider`**: a real provider backed by the Claude Code CLI.

Nothing is deprecated, because nothing has shipped before this.
