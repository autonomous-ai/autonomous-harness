#!/usr/bin/env bash
# Reproducible Windows release build + unsigned distributable bundle, VERIFIED.
#
#   bash scripts/build-windows-release.sh
#   ALLOW_TEST_FAILURES=1 bash scripts/build-windows-release.sh
#
# Produces:
#   build/windows/x64/runner/Release/harness.exe    (the release app)
#   dist/harness-desktop-windows-x64-<version>.zip  (unsigned bundle to hand out)
#   dist/harness-desktop-windows-x64-<version>.zip.sha256
#
# and then VERIFIES the two files the way a recipient would: it copies them into
# an unrelated directory, checks the checksum THERE, and opens the archive to
# confirm the executable and its runtime files are inside. The checksum file
# names the bundle by FILE NAME only, so it verifies from anywhere.
#
# EXIT CODES — printed as a summary, and never a stand-in for a green suite:
#   0  analysis completed with no errors, tests green, build + bundle + verify OK
#   1  build/packaging/verification failed, or analyze reported errors
#   2  a bundle was produced, but analysis or tests were NOT green and the
#      caller opted in with ALLOW_TEST_FAILURES=1
#
# No signing, no notarization, no upload, and no recursive deletes: staging is a
# fresh uniquely named directory under `.toolchain/state/` that is left in place.
#
# Flutter cannot cross-compile to Windows — run it ON Windows 11 x64 with the
# Visual Studio "Desktop development with C++" workload and the Windows SDK.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FLUTTER="${FLUTTER:-flutter}"
# `-f`, not `-x`: a .cmd wrapper on Windows has no executable bit for MSYS, and
# the wrapper is meant to be launched through cmd.exe anyway.
if [[ -f "$REPO_ROOT/.toolchain/flutter.cmd" && "$FLUTTER" == "flutter" ]]; then
  FLUTTER="$REPO_ROOT/.toolchain/flutter.cmd"
fi

VERSION_RAW="$(sed -n 's/^version: *\(.*\)$/\1/p' pubspec.yaml | head -1)"
VERSION="${WINDOWS_RELEASE_VERSION:-${VERSION_RAW%%+*}}"
VERSION="${VERSION:-0.0.0}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  echo "error: WINDOWS_RELEASE_VERSION must be a semantic version" >&2
  exit 1
fi
OUT_DIR="$REPO_ROOT/dist"
BUNDLE_NAME="harness-desktop-windows-x64-$VERSION"
STATE_DIR="$REPO_ROOT/.toolchain/state"
STAMP="build-$(date +%Y%m%d-%H%M%S)-$$"

native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}

