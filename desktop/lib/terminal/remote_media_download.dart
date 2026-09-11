import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import '../core/harness_file_store.dart';
import 'terminal_links.dart';

// Mirrors cli/src/lib/mediaPreview.ts. Four bounded requests per batch keep a
// high-latency relay useful without buffering a whole video on either machine.
const remoteMediaChunkBytes = 128 * 1024;
const remoteMediaMaxBytes = 512 * 1024 * 1024;
const _cacheMaxBytes = 1024 * 1024 * 1024;
const _cacheMaxAge = Duration(hours: 24);

typedef ReadRemoteMediaChunk = Future<Map<String, dynamic>> Function({
  required int offset,
  String? revision,
});

class RemoteMediaException implements Exception {
  final String message;
  const RemoteMediaException(this.message);
  @override
  String toString() => message;
}

class RemoteMediaCancelled implements Exception {
  const RemoteMediaCancelled();
}

class MediaDownloadCancellation {
  final _listeners = <void Function()>{};
  bool _cancelled = false;
  bool get isCancelled => _cancelled;
  void cancel() {
    if (isCancelled) return;
    _cancelled = true;
    for (final listener in _listeners.toList()) {
      listener();
    }
    _listeners.clear();
  }

  void check() {
    if (isCancelled) throw const RemoteMediaCancelled();
  }

  Future<T> wait<T>(Future<T> operation) {
    final result = Completer<T>();
    void cancelled() {
      if (!result.isCompleted) {
        result.completeError(const RemoteMediaCancelled());
      }
    }

    // Remove listeners after every batch; retaining completed futures on one
    // cancellation future would accidentally retain the entire video in RAM.
    operation.then(
      (value) {
        _listeners.remove(cancelled);
        if (!result.isCompleted) result.complete(value);
      },
      onError: (Object error, StackTrace stack) {
        _listeners.remove(cancelled);
        if (!result.isCompleted) result.completeError(error, stack);
      },
    );
    if (isCancelled) {
      cancelled();
    } else {
      _listeners.add(cancelled);
    }
    return result.future;
  }
}

class RemoteMediaProgress {
  final String filename;
  final int receivedBytes;
  final int? totalBytes;
  const RemoteMediaProgress(this.filename, this.receivedBytes, this.totalBytes);
  double? get fraction =>
      totalBytes == null ? null : receivedBytes / totalBytes!;
}

class _Chunk {
  final String filename;
  final int totalBytes;
  final String revision;
  final Uint8List bytes;
  const _Chunk(this.filename, this.totalBytes, this.revision, this.bytes);

  factory _Chunk.parse(Map<String, dynamic> raw, int offset, [_Chunk? first]) {
    final filename = raw['filename'];
    final total = raw['totalBytes'];
    final revision = raw['revision'];
    final encoded = raw['contentBase64'];
    if (raw['media'] != true ||
        raw['offset'] != offset ||
        filename is! String ||
        filename.isEmpty ||
        filename.length > 255 ||
        RegExp(r'[\\/\x00-\x1f\x7f]').hasMatch(filename) ||
        !isMediaPath(filename) ||
        total is! int ||
        total <= 0 ||
        total > remoteMediaMaxBytes ||
        offset >= total ||
        revision is! String ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(revision) ||
        encoded is! String) {
      throw const RemoteMediaException(
        'This machine returned an invalid media preview. Update its Harness CLI and try again.',
      );
    }
    if (first != null &&
        (first.totalBytes != total ||
            first.revision != revision ||
            first.filename != filename)) {
      throw const RemoteMediaException(
        'The file changed while downloading. Wait for it to finish generating and try again.',
      );
    }
    final length = min(remoteMediaChunkBytes, total - offset);
    if (encoded.length != ((length + 2) ~/ 3) * 4) {
      throw const RemoteMediaException(
        'The media download was incomplete. Try again.',
      );
    }
    Uint8List bytes;
    try {
      bytes = base64Decode(encoded);
    } on FormatException {
      throw const RemoteMediaException(
        'The media download was incomplete. Try again.',
      );
    }
    if (bytes.length != length) {
      throw const RemoteMediaException(
        'The media download was incomplete. Try again.',
      );
    }
    return _Chunk(filename, total, revision, bytes);
  }
}

/// Each preview gets a private, unique directory, so identical paths on two
/// machines (or two concurrent requests) can never overwrite each other. Only a
/// completely downloaded file is renamed to its real extension and opened.
class RemoteMediaDownloader {
  final Directory? directory;
  RemoteMediaDownloader({this.directory});
  static final _activeDirectories = <String>{};

