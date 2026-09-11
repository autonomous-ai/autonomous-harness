import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_link_opener.dart';
import 'package:harness/terminal/remote_media_download.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

class _PreviewNotifier extends AppNotifier {
  _PreviewNotifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  final reads = <(String, String, String, int)>[];
  @override
  Future<Map<String, dynamic>> readRemoteMediaChunk(
    String machineId,
    String agentId,
    String target, {
    required int offset,
    String? revision,
  }) async {
    reads.add((machineId, agentId, target, offset));
    return {};
  }
}

class _PendingDownloader extends RemoteMediaDownloader {
  final result = Completer<String>();
  MediaDownloadCancellation? cancellation;
  @override
  Future<String> download({
    required ReadRemoteMediaChunk readChunk,
    required MediaDownloadCancellation cancellation,
    required void Function(RemoteMediaProgress) onProgress,
  }) async {
    this.cancellation = cancellation;
    await readChunk(offset: 0);
    onProgress(const RemoteMediaProgress('preview.png', 5, 10));
    return cancellation.wait(result.future);
  }
}

void testOnPlatform(
  String description,
  WidgetTesterCallback callback, {
  TargetPlatform platform = TargetPlatform.macOS,
}) {
  testWidgets(
    description,
    callback,
    variant: TargetPlatformVariant.only(platform),
  );
}

