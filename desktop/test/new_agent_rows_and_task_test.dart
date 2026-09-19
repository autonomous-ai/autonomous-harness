// New Harness, as a person reads and uses it: each agent row names the agent,
// whose it is and what it is in its own words — whichever of the machine's
// catalog and this build knows it — the search finds an agent by any of those,
// and the first task is sent exactly as typed, or not at all.
import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/shared/widgets/app_icon_button.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/widgets/search_result_text.dart';

import 'support/agent_picker.dart';

class _Folders extends FileSelectorPlatform {
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) async => '/work/lamp';
}

/// The machine's catalog as a daemon that forwards taglines sends it, with
/// each way a row can fall back.
const _catalog = [
  // An older daemon: no tagline and no author, so this build's words.
  DshEntry(
    id: 'autonomous/mujoco',
    name: 'MuJoCo',
    engine: 'claude',
    category: 'Simulation',
    installed: true,
  ),
  // The catalog's words win over this build's, trimmed.
  DshEntry(
    id: 'autonomous/typst',
    name: 'Typst',
    engine: 'claude',
    category: 'Documents',
    author: 'Typst GmbH',
    tagline: '  Typesetting, as the catalog says it  ',
    installed: true,
  ),
  // A blank tagline and no face in this build: its domain.
  DshEntry(
    id: 'someone/earth',
    name: 'Google Earth Engine',
    engine: 'codex',
    category: 'Robotics',
    author: 'Earth Team',
    tagline: '   ',
    installed: true,
  ),
  // No tagline and no domain: its description. No author: no byline.
  DshEntry(
    id: 'someone/maps',
    name: 'Maps',
    engine: 'codex',
    description: 'Works with Google Maps.',
    installed: true,
  ),
  // Nothing to say at all.
  DshEntry(id: 'someone/bare', name: 'Bare', engine: 'codex', installed: true),
  // Not installed, with a name long enough to test the busy label.
  DshEntry(
    id: 'someone/long',
    name: 'An Extraordinarily Long Harness Name That Keeps Going Well Past The Button',
    engine: 'codex',
  ),
];

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final prompts = <String?>[];

  /// When set, a create waits for it: the dialog stays mid-create.
  Completer<String?>? pendingCreate;

  /// When set, an install waits for it.
  Completer<String?>? pendingInstall;

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {}

  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async => {'profiles': <dynamic>[]};

  @override
  Future<String?> installDsh(String machineId, String id) =>
      pendingInstall?.future ?? Future.value(null);

  @override
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String? folder,
    bool bypassPermission = false,
    String? permissionMode,
    String? codexHome,
    String? dsh,
    String? prompt,
    String? name,
    String? agent,
    ProjectFolderRequest? projectFolder,
    String? swarmId,
    PaneSplitRequest? split,
    AgentCreationAttempt? attempt,
  }) async {
    prompts.add(prompt);
    return pendingCreate?.future ?? 'Test launch refused.';
  }
}

final _task = find.byKey(const ValueKey('new-agent-task'));
final _clear = find.byKey(const ValueKey('new-agent-task-clear'));
final _submit = find.byKey(const ValueKey('create-agent-submit'));

Future<_App> _open(
  WidgetTester tester, {
  bool catalogLoaded = true,
  Size size = const Size(1400, 1000),
  String? initialPrompt,
}) async {
  FileSelectorPlatform.instance = _Folders();
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final app = _App();
  addTearDown(app.dispose);
  const machine = Machine(
    machineId: 'machine-1',
    authMode: MachineAuthMode.remote,
    name: 'studio',
  );
  final state = MachineState(machine)..localOnly = true;
  state.engines.replace(const [
    EngineAvailability(engine: 'claude', installed: true),
    EngineAvailability(engine: 'codex', installed: true),
    EngineAvailability(engine: 'cursor', installed: true),
  ]);
  if (catalogLoaded) state.dsh.replace(_catalog);
  app.machineStates['machine-1'] = state;
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () => showNewAgentDialog(
              context,
              app,
              'machine-1',
              source: 'test',
              initialPrompt: initialPrompt,
            ),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return app;
}

