# shellcheck shell=bash
# runtimes.sh — the interpreters a store package runs on, found on this machine or fetched, never
# asked of the person who pressed Get.
#
# Sourced (not run) by a package's setup, doctor and viewer scripts. A new Mac has Apple's Python 3.9,
# no Homebrew and, for most people, no Node on PATH; a package that answers "brew install python@3.11"
# has failed its install. So:
#
#   harness_node 18                 node >= 18 on PATH, with npm: the machine's own, else the Node Harness
#                                   itself runs on (~/.harness/runtime/current-node, laid down with the CLI)
#   harness_uv                      uv on PATH: the machine's own, else a pinned, checksummed release
#                                   fetched into ~/.harness/runtime
#   harness_venv DIR 3.12 [MIN [BELOW]]
#                                   DIR is a venv on CPython 3.12, which uv downloads when the machine
#                                   has none. A venv already there on a Python in [MIN, BELOW) is kept.
#   harness_pip DIR PKG…            install into that venv, through uv
#   harness_micromamba              micromamba, pinned and checksummed, for native libraries PyPI has
#                                   no wheel for (pycairo on macOS)
#   harness_conda_env DIR SPEC…     DIR is a conda-forge environment with those packages
#
# Every function prints `miss …` and returns 1 when it cannot deliver, so `harness_node 18 || exit 1`
# reads like the rest of a setup script. Nothing here touches the user's shell profile; what it
# installs lands in ~/.harness/runtime or the package's own directory (uv keeps its download cache
# where it always does, which a venv does not depend on).
#
# ONE copy is written by hand: store/tools/runtimes.sh in the OpenHarness repository. Each package
# carries an identical copy (a package installs alone, so it cannot reach this one);
# `node store/tools/sync-runtimes.mjs` rewrites them and the CLI's store spec fails when one drifts.

HARNESS_RUNTIME="${ADAPTER_RUNTIME_DIR:-${HOME:-}/.harness/runtime}"
# The Pythons uv downloads live with Harness's other runtimes, not in uv's own ~/.local/share/uv:
# a package's venv points at its interpreter, and `uv python uninstall` there must not break it.
UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$HARNESS_RUNTIME/python}"
export UV_PYTHON_INSTALL_DIR
HARNESS_UV_VERSION=0.12.15
HARNESS_MICROMAMBA_VERSION=2.9.0-0

_harness_platform() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo darwin-arm64 ;;
    Darwin-x86_64) echo darwin-x64 ;;
    Linux-x86_64) echo linux-x64 ;;
    Linux-aarch64 | Linux-arm64) echo linux-arm64 ;;
    *) return 1 ;;
  esac
}

_harness_sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

# _harness_fetch URL DEST SHA256 — DEST exists only if what arrived matches the pinned checksum.
_harness_fetch() {
  local part="$2.part.$$"
  if ! curl -fsSL --retry 3 --connect-timeout 20 --max-time 900 -o "$part" "$1"; then
    rm -f "$part"; echo "miss could not download $1 — check this machine's internet connection"; return 1
  fi
  if [ "$(_harness_sha256 "$part")" != "$3" ]; then
    rm -f "$part"; echo "miss $1 did not match its pinned checksum; nothing was installed"; return 1
  fi
  mv -f "$part" "$2"
}

_harness_node_at_least() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [a, b = 0] = process.argv[1].split(".").map(Number)
    const [x, y] = process.versions.node.split(".").map(Number)
    process.exit(x > a || (x === a && y >= b) ? 0 : 1)
  ' "$1" >/dev/null 2>&1
}

