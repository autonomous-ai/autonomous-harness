import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/widgets/status_rail/usage_panel.dart';
import 'package:harness/usage/claude_usage_source.dart';
import 'package:harness/usage/codex_usage_source.dart';
import 'package:harness/usage/usage_credentials.dart';
import 'package:harness/usage/usage_controller.dart';
import 'package:harness/usage/usage_source.dart';
import 'package:harness/usage/usage_accounts.dart';
import 'package:harness/usage/usage_window.dart';

/// A Dio that answers every request with one canned payload, so a source can be
/// exercised without a socket or a credential.
Dio _dioAnswering(Object? body, {int status = 200}) {
  final dio = Dio(
    BaseOptions(validateStatus: (s) => s != null && s >= 200 && s < 600),
  );
  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) => handler.resolve(
        Response<Object?>(
          requestOptions: options,
          statusCode: status,
          data: body,
        ),
      ),
    ),
  );
  return dio;
}

/// Credentials backed by a throwaway home directory, read the same way on
/// every platform this app ships to.
///
/// The token goes in the FILE, never through the stubbed keychain. An earlier
/// version supplied it as fake `security` output, which passed here and failed
/// on the Linux CI: `UsageCredentials` reads the Keychain only on macOS, so on
/// Linux the stub was never called and every one of these tests saw an account
/// with no session. Linux is a released target, not a second-class one, and a
/// helper that only works on the author's laptop hides exactly this.
///
/// The keychain stub stays, and always fails, for the opposite reason: without
/// it a macOS run would shell out to the real `security` and read whoever is
/// signed in on the machine.
UsageCredentials _creds({String? claudeJson, String? codexJson}) {
  final dir = Directory.systemTemp.createTempSync('harness-usage-test');
  addTearDown(() => dir.deleteSync(recursive: true));
  void write(String folder, String file, String body) {
    Directory('${dir.path}/$folder').createSync();
    File('${dir.path}/$folder/$file').writeAsStringSync(body);
  }

  if (claudeJson != null) write('.claude', '.credentials.json', claudeJson);
  if (codexJson != null) write('.codex', 'auth.json', codexJson);
  return UsageCredentials(
    home: dir.path,
    runProcess: (_, _) async => ProcessResult(0, 1, '', ''),
  );
}

