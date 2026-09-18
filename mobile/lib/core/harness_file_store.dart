import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'host_platform.dart';
import 'viewer_mode.dart';
import 'local_key_value_store.dart';

/// Versioned Harness desktop state stored under the user's Harness home.
///
/// The file contains credentials and E2EE key material. Its parent directory
/// is private to the current user and every file created here is mode 0600 on
/// POSIX platforms. Values are never logged.
class HarnessFileStore implements BatchLocalKeyValueStore {
  static const schemaVersion = 1;
  // Separate from production; the CLI still owns shared authentication and links.
  //
  // A viewer build is a different product holding a different session — its own
  // SSO tokens and its own E2EE identity — so it lives BESIDE the desktop one
  // rather than in it. On a Mac, where the viewer path is developed with
  // `--dart-define=HARNESS_VIEWER_MODE=true`, the two would otherwise overwrite
  // each other's state.
  static final String directoryName = kViewerMode
      ? 'viewer-app-v2'
      : 'desktop-app-v2';
  static const fileName = 'state.json';
  static const lockFileName = 'state.lock';

  static final HarnessFileStore shared = HarnessFileStore();
  static final Map<String, Future<void>> _pathTails = {};

  final Directory directory;

  /// The parsed document, held between operations — **only where this app is the
  /// only writer.**
  ///
  /// ⚠️ **On a phone, and only on a phone.** Every read here costs a directory
  /// create, a lock file open, an exclusive `flock`, a full re-read and re-parse,
  /// an unlock and a close — and they are queued process-wide, so a launch that
  /// touches a dozen keys pays that toll a dozen times in series. Measured on a
  /// simulator, loading three config keys this way took 196ms for a 3 KB file.
  ///
  /// Sound because a viewer's state file has exactly one writer: the app itself,
  /// in its own sandbox, where no `harness` CLI exists and no second process can
  /// reach the container. On a DESKTOP the CLI writes this same file — the whole
  /// reason for the lock — so the cache stays off there and every read goes to
  /// disk exactly as before.
  ///
  /// It is a cache of the LAST READ DOCUMENT, refreshed by every write this
  /// store makes, so it cannot serve values older than this process's own last
  /// change. [_invalidate] drops it when a write fails and the file's true
  /// contents are no longer known.
  Map<String, String>? _cached;

  /// Whether this store may hold [_cached] at all. See its doc comment.
  final bool _cacheable;

  HarnessFileStore({Directory? directory})
    : directory = directory ?? Directory(defaultDirectoryPath()),
      // Only the shared, default-location store on a phone: a store pointed at a
      // directory a caller chose is a test's, or a second copy of the same file,
      // and neither may assume it is the only writer.
      _cacheable = isMobileHost && directory == null;

  /// [name] names the sibling under `~/.harness`; it defaults to this store's own.
  static String defaultDirectoryPath({
    Map<String, String>? environment,
    String? name,
  }) {
    final env = environment ?? Platform.environment;
    var home = env['HOME'];
    if ((home == null || home.isEmpty) && Platform.isWindows) {
      home = env['USERPROFILE'];
      if (home == null || home.isEmpty) {
        final drive = env['HOMEDRIVE'];
        final path = env['HOMEPATH'];
        if (drive != null && path != null) home = '$drive$path';
      }
    }
    if (home == null || home.isEmpty) home = containerHome;
    if (home == null || home.isEmpty) {
      throw StateError('Could not resolve the current user home directory');
    }
    return _join(_join(home, '.harness'), name ?? directoryName);
  }

  File get stateFile => File(_join(directory.path, fileName));
  File get _lockFile => File(_join(directory.path, lockFileName));

  @override
  Future<String?> read(String key) {
    final cached = _cached;
    // Answered without touching the filesystem, and without joining the queue:
    // where this store is the only writer, the held document IS the file. A
    // `SynchronousFuture` would let this resolve inside the caller's own
    // microtask, but an ordinary one keeps every caller's ordering identical to
    // the uncached path, which is worth more than the hop it saves.
    if (cached != null) return Future.value(cached[key]);
    return _serialized(() async => (await _readDocument())[key]);
  }

  /// One lock and document read for related preferences. The snapshot is scoped
  /// to this call: later reads still observe intervening writes, including
  /// writes from another store or process. Unrequested credentials never leave
  /// this operation.
  @override
  Future<Map<String, String?>> readMany(Iterable<String> keys) {
    final requested = keys.toSet();
    if (requested.isEmpty) return Future.value(const <String, String?>{});
    final cached = _cached;
    if (cached != null) {
      return Future.value({for (final key in requested) key: cached[key]});
    }
    return _serialized(() async {
      final values = await _readDocument();
      return {for (final key in requested) key: values[key]};
    });
  }

  @override
  Future<void> write(String key, String value) => _serialized(() async {
    final values = await _readDocument();
    values[key] = value;
    await _writeDocument(values);
  });

  @override
  Future<void> delete(String key) => _serialized(() async {
    final values = await _readDocument();
    if (values.remove(key) == null) return;
    await _writeDocument(values);
  });

  Future<T> _serialized<T>(Future<T> Function() operation) {
    final result = Completer<T>();
    final path = directory.absolute.path;
    final previous = _pathTails[path] ?? Future<void>.value();
    late final Future<void> queued;
    queued = previous.then((_) async {
      try {
        result.complete(await _withFileLock(operation));
      } catch (error, stack) {
        result.completeError(error, stack);
      }
    });
    _pathTails[path] = queued;
    unawaited(
      queued.whenComplete(() {
        if (identical(_pathTails[path], queued)) _pathTails.remove(path);
      }),
    );
    return result.future;
  }

