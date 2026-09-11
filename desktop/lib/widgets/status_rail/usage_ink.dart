import 'package:flutter/widgets.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../theme/app_theme.dart';
import '../../usage/usage_pressure.dart';

/// The colour a nearly-spent window is drawn in, over the [calm] colour it
/// wears the rest of the time.
///
/// One function for the rail's figure and the panel's bar, so a window cannot
/// be amber in one place and plain in the other — the strip prints a summary of
/// the very numbers the panel expands, and two thresholds would make the pair
/// disagree at exactly the moment they matter.
///
/// ⚠️ [AppColors.danger] rather than `AppPalette.dangerFill`: this is ink on a
/// surface, and the fill is tuned to carry white lettering ON it.
Color usagePressureInk(UsagePressure pressure, Color calm) =>
    switch (pressure) {
      UsagePressure.calm => calm,
      UsagePressure.warn => grid.AppPalette.warn,
      UsagePressure.critical => AppColors.danger,
    };
