import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' show mount;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  for (final native in [false, true]) {
    testWidgets(
      'command and Add pickers keep editing ownership with session previews (native=$native)',
      (tester) async {
        debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
        const channel = MethodChannel('harness/swarm_tabs');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (_) async => null,
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final map = MemoryKeymap();
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        final input = <TerminalBinaryFrame>[];
        app.adoptSessionForTest(
          terminal('a0', input)..terminal.write('Private terminal output'),
        );
        await mount(tester, app, map, native: native);
        final field = find.byKey(const ValueKey('swarm-search-input'));
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        final controller = tester.widget<TextField>(field).controller!;
        final focus = tester.widget<TextField>(field).focusNode!;
        final selected = find.byWidgetPredicate(
          (w) => w is ListTile && w.selected,
        );
        final first = tester.widget<ListTile>(selected).key;
        await key(tester, LogicalKeyboardKey.arrowDown);
        expect(tester.widget<ListTile>(selected).key, isNot(first));
        await key(tester, LogicalKeyboardKey.arrowUp);
        expect(tester.widget<ListTile>(selected).key, first);
        await tester.enterText(field, 'new');
        await key(tester, LogicalKeyboardKey.keyA, cmd: true);
        expect(controller.selection.textInside(controller.text), 'new');
        await key(tester, LogicalKeyboardKey.backspace);
        expect(controller.text, isEmpty);
        expect(
          tester
              .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
              .search
              .rows
              .every((row) => row.isCommand),
          isTrue,
        );
        expect(focus.hasFocus, isTrue);
        expect(
          find.byKey(const ValueKey('swarm-search-preview')),
          findsNothing,
        );
        await key(tester, LogicalKeyboardKey.escape);
        expect(field, findsNothing);
        // The picker with session previews is the Open Agent chooser; New Agent
        // opens its dialog directly and has no inline results to preview.
        await key(tester, LogicalKeyboardKey.keyO, cmd: true);
        await tester.enterText(field, 'Agent 0');
        await tester.pump();
        expect(
          find.byKey(const ValueKey('swarm-search-preview')),
          findsOneWidget,
        );
        expect(find.textContaining('Private terminal output'), findsNothing);
        final results = tester.getRect(
          find.byKey(const ValueKey('swarm-search-result-list')),
        );
        final picker = tester.getRect(
          find.byKey(const ValueKey('swarm-search-results')),
        );
        expect(results.width, lessThan(picker.width));
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        expect(input, isEmpty);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
        debugDefaultTargetPlatformOverride = null;
      },
    );
  }
}