Future<void> _search(WidgetTester tester, String query) async {
  if (agentSearch.evaluate().isEmpty) await openAgentSearch(tester);
  await tester.enterText(agentSearch, query);
  await tester.pump();
}

Future<void> _pickFolder(WidgetTester tester) async {
  final newProject = find.byKey(const ValueKey('new-agent-folder-newProject'));
  await tester.ensureVisible(newProject);
  await tester.tap(newProject);
  await tester.pumpAndSettle();
}

Future<void> _create(WidgetTester tester) async {
  await tester.ensureVisible(_submit);
  await tester.tap(_submit);
  await tester.pump();
}

Finder _row(String id) => find.byKey(ValueKey('new-agent-agent-row-$id'));

/// The row's byline and the line under its name, as drawn.
({String? by, String? line}) _read(WidgetTester tester, String id) {
  final by = find.byKey(ValueKey('new-agent-agent-row-by-$id'));
  final subtitle = tester.widget<ListTile>(_row(id)).subtitle;
  return (
    by: by.evaluate().isEmpty ? null : tester.widget<Text>(by).data,
    line: subtitle is SearchResultText ? subtitle.text : null,
  );
}

void main() {
  group('agent rows: the name, whose it is, and what it is', () {
    testWidgets('the catalog first, then this build, then domain, then '
        'description', (tester) async {
      await _open(tester);

      await _search(tester, 'mujoco');
      expect(_read(tester, 'autonomous/mujoco'), (
        by: 'by Google DeepMind',
        line: 'Advanced physics simulation',
      ), reason: 'an older daemon sends neither: this build knows both');

      await _search(tester, 'typst');
      expect(_read(tester, 'autonomous/typst'), (
        by: 'by Typst GmbH',
        line: 'Typesetting, as the catalog says it',
      ), reason: 'the catalog wins over this build, trimmed');

      await _search(tester, 'earth');
      expect(_read(tester, 'someone/earth'), (
        by: 'by Earth Team',
        line: 'Robotics',
      ), reason: 'a blank tagline is no tagline: the domain says it');

      await _search(tester, 'maps');
      expect(
        _read(tester, 'someone/maps'),
        (by: null, line: 'Works with Google Maps.'),
        reason:
            'nothing else: the description, and no byline without an author',
      );

      await _search(tester, 'bare');
      expect(_read(tester, 'someone/bare'), (by: null, line: null));

      await _search(tester, 'claude');
      expect(_read(tester, 'claude'), (
        by: 'by Anthropic',
        line: 'Work with Claude directly in your codebase',
      ), reason: 'the engines read the same way');
      expect(tester.takeException(), isNull);
    });

    testWidgets('before the machine answers, the harnesses read in this '
        "build's words", (tester) async {
      await _open(tester, catalogLoaded: false);
      await _search(tester, 'yosys');
      expect(_read(tester, 'autonomous/yosys'), (
        by: 'by YosysHQ',
        line: 'Framework for Verilog RTL synthesis',
      ));
      await _search(tester, 'godogen');
      expect(
        find.byKey(const ValueKey('new-agent-agent-row-autonomous/godogen')),
        findsNothing,
        reason: 'a harness this build has no face for waits for the machine',
      );
    });

    testWidgets('the search finds an agent by whose it is, its Store shelf '
        'and its domain, name matches first', (tester) async {
      await _open(tester);

      // A name, then an author, then the line under a name.
      // Among equals a harness before an engine: MuJoCo, then Antigravity,
      // both by Google.
      await _search(tester, 'google');
      expect(agentRows(tester), [
        'someone/earth',
        'autonomous/mujoco',
        'agy',
        'someone/maps',
      ]);

      // The Store's shelf: Simulation is on Science.
      await _search(tester, 'science');
      expect(agentRows(tester), contains('autonomous/mujoco'));
      // The domain itself, where no line under a name says it.
      await _search(tester, 'documents');
      expect(agentRows(tester), ['autonomous/typst']);
      // An unknown domain is on the Store's Other shelf.
      await _search(tester, 'other');
      expect(agentRows(tester), contains('someone/earth'));
      // An author the row draws.
      await _search(tester, 'gmbh');
      expect(agentRows(tester), ['autonomous/typst']);
    });

    testWidgets('the preview names whose it is and what it is', (tester) async {
      await _open(tester);
      await _search(tester, 'deepmind');
      expect(agentRows(tester), ['autonomous/mujoco']);
      final preview = find.byKey(const ValueKey('new-agent-agent-preview'));
      expect(preview, findsOneWidget);
      expect(
        find.descendant(
          of: preview,
          matching: find.textContaining('by Google DeepMind'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: preview,
          matching: find.text('Advanced physics simulation'),
        ),
        findsOneWidget,
      );

      // A harness with no author shows its name alone.
      await _search(tester, 'bare');
      expect(
        find.descendant(of: preview, matching: find.textContaining('by ')),
        findsNothing,
      );
    });
  });

  group('the first task', () {
    testWidgets('opens empty, with its hint and nothing to clear', (
      tester,
    ) async {
      await _open(tester);
      expect(tester.widget<TextField>(_task).controller!.text, isEmpty);
      expect(find.text('Tell your agent what to do first.'), findsOneWidget);
      expect(_clear, findsNothing);
      expect(
        find.text('First task. What should your agent work on? (Optional)'),
        findsOneWidget,
      );
    });

    testWidgets('is sent as typed, trimmed at its ends', (tester) async {
      final app = await _open(tester);
      await _pickFolder(tester);
      await tester.ensureVisible(_task);
      await tester.enterText(
        _task,
        '  Fix the failing tests.\n\n  Then push. \n',
      );
      await tester.pump();
      expect(_clear, findsOneWidget);
      await _create(tester);
      expect(app.prompts, ['Fix the failing tests.\n\n  Then push.']);
    });

    testWidgets('only spaces and new lines sends nothing', (tester) async {
      final app = await _open(tester);
      await _pickFolder(tester);
      await tester.ensureVisible(_task);
      await tester.enterText(_task, '  \n\t \n ');
      await tester.pump();
      await _create(tester);
      expect(app.prompts, [null]);
    });

    testWidgets('a prompt of only spaces opens an empty task', (tester) async {
      final app = await _open(tester, initialPrompt: '   \n ');
      expect(tester.widget<TextField>(_task).controller!.text, isEmpty);
      expect(_clear, findsNothing);
      await _pickFolder(tester);
      await _create(tester);
      expect(app.prompts, [null]);
    });

    testWidgets('an agent that cannot take one says so, keeps what was typed '
        'and sends nothing', (tester) async {
      final app = await _open(tester, initialPrompt: 'Draw a desk lamp');
      await _pickFolder(tester);
      await chooseAgent(tester, 'cursor');
      await tester.pumpAndSettle();
      expect(
        find.text(
          'First task. Cursor starts without one. Tell it once it opens.',
        ),
        findsOneWidget,
      );
      final field = tester.widget<TextField>(_task);
      expect(field.enabled, isFalse);
      expect(field.controller!.text, 'Draw a desk lamp');
      expect(_clear, findsNothing, reason: 'a disabled field offers no clicks');
      await _create(tester);
      expect(app.prompts, [null]);

      // Back on an agent that takes one: the same words, sent.
      await tester.pumpAndSettle();
      await chooseAgent(tester, 'claude');
      await tester.pumpAndSettle();
      expect(
        find.text('First task. What should your agent work on? (Optional)'),
        findsOneWidget,
      );
      expect(tester.widget<TextField>(_task).enabled, isTrue);
      await _create(tester);
      expect(app.prompts, [null, 'Draw a desk lamp']);
    });

    testWidgets('longer than a machine takes holds Create and says by how '
        'much, counted as the machine counts', (tester) async {
      final app = await _open(tester);
      await _pickFolder(tester);
      await chooseAgent(tester, 'claude');
      await tester.pumpAndSettle();
      bool createEnabled() =>
          tester.widget<ButtonStyleButton>(_submit).onPressed != null;
      expect(createEnabled(), isTrue);

      await tester.ensureVisible(_task);
      await tester.enterText(_task, 'x' * 2001);
      await tester.pump();
      expect(
        find.text(
          'A first task can be up to 2000 characters. This one is 2001.',
        ),
        findsOneWidget,
      );
      expect(createEnabled(), isFalse);
      // Neither the button nor the keyboard creates.
      await tester.tap(_task);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pump();
      expect(app.prompts, isEmpty);

      // The machine counts after trimming, and so does this.
      await tester.enterText(_task, '  ${'x' * 2000}\n ');
      await tester.pump();
      expect(find.textContaining('A first task can be up to'), findsNothing);
      expect(createEnabled(), isTrue);
      await _create(tester);
      expect(app.prompts, ['x' * 2000]);
      await tester.pumpAndSettle();

      // On an agent that cannot take a task at all, its length holds nothing.
      await tester.enterText(_task, 'x' * 2500);
      await tester.pump();
      expect(createEnabled(), isFalse);
      await chooseAgent(tester, 'cursor');
      await tester.pumpAndSettle();
      expect(find.textContaining('A first task can be up to'), findsNothing);
      expect(createEnabled(), isTrue);
      await _create(tester);
      expect(app.prompts, ['x' * 2000, null]);
      expect(tester.takeException(), isNull);
    });

    testWidgets('is locked while the harness is being created, and '
        'unlocked when that fails', (tester) async {
      final app = await _open(tester, initialPrompt: 'Draw a desk lamp');
      app.pendingCreate = Completer<String?>();
      await _pickFolder(tester);
      await _create(tester);
      expect(app.prompts, ['Draw a desk lamp']);

      bool excluded() => tester
          .widgetList<ExcludeFocus>(
            find.ancestor(of: _task, matching: find.byType(ExcludeFocus)),
          )
          .any((exclude) => exclude.excluding);
      bool absorbed() => tester
          .widgetList<AbsorbPointer>(
            find.ancestor(of: _task, matching: find.byType(AbsorbPointer)),
          )
          .any((absorb) => absorb.absorbing);
      AppIconButton clearButton() => tester.widget<AppIconButton>(_clear);

      expect(excluded(), isTrue, reason: 'Tab cannot reach it mid-create');
      expect(absorbed(), isTrue, reason: 'a click cannot reach it either');
      expect(clearButton().onPressed, isNull);

      app.pendingCreate!.complete('The machine refused.');
      await tester.pumpAndSettle();
      expect(excluded(), isFalse);
      expect(absorbed(), isFalse);
      expect(clearButton().onPressed, isNotNull);
      await tester.tap(_clear);
      await tester.pump();
      expect(tester.widget<TextField>(_task).controller!.text, isEmpty);
    });
  });

  testWidgets('the busy label ends in an ellipsis at 900 wide rather than '
      'pushing the button out of the footer', (tester) async {
    final app = await _open(tester, size: const Size(900, 720));
    app.pendingInstall = Completer<String?>();
    await chooseAgent(tester, 'someone/long');
    await _pickFolder(tester);
    await _create(tester);
    await tester.pump();
    final label = find.descendant(
      of: _submit,
      matching: find.textContaining('Installing An Extraordinarily Long'),
    );
    expect(label, findsOneWidget);
    expect(tester.widget<Text>(label).overflow, TextOverflow.ellipsis);
    expect(tester.widget<Text>(label).maxLines, 1);
    expect(tester.takeException(), isNull, reason: 'no overflow');
    final dialog = tester.getRect(find.byType(Dialog));
    expect(tester.getRect(_submit).right, lessThanOrEqualTo(dialog.right));
    app.pendingInstall!.complete('Install refused.');
    await tester.pumpAndSettle();
  });
}
