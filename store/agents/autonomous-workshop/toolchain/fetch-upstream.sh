#!/usr/bin/env bash
# Fetch the wrapped project into upstream/ at the commit VERSIONS pins — read-only, from its public
# repository, sparse and blob-less so only the folders a build needs come down. Idempotent: a matching
# upstream/.harness-commit means it is already there. Sourced by setup.sh; cwd = the package dir.
set -euo pipefail
. ./VERSIONS
if [ -f upstream/.harness-commit ] && [ "$(cat upstream/.harness-commit)" = "${UPSTREAM_COMMIT}" ]; then
  echo "ok   ${UPSTREAM_NAME} @ ${UPSTREAM_COMMIT:0:12} already fetched"
  exit 0
fi
command -v git >/dev/null 2>&1 || { echo "miss git on PATH"; exit 1; }
echo "     fetching ${UPSTREAM_REPO} @ ${UPSTREAM_COMMIT:0:12} (${UPSTREAM_SPARSE_MODE} sparse: ${UPSTREAM_SPARSE})"
rm -rf upstream.partial upstream
git init -q upstream.partial
git -C upstream.partial remote add origin "${UPSTREAM_REPO}"
# Split the patterns on spaces WITHOUT globbing: `/*` is a sparse pattern, not the filesystem root.
read -r -a patterns <<<"${UPSTREAM_SPARSE}"
git -C upstream.partial sparse-checkout set --"${UPSTREAM_SPARSE_MODE}" -- "${patterns[@]}"
git -C upstream.partial fetch -q --depth 1 --filter=blob:none origin "${UPSTREAM_COMMIT}"
git -C upstream.partial checkout -q FETCH_HEAD
echo "${UPSTREAM_COMMIT}" > upstream.partial/.harness-commit
mv upstream.partial upstream
echo "ok   ${UPSTREAM_NAME} @ ${UPSTREAM_COMMIT:0:12} fetched ($(du -sh upstream | cut -f1))"
