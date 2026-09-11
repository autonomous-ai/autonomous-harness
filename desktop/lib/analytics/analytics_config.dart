import 'dart:io';

import 'package:flutter/foundation.dart';

import '../core/test_run.dart';

/// Where behavioural events go, whether they go at all, and under what limits.
///
/// The destination is **Autonomous Analytics** — the same event stream the
/// website and the Grid desktop app report into. Sharing the destination is the
/// point: someone who read the site, installed Grid and then installed Harness
/// is one funnel, not three datasets that can never be joined. [category] is
/// what keeps them apart within it.
///
/// ⚠️ **This app reports under GRID's write key, not one of its own.** The
/// constant below is the same one `autonomous-grid-app` ships, so both desktop
/// apps append into the same analytics project. That is a deliberate stopgap —
/// a muted stream measures nothing, and this app has been waiting on a key of
/// its own since the port — but the cost is real and worth stating: the two
/// apps are then separable **only by [category]** (`harness-desktop` against
/// Grid's `grid-app`, stamped on every event), not at the source. Anyone
/// reading the Grid project sees this app's events inside it, and anything set
/// per project — a quota, a retention rule, a rotated or revoked key — lands on
/// both apps at once.
///
/// TODO(BE): swap in a Harness Desktop key from the analytics owner. It is a
/// one-constant change here, and it is the only thing that separates the two
/// streams properly.
///
/// The key is a *write* key rather than a secret. The website ships the same
/// kind of key in its public JS bundle, a desktop binary can be unpacked either
/// way, and it only lets the holder append events.
class AnalyticsConfig {
  const AnalyticsConfig({
    required this.endpoint,
    required this.writeKey,
    this.offReason,
  });

  /// The full `…/api/v1/event_tracking` URL one event is POSTed to. Autonomous
  /// Analytics takes a single event per request — there is no batch route — so
  /// the queue sends serially rather than in batches.
  final Uri endpoint;

  /// Sent verbatim as `Authorization`, with no `Bearer` prefix — that is what
  /// the web client does and what the server reads.
  final String writeKey;

  /// Why nothing is being sent, or null when the stream is live. A sentence
  /// rather than a bool, because it is the answer to "why is nothing arriving"
  /// and a developer can lose an hour to that question.
  final String? offReason;

  /// Whether events are queued and sent at all.
  bool get enabled => offReason == null;

  /// Stamped on every event, so this app's stream stays separable from Grid's
  /// and the website's inside the shared project. Grid sends `grid-app`.
  static const String category = 'harness-desktop';

  /// Env var / `--dart-define` names. The URL and key overrides are dev-only so
  /// a shipped build always reports to production; [disableEnvKey] is honoured
  /// everywhere, because a user who wants to be left alone has to be able to
  /// say so in a release build.
  static const String urlEnvKey = 'HARNESS_ANALYTICS_URL';
  static const String keyEnvKey = 'HARNESS_ANALYTICS_KEY';
  static const String disableEnvKey = 'HARNESS_ANALYTICS_DISABLED';

  // `String.fromEnvironment` needs a const literal, so the names above can't be
  // used here — keep the two in step by hand.
  static const String _urlDefine = String.fromEnvironment(
    'HARNESS_ANALYTICS_URL',
  );
  static const String _keyDefine = String.fromEnvironment(
    'HARNESS_ANALYTICS_KEY',
  );

  static const String _defaultBaseUrl =
      'https://autonomous-analytics-qffztaoryq-uc.a.run.app/api/v1';
  static const String _path = 'event_tracking';

  /// Borrowed from Grid until this app has its own — see the class TODO(BE).
  /// Keep it byte-for-byte equal to `autonomous-grid-app`'s
  /// `AnalyticsConfig._defaultWriteKey`; a copy that drifts sends this app's
  /// events to a project nobody is reading.
  static const String _defaultWriteKey = 'tBCs0oLwgFgf1borYn54cjHz4fvWahyV';

  /// The live configuration, from the environment alone.
  static AnalyticsConfig resolve() {
    final base = (_devOverride(urlEnvKey) ?? _defaultBaseUrl).replaceFirst(
      RegExp(r'/+$'),
      '',
    );
    final key = _devOverride(keyEnvKey) ?? _defaultWriteKey;
    return AnalyticsConfig(
      endpoint: Uri.parse('$base/$_path'),
      writeKey: key,
      offReason: _offReason(key),
    );
  }

  static String? _offReason(String key) {
    if (key.isEmpty) {
      return 'This build carries no analytics key '
          '(set $keyEnvKey to turn the stream on).';
    }
    if (_muted) return '$disableEnvKey is set in this environment.';
    if (_underTest) return 'Running under flutter test.';
    return null;
  }

  /// True when `HARNESS_ANALYTICS_DISABLED` is set to anything truthy.
  static bool get _muted {
    final value = Platform.environment[disableEnvKey]?.toLowerCase().trim();
    return value == '1' || value == 'true' || value == 'yes';
  }

  /// Tests here build a real `AppNotifier` and drive real controllers, so one
  /// that happens to track an event must not open a socket or touch
  /// `~/.harness` to do it. See [kUnderTest] for the whole of why.
  static bool get _underTest => kUnderTest;

  /// [key]'s override — `--dart-define` first, then the process env — ignored
  /// in release so a shipped build can only ever report to production.
  static String? _devOverride(String key) {
    if (kReleaseMode) return null;
    final define = switch (key) {
      urlEnvKey => _urlDefine,
      keyEnvKey => _keyDefine,
      _ => '',
    };
    if (define.isNotEmpty) return define;
    final value = Platform.environment[key];
    return (value != null && value.isNotEmpty) ? value : null;
  }
}

/// The limits the queue and the payload are held to.
///
/// [sessionIdle] matches the website's and Grid's 15 minutes on purpose: a
/// "visit" has to mean the same span everywhere or the streams cannot be
/// compared. The rest are a desktop app's own — one quit offline and reopened
/// on a plane needs a bounded queue and a backoff, which a page that unloads
/// after a few minutes never did.
class AnalyticsLimits {
  const AnalyticsLimits._();

  /// Events kept while the server is unreachable. Past this the oldest go —
  /// a full queue is a signal, and the newest events describe it best.
  static const int queueCap = 500;

  /// Params per event, and the length of any one string value. The backend
  /// truncates and drops on its own; doing it here keeps what we send and what
  /// lands identical, so a value read back in analysis is the value we meant.
  static const int paramsMaxKeys = 40;
  static const int paramsMaxStringLength = 500;

  /// How long a visit survives without an event before a new one starts.
  static const Duration sessionIdle = Duration(minutes: 15);

  static const Duration requestTimeout = Duration(seconds: 10);

  /// First retry delay, doubled up to [retryDelayMax] while sends keep failing.
  static const Duration retryDelay = Duration(seconds: 2);
  static const Duration retryDelayMax = Duration(minutes: 2);

  /// How long a quit waits for the queue to drain. A wedged network must never
  /// be what keeps the window on screen after the user pressed ⌘Q.
  static const Duration closeDeadline = Duration(seconds: 3);
}
