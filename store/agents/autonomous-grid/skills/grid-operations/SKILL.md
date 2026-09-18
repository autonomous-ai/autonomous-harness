---
name: grid-operations
description: "Look after the models on the user's machines — one laptop or a fleet: recognise their private grid, ask what they need in plain words, pick a model that fits from disk, catalog or Hugging Face, start it with vision and context that fit, prove it answers with one bounded call, change or stop a running one, and use Grid routing, usage, media and training commands."
---

# Grid operations

`$GRID_FLEET` and `$GRID_CLI` are executable paths, not directories. Quote them. Start with
`"$GRID_FLEET" config` and `"$GRID_FLEET" status`. `status` reads the viewer's published snapshot
without opening a socket or launching Grid. Check `fresh`, `status` and `observedAt`; use fresh live
observations to answer ordinary inventory questions. A downloaded weight file or a catalog entry
is not a serving model. The viewer reads actual CLI data, and the
runner records operation start/completion without recording prompts, credentials or full argv.

In a restricted agent sandbox, `refresh`, `connect`, `discover` and network-using `run` commands
require the engine's normal scoped network approval. Request it before calling them rather than
repeating commands that fail with EPERM. This also applies to the loopback Harness bridge. Do not
disable the sandbox or broaden global permissions. A denied network call does not prove a host is
offline; use fresh viewer observations or an approved live check.

## Targets and access

`grid-fleet.json` holds the mode (`local` or `remote`), grid selector, controller machine, managed
machines and user preferences. A null grid means the workspace is not connected; the viewer must not
fall through to an old CLI default. **The CLI's selection (`use`) is the one source of truth for
which grid this is.** The viewer reads it on every poll and follows a change, so what the person
selected — in a terminal, or by asking you — is what the screen shows; `connect` selects too, so
the two never disagree. A fresh sign-in has no selection yet: then the workspace reuses the
remembered fleet, else the **user's own private grid**, recognised rather than asked for — Harness
mints it at sign-in as the email's local part from `~/.grid/credentials.toml` (lowercased, runs of
non-alphanumerics → `-`, trimmed), then `-` and eight hex, of type `permissioned-public`; exactly
one row of `ls --json` matches — and selects it, so the CLI agrees from the first minute. A person
who asks to "switch to", "use" or "work on" another grid they are in (`ls`) gets `connect` with
that name: it verifies the grid answers, then selects it. Pass the selected grid to every command
that takes one. With no private grid and several reachable, ask which with the question tool.
Connect with
`"$GRID_FLEET" connect --mode remote --grid NAME --remember` to select a verified grid and reuse it
in future workspaces. `--remember` writes this controller's `~/.harness/grid-fleet/default.json`;
existing workspace selections remain independent. Changing this workspace's mode never requires
changing Grid's global mode.

The default machine is this computer. Use `"$GRID_FLEET" discover` to list the user's Harness machines,
and `discover --add` to add them when fleet management is requested. Paired Harness links need no SSH
setup; the runner checks the target's Grid fleet protocol before any command. An older Harness must
be updated before this transport works. An offline or unlinked machine stays unavailable.
Alternatively, add a known SSH target using an established SSH config alias
or `user@host`; do not infer SSH access from a display name in Grid. Grid lists serving engines,
which are not necessarily distinct physical machines. See [fleet configuration](references/fleet.md).
An engine can be observed through the relay without having permission or a transport to administer its host.

```sh
"$GRID_FLEET" run -- ls --json
"$GRID_FLEET" run -- engines GRID --json
"$GRID_FLEET" run --machine MACHINE -- device-info --json
"$GRID_FLEET" run --machine MACHINE -- catalog --json
```

`run` passes every argument after `--` to the real Grid CLI and applies the workspace's mode.
It supports Grid's entire CLI, including nested commands. Local and SSH execution accept interactive
input; Harness transport is noninteractive, so sign-in prompts belong in that machine's terminal. The controller is
the default execution machine. Model files and `join`/`leave` operations belong on the machine
that runs the engine; listing, routing and requests can run on the controller.

## Start a model

