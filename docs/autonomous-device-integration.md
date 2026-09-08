# Autonomous device ↔ Harness CLI: implemented protocol v1

Code is implemented and the real Go OS client → CLI loopback pairing flow has passed. Physical
device testing is **not yet completed**. This document
replaces the proposed revisions and describes the current implementation. Do not treat fixtures or
unexecuted tests as evidence of interoperability.

## Architecture and scope

Autonomous device connects to a dedicated LAN WebSocket on the CLI. Desktop manages pairing through the
existing authenticated loopback hook API. Desktop need not stay open. No cloud/backend changes,
device SSO token, raw terminal access, shell execution, agent creation/deletion, remote-machine
access, model changes, or tool-permission approval are provided. Autonomous Buddy is untouched
in this repository. OS owns conversation target selection; every targeted request must explicitly
name `machineId` and `agentId`.

Implementation: `cli/src/lib/autonomous-device/{transport,crypto,store,service,localApi,command}.ts` and wiring in
`cli/src/cli.ts`. Existing SessionInputController remains the delivery path. Existing E2EE
`core.ts` is unchanged; USB dial, cloud device links and Desktop loopback remain separate.

## Listener and management

Default bind `0.0.0.0`, port `18474`; configure `HARNESS_AUTONOMOUS_DEVICE_BIND` and `HARNESS_AUTONOMOUS_DEVICE_PORT`.
`HARNESS_AUTONOMOUS_DEVICE_IFACE` and mDNS are not implemented. Pairing returns a manually entered
`host:port` address. On multi-interface machines the default address is the first external IPv4
address; bind an explicit address if that is inappropriate.

No LAN listener opens on a fresh daemon until pairing starts. It stays open while an incumbent,
pending candidate or pairing window exists, including after restart with stored trust. With no
trust/window it closes on the next housekeeping tick (approximately one second).

LAN URL: `ws://<host>:18474/api/autonomous-device-ws`. No TLS; authenticated application encryption supplies
confidentiality. No query parameters, Origin, Cookie, Authorization header or subprotocol. The LAN
HTTP server exposes no management routes. At most 16 simultaneous sockets, 64 KiB frames,
10-second session-auth deadline, WS ping every 20 seconds; missing the next pong terminates.

Management uses existing loopback hook server and `Authorization: Bearer <hook credential>`.
Origin is refused. Success is direct JSON below; failure is `{error:{code,message}}` with HTTP
status, not an OS `status/data` wrapper.

| Method and path | Body | Success |
|---|---|---|
| POST `/api/autonomous-device/pair/listen` | `{}` or `{replace:true}` | `{state:"listening",expiresAt,machineId,machineName,address,fingerprint}` |
| POST `/api/autonomous-device/pair/start` | `{code,pairId?,replace?}` | `{state:"running",pairId,deviceLabel,expiresAt,address}` |
| POST `/api/autonomous-device/pair/cancel` | `{}` | `{cancelled:true}` |
| GET `/api/autonomous-device/pair/status` | — | `{state,pairId?,deviceLabel?,expiresAt?,address?,pendingFirstSession?,deviceFingerprint?,error?}` |
| GET `/api/autonomous-device/list` | — | `{devices:[{id,label,fingerprint,pairedAt,lastSeenAt,enabled,online,pendingFirstSession}]}` |
| POST `/api/autonomous-device/revoke` | `{id}` or `{all:true}` | `{revoked:number}` |
| GET `/api/autonomous-device/status` | — | `{listening,bind,port,address,paired,sessions,serverInstanceId,proto:1}` |
| GET `/api/autonomous-device/receipt?deviceId=…&idempotencyKey=…` | — | `{receipt:Receipt|null}` |

