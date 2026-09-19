# Local flow simulation and optional OpenFOAM benchmark

`simulate` executes an original D2Q9 lattice Boltzmann solver with a circle, square, or ellipse. It exports the velocity/pressure field and convergence samples. The animated replay samples those measured velocities; an unsaved control change switches to a labelled flow sketch. `openfoam` uses active `blockMesh` and `icoFoam` executables for the supplied cavity case. The upstream Foam-Agent skill is in `upstream/.claude/skills/foam.md`; its MCP/model calls need its separate native setup.

## Verification scope

Local solver variants, field export, tracer interaction, and failure recovery are in the local test scope. OpenFOAM itself is optional and was not installed on this Mac. The coarse local solver is not a validated engineering wind tunnel.

The browser acceptance suite lives in `store/viewers/studio-viewer/test/studios.e2e.mjs`.
`TESTING.md` beside that viewer records commands, outcomes, screenshots and coverage.
Upstream source revisions are in `upstream.lock.json`; install-time Python dependencies are
hash-locked in `requirements.lock`. No user application configuration is written by setup.
