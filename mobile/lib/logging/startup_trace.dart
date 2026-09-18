import 'app_log.dart';

/// Where the launch actually spends its time, as a timeline a shipped build can
/// be asked about after the fact.
///
/// The phone's launch is a long chain of awaits — preferences off disk, the SSO
/// session, `/api/machines`, a relay dial per machine, the E2EE handshake on top
/// of it, and only then the agent list. Every one of those is a plausible
/// suspect for a slow start, and until each is timed separately the only honest
/// answer to "why is it slow" is a guess. The screen says
/// "Connecting to your machine…" for all of them at once (see
/// `phone/phone_status.dart`), so the UI cannot be read as a progress bar
/// either.
///
/// Two shapes, because the launch has two:
///  - [mark] for a moment on one timeline — how far into the launch it happened.
///  - [time]/[timeSync] for a span, which is what a suspect actually needs: the
///    span's own cost, not its position.
///
/// ⚠️ **Both write through [appLog], which is a SYNCHRONOUS, FLUSHED file write
/// on the UI isolate** (see `logging/log_file.dart`). That is fine for the tens
/// of events a launch produces and is emphatically not fine per frame or per
/// terminal chunk: instrument phases here, never hot paths.
///
/// Timings are always on, in release too. A launch that is slow on a tester's
/// phone and fast on a developer's is exactly the launch worth measuring, and
/// `~/.harness/logs/app-YYYYMMDD.log` is where that evidence already lives —
/// the same reasoning that keeps the file sink itself unconditional
/// (`logging/debug_surface.dart`).
abstract final class StartupTrace {
  /// Started when the process reaches `startHarness`, so every [mark] shares one
  /// origin. Not `DateTime`: a clock the user or the network can move backwards
  /// mid-launch would report negative elapsed time.
  static final Stopwatch _sinceLaunch = Stopwatch()..start();

  /// How long since the app entered `startHarness`.
  static Duration get sinceLaunch => _sinceLaunch.elapsed;

  /// One moment on the launch timeline, stamped with its offset from launch.
  ///
  /// For things that have no duration of their own — the first frame, the point
  /// bootstrap decided the user was signed in. A span belongs in [time].
  static void mark(String event) =>
      appLog.info('startup', '$event @${_ms(_sinceLaunch.elapsed)}');

  /// Run [body], then log what it cost and where it fell in the launch.
  ///
  /// The offset is carried alongside the duration because a 300ms step means
  /// something different at 200ms into the launch than at 4s: the first is the
  /// launch, the second is a step waiting on something that came before it.
  ///
  /// A throwing [body] is timed and logged too, then rethrown — a step that
  /// failed after 15 seconds is the single most useful line in the file, and it
  /// is exactly the one a `finally`-less version would drop.
  static Future<T> time<T>(String step, Future<T> Function() body) async {
    final started = _sinceLaunch.elapsed;
    try {
      return await body();
    } finally {
      _record(step, started);
    }
  }

  /// [time] for work that is not asynchronous.
  static T timeSync<T>(String step, T Function() body) {
    final started = _sinceLaunch.elapsed;
    try {
      return body();
    } finally {
      _record(step, started);
    }
  }

  static void _record(String step, Duration started) {
    final elapsed = _sinceLaunch.elapsed - started;
    appLog.info(
      'startup',
      '$step took ${_ms(elapsed)} (at ${_ms(started)})',
    );
  }

  /// Milliseconds, the unit a launch is argued about in.
  ///
  /// Deliberately not `logDuration` from `log_file.dart`: that one floors to
  /// whole seconds, which renders every interesting step of a launch as `0s`.
  static String _ms(Duration d) => '${d.inMilliseconds}ms';
}
