#!/usr/bin/env bash
set -euo pipefail

DESKTOP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTONOMOUS_CODE_ROOT="${AUTONOMOUS_CODE_ROOT:-$DESKTOP_ROOT/../../autonomous-code}"
[[ -d "$AUTONOMOUS_CODE_ROOT/apps/backend" ]] \
  || { echo "MISSING AUTONOMOUS_CODE_ROOT: $AUTONOMOUS_CODE_ROOT" >&2; exit 69; }
AUTONOMOUS_CODE_ROOT="$(cd "$AUTONOMOUS_CODE_ROOT" && pwd)"
HARNESS_ROOT="${HARNESS_REPO_ROOT:-$DESKTOP_ROOT/..}"

for command in docker redis-server node curl jq tmux flutter openssl; do
  command -v "$command" >/dev/null || { echo "MISSING TOOL: $command" >&2; exit 69; }
done
for path in \
  "$AUTONOMOUS_CODE_ROOT/apps/backend/node_modules/.bin/prisma" \
  "$AUTONOMOUS_CODE_ROOT/apps/backend/node_modules/.bin/tsx" \
  "$HARNESS_ROOT/cli/node_modules/.bin/tsx"; do
  [[ -x "$path" ]] || { echo "MISSING LOCAL DEPENDENCY: $path" >&2; exit 69; }
done

RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/terminal-local-e2e.XXXXXX")"
MONGO_CONTAINER="terminal-local-e2e-${$}"
TMUX_SESSION="terminal-local-e2e-${$}"
BACKEND_PID=""
REDIS_PID=""
HARNESS_PID=""
PANE_ID=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  for pid in "$HARNESS_PID" "$BACKEND_PID" "$REDIS_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  done
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  docker rm -f "$MONGO_CONTAINER" >/dev/null 2>&1 || true
  if [[ "${LOCAL_TERMINAL_E2E_KEEP:-0}" == "1" ]]; then
    echo "Local E2E artifacts kept at $RUN_ROOT"
  else
    rm -rf "$RUN_ROOT"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

read -r BACKEND_PORT APP_PROXY_PORT REDIS_PORT MONGO_PORT CLI_PORT <<<"$(node --input-type=module -e '
  import net from "node:net";
  const servers = [];
  for (let i = 0; i < 5; i++) {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    servers.push(server);
  }
  console.log(servers.map((server) => server.address().port).join(" "));
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
')"

API_KEY="$(openssl rand -hex 32)"
MACHINE_ID="$(printf '%s' "$API_KEY" | shasum -a 256 | cut -c1-32)"
MARKER="LOCAL_TERMINAL_E2E_READY_${$}"
DATABASE_URL="mongodb://127.0.0.1:${MONGO_PORT}/harness?replicaSet=rs0&directConnection=true"
WS_BASE_URL="ws://127.0.0.1:${BACKEND_PORT}"
mkdir -p "$RUN_ROOT/adapter-data" "$RUN_ROOT/bin" "$RUN_ROOT/workspace"

docker run --rm -d \
  --name "$MONGO_CONTAINER" \
  -p "127.0.0.1:${MONGO_PORT}:27017" \
  mongo:7 --replSet rs0 --bind_ip_all >"$RUN_ROOT/mongo-container-id"

mongo_ready=0
for _ in $(seq 1 60); do
  docker exec "$MONGO_CONTAINER" mongosh --quiet --eval \
    'try { if (rs.status().ok === 1) quit(0) } catch (_) { try { rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]}) } catch (_) {} } quit(1)' \
    >/dev/null 2>&1 && { mongo_ready=1; break; }
  sleep 0.5
done
[[ "$mongo_ready" == "1" ]] || { echo "Mongo replica set did not become ready" >&2; exit 75; }

redis-server \
  --bind 127.0.0.1 \
  --port "$REDIS_PORT" \
  --save '' \
  --appendonly no \
  --daemonize no >"$RUN_ROOT/redis.log" 2>&1 &
REDIS_PID=$!

redis_ready=0
for _ in $(seq 1 40); do
  node --input-type=module -e '
    import net from "node:net";
    const socket = net.connect(Number(process.argv[1]), "127.0.0.1");
    socket.setTimeout(300);
    socket.once("connect", () => { socket.end(); process.exit(0) });
    socket.once("timeout", () => process.exit(1));
    socket.once("error", () => process.exit(1));
  ' "$REDIS_PORT" && { redis_ready=1; break; }
  sleep 0.25
done
[[ "$redis_ready" == "1" ]] || { echo "Redis did not become ready" >&2; exit 75; }

(
  cd "$AUTONOMOUS_CODE_ROOT/apps/backend"
  DATABASE_URL="$DATABASE_URL" ./node_modules/.bin/prisma db push --skip-generate
) >"$RUN_ROOT/prisma.log" 2>&1
LOCAL_TERMINAL_E2E_API_KEY="$API_KEY" DATABASE_URL="$DATABASE_URL" \
  node "$AUTONOMOUS_CODE_ROOT/scripts/terminal-local-db-fixture.mjs" >"$RUN_ROOT/db-fixture.json"
jq -e --arg machine "$MACHINE_ID" '.machineId == $machine' "$RUN_ROOT/db-fixture.json" >/dev/null

(
  cd "$AUTONOMOUS_CODE_ROOT/apps/backend"
  exec env \
    NODE_ENV=test \
    PORT="$BACKEND_PORT" \
    PORT_APP_PROXY="$APP_PROXY_PORT" \
    DATABASE_URL="$DATABASE_URL" \
    REDIS_URL="redis://127.0.0.1:${REDIS_PORT}" \
    HARNESS_BILLING_ENABLED=false \
    MESH_ENABLED=false \
    ./node_modules/.bin/tsx src/server.ts
) >"$RUN_ROOT/backend.log" 2>&1 &
BACKEND_PID=$!

