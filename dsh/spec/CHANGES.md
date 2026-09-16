# Changes to the DSH contract

Append-only. Each entry: Change / Why / Backward compatible / Mechanism.

## 2026-09-14 — spec 1

Initial contract. Lifted from the `.board.json` (Circuit) and `.episode.json` (TV) sidecars and the Vibe viewer's `serve:ensure` handoff.

## 2026-09-15 — phases in the verdict
- **Change:** `verdict.phases` (optional, ≤ 12): `[{ id, name, state, artifact? }]` with
  `state ∈ done | active | pending | failed`. The daemon forwards it on `AgentFrame.verdict.phases`;
  the desktop draws a phase strip in the viewer pane's header beside the verdict chip.
- **Why:** the pane is progressive — a Workshop run is research, concept, 3D, verify, and the user
  watching the viewer needs to know which of those is happening. The verdict already moves; this
  is the one line that says where.
- **Backward compatible:** yes — absent means no strip; every existing verdict is unchanged.

## 2026-09-15 — `category`, and the first-party names
- **Change:** manifest and registry entries gain `category` (≤ 24 chars): what the harness makes,
  in a word or two — "PCB", "3D design", "Slides". `dsh_list` forwards it; the picker shows it under
  the name, the way every engine now shows "Code". The first-party ids are `autonomous/copper`
  (Circuit's pipeline) and `autonomous/solid` (Workshop's Make stage); `autonomous/marp` is unchanged.
- **Backward compatible:** `category` is optional. Manifests may list the ids they went by in
  `formerly` (≤ 8); the daemon resolves an agent's `HARNESS_DSH` through it, so an agent created as
  `autonomous/circuit` or `autonomous/workshop` keeps its harness, viewer and verdict after the
  rename. Without it, such an agent draws by its name and runs as its plain engine.

## 2026-09-16 — spec 1.1: viewer packages and `viewer.use`
- **Change:** a package declares its `kind`: `agent` (default; a harness, a tile) or `viewer` (a
  pane other packages point at; no `engine`, never a tile, ships `viewer.command` + `viewer.url`).
  A harness may declare `"viewer": { "use": "<viewer id>" }` instead of its own viewer, optionally
  narrowing `url` and `artifactExtensions`. The daemon installs the used viewer with the harness
  (from the registry), runs its command in the viewer's own directory with `HARNESS_VIEWER` and
  `HARNESS_VIEWER_DIR` added to the usual env, and publishes the URL exactly as for an own viewer.
  Registry entries carry `kind` too; `dsh_list` rows forward it so the picker skips viewers.
- **Why:** one viewer, many agents. Solid's 3D pane is a vendored copy of text-to-cad's CAD Viewer;
  text-to-cad itself, and any CAD agent after it, wants the same pane. A viewer that is its own
  package is installed once, credited once, and updated with a version bump instead of a re-vendor.
- **Backward compatible:** yes — `kind` absent is an agent, `viewer` with `command` is unchanged,
  every existing manifest and registry entry parses as before.
- **Mechanism:** `cli/src/dsh/manifest.ts` (`kind`, viewer union, `viewerUse`), `viewer.ts`
  (`resolveViewer`), `install.ts` (dependency install), `check.ts`, `backendSocket.ts` (`kind` on
  rows; a viewer package refused as an agent on create).

## 2026-09-16 — Toymaker
- **Change:** the Make harness is `autonomous/toymaker`, "Toymaker", category "Toys" (was
  `autonomous/solid`, "Solid", "3D design"). `formerly` lists `autonomous/solid` and
  `autonomous/workshop`, so every agent created under either keeps its harness.
- **Why:** the public buys toys — kits of printed parts, printed fasteners, a mechanism — and the
  name should say what comes out, not the room it comes from.
- **Backward compatible:** yes, through `formerly`.

## 2026-09-16 — `author`, and CAD as one category
- **Change:** manifest and registry entries gain `author` (≤ 80 chars): who made the agent —
  "Autonomous" for Copper and Toymaker, "Jake Fitzgerald" for text-to-cad, "Yuki Hattori" for Marp, a vendor for a built-in engine. `dsh_list`
  forwards it; the picker shows it beside the category ("CAD · Autonomous"), and every built-in engine shows its maker the same way
  ("Code · OpenAI"). Toymaker and text-to-cad share the category "CAD".
- **Backward compatible:** `author` is optional.

## 2026-09-16 — The Harness Store
- **Change:** registry entries gain the facts a store page needs, all optional: `homepage` (the
  project's site), `upstream` (the repo a wrapper brings into Harness), `license` (SPDX id of the
  wrapper), `screenshots` (https URLs, ≤ 8). `dsh_list` rows carry them — plus `repo`, and `linked`
  for an install that is a link to a checkout — whether or not the package is installed, because a
  manifest does not know them. A new RPC, `dsh_remove { id }`, uninstalls a package from the machine
  that answers it (a linked install loses only its link) and replies `{ ok, id }` or
  `{ error, detail }`; a daemon without it answers `UNSUPPORTED`, which the app turns into "update the
  CLI". Ratings and reviews live in the control plane (`/api/store/…`), proxied by the local CLI
  like the machine list; they are keyed by registry id and are not part of the package.
- **Why:** the app's Harness Store shows every registry package as a card and a page — whose it is,
  where it lives, what it is licensed under, what people think, and where it is installed — and a
  page with Get needs a Remove.
- **Backward compatible:** yes — every field is optional, every old row and manifest parses as before.
- **Mechanism:** `cli/src/dsh/registry.ts`, `backendSocket.ts` (`dsh_list` facts, `dsh_remove`),
  `hookServer.ts` (`/api/store/*` proxy), `backend/src/routes/store.ts`, `desktop/lib/store/`.

## 2026-09-16 — Skills a setup fetches
- **Change:** `harness dsh check` warns instead of failing when an `agent.skills` root is missing
  from the checkout but the manifest declares `toolchain.setup`. The root must exist after setup, or
  the agent gets no skills.
- **Why:** a project that publishes skills without a licence to copy them (Remotion's, for one) can
  still be wrapped — its skills are fetched at install time, at a pinned commit, never vendored.