  Future<T> _withFileLock<T>(Future<T> Function() operation) async {
    await _ensurePrivateDirectory();
    final lock = await _lockFile.open(mode: FileMode.append);
    try {
      await _makePrivateFile(_lockFile);
      await lock.lock(FileLock.exclusive);
      return await operation();
    } finally {
      try {
        await lock.unlock();
      } finally {
        await lock.close();
      }
    }
  }

  /// The document on disk, and — where [_cacheable] — what [_cached] becomes.
  ///
  /// ⚠️ **Always returns a map the caller may mutate.** `write` and `delete`
  /// edit what this returns and hand it to [_writeDocument], so handing back
  /// `_cached` itself would let a write that later fails leave its change in the
  /// cache, where it would be served as though it had been persisted. Every exit
  /// below builds a fresh map, and [_remember] copies rather than aliases.
  Future<Map<String, String>> _readDocument() async {
    final file = stateFile;
    if (!await file.exists()) return _remember(<String, String>{});
    try {
      final decoded = jsonDecode(await file.readAsString());
      if (decoded is! Map<String, dynamic>) {
        throw const FormatException('state root must be an object');
      }
      final version = decoded['version'];
      if (version is int && version > schemaVersion) {
        throw UnsupportedStateVersionException(version);
      }
      if (version != schemaVersion || decoded['values'] is! Map) {
        throw const FormatException('unsupported state document shape');
      }
      final values = <String, String>{};
      for (final entry in (decoded['values'] as Map).entries) {
        if (entry.key is! String || entry.value is! String) {
          throw const FormatException('state values must be strings');
        }
        values[entry.key as String] = entry.value as String;
      }
      return _remember(values);
    } on UnsupportedStateVersionException {
      // NOT remembered: this one leaves the file untouched and intact, so the
      // next read must go and look again rather than answer from a document
      // this store never managed to understand.
      rethrow;
    } on Object {
      // The corrupt file has been moved aside, so an empty document is now the
      // truth on disk and is safe to hold.
      await _quarantineCorruptState(file);
      return _remember(<String, String>{});
    }
  }

  /// Hold [values] as the known contents, and return it for the caller to use.
  ///
  /// The COPY is the one kept: callers mutate what they are given (see
  /// [_readDocument]), and a cache aliased to that map would follow their edits
  /// before those edits reached the disk.
  Map<String, String> _remember(Map<String, String> values) {
    if (_cacheable) _cached = Map<String, String>.from(values);
    return values;
  }

  /// Forget the held document: the file's contents are no longer known.
  void _invalidate() => _cached = null;

  Future<void> _writeDocument(Map<String, String> values) async {
    final suffix = '${pid}_${DateTime.now().microsecondsSinceEpoch}';
    final temporary = File(_join(directory.path, '.$fileName.$suffix.tmp'));
    // ⚠️ Dropped BEFORE the write and only restored once the rename lands. A
    // write that throws halfway leaves a file this store can no longer describe,
    // and serving the pre-write document from memory would be a lie that
    // outlives the process's next read. Cleared first, the next read goes to
    // disk and finds out.
    _invalidate();
    try {
      await temporary.writeAsString(
        '${const JsonEncoder.withIndent('  ').convert({'version': schemaVersion, 'values': values})}\n',
        flush: true,
      );
      await _makePrivateFile(temporary);
      await temporary.rename(stateFile.path);
      await _makePrivateFile(stateFile);
      // The rename is the commit: past it, `values` is exactly what is on disk.
      _remember(values);
    } finally {
      if (await temporary.exists()) await temporary.delete();
    }
  }

  Future<void> _quarantineCorruptState(File file) async {
    final timestamp = DateTime.now().toUtc().toIso8601String().replaceAll(
      RegExp(r'[^0-9A-Za-z]'),
      '',
    );
    var backup = File(_join(directory.path, 'state.corrupt-$timestamp.json'));
    var duplicate = 0;
    while (await backup.exists()) {
      duplicate++;
      backup = File(
        _join(directory.path, 'state.corrupt-$timestamp-$duplicate.json'),
      );
    }
    await file.rename(backup.path);
    await _makePrivateFile(backup);
  }

  Future<void> _ensurePrivateDirectory() async {
    await directory.create(recursive: true);
    await _chmod(directory.path, '700');
  }

  Future<void> _makePrivateFile(File file) => _chmod(file.path, '600');

  /// Windows has no POSIX modes, and a phone neither needs one — the app's
  /// sandbox is already private to it — nor can spawn `/bin/chmod` at all.
  Future<void> _chmod(String path, String mode) async {
    if (Platform.isWindows || isMobileHost) return;
    final result = await Process.run('/bin/chmod', [mode, path]);
    if (result.exitCode != 0) {
      throw FileSystemException('Could not set mode $mode', path);
    }
  }

  static String _join(String left, String right) {
    if (left.endsWith(Platform.pathSeparator)) return '$left$right';
    return '$left${Platform.pathSeparator}$right';
  }
}

class UnsupportedStateVersionException implements Exception {
  final int version;

  const UnsupportedStateVersionException(this.version);

  @override
  String toString() =>
      'Desktop state schema $version is newer than supported schema '
      '${HarnessFileStore.schemaVersion}; refusing to overwrite it';
}
