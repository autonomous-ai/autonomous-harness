# Autonomous machine provider protocol

A **provider** backs an Autonomous *machine* with your agent platform instead of a CLI running on the
user's own computer. This document is the whole contract.

**Authenticate, call a method, handle the response.** JSON-RPC 2.0 over HTTPS POST to one URL, with
Server-Sent Events for the one method that streams. No WebSocket, nothing long-lived, no SDK, and
nothing to discover — the eight methods below are the entire surface.

```http
POST /  HTTP/1.1
Host: agent.example.com
Authorization: Bearer <credential>
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"agent.list","params":{}}
```
```jsonc
{"jsonrpc":"2.0","id":1,"result":{"agents":[{"id":"seo","name":"SEO Analyst"}]}}
```

Field names are camelCase. Ids are strings. Timestamps are ISO-8601 UTC.

---

## The model

```
machine   one provider endpoint + one credential          ← what the user creates and pays for
  └── agent    one working unit inside it                 ← what the user picks and talks to
        └── turn     one user message until the agent stops
```

**There are only agents.** A provider has no session, thread, or conversation concept here: **one
agent is one continuous transcript.** Autonomous presents a session to its own clients and synthesises
it from the agent — entirely our side of the line, and nothing you need to model.

| Autonomous concept | On your side |
|---|---|
| machine | your endpoint; the credential selects *which* tenant |
| agent | an entry in `agent.list` |
| turn | one `agent.send` call and the stream it returns |
| a question to the user | a `turn_input_required` frame, answered by a resumed `agent.send` |
| credential rejected | the `unauthenticated` error code |

---

## Authentication

The credential is pasted by the end user into the Autonomous web app and sent on every request as
`Authorization: Bearer <credential>`. One header, fixed by convention: there is no descriptor to name
a different one.

It identifies **one tenant**, and must not grant access beyond that tenant.

A rejected credential must answer the `unauthenticated` error code, never a generic failure — the
product says a different sentence for "your credential is wrong" than for "the provider is down", and
cannot tell them apart otherwise.

---

## The eight methods

All eight are required. There is nothing to declare, and no capability negotiation.

| Method | Params | Result |
|---|---|---|
| `agent.list` | — | `{ agents: [{ id, name, description? }] }` |
| `agent.send` | `{ agentId, turnId, message, resume? }` | **SSE** — see below |
| `agent.history` | `{ agentId, limit?, before? }` | `{ agentId, events, nextBefore?, truncated? }` |
| `turn.cancel` | `{ turnId }` | `{ cancelled: true }` |
| `agent.create` | `{ name, description? }` | `{ id, name, description? }` |
| `agent.rename` | `{ agentId, name }` | `{ id, name, description? }` |
| `agent.delete` | `{ agentId }` | `{ deleted: true }` |
| `agent.recap` | `{ agentId }` | `{ agentId, recap?, text?, turnId? }` |

**"Required" does not mean "pretend".** If your agents are managed inside your own product, do not
implement a fake mutation — answer `invalid_request` with a message, and Autonomous shows that message
to the user: *"Agents are managed in Example Co."* An explanation the user can read beats a control
that is silently missing, which is why nothing has to be declared in advance. Likewise, a provider
that summarises nothing answers `agent.recap` with no `recap`, and Autonomous derives one from the
turn's own text instead.

Ignore request fields you do not recognise rather than failing on them, so a client on a newer
revision still works against you. Reject a method you do not implement with `unsupported`.

### `agent.list`

Authenticated, returning the agents this credential's tenant may use. `id` is stable and opaque to us;
`name` and `description` are shown to the user.

A provider with no meaningful agent concept returns **exactly one** entry for the whole workspace —
never an empty list, which reads to the user as a broken machine. An id that disappears between calls
is treated as deleted, and Autonomous refuses to send to an agent the latest list does not contain.

### `agent.send`

```jsonc
// → agent.send
{ "agentId": "seo",
  "turnId": "t_01J8Z…",
  "message": { "text": "how is acme pacing?",
               "attachments": [{ "mediaType": "image/png", "data": "<base64>" }] } }
```

Returns `Content-Type: text/event-stream`, one JSON object per `data:` frame. Streaming is not
optional — the product renders assistant output as it arrives.

`turnId` is minted by the **client** and must be used as given: it is how a turn is cancelled. A
provider that mints its own leaves an early cancel with nothing to name — the user presses stop, and
there is no id to send yet.

Attachments are optional to support. A provider that cannot read images must **fail the turn** with a
clear message rather than silently discarding them; silent loss reads to the user as the agent
ignoring what they sent.

### The two stream guarantees

**It ends, exactly once.** Every stream ends with one terminal frame — `turn_completed`, `turn_failed`,
`turn_cancelled` or `turn_input_required`. None leaves the web spinning forever; two ends the turn
twice.

