# Harness Provider Protocol (A2A profile)

**Status:** DRAFT, revision **0.2.0**. Public but not yet implemented by anyone outside Autonomous,
so it is still changing. Treat §12 as binding from 0.2.0 onward.

**Audience:** a third party who wants their agent platform to appear as a `provider` machine in the
Autonomous product — reachable from the web app and from the Harness device.

**What this document is:** a *profile* of the Agent2Agent (A2A) protocol, not a new protocol. If you
already run a conformant A2A agent, most of Tier 0 is already done. Everything Autonomous-specific is
expressed as declared A2A extensions or as metadata on standard objects — nothing here forks A2A.

**Related:** `onboarding.md` in this folder — what to do once your endpoint conforms.
The `reference-provider/` and `example-provider/` packages in this repository are working
implementations of everything below.

---

## 1. Target revision

This profile targets **A2A v1.0.1** (`github.com/a2aagent/A2A`, released 2026-05-28), the current
stable release under Linux Foundation governance.

A2A v1.0 ships official SDKs in **Python, JavaScript, Java, Go and .NET**. Autonomous therefore
publishes **no SDK of its own** — use the one for your stack. What Autonomous publishes instead is
this profile, a reference implementation, and a conformance runner you can point at your own endpoint.

> **HP-001** An implementation MUST declare its A2A protocol support through its Agent Card. Clients
> MUST NOT infer capability from anything else — the card is the single source of truth.

> **HP-002** A provider MUST implement A2A v1.0 or later. Autonomous pins to v1.0.1 and will state a
> new pin, with a deprecation window, before requiring anything newer.

> **HP-004** A provider SHOULD serve a **signed Agent Card** (A2A v1.0), so Autonomous can verify the
> card was issued by the domain owner rather than merely served from it. Because the card is this
> profile's single source of truth for capability (HP-001), signing it is the one control that makes
> that trust verifiable. Expect this to become a MUST in a future revision; providers onboarding now
> should plan for it.

### Canonical base

Everything this profile publishes lives under **`https://harness.autonomous.ai/api/a2a/`**:

| Path | What |
|---|---|
| `ext/<name>` | extension identifier URIs, used verbatim in `AgentCard.extensions` |
| `schema/<name>.json` | the JSON Schemas accompanying this document |

> **HP-003** Extension URIs are opaque identifiers and MUST be sent byte-for-byte as written in §8.
> A provider MUST NOT normalise, shorten, or re-host them; a mismatched URI means the extension is
> undeclared (HP-022).

Note that the `Part.metadata` key prefix is `autonomous.ai/` — a short reverse-DNS **key namespace**,
deliberately not a URL. It appears on every part of every streamed event, and the Harness device
renders under a tight frame budget, so the prefix is kept short on purpose.

---

## 2. Object mapping

| Autonomous concept | A2A concept | Notes |
|---|---|---|
| **machine** | one A2A agent endpoint | The credential the user supplies selects *which* workspace/tenant on the provider side |
| **agent** — one working unit inside a machine | `AgentCard.skills[]` entry | Read-only in Tier 0. **Not** the A2A sense of "agent" — see the note below |
| **session** (a chat thread) | `contextId` | Starting a new chat mints a new `contextId`; no call is required |
| **turn** (one user message until the agent stops) | `taskId` | Task lifecycle *is* turn lifecycle |
| **turn start / end** | `TASK_STATE_WORKING` → `COMPLETED` / `FAILED` / `CANCELED` | |
| **permission prompt / question to the user** | `TASK_STATE_INPUT_REQUIRED` | Native A2A. No extension |
| **credential rejected** | `TASK_STATE_AUTH_REQUIRED` | Distinguishable from an outage, so the UI can say "re-enter credential" |

> **One word, two meanings — read this before implementing.** A2A calls *your whole endpoint* an
> agent: that is what an `AgentCard` describes. Autonomous calls *one working unit inside a machine*
> an agent, and those map to the **skills** on your card. So a single A2A agent (you) exposes many
> Autonomous agents (your skills). The product model is **machine → agent → session**; on your side
> that reads **endpoint → skill → `contextId`**.

---

## 3. Transport and authentication

> **HP-010** The endpoint MUST be reachable over HTTPS at a stable, publicly resolvable URL. The URL
> is registered by Autonomous, not supplied by end users.

