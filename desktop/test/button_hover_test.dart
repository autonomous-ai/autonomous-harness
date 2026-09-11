// Every button in this app must answer the pointer.
//
// `splashFactory: NoSplash` turns Material's ripple off app-wide, which is
// right — a ripple is an Android idiom. But the ripple was also the only thing
// the theme left drawing a hover response: M3 derives its overlay from
// `foregroundColor`, and a `styleFrom` that passes none resolves to **null**.
// Text buttons across the app lit up on press and did nothing at all under the
// pointer, which on a desktop app makes a control read as a label.
//
// Two rules, both measured here:
//   1. the theme declares a hover overlay for each button kind;
//   2. a `styleFrom` at a call site restates it, because `styleFrom` REPLACES
//      the theme's style rather than merging with it.
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/shared/theme/app_theme.dart';

const _hovered = {WidgetState.hovered};

Color _over(Color base, Color layer) {
  final a = layer.a;
  return Color.from(
    alpha: 1,
    red: layer.r * a + base.r * (1 - a),
    green: layer.g * a + base.g * (1 - a),
    blue: layer.b * a + base.b * (1 - a),
  );
}

double _luminance(Color c) {
  double channel(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

double _contrast(Color a, Color b) {
  final l1 = _luminance(a), l2 = _luminance(b);
  final hi = l1 > l2 ? l1 : l2;
  final lo = l1 > l2 ? l2 : l1;
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  for (final brightness in [Brightness.dark, Brightness.light]) {
    group('on ${brightness.name}', () {
      late ThemeData theme;

      setUp(() {
        AppTheme.brightness.value = brightness;
        theme = buildAppTheme(brightness: brightness);
      });

      tearDown(() => AppTheme.brightness.value = Brightness.light);

      test('every button kind declares a hover overlay', () {
        final kinds = {
          'text': theme.textButtonTheme.style,
          'outlined': theme.outlinedButtonTheme.style,
          'filled': theme.filledButtonTheme.style,
        };
        kinds.forEach((name, style) {
          final overlay = style?.overlayColor?.resolve(_hovered);
          expect(
            overlay,
            isNotNull,
            reason: '$name buttons would have no hover state at all',
          );
          expect(
            overlay!.a,
            greaterThan(0),
            reason: '$name buttons resolve to a fully transparent hover',
          );
        });
      });

      // An overlay that exists but cannot be seen is the same bug wearing a
      // value. These are measured on the surfaces buttons actually sit on.
      test('the hover wash is visible on the surfaces buttons sit on', () {
        final page = brightness == Brightness.dark
            ? const Color(0xFF191919)
            : const Color(0xFFFAFAF9);
        final grounds = {
          'page': page,
          'card': _over(page, AppPalette.cardBg),
          'accent wash': _over(page, AppSurface.accentWash),
        };
        grounds.forEach((name, ground) {
          expect(
            _contrast(ground, _over(ground, AppSurface.hoverFill)),
            greaterThan(1.03),
            reason: 'hover is invisible on $name',
          );
        });
      });
    });
  }
}
