#!/usr/bin/env bash
# Drive a second harness machine in Docker — the one thing a single laptop cannot test.
#
# The desktop app reaches another of your machines through the backend relay
# (`src/lib/remoteRelay.ts`): frames leave the local daemon, cross the cloud, and are handled by the
# daemon on the far side. Every interesting behaviour on that path — creating an agent, moving one
# onto a grid, reading back which grid it landed on — is code that never runs when the app and the
# agent share a computer. This rig gives you the far side.
#
#   bash cli/scripts/remote-machine.sh build     # bundle THIS tree + build the image
#   bash cli/scripts/remote-machine.sh up        # start the box
#   bash cli/scripts/remote-machine.sh login     # SSO (interactive — opens a URL you approve)
#   bash cli/scripts/remote-machine.sh link      # let this Mac's relay reach the box
#   bash cli/scripts/remote-machine.sh verify    # what each remote agent is ACTUALLY running on
#   bash cli/scripts/remote-machine.sh sh        # a shell inside the box
#   bash cli/scripts/remote-machine.sh down      # stop + remove the container (keeps the session)
#   bash cli/scripts/remote-machine.sh destroy   # ...and throw the session away
#
# `verify` is the instrument the rig exists for. It prints, per agent, BOTH the environment of the
# live engine process (read from /proc, which is the only thing that decides where inference goes)
# AND what the daemon reports about it. Those two disagreeing is a real class of bug — the daemon can
# be right about a process and still describe it wrongly to the app — so the rig refuses to collapse
# them into one number.
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the cli package
RIG_DIR="$ADAPTER_DIR/docker/remote-machine"
RIG_ENV="$RIG_DIR/.rig.env"          # gitignored; holds the pinned computer id, nothing secret

IMAGE="${HARNESS_RIG_IMAGE:-harness-remote-machine}"
CONTAINER="${HARNESS_RIG_CONTAINER:-harness-remote-machine}"
VOLUME="${HARNESS_RIG_VOLUME:-harness-remote-machine-state}"
# The Mac's own CLI — the side that has to be told how to reach the box.
HOST_HARNESS="${HARNESS_BIN:-$HOME/.local/bin/harness}"
# The SSO redirect lands on the HOST's browser but must reach a listener inside the box, so the port
# cannot be the ephemeral one `harness login` would otherwise pick — it has to be known in advance to
# be published. Pinned here and honoured by ADAPTER_LOGIN_CALLBACK_PORT on the far side.
LOGIN_PORT="${HARNESS_RIG_LOGIN_PORT:-46789}"

die() { echo "error: $*" >&2; exit 1; }
note() { echo ">> $*"; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker not found"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running — start Docker Desktop first"
}

running() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ]; }
require_running() { running || die "the box is not up — run: bash cli/scripts/remote-machine.sh up"; }

# The container's identity, pinned OUTSIDE the volume.
#
# A machine is bound to its computer id on the backend, so an id that regenerates does not reconnect —
# it mints a SECOND machine on your account and leaves the first as a tombstone. The volume normally
# carries the id, but `destroy` (or any stray `docker volume rm`) takes it with it, and the cost of
# that lands on a real account. Keeping it here means even a wiped volume comes back as the same
# machine.
ensure_computer_id() {
  if [ -f "$RIG_ENV" ]; then
    # shellcheck source=/dev/null
    . "$RIG_ENV"
  fi
  if [ -z "${ADAPTER_COMPUTER_ID:-}" ]; then
    # A UUID, because the backend validates the shape and rejects anything else with
    # "Invalid computer id" — a readable prefix like `docker-...` does not survive registration.
    ADAPTER_COMPUTER_ID="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
    mkdir -p "$RIG_DIR"
    printf 'ADAPTER_COMPUTER_ID=%s\n' "$ADAPTER_COMPUTER_ID" > "$RIG_ENV"
    note "minted a computer id for the box: $ADAPTER_COMPUTER_ID (kept in docker/remote-machine/.rig.env)"
  fi
  export ADAPTER_COMPUTER_ID
}

cmd_build() {
  require_docker
  # Bundle from the working tree, labelled exactly as a local install is, so `harness version` on the
  # box and on this Mac read identically for the same code. See scripts/lib/build-label.sh.
  # shellcheck source=lib/build-label.sh
  . "$ADAPTER_DIR/scripts/lib/build-label.sh"
  local label
  label="$(harness_build_label "$ADAPTER_DIR")"
  note "bundling ${label}…"
  ( cd "$ADAPTER_DIR" && ADAPTER_VERSION="$label" npm run bundle )
  [ -f "$ADAPTER_DIR/dist/cli.js" ] || die "dist/cli.js missing after the bundle step"

  note "building image ${IMAGE}…"   # braces required: bash swallows the following UTF-8 byte into the name
  docker build \
    -f "$RIG_DIR/Dockerfile" \
    -t "$IMAGE" \
    "$ADAPTER_DIR"
  note "built $IMAGE ($label)"
}