> **HP-011** The provider MUST declare its authentication requirement using standard A2A
> `securitySchemes`. `APIKey` and `HTTPAuth` (bearer) are the schemes Autonomous supports today.
> OAuth2 and OpenIdConnect are reserved for a later revision and MUST NOT be relied on.

> **HP-012** The credential is supplied by the end user in the Autonomous web app and presented by the
> Autonomous backend on every request. The provider MUST treat it as identifying **one tenant/user**
> on its side and MUST NOT grant it access beyond that tenant.

> **HP-013** A rejected credential MUST surface as `TASK_STATE_AUTH_REQUIRED` on a task, or as the
> A2A-standard authentication error on a non-task call — never as a generic failure. The product
> distinguishes "your credential is wrong" from "the provider is down", and cannot do so without this.

---

## 4. Agent Card (HP-0xx)

> **HP-020** The provider MUST serve an Agent Card at `/.well-known/agent-card.json`.

> **HP-021** `capabilities.streaming` MUST be `true`. A non-streaming provider is not usable: the
> product renders assistant output token by token.

> **HP-022** Every Autonomous extension the provider implements MUST be listed in
> `AgentCard.extensions` by its exact URI (§8). An extension that is implemented but undeclared MUST
> be treated by clients as absent.

> **HP-023** `skills[]` is the agent list. Each skill's `name` and `description` are shown to the
> user. A provider with no meaningful agent concept SHOULD expose exactly one skill representing the
> whole workspace.

Schema for the extension entries: `schema/agent-card.ext.json`.

---

## 5. Messaging (HP-1xx)

> **HP-100** The provider MUST implement `SendStreamingMessage` and return Server-Sent Events.

> **HP-101** A message that begins a new chat carries a fresh `contextId` and no `taskId`. A follow-up
> within the same chat carries the existing `contextId`.

> **HP-102** The provider MUST emit a terminal task state on every stream. A stream that ends without
> one is a protocol violation; clients will treat the turn as failed.

> **HP-103** The provider MUST implement `CancelTask`. After a successful cancel, the corresponding
> SSE stream MUST terminate and the task MUST report `TASK_STATE_CANCELED`.

> **HP-104** When the agent needs an answer from the user (a permission prompt, a clarifying
> question), the provider MUST enter `TASK_STATE_INPUT_REQUIRED` and MUST accept a subsequent Message
> carrying the same `taskId` as the answer.

> **HP-105** Assistant output MUST be delivered as `TaskStatusUpdateEvent` messages containing `Part`
> objects. Files produced by the turn SHOULD be delivered as `Artifact` via
> `TaskArtifactUpdateEvent`.

> **HP-106** A user message MAY carry image attachments. These travel as standard A2A `Part` objects
> using `raw` (base64) with `mediaType`, alongside the text part — no Autonomous extension is
> involved. A provider that cannot accept images MUST fail the task with a clear message rather than
> silently discarding them; silent loss reads to the user as the agent ignoring what they sent.

---

## 6. History (HP-2xx)

Chat history lives **entirely on the provider side**. Autonomous stores no transcript for a `provider`
machine — there is no database to fall back on. This is why the two methods below are required rather
than recommended: without them, a page refresh loses the conversation.

> **HP-200** The provider MUST implement `ListTasks`, and MUST support grouping/filtering by
> `contextId`. This backs the session list.

> **HP-201** The provider MUST implement `GetTask`, returning the full message history of the task.
> This backs the transcript view.

> **HP-202** For v1 the provider MUST return the complete transcript in a single `GetTask` response.
> Pagination is **not** part of this revision — see §10.1.

> **HP-203** A transcript exceeding **5 MB** serialized MAY be truncated by the provider, which MUST
> then mark the response so the client can tell the user the view is partial. Silent truncation is a
> violation.

---

## 7. Event vocabulary on `Part.metadata`

A2A core has no representation for thinking, tool calls, or the fine structure the product renders.
This profile defines a namespace on `Part.metadata`.

> **HP-210** Autonomous-specific metadata MUST be namespaced under keys beginning `autonomous.ai/`.
> Clients MUST ignore unknown keys in that namespace rather than failing.

> **HP-211** A provider that emits no `autonomous.ai/*` metadata is conformant. Its output renders as
> plain assistant text. Richness is opt-in.