void main() {
  group('reset timestamps', () {
    test('seconds and milliseconds are told apart by magnitude', () {
      final seconds = parseResetTimestamp(1770000000);
      final millis = parseResetTimestamp(1770000000000);
      // 1e10 sits between any plausible seconds epoch and any plausible
      // millisecond one, so both must land on the same instant.
      expect(seconds, millis);
    });

    test(
      'an ISO string is read, and nonsense is null rather than epoch zero',
      () {
        expect(
          parseResetTimestamp('2026-09-08T12:00:00Z'),
          DateTime.utc(2026, 9, 8, 12),
        );
        expect(parseResetTimestamp('not a date'), isNull);
        expect(parseResetTimestamp(null), isNull);
        expect(parseResetTimestamp(''), isNull);
      },
    );
  });

  group('used percent', () {
    test('the first field that is actually a number wins', () {
      expect(parseUsedPercent([null, 'x', 16]), 16);
      expect(parseUsedPercent([null, 'x']), isNull);
    });

    test(
      'a figure outside 0-100 is clamped, not drawn off the end of the bar',
      () {
        expect(parseUsedPercent([140]), 100);
        expect(parseUsedPercent([-3]), 0);
      },
    );
  });

  group('countdown', () {
    final now = DateTime(2026, 9, 8, 12);
    UsageWindow at(Duration left) =>
        UsageWindow(label: 'w', usedPercent: 1, resetsAt: now.add(left));

    test('reads in the largest two units that still say something', () {
      expect(at(const Duration(minutes: 43)).resetsInLabel(now: now), '43m');
      expect(
        at(const Duration(hours: 4, minutes: 34)).resetsInLabel(now: now),
        '4h 34m',
      );
      expect(
        at(const Duration(days: 5, hours: 11)).resetsInLabel(now: now),
        '5d 11h',
      );
    });

    test(
      'a window with no reset time, or one already past, counts nothing',
      () {
        // Null is not zero: "resets in 0m" would be a measurement invented out
        // of a silence.
        expect(
          const UsageWindow(label: 'Fable', usedPercent: 0).resetsInLabel(),
          isNull,
        );
        expect(at(const Duration(seconds: -5)).resetsInLabel(now: now), isNull);
      },
    );
  });

  test('the tightest window is the one closest to stopping the work', () {
    const reading = ProviderUsage(
      provider: UsageProvider.claude,
      status: UsageStatus.ok,
      windows: [
        UsageWindow(label: 'Session', usedPercent: 2),
        UsageWindow(label: 'Weekly', usedPercent: 16),
      ],
    );
    expect(reading.tightest?.label, 'Weekly');
  });

  test('the rail prints the weekly window, not the tightest one', () {
    // Two different questions. `tightest` is the limit that will stop the work
    // first; the rail wants the one worth a GLANCE, and the five-hour window
    // refills all day — it is back to nothing by the time anybody reads it.
    const reading = ProviderUsage(
      provider: UsageProvider.claude,
      status: UsageStatus.ok,
      windows: [
        UsageWindow(label: 'Session', usedPercent: 88),
        UsageWindow(label: kWeeklyWindowLabel, usedPercent: 42),
      ],
    );
    expect(reading.tightest?.label, 'Session');
    expect(reading.railWindow?.label, kWeeklyWindowLabel);
  });

  test('a provider with no weekly window still prints one figure', () {
    // One figure is the rule, and a blank strip would be a worse answer than
    // the wrong window.
    const reading = ProviderUsage(
      provider: UsageProvider.codex,
      status: UsageStatus.ok,
      windows: [
        UsageWindow(label: '5h', usedPercent: 30),
        UsageWindow(label: '30d', usedPercent: 61),
      ],
    );
    expect(reading.railWindow?.label, '30d');
    expect(
      const ProviderUsage(
        provider: UsageProvider.codex,
        status: UsageStatus.ok,
      ).railWindow,
      isNull,
    );
  });

  group('Claude source', () {
    test('maps the three windows the CLI itself shows', () async {
      final source = ClaudeUsageSource(
        dio: _dioAnswering({
          'five_hour': {'utilization': 2, 'resets_at': 1770000000},
          'seven_day': {'used_percentage': 16},
          'fable_weekly': {'utilization': 0},
        }),
        credentials: _creds(
          claudeJson: '{"claudeAiOauth":{"accessToken":"t"}}',
        ),
      );
      final reading = await source.read();

      expect(reading.status, UsageStatus.ok);
      expect(
        reading.windows.map((w) => '${w.label} ${w.usedPercent.round()}'),
        ['Session 2', 'Weekly 16', 'Fable 0'],
      );
      // Shortest window first, because that is the one about to bite.
      expect(reading.windows.first.label, 'Session');
    });

    test('Fable is found under any of the three names it has had', () async {
      for (final key in [
        'fable_weekly',
        'fable_seven_day',
        'seven_day_fable',
      ]) {
        final source = ClaudeUsageSource(
          dio: _dioAnswering({
            key: {'utilization': 7},
          }),
          credentials: _creds(
            claudeJson: '{"claudeAiOauth":{"accessToken":"t"}}',
          ),
        );
        final reading = await source.read();
        expect(reading.windows.single.label, 'Fable', reason: key);
      }
    });

    test('no credential is a sign-in, not a failure', () async {
      final reading = await ClaudeUsageSource(
        dio: _dioAnswering(const {}),
        credentials: _creds(),
      ).read();
      // Retrying a sign-out fails identically forever, so the two states must
      // not render the same.
      expect(reading.status, UsageStatus.signedOut);
    });

    test(
      'an expired token is spent as a sign-in, not as a round trip',
      () async {
        var called = false;
        final dio = _dioAnswering(const {});
        dio.interceptors.add(
          InterceptorsWrapper(
            onRequest: (o, h) {
              called = true;
              h.next(o);
            },
          ),
        );
        final reading = await ClaudeUsageSource(
          dio: dio,
          credentials: _creds(
            claudeJson: '{"claudeAiOauth":{"accessToken":"t","expiresAt":1}}',
          ),
        ).read();

        expect(reading.status, UsageStatus.signedOut);
        expect(called, isFalse);
      },
    );

    test('a 401 is a sign-in and a 500 is a failure', () async {
      Future<UsageStatus> statusFor(int code) async => (await ClaudeUsageSource(
        dio: _dioAnswering(const {}, status: code),
        credentials: _creds(
          claudeJson: '{"claudeAiOauth":{"accessToken":"t"}}',
        ),
      ).read()).status;

      expect(await statusFor(401), UsageStatus.signedOut);
      expect(await statusFor(500), UsageStatus.failed);
    });
  });

  group('Codex source', () {
    test('names each window by how long it actually is', () async {
      final source = CodexUsageSource(
        dio: _dioAnswering({
          'rate_limit': {
            'primary_window': {
              'used_percent': 9,
              'limit_window_seconds': 18000,
            },
            'secondary_window': {
              'used_percent': 40,
              'limit_window_seconds': 604800,
            },
          },
        }),
        credentials: _creds(
          codexJson: '{"tokens":{"access_token":"t","account_id":"acct"}}',
        ),
      );
      final reading = await source.read();

      expect(reading.status, UsageStatus.ok);
      // 18000s is 5h; 604800s is the week, which earns the name rather than
      // the arithmetic "7d".
      expect(reading.windows.map((w) => w.label), ['5h', 'Weekly']);
      expect(reading.windows.first.usedPercent, 9);
    });

    test(
      'a window whose duration was never sent is not given a made-up one',
      () async {
        final reading = await CodexUsageSource(
          dio: _dioAnswering({
            'rate_limit': {
              'primary_window': {'used_percent': 9},
            },
          }),
          credentials: _creds(
            codexJson: '{"tokens":{"access_token":"t","account_id":"acct"}}',
          ),
        ).read();

        // A confident "5h" beside a real percentage would be read as measured.
        expect(reading.windows.single.label, 'Limit');
      },
    );

    test('no auth.json is a sign-in, not a failure', () async {
      final reading = await CodexUsageSource(
        dio: _dioAnswering(const {}),
        credentials: _creds(),
      ).read();
      expect(reading.status, UsageStatus.signedOut);
    });
  });

  group('the bar', () {
    /// Pumps one window's row and hands back the fill as it was actually
    /// LAID OUT — [WidgetTester.getSize], not the `width` property of the
    /// widget that asked for it.
    ///
    /// The difference is the whole point. An earlier version of these tests
    /// read the properties, and passed against a bar whose fill was laid out
    /// zero pixels tall and therefore never appeared on screen: the tree said
    /// coral, the window drew nothing. A property is a request; only the size
    /// is an outcome.
    Future<({Size size, Color color})> fill(
      WidgetTester tester,
      double percent,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: SizedBox(
                // The width the rail actually opens this panel at.
                width: 248,
                child: UsagePanelContent(
                  accounts: [
                    UsageAccount(
                      isLocal: true,
                      reading: ProviderUsage(
                        provider: UsageProvider.claude,
                        status: UsageStatus.ok,
                        windows: [
                          UsageWindow(label: 'Session', usedPercent: percent),
                        ],
                        fetchedAt: DateTime.now(),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      final finder = find.byKey(const Key('usage-bar-fill'));
      final painted = tester.widget<ColoredBox>(
        find.descendant(of: finder, matching: find.byType(ColoredBox)),
      );
      return (size: tester.getSize(finder), color: painted.color);
    }

    testWidgets('a single-digit window still shows a band of colour', (
      tester,
    ) async {
      // The bug this guards: at the percentages these windows sit at for most
      // of their life, a strictly proportional fill is a couple of pixels and
      // reads as nothing at all.
      final small = await fill(tester, 2);
      expect(small.size.width, greaterThanOrEqualTo(4));
      // And it has to be tall enough to see, which is the half that silently
      // went missing: a fill laid out flat is present, correct and invisible.
      expect(small.size.height, 6);
    });

    testWidgets('an untouched window draws no fill at all', (tester) async {
      // Zero is the one case that must NOT be over-represented: a bar claiming
      // usage nobody spent is worse than a bar that is hard to see.
      expect((await fill(tester, 0)).size.width, 0);
    });

    testWidgets('the fill wears the account colour, and never a grey', (
      tester,
    ) async {
      final claude = await fill(tester, 30);
      expect(claude.color, engineIdentity('claude').color);
      // The mark at the top of the panel is drawn from the same source, so the
      // two cannot drift into two colours for one account.
      expect(
        claude.color.r == claude.color.g && claude.color.g == claude.color.b,
        isFalse,
      );
    });

    testWidgets('a nearly spent window stops wearing the account colour', (
      tester,
    ) async {
      final spent = await fill(tester, 92);
      expect(spent.color, isNot(engineIdentity('claude').color));
    });

    testWidgets('a full window fills the bar exactly, not past it', (
      tester,
    ) async {
      // The bar spans the panel, so a spent window's fill is the panel's own
      // width — and the clamp that widens small fills must not widen this one
      // past the track it sits in.
      final full = await fill(tester, 100);
      expect(full.size.width, 248);
      expect(full.size.height, 6);
    });
  });

  group('controller', () {
    test('a controller nobody started is not loading', () {
      // A rail that drew a skeleton for it would promise an answer that was
      // never coming.
      final controller = UsageController(sources: const [], autoStart: false);
      expect(controller.loading, isFalse);
      controller.dispose();
    });

    test('the last good reading survives a failed refresh, and goes stale', () async {
      final source = _SwitchableSource();
      final controller = UsageController(sources: [source], autoStart: false);

      await controller.refresh();
      expect(controller.answered.single.windows.single.usedPercent, 2);
      expect(controller.stale, isFalse);
      expect(controller.loading, isFalse);

      source.failing = true;
      await controller.refresh();

      // An account that answered a minute ago has not stopped existing because
      // one request timed out.
      expect(controller.stale, isTrue);
      controller.dispose();
    });
  });
}

/// A source that answers, and then stops answering.
class _SwitchableSource implements UsageSource {
  bool failing = false;

  @override
  UsageProvider get provider => UsageProvider.claude;

  @override
  Future<ProviderUsage> read() async => failing
      ? const ProviderUsage(
          provider: UsageProvider.claude,
          status: UsageStatus.failed,
          message: 'Could not reach Claude',
        )
      : ProviderUsage(
          provider: UsageProvider.claude,
          status: UsageStatus.ok,
          windows: const [UsageWindow(label: 'Session', usedPercent: 2)],
          fetchedAt: DateTime.now(),
        );
}
