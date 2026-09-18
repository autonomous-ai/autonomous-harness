import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/shared/widgets/app_choice_picker.dart';
import 'package:harness/shared/widgets/app_select_field.dart';

import 'support/agent_picker.dart';

class _App extends AppNotifier {
  _App() : super(config: AppConfig.dev, authSession: AuthSession()) {
    for (final id in ['local', 'remote']) {
      machineStates[id] =
          MachineState(
              Machine(
                machineId: id,
                name: id,
                authMode: MachineAuthMode.remote,
              ),
            )
            ..localOnly = id == 'local'
            ..nodeOnline = true
            ..agents = [
              for (final name in ['alpha', 'beta'])
                Agent(
                  id: '$id-$name',
                  name: name,
                  project: AgentProject(name: name, cwd: '/$id/$name'),
                ),
            ];
    }
  }
  final calls = <Map<String, Object?>>[];
  final previews = <String>[];
  final pending = <String, Completer<Map<String, dynamic>>>{};
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async => {'profiles': []};
  @override
  Future<Map<String, dynamic>> readProjectPreview(
    String machineId,
    String path,
  ) async {
    previews.add('$machineId:$path');
    return pending[path]?.future ??
        Future.value({'readme': 'README for $path', 'branch': 'main'});
  }

  @override
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String? folder,
    ProjectFolderRequest? projectFolder,
    bool bypassPermission = false,
    String? permissionMode,
    String? codexHome,
    String? swarmId,
    PaneSplitRequest? split,
    String? dsh,
    String? prompt,
    String? name,
    String? agent,
    AgentCreationAttempt? attempt,
  }) async {
    calls.add({
      'machine': machineId,
      'engine': engine,
      'folder': folder,
      'project': projectFolder?.payload,
    });
    return null;
  }
}