The recognised event kinds — declared here **independently** of any Autonomous internal type, so that
this contract does not inherit an internal shape:

| `autonomous.ai/kind` | Meaning |
|---|---|
| `user_message` | the user's own turn, replayed in history |
| `thinking_delta` | a chunk of reasoning text |
| `thinking_title` | a short label for a reasoning block |
| `text_delta` | a chunk of assistant output |
| `tool_start` | a tool invocation began |
| `tool_end` | a tool invocation finished (with output, error flag, summary) |
| `context_compact` | the provider compacted its own context |
| `done` | the turn's final result text |

Turn lifecycle (`turn_started` / `turn_ended`) is **not** metadata — it is derived from A2A task
states, per HP-102.

Schema: `schema/part-metadata.json`.

---

## 8. Extensions (HP-3xx)

Each extension is optional and MUST be declared per HP-022. A client hides the corresponding feature
entirely when an extension is absent, rather than offering a control that fails.

| URI | Adds |
|---|---|
| `https://harness.autonomous.ai/api/a2a/ext/workspace-files` | browse and read files in an agent |
| `https://harness.autonomous.ai/api/a2a/ext/workspace-write` | create / rename / delete agents and sessions |
| `https://harness.autonomous.ai/api/a2a/ext/session-recap` | short persisted per-turn summaries (used by the device) |
| `https://harness.autonomous.ai/api/a2a/ext/voice` | provider-side routing of a spoken task to an agent |

### 8.1 Method naming

Extension methods travel on the **same JSON-RPC endpoint** as A2A core — there is no second URL.

> **HP-310** Extension methods MUST be named `autonomous.<Verb>`. The prefix keeps them from ever
> colliding with a current or future A2A core method name, and makes it obvious in a log which calls
> are profile extensions rather than standard A2A.

> **HP-311** A provider MUST reject a call to an extension method it has not declared, with JSON-RPC
> `-32601` (method not found). Answering a method the Agent Card does not advertise contradicts
> HP-022 and leaves the client unable to trust the card.

### 8.2 The extensions

> **HP-300** `workspace-files` — read-only file access, scoped to an agent.
> Methods: **`autonomous.ListFiles`** (`{ agentId, path? }` → `{ files }`) and
> **`autonomous.ReadFile`** (`{ agentId, path }` → `{ path, content, truncated? }`).
> Schema: `schema/ext-workspace-files.json`.

> **HP-301** `workspace-write` — mutations on agents and sessions. Methods:
> **`autonomous.CreateAgent`**, **`autonomous.RenameAgent`**, **`autonomous.DeleteAgent`**,
> **`autonomous.SetSessionTitle`**, **`autonomous.DeleteSession`**.
> `AgentCard.extensions[].params` declares which halves are supported: `{ agents: bool, sessions: bool }`.
> A provider declaring this extension MUST enforce that every operation stays inside the tenant
> identified by the credential. Schema: `schema/ext-workspace-write.json`.

> **HP-302** `session-recap` — short persisted per-turn summaries.
> Method: **`autonomous.GetRecap`** (`{ agentId, n? }` → `{ agentId, entries }`).
> Used to restore the device's tiles after a reboot; the device shows nothing rather than stale text
> when this is absent. An empty `entries` array is correct before any turn has been summarised.
> Schema: `schema/ext-session-recap.json`.

> **HP-303** `voice` — the provider chooses which agent a transcribed spoken task belongs to.
> Method: **`autonomous.RouteVoice`** (`{ transcript, candidateAgentIds? }` → `{ agentId, confidence?, reason? }`).
> **Optional and rarely needed**: Autonomous can route from `skills[]` names and descriptions without
> provider help, and does so by default. Declare this only to override that routing with your own.
> A `agentId` of `null` declines and hands routing back to Autonomous.
> Schema: `schema/ext-voice.json`.

---

## 9. Out of scope

Deliberate omissions. Listed so their absence is a decision on record and not a gap:

