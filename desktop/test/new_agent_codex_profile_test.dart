import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/new_agent_dialog.dart';

class _Folders extends FileSelectorPlatform {
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) async => '/work';
}

/// The profile the dialog says it will use, read off the Advanced row.
///
/// That row is the only place reporting it now: the summary card that used to
/// print a `Profile` fact is gone with the rest of the second column, and the
/// row carries the same answer by LABEL rather than by full path — which is what
/// a person reading a folded drawer actually needs.
void expectProfile(WidgetTester tester, String label) {
  final state = tester.widget<Text>(
    find.byKey(const Key('new-agent-advanced-state')),
  );
  expect(state.data, contains(label), reason: 'Advanced should name $label');
}

String _labelFor(String path) =>
    path.split('/').where((p) => p.isNotEmpty).last;

/// Stands in for the CLI round trip. `listCodexProfiles`/`linkCodexProfile` are what the harness CLI
/// on [machineId] would answer with — this fake never touches a filesystem, matching how the real
/// data now only ever comes from the machine's own CLI.
class _Notifier extends AppNotifier {
  _Notifier([
    Iterable<String> initialPaths = const [
      '/accounts/codex1',
      '/accounts/codex2',
    ],
  ]) : paths = {...initialPaths},
       super(
         config: AppConfig.dev,
         authSession: AuthSession(),
         configStore: null,
       );

  final Set<String> paths;
  final extraPaths = <String>{};
  final linkedPaths = <String>[];
  Completer<void>? pending;
  final calls = <Map<String, Object?>>[];

  void replaceAgents(String machineId, List<Agent> agents) {
    machineStates[machineId]!.agents = agents;
    notifyListeners();
  }

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async {
    await pending?.future;
    return {
      'profiles': [
        for (final path in {...paths, ...observedPaths, ...extraPaths})
          {'path': path, 'label': _labelFor(path)},
      ],
    };
  }

  @override
  Future<Map<String, dynamic>> linkCodexProfile(
    String machineId,
    String path,
  ) async {
    linkedPaths.add(path);
    paths.add(path);
    return {
      'profile': {'path': path, 'label': _labelFor(path)},
    };
  }

