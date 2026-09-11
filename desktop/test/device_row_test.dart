// The dial's row on the rail's floor: one row, three readings, decided by two facts.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/dial_status.dart';
import 'package:harness/widgets/device_row.dart';

class _MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

AppNotifier _notifier() => AppNotifier(
  config: AppConfig.dev,
  authSession: AuthSession(),
  configStore: null,
);

Future<void> _pump(WidgetTester tester, AppNotifier notifier) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SizedBox(width: 264, child: DeviceRow(notifier: notifier)),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('never seen one: the row is the way to get one', (tester) async {
    final notifier = _notifier();
    await _pump(tester, notifier);
    expect(find.textContaining('Get the device'), findsOneWidget);
    expect(find.byIcon(Icons.chevron_right), findsNothing);
  });

  testWidgets('plugged in: the name alone, and a way to its status', (
    tester,
  ) async {
    // No version, no port on the row — the green ring already says "here", and
    // the card this opens carries the rest.
    final notifier = _notifier();
    notifier.dial.apply(const DialStatus(attached: true, fw: '0.0.58'));
    await _pump(tester, notifier);
    expect(find.text('Harness device'), findsOneWidget);
    expect(find.textContaining('0.0.58'), findsNothing);
    expect(find.textContaining('Get the device'), findsNothing);
    expect(find.byIcon(Icons.chevron_right), findsOneWidget);

    await tester.tap(find.byKey(const Key('device-row')));
    await tester.pumpAndSettle();
    // One rich line: state, then the version in a heavier ink.
    expect(
      find.textContaining('Connected via USB', findRichText: true),
      findsOneWidget,
    );
    expect(find.textContaining('0.0.58', findRichText: true), findsOneWidget);
    expect(find.text('Settings are on the device'), findsOneWidget);
  });

  testWidgets('unplugged after being seen: told so, not sold another', (
    tester,
  ) async {
    final notifier = _notifier();
    notifier.dial.apply(const DialStatus(attached: true, fw: '0.0.58'));
    notifier.dial.apply(DialStatus.none);
    await _pump(tester, notifier);
    expect(find.text('Harness device · unplugged'), findsOneWidget);
    expect(find.textContaining('Get the device'), findsNothing);
  });

  testWidgets('an update in flight says the one thing that matters', (
    tester,
  ) async {
    final notifier = _notifier();
    notifier.dial.apply(
      const DialStatus(attached: true, fw: '0.0.57', updating: '0.0.58'),
    );
    await _pump(tester, notifier);
    await tester.tap(find.byKey(const Key('device-row')));
    await tester.pumpAndSettle();
    expect(find.text('Keep it plugged in'), findsOneWidget);
    expect(
      find.textContaining('updating to 0.0.58', findRichText: true),
      findsOneWidget,
    );
  });

  test(
    '"seen" is remembered across launches, and only ever set by a real dial',
    () async {
      final store = _MemoryStore();
      final state = DialState(store);
      await state.restore();
      expect(state.seen, isFalse);

      state.apply(DialStatus.none);
      expect(store.values, isEmpty, reason: 'nothing seen yet');

      state.apply(const DialStatus(attached: true));
      await Future<void>.delayed(Duration.zero);
      expect(store.values['dial_seen'], '1');

      final later = DialState(store);
      await later.restore();
      expect(later.seen, isTrue);
    },
  );

  test('the frame is read with is, never as', () {
    expect(
      DialStatus.fromJson({'attached': true, 'fw': '0.0.58'}).fw,
      '0.0.58',
    );
    final junk = DialStatus.fromJson({
      'attached': 'yes',
      'fw': 7,
      'updating': '',
    });
    expect(junk.attached, isFalse);
    expect(junk.fw, isNull);
    expect(junk.updating, isNull);
  });
}
