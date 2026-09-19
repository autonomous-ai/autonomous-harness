---
name: foam-agent
description: Create and inspect simulation projects in the Foam-Agent Harness workspace, including its local starter and optional upstream integration.
---

# Wind tunnel

Read `studio.json` to understand the current controls; `"$STUDIO_TOOLCHAIN/../studio.config.json"`
describes their ranges. Run `"$STUDIO_TOOLCHAIN/run.sh" simulate` to make a new result.
Successful artifacts and their measurements are in `out/runs/<id>/`; `out/latest.json` names the
current result. A failed run preserves the last success and records the error in the verdict.

The local workflow solves a two-dimensional D2Q9 lattice Boltzmann model on a coarse grid. It is an exploratory simulation, not a converged engineering drag analysis. The optional OpenFOAM action reproduces the supplied lid-driven cavity benchmark; Foam-Agent instructions and sources are pinned for richer cases.

Use `"$STUDIO_TOOLCHAIN/../README.md"` for the integration contract and commands. Read the relevant
files under `$STUDIO_UPSTREAM` before using an upstream API. Keep controls within their documented
ranges, preserve the data needed to reproduce a comparison, and distinguish preview results from
native service or hardware output. The viewer supports history and artifact downloads; tell the
user which run contains the result, and what was actually measured.

## Compare flow cases

Save a baseline, then vary shape or radius while holding inlet speed, viscosity, and solver
steps fixed. Read `flow.csv` and `field.json`; check finite velocities, solid-boundary velocities,
and the convergence record. A coarse flow picture does not establish drag or mesh convergence.
Wind strength in `studio.json` is divided by 100 for the lattice inlet velocity.

For real OpenFOAM work, read `$STUDIO_UPSTREAM/.claude/skills/foam.md` before constructing a
case. The optional `openfoam` action checks the supplied cavity benchmark with active
`blockMesh` and `icoFoam`. Preserve its boundary conditions when reproducing the benchmark.
Upstream model/MCP planning requires its separate dependencies and credentials.