void main() {
  late TerminalSession session;
  late AppNotifier notifier;
  late List<Uri> launched;
  late List<String> outbound;

  Future<void> mount(
    WidgetTester tester, {
    bool local = true,
    bool readOnly = false,
    bool exists = true,
    RemoteMediaDownloader? downloader,
  }) async {
    launched = [];
    outbound = [];
    notifier = downloader != null
        ? _PreviewNotifier()
        : AppNotifier(
            config: AppConfig.dev,
            authSession: AuthSession(),
            configStore: null,
          );
    final machine = Machine(
      machineId: 'm1',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'm1',
      status: 'online',
    );
    notifier.machines = [machine];
    notifier.machineStates['m1'] = MachineState(machine)
      ..localOnly = local
      ..connectionStatus = ConnectionStatus.connected;
    session =
        TerminalSession(
            machineId: 'm1',
            agentId: 'a1',
            agentName: 'a1',
            engineId: 'codex',
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream-a1';
    session.terminal.onOutput = outbound.add;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalPanel(
            notifier: notifier,
            session: session,
            focused: true,
            readOnly: readOnly,
            mediaDownloader: downloader,
            linkOpener: TerminalLinkOpener(
              windows: false,
              fileExists: (_) async => exists,
              launch: (uri) async {
                launched.add(uri);
                return true;
              },
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    // Mouse-tracking agents must not also receive a click used to open media.
    session.terminal.write('\x1b[?1000h\x1b[?1006h/tmp/preview.png');
    await tester.pump();
    addTearDown(() {
      session.dispose();
      notifier.dispose();
    });
  }

  Offset point(WidgetTester tester, [int column = 6]) {
    final view = tester.state<TerminalViewState>(find.byType(TerminalView));
    final render = view.renderTerminal;
    return render.localToGlobal(
      render.getOffset(CellOffset(column, 0)) +
          Offset(render.cellSize.width / 2, render.cellSize.height / 2),
    );
  }

  Future<void> click(
    WidgetTester tester, {
    LogicalKeyboardKey? modifier,
    String platform = 'macos',
  }) async {
    if (modifier != null) {
      await tester.sendKeyDownEvent(modifier, platform: platform);
    }
    await tester.tapAt(point(tester), kind: PointerDeviceKind.mouse);
    if (modifier != null) {
      await tester.sendKeyUpEvent(modifier, platform: platform);
    }
    await tester.pump(const Duration(milliseconds: 350));
  }

  for (final platform in [TargetPlatform.macOS, TargetPlatform.linux]) {
    testOnPlatform(
      '$platform modifier-click opens media without terminal mouse input',
      (tester) async {
        await mount(tester);
        await click(
          tester,
          modifier: platform == TargetPlatform.macOS
              ? LogicalKeyboardKey.metaLeft
              : LogicalKeyboardKey.controlLeft,
          platform: platform == TargetPlatform.macOS ? 'macos' : 'linux',
        );
        expect(launched.single.toFilePath(), '/tmp/preview.png');
        expect(outbound, isEmpty);
      },
      platform: platform,
    );
  }
  testOnPlatform(
    'ordinary click still sends terminal mouse reports and never opens a file',
    (tester) async {
      await mount(tester);
      await click(tester);
      expect(launched, isEmpty);
      expect(outbound, hasLength(2));
    },
  );
  testOnPlatform(
    'modified click on ordinary text still belongs to the terminal',
    (tester) async {
      await mount(tester);
      session.terminal.write('\r\x1b[2Kordinary text');
      await tester.pump();
      await click(tester, modifier: LogicalKeyboardKey.metaLeft);
      expect(launched, isEmpty);
      expect(outbound, hasLength(2));
    },
  );
  testOnPlatform('read-only output can still open a preview', (tester) async {
    await mount(tester, readOnly: true);
    await click(tester, modifier: LogicalKeyboardKey.metaLeft);
    expect(launched, hasLength(1));
    expect(outbound, isEmpty);
  });
  for (final remote in [false, true]) {
    testOnPlatform(
      remote
          ? 'remote media shows a useful message'
          : 'missing media shows a useful message',
      (tester) async {
        await mount(tester, local: !remote, exists: false);
        await click(tester, modifier: LogicalKeyboardKey.metaLeft);
        expect(launched, isEmpty);
        expect(
          find.textContaining(
            remote
                ? 'Update the Harness CLI'
                : 'not available on this computer',
          ),
          findsOneWidget,
        );
        expect(outbound, isEmpty);
      },
    );
  }
  for (final platform in [TargetPlatform.macOS, TargetPlatform.linux]) {
    testOnPlatform(
      '$platform remote preview shows progress then opens the downloaded file',
      (tester) async {
        final download = _PendingDownloader();
        await mount(tester, local: false, downloader: download);
        await click(
          tester,
          modifier: platform == TargetPlatform.macOS
              ? LogicalKeyboardKey.metaLeft
              : LogicalKeyboardKey.controlLeft,
          platform: platform == TargetPlatform.macOS ? 'macos' : 'linux',
        );
        expect((notifier as _PreviewNotifier).reads, [
          ('m1', 'a1', '/tmp/preview.png', 0),
        ]);
        expect(find.text('Downloading preview.png · 50%'), findsOneWidget);
        expect(launched, isEmpty);
        expect(outbound, isEmpty);
        download.result.complete('/cache/downloaded.png');
        await tester.pump();
        expect(launched.single.toFilePath(), '/cache/downloaded.png');
        expect(find.textContaining('Downloading'), findsNothing);
      },
      platform: platform,
    );
  }
  testOnPlatform('Cancel removes download progress and ignores a late result', (
    tester,
  ) async {
    final download = _PendingDownloader();
    await mount(tester, local: false, downloader: download);
    await click(tester, modifier: LogicalKeyboardKey.metaLeft);
    await tester.tap(find.text('CANCEL'));
    await tester.pump();
    expect(download.cancellation!.isCancelled, isTrue);
    expect(find.textContaining('Downloading'), findsNothing);
    download.result.complete('/cache/downloaded.png');
    await tester.pump();
    expect(launched, isEmpty);
  });
  testOnPlatform(
    'closing the pane cancels a download and never opens its late result',
    (tester) async {
      final download = _PendingDownloader();
      await mount(tester, local: false, downloader: download);
      await click(tester, modifier: LogicalKeyboardKey.metaLeft);
      await tester.pumpWidget(const SizedBox());
      expect(download.cancellation!.isCancelled, isTrue);
      download.result.complete('/cache/downloaded.png');
      await tester.pump();
      expect(launched, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );
  testOnPlatform(
    'replacing the session cancels its preview without opening the old file',
    (tester) async {
      final download = _PendingDownloader();
      await mount(tester, local: false, downloader: download);
      await click(tester, modifier: LogicalKeyboardKey.metaLeft);
      final previous = tester.widget<TerminalPanel>(find.byType(TerminalPanel));
      final panelState = tester.state(find.byType(TerminalPanel));
      final replacement = TerminalSession(
        machineId: 'm1',
        agentId: 'a2',
        agentName: 'a2',
        engineId: 'codex',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      )..status = TerminalSessionStatus.controlling;
      addTearDown(replacement.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TerminalPanel(
              notifier: notifier,
              session: replacement,
              focused: true,
              mediaDownloader: download,
              linkOpener: previous.linkOpener,
            ),
          ),
        ),
      );
      expect(tester.state(find.byType(TerminalPanel)), same(panelState));
      expect(download.cancellation!.isCancelled, isTrue);
      expect(find.textContaining('Downloading'), findsNothing);
      download.result.complete('/cache/downloaded.png');
      await tester.pump();
      expect(launched, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );
  testOnPlatform(
    'a failed remote download clears progress and explains the failure',
    (tester) async {
      final download = _PendingDownloader();
      await mount(tester, local: false, downloader: download);
      await click(tester, modifier: LogicalKeyboardKey.metaLeft);
      download.result.completeError(
        const RemoteMediaException('The remote machine disconnected.'),
      );
      await tester.pump();
      expect(find.text('The remote machine disconnected.'), findsOneWidget);
      expect(find.textContaining('Downloading'), findsNothing);
      expect(launched, isEmpty);
    },
  );
  testOnPlatform('drag selection does not open media', (tester) async {
    await mount(tester);
    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.metaLeft,
      platform: 'macos',
    );
    await tester.dragFrom(
      point(tester),
      const Offset(100, 0),
      kind: PointerDeviceKind.mouse,
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft, platform: 'macos');
    await tester.pump(const Duration(milliseconds: 350));
    expect(launched, isEmpty);
    final view = tester.widget<TerminalView>(find.byType(TerminalView));
    expect(view.controller!.selection, isNotNull);
  });
  testOnPlatform(
    'hover shows the shortcut and refreshes after streamed output changes',
    (tester) async {
      await mount(tester);
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(point(tester));
      await tester.pump();
      await tester.sendKeyDownEvent(
        LogicalKeyboardKey.metaLeft,
        platform: 'macos',
      );
      await tester.pump();
      expect(
        tester.widget<TerminalView>(find.byType(TerminalView)).mouseCursor,
        SystemMouseCursors.click,
      );
      session.terminal.write('\r\x1b[2KWorking...');
      await tester.pump();
      await tester.pump();
      expect(
        tester.widget<TerminalView>(find.byType(TerminalView)).mouseCursor,
        SystemMouseCursors.text,
      );
      await tester.sendKeyUpEvent(
        LogicalKeyboardKey.metaLeft,
        platform: 'macos',
      );
      await mouse.removePointer();
      await tester.pump(const Duration(milliseconds: 350));
    },
  );
}
