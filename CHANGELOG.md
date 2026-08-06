# Changelog

The spec is a compatibility contract, so every entry says whether it is additive or breaking.
Additive changes are safe for a deployed integration; breaking ones are not, and get a new revision
served alongside the old.

## [0.3.0] — 2026-08-06

The first revision anything is built against. Earlier drafts were withdrawn without implementers, so
they are not carried here; from 0.3.0 on a breaking change requires serving both revisions side by
side for a deprecation window.

**The protocol.** Authenticate, call a method, handle the response. JSON-RPC 2.0 over HTTPS on a
single URL, with Server-Sent Events for the one method that streams. The credential travels as
`Authorization: Bearer` — one header, fixed by convention. There is no discovery document, no SDK,
and no capability negotiation.

| Method | For |
|---|---|
| `agent.list` | the agents a user picks from — **authenticated**, so it can differ per tenant |
| `agent.send` | one turn, streamed |
| `agent.history` | rebuilding the conversation, windowed |
| `turn.cancel` | stopping a turn |
| `agent.create` / `agent.rename` / `agent.delete` | managing the agent list |
| `agent.recap` | short per-turn summaries the hardware device restores its tiles from |

All eight are required, and **"required" does not mean "pretend"**: a provider whose agents live in
its own product answers `invalid_request` with a message, and Autonomous shows that message to the
user. An explanation beats a control that silently vanished, which is why nothing has to be declared
in advance.

**The model has only agents.** One agent is one continuous transcript; there is no session, thread or
context on this boundary. Autonomous synthesises what its own clients need from the agent, which is
entirely its side of the line.

**Events are flat and self-describing**, discriminated on `kind`, and the same objects serve the live
stream and `agent.history` — one shape, so a replayed transcript and the live view cannot disagree.
`kind` is optional: an event carrying only `text` is conformant and renders as plain assistant output,
which is the smallest correct implementation a partner can ship.

Three rules worth calling out, because each exists to prevent a specific user-visible failure:

- **Exactly one terminal frame ends every stream.** Zero leaves a spinner that never resolves; two
  ends the turn twice.
- **The client mints `turnId`**, so a user pressing stop in the first moment has something to name.
- **A rejected credential has its own error code**, so the product can say "re-enter your credential"
  rather than "something went wrong".

**Conformance.** `provider/reference-provider/` ships a scripted implementation and a runner, each of
whose checks carries a stable slug. The runner is itself tested against eleven deliberately broken
providers, each violating one rule, each of which it must catch — a suite that only ever goes green
converts "we did not check" into "we checked and it was fine". `provider/e2e/` then runs everything
against **both** reference implementations, which is what distinguishes a spec that is implementable
from one that is merely self-consistent.
