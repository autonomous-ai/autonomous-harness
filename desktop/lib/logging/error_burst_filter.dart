/// Decides whether one more copy of a repeating error is worth writing down.
///
/// An exception thrown from `build`, `paint` or a frame callback doesn't happen
/// once — it repeats *every frame*, and [DailyLogFile] appends each copy with an
/// `fsync` on the UI isolate. That is how a glitch turns into a hang: on
/// 2026-08-06 a tooltip assertion inside the mouse tracker repeated 11,406 times
/// in two and a half minutes, wrote 19MB of identical stack traces, and the app
/// had to be killed. The first copy carries the diagnosis; the rest only need to
/// be counted.
///
/// Errors are matched on their first line, so the same failure with a slightly
/// different tail still counts as one burst.
///
/// Pure and clock-injected: the rule is tested rather than watched.
class ErrorBurstFilter {
  ErrorBurstFilter({
    this.window = const Duration(seconds: 30),
    DateTime Function() clock = DateTime.now,
    // The field is private, so an initialising formal would name the
    // PARAMETER `_clock` — which no caller outside this library could pass.
    // The clock is injected by tests.
    // ignore: prefer_initializing_formals
  }) : _clock = clock;

  /// How long an error stays suppressed after a copy of it is written.
  final Duration window;

  final DateTime Function() _clock;

  /// When each error was last written, and how many copies were swallowed since.
  final Map<String, ({DateTime at, int suppressed})> _seen = {};

  /// Past this many distinct errors the map is cleared wholesale: a guard
  /// against floods must not become the leak it was meant to prevent.
  static const int _maxTracked = 256;

  /// How many distinct errors are currently being tracked — the one thing worth
  /// asserting about the bound above.
  int get trackedCount => _seen.length;

  /// The text to log for [message], or null when this copy should be dropped.
  ///
  /// The returned text is [message] itself, with a count appended when copies
  /// were swallowed while it was suppressed — so the log says "this happened
  /// 3,000 times", never just "this happened".
  String? admit(String message) {
    final now = _clock();
    final key = _signature(message);
    final last = _seen[key];
    if (last != null && now.difference(last.at) < window) {
      _seen[key] = (at: last.at, suppressed: last.suppressed + 1);
      return null;
    }
    if (_seen.length >= _maxTracked) _seen.clear();
    _seen[key] = (at: now, suppressed: 0);
    final swallowed = last?.suppressed ?? 0;
    return swallowed == 0
        ? message
        : '$message  [+$swallowed identical since the last copy]';
  }

  /// The first line, capped: enough to tell two failures apart without hashing a
  /// whole stack trace on every frame of a burst.
  static String _signature(String message) {
    final end = message.indexOf('\n');
    final line = end < 0 ? message : message.substring(0, end);
    return line.length <= 200 ? line : line.substring(0, 200);
  }
}
