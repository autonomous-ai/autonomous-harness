# Domain-specific harness contract (spec 1)

Frozen 2026-09-14. Changes go to [CHANGES.md](CHANGES.md), append-only.

A DSH is a git repo. Harness reads `harness.json` at its root and nothing else about its code.


## `harness.json`

```jsonc
{
  "spec": 1,
  "id": "autonomous/copper",             // owner/name; the install dir and the wire id
  "name": "Circuit",                      // the picker tile
  "description": "Chat with AI → a board you can order",
  "engine": "claude",                     // base engine, one of ENGINES
  "workspace": {
    "template": "template",               // copied into an EMPTY workspace (no marker present)
    "marker": "product.json",             // relative path; present = already materialized
    "init": "toolchain/init-workspace.sh" // optional; run after the template copy, cwd = workspace
  },
  "agent": {
    "instructions": "AGENTS.md",          // copied to <workspace>/AGENTS.md, see below
    "skills": ["skills"],                 // dirs whose SKILL.md-bearing subdirs are linked in
    "env": { "CIRCUIT_TOOLCHAIN": "${dsh}/toolchain" },  // ${dsh} ${workspace} ${home} expand
    "args": []                            // appended to the base engine's argv
  },
  "toolchain": {
    "setup": "toolchain/setup.sh",        // run once at install, cwd = install dir
    "doctor": "toolchain/doctor.sh"       // exit 0 = ready; stdout lines are shown to the user
  },
  "viewer": {                             // optional (tier 2)
    "command": "toolchain/viewer.sh",     // long-running; env HARNESS_VIEWER_PORT, HARNESS_WORKSPACE
    "url": "http://127.0.0.1:${port}/?file=${artifact}",  // ${port} ${artifact} (url-encoded)
    "artifactExtensions": [".step", ".stl"]               // newest such file under the workspace
  },
  "verdict": ".harness/verdict.json"      // relative to the workspace; optional (tier 1+)
}
```

Materialization, in order, at every create (idempotent):

1. If `workspace.marker` is absent: copy `workspace.template/*` into the workspace, then run
   `workspace.init` if declared.
2. `AGENTS.md`: copy if absent; else append the DSH file under a marker line
   `<!-- harness:dsh <id> -->` if that marker is not already present. For a `claude` base also
   ensure `CLAUDE.md` contains `@AGENTS.md` (Claude Code reads `CLAUDE.md`, imports the rest).
3. Skills: symlink each skill dir into `<workspace>/.claude/skills/<name>` (claude) or
   `<workspace>/.agents/skills/<name>` (codex). Symlinks, so a DSH update is live.
4. Create `<workspace>/.harness/`.

Launch env, always: `HARNESS_DSH=<id>`, `HARNESS_DSH_DIR=<install dir>`,
`HARNESS_WORKSPACE=<workspace>`, plus `agent.env` expanded. Set through tmux `-e`, the same channel
grids and Codex profiles use, on create AND on every relaunch (`buildLaunchOverrides`).

## Viewer packages (spec 1.1)

A viewer can be a package of its own, pointed at by any number of harnesses:

```jsonc
// harness.json of a viewer package
{ "spec": 1, "kind": "viewer", "id": "autonomous/cad-viewer", "name": "CAD Viewer",
  "toolchain": { "setup": "setup.sh", "doctor": "doctor.sh" },
  "viewer": { "command": "viewer.sh", "url": "http://127.0.0.1:${port}/?file=${artifact}",
              "artifactExtensions": [".step", ".stp", ".glb", ".stl", ".3mf"] } }

// harness.json of an agent that uses it
{ "spec": 1, "id": "autonomous/text-to-cad", "name": "text-to-cad", "engine": "claude",
  "viewer": { "use": "autonomous/cad-viewer" } }
```

A viewer package has no engine, no workspace and no verdict, and is never a tile. `harness dsh
install` of a harness that `use`s a viewer installs the viewer too (by registry id). At launch the
daemon runs the viewer's command in the VIEWER's directory with the usual env plus
`HARNESS_VIEWER=<viewer id>` and `HARNESS_VIEWER_DIR=<its install dir>`; `HARNESS_DSH` and
`HARNESS_DSH_DIR` still name the harness. The harness may narrow `url` and `artifactExtensions`.

