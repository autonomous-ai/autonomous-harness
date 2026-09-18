import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/phone_status.dart';
import 'package:harness_mobile/phone/status_pill.dart';
import 'package:harness_mobile/phone/terminal_header.dart';

/// The terminal's top bar: *agent* over *folder ⑂ branch*, with the
/// connection state as a dot on the engine mark.
void main() {
  group('the folder is named by its own name, parents folded', () {
    for (final (cwd, label) in [
      (
        '/Users/dudu/Bitcoin_builder/Grid/autonomous-harness',
        '~/…/autonomous-harness',
      ),
      ('/home/tony/work/harness', '~/…/harness'),
      ('/Users/dudu/notes', '~/notes'),
      ('/Users/dudu', '~'),
      ('/root/app', '~/app'),
      ('/srv', '/srv'),
      ('/opt/tools/grid', '/…/grid'),
      (r'C:\Users\tony\code\harness', 'C:/…/harness'),
      ('/', '/'),
    ]) {
      test('$cwd → $label', () => expect(projectPathLabel(cwd), label));
    }
  });

  testWidgets('two lines, and the state on the mark', (tester) async {
    final agent = Agent.fromJson({
      'id': 'a',
      'name': 'agent-3',
      'engine': 'claude',
      'project': {
        'name': 'autonomous-harness',
        'cwd': '/Users/dudu/Bitcoin_builder/Grid/autonomous-harness',
        'branch': 'feat/mobile-ios-android',
      },
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalHeader(
            agent: agent,
            status: (label: 'Live', tone: PhoneTone.good),
          ),
        ),
      ),
    );

    expect(find.text('agent-3'), findsOneWidget);
    expect(find.text('~/…/autonomous-harness'), findsOneWidget);
    expect(find.text('feat/mobile-ios-android'), findsOneWidget);
    // No word for the state — the dot says it, and its tooltip.
    expect(find.text('Live'), findsNothing);
    expect(find.byType(StatusDot), findsOneWidget);
    expect(find.byTooltip('Live'), findsOneWidget);
  });
}
