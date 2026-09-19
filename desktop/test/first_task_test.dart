// What a machine accepts as a first task, as this app knows it: the engines
// that take one and how long it may be. Both are the CLI's to decide, so both
// are read back from its source here — a CLI that learns a new engine's first
// message, or a new limit, fails this test until the app says the same.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/first_task.dart';
import 'package:harness/widgets/engine_identity.dart';

void main() {
  final source = File('../cli/src/lib/engineLaunch.ts').readAsStringSync();

  test('the engines that take a first task are the CLI\'s', () {
    final table = RegExp(
      r'export const FIRST_PROMPT_ARGS[^=]*=\s*\{(.*?)\n\}',
      dotAll: true,
    ).firstMatch(source);
    expect(
      table,
      isNotNull,
      reason: 'FIRST_PROMPT_ARGS moved or changed shape',
    );
    final entries = {
      for (final m in RegExp(
        r'^\s*([a-z]+):\s*(null|\[)',
        multiLine: true,
      ).allMatches(table!.group(1)!))
        m.group(1)!: m.group(2) != 'null',
    };
    expect(entries, isNotEmpty);
    expect({
      for (final e in entries.entries)
        if (e.value) e.key,
    }, kFirstTaskEngines);
    // Every engine this app offers is in the CLI's table, one way or the other.
    for (final engine in allEngines) {
      expect(entries.keys, contains(engine.id), reason: engine.id);
      expect(takesFirstTask(engine.id), entries[engine.id], reason: engine.id);
    }
  });

  test('the longest first task is the CLI\'s', () {
    final limit = RegExp(r'export const MAX_FIRST_PROMPT_CHARS = (\d+)')
        .firstMatch(source);
    expect(limit, isNotNull);
    expect(kFirstTaskMaxLength, int.parse(limit!.group(1)!));
  });
}
