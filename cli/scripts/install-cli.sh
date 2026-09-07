#!/usr/bin/env bash
# Install the adapter CLI from THIS working tree into ~/.harness/cli — the local twin of
# scripts/upload-cli.sh with the GCS round-trip cut out. It produces exactly the layout the public
# installer does (the hosted installer), so afterwards `harness` on this computer IS
# your build. Nothing is uploaded, nothing is version-bumped, nothing is git-committed.
#
# Usage:
#   bash scripts/install-cli.sh               # bundle -> install -> restart the daemon if it was running
#   bash scripts/install-cli.sh --no-build    # install the existing dist/ as-is
#   bash scripts/install-cli.sh --no-restart  # swap the bytes, leave the daemon stopped
#   bash scripts/install-cli.sh --no-updates  # pin this build: turn self-update OFF (default: ON)
#
# SELF-UPDATE STAYS ON BY DEFAULT, and the version label is what makes that safe. The build is labelled
# `<published-core>-dev.<sha>`, and shouldAutoUpdate() (lib/selfUpdate.ts) refuses to replace ANY
# `-dev.` build automatically — so no release, however far ahead, overwrites your bytes on its own.
#
# It did not always: the rule used to be ordering alone (semverGt on the X.Y.Z core), which let the
# release you were level with sit still but let the NEXT one land. That reads like being carried
# forward and behaves like losing your work — a machine developing against unreleased CLI code had its
# bundle swapped mid-session, and the only symptom was the unreleased feature quietly not working.
#
# So: nothing here pins the computer, and nothing overwrites it either. To take a release deliberately,
# `harness update --force`, or the public installer:
#   curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
#
# `--no-updates` remains for a stronger promise — no manifest is even fetched. It exports
# ADAPTER_UPDATE_DISABLE=true in the launcher, switching off both the 60s poll and `harness start`'s
# update-before-connect (cli.ts `stageLatestBundle`), which also silences the update check for a
# release-labelled build installed with --no-build.
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # this package
SRC_CLI="$ADAPTER_DIR/dist/cli.js"
SRC_NOTIFY="$ADAPTER_DIR/dist/notify.mjs"

# Install layout — same defaults as src/config/env.ts, overridable for a sandboxed try-out.
CLI_DIR="${ADAPTER_CLI_DIR:-$HOME/.harness/cli}"
DATA_DIR="${ADAPTER_DATA_DIR:-$CLI_DIR/data}"
BIN_DIR="${HARNESS_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER="$BIN_DIR/harness"
PID_FILE="$DATA_DIR/adapter.pid"

# The build's version label — and the GCS_BUCKET / METADATA_PATH / OTA_KEY overrides that steer it —
# belong to scripts/lib/build-label.sh, sourced at step 1. This script never publishes.

# --- Parse args ---
DO_BUILD=1
DO_RESTART=1
KEEP_UPDATES=1   # self-update ON unless --no-updates says otherwise (see the header)
LABEL=""   # the version this run bundles; stays empty under --no-build (nothing was built to label)
for arg in "$@"; do
  case "$arg" in
    --no-build)   DO_BUILD=0 ;;
    --no-restart) DO_RESTART=0 ;;
    --updates)    KEEP_UPDATES=1 ;;   # accepted for muscle memory; it is the default now
    --no-updates) KEEP_UPDATES=0 ;;
    *) echo "error: unknown argument '$arg' (see the header of $0)" >&2; exit 1 ;;
  esac
done