void main() {
  late _App app;
  Future<void> mount(WidgetTester tester, {String? rememberedProject}) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 1000);
    addTearDown(tester.view.reset);
    app = _App();
    if (rememberedProject != null) {
      await app.projectHistory.select('local', rememberedProject);
    }
    await app.agentPreference.select('claude');
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () =>
                  showNewAgentDialog(context, app, 'local', source: 'test'),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
  }

  Future<void> recent(WidgetTester tester, String name) async {
    final button = find.byKey(const Key('new-agent-project-recent'));
    await tester.ensureVisible(button);
    await tester.tap(button);
    await tester.pumpAndSettle();
    await tester.tap(find.text(name).last);
    await tester.pumpAndSettle();
  }

  Future<void> git(WidgetTester tester) async {
    final button = find.byKey(const Key('new-agent-project-git'));
    await tester.ensureVisible(button);
    await tester.tap(button);
    await tester.pumpAndSettle();
  }

  testWidgets('every new dialog starts with New and leaves history in Recent', (
    tester,
  ) async {
    await mount(tester, rememberedProject: '/local/remembered');
    final newProject = find.byKey(const Key('new-agent-folder-newProject'));
    final recentProject = find.byKey(const Key('new-agent-project-recent'));
    expect(tester.widget<AppChoiceTile>(newProject).selected, isTrue);
    expect(
      tester.widget<AppSelectField<String>>(recentProject).selected,
      isFalse,
    );
    expect(find.text('remembered'), findsNothing);
    await recent(tester, 'remembered');
    expect(tester.widget<AppChoiceTile>(newProject).selected, isFalse);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(tester.widget<AppChoiceTile>(newProject).selected, isTrue);
    expect(
      tester.widget<AppSelectField<String>>(recentProject).selected,
      isFalse,
    );
    await tester.tap(recentProject);
    await tester.pumpAndSettle();
    expect(find.text('remembered'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('create-agent-submit')));
    await tester.pumpAndSettle();
    expect(app.calls.single['project'], {'projectSource': 'new'});
  });

  testWidgets('recent projects support type-select and keyboard selection', (
    tester,
  ) async {
    await mount(tester);
    await tester.tap(find.byKey(const Key('new-agent-project-recent')));
    await tester.sendKeyEvent(LogicalKeyboardKey.keyA, character: 'a');
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('alpha'), findsOneWidget);
    expect(find.text('/local/alpha'), findsNothing);
    expect(app.calls, isEmpty);
    expect(app.previews, isEmpty);
    await tester.tap(find.byKey(const Key('new-agent-project-recent')));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('alpha'), findsOneWidget);
    expect(find.text('/local/alpha'), findsNothing);
  });

  testWidgets(
    'engine switching keeps the project and each machine restores its choice',
    (tester) async {
      await mount(tester);
      await recent(tester, 'alpha');
      await chooseAgent(tester, 'opencode');
      await tester.pumpAndSettle();
      expect(find.text('alpha'), findsOneWidget);
      expect(find.text('/local/alpha'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('new-agent-machine-remote')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('new-agent-project-recent')));
      await tester.pumpAndSettle();
      expect(find.text('/local/alpha'), findsNothing);
      await tester.tap(find.text('beta'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('new-agent-machine-local')));
      await tester.pumpAndSettle();
      expect(find.text('alpha'), findsOneWidget);
      expect(find.text('/local/alpha'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('new-agent-machine-remote')));
      await tester.pumpAndSettle();
      expect(find.text('beta'), findsOneWidget);
      await tester.tap(find.byKey(const Key('create-agent-submit')));
      await tester.pumpAndSettle();
      expect(app.calls.single, containsPair('folder', '/remote/beta'));
      expect(app.calls.single, containsPair('machine', 'remote'));
      expect(app.calls.single, containsPair('engine', 'opencode'));
    },
  );

  testWidgets(
    'Git validates in a separate dialog and preserves the chosen repository',
    (tester) async {
      await mount(tester);
      await git(tester);
      final field = find.byKey(const Key('new-agent-git-url'));
      await tester.enterText(field, 'not a repository');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(
        find.text('Enter a GitHub URL or owner/repository.'),
        findsOneWidget,
      );
      expect(app.calls, isEmpty);
      await tester.enterText(field, 'owner/repo');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(find.text('repo'), findsOneWidget);
      await git(tester);
      expect(
        tester.widget<TextField>(field).controller!.text,
        'https://github.com/owner/repo.git',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('new-agent-machine-remote')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('new-agent-machine-local')));
      await tester.pumpAndSettle();
      expect(find.text('repo'), findsOneWidget);
      await tester.tap(find.byKey(const Key('create-agent-submit')));
      await tester.pumpAndSettle();
      expect(app.calls.single['project'], {
        'projectSource': 'remote',
        'repositoryUrl': 'https://github.com/owner/repo.git',
      });
    },
  );

  testWidgets(
    'dismissing Git keeps the project; New clears it without creating a folder',
    (tester) async {
      await mount(tester);
      await recent(tester, 'alpha');
      await git(tester);
      await tester.enterText(
        find.byKey(const Key('new-agent-git-url')),
        'owner/cancelled',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.text('alpha'), findsOneWidget);
      expect(find.text('/local/alpha'), findsNothing);
      await tester.tap(find.byKey(const Key('new-agent-folder-newProject')));
      await tester.pumpAndSettle();
      expect(find.text('alpha'), findsNothing);
      expect(app.calls, isEmpty);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pumpAndSettle();
      expect(app.calls.single['project'], {'projectSource': 'new'});
    },
  );

  testWidgets('keyboard focus never looks like a second project selection', (
    tester,
  ) async {
    await mount(tester);
    await recent(tester, 'alpha');
    final newTile = find.byKey(const Key('new-agent-folder-newProject'));
    final newButton = find.descendant(
      of: newTile,
      matching: find.byType(TextButton),
    );
    tester.widget<TextButton>(newButton).focusNode!.requestFocus();
    await tester.pumpAndSettle();
    expect(tester.widget<AppChoiceTile>(newTile).selected, isFalse);
    expect(
      tester.widget<TextButton>(newButton).style!.side!.resolve({
        WidgetState.focused,
      })!.color,
      Colors.transparent,
    );
    final recentTile = find.byKey(const Key('new-agent-project-recent'));
    expect(tester.widget<AppSelectField<String>>(recentTile).selected, isTrue);
    await tester.tap(newTile);
    await tester.pumpAndSettle();
    expect(tester.widget<AppChoiceTile>(newTile).selected, isTrue);
    expect(tester.widget<AppSelectField<String>>(recentTile).selected, isFalse);
    final trigger = find
        .descendant(of: recentTile, matching: find.byType(InkWell))
        .first;
    tester.widget<InkWell>(trigger).focusNode!.requestFocus();
    await tester.pumpAndSettle();
    final container = tester.widget<AnimatedContainer>(
      find
          .descendant(of: recentTile, matching: find.byType(AnimatedContainer))
          .first,
    );
    expect(
      ((container.decoration! as BoxDecoration).border! as Border).top.color,
      Colors.transparent,
    );
  });

  testWidgets('empty Recent is clear and Escape returns to the form', (
    tester,
  ) async {
    await mount(tester);
    app.machineStates['local']!.agents = [];
    app.notifyListeners();
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('new-agent-project-recent')));
    await tester.pumpAndSettle();
    expect(find.text('No recent projects'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('No recent projects'), findsNothing);
    expect(find.byKey(const ValueKey('create-agent-submit')), findsOneWidget);
    expect(app.calls, isEmpty);
  });
}
