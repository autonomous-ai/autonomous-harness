#!/usr/bin/env bash
# The project's own doctor, run against the fetched copy. cwd = the install dir.
set -uo pipefail
cd "$(dirname "$0")/.."
. ./VERSIONS
if [ ! -f upstream/.harness-commit ]; then
  echo "miss autonomous-workshop is not fetched — run toolchain/setup.sh"; exit 1
fi
[ "$(cat upstream/.harness-commit)" = "${UPSTREAM_COMMIT}" ] \
  && echo "ok   autonomous-workshop @ ${UPSTREAM_COMMIT:0:12}" \
  || echo "warn autonomous-workshop @ $(cut -c1-12 upstream/.harness-commit), VERSIONS pins ${UPSTREAM_COMMIT:0:12} — run toolchain/setup.sh"
HARNESS_DSH_DIR="$PWD/upstream" exec upstream/harness/toolchain/doctor.sh
