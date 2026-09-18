# Harness package updates

Status: implemented and verified.

Add explicit updates through `harness dsh update <id>` and the desktop Store. The daemon reports the
installed and available commits; catalog entries may also carry a package tree revision so publishing
an unrelated monorepo change does not offer every package an update.

Updates follow the installed repository and package path. Matching catalog entries supply the
published ref; other installations use their recorded ref. Linked development checkouts are left to
their owner. Shared viewers can be updated independently from their Store pages.

Fetch and validate the package before replacing anything. Keep the previous package while running
setup and doctor at the permanent installation path (virtual environments can embed that path).
Restore it on failure and write the new installed record only after success. Serialize mutations of
each package across CLI and daemon processes. Do not materialize or migrate workspaces during an
update: their files, instructions, session identity and stable skill links remain in place.

Verification: real local git repositories for whole-repo and subfolder updates, no-op updates,
rollback, linked installs, source identity, concurrent mutations and workspace preservation; wire and
CLI tests; desktop parsing and Store interaction tests; CLI typecheck/full suite and Flutter analysis
and relevant widget tests. Setup scripts' external side effects cannot be rolled back.

Verification completed on 2026-09-18, including a fresh full round before opening the PR:

- 388 package/socket tests pass with 100% statements, branches, functions and lines in each of
  `update.ts`, `updates.ts`, `lock.ts` and `service.ts`: 155 statements, 146 branches, 17 functions and
  115 lines. Verified on the development runtime and the shipped Node 22.23.2. The on-demand CI
  workflow enforces the same coverage gate.
- CLI typecheck and the full suite pass: 2,959 tests passed, 52 existing opt-in tests skipped.
  Development and release builds pass. A smoke test of the actual release bundle on both runtimes
  verifies install, update, installed-version display, setup at the stable path, preserved work and
  doctor-failure rollback.
- The real Store → daemon → Git → setup → doctor integration passes rollback, retry, independent
  viewer updates and reopening an unchanged workspace with a working viewer. Its isolated fixtures
  use real WebSockets and a running HTTP viewer, without accounts or model calls.
- The complete desktop suite passes: 1,950 tests, with two opt-in integrations skipped, using
  Flutter 3.47.2 and the shipped Node 22.23.2 for the real update integration. The four-worker coverage
  run hit a timeout in the unchanged keymap symlink-watcher test; all eight keymap tests and the
  update integration passed in isolation, followed by a clean full run with two workers. An earlier
  terminal batching timing failure was fixed with a test clock, and the install-panel test accepts
  elapsed time instead of requiring the first frame within a second. Login fixtures explicitly
  avoid the Grid installer and this machine's Grid binary.
- Changed Flutter files pass analysis. Full Flutter analysis reports no errors or warnings, with
  15 existing informational style notices outside this feature.
- Captured and visually checked the real Store's Update and Open states with the app theme. The
  action retains the selected UI font and centers its workspace-preservation note. Review screenshots
  are in `docs/images/harness-update-available.png` and `docs/images/harness-update-installed.png`.

See `docs/development.md` for repeatable coverage and end-to-end test commands. Coverage percentages
above apply to the four updater modules, not the entire repository. Updating does not restart live
sessions or migrate project contents; setup scripts can still have external side effects.
