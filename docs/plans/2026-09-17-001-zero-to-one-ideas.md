# Zero-to-one ideas: what Harness needs next

Status: ideas, not yet plans · 2026-09-17
Context: written after building the Harness Store end to end — 18 harnesses on a fresh machine, a store
page per harness with real prompt → output examples, permission modes in New Harness. Each idea below
says what it is, why it matters, what already exists to build on, and the open questions. Pick one, then
turn it into a plan beside this file.

---

## 1. Harness Builder — a new harness from one sentence

**What.** "A harness for KiCad." "For Unity." "For our Terraform repo." An agent writes the whole
package — `harness.json`, toolchain setup and doctor, a viewer (or `viewer.use` of an existing one),
`AGENTS.md` and skills, a starter template, store facts — then proves it: installs it on a fresh machine,
runs a first prompt through it, captures the output as the package's first store examples, and offers to
publish it.

**Why.** Every harness in the store today was written by hand. The Builder turns the store from a
catalogue we curate into a platform anyone can extend, and it is the most direct path to the long tail
of domains (EDA, game engines, data tools, internal company tooling).

**What exists.**
- The package contract and its checker: `store/spec/`, `harness dsh check`, `cli/src/dsh/manifest.ts`.
- A starter package: `store/starter/`.
- The fresh-machine install recipe (`env -i HOME=<tmp>`, `store/tools/runtimes.sh` for Node, uv/Python,
  micromamba) and the conversion of all 21 packages to it.
- The showcase pipeline: a real run → a 1600×1000 picture of the viewer → `store/showcase/<name>/` →
  `examples` in `store.json` → the store page.

**Open questions.**
- Where does a built harness live — a repository of the person's own (`store/registry/<owner>/<name>.json`
  entry) or a local-only install until they publish?
- How much of the proof is automatic before publishing is allowed (doctor passes, one prompt produced an
  artifact, the viewer rendered it)?
- Licensing and credit when the Builder wraps an existing open-source project, as the store's own
  wrappers do (upstream name, author on the tile, THIRD_PARTY_NOTICES).

---

## 2. Studios — harnesses that hand work to each other

**What.** One request that runs across several harnesses in one tab, each step's output becoming the
next step's input: text-to-cad designs a part → Blender renders it → Remotion cuts a launch video →
Marp builds the keynote. Every step is visible in its own viewer pane, and any step can be re-run.

**Why.** It is the product's whole story in one demo, and something no single-agent tool can do: many
specialised agents, each with its own toolchain and viewer, on one project.

**What exists.**
- Tabs that hold several agents and panes (swarms), viewer panes that follow a harness's verdict
  artifact, and a verdict contract (`.harness/verdict.json`: ready, artifact, phases).
