# Mesh secret for machine-to-machine E2EE (replaces `harness link create/import`)

Status: proposed · 2026-08-28

## Context

A user can own several **machines**, each with its own Ed25519 identity
(`E2eeStore`, `cli/src/lib/e2ee/store.ts`). To E2EE two machines directly
with each other (machine-to-machine relay, not through a browser), today's
flow is per-pair and manual:

1. On the target machine T: `harness link create` builds a `SetupTokenPayload`
   signed with T's own identity (`core.ts:181-232`, `encodeSetupToken`),
   7-day TTL, reusable until expiry.
2. User copies the token to source machine S, runs `harness link import
   <token>` → `claimSetupToken` (`relayClient.ts:157-225`) dials
   `/api/web-ws`, sends `machine_select{machineId:T}` then
   `e2e_setup_claim{token, identityPub:S.pub, sig}`.
3. `manager.ts` `onSetupClaim` on T verifies + pins S into T's `paired.json`;
   S pins T into its own `machinePeers.json` (`cli.ts:3600`).
4. Result: trust for **exactly one ordered pair**. Full-mesh over N machines
   needs N·(N-1) manual create/copy/import cycles.

**Goal of this plan:** the user generates **one secret**, imports it into
every machine, and any two machines in that group bootstrap E2EE with each
other automatically the first time they need to talk — zero per-pair steps.

Verified in code (no backend change needed for any of this):
- `apps/backend/src/lib/webWs.ts` `handleFrame` forwards any frame type it
  doesn't special-case straight to the target machine once `machine_select`
  succeeds and `binding.userId === user.sub` — pure ownership check, no
  extra secret at the backend layer. All work below is confined to this
  repo (`autonomous-harness/cli`).
- Real chat traffic (post-bootstrap) uses a fresh ephemeral X25519 key per
  connection (`sessionKeys`, `core.ts:242`), independent of whatever
  bootstrapped the identity pin — so this redesign only changes how two
  machines first come to trust each other's Ed25519 identity, never the
  confidentiality of ongoing traffic.
- CPace primitives already in `core.ts:133-179` (used today for the 6-char
  browser pairing code) are reusable for a persistent secret: each run has
  its own `sid`/ephemeral values, so reusing the same secret across many
  bootstrap runs does not create cross-run transcript collisions.

**Decisions locked in with the user:**
- Bootstrap is fully automatic (zero-touch) — but every new mesh pin must be
  logged clearly (daemon log + visible in `harness mesh status`), so a
  compromise-driven pin still leaves a trail the user can audit. This is
  the one accepted tradeoff: removing the human-in-the-loop step means a
  leaked secret + one compromised machine can self-propagate trust across
  the whole mesh — logging is the mitigation, not a blocker.
