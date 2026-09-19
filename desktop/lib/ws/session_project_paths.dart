// Parses a daemon's session list into per-project working folders, honoring the daemon's path dialect.

import 'dart:io';

import '../core/backend_path.dart';
import '../core/models.dart';

/// Which path dialect a daemon's session cwds arrive in.
enum DaemonPathPlatform {
  /// Windows drive/UNC paths (`C:\work`, `\\server\share`) and `\`-relative `~` forms.
  windows,

  /// POSIX paths (`/home/user/project`) — macOS, Linux, or a WSL2 daemon.
  posix,
}

Map<String, AgentProject> localAgentProjects(
  Object? sessions,
  Map<String, String> environment,
  DaemonPathPlatform pathPlatform,
) {
  if (sessions is! List) return const {};
  final projects = <String, AgentProject>{};
  final home = resolveHomeDirectory(environment);
  for (final session in sessions) {
    if (session is! Map || session['id'] is! String) continue;
    final id = session['id'] as String;
    final rawCwd = session['cwd'];
    if (id.isEmpty ||
        rawCwd is! String ||
        rawCwd.isEmpty ||
        rawCwd.length > 4096 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(rawCwd)) {
      continue;
    }
    String cwd = rawCwd;
    final tildeRooted =
        cwd == '~' ||
        cwd.startsWith('~/') ||
        (pathPlatform == DaemonPathPlatform.windows && cwd.startsWith(r'~\'));
    if (tildeRooted) {
      // The home must be in the DAEMON's dialect: a POSIX (WSL) daemon's
      // `~/project` expanded with the Windows GUI's `C:\Users\me` both failed
      // the POSIX absolute check below (silently dropping the row) and, when
      // the GUI inherited an MSYS `HOME=/c/Users/me`, PASSED it while naming a
      // directory that does not exist inside the distro. A single drive letter
      // as the first POSIX segment (`/c/…`) is that MSYS transliteration, not
      // a home.
      final homeInDaemonDialect = home != null &&
          home.isNotEmpty &&
          (pathPlatform == DaemonPathPlatform.windows
              ? RegExp(r'^[A-Za-z]:[\\/]|^\\\\').hasMatch(home)
              : home.startsWith('/') &&
                    !RegExp(r'^/[A-Za-z](/|$)').hasMatch(home));
      if (pathPlatform == DaemonPathPlatform.windows) {
        if (!homeInDaemonDialect) continue;
        cwd = '$home${cwd.substring(1)}';
      } else if (homeInDaemonDialect) {
        cwd = '$home${cwd.substring(1)}';
      }
      // POSIX with no usable home: keep the daemon's own `~/…` verbatim below —
      // its shell resolves it, and no expansion beats a fabricated path.
    }
    // Validate against the DAEMON's path dialect, not the GUI host's.
    final absolute = pathPlatform == DaemonPathPlatform.windows
        ? RegExp(r'^[A-Za-z]:[\\/]|^\\\\').hasMatch(cwd)
        : cwd.startsWith('/') || (tildeRooted && !cwd.startsWith(r'~\'));
    if (!absolute) continue;
    try {
      if (pathPlatform == DaemonPathPlatform.posix) {
        // NO host File/Uri normalization: `toFilePath()` is host-relative — on a Windows GUI it
        // renders a POSIX path with backslashes and a drive-relative leading `\`, Uri parsing
        // throws ArgumentError (not FormatException) on a `:` in a segment, and a literal
        // backslash in a Linux file name silently becomes a separator (review cycle-7, P2). The
        // daemon's cwds stay in the daemon's dialect; dot segments are resolved by hand.
        // A kept-verbatim tilde cwd has no dot segments to resolve and must not
        // grow the synthetic `/` root `_normalizePosixPath` prepends.
        cwd = tildeRooted && cwd.startsWith('~')
            ? cwd
            : _normalizePosixPath(cwd);
      } else {
        cwd = File(cwd).uri.normalizePath().toFilePath();
      }
      // Directory paths in the status may carry a trailing separator.
      final separator = pathPlatform == DaemonPathPlatform.windows
          ? r'\'
          : '/';
      while (cwd.length > 1 &&
          cwd.endsWith(separator) &&
          !(pathPlatform == DaemonPathPlatform.windows &&
              RegExp(r'^[A-Za-z]:\\$').hasMatch(cwd))) {
        cwd = cwd.substring(0, cwd.length - 1);
      }
      final parts = cwd.split(separator).where((part) => part.isNotEmpty);
      final project = AgentProject.fromJson({
        'name': parts.isEmpty ? cwd : parts.last,
        'cwd': cwd,
      });
      if (project != null) projects[id] = project;
    } on FormatException {
      // A malformed status row must not prevent discovery of the daemon.
    }
  }
  return Map.unmodifiable(projects);
}

/// Resolve `.`/`..` segments of an ABSOLUTE POSIX path textually — no host filesystem, no Uri
/// parsing, no host dialect conversion. `/a/b/../c` is `/a/c`; `..` above the root stays at
/// the root. A trailing separator is preserved for the caller's trim loop.
String _normalizePosixPath(String path) {
  final trailing = path.length > 1 && path.endsWith('/') ? '/' : '';
  final parts = <String>[];
  for (final part in path.split('/')) {
    if (part.isEmpty || part == '.') continue;
    if (part == '..') {
      if (parts.isNotEmpty) parts.removeLast();
      continue;
    }
    parts.add(part);
  }
  return '/${parts.join('/')}$trailing';
}
