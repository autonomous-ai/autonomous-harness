// ⌘P — the ranking behind "go to an agent by name".
//
// Pinned here rather than through the widget, because "why did it not find my
// agent" is the one bug report a fuzzy list reliably generates, and the answer
// is always in these two functions.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/widgets/agent_switcher.dart';

Agent _agent(String id, String name) => Agent(
  id: id,
  sessionId: null,
  name: name,
  engine: 'claude',
  engineDisplayName: null,
  engineIconHint: null,
  codexHome: null,
  parentAgentId: null,
  status: 'running',
  launchState: 'ready',
  launchError: null,
  launchDetail: null,
  terminalAvailable: true,
);

SwitcherEntry _entry(
  String name, {
  String machine = 'MacBook-Pro.local',
  bool onGrid = false,
  String? id,
}) => SwitcherEntry(
  machineId: 'm1',
  machineName: machine,
  agent: _agent(id ?? name, name),
  onGrid: onGrid,
);

void main() {
  group('subsequenceSpread', () {
    test('an exact run is the tightest possible', () {
      expect(subsequenceSpread('frontend', 'front'), 4);
    });

    test('matches letters that are apart — this is fzf, not a substring', () {
      // The whole reason to use a subsequence: `frn` is what a hand types when
      // it is going fast, and a substring matcher answers "no such agent".
      expect(subsequenceSpread('frontend', 'frn'), isNotNull);
    });

    test('is null when a letter is missing, or out of order', () {
      expect(subsequenceSpread('frontend', 'frx'), isNull);
      expect(subsequenceSpread('frontend', 'nof'), isNull);
    });

    test('an empty query matches everything at zero', () {
      expect(subsequenceSpread('anything', ''), 0);
    });

    test('a tight match scores lower than a scattered one', () {
      // Which is the ranking: lower spread sorts first.
      final tight = subsequenceSpread('auth', 'ath')!;
      final scattered = subsequenceSpread('a big ugly thing', 'ath')!;
      expect(tight, lessThan(scattered));
    });
  });

  group('rankAgentsForSwitcher', () {
    test('with no query, the agents NOT on the grid come first', () {
      // Someone who opened this with an empty field is looking for something
      // they cannot already see.
      final rows = rankAgentsForSwitcher([
        _entry('alpha', onGrid: true),
        _entry('beta'),
      ], '');
      expect(rows.map((r) => r.agent.name), ['beta', 'alpha']);
    });

    test('drops what does not match at all', () {
      final rows = rankAgentsForSwitcher([
        _entry('frontend'),
        _entry('billing'),
      ], 'front');
      expect(rows.map((r) => r.agent.name), ['frontend']);
    });

    test('ranks the tighter match first', () {
      final rows = rankAgentsForSwitcher([
        _entry('a big ugly thing'),
        _entry('auth'),
      ], 'ath');
      expect(rows.first.agent.name, 'auth');
    });

    test('a query can name the MACHINE instead', () {
      // "mini auth" has to reach the Auth agent on the mac mini — two agents
      // with the same name on two computers are told apart by nothing else.
      final rows = rankAgentsForSwitcher([
        _entry('auth', machine: 'MacBook-Pro.local', id: 'a1'),
        _entry('auth', machine: 'mac-mini', id: 'a2'),
      ], 'mini');
      expect(rows, hasLength(1));
      expect(rows.first.agent.id, 'a2');
    });

    test('is case- and whitespace-insensitive', () {
      final rows = rankAgentsForSwitcher([_entry('Frontend')], '  FRONT ');
      expect(rows, hasLength(1));
    });

    test('keeps agents that are already on the grid', () {
      // Hiding them would make ⌘P useless for the very agents being worked on:
      // "where is it" and "is it open" are different questions.
      final rows = rankAgentsForSwitcher([
        _entry('auth', onGrid: true),
      ], 'auth');
      expect(rows, hasLength(1));
      expect(rows.first.onGrid, isTrue);
    });

    test('an empty roster is an empty list, not a throw', () {
      expect(rankAgentsForSwitcher(const [], 'anything'), isEmpty);
    });
  });
}
