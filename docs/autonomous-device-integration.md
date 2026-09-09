# Autonomous device ↔ Mac: direct discovery and original Harness E2EE

The Mac discovers Autonomous OS on the local network and connects **directly to the device**.
No manual IP address, device backend credentials, cloud device registration, or backend relay is
involved in this path. The existing Harness Mac login/start behavior is unchanged; an already
running daemon can pair and operate while its backend connection is offline. Buddy is untouched.

## Discovery and pairing

Autonomous OS already advertises `_autonomous._tcp` using Avahi. CLI uses `bonjour-service` to
browse that existing service for three seconds. It returns stable DNS-SD instance IDs and the
advertised host/port; no new Avahi service or script is needed. Metadata is untrusted discovery,
not authorization. The user selects a discovered device and enters the code displayed by it.

```sh
harness autonomous-device discover --json
harness autonomous-device pair --device '<discovery id>' --code-stdin
harness autonomous-device status --json
harness autonomous-device list --json
harness autonomous-device revoke '<full fingerprint>'
```

Desktop writes the device code to stdin and closes stdin. Terminal users can use
`pair <device-code> --device <discovery-id>`. No response echoes the code. No address entry, listen,
replace or blanket revoke command exists. A stale discovery ID returns DEVICE_NOT_FOUND; if the
selected device has not opened pairing, NO_INTENT. Wrong code fails the original PAKE and closes
the attempted socket; a retry makes a fresh socket and requests a new device intent.

CLI connects `ws://<discovered-host>:<SRV-port>/api/harness/ws`. The service may advertise port80;
its existing nginx must forward WebSocket upgrade for that exact route to OS-server. Never hardcode
OS port5000 or ask the user to type it. First message:

```json
{"type":"machine_select","payload":{"machineId":"stable-harness-machine-id","label":"Mac name"}}
```

OS responds machine_selected. During device pairing it sends original e2e_pair_intent role device;
CLI accepts the human code and delegates to the existing E2eeManager. After original PAKE, OS
sends original e2e_hello on the same direct socket. CLI waits for authentication as the exact newly
paired device before reporting success. On reconnect, OS sends e2e_hello using its stored pin.

The Mac retains only `{discoveryId,fingerprint}` association metadata in
`${ADAPTER_DATA_DIR}/autonomous-device-connections.json`; keys and trust remain exclusively in
original E2eeManager/paired.json. Every 15 seconds it rediscovers disconnected saved devices.
Discovered reconnect identity must match the saved fingerprint, even if a different identity is
already trusted elsewhere. Revocation deletes the association, closes its direct socket and stops
reconnect. Browser/dial pairings retain their existing behavior and are never blanket-revoked.

Direct connections enter the **same** daemon manager via isolated connIds and targeted sends.
Inbound direct whitelist is original device PAKE/cancel/hello/status plus Autonomous device app
RPC, never generic backend/terminal/admin handlers, setup claims or remote-password PAKE.
Pair intent/PAKE is accepted only during an explicit direct pairing attempt. Backend disconnection
drops relay sessions but preserves direct ones. Offline pairing availability is checked for the
specific pending connection, so a direct socket cannot authorize pairing an offline browser slot.
Only an authenticated application hello activates recap generation/notifications.

## Local management facade

All routes remain on the credential-checked loopback hook server. There is no new Mac LAN listener.

| Route | Input/result |
|---|---|
| GET `/api/autonomous-device/discover` | `{devices:[{id,name,host,port}]}` discovered candidates |
| POST `/api/autonomous-device/pair/start` | `{code,device:<discovery-id>}` → `{state:"paired",label,fingerprint}` |
| GET `/api/autonomous-device/pair/status` | existing pending device status idle/waiting/running |
| GET `/api/autonomous-device/status` | `{transport:"direct",connected,paired,sessions,proto:1}`; connected/sessions count authenticated application-ready direct sessions only |
| GET `/api/autonomous-device/list` | `{devices:[{id:fingerprint,fingerprint,label,pairedAt,online,role,current}]}` existing trusted device-role identities |
| POST `/api/autonomous-device/revoke` | `{id:<full fingerprint>}` → `{revoked:1}` |
| GET `/api/autonomous-device/receipt?deviceId=…&idempotencyKey=…` | existing receipt; deviceId here is canonical public key |

Discovery id and trusted fingerprint are distinct identifiers. A user chooses a discovery record
for pairing; revoke targets the exact existing trusted fingerprint. Original `harness pair` and
browser/dial UI behavior are unchanged. Direct pairing is initiated by the named facade above.
When the device revokes its own local trust, it sends the authenticated application request
`{type:"pair.revoke",requestId}` and waits for `pair.revoke_result` before closing its socket.
The CLI then removes that exact device identity and its reconnect metadata. A socket close without
this request remains `offline`, rather than being treated as a revoke, so transient LAN failures do
not unpair the device.

## Existing encrypted wire, unchanged

Client identity and session use `cli/src/lib/e2ee/core.ts` and `manager.ts` exactly:

- `e2e_pair_intent`, `e2e_pair_intent_result`, `e2e_pair_cancel`, `e2e_pake` payload rounds 1–5;
  CPace CI `autonomous-e2e-pair|agent:<machineId>|a:adapter|b:device`.
