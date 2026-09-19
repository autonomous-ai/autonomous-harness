import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/widgets/remote_folder_picker.dart';

import 'support/agent_picker.dart';

class _Folders extends AppNotifier {
  _Folders()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    machineStates['remote'] = MachineState(
      const Machine(
        machineId: 'remote',
        name: 'Studio Mac',
        authMode: MachineAuthMode.remote,
      ),
    );
  }

  final requests =
      <
        ({String machine, String? path, Completer<Map<String, dynamic>> reply})
      >[];

  final launches = <({String machine, String engine, String folder})>[];

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  @override
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String? folder,
    ProjectFolderRequest? projectFolder,
    bool bypassPermission = false,
    String? permissionMode,
    String? codexHome,
    String? dsh,
    String? prompt,
    String? name,
    String? agent,
    String? swarmId,
    PaneSplitRequest? split,
    AgentCreationAttempt? attempt,
  }) async {
    launches.add((machine: machineId, engine: engine, folder: folder!));
    return null;
  }

  @override
  Future<Map<String, dynamic>> listRemoteFolder(
    String machineId,
    String? path,
  ) {
    final reply = Completer<Map<String, dynamic>>();
    requests.add((machine: machineId, path: path, reply: reply));
    return reply.future;
  }
}

Map<String, dynamic> _listing(String path, [List<String> names = const []]) => {
  'path': path,
  'entries': [
    for (final name in names) {'name': name, 'isDir': true},
  ],
};

Future<void> _open(
  WidgetTester tester,
  _Folders app, {
  ValueChanged<String?>? onResult,
  TargetPlatform platform = TargetPlatform.macOS,
  double textScale = 1,
}) async {
  addTearDown(app.dispose);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid
          .buildAppTheme(brightness: Brightness.dark)
          .copyWith(platform: platform),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () async {
              final result = await showRemoteFolderPicker(
                context,
                notifier: app,
                machineId: 'remote',
              );
              onResult?.call(result);
            },
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 200));
}