Slow steps are a real stop: a download or an engine build is asked about through the question tool
and runs in the **next** turn, never in the message that asks. Every model you offer comes from
something you looked up — the host's disk, the catalog, or Hugging Face — never from memory. The
pick is made once; after the person chooses, that is the model through the download, the vision
question and the start, unless it fails (won't fit, won't pull, won't answer).

**1. What they need — three questions, in plain words, through the question tool.** Skip any the
person already answered. The engine numbers in brackets are yours; they are never shown.

    "What will you mostly use it for?"  — the work decides which model is worth downloading
      Coding · Chat and writing · Reading images · Just something fast
    "How much can it hold in its head at once?"  — its working memory for one conversation; when it
      fills, it forgets the beginning; more costs memory on the machine
      Short, about 20 pages [32K] · Medium, about 40 pages [64K] · Long, about 80 pages [128K] ·
      As much as this machine can give it
    "How many things will talk to it at the same time?"  — each one reserves its own share of memory
      up front; when every share is taken, the next request waits
      Just me, one agent at a time [1] · Two agents at once [2] · A few agents or people at once [4]

Coding wants Long (an agent burns context as a session grows); chat is fine at Short; "just me" on
a laptop someone is also working on.

**2. What the host has.** `device-info --json` on the intended host first: `usable_bytes` is the
real ceiling for weights plus context. Per-machine, never summed across hosts. The engine check is
the binary, not a status command: `~/.grid/bin/llama-server --version` printing a version line means
llama.cpp is installed — go on without a word. ⚠️ `engine status` reports the **media** engine
(ComfyUI) and says `Installed: no` on a host whose llama.cpp is fine; it sent an agent asking to
install what was already built. Only when the binary is missing, ask (build from source or prebuilt)
and run `engine install llama.cpp [--from-source]` in the next turn.

**3. What is already on the host's disk comes first.** `ls ~/.grid/models/*.gguf` minus the
`.mmproj.gguf` sidecars; `ctx FILE --json` says how much each can hold; a `<stem>.mmproj.gguf`
beside a file means it reads images. Anything that fits the answers is offered first as "already on
this computer, no download", beside one option to fetch something new. Only that option goes on.

**4. The catalog, then Hugging Face.** `catalog --json` is sized for the host: keep entries that are
`runnable`, whose `fit.ctx` covers the context asked, and that suit the purpose; pull
`fit.version`'s `pull_spec`. Offer 2–3 in the same plain terms as step 1 — what it is good at, the
download size in GB, how much it can hold in pages, whether it reads images. No speed figure
(`fit.est_tok_s` only orders the list for "fast"), no quant name, no token count as the whole answer.
When the person names a model the catalog lacks, the catalog is not a wall — `pull` takes any
`<repo>:<file>.gguf` on Hugging Face and fetches its projector too:

    curl -sf "https://huggingface.co/api/models?search=<name>&filter=gguf&sort=downloads&limit=8" \
      | python3 -c 'import json,sys; [print(m["id"], m.get("downloads")) for m in json.load(sys.stdin)]'
    curl -sf "https://huggingface.co/api/models/<repo_id>" | python3 -c '
    import json,sys
    for f in json.load(sys.stdin)["siblings"]:
        if f["rfilename"].endswith(".gguf"): print(f["rfilename"], f.get("size"))'

Prefer an official org (`ggml-org`, `Qwen`, `google`, `unsloth`, `bartowski`, `lmstudio-community`)
over an unknown uploader, then downloads; say which in half a line. Pick the quant by size against
`usable_bytes` (or ≈0.6 bytes per parameter for Q4_K_M), leaving room for context. A model outside
the catalog has been sized by nobody but you — say the fit is your estimate.

**Vision is not in the catalog** (every entry's `task` is `text-generation`). Before pulling, the
same `siblings` list answers it: any top-level `mmproj*.gguf` means the model reads images — print
the file names, and put "reads images" or "text only" on each option; for "Reading images" offer
only repos with an mmproj. After the pull, the disk proves it:
`test -f ~/.grid/models/<stem>.mmproj.gguf`.

**5. Two checks, then the start.** *Fit:* `--ctx-size` is per request and the engine reserves
context × slots up front (grid passes `ctx × slots` to llama.cpp; 4 slots at 64K is 256K tokens of
KV cache before the first request, and a size the host cannot hold fails to start rather than
shrinking). Check context × the asked concurrency against `usable_bytes` minus the weights and
`keepFreeMemoryGb`; if it doesn't fit, offer a smaller context or fewer slots through a tool.
*Vision:* when the projector is on disk, ONE question whose options say what each does —
"Serve it with vision on?" · *Yes, with vision — it reads screenshots and photos (some extra
memory)* · *No, text only — the vision file is set aside for this run; say the word to put it back*.
On "no", rename the projector yourself (`mv <stem>.mmproj.gguf <stem>.mmproj.gguf.off`) before the
join and say so in one line — never a second question about the file.

    "$GRID_FLEET" run --machine MACHINE -- pull OWNER/REPO:EXACT_FILE.gguf
    "$GRID_FLEET" run --machine MACHINE -- join GRID --serve EXACT_FILE.gguf --advertise-as MODEL_ALIAS \
      --name MACHINE-MODEL --max-concurrency N --ctx-size CTX --endpoint-port PORT

`--advertise-as` is the name the person will see in their model picker; `--name` is the machine's
display name — different things. `--max-concurrency N` is the step-1 answer; don't pass
`--parallel` (grid derives the slot count from it) and don't pass `--jinja` (on by default in the
engine grid ships). `--ctx-size` always, capped at the file's `fit.max_ctx` ("as much as fits" =
`fit.ctx`): left off, the engine takes a 16K default, smaller than an agent's own prompt. Use
explicit ports when several instances share a host. An existing Ollama, vLLM, MLX or LM Studio
engine can join with `--at URL -m MODEL --name NAME`; do not install a second engine needlessly.

