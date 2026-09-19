#!/usr/bin/env bash
# Synthetic regression checks for build-windows-release.sh. No Flutter, Visual Studio, installer build, signing, upload, or publication is performed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPOSITORY_ROOT="$(cd "$DESKTOP_ROOT/.." && pwd)"
STAMP="packaging-fixture-$(date +%Y%m%d-%H%M%S)-$$"
FIXTURES_PARENT="${HARNESS_PACKAGING_FIXTURE_ROOT:-$DESKTOP_ROOT/.toolchain/packaging-fixtures}"
FIXTURES_ROOT="$FIXTURES_PARENT/$STAMP"
PYTHON_BIN="${PYTHON:-$(command -v python || command -v python3)}"
mkdir -p "$FIXTURES_ROOT"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

make_fixture() {
  local name="$1"
  local root="$FIXTURES_ROOT/$name"
  local desktop="$root/desktop"
  mkdir -p "$desktop/scripts" "$desktop/third_party/xterm" "$desktop/fake-bin"
  cp "$SCRIPT_DIR/build-windows-release.sh" "$desktop/scripts/"
  cp "$REPOSITORY_ROOT/LICENSE" "$root/LICENSE"
  cp "$DESKTOP_ROOT/third_party/xterm/LICENSE" "$desktop/third_party/xterm/LICENSE"
  cp "$DESKTOP_ROOT/WINDOWS_QUICKSTART.md" "$desktop/WINDOWS_QUICKSTART.md"
  cp "$DESKTOP_ROOT/WINDOWS_PORT.md" "$desktop/WINDOWS_PORT.md"
  cp "$DESKTOP_ROOT/WINDOWS_AGENT_VERIFICATION.md" "$desktop/WINDOWS_AGENT_VERIFICATION.md"
  mkdir -p "$root/cli"
  printf 'name: harness\nversion: 9.8.7+fixture\n' > "$desktop/pubspec.yaml"
  cat > "$desktop/fake-bin/flutter" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pub)
    exit 0
    ;;
  analyze)
    if [[ "${FIXTURE_ANALYZE_STATUS:-0}" != "0" && "${FIXTURE_ANALYZE_STATUS:-0}" != "1" ]]; then
      echo "Analyzing fixture..."
      exit "${FIXTURE_ANALYZE_STATUS}"
    fi
    if [[ "${FIXTURE_ANALYZE_STATUS:-0}" == "1" ]]; then
      echo "   info - fixture diagnostic - lib/fixture.dart:1:1"
      if [[ "${FIXTURE_ANALYZE_COMPLETE:-1}" == "1" ]]; then
        echo "1 issue found."
      fi
      exit 1
    fi
    echo "No issues found!"
    exit 0
    ;;
  test)
    if [[ "${FIXTURE_TEST_STATUS:-0}" != "0" ]]; then
      echo "00:01 +0 ~0 -1: Some tests failed."
      exit "${FIXTURE_TEST_STATUS}"
    fi
    echo "00:01 +1 ~0: All tests passed!"
    exit 0
    ;;
  build)
    release="$(pwd)/build/windows/x64/runner/Release"
    mkdir -p "$release/data/flutter_assets"
    printf 'fixture executable\n' > "$release/harness.exe"
    printf 'fixture plugin\n' > "$release/plugin.dll"
    printf 'fixture data\n' > "$release/data/flutter_assets/AssetManifest.bin"
    exit 0
    ;;
esac
echo "unexpected fake Flutter arguments: $*" >&2
exit 64
SH
  cat > "$desktop/fake-bin/npm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FIXTURE_CLI_STATUS:-0}" != "0" ]]; then exit "$FIXTURE_CLI_STATUS"; fi
if [[ "$2" == "bundle" ]]; then
  mkdir -p dist
  printf 'fixture cli\n' > dist/cli.js
  if [[ "${FIXTURE_MISSING_NOTIFY:-0}" != "1" ]]; then
    printf 'fixture hook\n' > dist/notify.mjs
  fi
fi
SH
  cat > "$desktop/fake-bin/dumpbin.exe" <<'SH'
#!/usr/bin/env bash
if [[ "${FIXTURE_DUMPBIN_STATUS:-0}" != "0" ]]; then
  echo "fixture dumpbin failure" >&2
  exit "${FIXTURE_DUMPBIN_STATUS}"
fi
printf 'MSVCP140.dll\nVCRUNTIME140.dll\nVCRUNTIME140_1.dll\n'
SH
  chmod +x "$desktop/fake-bin/flutter" "$desktop/fake-bin/dumpbin.exe" "$desktop/fake-bin/npm"
  printf '%s\n' "$root"
}

make_crt() {
  local target="$1"
  mkdir -p "$target"
  printf 'fixture msvcp\n' > "$target/msvcp140.dll"
  printf 'fixture vcruntime\n' > "$target/vcruntime140.dll"
  printf 'fixture vcruntime1\n' > "$target/vcruntime140_1.dll"
}

run_fixture() {
  local root="$1"
  local expected="$2"
  local log="$root/run.log"
  shift 2
  set +e
  (
    cd "$root/desktop"
    env FLUTTER="$root/desktop/fake-bin/flutter" NPM="$root/desktop/fake-bin/npm" PYTHON="$PYTHON_BIN" "$@" bash scripts/build-windows-release.sh
  ) > "$log" 2>&1
  local status=$?
  set -e
  if [[ "$status" != "$expected" ]]; then
    cat "$log" >&2
    fail "$(basename "$root") exited $status; expected $expected"
  fi
  printf '%s\n' "$log"
}

