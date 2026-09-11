import 'dart:io' show Platform;

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/terminal/terminal_typography.dart';
import 'package:xterm/xterm.dart';

void main() {
  test('the default terminal face is the one this platform actually has', () {
    // Not a literal: the macOS names resolve to nothing on Linux, where
    // fontconfig answers `.AppleSystemUIFontMonospaced` and `Menlo` alike with
    // the PROPORTIONAL Noto Sans — and a proportional face breaks the cell grid
    // the renderer measures by laying out ten `m` glyphs.
    if (Platform.isMacOS) {
      expect(terminalFontFamily, '.AppleSystemUIFontMonospaced');
      expect(terminalFontFallback, macTerminalFontFallback);
    } else {
      expect(terminalFontFamily, 'DejaVu Sans Mono');
      expect(terminalFontFallback, linuxTerminalFontFallback);
    }
    expect(terminalFontSize, 13.0);
  });

  test('the default face is the one the store opens on', () {
    expect(
      TerminalFontChoice.defaultForPlatform.fontFamily,
      terminalFontFamily,
    );
    expect(
      TerminalFontChoice.defaultForPlatform.fontFamilyFallback,
      terminalFontFallback,
    );
  });

  test('every face offered here can reach a font that is really there', () {
    // The generic `monospace` at the end of each list is NOT the floor, however
    // much it looks like one: Flutter resolves families through Skia, which
    // does not honour fontconfig's generic aliases, and a real Linux build
    // measures `monospace` at exactly the width of a family that does not
    // exist (see terminal_typography.dart for the numbers). So each chain has
    // to name a face the platform actually ships — otherwise a machine without
    // the chosen font lands on the engine's proportional default and the whole
    // grid shears.
    final anchor = Platform.isMacOS ? 'Menlo' : 'DejaVu Sans Mono';
    for (final choice in TerminalFontChoice.available) {
      expect(choice.fontFamily, isNotEmpty);
      expect(
        [choice.fontFamily, ...choice.fontFamilyFallback],
        contains(anchor),
        reason:
            '${choice.label} can only fall through to faces that may be absent',
      );
      expect(
        choice.fontFamilyFallback.last,
        'monospace',
        reason: 'keep the generic last for engines that do honour it',
      );
    }
  });

  test('the Apple faces are not offered off macOS, and vice versa', () {
    const appleOnly = {
      '.AppleSystemUIFontMonospaced',
      'Menlo',
      'Monaco',
      'Courier New',
    };
    final offered = TerminalFontChoice.available
        .map((choice) => choice.fontFamily)
        .toSet();
    if (Platform.isMacOS) {
      expect(offered, appleOnly);
    } else {
      expect(offered.intersection(appleOnly), isEmpty);
    }
  });

  test('ANSI bold uses semibold instead of heavy bold', () {
    expect(
      const TerminalStyle().toTextStyle(bold: true).fontWeight,
      FontWeight.w600,
    );
    expect(const TerminalStyle().toTextStyle().fontWeight, FontWeight.normal);
  });
}
