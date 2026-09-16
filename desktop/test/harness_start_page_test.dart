import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/harness_start_page.dart';

import 'swarm_state_test.dart' show createApp;

final _input = find.byKey(const ValueKey('harness-start-search'));
final _results = find.byKey(const ValueKey('harness-start-results'));

void main() {
  testWidgets('unused start page never builds a search catalog', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    final focus = FocusNode();
    addTearDown(focus.dispose);
    var searches = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: HarnessStartPage(
            focusNode: focus,
            createSearch: () {
              searches++;
              return SwarmSearchController(app, [], adding: true);
            },
            onNew: () {},
            onChoose: (_) {},
          ),
        ),
      ),
    );
    await tester.pump();
    expect(focus.hasFocus, isTrue);
    expect(_results, findsNothing);
    expect(searches, 0);
    await tester.pumpWidget(const SizedBox());
    expect(searches, 0, reason: 'Closing an unused page must not index agents');
  });

  testWidgets('dismissed search is idle and reopens with current results', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    final focus = FocusNode();
    addTearDown(focus.dispose);
    var commandReads = 0;
    var updated = false;
    String? chosen;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: HarnessStartPage(
            focusNode: focus,
            createSearch: () => SwarmSearchController(
              app,
              [],
              adding: true,
              commands: () {
                commandReads++;
                return [
                  for (final id in ['one', 'two'])
                    SwarmDestination(
                      id: 'command:$id',
                      title: id == 'one'
                          ? updated
                                ? 'Updated command'
                                : 'First command'
                          : 'Second command',
                      detail: 'Commands',
                      swarmId: null,
                      current: false,
                      commandId: id,
                    ),
                ];
              },
            ),
            onNew: () {},
            onChoose: (selection) => chosen = selection.destination.id,
          ),
        ),
      ),
    );
    await tester.tap(_input);
    await tester.enterText(_input, '>');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    final selected = find.byWidgetPredicate(
      (widget) => widget is ListTile && widget.selected,
    );
    expect(
      find.descendant(of: selected, matching: find.text('Second command')),
      findsOneWidget,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(_results, findsNothing);
    final readsAtDismissal = commandReads;
    updated = true;
    app.renameSwarm(app.activeSwarmId, 'Background change');
    await tester.pump();
    expect(
      commandReads,
      readsAtDismissal,
      reason: 'A dismissed search must not refresh commands on app updates',
    );
    await tester.tap(_input);
    await tester.pump();
    expect(tester.widget<TextField>(_input).controller!.text, '>');
    expect(find.text('Updated command'), findsOneWidget);
    expect(
      find.descendant(of: selected, matching: find.text('Second command')),
      findsOneWidget,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(chosen, 'command:two');
    expect(_results, findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the store card is the door to the Harness Store, and only when there is one', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    final focus = FocusNode();
    addTearDown(focus.dispose);
    var opened = 0;
    Widget page({VoidCallback? onStore}) => MaterialApp(
      home: Scaffold(
        body: HarnessStartPage(
          focusNode: focus,
          createSearch: () => SwarmSearchController(app, [], adding: true),
          onNew: () {},
          onChoose: (_) {},
          onStore: onStore,
        ),
      ),
    );
    await tester.pumpWidget(page());
    await tester.pump();
    expect(find.byKey(const ValueKey('harness-store-link')), findsNothing);
    expect(find.byKey(const ValueKey('harness-device-link')), findsOneWidget);

    await tester.pumpWidget(page(onStore: () => opened++));
    await tester.pump();
    expect(find.byKey(const ValueKey('harness-store-link')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('harness-store-link')));
    await tester.pump();
    expect(opened, 1);
  });
}
