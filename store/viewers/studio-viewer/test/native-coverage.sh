#!/usr/bin/env bash
# Instrument only the original JUCE starter's coverage; JUCE itself is upstream code.
set -euo pipefail
studio_viewer="$(cd "$(dirname "$0")/.." && pwd)"
studio_package="$(cd "$studio_viewer/../../agents/juce-agent-toolkit" && pwd)"
studio_workspace="$studio_viewer/test-results/native-coverage-workspace"
mkdir -p "$studio_workspace/Source" "$studio_workspace/profiles"
cp "$studio_package/template/CMakeLists.txt" "$studio_workspace/"
cp "$studio_package/template/Source/main.cpp" "$studio_workspace/Source/"
studio_sdk="$(xcrun --show-sdk-path)"
export SDKROOT="$studio_sdk"
export CPLUS_INCLUDE_PATH="$studio_sdk/usr/include/c++/v1${CPLUS_INCLUDE_PATH:+:$CPLUS_INCLUDE_PATH}"
studio_cmake="$studio_package/.venv/bin/cmake"
"$studio_cmake" -S "$studio_workspace" -B "$studio_workspace/build" \
  -DJUCE_ROOT="$studio_package/juce" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_SYSROOT="$studio_sdk" \
  '-DCMAKE_CXX_FLAGS=-fprofile-instr-generate -fcoverage-mapping' \
  -DCMAKE_EXE_LINKER_FLAGS=-fprofile-instr-generate
"$studio_cmake" --build "$studio_workspace/build" --target HarnessTone -j 2
studio_binary="$studio_workspace/build/HarnessTone_artefacts/Release/HarnessTone"
rm -f "$studio_workspace"/profiles/*.profraw
export LLVM_PROFILE_FILE="$studio_workspace/profiles/run-%p.profraw"
for studio_wave in sine triangle saw; do
  "$studio_binary" "$studio_workspace/$studio_wave.wav" "$studio_wave" 220 .02 .6 1
done
studio_expect_exit() {
  local studio_expected="$1"
  shift
  local studio_status=0
  "$studio_binary" "$@" || studio_status=$?
  test "$studio_status" -eq "$studio_expected" || { echo "Expected exit $studio_expected, got $studio_status"; exit 1; }
}
studio_expect_exit 2
studio_expect_exit 3 "$studio_workspace/invalid.wav" sine 220 .02 .6 0
studio_expect_exit 3 "$studio_workspace/invalid.wav" sine 220 .02 .6 9
studio_expect_exit 3 "$studio_workspace/invalid.wav" sine 100 .02 .6 1
studio_expect_exit 3 "$studio_workspace/invalid.wav" sine 900 .02 .6 1
studio_expect_exit 4 "$studio_workspace/missing/output.wav" sine 220 .02 .6 1
xcrun llvm-profdata merge -sparse "$studio_workspace"/profiles/*.profraw -o "$studio_workspace/coverage.profdata"
xcrun llvm-cov export "$studio_binary" -instr-profile="$studio_workspace/coverage.profdata" \
  "$studio_workspace/Source/main.cpp" > "$studio_viewer/test-results/native-cpp-coverage.json"
"$studio_package/.venv/bin/python" - "$studio_viewer/test-results/native-cpp-coverage.json" <<'PY'
import json,sys
report=json.load(open(sys.argv[1]))['data'][0]['files']
assert len(report)==1, 'Only the original starter belongs in this coverage denominator'
for name in ['lines','functions','branches','regions']:
    metric=report[0]['summary'][name]
    print(f'Native C++ {name}: {metric["covered"]}/{metric["count"]} ({metric["percent"]}%)')
    assert metric['covered']==metric['count'], f'Incomplete native {name} coverage'
PY
