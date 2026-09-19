#!/bin/bash
set -euo pipefail

# Exercise the actual AppKit source without booting Flutter, authenticating,
# opening a window, or touching saved app data. The local Flutter SDK supplies
# FlutterMacOS only to satisfy the production source's framework import.
desktop_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
flutter_sdk="${1:-}"
if [[ -z "$flutter_sdk" && -f "$desktop_dir/macos/Flutter/ephemeral/Flutter-Generated.xcconfig" ]]; then
  flutter_sdk="$(sed -n 's/^FLUTTER_ROOT=//p' "$desktop_dir/macos/Flutter/ephemeral/Flutter-Generated.xcconfig")"
fi
framework_dir="$flutter_sdk/bin/cache/artifacts/engine/darwin-x64-release/FlutterMacOS.xcframework/macos-arm64_x86_64"
if [[ ! -d "$framework_dir/FlutterMacOS.framework/Modules" ]]; then
  echo 'Build Harness V2 first, or pass the Flutter SDK path containing its cached macOS release engine.' >&2
  exit 1
fi
check_dir="$(mktemp -d "${TMPDIR:-/tmp}/harness-v2-titlebar.XXXXXX")"
trap 'rm -rf "$check_dir"' EXIT
check_source="$desktop_dir/tool/swarm_titlebar_checks.swift"
if [[ "${2:-}" == "--window-zoom" ]]; then
  check_source="$desktop_dir/tool/window_zoom_checks.swift"
fi
cat "$desktop_dir/macos/Runner/HarnessKeymap.swift" \
  "$desktop_dir/macos/Runner/SwarmTitlebar.swift" \
  "$check_source" > "$check_dir/main.swift"
xcrun swiftc -swift-version 5 -module-cache-path "$check_dir/module-cache" \
  -F "$framework_dir" -framework FlutterMacOS \
  -Xlinker -rpath -Xlinker "$framework_dir" \
  "$check_dir/main.swift" -o "$check_dir/check-titlebar"
# Optional --window-layout / --window-zoom checks create a hidden NSWindow. They never show
# the window, boot Flutter, connect to agents or read saved app data.
HARNESS_TITLEBAR_ASSETS="$desktop_dir/assets" "$check_dir/check-titlebar" "${2:-}"
