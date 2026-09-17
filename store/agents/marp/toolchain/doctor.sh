#!/usr/bin/env bash
# Harness DSH doctor — can THIS machine write, show and export a deck? cwd = the install dir.
# One line per check: `ok   <what>` / `warn <what>` / `miss <what>`. Exit 1 only on a miss.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
status=0
ok()   { echo "ok   $*"; }
warn() { echo "warn $*"; }
miss() { echo "miss $*"; status=1; }

if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
  ok "claude on PATH"
else
  miss "claude not found — install Claude Code: https://claude.ai/install"
fi

if command -v node >/dev/null 2>&1; then
  v="$(node --version | sed 's/^v//')"; major="${v%%.*}"
  case "$major" in (*[!0-9]*|"") major=0;; esac
  if [ "$major" -ge 18 ]; then ok "node $v"; else miss "node $v is older than 18 (brew install node)"; fi
else
  miss "node not found (brew install node)"
fi

if [ -d "$ROOT/toolchain/node_modules/@marp-team/marp-core" ]; then
  ok "marp-core $(node -p "require('$ROOT/toolchain/node_modules/@marp-team/marp-core/package.json').version" 2>/dev/null || echo present)"
else
  miss "marp toolchain not installed — run toolchain/setup.sh"
fi
if [ -x "$ROOT/toolchain/node_modules/.bin/marp" ]; then
  ok "marp-cli (PDF, PPTX and HTML export)"
else
  warn "marp-cli missing — decks show live but do not export"
fi

# Export to PDF/PPTX renders through a Chromium-family browser marp-cli finds on its own.
found=""
for app in "/Applications/Google Chrome.app" "/Applications/Chromium.app" "/Applications/Microsoft Edge.app" "/Applications/Brave Browser.app"; do
  [ -d "$app" ] && { found="$app"; break; }
done
[ -z "$found" ] && command -v chromium >/dev/null 2>&1 && found="$(command -v chromium)"
[ -z "$found" ] && command -v google-chrome >/dev/null 2>&1 && found="$(command -v google-chrome)"
if [ -n "$found" ]; then ok "browser for PDF/PPTX export: $(basename "$found")"; else warn "no Chrome/Chromium/Edge — HTML export only, no PDF or PPTX"; fi

exit $status
