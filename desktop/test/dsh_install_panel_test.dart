// The install panel the New Harness dialog shows while a harness installs:
// three steps with the line each is on, the tail of the log, how long each step
// took, and — when it fails — the machine's own `miss` line as a sentence with
// the command that fixes it.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/widgets/dsh_install_panel.dart';

final _t0 = DateTime(2026, 9, 1, 9);

/// One push from the machine, [seconds] after the run began.
(DshInstallProgress, int) _at(
  String phase,
  int seconds, {
  String? line,
  String? detail,
}) => (
  DshInstallProgress(
    id: 'autonomous/marp',
    phase: phase,
    line: line,
    detail: detail,
  ),
  seconds,
);

DshInstallRun _run(List<(DshInstallProgress, int)> pushes) {
  final run = DshInstallRun('autonomous/marp', startedAt: _t0);
  for (final (progress, seconds) in pushes) {
    run.apply(progress, now: _t0.add(Duration(seconds: seconds)));
  }
  return run;
}

Future<void> _show(WidgetTester tester, DshInstallRun run) => tester.pumpWidget(
  MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: DshInstallPanel(
          run: run,
          harnessName: 'Marp',
          machineName: 'Studio',
        ),
      ),
    ),
  ),
);

/// The step row named [name]: its mark and its text.
Finder _step(String name) => find
    .ancestor(
      of: find.text(name),
      matching: find.byWidgetPredicate(
        (w) => w is Row && w.crossAxisAlignment == CrossAxisAlignment.start,
      ),
    )
    .first;

enum _Mark { pending, active, done, failed }

_Mark _markOf(WidgetTester tester, String name) {
  final row = _step(name);
  if (find
      .descendant(of: row, matching: find.byType(CircularProgressIndicator))
      .evaluate()
      .isNotEmpty) {
    return _Mark.active;
  }
  final icons = tester
      .widgetList<Icon>(find.descendant(of: row, matching: find.byType(Icon)))
      .map((i) => i.icon)
      .toList();
  if (icons.contains(Icons.check)) return _Mark.done;
  if (icons.contains(Icons.priority_high)) return _Mark.failed;
  return _Mark.pending;
}