latest_redist_in_root() {
  local root="$1"
  local matches=()
  shopt -s nullglob
  matches=("$root"/*/*/VC/Redist/MSVC/*/x64/Microsoft.VC*.CRT)
  shopt -u nullglob
  if [[ "${#matches[@]}" == "0" ]]; then
    return 1
  fi
  printf '%s\n' "${matches[@]}" | sort -V | tail -1
}

latest_dumpbin_in_root() {
  local root="$1"
  local matches=()
  shopt -s nullglob
  matches=("$root"/*/*/VC/Tools/MSVC/*/bin/Hostx64/x64/dumpbin.exe)
  shopt -u nullglob
  if [[ "${#matches[@]}" == "0" ]]; then
    return 1
  fi
  printf '%s\n' "${matches[@]}" | sort -V | tail -1
}

echo "==> flutter pub get"
"$FLUTTER" pub get

# --- analyze ------------------------------------------------------------------
# The status is CAPTURED and PRINTED, and a startup failure is not mistaken for
# a clean run: the output must actually look like an analyzer run, and only an
# analyzer ERROR fails the build (this repository carries pre-existing
# info-level notices inside third_party/xterm and one test file).
echo "==> flutter analyze"
ANALYZE_LOG="$STATE_DIR/$STAMP-analyze.log"
mkdir -p "$STATE_DIR"
set +e
"$FLUTTER" analyze > "$ANALYZE_LOG" 2>&1
ANALYZE_STATUS=$?
set -e
cat "$ANALYZE_LOG"
ANALYZE_ERRORS="$(grep -cE '^\s*error - ' "$ANALYZE_LOG" || true)"
ANALYZE_STATUS_TEXT="completed with no analyzer errors (exit $ANALYZE_STATUS, $ANALYZE_ERRORS analyzer error(s))"
# A COMPLETED analysis, not just a banner. `flutter analyze` exits 0 (clean) or
# 1 (diagnostics); anything else means the tool itself failed, and a crashed
# analyzer can still have printed "Analyzing …" before dying. So the exit code
# must be one of the two the tool defines AND the output must carry a finished
# result line. Without this, "banner then exit 42" read as zero analyzer errors.
if [[ "$ANALYZE_STATUS" != "0" && "$ANALYZE_STATUS" != "1" ]]; then
  echo "error: flutter analyze exited $ANALYZE_STATUS — not a completed analysis (0 or 1)" >&2
  exit 1
fi
if ! grep -qE '([0-9]+ issues? found|No issues found)' "$ANALYZE_LOG"; then
  echo "error: flutter analyze printed no completed result — treat as a failed run" >&2
  exit 1
fi
if [[ "$ANALYZE_ERRORS" != "0" ]]; then
  echo "error: flutter analyze reported $ANALYZE_ERRORS error(s)" >&2
  exit 1
fi
if [[ "$ANALYZE_STATUS" == "1" ]]; then
  ANALYZE_STATUS_TEXT="completed with non-error diagnostics (exit $ANALYZE_STATUS, $ANALYZE_ERRORS analyzer error(s))"
fi

# --- tests --------------------------------------------------------------------
# Run and REPORT the real result. A failing suite is not a green suite, so by
# default it fails the script; a host with known pre-existing failures must say
# so explicitly with ALLOW_TEST_FAILURES=1, and then the script exits 2.
echo "==> flutter test"
TEST_LOG="$STATE_DIR/$STAMP-test.log"
set +e
"$FLUTTER" test > "$TEST_LOG" 2>&1
TEST_STATUS=$?
set -e
tail -5 "$TEST_LOG"
TEST_SKIPPED=0
TEST_FAILED=0
TEST_PASSED=0
if grep -qE '^\s*[0-9]{2}:[0-9]{2} \+[0-9]+' "$TEST_LOG"; then
  TEST_SUMMARY="$(grep -oE '\+[0-9]+ ~[0-9]+( -[0-9]+)?: (All tests passed!|Some tests failed\.)' "$TEST_LOG" | tail -1)"
else
  TEST_SUMMARY=""
fi
TEST_STATUS_TEXT="exit $TEST_STATUS${TEST_SUMMARY:+ · $TEST_SUMMARY}"
TESTS_GREEN=1
if [[ "$TEST_STATUS" != "0" ]]; then
  TESTS_GREEN=0
  if [[ "${ALLOW_TEST_FAILURES:-0}" != "1" ]]; then
    echo "error: the test suite is not green ($TEST_STATUS_TEXT)." >&2
    echo "       Re-run with ALLOW_TEST_FAILURES=1 to build anyway (script exits 2)." >&2
    exit 1
  fi
  echo "warning: the test suite is NOT green ($TEST_STATUS_TEXT); building anyway because ALLOW_TEST_FAILURES=1"
fi

# --- build --------------------------------------------------------------------
echo "==> flutter build windows --release"
"$FLUTTER" build windows --release --build-name="${VERSION%%-*}" --dart-define=WINDOWS_BUNDLED_CLI=true

RELEASE_DIR="$REPO_ROOT/build/windows/x64/runner/Release"
if [[ ! -f "$RELEASE_DIR/harness.exe" ]]; then
  echo "error: $RELEASE_DIR/harness.exe was not produced" >&2
  exit 1
fi

# Ship the CLI from this SAME checkout. The Windows runner executes these bytes
# in WSL with automatic updates disabled; the upstream installer supplies Node
# and tmux prerequisites, never the fork's running CLI.
echo "==> bundle matching Harness CLI"
NPM="${NPM:-npm}"
(
  cd "$REPO_ROOT/../cli"
  "$NPM" run typecheck
  ADAPTER_VERSION="$VERSION" "$NPM" run bundle
)
mkdir -p "$RELEASE_DIR/harness-cli"
for file in cli.js notify.mjs; do
  if [[ ! -s "$REPO_ROOT/../cli/dist/$file" ]]; then
    echo "error: matching CLI bundle is missing $file" >&2
    exit 1
  fi
  cp -f "$REPO_ROOT/../cli/dist/$file" "$RELEASE_DIR/harness-cli/$file"
done
SOURCE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if ! git -C "$REPO_ROOT" diff --quiet HEAD --; then
  SOURCE_COMMIT="$SOURCE_COMMIT-dirty"
fi
printf '%s\n' "$SOURCE_COMMIT" > "$RELEASE_DIR/source-commit.txt"
cp -f "$REPO_ROOT/WINDOWS_QUICKSTART.md" "$RELEASE_DIR/README-WINDOWS.md"
for doc in WINDOWS_PORT.md WINDOWS_AGENT_VERIFICATION.md; do
  cp -f "$REPO_ROOT/$doc" "$RELEASE_DIR/$doc"
done

# --- the MSVC runtime the bundle must carry -----------------------------------
# harness.exe and every Flutter plugin DLL IMPORT the MSVC C++ runtime
# (msvcp140.dll, vcruntime140.dll, vcruntime140_1.dll). Those are NOT part of a
# stock Windows install; they ship with the Visual C++ Redistributable, and a
# machine that has never installed it cannot start the app. A development box
# always has them, which is exactly why this defect hides — so the bundle carries
# them. They are taken from the installed toolchain's own redist directory
# (Microsoft.VC*.CRT under VC\Redist\MSVC\<version>\x64), never downloaded and
# never installed on this machine.
VS_ROOT_PATHS=(
  "${VS_ROOT_PRIMARY:-/c/Program Files/Microsoft Visual Studio}"
  "${VS_ROOT_SECONDARY:-/c/Program Files (x86)/Microsoft Visual Studio}"
)
CRT_DIR="${CRT_DIR_OVERRIDE:-}"
CRT_VERSION=""
VS_ROOT=""
if [[ -n "$CRT_DIR" ]]; then
  if [[ ! -d "$CRT_DIR" ]]; then
    echo "error: CRT_DIR_OVERRIDE does not name a directory: $CRT_DIR" >&2
    exit 1
  fi
  CRT_VERSION="override"
else
  for root in "${VS_ROOT_PATHS[@]}"; do
    [[ -d "$root" ]] || continue
    if candidate="$(latest_redist_in_root "$root")" && [[ -d "$candidate" ]]; then
      CRT_DIR="$candidate"
      VS_ROOT="$root"
      CRT_VERSION="$(basename "$(dirname "$(dirname "$candidate")")")"
      break
    fi
  done
fi
if [[ -z "$CRT_DIR" ]]; then
  echo "error: no Visual Studio VC\Redist\MSVC\...\x64\Microsoft.VC*.CRT directory found." >&2
  echo "       The bundle must carry msvcp140.dll, vcruntime140.dll and" >&2
  echo "       vcruntime140_1.dll; without them a clean Windows machine cannot" >&2
  echo "       start the app. Install the 'Desktop development with C++'" >&2
  echo "       workload, or set CRT_DIR_OVERRIDE=<path> to point at those three files." >&2
  exit 1
fi
echo "==> MSVC runtime from $CRT_DIR (MSVC $CRT_VERSION)"
for runtime in msvcp140.dll vcruntime140.dll vcruntime140_1.dll; do
  if [[ ! -f "$CRT_DIR/$runtime" ]]; then
    echo "error: $CRT_DIR/$runtime is missing; the bundle would not be portable" >&2
    exit 1
  fi
  cp -f "$CRT_DIR/$runtime" "$RELEASE_DIR/$runtime"
done
echo "    copied: msvcp140.dll vcruntime140.dll vcruntime140_1.dll"

# Windows stamps the version into the executable's resources (Runner.rc), so
# package_info_plus reports it; the file is written anyway so a Windows bundle
# can be read the same way a Linux one is (see lib/core/app_version.dart).
echo "$VERSION" > "$RELEASE_DIR/version.txt"

# Ship the license for this repository and the notice for the vendored xterm source compiled into the app.
# These are the license files present for code this repository vendors directly; package-manager notices are not inferred.
LICENSES_DIR="$RELEASE_DIR/licenses"
mkdir -p "$LICENSES_DIR"
if [[ ! -f "$REPO_ROOT/../LICENSE" ]]; then
  echo "error: repository LICENSE is missing: $REPO_ROOT/../LICENSE" >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/third_party/xterm/LICENSE" ]]; then
  echo "error: vendored xterm LICENSE is missing: $REPO_ROOT/third_party/xterm/LICENSE" >&2
  exit 1
fi
cp -f "$REPO_ROOT/../LICENSE" "$RELEASE_DIR/LICENSE.txt"
cp -f "$REPO_ROOT/third_party/xterm/LICENSE" "$LICENSES_DIR/xterm-LICENSE.txt"

# --- bundle -------------------------------------------------------------------
mkdir -p "$OUT_DIR"
ZIP="$OUT_DIR/$BUNDLE_NAME.zip"
rm -f "$ZIP"
# Zip the WHOLE release directory: harness.exe alone is not runnable — it needs
# data/ (the Dart AOT snapshot, assets, ICU data) beside it.
if command -v zip >/dev/null 2>&1; then
  ( cd "$(dirname "$RELEASE_DIR")" && zip -q -r "$ZIP" "Release" )
else
  # Git Bash ships no `zip`; python3 does the same job. python3 here is a NATIVE
  # Windows program, so it needs Windows paths.
  PYTHON="${PYTHON:-python3}"
  "$PYTHON" - "$(native_path "$ZIP")" "$(native_path "$(dirname "$RELEASE_DIR")")" Release <<'PY'
import os
import sys
import zipfile

archive, root, folder = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
    for base, _, files in os.walk(os.path.join(root, folder)):
        for name in files:
            path = os.path.join(base, name)
            bundle.write(path, os.path.relpath(path, root))
PY
fi

# PORTABLE checksum: the file NAME, computed from inside dist/, so the pair may
# be moved anywhere together. An absolute builder path in here would only verify
# on the machine that wrote it.
CHECKSUM="$ZIP.sha256"
( cd "$OUT_DIR" && sha256sum "$(basename "$ZIP")" > "$(basename "$ZIP").sha256" )

# --- verification in an unrelated directory -----------------------------------
# A fresh, uniquely named staging directory; it is left in place for inspection
# (nothing here deletes directories).
VERIFY_DIR="$STATE_DIR/$STAMP-verify"
EXTRACT_DIR="$STATE_DIR/$STAMP-extract"
mkdir -p "$VERIFY_DIR" "$EXTRACT_DIR"
cp "$ZIP" "$VERIFY_DIR/"
cp "$CHECKSUM" "$VERIFY_DIR/"

echo "==> verifying the checksum in $VERIFY_DIR"
( cd "$VERIFY_DIR" && sha256sum -c "$(basename "$CHECKSUM")" )

echo "==> opening the archive"
PYTHON="${PYTHON:-python3}"
"$PYTHON" - "$(native_path "$ZIP")" "$(native_path "$EXTRACT_DIR")" <<'PY'
import sys
import zipfile

archive, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive) as bundle:
    names = bundle.namelist()
    bundle.extractall(target)
required = [
    "Release/harness.exe",
    "Release/harness-cli/cli.js",
    "Release/harness-cli/notify.mjs",
    "Release/source-commit.txt",
    "Release/README-WINDOWS.md",
    "Release/WINDOWS_PORT.md",
    "Release/WINDOWS_AGENT_VERIFICATION.md",
    "Release/version.txt",
    "Release/LICENSE.txt",
    "Release/licenses/xterm-LICENSE.txt",
    "Release/msvcp140.dll",
    "Release/vcruntime140.dll",
    "Release/vcruntime140_1.dll",
]
missing = [name for name in required if name not in names]
if missing:
    raise SystemExit(f"missing from the bundle: {missing}")
data_files = [n for n in names if n.startswith("Release/data/")]
if not data_files:
    raise SystemExit("the bundle carries no Release/data/ — harness.exe cannot run")
print(f"bundle entries: {len(names)} (data/: {len(data_files)})")
print("required files present: " + ", ".join(required))
PY

# --- the executable's import closure -------------------------------------------
# Verification of the CLOSURE, not just the three names: harness.exe and every
# Flutter plugin DLL were built with MSVC, so each imports the MSVC runtime. Any
# CRT-family import that is not in the bundle is a machine that cannot start the
# app. OS/UCRT/API-set libraries are separate and deliberately not required.
DUMPBIN="${DUMPBIN_OVERRIDE:-}"
if [[ -n "$DUMPBIN" && ! -f "$DUMPBIN" ]]; then
  echo "error: DUMPBIN_OVERRIDE does not name a file: $DUMPBIN" >&2
  exit 1
fi
if [[ -z "$DUMPBIN" ]]; then
  if [[ -n "$VS_ROOT" ]]; then
    DUMPBIN="$(latest_dumpbin_in_root "$VS_ROOT" || true)"
  fi
  if [[ -z "$DUMPBIN" ]]; then
    for root in "${VS_ROOT_PATHS[@]}"; do
      [[ -d "$root" ]] || continue
      if candidate="$(latest_dumpbin_in_root "$root")" && [[ -f "$candidate" ]]; then
        DUMPBIN="$candidate"
        break
      fi
    done
  fi
fi
if [[ -z "$DUMPBIN" ]]; then
  echo "== import closure: SKIPPED — dumpbin.exe not found next to the redist files."
  echo "   (The three CRT DLLs are present in the bundle; the closure was not"
  echo "   independently re-checked.)"
else
  echo "==> import closure via $DUMPBIN"
  closure_failures=0
  # Bundle names, lowercased once: a PE may import `MSVCP140.dll` while the file
  # on disk is `msvcp140.dll`, and this filesystem is case-sensitive.
  bundle_names="$(ls "$EXTRACT_DIR/Release" 2>/dev/null | tr 'A-Z' 'a-z')"
  while IFS= read -r binary; do
    set +e
    dumpbin_output="$("$DUMPBIN" //dependents "$binary" 2>&1)"
    dumpbin_status=$?
    set -e
    if [[ "$dumpbin_status" != "0" ]]; then
      echo "error: dumpbin failed for $(basename "$binary") (exit $dumpbin_status)" >&2
      printf '%s\n' "$dumpbin_output" >&2
      closure_failures=1
      continue
    fi
    # grep returns 1 when a valid binary has no matching imports; only that empty-match status is tolerated after dumpbin itself completed.
    imports="$(printf '%s\n' "$dumpbin_output" | grep -oiE '[A-Za-z0-9_.-]+\.dll' | sort -u || true)"
    while IFS= read -r imported; do
      if [[ -z "$imported" ]]; then
        continue
      fi
      case "${imported,,}" in
        msvcp*.dll|vcruntime*.dll|concrt*.dll|vccorlib*.dll)
          if ! grep -qx "${imported,,}" <<< "$bundle_names"; then
            echo "error: $(basename "$binary") imports $imported, which the bundle does not carry" >&2
            closure_failures=1
          fi
          ;;
      esac
    done <<< "$imports"
  done < <(ls "$EXTRACT_DIR"/Release/*.exe "$EXTRACT_DIR"/Release/*.dll 2>/dev/null)
  if [[ "$closure_failures" != "0" ]]; then
    exit 1
  fi
  echo "    every MSVC-family import of harness.exe and its plugin DLLs is present"
fi

# --- summary ------------------------------------------------------------------
echo
echo "== analysis : $ANALYZE_STATUS_TEXT"
echo "== tests    : $TEST_STATUS_TEXT"
echo "== build    : build/windows/x64/runner/Release/harness.exe"
echo "== bundle   : $ZIP"
echo "== checksum : $CHECKSUM (portable; names $(basename "$ZIP"))"
echo "== verified : $VERIFY_DIR (sha256sum -c) and $EXTRACT_DIR (contents)"
echo
echo "Run the unpacked app with: $RELEASE_DIR/harness.exe"
if [[ "$TESTS_GREEN" == "1" ]]; then
  exit 0
fi
exit 2