- A first message on create (`agent_create`'s `prompt`), which is how a step would be started.

**Open questions.**
- The handoff: a shared project folder each harness reads from, or an explicit artifact passed by path?
- Who orchestrates — a coordinating agent, or a declared pipeline (a "studio" manifest)?
- How a failed or unready step (`ready: false`) holds the chain, and how a person steps in.

---

## 3. Share what you made

**What.** One click turns a finished run — the prompt, a picture of the output, later a replay — into a
public page, and optionally into a community example on that harness's store page.

**Why.** The growth loop: store pages fill with real work by real people, and every shared page is an
invitation to try the prompt.

**What exists.** `examples` on store entries (`StoreExampleSchema`, `cli/src/dsh/registry.ts`), the store
page that renders them, and the review/rating service in the control plane.

**Open questions.** It needs the backend (not released yet). Moderation, attribution, and what a
picture may show (paths, usernames, hostnames in viewer chrome — the showcase work had to check for
exactly these).

---

## 4. Share a harness with someone

Two steps, deliberately apart: read-only first, read-write only once the security model is designed.

### Step 1 — read-only: "watch my harness"

**What.** Bob sends Alice a link to one running harness. Alice sees what Bob sees — the agent's terminal
as it streams, and the viewer pane (the 3D model, the board, the deck) — live, in her own app or a
browser. She cannot type, click into the viewer in any way that changes it, or reach anything else on
Bob's machine.

**Why.** Pairing, reviews, demos, "look what it's doing" — the social moment of watching an agent work,
without screen sharing.

**What exists.**
- The app already attaches to agents on other machines through the daemon, and the CLI terminates
  end-to-end encryption for relayed machines (`cli/src/lib/e2ee/`, `harness link create/import/list`).
- Terminal streams are framed and addressed per agent (`terminal_open`, binary frames with a stream id).

**The security shape, even for read-only.**
- **Scope is one agent, enforced by Bob's daemon**, not by Alice's UI: the share grants
  `terminal_open` for that agent's stream and nothing else — no `agents_list`, no `fs_list_dir`, no
  `agent_create`, no other agent's stream. A share is an allow-list of frame types and one agent id.
- **No input path exists at the protocol level** for a read-only grant: input frames, resize, restart,
  permission responses and question answers are refused by the daemon, whatever the client sends.
- **Terminal output is sensitive.** It shows paths, environment dumps, tokens an agent printed, file
  contents. Bob should see what a share exposes before sending it; consider redaction of known secret
  shapes (the app already has `redactSecretsInText` for logs).
- **Viewers are local web servers with their own write APIs** (a viewer can save notes, re-render,
  trigger builds). A read-only share must not proxy them wholesale — either a snapshot/stream of what
  the viewer shows, or a proxy that allows only safe GETs. This overlaps with the missing remote-viewer
  forwarding (see Gaps).
- **Revocable, expiring, visible.** A share has an expiry, Bob can end it at once, and Bob sees who is
  watching right now.
- **Identity.** Alice signs in; a share is to a person (or an org), not a bearer link anyone can
  forward — or, if bearer links are allowed for demos, they are short-lived and read-only by
  construction.

### Step 2 — read-write: "work in my harness together"

**What.** Alice can also type to the agent (and maybe drive the viewer), as a collaborator in Bob's
harness.

**Why it needs its own design: this is Alice on Bob's computer.** Anything that can type into the
agent's terminal can run code as Bob's user, on Bob's machine:
- An agent in an auto-approve mode runs the commands it is asked to run; Alice asking is enough.
- Engine TUIs have shell escapes (Claude Code's `!` bash mode, for one) — raw keystrokes are a shell.
- The agent's environment holds Bob's credentials: vendor logins, git credentials, SSH agent, cloud
  CLIs, the keychain the agent can reach.
- The workspace is a folder on Bob's disk, and the agent is not confined to it.

**Directions to think through, not decisions.**
- **Prompt-level input, not keystrokes.** Alice sends messages to the agent through a composer that
  the daemon delivers as a prompt; raw terminal input stays Bob's.
- **Permission mode caps.** A shared harness runs in Ask first (or Plan) for Alice's turns: every command
  Alice's prompt causes needs Bob's approval, or at least Alice's own approval shown to Bob.
- **Isolation.** Shared harnesses run in a sandbox or container with only the workspace mounted and no
  access to Bob's credentials; the harness's toolchain comes with it.
- **A driver's seat.** One person drives at a time; handing over is explicit; Bob can take it back or end
  the session instantly.
- **Audit.** Every input from Alice is recorded against her identity, visible to Bob.
- **Explicit, per-session consent** from Bob, time-boxed.

---

## Gaps found on the way (not zero-to-one, but they will hurt soon)

- **Remote viewers — implemented.** The desktop's CLI forwards a linked machine's viewer through its
  existing encrypted connection; both CLIs need the forwarding-capable version. See
  [the implementation and validation plan](2026-09-17-004-remote-viewers.md). This preserves the
  owner's interactive viewer access; read-only public sharing still needs its own restrictions.
- **Harness updates — implemented.** Installed packages track their source commit, the catalog
  identifies published revisions, and the Store shows "Update". `harness dsh update <id>` and the
  Store upgrade packages while preserving workspaces and restoring the previous package if setup or
  doctor fails. Shared viewers update independently. See [implementation and verification](2026-09-17-002-harness-updates.md).
