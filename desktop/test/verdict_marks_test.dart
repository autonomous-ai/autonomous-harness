// The one status a verdict puts in the viewer's title, and the phases it is
// read from.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/theme/app_theme.dart';
import 'package:harness/widgets/verdict_marks.dart';

void main() {
  test('phases parse in order, defaulting and dropping what is malformed', () {
    final verdict = AgentVerdict.fromJson({
      'ready': false,
      'phases': [
        {'id': 'build', 'name': 'Build', 'state': 'done', 'artifact': 'a.step'},
        {'name': 'Checks', 'state': 'active'},
        {'name': 'Fab', 'state': 'someday'},
        {'name': '', 'state': 'done'},
        'nope',
        {'id': 'x', 'state': 'done'},
      ],
    })!;
    expect(verdict.phases.map((p) => p.name), ['Build', 'Checks', 'Fab']);
    expect(verdict.phases.map((p) => p.state), [
      AgentPhaseState.done,
      AgentPhaseState.active,
      AgentPhaseState.pending,
    ]);
    expect(verdict.phases.first.artifact, 'a.step');
    expect(verdict.phases[1].id, 'checks');
    expect(verdict.activePhase?.name, 'Checks');
    expect(AgentVerdict.fromJson({'ready': true})!.phases, isEmpty);
    expect(
      AgentVerdict.fromJson({'ready': true, 'phases': 'x'})!.phases,
      isEmpty,
    );
    final many = AgentVerdict.fromJson({
      'ready': true,
      'phases': [
        for (var i = 0; i < 20; i++) {'name': 'P$i'},
      ],
    })!;
    expect(many.phases, hasLength(12));
  });

  test(
    'the current phase is the one under way, else the last that happened',
    () {
      AgentVerdict v(List<AgentPhaseState> states) => AgentVerdict(
        ready: false,
        phases: [
          for (final (i, s) in states.indexed)
            AgentPhase(id: 'p$i', name: 'P$i', state: s),
        ],
      );
      expect(
        v([
          AgentPhaseState.done,
          AgentPhaseState.active,
          AgentPhaseState.pending,
        ]).currentPhase?.name,
        'P1',
      );
      expect(
        v([AgentPhaseState.done, AgentPhaseState.done, AgentPhaseState.pending])
            .currentPhase
            ?.name,
        'P1',
      );
      expect(v([AgentPhaseState.pending]).currentPhase, isNull);
      expect(const AgentVerdict(ready: true).currentPhase, isNull);
    },
  );

  testWidgets('one status: ready, then errors, then the phase, then warnings', (
    tester,
  ) async {
    const build = AgentPhase(
      id: 'build',
      name: 'Build',
      state: AgentPhaseState.done,
    );
    const checks = AgentPhase(
      id: 'checks',
      name: 'Checks',
      state: AgentPhaseState.active,
    );
    final cases = <(AgentVerdict, String, Color)>[
      (
        const AgentVerdict(ready: true, phases: [build, checks], summary: 'ok'),
        'Ready',
        AppColors.success,
      ),
      (
        const AgentVerdict(ready: false, errors: 3, phases: [build, checks]),
        '3 errors',
        AppColors.danger,
      ),
      (
        const AgentVerdict(ready: false, warnings: 2, phases: [build, checks]),
        'Checks',
        AppColors.text,
      ),
      (
        const AgentVerdict(ready: false, warnings: 1, phases: [build]),
        '1 warning',
        AppColors.warning,
      ),
      (
        const AgentVerdict(ready: false, phases: [build]),
        'Build',
        AppColors.success,
      ),
      (const AgentVerdict(ready: false), 'Checked', AppColors.mutedStrong),
    ];
    final status = find.byKey(const ValueKey('pane-status'));
    for (final (verdict, label, color) in cases) {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: VerdictStatus(verdict: verdict)),
        ),
      );
      expect(status, findsOneWidget, reason: label);
      expect(
        find.descendant(of: status, matching: find.text(label)),
        findsOneWidget,
        reason: label,
      );
      expect(
        tester
            .widget<Text>(
              find.descendant(of: status, matching: find.text(label)),
            )
            .style
            ?.color,
        color,
        reason: label,
      );
    }
  });

  testWidgets('a working agent reads Working, or its phase, never the last Ready', (
    tester,
  ) async {
    const build = AgentPhase(id: 'build', name: 'Build', state: AgentPhaseState.active);
    final status = find.byKey(const ValueKey('pane-status'));
    for (final (verdict, label) in [
      (const AgentVerdict(ready: true, summary: 'main.pdf · 1 page'), 'Working'),
      (const AgentVerdict(ready: false, errors: 2), 'Working'),
      (const AgentVerdict(ready: false, phases: [build]), 'Build'),
    ]) {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: VerdictStatus(verdict: verdict, working: true)),
        ),
      );
      expect(
        find.descendant(of: status, matching: find.text(label)),
        findsOneWidget,
        reason: label,
      );
      expect(find.descendant(of: status, matching: find.text('Ready')), findsNothing);
    }
    final tooltip = tester.widget<Tooltip>(find.byType(Tooltip).first);
    expect(tooltip.message, 'The agent is working');
  });
}
