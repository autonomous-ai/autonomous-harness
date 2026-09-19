# Experience rebuild — review and evidence

## Objective

Review the complete branch, make the seven harnesses genuinely capable and visually distinctive,
and verify the experiences people use through the actual shared viewer. Preserve the isolated worktree.

## Audit, 2026-09-19

- Reviewed all 14 branch commits, all seven manifests, agent instructions, domain skills, templates,
  init/verdict scripts, the shared viewer, previous browser scripts and research.
- At audit start, all seven shipped artifacts were placeholders. Voxel is two rectangles; drone is a moving dot;
  arena has no ending; music consumes its random generator across plays; bench has no filters.
- The previous E2E opens a manually constructed URL against an installed upstream viewer, appends
  an HTML comment and checks an iframe URL. It does not exercise manifest routing or user controls.
- All seven manifests inherit `?file=index.html` although their artifacts live in subdirectories.
- The 100% coverage claim does not cover any browser artifact. Shell-script subprocesses are not
  instrumented by Node coverage either. Do not repeat it as product coverage.
- Verdict helpers mark any nonempty HTML ready and claim verification they did not perform.
- Both installed and branch shells retain `sandbox="allow-scripts"`; the handoff's claim that the
  branch fixes canvas inspection is false. A user browser reproduction confirms sibling fetch and localStorage fail. Enable same-origin for trusted workspace apps; test fetch, modules, storage, pointer lock and exports.
- The research contains unsourced model rankings, licenses and product claims. They are leads,
  not verified requirements. Original implementations here must be credited as such.

## Completion requirements

1. Seven useful, offline, self-contained starter experiences with distinct art direction:
   walkable/buildable voxel island; reproducible print studio; editable/exportable music;
   coherent brand directions; first-person gate racing; finite replayable strategy arena;
   probeable synthetic experiment with computed statistics and data export.
2. A shared viewer with correct artifact routing, preserved seed, usable narrow layouts,
   visible loading/error/reconnect states, manual and automatic refresh, pointer lock and exports.
3. Reproducible pure domain models plus browser tests for real controls, exports, no runtime
   errors, determinism, responsive layouts, and file changes through the branch viewer.
4. Honest verdicts, useful agent instructions, portable developer commands, store metadata and
   actual output screenshots; remove misleading evidence and unsupported research conclusions.
5. Conformance, catalog validation, materialization/viewer integration and visual QA on the final
   state. Record exact evidence and limitations. No fabricated coverage or completion claims.

## Status

Implementation and local verification complete. All seven placeholders have been replaced,
manifest routes corrected, verdict claims corrected, same-origin browser APIs restored, and
Store metadata/screenshots supplied. Actual daemon creation and installed viewer reloads pass
for all seven. See `VERIFICATION.md` and `PERFORMANCE.md` for commands, samples and limitations.
Publication is verified separately against the live Store catalog after merging.