- `harness link create/import/unlink` is **fully replaced**, not kept in
  parallel. Existing pins in `machinePeers.json`/`paired.json` are untouched
  (they're keyed by Ed25519 pubkey, not by how they were established) — only
  the CLI surface for creating *new* pins changes.
- `rotate` and `revoke` stay separate operations: rotating the mesh secret
  only blocks *new* machines from joining with the old secret; it does not
  revoke already-pinned peers. Revoking one peer is `harness mesh unlink
  <machineId>`.
- **Mesh-secret setup is required right after authentication succeeds**, the
  first time a machine has no local mesh secret yet — not an optional,
  deferred step the user might forget. `harness login` must not finish
  reporting success while this machine holds no mesh secret. This does not
  retroactively affect already-linked pairs (see the note above: an
  existing pin from the old `link` flow keeps working with no mesh secret
  at all) — it only guarantees every machine finishing `login` fresh is
  mesh-ready without a separate manual step.

## Dependency graph

```
Phase 1 (crypto + storage primitives)
   │
   ▼
Phase 2 (bootstrap protocol: manager handlers + client-side dial)
   │
   ▼
Phase 3 (CLI surface: new `mesh` commands, remove old `link` commands)
   │
   ▼
Phase 4 (tests + end-to-end verification)
```

Linear dependency — each phase needs the previous phase's surface to exist
before it can be exercised. Within Phase 2, the manager-side handler and the
client-side dial code are two sub-tracks that touch different files and
could be split across two people/agents in parallel, but both must land
before either can be tested against the other.

---

## Phase 1 — Core crypto + storage primitives

**Goal:** the building blocks a mesh bootstrap needs exist and are
unit-testable in isolation, with no protocol wiring yet.

**Depends on:** nothing (first phase).

**Scope in:** new pure functions in `core.ts`; new `MeshSecretStore`; the
`MachinePeer` shape gains a field to record how a pin was established.

**Scope out:** no CLI commands yet, no manager/relay wiring, no removal of
old `link` code (that happens in Phase 3, once the replacement works
end-to-end).

**Files:**
- `cli/src/lib/e2ee/core.ts`
  - `newMeshSecret(rng)` — 32 random bytes, encode as base64url with a
    recognizable prefix (e.g. `msk_...`) so it's visually distinct from
    setup tokens or pairing codes.
  - `meshContext(idA, idB)` — hashes both `machineId`s in a fixed sort
    order into a channel identifier (`ci`), replacing the browser-pairing
    `pairContext('a:adapter'|'b:web')` convention for this use case, so a
    transcript is bound to the exact pair of machines and can't be
    replayed against a different pair.
- `cli/src/lib/e2ee/meshStore.ts` (**new file**)
  - `MeshSecretStore`: `get()`, `set(secret)`, `clear()`, persisting
    `meshSecret.json` under `${ADAPTER_DATA_DIR}/e2e/`, mode 0600 — mirror
    the secure-write helper `store.ts` already uses for `identity.json`.
- `cli/src/lib/e2ee/machinePeers.ts`
  - Add `linkMethod?: 'mesh'` to `MachinePeer`. Optional field — existing
    records without it stay valid.

**Steps:**
1. Implement `newMeshSecret`/`meshContext` in `core.ts` next to the existing
   CPace helpers, following the same style (pure functions, no I/O).
2. Implement `MeshSecretStore` in `meshStore.ts`, reusing whatever secure
   file-write helper `store.ts` exports (don't duplicate the perms logic).
3. Add the `linkMethod` field to `MachinePeer` and thread it through
   `MachinePeerStore.pin`'s signature as an optional param.

**Verify:**
- New unit tests in `core.test.ts` for `newMeshSecret` (length/format) and
  `meshContext` (deterministic regardless of argument order, different
  output for different pairs).
- A small test for `MeshSecretStore` round-tripping get/set/clear and file
  permissions (0600).

**Exit criteria:** `npx vitest run src/lib/e2ee/core.test.ts` passes with
the new cases; `MeshSecretStore` compiles and is usable from a scratch
script without touching any other module.

---

## Phase 2 — Bootstrap protocol (manager handlers + client dial)

**Goal:** two machines that both hold the same mesh secret can complete a
CPace handshake over the existing relay channel and pin each other, with no
user interaction.

**Depends on:** Phase 1 (`meshContext`, `MeshSecretStore`, `linkMethod`).

**Scope in:** new frame types, manager-side handler, client-side bootstrap
function, glare tie-break, rate limiting. Not yet wired into the automatic
`dial()` path — that's testable directly via the manager/relay test
harnesses first.

**Scope out:** CLI commands (Phase 3), removing old `link`/setup-token code
(Phase 3, since it must keep working until the replacement is proven).

**Files:**
- `cli/src/lib/e2ee/manager.ts`
  - `onMeshHello`, `onMeshPake` — parallel to the existing
    `onPairIntent`/`onPake` but keyed by the peer's `machineId` (not
    `connId` + a user-typed code): verify the requester against this
    machine's own `MeshSecretStore.get()`; if no local secret, or the CPace
    exchange fails, reply `e2e_denied{reason:'no-mesh-secret'}` — no extra
    detail leaked.
  - Tie-break: when both sides could initiate at once, the machine with the
    lexicographically smaller `machineId` is always the initiator; the
    other only responds.
  - Rate limiting: a counter separate from the existing browser-pairing
    `RATE_MAX`, capping new mesh pins per machine per time window — this is
    about capping relay/CPU spam and limiting propagation speed if a secret
    leaks, not about resisting brute force (32 random bytes makes brute
    force moot).
  - On success: `machinePeers.pin(peerMachineId, peerPub, 'mesh-auto', now,
    {linkMethod:'mesh'})`, plus an info-level log line naming the peer
    machine and fingerprint — this is the audit trail the zero-touch
    decision relies on.
- `cli/src/lib/e2ee/relayClient.ts`
  - `runMeshBootstrap(ws, selfIdentity, meshSecret, targetMachineId)` — runs
    the CPace roundtrip against the target using `e2e_mesh_hello`/
    `e2e_mesh_pake` frame types (deliberately separate from `e2e_pake` so
    the browser-pairing state machine is untouched), pins the result the
    same way as the manager side.
- New frame types `e2e_mesh_hello`, `e2e_mesh_pake` — add wherever the
  existing `e2e_pake`/`e2e_hello` frame type constants are declared.

**Steps:**
1. Add the frame type constants and wire `manager.ts`'s frame dispatch to
   route them to the new handlers (mirror how `e2e_pair_intent`/`e2e_pake`
   are already routed).
2. Implement `onMeshHello`/`onMeshPake` with the tie-break and rate limit.
3. Implement `runMeshBootstrap` in `relayClient.ts`.
4. Do **not** touch `remoteRelay.ts` `dial()` yet — that integration is the
   last step of this phase, once both sides are independently testable.
5. Wire `dial()`: before throwing `NO_PEER_LINK`, if `MeshSecretStore.get()`
   returns a secret, call `runMeshBootstrap`; on success, fall through to
   the existing `e2e_hello`/`e2e_welcome` session flow unchanged.

**Verify:**
- Extend `manager.test.ts` with cases: successful mesh pin, denied when
  secrets don't match, denied when responder has no secret at all, glare
  tie-break resolves to one initiator, rate limit trips after N attempts.
- Extend `relayLink.spec.ts` with a case that exercises `dial()` hitting
  `NO_PEER_LINK` → auto mesh bootstrap → success → normal session proceeds.

**Exit criteria:** `npx vitest run src/lib/e2ee/manager.test.ts
src/lib/e2ee/relayLink.spec.ts` passes; a two-instance in-process test
(matching the existing pattern in `manager.test.ts`) shows two machines
with the same secret pinning each other with no manual step.

---

## Phase 3 — CLI surface: `harness mesh …`, remove `harness link …`

**Goal:** the user-facing commands exist, and the old per-pair token flow
is gone.

**Depends on:** Phase 2 (bootstrap must work before removing the fallback
that currently provides the only way to link machines).

**Scope in:** new `mesh` command group in `cli.ts`; deletion of the `link`
command group and all setup-token code it depended on; enforcing mesh-secret
setup as part of `loginCommand` so no machine finishes `harness login` with
no mesh secret.

**Scope out:** none — this phase should leave no dangling references to the
old flow.

**Files:**
- `cli/src/cli.ts` — replace the `link` block (~line 3546-3631) with:
  - `harness mesh secret generate` — prints the secret once with a clear
    "store this like a password, it will not be shown again" warning; also
    saves it locally so the machine running the command joins the mesh too.
  - `harness mesh secret import <secret>` — validates format, saves
    locally.
  - `harness mesh secret rotate` — generates and prints a new secret;
    help text must say explicitly this does not revoke existing peers.
  - `harness mesh status` — lists peers pinned with `linkMethod:'mesh'`
    (machineId, label, fingerprint, linkedAt) for audit.
  - `harness mesh unlink <machineId>` — calls the existing
    `MachinePeerStore.unlink`.
- `cli/src/lib/e2ee/core.ts` — remove `SetupTokenPayload`,
  `encodeSetupToken`, `verifySetupToken`, `setupClaimSig`,
  `setupClaimVerify`.
- `cli/src/lib/e2ee/store.ts` — remove `createSetupToken`/
  `validateSetupToken` (confirm nothing else calls them first).
- `cli/src/lib/e2ee/relayClient.ts` — remove `claimSetupToken`.
- `cli/src/lib/e2ee/manager.ts` — remove `onSetupClaim`.
- `cli/src/cli.ts` `loginCommand` (line 351-454) — enforce mesh-secret setup
  at the two points a login can report success:
  - Fresh login: after `resolveComputerMachine()` succeeds (line 444) and
    before the `success` result is emitted (line 449-450).
  - Already-signed-in re-run (line 354-358, the early return when
    `readAuthSession() && !force`): same check before returning.

**Steps:**
1. `rg` across `cli/src` for every removed function/type name to make sure
   nothing outside the files above still references them.
2. Implement the `mesh` command group, reusing `MachinePeerStore.list`/
   `unlink` as-is.
3. Delete the old `link` command group and the setup-token functions listed
   above.
4. Update any CLI help text / `--help` output that still mentions `link`.
5. Add a `requireMeshSecret()` helper (`cli.ts` or `e2ee/meshStore.ts`)
   called from both success points in `loginCommand`:
   - If `MeshSecretStore.get()` already has a secret, no-op.
   - Else, if interactive (`!json && process.stdin.isTTY`): prompt "Do you
     already have a mesh secret from another machine? (y/N)" — `y` prompts
     to paste the secret and validates/saves it via `MeshSecretStore.set`;
     `N`/default generates a new one via `newMeshSecret()`, saves it, and
     prints it once with the same "store this like a password" warning as
     `harness mesh secret generate`.
   - Else (non-interactive: `--json`, no TTY, e.g. scripted machine
     provisioning): do **not** silently skip. Require one of two new
     `login` flags, `--mesh-secret <secret>` (import) or
     `--mesh-secret-generate` (generate + print in the JSON result). If
     neither flag is present, fail the login result with
     `{status:'error', code:'MESH_SECRET_REQUIRED'}` (JSON mode) / a clear
     stderr message + non-zero exit (non-JSON, non-TTY) naming both flags,
     rather than leaving the machine half-provisioned.

**Verify:**
- `npx tsc --noEmit` (or `npm run build`) — no leftover references.
- Manual: `harness --help` shows `mesh`, not `link`.
- Manual: fresh `harness login` on a machine with no mesh secret prompts
  for generate/import before printing "Signed in"; a second `harness login`
  on an already-signed-in machine that already has a secret does not
  re-prompt. Non-interactive `harness login --json` with neither
  `--mesh-secret` nor `--mesh-secret-generate` and no local secret returns
  `MESH_SECRET_REQUIRED` instead of succeeding.

**Exit criteria:** build is clean;
`grep -rn "setupClaim\|SetupTokenPayload\|linkCreateCommand\|linkImportCommand" cli/src`
returns nothing; no code path exists where `loginCommand` reports success
while `MeshSecretStore.get()` is empty.

---

## Phase 4 — Tests + end-to-end verification

**Goal:** confidence the replacement works across machines, and the two
adversarial cases (rotate-without-revoke, revoke) behave as documented.

**Depends on:** Phase 3 (final CLI surface must exist).

**Scope in:** finishing/tightening the test suite; one real two-machine
manual run against a local backend.

**Files:** `core.test.ts`, `manager.test.ts`, `relayLink.spec.ts` (no new
files expected, just filling gaps left by Phases 1-3's incremental tests).

**Steps / Verify (manual E2E):**
1. Run two daemon instances against the same local backend and the same
   user account (two distinct machines A and B).
2. On A: `harness mesh secret generate` → copy the printed secret.
3. On B: `harness mesh secret import <secret>`.
4. Trigger B to dial A for the first time (e.g. a `remoteRelay` request via
   `/api/local-ws`) — confirm no manual step is needed, `harness mesh
   status` on both A and B shows the other with a matching fingerprint, and
   the daemon log on both sides has a clear "new mesh peer pinned" line.
5. `harness mesh secret rotate` on A → confirm B (already pinned) still
   works; introduce a third machine C with the *old* secret → confirm C
   fails to bootstrap (only the new secret works for new joins).
6. `harness mesh unlink <machineId>` on A for B → confirm a subsequent dial
   either re-bootstraps (if B still holds the secret) or fails with
   `NO_PEER_LINK` (if the secret was cleared on B too).

**Exit criteria:** full vitest suite green; the six manual steps above all
behave as described, with no step requiring the user to type or paste a
value on any machine except the initial secret import.