`id` and `deviceId` are the **canonical base64 32-byte Ed25519 public key**, not fingerprint.
Percent-encode query parameters. `pair/status.state` is idle/listening/waiting/running/paired/failed. No management response returns a pairing code. The Autonomous device generates and displays it;
Desktop/CLI accepts human input and sends it only through authenticated loopback management. `paired` in overall
status counts confirmed incumbent, whereas list may also expose one pending candidate.
`online:false` does not mean unpaired. `pendingFirstSession:true` means pairing awaits session
confirmation. An already paired machine returns HTTP 409 `ALREADY_PAIRED`; use list for identity
before a deliberate `replace:true`. Concurrent pairing starts return `BUSY`.

CLI (daemon must already be running):

```sh
harness autonomous-device status --json
harness autonomous-device listen
# Start pairing on the device with the returned computer address, then enter its displayed code:
harness autonomous-device pair <device-code>
harness autonomous-device pair-status
harness autonomous-device cancel
harness autonomous-device list --json
harness autonomous-device listen --replace
harness autonomous-device pair <device-code> --replace
harness autonomous-device revoke '<base64-id>'
harness autonomous-device revoke --all
```

## Pairing and single-device trust

The Autonomous device generates and displays a six-character code. To make the computer reachable,
Desktop/CLI first opens a 60-second **enrollment listener** (`pair/listen`), which generates no code.
The device connects to the displayed computer address and sends an intent. Desktop shows that
pending device and asks the user for the code displayed on it. Entering that code via `pair/start`
is the human authorization. Until then the CLI sends accepted metadata but **no PAKE round 1**.
At most three PAKE attempts are permitted per listener window; opening a fresh window is local.
Pairing label is 1–80 characters with no ASCII control characters.

`pair/start` takes `{code,pairId?,replace?}`. Desktop must send the exact pending pairId it displayed.
The terminal may omit pairId to target the sole pending intent. A stale supplied ID is `STALE_PAIR`,
missing pending intent is `NO_INTENT`, an already running exchange is `BUSY`. Both listen and start
require `replace:true` if a confirmed incumbent exists. Cancel/expiry never deletes that incumbent.
Use `harness autonomous-device pair --code-stdin --pair-id <id> [--replace]` from Desktop: write the
code followed by EOF to child stdin, never process arguments, logs or telemetry. Positional
`pair <code>` remains available for deliberate terminal use. No API response echoes the code.

The CLI is CPace initiator `a`; device is responder `b`. Pair ID is 16 random bytes, canonical base64.
Only cryptographic handshake material and display metadata are cleartext.

```
DEVICE_CI = autonomous-e2e-pair|agent:<machineId>|a:adapter|b:autonomous-device
```

1. Autonomous device sends `{type:"autonomous_device_pair_intent",pairId,role:"autonomous-device",label}`.
2. CLI replies `{type:"autonomous_device_pair_intent_result",accepted:true,machineId,machineName,ttl}`,
   then waits for the human to enter the device code via `pair/start`. Only then it sends
   `{type:"autonomous_device_pake",pairId,round:1,ya}`. The received machine ID is provisional until PAKE
   authentication succeeds; altering it changes the channel binding and fails authentication.
3. Autonomous device derives generator from code, pair ID and CI, creates `(y,Yb)` and computes shared K,
   `isk=cpaceISK(sid,K,Ya,Yb)`, `th=transcriptHash(sid,CI,Ya,Yb)`, `kc=kcKeys(isk,CI)`.
   Sends `{type:"autonomous_device_pake",pairId,round:2,yb,mac:base64(macTag(kc.web,th))}`.
4. CLI verifies MAC and returns round 3 with `mac=base64(macTag(kc.adapter,th))` and encrypted
   identity `enc`. Autonomous device verifies MAC, decrypts identity, verifies pair binding and retains a
   provisional CLI pin for reconnect recovery.
5. Autonomous device returns round 4 with its encrypted identity and pair binding signature. CLI durably stages
   the candidate, preserving incumbent, then replies round 5 `{ok:true,fingerprint,deviceId}`.
6. Autonomous device completes the session handshake below. **Only encrypted `autonomous_device_finished` promotes the
   candidate and replaces the incumbent.** A failed/expired/cancelled attempt cannot remove the old
   device. Losing round 5 is recoverable using the provisional pin and a normal signed session.

