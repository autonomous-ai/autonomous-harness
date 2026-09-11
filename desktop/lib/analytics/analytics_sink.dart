import 'dart:async';
import 'dart:ffi' show Abi;
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../logging/debug_surface.dart';
import 'analytics.dart';
import 'analytics_client.dart';
import 'analytics_config.dart';
import 'analytics_event.dart';
import 'analytics_identity.dart';
import 'analytics_log.dart';
import 'analytics_service.dart';

/// The app's one analytics sink.
///
/// A lazily-built singleton rather than a Riverpod provider, for the same
/// reason `terminalFontStore` is: the call sites have no
/// common ancestor short of `MaterialApp` — `main`, `AppNotifier`, a settings
/// pane, a menu item inside a pane header — and most of them are plain widgets
/// that were handed a notifier, not a `Ref`.
///
/// [NoopAnalytics] whenever tracking is off — no key in this build, the
/// environment muted it, the code is under `flutter test`, or the user opted
/// out in `~/.harness/desktop-app/analytics.json` — so a muted app and a test
/// run open no sockets at all rather than queueing into a void.
Analytics get analytics => _analytics ??= _build();

Analytics? _analytics;

/// Replaces the sink, for tests. Returns what was there, so a test can put it
/// back; passing null re-arms the lazy build.
@visibleForTesting
Analytics? setAnalyticsForTest(Analytics? value) {
  final previous = _analytics;
  _analytics = value;
  return previous;
}

Analytics _build() {
  // The environment is asked first, and on purpose: under `flutter test` this
  // returns before anything reads `~/.harness`, so a widget test that happens
  // to track an event touches neither the network nor a real Harness home.
  final config = AnalyticsConfig.resolve();
  if (config.offReason case final reason?) return _muted(reason);
  final identity = AnalyticsIdentityStore();
  if (identity.optedOut) return _muted(kAnalyticsOptedOutReason);
  return QueuedAnalytics(
    client: HttpAnalyticsClient(config),
    identityStore: identity,
    contextFuture: resolveAnalyticsContext(),
    userLookup: () => analyticsAccount.current,
    recorder: analyticsRecorder,
  );
}

/// A muted sink that still shows its work where there is a screen to show it
/// on, and a plain [NoopAnalytics] where there is not.
///
/// A build can be muted for four reasons — no key, `HARNESS_ANALYTICS_DISABLED`,
/// `flutter test`, or the user's own opt-out (see [AnalyticsConfig]) — and a
/// Tracking screen that were permanently empty for any of them is the exact
/// trap that screen exists to spring. Every event still lands in the list,
/// settled as `dropped` with [reason], which turns "nothing is arriving" into a
/// sentence.
///
/// Nothing recorded here leaves the machine: the buffer is in memory, and a
/// build with no [kDebugSurfaceEnabled] keeps none of it. That is what makes it
/// right to record even for a user who opted out — their choice is about what
/// we *send*, and this sends nothing.
Analytics _muted(String reason) => kDebugSurfaceEnabled
    ? MutedAnalytics(analyticsLog, reason)
    : const NoopAnalytics();

/// Where the queue reports its rows: this session's buffer where the Tracking
/// screen exists, nothing at all where it does not.
AnalyticsLog get analyticsRecorder =>
    kDebugSurfaceEnabled ? analyticsLog : const NoopAnalyticsLog();

/// Why a sink is muted when the user turned it off by hand.
const String kAnalyticsOptedOutReason =
    'Tracking is switched off in ~/.harness/desktop-app/analytics.json.';

/// [Analytics] that records what was tracked and sends none of it.
///
/// Not a subclass of [QueuedAnalytics] with the transport stubbed out: this
/// must not touch [AnalyticsIdentityStore], so a muted build reads no Harness
/// home and mints no ids for a stream that will never carry them.
class MutedAnalytics implements Analytics {
  MutedAnalytics(this.recorder, this.reason, {this.clock = DateTime.now});

  final AnalyticsLog recorder;

  /// The sentence the Tracking screen puts on every row, and the one its header
  /// card leads with.
  final String reason;

  final DateTime Function() clock;

  @override
  void track(String name, {Map<String, Object?> params = const {}}) {
    // Settled the instant it is queued: there is no wire and no retry, so a row
    // that sat at "Waiting" would be describing a queue that does not exist.
    recorder.settled(
      recorder.queued(name, params, clock()),
      AnalyticsEventStatus.dropped,
      note: reason,
    );
  }

  @override
  Future<void> flush() async {}

  @override
  Future<void> close() async {}
}

/// What the Tracking screen's header card reports: where events go, whether
/// they are going at all, and the two ids they are filed under.
@immutable
class AnalyticsStreamStatus {
  const AnalyticsStreamStatus({
    required this.endpoint,
    required this.offReason,
    required this.deviceId,
    required this.sessionId,
  });

  final Uri endpoint;

  /// Why nothing is being sent, or null when the stream is live.
  final String? offReason;

  final String deviceId;

  /// Empty until the first event of a launch has been tracked.
  final String sessionId;

  bool get enabled => offReason == null;
}

/// Reads the live configuration and the ids on disk.
///
/// Injected into the Tracking screen the way `probeDebugEnvironment` is into
/// Settings ▸ Debug, and for the same reason: this reads a real `~/.harness`,
/// which a test must not.
///
/// The opt-out is checked here as well as in [_build] — a card that said
/// "Reporting" over a stream the user switched off would be the dishonest
/// label this screen exists to prevent.
AnalyticsStreamStatus probeAnalyticsStatus() {
  final config = AnalyticsConfig.resolve();
  final store = AnalyticsIdentityStore();
  final ids = store.peek();
  final optedOut = store.optedOut ? kAnalyticsOptedOutReason : null;
  return AnalyticsStreamStatus(
    endpoint: config.endpoint,
    offReason: config.offReason ?? optedOut,
    deviceId: ids.pseudoId,
    sessionId: ids.sessionId,
  );
}

/// Who events are filed under.
///
/// `AppNotifier` writes it when sign-in resolves and clears it on sign-out; the
/// queue reads it fresh per event, so a visit that begins signed out and ends
/// signed in is not reported as anonymous throughout.
final AnalyticsAccount analyticsAccount = AnalyticsAccount();

/// The signed-in account, as the wire wants it. Mutable and global on purpose —
/// see [analyticsAccount].
class AnalyticsAccount {
  ({String? id, String? email}) current = (id: null, email: null);

  void set({String? id, String? email}) => current = (id: id, email: email);

  void clear() => current = (id: null, email: null);
}

/// The machine and build an event happened on, resolved once per launch.
///
/// Never fails: a version lookup that throws costs those fields, not the
/// stream. The queue awaits this once, before its first send, so the first
/// event of a launch already carries the version rather than racing it.
Future<AnalyticsContext> resolveAnalyticsContext() async {
  var version = '';
  var build = '';
  try {
    final info = await PackageInfo.fromPlatform();
    version = info.version;
    build = info.buildNumber;
  } on Object {
    // A bundle we can't read is worth an anonymous version, not a lost event.
  }
  return AnalyticsContext(
    platform: Platform.operatingSystem,
    appVersion: version,
    appBuild: build,
    osVersion: Platform.operatingSystemVersion,
    arch: Abi.current().toString(),
    locale: Platform.localeName,
    release: kReleaseMode,
  );
}