**What is inside is renderable.** The kinds below, discriminated on `kind`. An unrecognised kind is
ignored, never fatal, so a later revision may add one. An event with **no `kind` at all** but with
`text` is conformant and renders as plain assistant output — the smallest correct provider streams
`{"text":"…"}` then `{"kind":"turn_completed"}`.

### `turn.cancel`

Always accepted, including for a turn that has not started yet — which must then terminate
immediately if it later begins. After a successful cancel the stream terminates with `turn_cancelled`.

### `agent.history`

Transcripts live **entirely on your side**. Autonomous stores none for a provider machine, which is
why this is required: without it a page refresh loses the conversation.

Returns that agent's transcript newest-last, in the **same event objects the stream emitted** — one
shape, so a replayed transcript and the live view cannot disagree about what happened. A provider that
stores its own richer form converts on the way out.

Streamed **deltas may be coalesced**: `text_delta "Acme is at "` then `text_delta "118% of pace."` may
come back as one `text_delta "Acme is at 118% of pace."`. Deltas are a streaming detail. Everything
else — the kinds, their order, the tool ids, the fields — must survive, because that is what a client
renders from. `turn_started`, the terminal frames, the recap bracket and `done` are live-turn signals
and need not appear at all; `done` in particular restates text already streamed.

With `limit`, the response is a window ending at the newest event, or at `before` when supplied, plus
`nextBefore` — an opaque cursor naming the next older window, omitted once the start is reached.
Clients never construct a cursor. Without `limit`, the whole transcript comes back and `nextBefore` is
omitted. A transcript you truncate must carry `truncated: true`; silent truncation is a violation.

```jsonc
// → agent.history  { "agentId": "seo", "limit": 200 }
{ "agentId": "seo",
  "events": [ { "kind": "user_message", "text": "how is acme pacing?" },
              { "kind": "text_delta",   "text": "Acme is at 118%." } ],
  "nextBefore": "evt_8841",
  "truncated": false }
```

### `agent.recap`

The agent's **last** recap — one short summary, used to restore the physical device's tile after a
reboot, since it has no stream to read. There is no history to page through: the device shows one tile
per agent.

```jsonc
// → agent.recap  { "agentId": "seo" }
{ "agentId": "seo",
  "recap":  "Acme is over pace",
  "text":   "Acme is at 118% of pacing this week.",
  "turnId": "t_01J8Z" }
```

**This is the same object `recap_end` carries**, so a recap has one shape whether it was pushed on a
turn's stream or pulled here. An **absent `recap` means nothing has been summarised yet** — the same
convention, and the correct answer for a provider that does not summarise at all.

`turnId` is optional but strongly recommended: this method is scoped to an **agent** and cannot be
scoped to a turn, so a client asking the instant a turn ends otherwise receives the previous turn's
summary with no way to tell.

---

## Asking the user something

When the agent needs an answer — a permission prompt, a clarifying question — end the stream with
`turn_input_required` carrying a `prompt`, and accept a later `agent.send` with the **same `turnId`**
and `resume: true` as the answer, continuing the same turn.

The stream ends rather than being held open, deliberately: a human decision has no time bound, and an
HTTP request whose duration a user controls is a connection leak on both sides.

```
client                                provider
  │── agent.send {turnId: t1} ──────────►│
  │◄── … events …                        │
  │◄── turn_input_required {prompt} ─────│   stream closes
  │                                      │
  │── agent.send {turnId: t1, resume} ──►│   same turn continues
  │◄── … events …                        │
  │◄── turn_completed ───────────────────│
```

---

## The event vocabulary

One flat, self-describing object per frame. Every event must be readable without the frames before it
— that is what lets the same objects serve the live stream and `agent.history`.

| `kind` | Fields | Meaning |
|---|---|---|
| `turn_started` | `turnId`, `agentId`, `at?` | the turn is underway |
| `user_message` | `text` | the user's own turn, replayed in history |
| `thinking_title` | `title` (or `text`), `thinkingId?` | a short label for a reasoning block |
| `thinking_delta` | `text`, `thinkingId?` | a chunk of reasoning |
| `text_delta` | `text` | a chunk of assistant output |
| `tool_start` | `toolId`, `tool`, `title?`, `input?` | a tool invocation began |
| `tool_end` | `toolId`, `tool?`, `ok?`, `output?`, `summary?`, `durationSeconds?` | it finished |
| `context_compact` | `text?` | the provider compacted its own context |
| `done` | `text` | the turn's final result text |
| `recap_start` | — | summarising has begun |
| `recap_end` | `recap?`, `text?` | summarising is over |
| `turn_completed` | — | terminal |
| `turn_failed` | `error` | terminal |
| `turn_cancelled` | — | terminal |
| `turn_input_required` | `prompt` | terminal; the turn is paused, not over |