void main() {
  testWidgets('cannot select the old folder while opening another folder', (
    tester,
  ) async {
    final app = _Folders();
    String? selected;
    await _open(tester, app, onResult: (value) => selected = value);
    app.requests.single.reply.complete(_listing('/home/dev', ['code']));
    await tester.pumpAndSettle();
    await tester.tap(find.text('code'));
    await tester.pump();
    expect(app.requests.last.path, '/home/dev/code');
    final select = find.widgetWithText(FilledButton, 'Select this folder');
    expect(tester.widget<FilledButton>(select).onPressed, isNull);
    expect(selected, isNull);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    expect(
      app.requests,
      hasLength(2),
      reason: 'Up cannot use the old folder while another is loading.',
    );
    app.requests.last.reply.complete(_listing('/home/dev/code'));
    await tester.pumpAndSettle();
    await tester.tap(select);
    await tester.pumpAndSettle();
    expect(selected, '/home/dev/code');
  });

  testWidgets('a newer path wins over an older reply and stays editable', (
    tester,
  ) async {
    final app = _Folders();
    String? selected;
    await _open(tester, app, onResult: (value) => selected = value);
    final input = find.byKey(const Key('remote-folder-path'));
    await tester.enterText(input, '/home/dev/new-project');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(app.requests.map((request) => request.path), [
      null,
      '/home/dev/new-project',
    ]);
    expect(
      app.requests.every((request) => request.machine == 'remote'),
      isTrue,
    );
    app.requests.last.reply.complete(
      _listing('/home/dev/new-project', ['src']),
    );
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
    app.requests.first.reply.complete(_listing('/home/dev', ['old']));
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(input).controller!.text,
      '/home/dev/new-project',
    );
    expect(find.text('src'), findsOneWidget);
    expect(find.text('old'), findsNothing);
    await tester.tap(find.text('Select this folder'));
    await tester.pumpAndSettle();
    expect(selected, '/home/dev/new-project');
  });

  testWidgets(
    'a late reply preserves a path draft, selection and composition',
    (tester) async {
      final app = _Folders();
      await _open(tester, app);
      final input = find.byKey(const Key('remote-folder-path'));
      const draft = TextEditingValue(
        text: '/home/dev/日本語',
        selection: TextSelection.collapsed(offset: 13),
        composing: TextRange(start: 10, end: 13),
      );
      tester.testTextInput.updateEditingValue(draft);
      await tester.pump();
      app.requests.single.reply.complete(_listing('/home/dev', ['code']));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(input).controller!.value, draft);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Select this folder'),
            )
            .onPressed,
        isNull,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
      expect(app.requests, hasLength(1));
    },
  );

  testWidgets(
    'failed browsing preserves the last folder and retries in place',
    (tester) async {
      final app = _Folders();
      await _open(tester, app);
      app.requests.single.reply.complete(
        _listing('/home/dev', ['code', 'notes']),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('code'));
      await tester.pump();
      app.requests.last.reply.complete({'error': 'PERMISSION_DENIED'});
      await tester.pumpAndSettle();
      expect(find.text('notes'), findsOneWidget);
      expect(find.text('Showing /home/dev'), findsOneWidget);
      expect(
        find.text('You don’t have permission to open this folder.'),
        findsOneWidget,
      );
      final input = tester.widget<TextField>(
        find.byKey(const Key('remote-folder-path')),
      );
      expect(input.controller!.text, '/home/dev/code');
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Select this folder'),
            )
            .onPressed,
        isNull,
      );
      await tester.tap(find.text('Retry'));
      await tester.tap(find.text('Retry'));
      await tester.pump();
      expect(app.requests.map((request) => request.path), [
        null,
        '/home/dev/code',
        '/home/dev/code',
      ]);
      app.requests.last.reply.complete(_listing('/home/dev/code', ['project']));
      await tester.pumpAndSettle();
      expect(find.text('project'), findsOneWidget);
      expect(find.text('Retry'), findsNothing);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Select this folder'),
            )
            .onPressed,
        isNotNull,
      );
    },
  );

  for (final platform in [TargetPlatform.macOS, TargetPlatform.linux]) {
    testWidgets(
      'keyboard path, long-list browsing and selection on $platform',
      (tester) async {
        final app = _Folders();
        String? selected;
        await _open(
          tester,
          app,
          platform: platform,
          onResult: (value) => selected = value,
        );
        final entries = [for (var i = 0; i < 60; i++) 'project-$i'];
        app.requests.single.reply.complete(_listing('/home/dev', entries));
        await tester.pumpAndSettle();
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pump();
        expect(
          FocusManager.instance.primaryFocus!.debugLabel,
          'Remote folders',
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.end);
        await tester.pump();
        expect(find.text('project-59').hitTestable(), findsOneWidget);
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(app.requests.last.path, '/home/dev/project-58');
        app.requests.last.reply.complete(
          _listing('/home/dev/project-58', ['src']),
        );
        await tester.pumpAndSettle();
        expect(
          FocusManager.instance.primaryFocus!.debugLabel,
          'Remote folders',
        );
        await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
        await tester.pump();
        expect(app.requests.last.path, '/home/dev');
        app.requests.last.reply.complete(_listing('/home/dev', entries));
        await tester.pumpAndSettle();
        expect(find.text('project-58').hitTestable(), findsOneWidget);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(app.requests.last.path, '/home/dev/project-58');
        app.requests.last.reply.complete(_listing('/home/dev/project-58'));
        await tester.pumpAndSettle();
        final modifier = platform == TargetPlatform.macOS
            ? LogicalKeyboardKey.metaLeft
            : LogicalKeyboardKey.controlLeft;
        await tester.sendKeyDownEvent(modifier);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.sendKeyUpEvent(modifier);
        await tester.pumpAndSettle();
        expect(selected, '/home/dev/project-58');
      },
    );
  }

  testWidgets(
    'home recovers an initial failure; cancelling ignores late replies',
    (tester) async {
      final app = _Folders();
      var returned = false;
      String? selected;
      await _open(
        tester,
        app,
        onResult: (value) {
          returned = true;
          selected = value;
        },
      );
      app.requests.single.reply.complete({'error': 'UNREACHABLE'});
      await tester.pumpAndSettle();
      expect(
        find.text(
          'Couldn’t reach this machine. Check its connection and retry.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('remote-folder-home')));
      await tester.pump();
      expect(app.requests.last.path, isNull);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      app.requests.last.reply.complete(_listing('/home/dev', ['code']));
      await tester.pumpAndSettle();
      expect(returned, isTrue);
      expect(selected, isNull);
      expect(find.byType(AlertDialog), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'remote selection returns to New Harness without launching or losing choices',
    (tester) async {
      final app = _Folders();
      addTearDown(app.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid
              .buildAppTheme(brightness: Brightness.dark)
              .copyWith(platform: TargetPlatform.macOS),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => showNewAgentDialog(
                  context,
                  app,
                  'remote',
                  source: 'test',
                  initialFolder: '/home/dev/old',
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      await chooseAgent(tester, 'codex');
      await tester.ensureVisible(
        find.byKey(const Key('new-agent-project-browse')),
      );
      await tester.tap(find.byKey(const Key('new-agent-project-browse')));
      await tester.pump();
      app.requests.single.reply.complete(_listing('/home/dev/old'));
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('old'), findsOneWidget);
      expect(app.launches, isEmpty);
      await tester.ensureVisible(
        find.byKey(const Key('new-agent-project-browse')),
      );
      await tester.tap(find.byKey(const Key('new-agent-project-browse')));
      await tester.pump();
      app.requests.last.reply.complete(_listing('/home/dev/old'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('remote-folder-path')),
        '/home/dev/target',
      );
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      app.requests.last.reply.complete(_listing('/home/dev/target'));
      await tester.pumpAndSettle();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text('target'), findsOneWidget);
      expect(find.text('/home/dev/target'), findsNothing);
      expect(app.launches, isEmpty);
      await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
      await tester.pumpAndSettle();
      expect(app.launches, [
        (machine: 'remote', engine: 'codex', folder: '/home/dev/target'),
      ]);
      expect(find.byType(AlertDialog), findsNothing);
    },
  );

  testWidgets('large text keeps actions reachable at the minimum window size', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(880, 560);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final app = _Folders();
    await _open(tester, app, textScale: 2);
    app.requests.single.reply.complete(_listing('/home/dev', ['code']));
    await tester.pumpAndSettle();
    expect(find.text('Select this folder').hitTestable(), findsOneWidget);
    final input = find.byKey(const Key('remote-folder-path'));
    await tester.ensureVisible(input);
    await tester.enterText(input, '/home/dev/missing');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    app.requests.last.reply.complete({'error': 'NOT_FOUND'});
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Retry'));
    await tester.tap(find.text('Retry'));
    await tester.pump();
    app.requests.last.reply.complete(_listing('/home/dev/missing'));
    await tester.pumpAndSettle();
    expect(find.text('Select this folder').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