# The Node the launcher will be PINNED to, as an absolute path. Two reasons it is resolved here
# rather than left as a bare `node` in the launcher: a Finder-launched app inherits launchd's
# PATH (/usr/bin:/bin:/usr/sbin:/sbin — no Homebrew, no nvm) and would find no `node` at all; and
# the public installer pins an absolute path, which this script's header promises to match.
# The managed runtime wins when it is present, so a dev install drives the same cli.js on the same
# Node the desktop app uses instead of quietly forking onto whatever PATH resolves.
HARNESS_RUNTIME_NODE="${HARNESS_RUNTIME_NODE:-$HOME/.harness/runtime/current-node}"
NODE_BIN=""
if [ -r "$HARNESS_RUNTIME_NODE" ]; then
  CANDIDATE="$(cat "$HARNESS_RUNTIME_NODE" 2>/dev/null || true)"
  if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ]; then NODE_BIN="$CANDIDATE"; fi
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
[ -n "$NODE_BIN" ] || { echo "error: node not found — the CLI is plain JS run by your Node (>= 20)" >&2; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "error: Node >= 20 required (found $("$NODE_BIN" -v))" >&2; exit 1; }
if [ "$DO_BUILD" -eq 1 ]; then
  command -v npm >/dev/null 2>&1 || { echo "error: npm not found (needed for the bundle step; use --no-build to skip)" >&2; exit 1; }
fi

# --- Step 1: bundle, labelled <published-core>-dev.<sha>[.dirty] ---
# The core matches the release so `harness version`/`status` read sensibly next to prod, and the
# `-dev.` suffix is load-bearing, not decoration: it is what shouldAutoUpdate() (lib/selfUpdate.ts)
# matches to leave this build alone, and what `harness update` refuses to replace without --force.
if [ "$DO_BUILD" -eq 1 ]; then
  # Shared with the Docker remote-machine rig, so both boxes report the SAME version for the same
  # tree — see scripts/lib/build-label.sh.
  # shellcheck source=lib/build-label.sh
  . "$ADAPTER_DIR/scripts/lib/build-label.sh"
  LABEL="$(harness_build_label "$ADAPTER_DIR")"
  echo ">> bundling ${LABEL}…"   # braces required: bash 3.2 swallows the following UTF-8 byte into the name
  ( cd "$ADAPTER_DIR" && ADAPTER_VERSION="$LABEL" npm run bundle )
fi
[ -f "$SRC_CLI" ] && [ -f "$SRC_NOTIFY" ] || { echo "error: dist/cli.js or dist/notify.mjs missing — bundle first (drop --no-build)" >&2; exit 1; }
head -1 "$SRC_CLI" | grep -q '^#!' || { echo "error: dist/cli.js lost its shebang on line 1 (esbuild change?)" >&2; exit 1; }

# --- Step 2: canary + read back the version REALLY in the artifact ---
# Runs before anything on disk is touched: a bundle that can't even print its own version must not
# replace a working install (the same gate the self-updater applies). Everything below reports
# `node dist/cli.js version` rather than the label above, so `--no-build` — where dist/ may hold a
# bundle some other command produced — can never announce a version it isn't installing.
VER="$("$NODE_BIN" "$SRC_CLI" version 2>/dev/null || true)"
[ -n "$VER" ] || { echo "error: 'node dist/cli.js version' failed — refusing to install a broken bundle" >&2; exit 1; }
if [ "$DO_BUILD" -eq 1 ] && [ "$VER" != "$LABEL" ]; then
  echo "error: bundle reports '$VER', expected '$LABEL' (ADAPTER_VERSION not injected)" >&2; exit 1
fi
echo ">> installing $VER"
case "$VER" in
  *-dev.*|*-dev) : ;;   # the label shouldAutoUpdate() protects
  *) echo "   note: '$VER' is not a -dev build, so it is NOT protected from self-update. With updates" >&2
     echo "         on, a newer published release would replace it; rebuild without --no-build to get" >&2
     echo "         a -dev label, or install with --no-updates." >&2 ;;
esac