For rounds 3 and 4, plaintext is `JSON.stringify({id:base64(identityPub),sig:base64(pairBindSig(priv,th))})`.
`enc=base64(aeadSeal(pairKey(isk,CI),round,utf8("e2e-id"),utf8(plaintext)))`.
All byte fields are canonical base64. Implement **the existing noble CPace construction**, which
uses Ristretto255 hash-to-group with XMD SHA-512, not the IETF CPace draft wire format.

Pair errors use `{type:"autonomous_device_pair_error",error:{code}}`; current state machine returns
`EXPIRED`, `BUSY`, `RATE_LIMITED`, `CANCELLED`, or `CODE_MISMATCH` (the latter also covers
malformed/out-of-order PAKE input). A client must not send user requests during pairing.

Trust file `${ADAPTER_DATA_DIR}/e2e/autonomous-devices.json` is atomically replaced, mode 0600 in directory 0700:

```json
{"v":1,"paired":null,"pending":null}
```

Reads/writes use the existing secureState guards: no symlink directory/file, owner UID/type checks,
refusal of group/world-writable preexisting state, and 16 KiB maximum file size. Temporary files
are exclusive/no-follow 0600, fsynced before atomic rename; the directory is fsynced afterward.

Each non-null record has `{id,identityPub,label,pairedAt,lastSeenAt,enabled:true,pendingFirstSession}`.
At most one incumbent and one provisional candidate; candidate expires after five minutes, also
on restart. Confirmed trust does not expire on disconnect. Malformed trust fails closed instead of
silently clearing identities. CLI reuses the existing durable computer identity. Revoke deletes
matching trust, immediately closes sessions, drops queued delivery and clears retained receipt
history for the old device. It cannot undo an already injected prompt.

## Session authentication and encryption

Hello fields:

```json
{"type":"autonomous_device_hello","proto":1,"deviceId":"<base64 identity pub>","ephPub":"<base64 X25519 pub>","machineId":"machine","capabilities":["agents.list","turn.send","turn.stop","status","recap","question.answer","receipt.get"],"client":{"name":"autonomous-device","version":"1"},"resume":{"serverInstanceId":"previous","cursor":4},"sig":"<base64>"}
```

`client` and `resume` are optional. Resume cursor is a nonnegative safe integer. Canonical JSON
sorts object keys recursively, preserves array order and omits only the **top-level** `sig`.
Nested fields named `sig` remain authenticated. Use exact UTF-8 JSON and length-prefixed `lvCat`:

```
H(frame) = sha256(utf8(canonical(frame without top-level sig)))
helloMessage = lvCat("autonomous-device-hello-v1", machineId, H(hello))
welcomeMessage = lvCat("autonomous-device-welcome-v1", machineId, H(welcome), deviceEphemeralPubBytes)
sig = base64(Ed25519.sign(identityPrivate, message))
```

CLI verifies against stored pin. Unknown identity → `UNKNOWN_DEVICE`; wrong signature →
`UNAUTHORIZED`; signed unsupported proto → `PROTO_UNSUPPORTED`.

Welcome is `{type:"autonomous_device_welcome",proto:1,machineId,machineName,ephPub,serverInstanceId,
capabilities,limits,resumed,cursor,challenge,sig}`. Capabilities are intersection; `challenge` is a
fresh UUID signed with the whole welcome. Session key derivation uses existing `sessionKeys` with
ordering `(deviceEphPub,cliEphPub)` on both sides. Autonomous device verifies the pinned CLI signature before
using keys. Then device sends encrypted `{type:"autonomous_device_finished",challenge}`. CLI promotes trust,
closes the older session and sends encrypted `{type:"autonomous_device_ready",serverInstanceId}`, followed by
replay/resync. A replayed signed hello without ephemeral possession cannot disconnect a live device.

Every encrypted frame:

```json
{"type":"turn.send","agentId":"agent","payload":{"__e2e":{"v":1,"k":"p","n":1,"ct":"<base64>"}}}
```

