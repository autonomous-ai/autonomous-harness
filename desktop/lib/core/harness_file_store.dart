import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'local_key_value_store.dart';

/// Versioned Harness desktop state stored under the user's Harness home.
///
/// The file contains credentials and E2EE key material. Its parent directory
/// is private to the current user and every file created here is mode 0600 on
/// POSIX platforms. Values are never logged.
class HarnessFileStore implements LocalKeyValueStore {
  static const schemaVersion = 1;
  // Keep this legacy namespace stable across the product rename so existing
  // credentials and E2EE pairing state remain available after upgrading.
  static const directoryName = 'desktop-app';
  static const fileName = 'state.json';
  static const lockFileName = 'state.lock';

  static final HarnessFileStore shared = HarnessFileStore();
  static final Map<String, Future<void>> _pathTails = {};

  final Directory directory;

  HarnessFileStore({Directory? directory})
    : directory = directory ?? Directory(defaultDirectoryPath());

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
    if (home == null || home.isEmpty) {
      throw StateError('Could not resolve the current user home directory');
    }
    return _join(_join(home, '.harness'), name ?? directoryName);
  }

  File get stateFile => File(_join(directory.path, fileName));
  File get _lockFile => File(_join(directory.path, lockFileName));

  @override
  Future<String?> read(String key) =>
      _serialized(() async => (await _readDocument())[key]);

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

  Future<Map<String, String>> _readDocument() async {
    final file = stateFile;
    if (!await file.exists()) return <String, String>{};
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
      return values;
    } on UnsupportedStateVersionException {
      rethrow;
    } on Object {
      await _quarantineCorruptState(file);
      return <String, String>{};
    }
  }

  Future<void> _writeDocument(Map<String, String> values) async {
    final suffix = '${pid}_${DateTime.now().microsecondsSinceEpoch}';
    final temporary = File(_join(directory.path, '.$fileName.$suffix.tmp'));
    try {
      await temporary.writeAsString(
        '${const JsonEncoder.withIndent('  ').convert({'version': schemaVersion, 'values': values})}\n',
        flush: true,
      );
      await _makePrivateFile(temporary);
      await temporary.rename(stateFile.path);
      await _makePrivateFile(stateFile);
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

  Future<void> _chmod(String path, String mode) async {
    if (Platform.isWindows) return;
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