Choose a reasoning budget deliberately. Grid's GPU default can spend more tokens thinking than a
small output limit permits, yielding no final answer. For an everyday low-latency assistant, start
with `fleet run --thinking off -- join ... --reasoning-budget 0`. `--thinking off` sets llama.cpp's
`enable_thinking:false` template parameter for the newly started engine; it is needed on builds
where a zero token budget alone still produces reasoning. Use `--thinking on` to enable a supported
model's thinking explicitly. These switches configure startup, not an already running instance.
For a reasoning model, reserve an explicit budget smaller than `--n-predict`, leaving room for the
answer.

**6. Prove it answers — once, bounded.** A successful `join` means *starting*, not ready. First wait
for the relay to list it (a call before that answers `No providers available for this model`, which
is "not yet", not "broken"):

    until "$GRID_FLEET" run -- models GRID 2>/dev/null | grep -qx 'MODEL_ALIAS'; do sleep 10; done
    eval "$("$GRID_FLEET" run -- info GRID --env)" && curl -s --max-time 420 "$OPENAI_BASE_URL/chat/completions" \
      -H "Authorization: Bearer $OPENAI_API_KEY" -H 'content-type: application/json' \
      -d '{"model":"MODEL_ALIAS","messages":[{"role":"user","content":"Reply with the single word: ok"}],"max_tokens":8}'

⚠️ Not `chat` for this check. `chat` sets no output limit and the engine's default is tens of
thousands of tokens, so a small model that runs away answering "ok" holds the slot for minutes — and
with one slot everything after it waits, including a second check. `max_tokens` is what makes this
finish in seconds whatever the model does. The timeout is long on purpose: right after a join, grid
sends the new engine a probe of about 5K tokens to measure what it can do, and on a host without a
GPU that alone takes 3–5 minutes at ~30 tokens/s while holding the single slot. Tell the user the
model is warming up and the first answer can take a few minutes on that machine. Send the check
ONCE and leave it alone — a second call, a `chat`, a log tail all queue behind the same probe. A
reply with a `choices` entry means the whole path works. Nothing within the timeout: stop the model
(`leave`), say in one line it started but did not answer in time, and offer through a tool a model
one step larger from the same list (tiny models loop), or more requests at once, or stop. Verify
`message.content` contains the requested result; reasoning text alone or a successful HTTP status is
not acceptance. Then `"$GRID_FLEET" refresh`.

