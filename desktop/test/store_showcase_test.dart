// A store product page shows what a harness does: its examples one after another down the page, each
// a prompt, the picture of what came of it and "Try this prompt", which opens New Harness with that
// prompt as the first message.
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
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/store/store_showcase.dart';
import 'package:harness/widgets/new_agent_dialog.dart';

import 'swarm_state_test.dart' show createApp;

const _lamp = StoreExample(
  prompt: 'A desk lamp with a weighted base and an arm that folds flat.',
  image: 'https://example.com/lamp.jpg',
  caption: 'Desk lamp · 9 parts',
);
const _gear = StoreExample(
  prompt: 'A planetary gearbox, 5:1, printable without supports.',
  image: 'https://example.com/gear.jpg',
  caption: 'Gearbox · STEP',
);

const _blender = DshEntry(
  id: 'autonomous/blender',
  name: 'Blender',
  engine: 'claude',
  installed: true,
  category: '3D',
  tier: 2,
  examples: [_lamp, _gear],
);

class _Folders extends FileSelectorPlatform {
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) async => '/work/lamp';
}

class _Notifier extends AppNotifier {
  _Notifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final prompts = <String?>[];

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
    return 'Test launch refused.';
  }
}

Future<void> _pumpFlow(
  WidgetTester tester, {
  ValueChanged<String>? onTry,
  bool animate = false,
  List<StoreExample> examples = const [_lamp, _gear],
  Size size = const Size(1200, 900),
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: SingleChildScrollView(
          child: StoreExampleFlow(
            entry: _blender,
            examples: examples,
            onTry: onTry,
            animate: animate,
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  group('StoreExample', () {
    test('keeps a prompt, an https picture and a short caption', () {
      final example = StoreExample.fromJson({
        'prompt': '  A lamp  ',
        'image': 'https://example.com/lamp.jpg',
        'caption': 'x' * 200,
      })!;
      expect(example.prompt, 'A lamp');
      expect(example.image, 'https://example.com/lamp.jpg');
      expect(example.caption, hasLength(120));
    });

    test(
      'drops a picture that is not https, and an example with no prompt',
      () {
        expect(
          StoreExample.fromJson({
            'prompt': 'A lamp',
            'image': 'http://example.com/lamp.jpg',
          })!.image,
          isNull,
        );
        expect(
          StoreExample.fromJson({
            'prompt': 'A lamp',
            'image': 'file:///etc/passwd',
          })!.image,
          isNull,
        );
        expect(StoreExample.fromJson({'prompt': '  '}), isNull);
        expect(
          StoreExample.fromJson({'image': 'https://example.com/a.jpg'}),
          isNull,
        );
        expect(StoreExample.fromJson('A lamp'), isNull);
      },
    );

    test('a catalog row carries at most eight examples and skips bad ones', () {
      final entry = DshEntry.fromJson({
        'id': 'autonomous/blender',
        'name': 'Blender',
        'engine': 'claude',
        'examples': [
          {'prompt': 'One'},
          'nonsense',
          for (var i = 0; i < 10; i++) {'prompt': 'More $i'},
        ],
      })!;
      expect(entry.examples, hasLength(8));
      expect(entry.examples.first.prompt, 'One');
      expect(entry.examples[1].prompt, 'More 0');
    });
  });

  testWidgets('every example is on the page, in order, prompt over picture', (
    tester,
  ) async {
    await _pumpFlow(tester);
    expect(find.text('“${_lamp.prompt}”'), findsOneWidget);
    expect(find.text('“${_gear.prompt}”'), findsOneWidget);
    expect(find.text('01 / 02'), findsOneWidget);
    expect(find.text('02 / 02'), findsOneWidget);
    expect(find.text('Desk lamp · 9 parts'), findsOneWidget);
    expect(find.text('Gearbox · STEP'), findsOneWidget);
    final first = tester.getRect(
      find.byKey(const ValueKey('store-example-prompt:0')),
    );
    final picture = tester.getRect(
      find.byKey(const ValueKey('store-example-image:0')),
    );
    final second = tester.getRect(
      find.byKey(const ValueKey('store-example-prompt:1')),
    );
    expect(picture.top, greaterThan(first.bottom));
    expect(second.top, greaterThan(picture.bottom));
    expect(tester.takeException(), isNull);
  });

  testWidgets('an example with no picture is its prompt and its button', (
    tester,
  ) async {
    await _pumpFlow(
      tester,
      examples: const [StoreExample(prompt: 'Start a slide deck.')],
    );
    expect(find.text('“Start a slide deck.”'), findsOneWidget);
    expect(find.byKey(const ValueKey('store-try-prompt:0')), findsOneWidget);
    expect(find.byKey(const ValueKey('store-example-image:0')), findsNothing);
  });

  testWidgets('each Try hands over its own prompt', (tester) async {
    final tried = <String>[];
    await _pumpFlow(tester, onTry: tried.add, size: const Size(1200, 4000));
    await tester.tap(find.byKey(const ValueKey('store-try-prompt:1')));
    await tester.tap(find.byKey(const ValueKey('store-try-prompt:0')));
    expect(tried, [_gear.prompt, _lamp.prompt]);
  });

  testWidgets('Try this prompt is off with nowhere to open it', (tester) async {
    await _pumpFlow(tester);
    final button = tester.widget<ButtonStyleButton>(
      find.ancestor(
        of: find.text('Try this prompt').first,
        matching: find.bySubtype<ButtonStyleButton>(),
      ),
    );
    expect(button.onPressed, isNull);
  });

  testWidgets('Copy puts the prompt on the clipboard', (tester) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String;
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    await _pumpFlow(tester);
    await tester.tap(find.byKey(const ValueKey('store-copy-prompt:0')));
    await tester.pump();
    expect(copied, _lamp.prompt);
  });

  testWidgets('an example rises into view when it is scrolled to, once', (
    tester,
  ) async {
    await _pumpFlow(tester, animate: true, size: const Size(1200, 700));
    await tester.pump(const Duration(seconds: 1));
    double opacityOf(int i) => tester
        .widget<Opacity>(
          find
              .ancestor(
                of: find.byKey(ValueKey('store-example:$i')),
                matching: find.byType(Opacity),
              )
              .first,
        )
        .opacity;
    expect(opacityOf(0), 1, reason: 'the first is on screen');
    expect(opacityOf(1), 0, reason: 'the second is still below the fold');
    await tester.drag(
      find.byType(SingleChildScrollView),
      const Offset(0, -1600),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(opacityOf(1), 1);
  });

  testWidgets('Reduce Motion shows every example at once', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1200, 700);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      const MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(disableAnimations: true),
          child: Scaffold(
            body: SingleChildScrollView(
              child: StoreExampleFlow(
                entry: _blender,
                examples: [_lamp, _gear],
                animate: true,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    for (final opacity in tester.widgetList<Opacity>(
      find.ancestor(
        of: find.byKey(const ValueKey('store-example:1')),
        matching: find.byType(Opacity),
      ),
    )) {
      expect(opacity.opacity, 1);
    }
  });

  group('New Harness with a first message', () {
    setUp(() => FileSelectorPlatform.instance = _Folders());

    Future<_Notifier> open(WidgetTester tester) async {
      final notifier = _Notifier();
      addTearDown(notifier.dispose);
      const machine = Machine(
        machineId: 'machine-1',
        authMode: MachineAuthMode.remote,
        name: 'harness-remote-box',
      );
      final state = MachineState(machine)..localOnly = true;
      state.engines.replace(const [
        EngineAvailability(engine: 'claude', installed: true),
      ]);
      state.dsh.replace(const [_blender]);
      notifier.machineStates['machine-1'] = state;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => showNewAgentDialog(
                  context,
                  notifier,
                  'machine-1',
                  source: 'store',
                  initialEngine: 'autonomous/blender',
                  initialPrompt: '  ${_lamp.prompt}\n',
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      final newProject = find.byKey(
        const ValueKey('new-agent-folder-newProject'),
      );
      await tester.ensureVisible(newProject);
      await tester.tap(newProject);
      await tester.pumpAndSettle();
      return notifier;
    }

    Future<void> create(WidgetTester tester) async {
      await tester.ensureVisible(
        find.byKey(const ValueKey('create-agent-submit')),
      );
      await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
      await tester.pump();
    }

    final task = find.byKey(const ValueKey('new-agent-task'));
    String taskText(WidgetTester tester) =>
        tester.widget<TextField>(task).controller!.text;

    testWidgets('fills the task with the prompt and sends it', (tester) async {
      final app = await open(tester);
      expect(taskText(tester), _lamp.prompt, reason: 'trimmed, not rewritten');
      await create(tester);
      expect(app.prompts, [_lamp.prompt]);
      expect(tester.takeException(), isNull);
    });

    testWidgets('sends the task as edited', (tester) async {
      final app = await open(tester);
      await tester.ensureVisible(task);
      await tester.enterText(task, '${_lamp.prompt} Make it brass.\nAnd tall.');
      await tester.pump();
      await create(tester);
      expect(app.prompts, ['${_lamp.prompt} Make it brass.\nAnd tall.']);
    });

    testWidgets('starts with nothing sent once the task is cleared', (
      tester,
    ) async {
      final app = await open(tester);
      final clear = find.byKey(const ValueKey('new-agent-task-clear'));
      await tester.ensureVisible(clear);
      await tester.tap(clear);
      await tester.pumpAndSettle();
      expect(taskText(tester), isEmpty);
      expect(clear, findsNothing);
      await create(tester);
      expect(app.prompts, [null]);
    });

    testWidgets('⌘Return creates from inside the task, Return adds a line', (
      tester,
    ) async {
      final app = await open(tester);
      await tester.ensureVisible(task);
      await tester.tap(task);
      await tester.pump();
      await tester.enterText(task, 'Draw a desk lamp');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.prompts, isEmpty, reason: 'Return alone never creates');
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pump();
      expect(app.prompts, hasLength(1));
      expect(app.prompts.single, startsWith('Draw a desk lamp'));
    });
  });

  testWidgets(
    'the product page scrolls through the examples and tries one in New Harness',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1400, 1000);
      addTearDown(tester.view.reset);
      final app = createApp();
      final state = app.machineStates['m']!
        ..localOnly = true
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected;
      state.dsh.replace(const [_blender]);
      await app.addAgentToSwarm('m', 'a0');
      app.newSwarm(name: 'Other work');
      app.openStore();
      final storeTab = app.activeSwarm;

      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(notifier: app, nativeTabs: false),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('store-search')),
        'blender',
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('store-card:autonomous/blender')).first,
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('store-example:0')), findsOneWidget);
      expect(find.byKey(const ValueKey('store-example:1')), findsOneWidget);
      final tryGear = find.byKey(const ValueKey('store-try-prompt:1'));
      await tester.ensureVisible(tryGear);
      await tester.pumpAndSettle();
      await tester.tap(tryGear);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('create-agent-submit')),
        findsOneWidget,
        reason: 'New Harness is open',
      );
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('new-agent-task')))
            .controller!
            .text,
        _gear.prompt,
      );

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(
        app.activeSwarm,
        same(storeTab),
        reason: 'dismissed, back on the store',
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
