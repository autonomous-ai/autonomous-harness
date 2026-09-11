import 'dart:io';

/// Opens [path] in the OS file manager — Finder on macOS, whatever `xdg-open`
/// resolves to on Linux.
///
/// For the one thing an app can hand a user that a screen cannot: the log files
/// themselves. `~/.harness/logs` is a hidden directory, and telling somebody to
/// type a dotted path into Finder is how a bug report ends instead of starts.
///
/// Returns whether the file manager was launched — false covers both a missing
/// directory and a machine with no handler for one, which is as much as the
/// caller can act on.
Future<bool> revealFolder(String path) async {
  if (!Directory(path).existsSync()) return false;
  final executable = Platform.isMacOS
      ? '/usr/bin/open'
      : Platform.isWindows
      ? 'explorer'
      : 'xdg-open';
  try {
    final result = await Process.run(executable, [path]);
    // `explorer` answers 1 even when it opened the window it was asked for.
    return result.exitCode == 0 || Platform.isWindows;
  } on ProcessException {
    return false;
  }
}