# --- Step 3: stop the running daemon (it holds the OLD bytes in memory) ---
WAS_RUNNING=0
RUNNING_PID=""
if [ -f "$PID_FILE" ]; then RUNNING_PID="$(tr -dc '0-9' < "$PID_FILE" || true)"; fi
if [ -n "$RUNNING_PID" ] && kill -0 "$RUNNING_PID" 2>/dev/null; then
  WAS_RUNNING=1
  echo ">> stopping the running adapter (pid $RUNNING_PID)…"
  # Prefer the CLI's own stop (graceful WS close → releases the machine-owner claim, clears the pid
  # file); fall back to signals if the currently-installed bundle is broken or missing.
  "$NODE_BIN" "$CLI_DIR/cli.js" stop >/dev/null 2>&1 || kill -TERM "$RUNNING_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$RUNNING_PID" 2>/dev/null || break; sleep 0.3; done
  if kill -0 "$RUNNING_PID" 2>/dev/null; then kill -KILL "$RUNNING_PID" 2>/dev/null || true; sleep 0.5; fi
  rm -f "$PID_FILE"
fi

# --- Step 4: install the artifacts (write-then-rename; never touch DATA_DIR) ---
# DATA_DIR lives INSIDE CLI_DIR and holds the token, computer-id, log and session registry — this step
# only ever replaces the three packaged files, so a reinstall keeps the computer joined to its machine.
mkdir -p "$CLI_DIR" "$BIN_DIR"
install_file() {
  local src="$1" dst="$2" mode="$3"
  cp "$src" "$dst.tmp"
  chmod "$mode" "$dst.tmp"
  mv -f "$dst.tmp" "$dst"          # atomic within the same filesystem
}
install_file "$SRC_CLI"    "$CLI_DIR/cli.js"     644
install_file "$SRC_NOTIFY" "$CLI_DIR/notify.mjs" 644
printf '{"type":"module"}\n' > "$CLI_DIR/package.json"   # the bundle is ESM
# Drop any .prev left by a previous self-update: a rollback to that release build would silently undo
# this install.
rm -f "$CLI_DIR/cli.js.prev" "$CLI_DIR/notify.mjs.prev"

# --- Step 5: the launcher ---
if [ "$KEEP_UPDATES" -eq 1 ]; then
  cat > "$LAUNCHER.tmp" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$CLI_DIR/cli.js" "\$@"
EOF
else
  cat > "$LAUNCHER.tmp" <<EOF
#!/bin/sh
# Local dev install, PINNED with --no-updates (see scripts/install-cli.sh).
# Self-update is off: no release will ever reach this computer on its own, not even a newer one.
# Re-run install-cli.sh without --no-updates (or the public installer) to rejoin the release train.
ADAPTER_UPDATE_DISABLE=true
export ADAPTER_UPDATE_DISABLE
exec "$NODE_BIN" "$CLI_DIR/cli.js" "\$@"
EOF
fi
chmod 755 "$LAUNCHER.tmp"
mv -f "$LAUNCHER.tmp" "$LAUNCHER"

echo "  ✓ installed $VER → $CLI_DIR"
echo "    launcher: $LAUNCHER$([ "$KEEP_UPDATES" -eq 1 ] && echo '  (self-update ON)' || echo '  (self-update OFF)')"

# --- Step 6: bring the daemon back on the new bytes ---
if [ "$WAS_RUNNING" -eq 1 ] && [ "$DO_RESTART" -eq 1 ]; then
  echo ">> reconnecting on the new build…"
  sleep 1                       # grace for the backend to release the one-machine claim (as `harness update` does)
  "$LAUNCHER" start
elif [ "$WAS_RUNNING" -eq 1 ]; then
  echo "  (daemon stopped and NOT restarted — run: harness start)"
else
  echo "  (no daemon was running — run \`harness login\` if needed, then \`harness start\`)"
fi

# --- Step 7: PATH hint (this script deliberately does not edit your shell rc) ---
case ":${PATH}:" in
  *":$BIN_DIR:"*) : ;;
  *)
    echo ""
    echo "  note: $BIN_DIR is not on PATH. For this shell:"
    echo "      export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