backend_ready=0
for _ in $(seq 1 80); do
  if curl --silent --fail "http://127.0.0.1:${BACKEND_PORT}/api/health" \
    | jq -e '.success == true and .data.status == "ok"' >/dev/null 2>&1; then
    backend_ready=1
    break
  fi
  kill -0 "$BACKEND_PID" 2>/dev/null || { echo "Backend exited during startup" >&2; tail -80 "$RUN_ROOT/backend.log" >&2; exit 75; }
  sleep 0.25
done
[[ "$backend_ready" == "1" ]] || { echo "Backend did not become ready" >&2; tail -80 "$RUN_ROOT/backend.log" >&2; exit 75; }

ln -s "$AUTONOMOUS_CODE_ROOT/scripts/fixtures/terminal-e2e-agent.mjs" "$RUN_ROOT/bin/codex"
PANE_ID="$(tmux new-session -d -P -F '#{pane_id}' \
  -s "$TMUX_SESSION" -c "$RUN_ROOT/workspace" -x 92 -y 27 \
  "env LOCAL_TERMINAL_E2E_MARKER=$MARKER $RUN_ROOT/bin/codex")"
[[ "$PANE_ID" =~ ^%[0-9]+$ ]] || { echo "Could not create disposable tmux pane" >&2; exit 70; }

(
  cd "$HARNESS_ROOT/cli"
  exec env \
    PATH="$RUN_ROOT/bin:$PATH" \
    NODE_ENV=test \
    BACKEND_WS_URL="$WS_BASE_URL" \
    WEB_URL="http://127.0.0.1:${BACKEND_PORT}" \
    ADAPTER_DATA_DIR="$RUN_ROOT/adapter-data" \
    PORT="$CLI_PORT" \
    TERMINAL_BACKENDS=tmux \
    TERMINAL_RECONCILE_INTERVAL_MS=5000 \
    TMUX_REAP_INTERVAL_MS=500 \
    DISABLE_HOOK_INSTALL=true \
    ANALYTICS_ENABLED=false \
    ADAPTER_UPDATE_DISABLE=true \
    LOG_FRAMES=true \
    ./node_modules/.bin/tsx src/cli.ts join -f "$API_KEY"
) >"$RUN_ROOT/harness.log" 2>&1 &
HARNESS_PID=$!

harness_ready=0
for _ in $(seq 1 120); do
  if curl --silent --fail -H 'x-adapter-local: 1' "http://127.0.0.1:${CLI_PORT}/api/status" \
    | jq -e '.connected == true' >/dev/null 2>&1; then
    harness_ready=1
    break
  fi
  kill -0 "$HARNESS_PID" 2>/dev/null || { echo "Harness CLI exited during startup" >&2; tail -120 "$RUN_ROOT/harness.log" >&2; exit 75; }
  sleep 0.25
done
[[ "$harness_ready" == "1" ]] || { echo "Harness CLI did not connect" >&2; tail -120 "$RUN_ROOT/harness.log" >&2; exit 75; }

browser_link_output="$(
  cd "$HARNESS_ROOT/cli"
  env \
    BACKEND_WS_URL="$WS_BASE_URL" \
    WEB_URL="http://127.0.0.1:${BACKEND_PORT}" \
    ADAPTER_DATA_DIR="$RUN_ROOT/adapter-data" \
    PORT="$CLI_PORT" \
    ANALYTICS_ENABLED=false \
    ADAPTER_UPDATE_DISABLE=true \
    ./node_modules/.bin/tsx src/cli.ts browser-link
)"
setup_url="$(printf '%s\n' "$browser_link_output" | sed -nE 's/^[[:space:]]*(http[^[:space:]]+)[[:space:]]*$/\1/p' | head -1)"
[[ -n "$setup_url" ]] || { echo "Harness did not return a setup link" >&2; exit 75; }
SETUP_TOKEN="$(node -e 'const u=new URL(process.argv[1]); const t=new URLSearchParams(u.hash.slice(1)).get("t"); if (!t) process.exit(1); process.stdout.write(t)' "$setup_url")"

(
  cd "$DESKTOP_ROOT"
  flutter test integration_test/local_terminal_e2e_test.dart -d macos \
    --dart-define=LOCAL_TERMINAL_E2E=true \
    --dart-define=LOCAL_E2E_WS_BASE_URL="$WS_BASE_URL" \
    --dart-define=LOCAL_E2E_API_KEY="$API_KEY" \
    --dart-define=LOCAL_E2E_MACHINE_ID="$MACHINE_ID" \
    --dart-define=LOCAL_E2E_SETUP_TOKEN="$SETUP_TOKEN" \
    --dart-define=LOCAL_E2E_TMUX_PANE="$PANE_ID" \
    --dart-define=LOCAL_E2E_TERMINAL_MARKER="$MARKER"
)

restored_size="$(tmux display-message -p -t "$PANE_ID" '#{pane_width}x#{pane_height}')"
[[ "$restored_size" == "92x27" ]] || { echo "Pane size was not restored after terminal_close: $restored_size" >&2; exit 1; }

if grep -F "$MARKER" "$RUN_ROOT/backend.log" "$RUN_ROOT/redis.log" >/dev/null; then
  echo "PLAINTEXT LEAK: terminal marker appeared in Backend/Redis logs" >&2
  exit 1
fi

echo "PASS: local Desktop -> local Backend -> local Harness CLI -> tmux terminal E2E"
echo "      machine=${MACHINE_ID:0:12} pane=$PANE_ID backend=$WS_BASE_URL"
