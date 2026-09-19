import 'dart:io';

/// Whether this build is a VIEWER: a window onto the user's machines and nothing more.
///
/// No harness CLI runs beside it and no agent is ever hosted here, so every machine — this computer
/// included, if it is a Harness machine at all — is reached through the relay, with this app
/// terminating the end-to-end encryption the CLI terminates everywhere else (see `lib/viewer/`).
///
/// True on iOS and Android, where a phone will not host a Node runtime or spawn a process at all.
/// On macOS and Linux only with `--dart-define=HARNESS_VIEWER_MODE=true`, which is how the path is
/// developed and tested on a Mac against real machines.
///
/// Windows hosts the CLI inside WSL2 and therefore uses local discovery and loopback transport.
/// Relay-only Windows builds remain available with `--dart-define=HARNESS_VIEWER_MODE=true`.
final bool kViewerMode =
    const bool.fromEnvironment('HARNESS_VIEWER_MODE') ||
    Platform.isIOS ||
    Platform.isAndroid;