`tool_start` and `tool_end` must carry the same `toolId`, unique within the turn — tools can overlap,
so pairing by position is not available, and an event without one is dropped rather than rendered as a
row that never resolves. `ok: false` marks failure; **absent `ok` is not a failure**, it is the
provider not saying.

Statistics are omitted rather than fabricated. A message count nobody counted, or a timestamp nobody
recorded, is worse than an absent field — the client hides what it did not receive.

Schema: `schema/event.json`.

### The recap phase

A turn may be summarised in-stream, as a **pair** emitted after the output and before the terminal
frame:

- `recap_start` — summarising has begun. Carries nothing; it exists so the client can show an
  indicator and hold its busy state open for a wait it cannot otherwise see.
- `recap_end` — the phase is over. The headline travels in `recap` (≤ 200 characters), the fuller body
  in `text`. **An absent `recap` means no recap was produced** — a turn that said nothing, or a
  summariser that failed. The client clears its indicator and paints nothing.

`recap_start` without a matching `recap_end` before the terminal frame leaves an indicator open
forever, which is worse than never opening one.

A pushed recap is unambiguously **this** turn's, which `agent.recap` cannot promise. A provider that
pushes should also persist, for the device restoring its tiles.

---

## Errors

JSON-RPC error objects whose `code` is a **string**:

```jsonc
{ "jsonrpc": "2.0", "id": 1, "error": { "code": "unauthenticated", "message": "…" } }
```

| Code | Meaning |
|---|---|
| `unauthenticated` | the credential is missing, wrong or revoked |
| `not_found` | no such agent or turn |
| `unsupported` | a method this provider does not implement |
| `invalid_request` | malformed parameters, or a mutation this provider declines |
| `rate_limited` | back off and retry |
| `internal` | anything else |

Only `unauthenticated` is load-bearing — it must be distinguishable, and it should carry HTTP 401 so a
client that never parses the body can tell a rejected credential from an outage. `message` is shown to
the user wherever one is present, so write it for them.

---

## Security

All traffic over TLS. The endpoint must be at a stable, publicly resolvable HTTPS URL the owner can
copy out of your product — no IP literals, no tunnels that move.

Everything a provider sends is **untrusted input** to the Autonomous web UI and to the physical device
screen. The Autonomous backend validates and allowlists every frame crossing this boundary;
non-conforming frames are dropped and logged, and a stream that repeats the violation is closed.

Providers are rate limited per machine; sustained excess closes the stream. Do not log or transmit the
supplied credential beyond what is required to authenticate the request.

Optional fields and new event kinds may be added over time. A published field is never renamed,
removed, retyped, or reinterpreted.

---

## Conformance

`reference-provider/` contains a scripted implementation and a runner. Point it at your endpoint:

```bash
npm run conformance -- --url https://agent.example.com --key <credential> \
                       --bad-key <deliberately invalid> --ask-phrase "<prompt that makes it ask>"
```

**Pass condition: zero failures.** Warnings and skips are expected and are printed with their reasons
— read them, do not just count them. Five things cannot be verified from outside and are human review:
tenant isolation, the truncation flag, fabricated statistics, rate limiting, and credential handling.

---

## Appendix A — A worked turn

```jsonc
// →  POST /   {"jsonrpc":"2.0","id":1,"method":"agent.send","params":
//              {"agentId":"seo","turnId":"t_01J8Z","message":{"text":"how is acme pacing?"}}}

// ←  200 text/event-stream
data: {"kind":"turn_started","turnId":"t_01J8Z","agentId":"seo","at":"2026-08-06T09:12:44Z"}

data: {"kind":"thinking_title","title":"Checking pacing"}

data: {"kind":"tool_start","toolId":"c1","tool":"query","title":"acme · last 30d"}

data: {"kind":"tool_end","toolId":"c1","tool":"query","ok":true,"summary":"1 row"}

data: {"kind":"text_delta","text":"Acme is at "}

data: {"kind":"text_delta","text":"118% of pace."}

data: {"kind":"done","text":"Acme is at 118% of pace."}

data: {"kind":"recap_start"}

data: {"kind":"recap_end","recap":"Acme at 118% of pace","text":"Acme is pacing 18% ahead…"}

data: {"kind":"turn_completed"}
```

The same objects, minus the lifecycle and recap frames, are what `agent.history` returns for that
agent.

## Appendix B — The smallest conformant provider

```jsonc
// agent.list      → { "agents": [{ "id": "main", "name": "Tiny" }] }
// agent.history   → { "agentId": "main", "events": [] }
// turn.cancel     → { "cancelled": true }
// agent.recap     → { "agentId": "main" }
// agent.create    → error { "code": "invalid_request", "message": "Agents are managed in Tiny" }
// agent.rename    → the same
// agent.delete    → the same
// agent.send      → SSE:
//                     data: {"text":"Hello."}
//                     data: {"kind":"turn_completed"}
```

Everything richer than this is opt-in.
