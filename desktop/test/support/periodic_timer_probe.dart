import 'dart:async';

/// Counts actual timer activity without adding instrumentation to the app.
/// Delegation preserves the widget test runner's fake clock and cancellation.
class PeriodicTimerProbe {
  final _timers = <Timer>[];
  int callbacks = 0;

  int get active => _timers.where((timer) => timer.isActive).length;

  Future<void> run(Future<void> Function() body) => runZoned(
    body,
    zoneSpecification: ZoneSpecification(
      createPeriodicTimer: (self, parent, zone, period, callback) {
        final timer = parent.createPeriodicTimer(zone, period, (timer) {
          callbacks++;
          callback(timer);
        });
        _timers.add(timer);
        return timer;
      },
    ),
  );
}
