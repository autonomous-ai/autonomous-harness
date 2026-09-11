import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_link_opener.dart';
import 'package:harness/terminal/remote_media_download.dart';

void main() {
  late List<Uri> launched;
  late List<String> checked;
  late TerminalLinkOpener opener;
  setUp(() {
    launched = [];
    checked = [];
    opener = TerminalLinkOpener(
      windows: false,
      homeDirectory: '/Users/test',
      launch: (uri) async {
        launched.add(uri);
        return true;
      },
      fileExists: (path) async {
        checked.add(path);
        return true;
      },
    );
  });
  test('hands the exact Unicode file URI to the OS without a shell', () async {
    const path = '/tmp/My art/ảnh (final) #1.png';
    expect(await opener.open(path, isLocalMachine: true), isNull);
    expect(checked, [path]);
    expect(launched.single.toFilePath(), path);
  });
  test('expands home and decodes a file URI once', () async {
    await opener.open('~/Pictures/one.png', isLocalMachine: true);
    await opener.open(
      'file://localhost/tmp/My%20art/100%2525.png',
      isLocalMachine: true,
    );
    expect(checked, ['/Users/test/Pictures/one.png', '/tmp/My art/100%25.png']);
  });
  test(
    'opens web URLs from local and remote agents without reading disk',
    () async {
      const target = 'https://example.com/a.mp4?token=a%2Fb&v=2';
      expect(await opener.open(target, isLocalMachine: false), isNull);
      expect(launched.single.toString(), target);
      expect(checked, isEmpty);
    },
  );
  test('never reads or launches a remote machine path locally', () async {
    expect(
      await opener.open('/tmp/preview.png', isLocalMachine: false),
      contains('another machine'),
    );
    expect(
      await opener.open(
        'file://other-host/tmp/preview.png',
        isLocalMachine: true,
      ),
      contains('another machine'),
    );
    expect(checked, isEmpty);
    expect(launched, isEmpty);
  });
  test('resolves remote paths on their owner and opens only the local completed copy', () async {
    for (final target in [
      '~/Pictures/ảnh.png',
      'output/clip.mp4',
      'file:///tmp/ảnh.png',
    ]) {
      String? requested;
      expect(
        await opener.open(
          target,
          isLocalMachine: false,
          downloadRemote: (path) async {
            requested = path;
            return '/cache/completed.png';
          },
        ),
        isNull,
      );
      expect(requested, target);
      expect(checked.last, '/cache/completed.png');
      expect(launched.last.toFilePath(), '/cache/completed.png');
    }
  });
  test('cancelled and failed downloads never launch a viewer', () async {
    expect(
      await opener.open(
        '/tmp/image.png',
        isLocalMachine: false,
        downloadRemote: (_) async => throw const RemoteMediaCancelled(),
      ),
      isNull,
    );
    expect(
      await opener.open(
        '/tmp/image.png',
        isLocalMachine: false,
        downloadRemote: (_) async =>
            throw const RemoteMediaException('Disconnected'),
      ),
      'Disconnected',
    );
    expect(
      await opener.open(
        '/tmp/image.png',
        isLocalMachine: false,
        downloadRemote: (_) async => '/cache/image.png',
        isCancelled: () => true,
      ),
      isNull,
    );
    expect(launched, isEmpty);
  });
  test('does not invent the agent cwd for relative paths', () async {
    expect(
      await opener.open('output/preview.png', isLocalMachine: true),
      contains('full file path'),
    );
    expect(checked, isEmpty);
    expect(launched, isEmpty);
  });
  for (final target in [
    'javascript:alert(1)',
    'command:run.png',
    '/tmp/run.sh',
    'data:image/png;base64,a',
    '/tmp/a\u0000.png',
  ]) {
    test('refuses $target', () async {
      expect(await opener.open(target, isLocalMachine: true), isNotNull);
      expect(checked, isEmpty);
      expect(launched, isEmpty);
    });
  }
  test('reports a missing file without launching', () async {
    final missing = TerminalLinkOpener(
      fileExists: (_) async => false,
      launch: (uri) async {
        launched.add(uri);
        return true;
      },
    );
    expect(
      await missing.open('/tmp/missing.png', isLocalMachine: true),
      contains('not available'),
    );
    expect(launched, isEmpty);
  });
  test('reports OS failures and exceptions', () async {
    final rejected = TerminalLinkOpener(launch: (_) async => false);
    expect(
      await rejected.open('https://example.com/preview', isLocalMachine: true),
      contains('Could not open'),
    );
    final failed = TerminalLinkOpener(
      launch: (_) async => throw StateError('no handler'),
    );
    expect(
      await failed.open('https://example.com/preview', isLocalMachine: true),
      contains('Could not open'),
    );
  });
}