| Not in this profile | Why |
|---|---|
| Model / effort selection | The provider owns its own model configuration. Reaching into it from the Autonomous UI would fight the provider's own surface and expose a control we cannot honour consistently. No model picker is shown for `provider` machines |
| Agent login flows | The provider owns authentication. The credential field in the Autonomous UI is the entire story |
| Explicit context compaction | The provider manages its own context window. Autonomous never asks a provider to compact; the `context_compact` event kind (§7) exists only so a provider can *report* that it did |
| End-to-end encryption | `provider` machines are **not** end-to-end encrypted. Plaintext already originates at the provider, so E2EE between the user and the provider would hide content from Autonomous, not from the provider. Users are shown this explicitly. Providers are onboarded under a data-processing agreement, which is the control that replaces the cryptographic one |

Additionally, a set of frames exists on the Autonomous data plane that **never crosses this boundary**:
live speaking-presence indicators, client-count bookkeeping, machine metadata and revocation, and
device pairing. These are handled entirely inside Autonomous. A provider neither sends nor receives
them, and MUST NOT attempt to.

> **HP-400** A provider MUST ignore any frame it does not recognise rather than failing the stream.
> Autonomous replies `UNSUPPORTED` on behalf of a provider for any capability the Agent Card does not
> declare, so an undeclared feature never reaches the provider at all.

---

## 10. Field projections and resolved gaps

The Autonomous client requires fields A2A does not carry. Each is resolved here so implementers do not
have to guess. **Most are synthesised by the Autonomous backend — the provider burden is small.**

### 10.1 Transcript pagination

The Autonomous client can request a windowed transcript (a limit plus a cursor). A2A `GetTask` has no
equivalent.

**Resolution for v1:** the provider returns the full transcript (HP-202); the backend serves windowed
requests from that response and reports no further pages. A paging extension is deferred until a real
provider hits the 5 MB ceiling of HP-203. Recorded as a known limitation, not an oversight.

### 10.2 `engine`

The client models an engine as one of eight local CLIs. A provider machine is none of them.

**Resolution:** the field is **omitted** for provider-backed agents. The client treats an absent
engine as provider-backed and skips every engine-specific branch. Providers MUST NOT invent a value.

### 10.3 Skill → agent projection

| Client field | Source |
|---|---|
| `id` | the skill's id |
| `name`, `description` | the skill's `name`, `description` |
| `userId` | **synthesised** by the backend — the Autonomous owner of the machine |
| `status` | **synthesised** — constant `active` |
| `createdAt`, `updatedAt` | **synthesised** — the machine's own timestamps unless the skill carries better |
| `engine` | omitted (§10.2) |

### 10.4 Task → session-list item projection

| Client field | Source |
|---|---|
| `id` | `contextId` |
| `title` | task metadata title, else the first user message truncated |
| `timestamp`, `lastActivity` | task timestamps |
| `messageCount` | best-effort; **omitted when unknown**, and the client hides the count rather than showing zero |
| `participants` | not modelled by A2A; the client omits it |

> **HP-220** A provider MUST NOT fabricate `messageCount` or similar statistics. Omission is correct;
> a wrong number is worse than a missing one.

---

## 11. Security (HP-9xx)

> **HP-900** All traffic MUST be over TLS.

> **HP-901** Everything a provider sends is **untrusted input** to the Autonomous web UI and to the
> physical device screen. The Autonomous backend validates and allowlists every frame crossing this
> boundary; a provider MUST NOT rely on being able to inject arbitrary client-side structures.
> Non-conforming frames are dropped and logged, and a stream that repeats the violation is closed.

> **HP-902** Providers are rate limited per machine. Sustained excess closes the stream.

> **HP-903** A provider MUST NOT log or transmit the supplied credential beyond what is required to
> authenticate the request.

---

## 12. Versioning

This document is a **compatibility contract, not ordinary prose.** The same discipline the Autonomous
codebase applies to its own launcher/daemon contract applies here.

> **HP-910** Optional fields MAY be added to a published revision.

> **HP-911** A published field MUST NOT be renamed, removed, retyped, or reinterpreted. Any of those
> requires a new revision.

> **HP-912** When a new revision exists, providers and clients MUST be able to negotiate through the
> Agent Card. A revision MUST be served alongside its predecessor for a deprecation window; removing
> support without one breaks deployed integrations.

**0.1.0 → 0.2.0 was an exception, and the only one.** It renamed published fields (`projectId` →
`agentId`) and dropped 0.1.0 rather than serving both, which is precisely what HP-911 and HP-912
forbid. It was taken because 0.1.0 was one day old and had no implementers — there was no deployed
integration for the rule to protect. From 0.2.0 on there is, so the rule binds: a rename now means a
0.3.0 served alongside 0.2.0 for a deprecation window. If you are reading this because you already
implemented 0.1.0, contact us — that is a case we did not think existed.

