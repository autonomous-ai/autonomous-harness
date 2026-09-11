import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/painter.dart';

void main() {
  test('record-button status marker paints as a monochrome filled circle', () {
    expect(terminalGlyphText(0x23FA), '\u25CF');
  });

  test('ordinary terminal glyphs remain unchanged', () {
    expect(terminalGlyphText('A'.codeUnitAt(0)), 'A');
  });
}