void main() {
  testWidgets('a run nobody has heard from yet is fetching', (tester) async {
    await _show(tester, DshInstallRun('autonomous/marp'));
    expect(find.text('Installing Marp on Studio'), findsOneWidget);
    // A loaded test host can spend seconds between construction and first
    // paint. Assert the clock format, not sub-second wall-clock scheduling.
    expect(find.textContaining(RegExp(r'^\d+:\d{2}$')), findsOneWidget);
    expect(_markOf(tester, 'Fetch Marp'), _Mark.active);
    expect(find.text('Fetching…'), findsOneWidget);
    expect(_markOf(tester, 'Set up the toolchain'), _Mark.pending);
    expect(_markOf(tester, 'Check this machine'), _Mark.pending);
    expect(
      find.text(
        'The first install takes a few minutes. You can keep using OpenHarness.',
      ),
      findsOneWidget,
    );
    expect(find.byKey(const Key('dsh-install-failure')), findsNothing);
  });

  testWidgets('the fetch step says what the machine is doing', (tester) async {
    await _show(
      tester,
      _run([_at('clone', 0, detail: 'Resolving the package')]),
    );
    expect(find.text('Resolving the package'), findsOneWidget);
  });

  testWidgets(
    'set up is active with its current line, fetch is done with its time, and the log tail is the last six',
    (tester) async {
      final run = _run([_at('clone', 0), _at('setup', 12, line: 'npm ci')]);
      for (var i = 1; i <= 8; i++) {
        run.apply(
          DshInstallProgress(
            id: 'autonomous/marp',
            phase: 'setup',
            line: 'added $i packages',
          ),
          now: _t0.add(Duration(seconds: 12 + i)),
        );
      }
      await _show(tester, run);
      expect(_markOf(tester, 'Fetch Marp'), _Mark.done);
      expect(
        find.descendant(of: _step('Fetch Marp'), matching: find.text('12s')),
        findsOneWidget,
      );
      expect(_markOf(tester, 'Set up the toolchain'), _Mark.active);
      // The current line, under the step and at the foot of the log.
      expect(find.text('added 8 packages'), findsNWidgets(2));
      for (var i = 3; i <= 7; i++) {
        expect(find.text('added $i packages'), findsOneWidget);
      }
      expect(find.text('added 2 packages'), findsNothing);
      expect(find.text('npm ci'), findsNothing, reason: 'older than the tail');
      expect(_markOf(tester, 'Check this machine'), _Mark.pending);
    },
  );

  testWidgets(
    'a quiet set up and a quiet check still say what they are doing',
    (tester) async {
      await _show(tester, _run([_at('clone', 0), _at('setup', 70)]));
      expect(find.text('Setting up the toolchain…'), findsOneWidget);
      expect(
        find.descendant(of: _step('Fetch Marp'), matching: find.text('1:10')),
        findsOneWidget,
        reason: 'a minute or more reads as a clock',
      );

      await _show(
        tester,
        _run([_at('clone', 0), _at('setup', 5), _at('doctor', 9)]),
      );
      expect(_markOf(tester, 'Check this machine'), _Mark.active);
      expect(find.text('Checking the machine…'), findsOneWidget);
    },
  );

  testWidgets(
    'the check lists its verdicts as they arrive, and trails off until one misses',
    (tester) async {
      final passing = _run([
        _at('clone', 0),
        _at('setup', 5),
        _at('doctor', 9, line: 'ok tmux (3.4)'),
        _at('doctor', 10, line: 'warn node (18; 22 is better)'),
      ]);
      await _show(tester, passing);
      expect(find.text('tmux ✓ · node ! …'), findsOneWidget);

      passing.apply(
        const DshInstallProgress(
          id: 'autonomous/marp',
          phase: 'doctor',
          line: 'miss marp-cli',
        ),
        now: _t0.add(const Duration(seconds: 11)),
      );
      await _show(tester, passing);
      expect(find.text('tmux ✓ · node ! · marp-cli ✗'), findsOneWidget);
    },
  );

  testWidgets(
    'a finished install marks every step it went through, and stops the clock',
    (tester) async {
      await _show(
        tester,
        _run([
          _at('clone', 0),
          _at('setup', 20),
          _at('doctor', 100),
          _at('done', 125),
        ]),
      );
      expect(find.text('Marp installed on Studio'), findsOneWidget);
      expect(find.text('2:05'), findsOneWidget);
      expect(_markOf(tester, 'Fetch Marp'), _Mark.done);
      expect(_markOf(tester, 'Set up the toolchain'), _Mark.done);
      expect(_markOf(tester, 'Check this machine'), _Mark.done);
      expect(find.text('Starting the harness…'), findsOneWidget);

      // Already installed toolchain: straight from fetch to done.
      await _show(
        tester,
        _run([_at('clone', 0, line: 'cloned'), _at('done', 3)]),
      );
      expect(_markOf(tester, 'Fetch Marp'), _Mark.done);
      expect(_markOf(tester, 'Set up the toolchain'), _Mark.pending);
      expect(_markOf(tester, 'Check this machine'), _Mark.pending);
      expect(
        find.text('cloned'),
        findsNothing,
        reason: 'no log once it is done',
      );
    },
  );

  testWidgets('a failed check names the step, the score and the fix', (
    tester,
  ) async {
    await _show(
      tester,
      _run([
        _at('clone', 0),
        _at('setup', 4),
        _at('doctor', 8, line: 'ok tmux'),
        _at('doctor', 9, line: 'miss codex (npm install -g @openai/codex)'),
        _at('failed', 12, detail: 'doctor failed'),
      ]),
    );
    expect(_markOf(tester, 'Fetch Marp'), _Mark.done);
    expect(_markOf(tester, 'Set up the toolchain'), _Mark.done);
    expect(_markOf(tester, 'Check this machine'), _Mark.failed);
    expect(find.text('1 of 2 checks passed'), findsOneWidget);
    final failure = find.byKey(const Key('dsh-install-failure'));
    expect(
      find.descendant(
        of: failure,
        matching: find.text('Codex is not installed on this machine.'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: failure,
        matching: find.text('Marp runs on Codex. Install it, then retry.'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: failure,
        matching: find.text('npm install -g @openai/codex'),
      ),
      findsOneWidget,
    );
    expect(
      find.text(
        'The download and the toolchain are kept; Retry runs the check again.',
      ),
      findsOneWidget,
    );
    expect(find.text('0:12'), findsOneWidget);
  });

  testWidgets('a failure the machine reported at once has only its words', (
    tester,
  ) async {
    await _show(
      tester,
      _run([_at('failed', 2, detail: 'kicad-cli not found')]),
    );
    final failure = find.byKey(const Key('dsh-install-failure'));
    expect(
      find.descendant(of: failure, matching: find.text('kicad-cli not found')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: failure, matching: find.byType(SelectableText)),
      findsNothing,
      reason: 'no command to offer for a failure it does not know',
    );
    for (final step in [
      'Fetch Marp',
      'Set up the toolchain',
      'Check this machine',
    ]) {
      expect(_markOf(tester, step), _Mark.pending, reason: step);
    }
  });

  group('describeInstallFailure', () {
    InstallFailure describe({List<String> lines = const [], String? detail}) {
      final run = DshInstallRun('a/b', startedAt: _t0);
      for (final line in lines) {
        run.apply(DshInstallProgress(id: 'a/b', phase: 'doctor', line: line));
      }
      run.apply(DshInstallProgress(id: 'a/b', phase: 'failed', detail: detail));
      return describeInstallFailure(run, 'Typst');
    }

    test('the known misses become a sentence and a command', () {
      final claude = describe(detail: 'ok tmux · miss claude not on PATH');
      expect(claude.title, 'Claude Code is not installed on this machine.');
      expect(claude.body, 'Typst runs on Claude Code. Install it, then retry.');
      expect(claude.command, 'npm install -g @anthropic-ai/claude-code');

      final uv = describe(lines: ['miss uv (https://docs.astral.sh/uv)']);
      expect(uv.title, 'uv is not installed on this machine.');
      expect(uv.command, 'curl -LsSf https://astral.sh/uv/install.sh | sh');

      final node = describe(lines: ['ok git', 'miss node 18.2 < 22']);
      expect(node.title, 'Node.js is missing or too old.');
      expect(node.body, 'node 18.2 < 22');
      expect(node.command, 'brew install node@22');
    });

    test('a slow check and a failed download are said plainly', () {
      final slow = describe(detail: 'doctor still running after 300s');
      expect(slow.title, 'The check is taking longer than five minutes.');
      expect(slow.command, isNull);

      final clone = describe(detail: 'git clone exited 128');
      expect(clone.title, 'Could not download Typst.');
      expect(clone.body, 'git clone exited 128');

      final fetch = describe(detail: 'fetch: clone timed out');
      expect(fetch.title, 'Could not download Typst.');
    });

    test('anything else is shown as the machine wrote it', () {
      final unknown = describe(detail: 'disk full');
      expect(unknown.title, 'disk full');
      expect(unknown.body, isNull);
      expect(unknown.command, isNull);
      expect(describe().title, 'Install failed');
    });
  });
}