cmd_up() {
  require_docker
  ensure_computer_id
  docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || die "image $IMAGE not built — run: bash cli/scripts/remote-machine.sh build"
  if running; then note "already up"; cmd_status; return; fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume create "$VOLUME" >/dev/null
  note "starting ${CONTAINER}…"
  docker run -d \
    --name "$CONTAINER" \
    --hostname harness-remote-box \
    -e ADAPTER_COMPUTER_ID="$ADAPTER_COMPUTER_ID" \
    -e ADAPTER_LOGIN_CALLBACK_PORT="$LOGIN_PORT" \
    -p "127.0.0.1:${LOGIN_PORT}:${LOGIN_PORT}" \
    -v "$VOLUME:/home/node/.harness" \
    "$IMAGE" >/dev/null
  sleep 1
  docker logs "$CONTAINER" 2>&1 | sed 's/^/   /'
}

signed_in() {
  docker exec "$CONTAINER" harness auth status --json 2>/dev/null | grep -q '"loggedIn":[[:space:]]*true'
}

cmd_login() {
  require_running
  if signed_in; then
    note "the box is already signed in"
  else
    # `--json` rather than the human flow, and deliberately so: this is the same NDJSON stream the
    # desktop app drives (`lib/auth/cli_login.dart`), so it needs no TTY and works the same whether a
    # person or a script is watching. The browser step itself cannot be automated — SSO is a person
    # approving something — so the URL is surfaced as loudly as possible and then we wait.
    # Bridge the published port to the callback's loopback bind, for this sign-in only.
    #
    # `harness login` listens on 127.0.0.1:$LOGIN_PORT INSIDE the box — correct everywhere, and
    # unreachable from here, because Docker forwards a published port to the container's eth0 address
    # rather than its loopback. socat listens on that eth0 address (NOT 0.0.0.0: the CLI already owns
    # the same port on loopback, and this way the two cannot collide) and hands the connection across.
    # It exits with the sign-in; nothing is left listening.
    note "bridging the callback port inside the box…"
    docker exec -d "$CONTAINER" sh -c \
      "socat TCP-LISTEN:${LOGIN_PORT},bind=\$(hostname -i),fork,reuseaddr TCP:127.0.0.1:${LOGIN_PORT}"

    note "signing the box in — approve the URL below, then come back"
    docker exec -i "$CONTAINER" harness login --json | node -e '
const rl = require("readline").createInterface({ input: process.stdin })
rl.on("line", (line) => {
  let e; try { e = JSON.parse(line) } catch { return }
  if (e.type === "authorize_url") {
    console.log("")
    console.log("   ┌─ approve the box in your browser ─────────────────────────────")
    console.log("   │ " + e.url)
    console.log("   └───────────────────────────────────────────────────────────────")
    console.log("")
    return
  }
  if (e.type === "result") {
    if (e.status === "success") console.log(e.alreadySignedIn ? "   already signed in" : "   signed in")
    else { console.error(`   sign-in failed: ${e.code} ${e.message || ""}`); process.exitCode = 1 }
  }
})'
    docker exec "$CONTAINER" pkill -f "socat TCP-LISTEN:${LOGIN_PORT}" >/dev/null 2>&1 || true
    signed_in || die "the box is still not signed in"
  fi
  note "starting the adapter on the box…"
  docker exec "$CONTAINER" harness start || true
  cmd_status
}

# The box's own machine id, straight from the backend's answer rather than anything we guessed.
box_machine_id() {
  docker exec "$CONTAINER" harness machines --json 2>/dev/null \
    | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  for (const line of s.split("\n")) {
    if (!line.trim()) continue
    try { const m = JSON.parse(line); if (m.current) { process.stdout.write(String(m.machineId||"")); return } } catch {}
  }
})'
}