---

## Appendix A — Clause index

| Range | Area |
|---|---|
| HP-001 … HP-004 | Target revision and canonical base |
| HP-010 … HP-013 | Transport and authentication |
| HP-020 … HP-023 | Agent Card |
| HP-100 … HP-106 | Messaging |
| HP-200 … HP-203 | History |
| HP-210 … HP-220 | Event vocabulary and projections |
| HP-300 … HP-311 | Extensions |
| HP-400 | Unknown frames |
| HP-900 … HP-903 | Security |
| HP-910 … HP-912 | Versioning |

Tier 0 (required for any provider) is: HP-003, HP-010–013, HP-020–023, HP-100–105, HP-200–203, HP-900–903,
HP-910–912. Everything in HP-3xx is optional.

## Appendix B — Conformance

The conformance suite asserts one check per clause ID and names the failing ID in its output, so a red
result points at a section of this document rather than at a symptom. See phase 6 of the
implementation plan.

## Appendix C — Coverage of the Autonomous client surface

Every operation the Autonomous client can issue, and where it lands in this profile. This table is the
audit artifact: **an entry that is neither Tier 0, nor an extension, nor explicitly out of scope is a
gap in the spec.** Re-run this audit whenever the client gains an operation.

| Client operation | Disposition |
|---|---|
| `message` | Tier 0 — HP-100 |
| `cancel` | Tier 0 — HP-103 |
| `permission_response` | Tier 0 — HP-104 (answer to `INPUT_REQUIRED`) |
| `question_response` | Tier 0 — HP-104 |
| `new_chat` | Tier 0 — no call; mint a fresh `contextId` (§2) |
| `agents_list` | Tier 0 — `AgentCard.skills` (HP-023) |
| `sessions_list` | Tier 0 — `ListTasks` (HP-200) |
| `session_get` | Tier 0 — `GetTask` (HP-201) |
| `agent_files` | Extension — `workspace-files` (HP-300) |
| `agent_read_file` | Extension — `workspace-files` (HP-300) |
| `agent_create` | Extension — `workspace-write` (HP-301) |
| `agent_update` (rename) | Extension — `workspace-write` (HP-301) |
| `agent_delete` | Extension — `workspace-write` (HP-301) |
| `session_update_title` | Extension — `workspace-write` (HP-301) |
| `session_delete` | Extension — `workspace-write` (HP-301) |
| `agent_recent` | Extension — `session-recap` (HP-302) |
| `voice_route` | Extension — `voice` (HP-303); Autonomous routes from `skills[]` by default |
| `agent_update` (model) | **Out of scope** — §9, provider owns model configuration |
| `models_list` | **Out of scope** — §9 |
| `compact` | **Out of scope** — §9, provider owns its context window |
| `claude_login_start` / `_submit` / `_status` | **Out of scope** — §9, provider owns authentication |
| `e2ee_pairings_list` / `_pairing_unpair` / `_pairings_unpair_all` / `e2ee_browser_link_create` | **Out of scope** — §9, no E2EE for `provider` |
| `speaking` | **Never crosses this boundary** — ephemeral presence, fanned out inside Autonomous |
| `__clients`, `machine_meta`, `machine_revoked`, `device_e2ee_pair` | **Never crosses this boundary** — Autonomous-internal control frames |

### Client-operation coverage — how to re-run this audit

Autonomous re-runs this audit whenever its client gains an operation: every one must appear above as
Tier 0, as a named extension, or as explicitly out of scope. An operation absent from this table is an
unresolved gap, not an implicit "no" — if you find one, say so rather than guessing.

### Event-kind coverage

The eight kinds in §7 (`user_message`, `thinking_delta`, `thinking_title`, `text_delta`, `tool_start`,
`tool_end`, `context_compact`, `done`) cover the client's full render vocabulary. Turn lifecycle
(`turn_started` / `turn_ended`) is carried by A2A task states per HP-102 and is deliberately not a
metadata kind. Nothing in the client's vocabulary is unrepresented.

---

## Appendix D — Worked example

One complete turn, end to end. Every field the Autonomous client needs is derivable from what appears
here; this example exists to prove that, and doubles as the shortest path to understanding the
profile.