crash_root="$(make_fixture analyzer-crash)"
crash_log="$(run_fixture "$crash_root" 1 FIXTURE_ANALYZE_STATUS=42)"
grep -q 'not a completed analysis' "$crash_log" || fail "analyzer process failure was not rejected"
if grep -q '==> flutter test' "$crash_log"; then
  fail "tests ran after an analyzer process failure"
fi

incomplete_root="$(make_fixture analyzer-incomplete)"
incomplete_log="$(run_fixture "$incomplete_root" 1 FIXTURE_ANALYZE_STATUS=1 FIXTURE_ANALYZE_COMPLETE=0)"
grep -q 'printed no completed result' "$incomplete_log" || fail "unfinished analyzer output was not rejected"
if grep -q '==> flutter test' "$incomplete_log"; then
  fail "tests ran after unfinished analyzer output"
fi

override_root="$(make_fixture override-and-info)"
override_crt="$override_root/toolchain/redist"
make_crt "$override_crt"
override_log="$(run_fixture "$override_root" 0 CRT_DIR_OVERRIDE="$override_crt" DUMPBIN_OVERRIDE="$override_root/desktop/fake-bin/dumpbin.exe" FIXTURE_ANALYZE_STATUS=1)"
grep -q 'analysis : completed with non-error diagnostics (exit 1, 0 analyzer error(s))' "$override_log" || fail "analysis info exit was not reported distinctly"
extract_root="$(find "$override_root/desktop/.toolchain/state" -type d -name '*-extract' -print -quit)"
[[ -n "$extract_root" ]] || fail "fixture produced no extracted verification directory"
cmp "$REPOSITORY_ROOT/LICENSE" "$extract_root/Release/LICENSE.txt" || fail "repository LICENSE changed in the bundle"
cmp "$DESKTOP_ROOT/third_party/xterm/LICENSE" "$extract_root/Release/licenses/xterm-LICENSE.txt" || fail "xterm license changed in the bundle"
cmp "$override_root/cli/dist/cli.js" "$extract_root/Release/harness-cli/cli.js" || fail "matching CLI not shipped"
cmp "$override_root/cli/dist/notify.mjs" "$extract_root/Release/harness-cli/notify.mjs" || fail "matching hook not shipped"

missing_cli_root="$(make_fixture missing-cli-hook)"
missing_cli_log="$(run_fixture "$missing_cli_root" 1 FIXTURE_MISSING_NOTIFY=1)"
grep -q 'matching CLI bundle is missing notify.mjs' "$missing_cli_log" || fail "missing hook was not rejected"

failed_cli_root="$(make_fixture failed-cli-build)"
run_fixture "$failed_cli_root" 7 FIXTURE_CLI_STATUS=7 >/dev/null

dumpbin_root="$(make_fixture dumpbin-failure)"
dumpbin_crt="$dumpbin_root/toolchain/redist"
make_crt "$dumpbin_crt"
dumpbin_log="$(run_fixture "$dumpbin_root" 1 CRT_DIR_OVERRIDE="$dumpbin_crt" DUMPBIN_OVERRIDE="$dumpbin_root/desktop/fake-bin/dumpbin.exe" FIXTURE_DUMPBIN_STATUS=7)"
grep -q 'error: dumpbin failed for harness.exe (exit 7)' "$dumpbin_log" || fail "dumpbin failure was not reported"
if grep -q 'every MSVC-family import' "$dumpbin_log"; then
  fail "dumpbin failure was followed by a verified-closure claim"
fi

fallback_root="$(make_fixture second-root-fallback)"
primary_root="$fallback_root/vs-primary"
secondary_root="$fallback_root/vs-secondary"
mkdir -p "$primary_root/2026/Community"
fallback_crt="$secondary_root/2026/BuildTools/VC/Redist/MSVC/14.50/x64/Microsoft.VC143.CRT"
fallback_dumpbin="$secondary_root/2026/BuildTools/VC/Tools/MSVC/14.50/bin/Hostx64/x64/dumpbin.exe"
make_crt "$fallback_crt"
mkdir -p "$(dirname "$fallback_dumpbin")"
cp "$fallback_root/desktop/fake-bin/dumpbin.exe" "$fallback_dumpbin"
chmod +x "$fallback_dumpbin"
fallback_log="$(run_fixture "$fallback_root" 0 VS_ROOT_PRIMARY="$primary_root" VS_ROOT_SECONDARY="$secondary_root")"
grep -Fq "MSVC runtime from $fallback_crt" "$fallback_log" || fail "second Visual Studio root was not selected"

tests_root="$(make_fixture allowed-test-failure)"
tests_crt="$tests_root/toolchain/redist"
make_crt "$tests_crt"
tests_log="$(run_fixture "$tests_root" 2 CRT_DIR_OVERRIDE="$tests_crt" DUMPBIN_OVERRIDE="$tests_root/desktop/fake-bin/dumpbin.exe" FIXTURE_TEST_STATUS=1 ALLOW_TEST_FAILURES=1)"
grep -q 'test suite is NOT green' "$tests_log" || fail "allowed failing tests were not labeled"
grep -q 'tests    : exit 1' "$tests_log" || fail "failing test exit was not retained in the summary"

echo "PASS: Windows release packaging fixtures"
echo "fixtures retained: $FIXTURES_ROOT"
