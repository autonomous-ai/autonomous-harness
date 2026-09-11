/// Where a feature keeps one JSON blob between launches.
///
/// A seam for the same reason [LocalKeyValueStore] is one: a widget test mounts
/// the real screen and drives the real store, and neither may touch a real
/// `~/.harness`. ⚠️ **Under `testWidgets` this is not merely untidy — it hangs.**
/// The test body runs in a fake-async zone that never completes a real
/// `File.writeAsString`, so a store that awaited one inside a widget test would
/// block until the shell was killed rather than failing. That is the bug this
/// interface exists to make impossible, so keep `dart:io` on the far side of it.
///
/// Deliberately NOT `LocalKeyValueStore`, which is `state.json` — one small
/// document holding settings and credentials, rewritten under a file lock on
/// every key. What lands here is derived bulk (a usage snapshot runs to
/// megabytes), and putting that in `state.json` would make every theme flip
/// rewrite it.
library;

import 'dart:io';

import 'harness_file_store.dart';

abstract interface class SnapshotStore {
  /// The blob as it was written, or null when there is none.
  ///
  /// Never throws: an unreadable snapshot is a snapshot that is not there, and
  /// a screen that failed to open because last week's cache was truncated would
  /// be a worse bug than recomputing it.
  Future<String?> read();

  Future<void> write(String contents);

  /// Forget it entirely — what switching a feature off does.
  Future<void> clear();
}

/// The real one: `~/.harness/desktop-app/<name>.json`.
///
/// Written to a temporary file and renamed, so a crash mid-write leaves the
/// previous snapshot rather than half of a new one.
class FileSnapshotStore implements SnapshotStore {
  FileSnapshotStore(this.name, {Directory? directory})
    : directory =
          directory ?? Directory(HarnessFileStore.defaultDirectoryPath());

  /// The basename, without `.json`.
  final String name;
  final Directory directory;

  File get file => File('${directory.path}/$name.json');

  @override
  Future<String?> read() async {
    try {
      final snapshot = file;
      if (!await snapshot.exists()) return null;
      return await snapshot.readAsString();
    } on Object {
      return null;
    }
  }

  @override
  Future<void> write(String contents) async {
    try {
      await directory.create(recursive: true);
      final temporary = File('${file.path}.tmp');
      await temporary.writeAsString(contents, flush: true);
      await temporary.rename(file.path);
    } on Object {
      // A snapshot that could not be written costs the next launch a recompute
      // and nothing else, so it must not turn good work into a failure.
    }
  }

  @override
  Future<void> clear() async {
    try {
      if (await file.exists()) await file.delete();
    } on FileSystemException {
      // Whatever it held is off the screen either way, and the next write
      // replaces the file.
    }
  }
}

/// The same contract with no disk under it — for tests, and for a build that
/// deliberately keeps nothing.
class MemorySnapshotStore implements SnapshotStore {
  MemorySnapshotStore([this.contents]);

  String? contents;

  bool get isEmpty => contents == null;

  @override
  Future<String?> read() async => contents;

  @override
  Future<void> write(String value) async => contents = value;

  @override
  Future<void> clear() async => contents = null;
}
