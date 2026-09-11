import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/autonomous_device/autonomous_device_cli.dart';
import 'package:harness/shared/widgets/app_icon_button.dart';
import 'package:harness/shared/widgets/app_select_field.dart';
import 'package:harness/shared/widgets/skeleton.dart';
import 'package:harness/shared/widgets/setting_row.dart';
import 'package:harness/settings/sections/devices_section.dart';

class FakeAutonomousDeviceCli extends AutonomousDeviceCli {
  bool unsupported = false;
  int statusCalls = 0;
  Completer<void>? statusWait;
  String? pairFailure;
  List<Map<String, dynamic>> discovered = [
    {'id': 'device-1', 'name': 'Kitchen', 'host': '192.168.1.2', 'port': 5000},
  ];
  List<Map<String, dynamic>> devices = [];
  final submissions = <Map<String, dynamic>>[];
  final revoked = <String>[];
  @override
  Future<Map<String, dynamic>> status() async {
    statusCalls++;
    if (statusWait != null) await statusWait!.future;
    if (unsupported) {
      throw const AutonomousDeviceCliException('NOT_FOUND', 'Unsupported CLI');
    }
    return {'transport': 'direct', 'connected': true, 'paired': devices.length};
  }

  @override
  Future<Map<String, dynamic>> list() async => {'devices': devices};
  @override
  Future<Map<String, dynamic>> discover() async => {'devices': discovered};
  @override
  Future<Map<String, dynamic>> pair({
    required String code,
    required String deviceId,
  }) async {
    submissions.add({'code': code, 'deviceId': deviceId});
    if (pairFailure != null) {
      throw AutonomousDeviceCliException('CODE_MISMATCH', pairFailure!);
    }
    // The real CLI persists the trust, so the next `list` is what reports it.
    devices.add({
      'id': 'fingerprint-$deviceId',
      'fingerprint': 'fingerprint-$deviceId',
      'label': 'Autonomous device',
      'online': true,
    });
    return {
      'state': 'paired',
      'label': 'Autonomous device',
      'fingerprint': 'fingerprint-$deviceId',
    };
  }

  @override
  Future<Map<String, dynamic>> revoke(String id) async {
    revoked.add(id);
    devices.removeWhere((device) => device['id'] == id);
    return {'revoked': 1};
  }
}