cmd_link() {
  require_running
  [ -x "$HOST_HARNESS" ] || die "this Mac's harness CLI not found at $HOST_HARNESS (set HARNESS_BIN)"
  local id
  id="$(box_machine_id)"
  [ -n "$id" ] || die "the box has no machine id yet — run: bash cli/scripts/remote-machine.sh login"
  note "box machine id: $id"

  # A fresh password per run, held only in this shell and passed on stdin to BOTH sides. It is never
  # written to disk and never appears in argv — `ps` is world-readable, and a rig that taught the
  # habit of putting credentials on a command line would be teaching the wrong habit.
  local password
  password="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"

  note "setting the box's remote password…"
  printf '%s\n' "$password" | docker exec -i "$CONTAINER" harness remote-password set --stdin
  note "connecting this Mac to it…"
  printf '%s\n' "$password" | "$HOST_HARNESS" link connect "$id" --stdin
  note "linked — the box should now appear as a machine in the desktop app"
}

cmd_status() {
  require_docker
  if ! running; then echo "box: not running"; return; fi
  echo "box: running ($CONTAINER)"
  docker exec "$CONTAINER" harness status 2>&1 | sed 's/^/   /' || true
  if [ -x "$HOST_HARNESS" ]; then
    echo "this Mac's linked machines:"
    "$HOST_HARNESS" link list 2>&1 | sed 's/^/   /' || true
  fi
}

# What is each remote agent ACTUALLY running on, and does the daemon agree?
cmd_verify() {
  require_running
  docker exec "$CONTAINER" node -e '
const fs = require("fs")
const path = require("path")

const dataDir = process.env.ADAPTER_DATA_DIR || "/home/node/.harness/data"
const registryPath = path.join(dataDir, "registry.json")

// Only the variables that decide where inference goes. The rest of a process environment is the
// user'"'"'s business and this rig has no reason to print it.
const INTERESTING = ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "OPENAI_BASE_URL", "GROK_MODELS_BASE_URL", "COPILOT_PROVIDER_BASE_URL"]

function processEnv(pid) {
  try {
    const out = {}
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const eq = entry.indexOf("=")
      if (eq > 0 && INTERESTING.includes(entry.slice(0, eq))) out[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    return out
  } catch { return null }
}

let agents = []
try {
  const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"))
  agents = Array.isArray(raw) ? raw : (raw.agents ? (Array.isArray(raw.agents) ? raw.agents : Object.values(raw.agents)) : [])
} catch (err) {
  console.log(`no registry at ${registryPath} (${err.code || err.message}) — has an agent been created on this box yet?`)
  process.exit(0)
}

if (!agents.length) { console.log("the box has no agents yet — create one on this machine from the app"); process.exit(0) }

for (const a of agents) {
  const pid = a.processIdentity && a.processIdentity.pid
  const env = pid ? processEnv(pid) : null
  console.log(`agent ${String(a.agentId).slice(0, 8)}  engine=${a.engine}  pid=${pid ?? "-"}  cwd=${a.cwd ?? "-"}`)
  // The process is the truth: an environment is fixed at exec, so this is where the requests go.
  if (env === null) console.log("   process env : UNREADABLE (process gone?)")
  else if (!Object.keys(env).length) console.log("   process env : no endpoint override — the engine is on its OWN login")
  else for (const [k, v] of Object.entries(env)) console.log(`   process env : ${k}=${v}`)
  // What the daemon would tell the app. Printed separately ON PURPOSE — see the header of this file.
  console.log(`   daemon says : grid=${JSON.stringify(a.grid ?? null)}`)
}
' 2>&1
}

cmd_sh() { require_running; docker exec -it "$CONTAINER" bash; }

cmd_down() {
  require_docker
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  note "container removed (volume $VOLUME kept — the box keeps its session and id)"
}

cmd_destroy() {
  require_docker
  local id=""
  running && id="$(box_machine_id || true)"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -f "$RIG_ENV"
  note "container, volume and pinned id removed"
  # The machine record lives on the ACCOUNT, and nothing local can remove it. Say so plainly rather
  # than leaving a tombstone the user finds weeks later in their machine list.
  if [ -n "$id" ]; then
    echo "   the machine record is still on your account. Remove it with:"
    echo "       harness machines delete $id"
  else
    echo "   if the box was ever signed in, remove its machine record with:"
    echo "       harness machines            # find it"
    echo "       harness machines delete <id>"
  fi
}

case "${1:-}" in
  build)   cmd_build ;;
  up)      cmd_up ;;
  login)   cmd_login ;;
  link)    cmd_link ;;
  status)  cmd_status ;;
  verify)  cmd_verify ;;
  sh)      cmd_sh ;;
  down)    cmd_down ;;
  destroy) cmd_destroy ;;
  *) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
