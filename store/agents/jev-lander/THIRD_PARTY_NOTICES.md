# Third-party notices

**Jev** — TypeSafe AI's "System One" decision model (typesafe.ai). This harness does not vendor or
fetch any TypeSafe code. It calls TypeSafe's public API (`POST /v1/systemone`) only when a
`TYPESAFE_API_KEY` is set. Without one, the harness runs on a deterministic local mock (a stand-in
for the *plumbing*, not for Jev's judgement). Jev and TypeSafe are trademarks of TypeSafe AI.

**OpenHarness** — Autonomous (this repository), MIT license. This harness is a wrapper that adds a
viewer and agent instructions; it does not modify TypeSafe AI's product.

This project does not imply endorsement by TypeSafe AI.