**1. Discovery.** `GET https://agent.example.com/.well-known/agent-card.json`

```json
{
  "name": "Example Marketing Agent",
  "description": "Answers questions about ad spend and builds reporting queries.",
  "version": "1.0.0",
  "capabilities": { "streaming": true },
  "securitySchemes": { "apiKey": { "type": "apiKey", "in": "header", "name": "x-api-key" } },
  "skills": [
    { "id": "acme-reporting", "name": "Acme reporting", "description": "Acme's ad accounts" }
  ],
  "extensions": [
    { "uri": "https://harness.autonomous.ai/api/a2a/ext/session-recap" }
  ]
}
```

The client now shows one agent ("Acme reporting"). No file browser, no rename — those extensions
are absent. No model picker either; that is out of scope for every provider (§9).

**2. The user types a message.** Autonomous calls `SendStreamingMessage` with the user's credential in
the declared header, a fresh `contextId`, and no `taskId` (a new chat):

```json
{
  "message": {
    "role": "ROLE_USER",
    "messageId": "m-1",
    "contextId": "ctx-91af",
    "parts": [{ "text": "did acme blow through budget this week?" }]
  }
}
```

**3. The provider streams SSE.** Abridged to one event per kind:

```
event: status-update
data: {"taskId":"task-77","contextId":"ctx-91af","status":{"state":"TASK_STATE_WORKING"}}

event: status-update
data: {"taskId":"task-77","status":{"state":"TASK_STATE_WORKING","message":{"role":"ROLE_AGENT",
       "parts":[{"text":"Checking pacing…","metadata":{"autonomous.ai/kind":"thinking_delta",
       "autonomous.ai/thinkingId":"t1"}}]}}}

event: status-update
data: {"taskId":"task-77","status":{"state":"TASK_STATE_WORKING","message":{"role":"ROLE_AGENT",
       "parts":[{"text":"","metadata":{"autonomous.ai/kind":"tool_start",
       "autonomous.ai/toolCallId":"c7","autonomous.ai/tool":"query_spend",
       "autonomous.ai/toolInput":{"account":"acme","window":"7d"}}}]}}}

event: status-update
data: {"taskId":"task-77","status":{"state":"TASK_STATE_WORKING","message":{"role":"ROLE_AGENT",
       "parts":[{"text":"7 rows","metadata":{"autonomous.ai/kind":"tool_end",
       "autonomous.ai/toolCallId":"c7","autonomous.ai/tool":"query_spend",
       "autonomous.ai/isError":false,"autonomous.ai/summary":"Returned 7 rows",
       "autonomous.ai/durationSeconds":1.4}}]}}}

event: status-update
data: {"taskId":"task-77","status":{"state":"TASK_STATE_WORKING","message":{"role":"ROLE_AGENT",
       "parts":[{"text":"Acme is at 118% of pacing.","metadata":{"autonomous.ai/kind":"text_delta"}}]}}}

event: status-update
data: {"taskId":"task-77","status":{"state":"TASK_STATE_COMPLETED"},"final":true}
```

A provider that emitted only the two `text_delta`-shaped parts with **no** metadata at all would also
be conformant (HP-211) — the turn would simply render as plain text.

**4. What the client reconstructs.** `TASK_STATE_WORKING` opens the turn and the terminal state closes
it (HP-102); no metadata kind is involved. Reloading the page calls `GetTask("task-77")`, and the
same parts rebuild the transcript:

| Client field | Derived from |
|---|---|
| session id | `contextId` = `ctx-91af` |
| title | task metadata title, else the first user message truncated (§10.4) |
| timestamp | task timestamps |
| events | the `Part` sequence above, keyed by `autonomous.ai/kind` |
| status | terminal task state → `idle`; `TASK_STATE_FAILED` → `error` |
| engine | omitted (§10.2) |
| messageCount | not sent; the client hides the count rather than showing zero (HP-220) |
| hasMore / cursors | absent — v1 returns the whole transcript (HP-202) |

**5. If the agent needs an answer.** Instead of completing, the provider emits
`TASK_STATE_INPUT_REQUIRED` with a question in the message. Autonomous renders it, and the user's
answer returns as a new Message carrying **the same `taskId`** (HP-104). The task then resumes and
completes as above.
