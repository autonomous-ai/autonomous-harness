import 'usage_window.dart';

/// How close a rate-limit window is to being spent.
///
/// Two thresholds, one step each: [warn] turns a figure amber and [critical]
/// turns it red. A third shade between them would be one nobody could name.
enum UsagePressure {
  calm,

  /// Amber. The window is worth noticing on the way past.
  warn,

  /// Red. The window is nearly spent.
  critical,
}

/// Where a window starts reading amber.
///
/// The figure beside it is already exact, so this number is not carrying the
/// quantity — it is carrying the moment the quantity starts to matter.
const double kUsageWarnPercent = 80;

/// Where a window starts reading red.
const double kUsageCriticalPercent = 90;

UsagePressure usagePressureOf(double usedPercent) {
  if (usedPercent >= kUsageCriticalPercent) return UsagePressure.critical;
  if (usedPercent >= kUsageWarnPercent) return UsagePressure.warn;
  return UsagePressure.calm;
}

extension UsageWindowPressure on UsageWindow {
  UsagePressure get pressure => usagePressureOf(usedPercent);
}
