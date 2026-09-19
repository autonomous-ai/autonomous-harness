/// Turns a path the GUI's native picker produced into a path the CLI can open.
///
/// ## Why this exists
///
/// On macOS and Linux the app and its CLI share one filesystem, so a path from
/// the native folder panel is already the right answer. On Windows that is not
/// true: the CLI usually runs INSIDE a WSL2 distribution (see `wsl_runtime.dart`),
/// and `C:\work\project` names no directory in that distribution at all. A
/// dialog that opened the Windows picker would hand the CLI a cwd it cannot
/// chdir into, and the agent would fail to start in the very folder the user
/// watched themselves select.
///
/// So "this is my computer" (connectivity) and "this machine shares my
/// filesystem" (paths) are two different questions, and only the second one
/// decides whether a native picker is useful. Where they differ, the app browses
/// the backend's own filesystem over the daemon's `fs_list_dir` RPC — and, when
/// a path still arrives in GUI form, converts it here or REFUSES it. A refusal
/// with a sentence is better than a path the CLI will fail on later.
///
/// The conversion is deliberately bounded and explicit:
///
/// * a POSIX path is already backend-native and passes through;
/// * `C:\…` / `C:/…` maps to `/mnt/c/…` (the WSL mount of that drive);
/// * `\\wsl.localhost\<distro>\…` and `\\wsl$\<distro>\…` map into that
///   distribution's root, and only when it is the distribution in use;
/// * anything else — a network share, a drive-relative or UNC path naming a
///   machine that is not this one, a relative path — is **null**: there is no
///   honest conversion, so the caller must ask the user for a backend path.
class BackendPath {
  const BackendPath._();

  static const List<String> _wslUncRoots = ['wsl.localhost', r'wsl$'];

  /// The backend-native form of [path], or null when there is none.
  ///
  /// [distro] is the WSL distribution the CLI runs in; it is only consulted for
  /// `\\wsl…` paths, where naming a different distribution means the path is not
  /// on this backend.
  static String? toBackend(
    String path, {
    required bool backendIsWsl,
    String? distro,
  }) {
    final trimmed = path.trim();
    if (trimmed.isEmpty) return null;
    if (!backendIsWsl) return trimmed;
    // Windows also accepts forward slashes in UNC paths. Do not mistake a
    // network share for a directory in the distribution's root filesystem.
    if (trimmed.startsWith('//')) return null;

    // Already a Linux path: nothing to do. `~` is left for the CLI's own shell.
    if (trimmed.startsWith('/') || trimmed == '~' || trimmed.startsWith('~/')) {
      return trimmed;
    }

    if (trimmed.startsWith(r'\\')) {
      return _fromWslUnc(trimmed, distro: distro);
    }

    return _fromDrivePath(trimmed);
  }

  /// `\\wsl.localhost\Ubuntu\home\ana\project` -> `/home/ana/project`.
  static String? _fromWslUnc(String path, {required String? distro}) {
    final parts = path
        .substring(2)
        .split(RegExp(r'\\+'))
        .where((part) => part.isNotEmpty)
        .toList();
    if (parts.length < 2) return null;
    final root = parts.first.toLowerCase();
    if (!_wslUncRoots.contains(root)) return null;
    final namedDistro = parts[1];
    if (distro == null || namedDistro.toLowerCase() != distro.toLowerCase()) {
      // A different distribution's filesystem: not where this CLI runs.
      return null;
    }
    final rest = parts.skip(2).join('/');
    return rest.isEmpty ? '/' : '/$rest';
  }

  /// `C:\work\project` -> `/mnt/c/work/project`.
  static String? _fromDrivePath(String path) {
    final match = RegExp(r'^([A-Za-z]):[\\/](.*)$').firstMatch(path);
    if (match == null) return null;
    final drive = match.group(1)!.toLowerCase();
    final rest = match.group(2)!.replaceAll('\\', '/');
    return rest.isEmpty ? '/mnt/$drive' : '/mnt/$drive/$rest';
  }
}

/// The current user's home directory out of a process environment: `HOME` first,
/// then `USERPROFILE` — Windows sets only the latter, so a launch that never went
/// through a shell still resolves. Null when neither names an existing directory.
String? resolveHomeDirectory(Map<String, String> environment) {
  final home = environment['HOME'];
  if (home != null && home.isNotEmpty) return home;
  final profile = environment['USERPROFILE'];
  return profile != null && profile.isNotEmpty ? profile : null;
}

/// A value remembered while present and re-read after [ttl] while absent — so a
/// transient miss (a distro still booting, a CLI mid-sign-in) is retried later
/// without turning every read into a probe, and without one miss poisoning the
/// cache for the life of the process.
class MissTtlCache<T> {
  MissTtlCache({required this.ttl, DateTime Function()? now})
    : _now = now ?? DateTime.now;

  final Duration ttl;
  final DateTime Function() _now;

  T? _value;
  DateTime? _missedAt;
  Future<T?>? _inFlight;

  /// The current value, if a past read found one.
  T? get value => _value;

  /// The cached value, or null when absent within [ttl] of the last completed
  /// miss. Concurrent callers share an active read instead of observing a
  /// provisional miss or starting another source read.
  Future<T?> read(Future<T?> Function() readSource) async {
    if (_value != null) return _value;
    final active = _inFlight;
    if (active != null) return active;
    final missedAt = _missedAt;
    if (missedAt != null && _now().difference(missedAt) < ttl) return null;

    late final Future<T?> operation;
    operation = () async {
      try {
        // Future.sync also turns a synchronous source exception into an
        // asynchronous completion. That guarantees [operation] has been
        // assigned before the finally block inspects it.
        final result = await Future<T?>.sync(readSource);
        if (result == null) {
          // The TTL begins when the source answers, not when a potentially slow
          // read starts. Time spent waiting must not consume the retry window.
          _missedAt = _now();
        } else {
          _value = result;
          _missedAt = null;
        }
        return result;
      } finally {
        // A failed source read is retryable immediately. The identity guard
        // prevents an older completion from clearing a newer operation.
        if (identical(_inFlight, operation)) _inFlight = null;
      }
    }();
    _inFlight = operation;
    return operation;
  }
}
