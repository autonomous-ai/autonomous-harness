import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;

/// Shared terminal-shell palette.
///
/// ⚠️ THESE ARE NOW ADAPTERS, NOT VALUES, AND THAT IS THE POINT. Every one of
/// them used to be a `const` slate colour, which is why nine files could read
/// this palette and still paint a dark window while the rest of the app went
/// light: a constant cannot answer "which theme is it".
///
/// Each name below resolves through [grid.AppPalette], the design system that
/// already carries a light and a dark value for every role — and carries the
/// contrast ratio it was chosen for, in a comment, next to it. Mapping onto it
/// rather than inventing a second light palette is deliberate: two palettes for
/// one app do not stay in agreement, and the one that drifts is always the one
/// nobody is looking at.
///
/// The DARK values are unchanged in spirit but no longer identical — they are
/// now whatever the design system says dark is, so the two halves of the app
/// stop disagreeing by a few points of grey along the seam between them.
///
/// Being getters, they cannot appear in a `const` expression. That is a feature:
/// the compiler names every site that froze a colour at build time, which is
/// exactly the set of places light mode would otherwise have missed.
abstract final class AppColors {
  /// The window itself.
  static Color get background => grid.AppPalette.windowBg;

  /// The rail column, set apart from [background] by a hairline rather than a tone.
  static Color get sidebar => grid.AppPalette.panelBg;

  /// Quiet cards and input fills.
  static Color get surface => grid.AppPalette.cardBg;
  static Color get hover => grid.AppPalette.cardBgHover;
  static Color get selected => grid.AppSurface.selectedFill;

  /// A hairline between blocks, and the stronger one that has to hold a shape.
  static Color get border => grid.AppPalette.divider;
  static Color get borderStrong => grid.AppPalette.guide;

  /// Ink, in three weights.
  static Color get text => grid.AppPalette.textPrimary;
  static Color get textSoft => grid.AppPalette.textSecondary;
  static Color get muted => grid.AppPalette.textFaint;
  static Color get mutedStrong => grid.AppPalette.textSecondary;

  /// The accent as a MARK on a surface, not as a fill behind white text — which
  /// is what these call sites use it for (an icon, a link, a focused rim).
  static Color get accent => grid.AppPalette.accentOnSurface;

  static Color get success => grid.AppPalette.online;
  static Color get warning => grid.AppPalette.warn;

  /// Error ink on a surface. NOT [grid.AppPalette.dangerFill], which is tuned to
  /// carry white lettering on top of it and is far too dark to read AS text.
  static Color get danger =>
      grid.AppTheme.pick(const Color(0xFFB3261E), const Color(0xFFF2544B));
}

/// The app's two font stacks — adapters over the design system's, exactly like
/// [AppColors] above.
///
/// Mono is for strings the user copies (a token, a path, terminal output);
/// everything else is read, not copied, and reads faster in the system's own UI
/// face. Which face that is belongs to `grid.AppFont`, which answers per
/// platform — these used to re-declare the macOS names as `const`, which is how
/// the whole app came to be drawn in Noto Sans on Ubuntu (nothing in the Apple
/// stack resolves there) and how `mono` here drifted to `'Menlo'` while the
/// token said `.AppleSystemUIFontMonospaced`. Nothing is `const` for the same
/// reason nothing in [AppColors] is: freezing the value is what breaks the
/// second platform.
abstract final class AppFonts {
  static String get sans => grid.AppFont.sans;
  static List<String> get sansFallback => grid.AppFont.sansFallback;
  static String get mono => grid.AppFont.mono;
  static List<String> get monoFallback => grid.AppFont.monoFallback;
}

/// The app's ThemeData now comes from `grid.buildAppTheme` — see `main.dart`.
///
/// ⚠️ DO NOT REBUILD ONE HERE. What used to live at this spot was a second,
/// hand-written `ThemeData` (`AppTheme.terminalLight/terminalDark`), and it was
/// the one the app actually wore: `grid.buildAppTheme` had ZERO call sites in
/// `lib/` and was reached only from two tests. Everything the design system
/// defines was therefore dead at runtime —
///
///   * all ten `TextTheme` steps were assigned the SAME style (family and colour
///     only), so size, weight and `AppFont.trackingFor` fell through to
///     Material's Roboto metrics. That is why ~150 call sites hand-type
///     `fontSize:` across 14 different values: the theme gave them nothing, so
///     each screen re-measured the ramp by eye.
///   * `AppControl` had 0 references outside the token file — no call site could
///     see the 32/28/36 control heights or the radius ladder.
///   * `menuTheme` was null, so a `MenuAnchor` that passed no style of its own
///     opened Material's raw default.
///
/// [AppColors] and [AppFonts] above stay: they are thin aliases onto
/// `grid.AppPalette`, which is what let the swap be two lines in `main.dart`
/// instead of renaming 500 call sites. Adding chrome back here would recreate
/// exactly the split this deletion closed.
