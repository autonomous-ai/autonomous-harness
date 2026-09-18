import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/shared/widgets/app_choice_picker.dart';

import 'support/real_fonts.dart';

import 'package:harness/widgets/agent_picker.dart';

import 'support/agent_picker.dart';

class _ChoicesApp extends AppNotifier {
  _ChoicesApp() : super(config: AppConfig.dev, authSession: AuthSession()) {
    for (final (id, name) in [
      ('local', 'iMac - Office'),
      ('office', 'M2'),
      ('home', 'T480 - Omarchy'),
      ('studio', 'Studio'),
      ('laptop', 'dees-MacBook-Pro.local'),
    ]) {
      final machine = Machine(
        machineId: id,
        name: name,
        authMode: MachineAuthMode.remote,
      );
      machineStates[id] = MachineState(machine)
        ..localOnly = id == 'local'
        ..nodeOnline = id != 'home'
        ..engines.replace(const [
          EngineAvailability(
            engine: 'codex',
            installed: true,
            supportsCodexHome: true,
          ),
          EngineAvailability(
            engine: 'kilo',
            installed: false,
            installable: true,
          ),
        ]);
    }
  }

  int createCalls = 0;

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
    createCalls++;
    return null;
  }

  @override
  Future<Map<String, dynamic>> readProjectPreview(
    String machineId,
    String path,
  ) async => {
    'path': path,
    'branch': 'main',
    'changedFiles': 2,
    'readme': '# Harness\nOne window for your coding agents.\n\n## Development\nRun agents on your machines and keep every project within reach.',
    'commit': {
      'subject': 'Simplify the project picker',
      'author': 'Alex',
      'date': '2026-09-15T10:00:00Z',
    },
    'contributors': ['Alex', 'Dee', 'Sam'],
  };

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async => {
    'profiles': [
      {'path': '/home/example/.codex', 'label': 'Personal'},
    ],
  };
}