**7. Say where it is.** "<alias> is running on <machine>, N at a time, vision on/off. Pick it from
the model dropdown at the top of any agent's pane, and that agent switches to it." The window's
Models menu only lists Local models; it does not switch. Don't offer to wire it into an agent's
config or add a provider — the picker is the whole hand-off.

## Change a running model

The person names the one thing they want different; everything else stays. Read the current
settings from the viewer or `stats GRID --verbose --json` (model, context, slots) so you change only
that and can say what changed. Context, concurrency and vision all mean a restart — `leave` that
instance, then the same `join` with the one flag (or the projector file) changed; check the fit
first as in step 5. A different model is step 3 onward, keeping the context and concurrency they
already have; stop the old one only when the new one is about to serve. Stop is `leave` and one
line. A restart drops the model from the picker for the seconds it takes and any agent mid-turn on
it loses that turn: say so in one line, and ask first only when `stats` shows requests in flight.

## Undeploy and move

`leave GRID --engine SELECTOR` on the serving machine stops/unregisters that instance. Match an
exact unique engine identity from `engines` first. `leave --all` affects other workloads; use it only
for a user-requested whole-grid teardown. `rm MODEL --yes` deletes downloaded weights and is a
different action from undeploying; retain files unless deletion is requested.

Verify the engine disappears from discovery after `leave`, with bounded polling. Local Grid can retain
a stopped engine until its 60-second heartbeat TTL expires; remote grids have their own convergence
delay. A successful exit alone is not proof of removal. If it persists beyond the deadline, inspect
the named process/logs and report a failed or incomplete undeployment, not a successful one.

For a move: verify the destination can answer the same model alias, check whether the source has
active work when that telemetry exists, then remove the source instance and verify routing again.
Do not promise seamless draining or conversation migration: the CLI does not guarantee either.
If the destination fails, keep the source serving. Keep a rollback command in the plan.

## Placement and model discovery

Use user needs (latency, coding quality, vision, privacy, power, quiet hours, concurrency) to compare
placements. `stats GRID --verbose --json` and `usage GRID --by model --json` are remote-grid reads.
Local grids expose a smaller surface; `device-info` gives hardware inventory, not a complete live
GPU sensor feed. Missing sensor values cannot justify moving a workload.

`throughput_tok_s` is the last measured decode estimate for one engine. Do not sum engines' rates
or present it as a simultaneous fleet benchmark. Compare candidates using the same representative
task and context; preserve the observed timings, output and model/quantization in `plans/`.

The shipped catalog is curated, not a live feed of every new release. For newly released models,
check primary model cards/release sources and offer a measured trial. Automatic replacement needs
the user's explicit standing policy (`allowAutomaticChanges` plus a concrete scope); a suggestion
does not authorize an unrequested fleet-wide upgrade. Existing authorization for a deployment or
move is enough to carry it through without asking again.

## When something fails

Say what failed and stop; translate every message, never repeat a raw line that names the CLI.

  - **Not signed in** → the user's to fix: `harness login`, the only command ever theirs.
  - **`No providers available for this model`** right after a join → not registered yet; wait as
    step 6 says.
  - **`exceeds the available context size`** (an agent may show it as a garbled "expected array
    `choices`") → served with too small a window, usually `--ctx-size` left off: leave, join again
    with the asked context.
  - **`Jinja Exception: System message must be at the beginning`** → the model's template refuses a
    system message after the first turn; the relay now hoists system/developer messages to the
    front, so the relay this machine talks to predates that fix. The model is fine; nothing to
    change here.
  - **The user says it isn't in the picker** → it is there only while served: `stats GRID --verbose`;
    not listed → start it again (the weights are still on disk); listed → the picker refreshes on
    open.

## The rest of Grid

Use `"$GRID_FLEET" run -- --help`, then a command's `--help`, to discover the installed surface.
See [command routes](references/commands.md) for the main families. Routing, training, media,
projects and agents are available through the same runner. Do not change credentials, memberships,
pricing, external API billing or training jobs as a side effect of an ordinary local deployment.

Keep failures visible. A timeout or dropped SSH session leaves the remote result uncertain; inspect
the engine before retrying a mutation. Exit zero and the operation record alone do not prove service
health: verify through `engines`, `models` and an actual request.
