import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/terminal/remote_media_download.dart';
import 'package:harness/terminal/terminal_link_opener.dart';
import 'package:harness/ws/ws_conn.dart';

/// Opt-in integration smoke: real CLI media reads, real signed E2EE handshake,
/// two WebSocket hops, Dart downloads and the OS-launch boundary. It needs the
/// companion CLI checkout (with npm dependencies) and ffmpeg, never real accounts.
void main() {
  final cliRoot = Platform.environment['REMOTE_MEDIA_CLI_ROOT'];
  if (cliRoot == null) {
    test(
      'remote media A/B smoke',
      () {},
      skip: 'Set REMOTE_MEDIA_CLI_ROOT to the companion CLI checkout.',
    );
    return;
  }
  late Directory fixture;
  late Directory machineB;
  late Directory cacheA;
  late Process peer;
  late int port;
  late WsConn connection;
  final stderr = StringBuffer();
  const video = 'preview.mp4';
  const photo = 'ảnh preview.png';

  setUpAll(() async {
    fixture = await Directory.systemTemp.createTemp('harness-remote-smoke-');
    machineB = await Directory('${fixture.path}/machine-B').create();
    final encoded = await Process.run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=30',
      '-t',
      '3',
      '-c:v',
      'mpeg4',
      '-q:v',
      '2',
      '-y',
      '${machineB.path}/$video',
    ]);
    expect(encoded.exitCode, 0, reason: '${encoded.stderr}');
    final thumbnail = await Process.run('ffmpeg', [
      '-v',
      'error',
      '-i',
      '${machineB.path}/$video',
      '-frames:v',
      '1',
      '-y',
      '${machineB.path}/$photo',
    ]);
    expect(thumbnail.exitCode, 0, reason: '${thumbnail.stderr}');
    expect(
      await File('${machineB.path}/$video').length(),
      greaterThan(remoteMediaChunkBytes),
    );
    peer = await Process.start(
      'node',
      ['--import', 'tsx', 'scripts/smoke-media-peer.ts', machineB.path],
      workingDirectory: cliRoot,
      environment: {
        'HARNESS_MEDIA_SMOKE': '1',
        'ADAPTER_DATA_DIR': '${fixture.path}/isolated-identities',
      },
    );
    peer.stderr.transform(utf8.decoder).listen(stderr.write);
    final ready = Completer<int>();
    peer.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
          (line) {
            try {
              final message = jsonDecode(line);
              if (message is Map &&
                  message['port'] is int &&
                  !ready.isCompleted) {
                ready.complete(message['port'] as int);
              }
            } on FormatException {
              /* The CLI may also print diagnostic lines. */
            }
          },
          onDone: () {
            if (!ready.isCompleted) {
              ready.completeError(StateError('Peer did not start: $stderr'));
            }
          },
        );
    port = await ready.future.timeout(const Duration(seconds: 15));
  });
  tearDownAll(() async {
    await peer.stdin.close();
    await peer.exitCode.timeout(
      const Duration(seconds: 10),
      onTimeout: () {
        peer.kill();
        return -1;
      },
    );
    await fixture.delete(recursive: true);
  });

  setUp(() async {
    cacheA = await fixture.createTemp('machine-A-cache-');
    final ready = Completer<void>();
    connection = WsConn(
      wsBaseUrl: '',
      autonomousEnv: 'smoke',
      machineId: 'smoke-B',
      accessTokenProvider: (_, _) async => '',
      onAuthFailure: (reason) => fail(reason),
      onEvent: (_) {},
      onStatus: (status) {
        if (status == ConnectionStatus.connected && !ready.isCompleted) {
          ready.complete();
        }
      },
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: Uri.parse('ws://127.0.0.1:$port'),
    );
    await connection.connect();
    await ready.future.timeout(const Duration(seconds: 10));
  });
  tearDown(() async {
    await connection.close();
  });

  ReadRemoteMediaChunk reader(
    String filename, {
    bool delay = false,
    bool disconnect = false,
  }) =>
      ({required offset, revision}) => connection.request(
        'agent_read_file',
        payload: {
          'agentId': 'agent-B',
          'media': true,
          'path': '${machineB.path}/$filename',
          'offset': offset,
          'revision': ?revision,
          if (delay) 'smokeDelay': true,
          if (disconnect) 'smokeDisconnect': true,
        },
        timeout: const Duration(seconds: 2),
      );

  for (final filename in [photo, video]) {
    test(
      'machine A downloads and opens $filename from B through E2EE',
      () async {
        final launched = <Uri>[];
        final progress = <RemoteMediaProgress>[];
        final opener = TerminalLinkOpener(
          launch: (uri) async {
            launched.add(uri);
            return true;
          },
        );
        final message = await opener.open(
          '${machineB.path}/$filename',
          isLocalMachine: false,
          downloadRemote: (_) =>
              RemoteMediaDownloader(directory: cacheA).download(
                readChunk: reader(filename),
                cancellation: MediaDownloadCancellation(),
                onProgress: progress.add,
              ),
        );
        expect(message, isNull, reason: stderr.toString());
        final localPath = launched.single.toFilePath();
        expect(localPath, startsWith(cacheA.path));
        expect(
          await File(localPath).readAsBytes(),
          await File('${machineB.path}/$filename').readAsBytes(),
        );
        expect(progress.last.fraction, 1);
        final stats = await connection.request('smoke_stats');
        expect(stats['encryptedRequests'], greaterThan(0));
        expect(stats['encryptedReplies'], stats['encryptedRequests']);
        expect(stats['maxFrameBytes'], lessThan(256 * 1024));
      },
    );
  }

  test(
    'Cancel during a delayed encrypted transfer deletes the partial copy',
    () async {
      final cancellation = MediaDownloadCancellation();
      var scheduled = false;
      await expectLater(
        RemoteMediaDownloader(directory: cacheA).download(
          readChunk: reader(video, delay: true),
          cancellation: cancellation,
          onProgress: (_) {
            if (!scheduled) {
              scheduled = true;
              Timer(const Duration(milliseconds: 20), cancellation.cancel);
            }
          },
        ),
        throwsA(isA<RemoteMediaCancelled>()),
      );
      expect(cacheA.listSync(), isEmpty);
    },
  );

  test('lost remote connection cannot leave or open a partial video', () async {
    final launched = <Uri>[];
    final opener = TerminalLinkOpener(
      launch: (uri) async {
        launched.add(uri);
        return true;
      },
    );
    final message = await opener.open(
      '${machineB.path}/$video',
      isLocalMachine: false,
      downloadRemote: (_) => RemoteMediaDownloader(directory: cacheA).download(
        readChunk: reader(video, disconnect: true),
        cancellation: MediaDownloadCancellation(),
        onProgress: (_) {},
      ),
    );
    expect(message, isNotNull);
    expect(launched, isEmpty);
    expect(cacheA.listSync(), isEmpty);
  });
}