## `.harness/verdict.json`

```jsonc
{
  "spec": 1,
  "ready": false,                         // the one machine fact: fab.ready, gates passed, exam passed
  "summary": "3 errors, 2 warnings",      // one line for the pane header
  "findings": [
    { "severity": "error", "kind": "source_trace_not_connected", "message": "…", "ref": "U3.pin7" }
  ],                                      // severity ∈ error | warning | info; kind is open
  "artifact": "boards/main.board.json",   // optional; primary thing to view, workspace-relative
  "phases": [                             // optional; where the work is, in order, for the pane header
    { "id": "build", "name": "Build", "state": "done" },
    { "id": "checks", "name": "Checks", "state": "active" },
    { "id": "fab", "name": "Fab", "state": "pending" }
  ],                                      // state ∈ done | active | pending | failed; ≤ 12 phases
  "updatedAt": "2026-09-14T20:00:00Z"
}
```

The verdict is a feed, not a gate: write it at every phase change and every check, not only at the
end. The pane is the product, and it must move while the agent works — a harness that only writes a
final verdict is not progressive. `phases` is how the header says "you are here"; `ready` stays the
one final truth.

Lifted from Circuit's `.board.json` and TV's `.episode.json` sidecars (same severity gate). Circuit
writes it beside the sidecar in `circuitpy.generation`; Workshop writes it from `verify_project`.

## Wire (daemon ↔ desktop)

- `agent_create` payload gains `dsh?: string`. Refused with `INVALID_DSH` when not installed on
  this machine or when `engine` is not the DSH's base.
- `AgentFrame` gains `dsh: string | null`, `dshName: string | null`, `viewerUrl: string | null`,
  `verdict: { ready, summary, errors, warnings, artifact, phases, updatedAt } | null`. Null is a real answer
  (see `agentFrame.ts`'s doc on erased fields).
- `dsh_list` → `{ dsh: [{ id, name, description, category, engine, installed, viewer, tier }] }`: installed
  DSHs on this machine merged with the bundled registry (`dsh/registry/**/*.json`).
- `dsh_install { id?, url?, ref? }` → runs clone → setup → doctor; pushes
  `dsh_install_status { id, phase: clone|setup|doctor|done|failed, detail? }`; replies `{ ok }` at
  the end (the desktop uses a 10-minute timeout for this one request).
- Discovery reads `HARNESS_DSH` off the live process (`probeDsh`, same cached env read as
  `probeCodexHome`) so a pane the daemon did not create, or re-minted after a restart, is labelled.

### The store's facts

A registry entry may also carry `homepage`, `upstream`, `license` and `screenshots` (see
`cli/src/dsh/registry.ts`). They are the store page's, not the package's: a manifest never has them,
and `dsh_list` rows forward them from the registry whether or not the package is installed, with
`repo` and `linked` beside them. `dsh_remove { id }` uninstalls from the answering machine.

## On disk

```
~/.harness/dsh/
  installed.json                # [{ id, dir, source, ref, commit, installedAt }]
  autonomous/copper/           # clone, or a symlink when installed with --link (dev loop)
  autonomous/toymaker/
```

CLI: `harness dsh install <git-url|path> [--link] [--ref <ref>]`, `harness dsh list`,
`harness dsh doctor <id>`, `harness dsh remove <id>`.

## In the monorepo

```
dsh/
  README.md            what a DSH is, the tiers, how to publish
  spec/README.md       this contract, frozen; CHANGES.md is append-only
  spec/schema/         harness.schema.json, verdict.schema.json
  registry/autonomous/ circuit.json, workshop.json   (bundled into the CLI at build time)
  starter-dsh/         tier 0: manifest + AGENTS.md + one skill; the CLI's test fixture
cli/src/dsh/           manifest, install, materialize, viewer, verdict, probe
desktop/lib/dsh/       catalog, web pane, verdict chip
```

Normative schemas: [`schema/harness.schema.json`](schema/harness.schema.json), [`schema/verdict.schema.json`](schema/verdict.schema.json).