void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide')..addFont(
          rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
        ))
        .load();
  });

  for (final (size, scale) in [
    (const Size(1280, 1000), 1.0),
    (const Size(1024, 768), 1.0),
    (const Size(900, 720), 1.0),
    (const Size(880, 560), 1.0),
    (const Size(600, 700), 2.0),
  ]) {
    testWidgets('machine and agent choices fit $size at text scale $scale', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = size;
      addTearDown(tester.view.reset);
      final app = _ChoicesApp();
      await app.agentPreference.select('codex');
      for (final path in [
        '/Users/example/code/workshop',
        '/Users/example/code/website',
        '/Users/example/code/harness',
      ]) {
        await app.projectHistory.select('local', path);
      }
      await app.projectHistory.select('local', null);
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      });
      final boundaryKey = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundaryKey,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
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
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();

      Future<void> capture(String state) async {
        final output = Platform.environment['HARNESS_CHOICES_CAPTURE_DIR'];
        if (output == null) return;
        await tester.runAsync(() async {
          for (final asset in [
            'codex.png',
            'cursor.png',
            'kilo.png',
            'autonomous-circuit.png',
            'marp.png',
          ]) {
            await precacheImage(
              AssetImage('assets/engine-icons/$asset'),
              boundaryKey.currentContext!,
            );
          }
        });
        await tester.pumpAndSettle();
        final boundary =
            boundaryKey.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        await tester.runAsync(() async {
          final image = await boundary.toImage(pixelRatio: 1);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(output).create(recursive: true);
          await File('$output/${size.width.toInt()}-$scale-$state.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }

      await capture('initial');
      for (final id in ['local', 'office', 'studio']) {
        expect(find.byKey(ValueKey('new-agent-machine-$id')), findsOneWidget);
      }
      // The agent section is its line and one search box, with no tiles
      // and no title over the form; the box names the chosen agent alone.
      expect(find.text('Agent. Choose who you’ll work with.'), findsOneWidget);
      expect(
        find.descendant(of: agentBar, matching: find.text(AgentPicker.hint)),
        findsNothing,
      );
      expect(
        find.descendant(
          of: find.byKey(const Key('new-agent-agent-choice')),
          matching: find.text('Codex'),
        ),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('harness-help-agent')), findsNothing);
      expect(find.byKey(const ValueKey('new-agent-quick-codex')), findsNothing);
      void expectUniformTiles() {
        final tile = tester.getSize(find.byType(AppChoiceTile).first);
        // Every machine and project tile, and the two menus that stand in a
        // tile's place.
        for (final element in find.byType(AppChoiceTile).evaluate()) {
          expect(
            tester.getSize(find.byWidget(element.widget)),
            tile,
            reason: '${element.widget.key}',
          );
        }
        for (final key in [
          'new-agent-machine-more',
          'new-agent-project-recent',
        ]) {
          expect(tester.getSize(find.byKey(ValueKey(key))), tile, reason: key);
        }
      }

      expectUniformTiles();
      // The agent box, the tiles and the first-task box are one height.
      final tileHeight = tester
          .getSize(find.byType(AppChoiceTile).first)
          .height;
      expect(tester.getSize(agentBar).height, tileHeight);
      final taskBox = find.byKey(const Key('new-agent-task'));
      await tester.ensureVisible(taskBox);
      await tester.pumpAndSettle();
      // The painted box, not only the space it takes: the decorator's fill.
      expect(
        tester
            .getSize(
              find.descendant(
                of: taskBox,
                matching: find.byType(InputDecorator),
              ),
            )
            .height,
        closeTo(tileHeight, 1),
      );
      expect(tester.getSize(taskBox).height, closeTo(tileHeight, 1));
      expect(
        find.text('First task. What should your agent work on? (Optional)'),
        findsOneWidget,
      );
      await tester.ensureVisible(agentBar);
      await tester.pumpAndSettle();

      if (size.width >= 900 && size.height >= 720 && scale == 1) {
        // The common desktop sizes should show every choice before scrolling.
        final form = find.ancestor(
          of: agentBar,
          matching: find.byType(SingleChildScrollView),
        );
        final visible = tester.getRect(form);
        for (final key in [
          'new-agent-agent-field',
          'new-agent-machine-local',
          'new-agent-folder-newProject',
          'new-agent-project-recent',
        ]) {
          final choice = find.byKey(ValueKey(key));
          final bounds = tester.getRect(choice);
          expect(bounds.top, greaterThanOrEqualTo(visible.top));
          expect(bounds.bottom, lessThanOrEqualTo(visible.bottom));
          expect(choice.hitTestable(), findsOneWidget);
        }
      }

      // Opened, the bar becomes the search: the agents you use first, the
      // Store last, in a panel that stays inside the window.
      await openAgentSearch(tester);
      expect(agentRows(tester).first, 'codex');
      expect(
        tester.getRect(find.byKey(const Key('new-agent-agent-panel'))).bottom,
        lessThanOrEqualTo(size.height),
      );
      await capture('search-open');
      await tester.enterText(agentSearch, 'openc');
      await tester.pumpAndSettle();
      expect(agentRows(tester).first, 'opencode');
      await capture('search');
      await tester.enterText(agentSearch, 'welding');
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('new-agent-agent-search-empty')),
        findsOneWidget,
      );
      await capture('search-empty');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(agentSearch, findsNothing);
      expect(tester.takeException(), isNull);
      expect(find.text('This computer'), findsOneWidget);
      expect(find.text('Cancel'), findsNothing);
      expect(find.byKey(const ValueKey('create-agent-submit')), findsOneWidget);
      final advanced = find.byKey(const Key('new-agent-advanced'));
      await tester.ensureVisible(advanced);
      await tester.tap(advanced);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Auto-approve'));
      expect(find.text('Permissions'), findsNothing);
      expect(find.text('Add'), findsOneWidget);
      if (size.width >= 900 && scale == 1) {
        final settingsCenter = tester.getCenter(advanced).dy;
        for (final control in [
          find.text('Auto-approve'),
          find.byKey(const Key('new-agent-codex-profile-field')),
          find.text('Add'),
        ]) {
          expect(tester.getCenter(control).dy, closeTo(settingsCenter, 1));
        }
      }
      await capture('advanced');
      await tester.ensureVisible(advanced);
      await tester.tap(advanced);
      await tester.pumpAndSettle();
      expect(find.text('Auto-approve'), findsNothing);
      expect(find.text('Add'), findsNothing);
      final recent = find.byKey(const Key('new-agent-project-recent'));
      await tester.ensureVisible(recent);
      await tester.tap(recent);
      await tester.pumpAndSettle();
      await capture('projects');
      await tester.ensureVisible(find.text('workshop'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('workshop'));
      await tester.pumpAndSettle();
      final git = find.byKey(const Key('new-agent-project-git'));
      await tester.ensureVisible(git);
      await tester.tap(git);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('new-agent-git-url')),
        'owner/repo',
      );
      await capture('repository');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();

      // Help is a separate route: it must keep the current choices and scroll
      // position, contain keyboard shortcuts, and return focus to its trigger.
      for (final (topic, lastTitle) in [
        ('machine', 'Remote machine'),
        ('project', 'Recent'),
      ]) {
        final help = find.byKey(ValueKey('harness-help-$topic'));
        await tester.ensureVisible(help);
        await tester.pumpAndSettle();
        final position = Scrollable.of(tester.element(help)).position;
        final scrollBefore = position.pixels;
        await tester.tap(help);
        await tester.pumpAndSettle();
        final guide = find.byKey(ValueKey('harness-help-guide-$topic'));
        expect(guide, findsOneWidget);
        await capture('help-$topic');
        for (final modifier in [
          LogicalKeyboardKey.metaLeft,
          LogicalKeyboardKey.controlLeft,
        ]) {
          await tester.sendKeyDownEvent(modifier);
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.sendKeyUpEvent(modifier);
          await tester.pumpAndSettle();
          expect(guide, findsOneWidget);
          expect(app.createCalls, 0);
        }
        final lastSection = find.descendant(
          of: guide,
          matching: find.text(lastTitle),
        );
        await tester.ensureVisible(lastSection);
        await tester.pumpAndSettle();
        expect(tester.getRect(lastSection).bottom, lessThan(size.height));
        expect(tester.takeException(), isNull);
        if (topic == 'agent') {
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        } else if (topic == 'machine') {
          await tester.tap(find.byKey(const Key('harness-help-close')));
        } else {
          await tester.tapAt(const Offset(2, 2));
        }
        await tester.pumpAndSettle();
        expect(guide, findsNothing);
        expect(position.pixels, closeTo(scrollBefore, 1));
        expect(tester.widget<TextButton>(help).focusNode!.hasFocus, isTrue);
        await capture('help-$topic-closed');
        final selected = tester.widget<AppChoiceTile>(git);
        expect(selected.selected, isTrue);
        expect(selected.detail, 'repo');
        expect(
          tester.widget<AgentPicker>(find.byType(AgentPicker)).value,
          'codex',
        );
        expect(
          tester
              .widget<AppChoicePicker<String>>(
                find.byKey(const Key('new-agent-machine-field')),
              )
              .value,
          'local',
        );
      }
      final moreMachines = find.byKey(const Key('new-agent-machine-more'));
      await tester.ensureVisible(moreMachines);
      await tester.tap(moreMachines);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('T480 - Omarchy'));
      await tester.tap(find.text('T480 - Omarchy'));
      await tester.pumpAndSettle();
      expect(find.text('T480 - Omarchy'), findsOneWidget);
      expect(find.text('Offline'), findsNothing);
      expect(find.byKey(const Key('new-agent-machine-home')), findsNothing);
      // An agent you have not used is a search away; chosen, the bar names it.
      await chooseAgent(tester, 'kilo');
      await tester.pumpAndSettle();
      expect(
        tester.widget<AgentPicker>(find.byType(AgentPicker)).value,
        'kilo',
      );
      expect(
        find.descendant(of: agentBar, matching: find.text('Kilo')),
        findsOneWidget,
      );
      expectUniformTiles();
      expect(find.byType(AppChoiceTile), findsNWidgets(6));
      expect(find.byType(Tooltip), findsNothing);
      expect(
        find.text('Harness will install Kilo before starting.'),
        findsNothing,
      );
      await capture('selected');
      final submit = find.byKey(const ValueKey('create-agent-submit'));
      expect(tester.getRect(submit).bottom, lessThan(size.height));
      expect(tester.takeException(), isNull);
    });
  }
}