harness_node() {
  local min="${1:-18}" recorded saved="$PATH" own=0
  _harness_node_at_least "$min" && own=1
  # A node without npm beside it (a distro's nodejs package) cannot run a setup's `npm ci`.
  if [ "$own" = 1 ] && command -v npm >/dev/null 2>&1; then return 0; fi
  recorded="$(cat "$HARNESS_RUNTIME/current-node" 2>/dev/null || true)"
  # Already Harness's own (a second call, or a wrapper calling a script that asks again): nothing to add.
  if [ "$own" = 1 ] && [ -n "$recorded" ] && [ "$(command -v node)" = "${recorded%/*}/node" ]; then return 0; fi
  if [ -n "$recorded" ] && [ -x "${recorded%/*}/node" ]; then
    PATH="${recorded%/*}:$PATH"; export PATH; hash -r 2>/dev/null || true
    _harness_node_at_least "$min" && return 0
    PATH="$saved"; export PATH; hash -r 2>/dev/null || true
    [ "$own" = 1 ] && return 0
    echo "miss node >= $min — this machine's newest is $("${recorded%/*}/node" -v), Harness's own; update Harness"
    return 1
  fi
  [ "$own" = 1 ] && return 0
  echo "miss node >= $min, and Harness's own Node is not in $HARNESS_RUNTIME — run \`harness start\` once to lay it down"
  return 1
}

harness_uv() {
  local dir asset sum tmp
  command -v uv >/dev/null 2>&1 && return 0
  for dir in "${HOME:-}/.local/bin" "${HOME:-}/.cargo/bin"; do
    [ -n "${HOME:-}" ] || break
    if [ -x "$dir/uv" ]; then PATH="$dir:$PATH"; export PATH; return 0; fi
  done
  dir="$HARNESS_RUNTIME/uv-$HARNESS_UV_VERSION"
  if [ ! -x "$dir/uv" ]; then
    case "$(_harness_platform)" in
      darwin-arm64) asset=uv-aarch64-apple-darwin sum=dc304b9ed1b24174572290fba60ac3f6fe63c73a671f0439e62a91375841964d ;;
      darwin-x64) asset=uv-x86_64-apple-darwin sum=e9ca61775532368fe518ab03e7a354c7ecab8ccb3c7d941c775fcc4a362b801b ;;
      linux-x64) asset=uv-x86_64-unknown-linux-gnu sum=f97935763c04be3e692460a7aaeaaab8fc3b78fcf8b389da820b38ae7423a638 ;;
      linux-arm64) asset=uv-aarch64-unknown-linux-gnu sum=0e9a3499b0587d449c9ff684c0160da607826e4af1cee220bc87f378702d3e08 ;;
      *) echo "miss uv — there is no uv release for $(uname -s) $(uname -m); install it from https://docs.astral.sh/uv/"; return 1 ;;
    esac
    echo "     fetching uv $HARNESS_UV_VERSION into $HARNESS_RUNTIME (it brings Python and the packages)"
    mkdir -p "$HARNESS_RUNTIME" || { echo "miss cannot write $HARNESS_RUNTIME"; return 1; }
    tmp="$(mktemp -d "$HARNESS_RUNTIME/.uv.XXXXXX")" || { echo "miss cannot write $HARNESS_RUNTIME"; return 1; }
    if ! _harness_fetch "https://github.com/astral-sh/uv/releases/download/$HARNESS_UV_VERSION/$asset.tar.gz" "$tmp/uv.tar.gz" "$sum"; then
      rm -rf "$tmp"; return 1
    fi
    tar -xzf "$tmp/uv.tar.gz" -C "$tmp" && chmod +x "$tmp/$asset/uv" "$tmp/$asset/uvx" \
      || { rm -rf "$tmp"; echo "miss the uv archive would not unpack"; return 1; }
    # Two installs at once both get here; whichever renames first wins and the other's copy goes.
    # (mv onto a directory that exists would nest the copy inside it, hence the test.)
    [ -e "$dir" ] || mv "$tmp/$asset" "$dir" 2>/dev/null || true
    rm -rf "$tmp"
    [ -x "$dir/uv" ] || { echo "miss uv did not land in $dir"; return 1; }
  fi
  PATH="$dir:$PATH"; export PATH
}

# harness_venv DIR VERSION [MIN [BELOW]] — MIN defaults to VERSION; BELOW is exclusive and optional.
harness_venv() {
  local dir="${1:?harness_venv needs a directory}" want="${2:?harness_venv needs a Python version}"
  local min="${3:-$2}" below="${4:-}"
  if [ -x "$dir/bin/python" ] && "$dir/bin/python" -c '
import sys
at = lambda s: tuple(int(p) for p in s.split("."))
v = sys.version_info[:2]
sys.exit(0 if v >= at(sys.argv[1]) and (not sys.argv[2] or v < at(sys.argv[2])) else 1)
' "$min" "$below" 2>/dev/null; then
    echo "ok   $("$dir/bin/python" --version) in $dir"
    return 0
  fi
  harness_uv || return 1
  echo "     python $want in $dir (uv downloads it when this machine has none)"
  rm -rf "$dir"
  # only-managed: the same python-build-standalone interpreter on every machine, so a package tested
  # once is tested everywhere — not whichever Homebrew or pyenv Python happened to be first on PATH.
  uv venv --quiet --seed --python "$want" --python-preference only-managed "$dir" \
    || { echo "miss could not make a Python $want environment in $dir"; return 1; }
  echo "ok   $("$dir/bin/python" --version) in $dir"
}

harness_pip() {
  local dir="${1:?harness_pip needs a venv}"
  shift
  harness_uv || return 1
  # uv's own error comes first; the miss line is last, so it is the line the store shows.
  uv pip install --quiet --python "$dir/bin/python" "$@" \
    || { echo "miss could not install $* into $dir"; return 1; }
}

harness_micromamba() {
  local dir asset sum
  dir="$HARNESS_RUNTIME/micromamba-$HARNESS_MICROMAMBA_VERSION"
  if [ ! -x "$dir/micromamba" ]; then
    case "$(_harness_platform)" in
      darwin-arm64) asset=micromamba-osx-arm64 sum=ec2a072f028e1a7cf20f3e2e74d5a8127cf5a5f27636375b5359811565f4e5be ;;
      darwin-x64) asset=micromamba-osx-64 sum=1e71054bb3ac9a076e21f7ec48acfef536f9b3f1408f371a942784bf5ef83d8a ;;
      linux-x64) asset=micromamba-linux-64 sum=366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3 ;;
      linux-arm64) asset=micromamba-linux-aarch64 sum=9f93b974adcb4d166996af969b6cd371287d1a3e52733704727884d9b74cb7a7 ;;
      *) echo "miss micromamba — there is no release for $(uname -s) $(uname -m)"; return 1 ;;
    esac
    echo "     fetching micromamba $HARNESS_MICROMAMBA_VERSION into $HARNESS_RUNTIME (native libraries PyPI has no wheel for)"
    mkdir -p "$dir" || { echo "miss cannot write $dir"; return 1; }
    _harness_fetch "https://github.com/mamba-org/micromamba-releases/releases/download/$HARNESS_MICROMAMBA_VERSION/$asset" "$dir/micromamba.$$" "$sum" || return 1
    chmod +x "$dir/micromamba.$$" && mv -f "$dir/micromamba.$$" "$dir/micromamba" \
      || { rm -f "$dir/micromamba.$$"; echo "miss micromamba would not install into $dir"; return 1; }
  fi
  HARNESS_MICROMAMBA="$dir/micromamba"
  export HARNESS_MICROMAMBA
}

# harness_conda_env DIR SPEC… — conda-forge only, packages cached under ~/.harness/runtime/mamba.
harness_conda_env() {
  local dir="${1:?harness_conda_env needs a directory}"
  shift
  # micromamba takes a relative --prefix as a name under its root prefix and "succeeds" there.
  case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
  harness_micromamba || return 1
  MAMBA_ROOT_PREFIX="$HARNESS_RUNTIME/mamba" "$HARNESS_MICROMAMBA" create --yes --quiet \
    --prefix "$dir" --override-channels --channel conda-forge "$@" >/dev/null \
    && [ -d "$dir/conda-meta" ] \
    || { echo "miss could not make the conda-forge environment in $dir ($*)"; return 1; }
}
