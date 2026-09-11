import 'dart:io';

import 'package:flutter/services.dart';

/// Flutter's own `Clipboard` (package:flutter/services.dart) only ever exposes `text/plain` — see
/// `widgets/terminal_panel.dart`'s `_paste()`. Reading a real IMAGE off the clipboard (a
/// screenshot, "Copy Image" from a browser, ...) needs a native round trip instead: NSPasteboard on
/// macOS (`macos/Runner/MainFlutterWindow.swift`), the GTK clipboard on Linux
/// (`linux/runner/my_application.cc`). Both answer over the same channel name and method, so this
/// wrapper is the one place call sites need to know about.
class NativeClipboard {
  NativeClipboard._();

  static const MethodChannel _channel = MethodChannel(
    'harness/clipboard_image',
  );

  /// Reads the system clipboard for an image, returned as PNG bytes.
  ///
  /// Returns `null` on any platform without a native handler for this channel (Windows — the
  /// runner is unexercised, see CLAUDE.md — and any platform that isn't macOS/Linux) or when the
  /// clipboard genuinely holds no image, so call sites can use one check to fall through to
  /// today's text-paste behavior either way.
  static Future<Uint8List?> readImagePng() async {
    if (!Platform.isMacOS && !Platform.isLinux) return null;
    try {
      final bytes = await _channel.invokeMethod<Uint8List>('readImagePng');
      return bytes;
    } on MissingPluginException {
      return null;
    } catch (_) {
      return null;
    }
  }

  /// Writes `pngBytes` onto the system clipboard, replacing whatever was there — the LOCAL half
  /// of native image drag-drop (see `_dropImage` in `widgets/pane_grid.dart`): when the pane's
  /// machine is this same computer, the app puts the bytes on ITS OWN clipboard directly instead
  /// of sending them over the terminal wire, then forwards a Ctrl+V so the engine reads them
  /// exactly as it already does for an ordinary local clipboard paste.
  ///
  /// Returns `false` on any platform without a native handler for this channel, or when the
  /// native side could not decode/write the bytes — callers should treat that as "could not do
  /// the local shortcut" rather than surfacing a crash.
  static Future<bool> writeImagePng(Uint8List pngBytes) async {
    if (!Platform.isMacOS && !Platform.isLinux) return false;
    try {
      final wrote = await _channel.invokeMethod<bool>(
        'writeImagePng',
        pngBytes,
      );
      return wrote ?? false;
    } on MissingPluginException {
      return false;
    } catch (_) {
      return false;
    }
  }
}
