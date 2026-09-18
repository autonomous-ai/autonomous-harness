import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

/// The resting fill of the terminal's floating buttons — the mic, Search and
/// `+`.
///
/// ⚠️ **Lighter than the terminal in both themes, because the terminal is dark
/// in both.** Every terminal palette is a near-black, so the dark theme's
/// surface grey laid over one at half strength drew a circle a few shades off
/// the page under it — the buttons read as missing. White at low strength is a
/// raised pane over that black; the light theme's is near-solid, as its
/// surfaces are.
Color get floatingButtonFill =>
    AppTheme.pick(const Color(0xD1FFFFFF), const Color(0x33FFFFFF));

/// The rim that draws the circle's edge over whatever runs under it.
Color get floatingButtonRim =>
    AppTheme.pick(const Color(0x29000000), const Color(0x59FFFFFF));

/// The resting shadow under those buttons: enough to lift the edge off a bright
/// line of output.
List<BoxShadow> get floatingButtonShadow => [
  BoxShadow(
    color: Colors.black.withValues(alpha: 0.3),
    blurRadius: 10,
    offset: const Offset(0, 3),
  ),
];

/// Frosted glass under a floating button: the output beneath [child] is
/// blurred to a soft wash, so its glyph reads against any line of text, while
/// the colour and movement of the terminal still show through.
///
/// ⚠️ **Blurred, not see-through.** A clear fill let every character under the
/// button cross its glyph, and the buttons were reported as too hard to see.
/// What the button covers is not readable any more — it was not readable
/// through a glyph either.
///
/// [child] is the circle itself and sets the size; the blur is clipped to it.
/// Grouped with the other floating buttons' blurs when a [BackdropGroup] is
/// above, so the backdrop is read once for all of them.
class FloatingGlass extends StatelessWidget {
  const FloatingGlass({super.key, required this.child});

  final Widget child;

  static const double blurSigma = 6;

  @override
  Widget build(BuildContext context) => Stack(
    alignment: Alignment.center,
    children: [
      Positioned.fill(
        child: ClipOval(
          child: BackdropFilter.grouped(
            filter: ImageFilter.blur(sigmaX: blurSigma, sigmaY: blurSigma),
            child: const SizedBox.expand(),
          ),
        ),
      ),
      child,
    ],
  );
}
