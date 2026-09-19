import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/agent_preference.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/widgets/agent_picker.dart';

import 'support/agent_picker.dart';
import 'swarm_state_test.dart' show MemoryStore;

class _SlowStore implements LocalKeyValueStore {
  final pending = Completer<String?>();
  @override
  Future<String?> read(String key) => pending.future;
  @override
  Future<void> write(String key, String value) async {}
  @override
  Future<void> delete(String key) async {}
}

AgentChoice _agent(
  String id,
  String label,
  String detail, {
  String? keywords,
  String? creator,
}) => AgentChoice(
  id: id,
  label: label,
  detail: detail,
  creator: creator,
  keywords: keywords,
  description: '$label, described.',
  mark: (size) => SizedBox.square(dimension: size),
);

final _choices = [
  _agent('codex', 'Codex', 'Code · OpenAI'),
  _agent(
    'claude',
    'Claude Code',
    'Agentic coding in your terminal',
    creator: 'Anthropic',
    keywords: 'Code',
  ),
  _agent('cursor', 'Cursor', 'Code · Anysphere'),
  _agent('hermes', 'Hermes', 'Code · Nous Research'),
  _agent('autonomous/marp', 'Marp', 'Slides · Autonomous', keywords: 'Media'),
  _agent(
    'autonomous/typst',
    'Typst',
    'Documents · Typst GmbH',
    keywords: 'Media',
  ),
];

