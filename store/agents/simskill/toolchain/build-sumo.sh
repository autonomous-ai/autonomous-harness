#!/usr/bin/env bash
# Intel macOS's published SUMO wheel requires global Homebrew libraries. Build just the two
# headless tools instead, with a package-local Xerces library and the pinned upstream source.
set -euo pipefail
cd "$(dirname "$0")/.."
. toolchain/runtimes.sh
studio_sumo_pin="$(.venv/bin/python -c 'import json; print(next(s["commit"] for s in json.load(open("upstream.lock.json")) if s["directory"] == "sumo-src"))')"
if [ -x .sumo/bin/sumo ] && [ -x .sumo/bin/netconvert ] && [ -f .sumo/.source-pin ] && [ "$(cat .sumo/.source-pin)" = "$studio_sumo_pin" ]; then exit 0; fi
harness_conda_env .sumo 'xerces-c=3.3.0=h32b985b_2' 'icu=78.3=py313hbf1d544_2' 'libcxx=23.1.1=h19cb2f5_0'
if [ "$(uname -s)" = Darwin ]; then
  export SDKROOT="$(xcrun --show-sdk-path)"
  if [ -d "$SDKROOT/usr/include/c++/v1" ]; then
    export CPLUS_INCLUDE_PATH="$SDKROOT/usr/include/c++/v1${CPLUS_INCLUDE_PATH:+:$CPLUS_INCLUDE_PATH}"
  fi
fi
studio_cmake="$PWD/.venv/bin/cmake"
"$studio_cmake" -S sumo-src -B .build/sumo -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="$PWD/.sumo" -DCMAKE_INSTALL_PREFIX="$PWD/.sumo" \
  -DCHECK_OPTIONAL_LIBS=OFF -DENABLE_FOX=OFF -DENABLE_PROJ=OFF -DENABLE_GDAL=OFF \
  -DENABLE_FMI=OFF -DENABLE_NETEDIT=OFF -DENABLE_PYTHON_BINDINGS=OFF \
  -DENABLE_JAVA_BINDINGS=OFF -DENABLE_CS_BINDINGS=OFF -DENABLE_EIGEN=OFF \
  -DENABLE_FMT=OFF -DENABLE_GTEST=OFF -DENABLE_PARQUET=OFF -DENABLE_TCMALLOC=OFF \
  -DISOLATED_BUILD=ON
"$studio_cmake" --build .build/sumo --target sumo netconvert -j 2
mkdir -p .sumo/bin
cp .build/sumo/src/sumo .build/sumo/src/netconvert .sumo/bin/
.sumo/bin/sumo --version
.sumo/bin/netconvert --version
printf '%s\n' "$studio_sumo_pin" > .sumo/.source-pin
