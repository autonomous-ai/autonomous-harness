import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

/// Harness owns the terminal's *default* appearance.
///
/// Terminal streams provide ANSI attributes, not the source application's
/// complete colour scheme.  The default foreground, background, and ANSI ramp
/// must therefore follow Harness's own (dark-only) appearance.  Explicit ANSI
/// and true-colour cells remain untouched by xterm, so a TUI keeps the colours
/// it deliberately emits.
const darkTerminalTheme = TerminalTheme(
  cursor: Color(0xffaeafad),
  // Translucent, not opaque: this is painted over the glyphs after they're drawn (see
  // render.dart's _paint), so an opaque fill here erased the selected text instead of
  // highlighting it, unlike every native terminal's selection. ~40% of the theme's own
  // brightBlue below, matching the tinted-overlay look those terminals use.
  selection: Color(0x663B8EEA),
  foreground: Color(0xffffffff),
  background: Color(0xff181818),
  black: Color(0xff000000),
  red: Color(0xffcd3131),
  green: Color(0xff0dbc79),
  yellow: Color(0xffe5e510),
  blue: Color(0xff2472c8),
  magenta: Color(0xffbc3fbc),
  cyan: Color(0xff11a8cd),
  white: Color(0xffe5e5e5),
  brightBlack: Color(0xff666666),
  brightRed: Color(0xfff14c4c),
  brightGreen: Color(0xff23d18b),
  brightYellow: Color(0xfff5f543),
  brightBlue: Color(0xff3b8eea),
  brightMagenta: Color(0xffd670d6),
  brightCyan: Color(0xff29b8db),
  brightWhite: Color(0xffffffff),
  searchHitBackground: Color(0xffffff2b),
  searchHitBackgroundCurrent: Color(0xff31ff26),
  searchHitForeground: Color(0xff000000),
);
