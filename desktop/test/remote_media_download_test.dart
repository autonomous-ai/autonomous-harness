import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/remote_media_download.dart';

void main() {
  late Directory cache;
  late RemoteMediaDownloader downloader;
  late MediaDownloadCancellation cancellation;
  final fileRevision = 'a' * 64;
  final content = Uint8List.fromList(
    List.generate(remoteMediaChunkBytes * 6 + 31, (i) => i % 251),
  );

  Map<String, dynamic> chunk(int offset, {Uint8List? bytes}) {
    final source = bytes ?? content;
    return {
      'media': true,
      'filename': 'ảnh #1.mp4',
      'totalBytes': source.length,
      'offset': offset,
      'revision': fileRevision,
      'contentBase64': base64Encode(
        source.sublist(
          offset,
          min(offset + remoteMediaChunkBytes, source.length),
        ),
      ),
    };
  }

  setUp(() async {
    cache = await Directory.systemTemp.createTemp('harness-media-client-test-');
    downloader = RemoteMediaDownloader(directory: cache);
    cancellation = MediaDownloadCancellation();
  });
  tearDown(() async {
    await cache.delete(recursive: true);
  });

  test('writes exact ordered bytes with bounded parallel requests and real progress', () async {
    var inFlight = 0;
    var peak = 0;
    final offsets = <int>[];
    final progress = <RemoteMediaProgress>[];
    final path = await downloader.download(
      cancellation: cancellation,
      readChunk: ({required offset, revision}) async {
        offsets.add(offset);
        if (offset != 0) expect(revision, fileRevision);
        peak = max(peak, ++inFlight);
        await Future<void>.delayed(Duration(milliseconds: offset % 3 + 1));
        inFlight--;
        return chunk(offset);
      },
      onProgress: (value) {
        progress.add(value);
        // No media file is exposed before all bytes have been written.
        expect(
          cache
              .listSync(recursive: true)
              .whereType<File>()
              .every((f) => f.path.endsWith('.part')),
          isTrue,
        );
      },
    );
    expect(await File(path).readAsBytes(), content);
    expect(path, endsWith('/ảnh #1.mp4'));
    expect(offsets, [
      for (var i = 0; i < content.length; i += remoteMediaChunkBytes) i,
    ]);
    expect(peak, 4);
    expect(progress.last.receivedBytes, content.length);
    expect(progress.last.fraction, 1);
    expect(
      progress.map((p) => p.receivedBytes),
      orderedEquals(progress.map((p) => p.receivedBytes).toList()..sort()),
    );
  });

  test(
    'cancels promptly during a stalled batch and removes partial files',
    () async {
      final stalled = Completer<Map<String, dynamic>>();
      final started = Completer<void>();
      var requested = 0;
      final downloading = downloader.download(
        cancellation: cancellation,
        onProgress: (_) {},
        readChunk: ({required offset, revision}) async {
          requested++;
          if (offset == 0) return chunk(0);
          if (!started.isCompleted) started.complete();
          return stalled.future;
        },
      );
      final assertion = expectLater(
        downloading,
        throwsA(isA<RemoteMediaCancelled>()),
      );
      await started.future;
      cancellation.cancel();
      await assertion.timeout(const Duration(seconds: 1));
      expect(cache.listSync(), isEmpty);
      expect(requested, lessThanOrEqualTo(5));
      // A reply arriving after Cancel is consumed without an unhandled error.
      stalled.completeError(const RemoteMediaException('disconnected'));
      await Future<void>.delayed(Duration.zero);
    },
  );

  test('does not start any read when already cancelled', () async {
    cancellation.cancel();
    await expectLater(
      downloader.download(
        cancellation: cancellation,
        onProgress: (_) {},
        readChunk: ({required offset, revision}) async {
          fail('must not request data');
        },
      ),
      throwsA(isA<RemoteMediaCancelled>()),
    );
    expect(cache.listSync(), isEmpty);
  });

  for (final change in ['revision', 'totalBytes', 'contentBase64', 'offset']) {
    test(
      'rejects a changed or malformed $change and removes the partial copy',
      () async {
        await expectLater(
          downloader.download(
            cancellation: cancellation,
            onProgress: (_) {},
            readChunk: ({required offset, revision}) async {
              final reply = chunk(offset);
              if (offset > 0) {
                reply[change] = switch (change) {
                  'revision' => 'b' * 64,
                  'totalBytes' => content.length + 1,
                  'offset' => offset + 1,
                  _ => 'bad',
                };
              }
              return reply;
            },
          ),
          throwsA(isA<RemoteMediaException>()),
        );
        expect(cache.listSync(), isEmpty);
      },
    );
  }

  test('cleans partial data when the remote disconnects', () async {
    await expectLater(
      downloader.download(
        cancellation: cancellation,
        onProgress: (_) {},
        readChunk: ({required offset, revision}) async {
          if (offset > 0) throw const RemoteMediaException('disconnected');
          return chunk(0);
        },
      ),
      throwsA(isA<RemoteMediaException>()),
    );
    expect(cache.listSync(), isEmpty);
  });

  for (final unsafe in [
    {'filename': '../escape.mp4'},
    {'filename': 'escape.exe'},
    {'totalBytes': remoteMediaMaxBytes + 1},
    {'totalBytes': 0},
    {'media': false},
    {'revision': 'invalid'},
  ]) {
    test('rejects invalid metadata $unsafe before creating a file', () async {
      await expectLater(
        downloader.download(
          cancellation: cancellation,
          onProgress: (_) {},
          readChunk: ({required offset, revision}) async => {
            ...chunk(0),
            ...unsafe,
          },
        ),
        throwsA(isA<RemoteMediaException>()),
      );
      expect(cache.listSync(), isEmpty);
    });
  }

  test(
    'same filename from different machines never overwrites a previous preview',
    () async {
      final paths = <String>[];
      for (final bytes in [
        Uint8List.fromList([1, 2, 3]),
        Uint8List.fromList([4, 5]),
      ]) {
        paths.add(
          await downloader.download(
            cancellation: cancellation,
            onProgress: (_) {},
            readChunk: ({required offset, revision}) async =>
                chunk(offset, bytes: bytes),
          ),
        );
      }
      expect(paths[0], isNot(paths[1]));
      expect(await File(paths[0]).readAsBytes(), [1, 2, 3]);
      expect(await File(paths[1]).readAsBytes(), [4, 5]);
    },
  );

  test(
    'enforces its cache budget without touching unrelated directories',
    () async {
      final old = await Directory('${cache.path}/preview-old').create();
      final large = await File('${old.path}/old.mp4')
          .open(mode: FileMode.write);
      await large.truncate(1024 * 1024 * 1024);
      await large.close();
      final unrelated = await Directory('${cache.path}/keep-me').create();
      await File('${unrelated.path}/notes.txt').writeAsString('keep');
      final path = await downloader.download(
        cancellation: cancellation,
        onProgress: (_) {},
        readChunk: ({required offset, revision}) async =>
            chunk(offset, bytes: Uint8List.fromList([1])),
      );
      expect(await old.exists(), isFalse);
      expect(await File('${unrelated.path}/notes.txt').readAsString(), 'keep');
      expect(await File(path).exists(), isTrue);
    },
  );
}