void main() {
  test(
    'remembers the agent across launches without replacing a newer choice',
    () async {
      final store = MemoryStore();
      final preferences = AgentPreference(store);
      await preferences.select('codex');
      final restored = AgentPreference(store);
      await restored.load();
      expect(restored.value, 'codex');
      final slow = _SlowStore();
      final racing = AgentPreference(slow);
      final loading = racing.load();
      await racing.select('hermes');
      slow.pending.complete('claude');
      await loading;
      expect(racing.value, 'hermes');
    },
  );

  test(
    'remembers the agents harnesses were created with, newest first',
    () async {
      final store = MemoryStore();
      final preferences = AgentPreference(store);
      for (final id in ['codex', 'autonomous/marp', 'claude', 'codex']) {
        await preferences.remember(id);
      }
      expect(preferences.recent, ['codex', 'claude', 'autonomous/marp']);
      final restored = AgentPreference(store);
      await restored.remember('hermes');
      await restored.load();
      expect(restored.recent, [
        'hermes',
        'codex',
        'claude',
        'autonomous/marp',
      ], reason: 'one used while loading stays first; the stored ones follow');
      for (var i = 0; i < 20; i++) {
        await restored.remember('agent-$i');
      }
      expect(restored.recent, hasLength(AgentPreference.recentCapacity));
    },
  );

  testWidgets('the bar names the agent; its search lists yours, then all', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1200, 900);
    addTearDown(tester.view.reset);
    var selected = 'claude';
    var recent = <String>['autonomous/marp'];
    final barFocus = FocusNode(debugLabel: 'test agent bar');
    addTearDown(barFocus.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topCenter,
            child: Padding(
              padding: const EdgeInsets.only(top: 40),
              child: SizedBox(
                width: 1000,
                child: StatefulBuilder(
                  builder: (_, setState) => AgentPicker(
                    value: selected,
                    width: 1000,
                    focusNode: barFocus,
                    choices: _choices,
                    recent: () => recent,
                    installed: const {'codex'},
                    statusOf: (id) => id == 'codex' ? 'Installed on M2' : null,
                    onChanged: (value) => setState(() => selected = value),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    // Closed, the box names the chosen agent and nothing else.
    expect(
      find.descendant(of: agentBar, matching: find.text(AgentPicker.hint)),
      findsNothing,
    );
    expect(
      find.descendant(
        of: find.byKey(const Key('new-agent-agent-choice')),
        matching: find.text('Claude Code'),
      ),
      findsOneWidget,
    );
    expect(agentSearch, findsNothing);

    // Opened: the choice, what you used, what the machine has, the familiar
    // engines to fill it; the choice is highlighted, with a preview beside
    // the list.
    await openAgentSearch(tester);
    expect(agentRows(tester), ['claude', 'autonomous/marp', 'codex']);
    expect(find.text('Keep agent'), findsOneWidget);
    final claudeRow = find.byKey(const ValueKey('new-agent-agent-row-claude'));
    expect(
      find.descendant(of: claudeRow, matching: find.text('by Anthropic')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: claudeRow,
        matching: find.text('Agentic coding in your terminal'),
      ),
      findsOneWidget,
    );
    expect(find.text('Claude Code, described.'), findsOneWidget);

    // The arrows move the highlight and the preview follows it.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(find.text('Use agent'), findsOneWidget);
    expect(find.text('Installed on M2'), findsOneWidget);

    // Typing searches everything: the name first, then the words under it,
    // then the Store's shelf, which no row draws.
    await tester.enterText(agentSearch, 'herm');
    await tester.pump();
    expect(agentRows(tester), ['hermes']);
    await tester.enterText(agentSearch, 'slides');
    await tester.pump();
    expect(agentRows(tester), ['autonomous/marp']);
    await tester.enterText(agentSearch, 'media');
    await tester.pump();
    expect(agentRows(tester), ['autonomous/marp', 'autonomous/typst']);
    await tester.enterText(agentSearch, 'code');
    await tester.pump();
    expect(
      agentRows(tester),
      ['codex', 'claude', 'cursor', 'hermes'],
      reason:
          'a name that starts with the word, then one that carries it, '
          'then the words under a name',
    );

    // Return takes the highlighted row and closes the search.
    await tester.enterText(agentSearch, 'typ');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(selected, 'autonomous/typst');
    expect(agentSearch, findsNothing);
    expect(barFocus.hasPrimaryFocus, isTrue);
    expect(
      find.descendant(
        of: find.byKey(const Key('new-agent-agent-choice')),
        matching: find.text('Typst'),
      ),
      findsOneWidget,
    );

    // The recent list is read when the search opens. Nothing matching says
    // so; Escape closes without choosing.
    recent = ['hermes'];
    await openAgentSearch(tester);
    expect(agentRows(tester).take(2), ['autonomous/typst', 'hermes']);
    await tester.enterText(agentSearch, 'welding');
    await tester.pump();
    expect(agentRows(tester), isEmpty);
    expect(
      find.byKey(const Key('new-agent-agent-search-empty')),
      findsOneWidget,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(agentSearch, findsNothing);
    expect(selected, 'autonomous/typst');

    // A click outside the panel closes it too.
    await openAgentSearch(tester);
    await tester.tapAt(const Offset(4, 890));
    await tester.pump();
    expect(agentSearch, findsNothing);

    // The first letter typed on the bar opens the search with it in.
    barFocus.requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.keyC, character: 'c');
    await tester.pump();
    await tester.pump();
    expect(tester.widget<TextField>(agentSearch).controller!.text, 'c');

    expect(tester.takeException(), isNull);
  });

  testWidgets('a mouse click on a row chooses it, on a desktop', (
    tester,
  ) async {
    // On a desktop a mouse press outside a text field unfocuses it, which
    // closed the panel before the click on a row could land (owner,
    // 2026-09-17: "i selected claude code but it still shows text to cad").
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1200, 900);
    addTearDown(tester.view.reset);
    var selected = 'autonomous/typst';
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topCenter,
            child: SizedBox(
              width: 1000,
              child: StatefulBuilder(
                builder: (_, setState) => AgentPicker(
                  value: selected,
                  width: 1000,
                  choices: _choices,
                  onChanged: (value) => setState(() => selected = value),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    final bar = tester.getRect(agentBar);
    await tester.tapAt(
      Offset(bar.left + 90, bar.center.dy),
      kind: PointerDeviceKind.mouse,
    );
    await tester.pump();
    await tester.pump();
    expect(agentSearch, findsOneWidget);
    // A person's click: the press, a frame drawn while the button is down,
    // then the release.
    final click = await tester.startGesture(
      tester.getCenter(
        find.byKey(const ValueKey('new-agent-agent-row-claude')),
      ),
      kind: PointerDeviceKind.mouse,
    );
    await tester.pump();
    await tester.pump();
    await click.up();
    await tester.pump();
    expect(selected, 'claude');
    expect(agentSearch, findsNothing);
    expect(
      find.descendant(
        of: find.byKey(const Key('new-agent-agent-choice')),
        matching: find.text('Claude Code'),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  }, variant: TargetPlatformVariant.desktop());
}