  @override
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String folder,
    bool bypassPermission = false,
    String? codexHome,
    String? swarmId,
  }) async {
    calls.add({'engine': engine, 'codexHome': codexHome, 'folder': folder});
    return null;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FileSelectorPlatform priorFiles;
  setUp(() {
    priorFiles = FileSelectorPlatform.instance;
    FileSelectorPlatform.instance = _Folders();
  });
  tearDown(() {
    FileSelectorPlatform.instance = priorFiles;
  });

  Future<_Notifier> open(
    WidgetTester tester, {
    bool local = true,
    bool supported = true,
    Iterable<String>? initialPaths,
    _Notifier? notifier,
  }) async {
    final n =
        notifier ??
        _Notifier(
          initialPaths ?? const ['/accounts/codex1', '/accounts/codex2'],
        );
    addTearDown(n.dispose);
    n.machineStates['machine'] =
        MachineState(
            const Machine(
              machineId: 'machine',
              name: 'This Mac',
              authMode: MachineAuthMode.remote,
            ),
          )
          ..localOnly = local
          ..engines.replace([
            EngineAvailability(
              engine: 'codex',
              installed: true,
              supportsCodexHome: supported,
            ),
          ]);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showNewAgentDialog(
                context,
                n,
                'machine',
                source: 'machine_row',
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('new-agent-engine-field')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Codex').last);
    await tester.pumpAndSettle();
    // The profile lives behind the fold now: it and the bypass flag are the two
    // settings most people never touch, so they are off the path of somebody who
    // wants neither. Every test below is about the profile, so every one of them
    // opens it.
    await tester.tap(find.byKey(const Key('new-agent-advanced')));
    await tester.pumpAndSettle();
    for (final t in [
      'Permissions',
      'Codex profile',
      'Link a profile folder…',
      '/custom/work-login',
      'Checking whether this computer supports Codex profiles…',
    ])
      // ignore: avoid_print
      print('PROBE $t -> ' + tester.widgetList(find.text(t)).length.toString());
    return n;
  }

  Future<void> selectSecond(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('new-agent-codex-profile-field')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('codex2').last);
    await tester.pumpAndSettle();
  }

  testWidgets('no profiles hides the picker and keeps a default launch', (
    tester,
  ) async {
    final notifier = await open(tester, initialPaths: const []);
    expect(
      find.byKey(const Key('new-agent-codex-profile-field')),
      findsNothing,
    );
    expect(find.text('Codex profile'), findsNothing);
    expect(find.text('Link a profile folder…'), findsOneWidget);
    await tester.tap(find.text('Browse…'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Create agent'));
    await tester.pumpAndSettle();
    expect(notifier.calls.single['codexHome'], isNull);
  });

  testWidgets('one profile is used automatically without a picker', (
    tester,
  ) async {
    final notifier = await open(
      tester,
      initialPaths: const ['/custom/work-login'],
    );
    expect(
      find.byKey(const Key('new-agent-codex-profile-field')),
      findsNothing,
    );
    expect(find.text('Codex profile'), findsNothing);
    expectProfile(tester, 'work-login');
    expect(find.text('Link a profile folder…'), findsOneWidget);
    await tester.tap(find.text('Browse…'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Create agent'));
    await tester.pumpAndSettle();
    expect(notifier.calls.single['codexHome'], '/custom/work-login');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'offers Codex profiles for a remote machine too, not only this computer',
    (tester) async {
      await open(
        tester,
        local: false,
        initialPaths: const ['/custom/work-login'],
      );
      expect(
        find.byKey(const Key('new-agent-codex-profile-field')),
        findsNothing,
      );
      expectProfile(tester, 'work-login');
      expect(find.text('Link a profile folder…'), findsOneWidget);
    },
  );

  testWidgets('the picker appears at two profiles and hides again at one', (
    tester,
  ) async {
    final notifier = await open(
      tester,
      initialPaths: const ['/accounts/codex1'],
    );
    expect(
      find.byKey(const Key('new-agent-codex-profile-field')),
      findsNothing,
    );
    notifier.paths.add('/accounts/codex2');
    await tester.tap(find.byTooltip('Refresh profiles'));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('new-agent-codex-profile-field')),
      findsOneWidget,
    );
    expectProfile(tester, 'codex1');
    await selectSecond(tester);
    notifier.paths.remove('/accounts/codex1');
    await tester.tap(find.byTooltip('Refresh profiles'));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('new-agent-codex-profile-field')),
      findsNothing,
    );
    expectProfile(tester, 'codex2');
  });

  testWidgets('creation waits for discovery to select the single account', (
    tester,
  ) async {
    final notifier = _Notifier(const ['/custom/work-login'])
      ..pending = Completer<void>();
    await open(tester, notifier: notifier);
    await tester.tap(find.text('Browse…'));
    await tester.pumpAndSettle();
    final createButton = find.widgetWithText(FilledButton, 'Create agent');
    expect(tester.widget<FilledButton>(createButton).onPressed, isNull);
    expect(notifier.calls, isEmpty);
    notifier.pending!.complete();
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(createButton).onPressed, isNotNull);
    await tester.tap(createButton);
    await tester.pumpAndSettle();
    expect(notifier.calls.single['codexHome'], '/custom/work-login');
    expect(tester.takeException(), isNull);
  });

  testWidgets('a missing selection requires an explicit account change', (
    tester,
  ) async {
    final notifier = await open(tester);
    await selectSecond(tester);
    notifier.paths.remove('/accounts/codex2');
    await tester.tap(find.byTooltip('Refresh profiles'));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('new-agent-codex-profile-field')),
      findsNothing,
    );
    expectProfile(tester, 'codex2');
    await tester.tap(find.text('Use codex1'));
    await tester.pumpAndSettle();
    expectProfile(tester, 'codex1');
    await tester.tap(find.text('Browse…'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Create agent'));
    await tester.pumpAndSettle();
    expect(notifier.calls.single['codexHome'], '/accounts/codex1');
  });

  testWidgets('refresh preserves an explicitly chosen default launch', (
    tester,
  ) async {
    final notifier = await open(tester);
    await selectSecond(tester);
    await tester.tap(find.byKey(const Key('new-agent-codex-profile-field')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Default').last);
    await tester.pumpAndSettle();
    notifier.paths.remove('/accounts/codex2');
    await tester.tap(find.byTooltip('Refresh profiles'));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('new-agent-codex-profile-field')),
      findsNothing,
    );
    expect(
      tester
          .widget<Text>(find.byKey(const Key('new-agent-advanced-state')))
          .data,
      isNot(contains('codex1')),
    );
    await tester.tap(find.text('Browse…'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Create agent'));
    await tester.pumpAndSettle();
    expect(notifier.calls.single['codexHome'], isNull);
  });

  testWidgets(
    'creates with the selected account and shows its full path before the click',
    (tester) async {
      final notifier = await open(tester);
      await selectSecond(tester);
      expectProfile(tester, 'codex2');
      await tester.tap(find.text('Browse…'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Create agent'));
      await tester.pumpAndSettle();
      expect(notifier.calls, [
        {'engine': 'codex', 'codexHome': '/accounts/codex2', 'folder': '/work'},
      ]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'discovers newly observed local profiles while ignoring remote machine paths',
    (tester) async {
      final notifier = await open(tester);
      notifier.machineStates['remote'] =
          MachineState(
              const Machine(
                machineId: 'remote',
                authMode: MachineAuthMode.remote,
              ),
            )
            ..agents = [
              Agent.fromJson({
                'id': 'remote-agent',
                'engine': 'codex',
                'codexHome': '/remote/private-account',
              }),
            ];
      notifier.replaceAgents('machine', [
        Agent.fromJson({
          'id': 'local-agent',
          'engine': 'codex',
          'codexHome': '/unusual/location/work-login',
        }),
      ]);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('new-agent-codex-profile-field')));
      await tester.pumpAndSettle();
      expect(find.text('work-login'), findsOneWidget);
      expect(find.text('private-account'), findsNothing);
      await tester.tap(find.text('work-login'));
      await tester.pumpAndSettle();
      expectProfile(tester, 'work-login');
    },
  );

  testWidgets(
    'refresh discovers an added profile and keeps the current selection',
    (tester) async {
      final notifier = await open(tester);
      await selectSecond(tester);
      notifier.extraPaths.add('/elsewhere/new-profile');
      await tester.tap(find.byTooltip('Refresh profiles'));
      await tester.pumpAndSettle();
      expectProfile(tester, 'codex2');
      await tester.tap(find.byKey(const Key('new-agent-codex-profile-field')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('new-profile'));
      await tester.pumpAndSettle();
      expectProfile(tester, 'new-profile');
    },
  );

  testWidgets('changing engines clears the selected account', (tester) async {
    final notifier = await open(tester);
    await selectSecond(tester);
    await tester.tap(find.byKey(const Key('new-agent-engine-field')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Claude').last);
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('new-agent-codex-profile-field')),
      findsNothing,
    );
    await tester.tap(find.text('Browse…'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Create agent'));
    await tester.pumpAndSettle();
    expect(notifier.calls.single['codexHome'], isNull);
    expect(notifier.calls.single['engine'], 'claude');
  });

  testWidgets(
    'an old CLI keeps the normal launch available and explains profile support',
    (tester) async {
      final notifier = await open(tester, supported: false);
      expect(
        find.byKey(const Key('new-agent-codex-profile-field')),
        findsNothing,
      );
      expect(
        find.text('Update Harness CLI to choose a local Codex profile.'),
        findsOneWidget,
      );
      await tester.tap(find.text('Browse…'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Create agent'));
      await tester.pumpAndSettle();
      expect(notifier.calls.single['codexHome'], isNull);
    },
  );
}