- `e2e_hello` payload `{identityPub,ephPub,sig}` using existing `helloSig`.
- `e2e_welcome` payload `{webEphPub,ephPub,sig,enc}` using existing `welcomeSig`. `enc` is AEAD
  server counter 0, AAD `e2e-welcome`, plaintext `{groupKey,epoch,features}`.
- Existing X25519 sessionKeys, pairwise counters/replay window and `e2e_rekey` behavior.
- No custom canonical hello/welcome signature, challenge, `autonomous_device_finished`, or custom
  identity file. The device needs its own existing E2EE identity/pin, separate from Buddy.

After original E2EE session establishment on the direct socket, application RPC uses:

```json
{"type":"autonomous_device_request","machineId":"selected-machine","payload":{"__e2e":{"v":1,"k":"p","n":0,"ct":"..."}}}
```

AAD uses existing wrapPayload: `1|autonomous_device_request||p|`; no dbSessionId on this envelope.
The encrypted payload is the full application request. CLI intercepts before frame logging,
requires an authenticated role-device session and ciphertext, and derives receipt identity from
that session, never from a client-supplied identifier. Results use outer `autonomous_device_result`
and events use outer `autonomous_device_event`, encrypted via existing wrapTarget with the same
empty dbSessionId AAD convention. Machine targeting is explicit in the inner application request. No cloud routing is involved.

First encrypted application request:

```json
{"type":"hello","requestId":"uuid","proto":1,"resume":{"serverInstanceId":"previous","cursor":4}}
```

Result plaintext: `{type:"hello_result",requestId,proto:1,machineId,serverInstanceId,capabilities,
resumed,cursor}`. Resume is optional. This is application capability/resume negotiation, not a new
cryptographic handshake. Existing session proof is the encrypted request. Then replay/resync and
normal requests below follow. Result plaintext retains the service's `<operation>_result` type.
Events retain full `{type:"event",...}` inside their encrypted outer envelope. Old browsers and
dials remain on their existing request/event protocol.

## Application requests, results and events

All requests have UUIDv4 `requestId`. Unknown fields are rejected. Responses use
`{type:"<operation>_result",requestId,...}`. Application failures before acceptance have
`error:{code,message}` without a receipt. Mutations successfully reserved have `status` and receipt;
a duplicate may return any retained receipt state. Supported operations:

| Operation | Additional request fields | Success fields |
|---|---|---|
| `agents.list` | none | `machineId,agents:[{machineId,agentId,name,engine,state}]` |
| `status` | `machineId,agentId` | `machineId,agentId,state,openQuestion:null\|{requestId,questions}` |
| `recap` | `machineId,agentId,n?` (default 3, integer 1–5) | `machineId,agentId,turns:[{kind,text,recap?,fullText?}]` |
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
`turn.tool`, `agent.error`, `question.open`, `question.close`.

`turn.summary` payload and `recap` turn entries carry three views of one answer, and a consumer should
prefer `turns[].fullText`, then `turn.summary.fullText`, then `text`:

| Field | Limit | What it is |
|---|---|---|
| `recap` | 60 chars | the first prose sentence — a tile headline |
| `text` | 250 chars | the answer flattened to one line and clipped — a glance |
| `fullText` | 8192 bytes UTF-8 | the assistant's final message as shown on screen, markdown and line breaks intact |

`fullText` is optional and absent when no answer was recorded, so read it defensively. It holds only the
final user-facing response — never tool transcripts, hidden reasoning or terminal output — and it costs
no extra model call: it is the same text the local summarizer already receives.

The 8192-byte cap is arithmetic, not taste: the direct socket accepts 65536 bytes, `recap` may return
five turns at once, and sealed payloads grow by roughly 37% through AEAD and base64. Oversized truncation
is UTF-8 safe and marked with a trailing `…`. `text` and `recap` are unchanged byte-for-byte, and the
shared `commander_event` card is not widened — the USB dial's encoder throws above an 8 KiB frame, so the
field is added only to the events this service emits. Question-open payload is
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
A per-relay-connection token bucket permits burst 20, refilling one request/second, with at most four async
requests in flight; a new relay connection starts a new quota. Excess returns an error result.
Direct transport uses an outbound WebSocket; reconnection rediscovers the saved service identity. There is
currently no server-wide request timeout guarantee.

## Implementation and validation

`discovery.ts` browses existing mDNS with bonjour-service; `direct.ts` owns outbound sockets and
non-secret reconnect associations. `relay.ts` is the retained application/E2EE adapter name, not a
network backend dependency; it sends on the direct connId through existing manager wrapTarget.
`service.ts` retains local agent dispatch and bounded receipt/dedupe logic.
Focused CLI tests and typecheck pass, including discovered-target-only pairing, failed-attempt
fresh retry, authentication before success and reconnect identity mismatch. Real mDNS discovery and direct Go OS ↔ CLI integration passed with the backend never connected:
advertised SRV port, wrong-code/fresh retry, original PAKE/session, encrypted list/send/dedupe,
restart/reconnect and revoke/unpair. This is a real local client/server test, not physical-device deployment.
Full CLI regression passed: `npm test -- --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000`
(144 files / 1,871 tests passed; 5 files / 50 tests skipped), plus `npm run typecheck`.
The default 5-second test deadline timed out in existing password/scrypt tests under local load;
the serial run uses command-line deadlines only and does not change test files or configuration.
No physical device deployment.
