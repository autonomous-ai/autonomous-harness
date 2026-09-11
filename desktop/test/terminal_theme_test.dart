import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_theme.dart';

void main() {
  test('the terminal default follows the app\'s dark background', () {
    expect(darkTerminalTheme.background, const Color(0xff181818));
    expect(darkTerminalTheme.foreground, const Color(0xffffffff));
  });
}