Plaintext is the **full request/result/event object**, including `type` and optional `agentId`.
Outer/inner fields must match. AEAD is ChaCha20-Poly1305; AAD is exactly
`1|<outer type>|<outer agentId or empty>|p|`. No epoch/group key. Nonce is 8-byte big-endian
counter followed by four zero bytes. Directional counters start at zero; `autonomous_device_finished` uses
client counter zero and `autonomous_device_ready` uses server counter zero. Replay window is 4096 counters;
invalid authentication does not consume the counter. User content is never sent plaintext.

| Close code | Meaning |
|---|---|
| 4401 | Unauthorized/invalid frame/authentication timeout |
| 4403 | Revoked |
| 4404 | Unknown device |
| 4408 | Same device superseded: old socket must not reconnect |
| 4409 | Unsupported protocol |
| 4410 | Different device replaced incumbent |
| 4413 | Outbound frame exceeds size limit |
| 1009 | Inbound WS message exceeds 64 KiB (ws library) |
| 1011 | Backpressure: reconnect with backoff and resync |
| 1001 | Daemon stopping |

Untrusted `autonomous_device_denied` cleartext has `{error:{code,message}}`. OS must not let a network attacker
silently erase durable trust based solely on an unauthenticated denial; surface and require re-pair
when appropriate. A malformed trusted-session payload is dropped if AEAD/schema validation fails.

## Application requests, results and events

All requests have UUIDv4 `requestId`. Unknown fields are rejected. Responses use
`{type:"<operation>_result",requestId,...}`. Application failures before acceptance have
`error:{code,message}` without a receipt. Mutations successfully reserved have `status` and receipt;
a duplicate may return any retained receipt state. Supported operations:

| Operation | Additional request fields | Success fields |
|---|---|---|
| `agents.list` | none | `machineId,agents:[{machineId,agentId,name,engine,state}]` |
| `status` | `machineId,agentId` | `machineId,agentId,state,openQuestion:null\|{requestId,questions}` |
| `recap` | `machineId,agentId,n?` (default 3, integer 1–5) | `machineId,agentId,turns:[{kind,text,recap?}]` |
| `turn.send` | `machineId,agentId,idempotencyKey,text` | `status,receipt` |
| `turn.stop` | `machineId,agentId,idempotencyKey` | `status,receipt` |
| `question.answer` | `machineId,agentId,idempotencyKey,questionRequestId,answers` | `status,receipt` |
| `receipt.get` | `idempotencyKey` | `receipt:null\|Receipt` |

`idempotencyKey` matches `[A-Za-z0-9_-]{1,64}`. Prompt must be nonblank and ≤16 KiB UTF-8;
it is never truncated. Answers is a nonempty object mapping question keys to string answers.
Question ID must still be open. Question answering cannot approve tool permissions.
Agent state currently derives `running`/`idle` from the local registry/turn tracker.
There is no CLI selection operation: OS retains a validated explicit target.

Receipt:

```json
{"idempotencyKey":"device-1","deliveryId":"<uuid>","operation":"turn.send","state":"queued","machineId":"machine","agentId":"agent","serverInstanceId":"<uuid>","turnId":null,"error":null,"at":1757302040000}
```

States: `queued`, `delivered`, `started`, `completed`, `rejected`, `unknown`. `turnId` is local
receipt correlation generated when start is observed, not an engine-native transcript ID.
`status` is `accepted` or `duplicate`; accepted means a reservation was created, not delivery or
completion. After reservation every result carries a receipt, including revoked or failed requests.
A proven failure is `receipt.state:"rejected"`; failure details remain inside `receipt.error`.
Successful stop/answer transitions its own receipt to completed; an unconfirmed outcome is unknown.
Submit exceptions and ambiguous post-dispatch failures are unknown. Only proven no-delivery cases
may be rejected. `receipt:null` means no information, never proof a request did not run.