  Future<String> download({
    required ReadRemoteMediaChunk readChunk,
    required MediaDownloadCancellation cancellation,
    required void Function(RemoteMediaProgress) onProgress,
  }) async {
    Directory? staging;
    RandomAccessFile? output;
    var complete = false;
    try {
      cancellation.check();
      final first = _Chunk.parse(
        await cancellation.wait(readChunk(offset: 0)),
        0,
      );
      cancellation.check();
      final cache =
          directory ??
          Directory(
            '${HarnessFileStore.defaultDirectoryPath()}/media-previews',
          );
      if (await FileSystemEntity.type(cache.path, followLinks: false) ==
          FileSystemEntityType.link) {
        throw const RemoteMediaException(
          'The preview cache is not accessible.',
        );
      }
      await cache.create(recursive: true);
      await _prune(cache, reserveBytes: first.totalBytes);
      cancellation.check();
      staging = await cache.createTemp('preview-');
      _activeDirectories.add(staging.path);
      output = await File('${staging.path}/download.part')
          .open(mode: FileMode.write);
      var received = 0;
      Future<void> write(_Chunk chunk) async {
        cancellation.check();
        await output!.writeFrom(chunk.bytes);
        cancellation.check();
        received += chunk.bytes.length;
        onProgress(
          RemoteMediaProgress(first.filename, received, first.totalBytes),
        );
      }

      await write(first);
      for (var offset = remoteMediaChunkBytes; offset < first.totalBytes;) {
        cancellation.check();
        final offsets = <int>[];
        for (
          var i = 0;
          i < 4 && offset < first.totalBytes;
          i++, offset += remoteMediaChunkBytes
        ) {
          offsets.add(offset);
        }
        final replies = await cancellation.wait(
          Future.wait([
            for (final start in offsets)
              Future.sync(
                () => readChunk(offset: start, revision: first.revision),
              ),
          ], eagerError: true),
        );
        for (var i = 0; i < replies.length; i++) {
          await write(_Chunk.parse(replies[i], offsets[i], first));
        }
      }
      cancellation.check();
      await output.close();
      output = null;
      cancellation.check();
      var filename = first.filename.replaceAll(RegExp(r'[:*?"<>|]'), '_');
      if (utf8.encode(filename).length > 200) {
        filename = 'preview${filename.substring(filename.lastIndexOf('.'))}';
      }
      final file = await File('${staging.path}/download.part')
          .rename('${staging.path}/$filename');
      cancellation.check();
      complete = true;
      return file.path;
    } on FileSystemException {
      throw const RemoteMediaException(
        'Could not save this preview. Check available disk space and try again.',
      );
    } finally {
      try {
        await output?.close();
      } on FileSystemException {
        /* still remove partial data */
      }
      if (staging != null) {
        _activeDirectories.remove(staging.path);
        if (!complete) {
          try {
            await staging.delete(recursive: true);
          } on FileSystemException {
            /* best effort */
          }
        }
      }
    }
  }

  /// Never follow links, touch active transfers, or let cache upkeep prevent a read.
  Future<void> _prune(Directory cache, {required int reserveBytes}) async {
    try {
      final entries = <({Directory directory, DateTime modified, int bytes})>[];
      await for (final entry in cache.list(followLinks: false)) {
        if (entry is! Directory ||
            !entry.uri.pathSegments
                .where((s) => s.isNotEmpty)
                .last
                .startsWith('preview-') ||
            _activeDirectories.contains(entry.path)) {
          continue;
        }
        var bytes = 0;
        await for (final file in entry.list(followLinks: false)) {
          if (file is File) bytes += (await file.stat()).size;
        }
        entries.add((
          directory: entry,
          modified: (await entry.stat()).modified,
          bytes: bytes,
        ));
      }
      entries.sort((a, b) => a.modified.compareTo(b.modified));
      var bytes = entries.fold(reserveBytes, (sum, entry) => sum + entry.bytes);
      final oldest = DateTime.now().subtract(_cacheMaxAge);
      for (final entry in entries) {
        if (entry.modified.isBefore(oldest) || bytes > _cacheMaxBytes) {
          await entry.directory.delete(recursive: true);
          bytes -= entry.bytes;
        }
      }
    } on FileSystemException {
      /* Cache pruning is best effort. */
    }
  }
}
