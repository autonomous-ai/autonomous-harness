// A remote machine answers `usage_read` with its vendors' replies exactly as
// they came. What matters is that this build reads them with the same rules it
// reads its own — and that nothing a machine sends can make it throw.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/remote_usage.dart';
import 'package:harness/usage/usage_accounts.dart';
import 'package:harness/usage/usage_controller.dart';
import 'package:harness/usage/usage_source.dart';
import 'package:harness/usage/usage_window.dart';

class _StubUsageSource implements UsageSource {
  _StubUsageSource(this.reading);

  final ProviderUsage reading;

  @override
  UsageProvider get provider => reading.provider;

  @override
  Future<ProviderUsage> read() async => reading;
}

void main() {
  group('parseUsageReadResult', () {
    test('an answered reading is named by the same rules as this computer', () {
      final readings = parseUsageReadResult({
        'providers': [
          {
            'provider': 'claude',
            'account': 'k1',
            'outcome': 'answered',
            'httpStatus': 200,
            'body': {
              'five_hour': {'utilization': 12},
              'seven_day': {'utilization': 42},
            },
          },
        ],
      });

      final claude = readings.single;
      expect(claude.status, UsageStatus.ok);
      expect(claude.account, 'k1');
      // Claude's `seven_day` is the Weekly window here exactly as it is for
      // this computer's own reading — one mapper, two sources.
      expect(claude.railWindow?.label, kWeeklyWindowLabel);
      expect(claude.railWindow?.usedPercent, 42);
    });

    test('a vendor refusal is read the way this computer reads one', () {
      final readings = parseUsageReadResult({
        'providers': [
          {
            'provider': 'codex',
            'account': null,
            'outcome': 'answered',
            'httpStatus': 401,
            'body': {'error': 'unauthorized'},
          },
        ],
      });

      expect(readings.single.status, UsageStatus.signedOut);
    });

    test("the machine's own sentence survives a sign-out", () {
      final readings = parseUsageReadResult({
        'providers': [
          {
            'provider': 'claude',
            'account': 'k1',
            'outcome': 'signedOut',
            'message': 'Claude session expired — run claude to sign in again',
          },
        ],
      });

      expect(readings.single.status, UsageStatus.signedOut);
      expect(readings.single.message, contains('expired'));
    });

    test('an unreachable vendor is a failure, not a figure', () {
      final readings = parseUsageReadResult({
        'providers': [
          {'provider': 'codex', 'account': null, 'outcome': 'unreachable'},
        ],
      });

      expect(readings.single.status, UsageStatus.failed);
      expect(readings.single.hasFigures, isFalse);
    });

    test('what this build cannot read is dropped, not thrown', () {
      expect(parseUsageReadResult({}), isEmpty);
      expect(parseUsageReadResult({'providers': 'nope'}), isEmpty);
      expect(
        parseUsageReadResult({
          'providers': [
            'not a map',
            {'provider': 'gemini', 'outcome': 'answered'},
          ],
        }),
        isEmpty,
      );
    });
  });

  group('UsageController', () {
    ProviderUsage weekly(double percent, String account) => ProviderUsage(
      provider: UsageProvider.claude,
      status: UsageStatus.ok,
      windows: [UsageWindow(label: kWeeklyWindowLabel, usedPercent: percent)],
      account: account,
    );

    test('a remote machine on another account joins the view', () async {
      final controller = UsageController(
        sources: [_StubUsageSource(weekly(42, 'k1'))],
        remote: () async => [
          MachineUsage(machineName: 'box', readings: [weekly(71, 'k2')]),
        ],
        autoStart: false,
      );
      addTearDown(controller.dispose);

      await controller.refresh();

      expect(controller.accounts.map((a) => a.isLocal), [true, false]);
      // The notice and the offer read [readings], which stays this computer's.
      expect(controller.readings, hasLength(1));
    });

    test('a remote failure keeps the last good answer', () async {
      var fail = false;
      final controller = UsageController(
        sources: [_StubUsageSource(weekly(42, 'k1'))],
        remote: () async {
          if (fail) throw StateError('relay down');
          return [
            MachineUsage(machineName: 'box', readings: [weekly(71, 'k2')]),
          ];
        },
        autoStart: false,
      );
      addTearDown(controller.dispose);

      await controller.refresh();
      fail = true;
      await controller.refresh();

      expect(controller.accounts, hasLength(2));
    });
  });
}