Dedupe is reserved synchronously before dispatch, keyed `(deviceId,idempotencyKey)`, comparing all
validated request fields except correlation IDs (normalized to null before canonical SHA-256).
Same key/different intent → `IDEMPOTENCY_CONFLICT`. Receipt capacity is 512 total. Completed and
rejected entries age out after 30 minutes from their last transition. At capacity, the oldest
completed/rejected receipt is evicted, even if younger than 30 minutes; retention is bounded by
both capacity and TTL. Outstanding/unknown entries are never silently evicted: if all 512 are
unresolved, new mutations receive `BACKPRESSURE`. Evicting these entries would permit a duplicate
live prompt; this explicit exception takes precedence over unconditional oldest-entry eviction.
A retired key may be treated as new, so never auto-resend after `receipt:null`. All receipts/events are
RAM-only. Every daemon start has a new UUID `serverInstanceId`; no mutation auto-replay is safe
across restart. Revoke clears the old device's receipts and event replay history.

Events are encrypted full objects:

```json
{"type":"event","eventId":1,"serverInstanceId":"<uuid>","machineId":"machine","agentId":"agent","kind":"receipt.updated","payload":{"receipt":{},"idempotencyKey":"device-1"}}
```

Kinds include `receipt.updated`, `turn.started`, `turn.done`, `turn.error`, `turn.summary`,
`turn.tool`, `agent.error`, `question.open`, `question.close`. Question-open payload is
`{questionRequestId,questions}`. Status uses `openQuestion.requestId` for that same identifier.
Only device-origin turns with known correlation include `idempotencyKey`/`turnId`.
Ring capacity 500; cursor is `(serverInstanceId,eventId)`. Matching retained cursor replays newer
events. Changed instance or stale cursor returns encrypted `{type:"resync",reason:
"instance_changed"|"cursor_too_old",serverInstanceId,cursor}`. First connect also requests resync.
OS re-reads agents/status and reconciles outstanding keys using receipt.get. Queued means wait;
delivered/started/completed means adopt; rejected means report; unknown/null means inspect and ask
before resending. Never automatically replay mutations on reconnect.

Application errors include `INVALID_REQUEST`, `UNSUPPORTED_CAPABILITY`, `MISSING_TARGET`,
`MACHINE_MISMATCH`, `AGENT_NOT_FOUND`, `PAYLOAD_TOO_LARGE`, `QUESTION_STALE`,
`IDEMPOTENCY_CONFLICT`, `BACKPRESSURE`, `RATE_LIMITED`, `REVOKED`, `INTERNAL`.
A per-identity token bucket permits burst 20, refilling one request/second, with at most four async
requests in flight; these limits survive same-identity reconnect. Excess returns an error result.
Outbound buffered data >1 MiB closes the session (1011); the OS reconnects/resyncs rather than
receiving silent event gaps. There is currently no server-wide request timeout guarantee.

## Fixtures and validation status

`cli/src/lib/autonomous-device/vectors/autonomous-device-protocol.json` contains **public test keys** and deterministic
CPace generator/scalars/shared secret/ISK/MACs, identity ciphertext, signed session messages,
X25519 session keys, encrypted `autonomous_device_finished` (client counter 0), encrypted `autonomous_device_ready`
(server counter 0), and a Unicode prompt (client counter 1). The signed welcome challenge and
key-confirmation step are mandatory protocol v1 fields, not an optional extension. Regenerate from CLI directory:

```sh
./node_modules/.bin/tsx src/lib/autonomous-device/vectors/generate.ts
```

The OS-generated-code flow passed CLI typecheck and focused tests (5 files/53 tests), plus a real
Go OS client → CLI loopback run covering wrong-code rejection, encrypted session readiness,
agent list/send/dedupe, incumbent preservation on failed replacement and successful replacement.

Generation is not a test. Final validation after reversing pairing direction: `npm run typecheck`
passed; full `npm test` passed 144 files/1873 tests, with 5 files/50 tests skipped (30.41 seconds).
This includes real WebSocket pairing/reconnect/revoke/tamper, service/local API and stdin command
coverage. Before release complete
CLI build and cross-language fixture assertions, then an explicitly authorized physical-device
pairing/voice flow. No device was deployed or paired here.