void main() {
  Future<void> open(WidgetTester tester, FakeAutonomousDeviceCli cli) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: DevicesSection(cli: cli)),
      ),
    );
    await tester.pumpAndSettle();
  }

  final codeField = find.byKey(const Key('autonomous-device-code'));
  Future<void> select(WidgetTester tester, String id) async {
    tester
        .widget<AppSelectField<String?>>(
          find.byKey(const Key('autonomous-device-selection')),
        )
        .onChanged(id);
    await tester.pumpAndSettle();
  }

  Future<void> submit(WidgetTester tester, String code) async {
    await tester.enterText(codeField, code);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
  }

  Future<void> refresh(WidgetTester tester) async {
    await tester.ensureVisible(find.byType(AppIconButton));
    await tester.tap(find.byType(AppIconButton));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'code input and discovery are immediate without address or intent',
    (tester) async {
      await open(tester, FakeAutonomousDeviceCli());
      expect(codeField, findsOneWidget);
      expect(
        find.textContaining('Separators are allowed, for example ABC-123.'),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('autonomous-device-selection')),
        findsOneWidget,
      );
      expect(find.byType(SettingRow), findsOneWidget);
      expect(find.text('Pair'), findsOneWidget);
      expect(find.text('Refresh'), findsNothing);
      expect(find.text('Pair an Autonomous device'), findsNothing);
      expect(find.text('Computer address'), findsNothing);
      expect(find.text('Cancel pairing'), findsNothing);
    },
  );
  testWidgets('pairing controls align with the title and explain persistence', (
    tester,
  ) async {
    await open(tester, FakeAutonomousDeviceCli());
    final title = find.text('Pair a device');
    final selection = find.byKey(const Key('autonomous-device-selection'));
    expect(
      tester.getTopLeft(selection).dy,
      closeTo(tester.getTopLeft(title).dy, 1),
    );
    expect(
      find.text(
        'Harness CLI keeps the connection running when you close Desktop.',
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
  testWidgets('an existing pairing makes the form an addition', (tester) async {
    final cli = FakeAutonomousDeviceCli();
    await open(tester, cli);
    expect(find.text('Pair a device'), findsOneWidget);
    // The CLI keeps every pairing, so the form adds rather than replaces.
    cli.devices = [
      {
        'id': 'fingerprint-1',
        'fingerprint': 'fingerprint-1',
        'label': 'Kitchen',
        'online': true,
      },
    ];
    await tester.tap(find.byType(AppIconButton));
    await tester.pumpAndSettle();
    expect(find.text('Pair another device'), findsOneWidget);
    expect(find.text('Pair a device'), findsNothing);
  });

  testWidgets('single discovered device still requires explicit selection', (
    tester,
  ) async {
    final cli = FakeAutonomousDeviceCli();
    await open(tester, cli);
    await submit(tester, 'ABC234');
    expect(cli.submissions, isEmpty);
    expect(
      find.text('Select your discovered Autonomous device first.'),
      findsOneWidget,
    );
  });
  testWidgets(
    'normalizes original Harness code and binds selected discovery identity',
    (tester) async {
      final cli = FakeAutonomousDeviceCli();
      await open(tester, cli);
      await select(tester, 'device-1');
      await submit(tester, 'o-i_l·u23');
      expect(cli.submissions, [
        {'code': '011V23', 'deviceId': 'device-1'},
      ]);
      expect(tester.widget<TextField>(codeField).controller!.text, isEmpty);
      expect(find.text('Connected · fingerprint-device-1'), findsOneWidget);
    },
  );
  testWidgets('changing selected device clears typed code', (tester) async {
    final cli = FakeAutonomousDeviceCli()
      ..discovered.add({'id': 'device-2', 'name': 'Desk'});
    await open(tester, cli);
    await select(tester, 'device-1');
    await tester.enterText(codeField, 'ABC234');
    await select(tester, 'device-2');
    expect(tester.widget<TextField>(codeField).controller!.text, isEmpty);
  });
  testWidgets('lost discovery clears selection and never retargets code', (
    tester,
  ) async {
    final cli = FakeAutonomousDeviceCli();
    await open(tester, cli);
    await select(tester, 'device-1');
    await tester.enterText(codeField, 'ABC234');
    cli.discovered = [
      {'id': 'device-2', 'name': 'Desk'},
    ];
    await refresh(tester);
    expect(tester.widget<TextField>(codeField).controller!.text, isEmpty);
    expect(
      tester
          .widget<AppSelectField<String?>>(
            find.byKey(const Key('autonomous-device-selection')),
          )
          .value,
      isNull,
    );
    expect(cli.submissions, isEmpty);
  });
  testWidgets('code mismatch persists through successful status refresh', (
    tester,
  ) async {
    final cli = FakeAutonomousDeviceCli()..pairFailure = 'CODE_MISMATCH';
    await open(tester, cli);
    await select(tester, 'device-1');
    await submit(tester, 'ABC234');
    await refresh(tester);
    expect(
      find.text(
        'That code did not match. Generate a new code on your Autonomous device, then try again.',
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'revocation confirms and targets the exact existing trust fingerprint',
    (tester) async {
      final cli = FakeAutonomousDeviceCli()
        ..devices = [
          {
            'id': 'fingerprint-1',
            'fingerprint': 'fingerprint-1',
            'label': 'Kitchen',
            'online': true,
          },
          {
            'id': 'fingerprint-2',
            'fingerprint': 'fingerprint-2',
            'label': 'Desk',
            'online': false,
          },
        ];
      await open(tester, cli);
      await tester.tap(find.text('Revoke').first);
      await tester.pumpAndSettle();
      expect(cli.revoked, isEmpty);
      await tester.tap(find.byKey(const Key('device-confirm')));
      await tester.pumpAndSettle();
      expect(cli.revoked, ['fingerprint-1']);
      expect(cli.devices.single['id'], 'fingerprint-2');
    },
  );

  testWidgets(
    'empty discovery gives network guidance without implicit target',
    (tester) async {
      final cli = FakeAutonomousDeviceCli()..discovered = [];
      await open(tester, cli);
      expect(
        find.textContaining('No Autonomous devices found.'),
        findsOneWidget,
      );
      await submit(tester, 'ABC234');
      expect(cli.submissions, isEmpty);
    },
  );
  testWidgets(
    'retry after mismatch pairs the same explicitly selected device',
    (tester) async {
      final cli = FakeAutonomousDeviceCli()..pairFailure = 'CODE_MISMATCH';
      await open(tester, cli);
      await select(tester, 'device-1');
      await submit(tester, 'ABC234');
      cli.pairFailure = null;
      await submit(tester, 'DEF567');
      expect(cli.submissions.map((row) => row['deviceId']), [
        'device-1',
        'device-1',
      ]);
      expect(
        find.text(
          'That code did not match. Generate a new code on your Autonomous device, then try again.',
        ),
        findsNothing,
      );
      expect(find.text('Connected · fingerprint-device-1'), findsOneWidget);
    },
  );

  testWidgets('unsupported CLI offers update guidance', (tester) async {
    await open(tester, FakeAutonomousDeviceCli()..unsupported = true);
    expect(
      find.text('Update Harness CLI to use Autonomous devices.'),
      findsOneWidget,
    );
    expect(codeField, findsNothing);
  });

  testWidgets('default construction never invokes a real CLI', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: DevicesSection())),
    );
    await tester.pumpAndSettle();
    await tester.pump(const Duration(minutes: 2));
    expect(tester.takeException(), isNull);
    expect(
      tester.widget<AppIconButton>(find.byType(AppIconButton)).onPressed,
      isNull,
    );
  });

  testWidgets('injected CLI has no background polling in tests', (
    tester,
  ) async {
    final cli = FakeAutonomousDeviceCli();
    await open(tester, cli);
    await tester.pump(const Duration(minutes: 2));
    expect(cli.statusCalls, 1);
  });

  testWidgets('first status request has a skeleton', (tester) async {
    final pending = Completer<void>();
    final cli = FakeAutonomousDeviceCli()..statusWait = pending;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: DevicesSection(cli: cli)),
      ),
    );
    await tester.pump();
    expect(find.byType(SkeletonBlock), findsOneWidget);
    pending.complete();
    await tester.pumpAndSettle();
    expect(find.byType(SkeletonBlock), findsNothing);
  });

  test('real CLI is unavailable under tests', () async {
    await expectLater(
      AutonomousDeviceCli().status(),
      throwsA(isA<AutonomousDeviceCliException>()),
    );
  });

  test('pair code travels only through stdin and selected discovery identity is bound', () async {
    final cli = RecordingAutonomousDeviceCli();
    await cli.pair(code: 'ABC234', deviceId: 'device-1');
    expect(cli.arguments, ['--code-stdin', '--device', 'device-1']);
    expect(cli.arguments.join(' '), isNot(contains('ABC234')));
    expect(cli.secret, 'ABC234');
  });
}

class RecordingAutonomousDeviceCli extends AutonomousDeviceCli {
  List<String> arguments = [];
  String? secret;
  @override
  Future<Map<String, dynamic>> command(
    String operation, {
    List<String> arguments = const [],
    String? secretStdin,
  }) async {
    this.arguments = arguments;
    secret = secretStdin;
    return {'state': 'paired'};
  }
}
