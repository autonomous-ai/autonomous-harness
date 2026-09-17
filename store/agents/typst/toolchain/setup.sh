#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Puts the pinned Typst release binary in bin/ — a
# single static executable from typst/typst's GitHub release for this machine, nothing installed
# outside this directory.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(cat TYPST_VERSION)"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET="typst-aarch64-apple-darwin.tar.xz" ;;
  Darwin-x86_64) ASSET="typst-x86_64-apple-darwin.tar.xz" ;;
  Linux-x86_64) ASSET="typst-x86_64-unknown-linux-musl.tar.xz" ;;
  Linux-aarch64) ASSET="typst-aarch64-unknown-linux-musl.tar.xz" ;;
  *) echo "miss no Typst release for $(uname -s)-$(uname -m)"; exit 1 ;;
esac
if [ -x bin/typst ] && bin/typst --version 2>/dev/null | grep -q "${VERSION#v}"; then echo "ok   typst ${VERSION} already here"; exit 0; fi
mkdir -p bin tmp
echo "     downloading typst ${VERSION} (${ASSET})"
curl -fsSL -o "tmp/${ASSET}" "https://github.com/typst/typst/releases/download/${VERSION}/${ASSET}"
tar -xJf "tmp/${ASSET}" -C tmp
cp "tmp/${ASSET%.tar.xz}/typst" bin/typst && chmod +x bin/typst && rm -rf tmp
echo "ok   $(bin/typst --version)"
