import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/src/ui/block_glyphs.dart';
import 'package:xterm/src/ui/painter.dart';
import 'package:xterm/xterm.dart';

const _full = Rect.fromLTRB(0, 0, 1, 1);
const _ul = Rect.fromLTRB(0, 0, 0.5, 0.5);
const _ur = Rect.fromLTRB(0.5, 0, 1, 0.5);
const _ll = Rect.fromLTRB(0, 0.5, 0.5, 1);
const _lr = Rect.fromLTRB(0.5, 0.5, 1, 1);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('lookup table', () {
    test(
      'every Block Elements code point has a glyph and nothing else does',
      () {
        for (var cp = 0x2580; cp <= 0x259F; cp++) {
          expect(BlockGlyph.lookup(cp), isNotNull, reason: _u(cp));
        }
        expect(BlockGlyph.lookup(0x257F), isNull); // last box-drawing char
        expect(BlockGlyph.lookup(0x25A0), isNull); // ■ geometric shapes
        expect(BlockGlyph.lookup('A'.codeUnitAt(0)), isNull);
      },
    );

    test('halves and the full block', () {
      expect(BlockGlyph.lookup(0x2588)!.rects, [_full]);
      expect(BlockGlyph.lookup(0x2580)!.rects, [
        const Rect.fromLTRB(0, 0, 1, 0.5),
      ]);
      expect(BlockGlyph.lookup(0x2584)!.rects, [
        const Rect.fromLTRB(0, 0.5, 1, 1),
      ]);
      expect(BlockGlyph.lookup(0x258C)!.rects, [
        const Rect.fromLTRB(0, 0, 0.5, 1),
      ]);
      expect(BlockGlyph.lookup(0x2590)!.rects, [
        const Rect.fromLTRB(0.5, 0, 1, 1),
      ]);
    });

    test('lower eighths U+2581–U+2587 grow from the bottom', () {
      for (var i = 1; i <= 7; i++) {
        final r = BlockGlyph.lookup(0x2580 + i)!.rects.single;
        expect(r, Rect.fromLTRB(0, 1 - i / 8, 1, 1), reason: _u(0x2580 + i));
      }
    });

    test('left eighths U+2589–U+258F shrink from seven eighths', () {
      for (var i = 7; i >= 1; i--) {
        final r = BlockGlyph.lookup(0x2590 - i)!.rects.single;
        expect(r, Rect.fromLTRB(0, 0, i / 8, 1), reason: _u(0x2590 - i));
      }
    });

    test('upper and right one-eighth strips', () {
      expect(BlockGlyph.lookup(0x2594)!.rects, [
        const Rect.fromLTRB(0, 0, 1, 0.125),
      ]);
      expect(BlockGlyph.lookup(0x2595)!.rects, [
        const Rect.fromLTRB(0.875, 0, 1, 1),
      ]);
    });

    test('all ten quadrant combinations, exactly', () {
      const expected = <int, List<Rect>>{
        0x2596: [_ll], // ▖
        0x2597: [_lr], // ▗
        0x2598: [_ul], // ▘
        0x2599: [_ul, _ll, _lr], // ▙
        0x259A: [_ul, _lr], // ▚
        0x259B: [_ul, _ur, _ll], // ▛
        0x259C: [_ul, _ur, _lr], // ▜
        0x259D: [_ur], // ▝
        0x259E: [_ur, _ll], // ▞
        0x259F: [_ur, _ll, _lr], // ▟
      };
      for (final entry in expected.entries) {
        expect(
          BlockGlyph.lookup(entry.key)!.rects,
          unorderedEquals(entry.value),
          reason: _u(entry.key),
        );
      }
    });

    test(
      'shades are a full cell at reduced coverage, everything else is opaque',
      () {
        expect(BlockGlyph.lookup(0x2591)!.opacity, 0.25);
        expect(BlockGlyph.lookup(0x2592)!.opacity, 0.5);
        expect(BlockGlyph.lookup(0x2593)!.opacity, 0.75);
        for (final cp in [0x2591, 0x2592, 0x2593]) {
          expect(BlockGlyph.lookup(cp)!.rects, [_full]);
        }
        for (var cp = 0x2580; cp <= 0x259F; cp++) {
          if (cp >= 0x2591 && cp <= 0x2593) continue;
          expect(BlockGlyph.lookup(cp)!.opacity, 1.0, reason: _u(cp));
        }
      },
    );
  });

  group('snapRectToDevicePixels', () {
    test('rounds every edge to a device pixel', () {
      expect(
        snapRectToDevicePixels(const Rect.fromLTRB(0.4, 0.6, 7.49, 15.5), 1),
        const Rect.fromLTRB(0, 1, 7, 16),
      );
      expect(
        snapRectToDevicePixels(const Rect.fromLTRB(0.2, 0, 7.8, 15.6), 2),
        const Rect.fromLTRB(0, 0, 8, 15.5),
      );
    });

    test(
      'two rects that meet at a fractional boundary share the snapped edge',
      () {
        final a = snapRectToDevicePixels(
          const Rect.fromLTRB(0, 0, 7.83, 16),
          2,
        );
        final b = snapRectToDevicePixels(
          const Rect.fromLTRB(7.83, 0, 15.66, 16),
          2,
        );
        expect(a.right, b.left);
      },
    );

    test('a strip thinner than a device pixel keeps one', () {
      final strip = snapRectToDevicePixels(
        const Rect.fromLTRB(6.9, 0, 7.3, 16),
        1,
      );
      expect(strip.width, 1);
      final tall = snapRectToDevicePixels(
        const Rect.fromLTRB(0, 15.9, 8, 16.1),
        2,
      );
      expect(tall.height, 0.5);
    });
  });

  group('painter', () {
    late TerminalPainter painter;
    late Size cell;

    setUp(() {
      painter = TerminalPainter(
        theme: TerminalThemes.defaultTheme,
        textStyle: const TerminalStyle(fontSize: 13),
        textScaler: TextScaler.noScaling,
      );
      cell = painter.cellSize;
    });

    test(
      'a full block covers every pixel of the cell with the foreground',
      () async {
        final image = await _raster(painter, _cell(0x2588, foreground: _red));
        for (var y = 0; y < cell.height.floor(); y++) {
          for (var x = 0; x < cell.width.floor(); x++) {
            expect(image.at(x, y), 0xFFFF0000, reason: '($x,$y)');
          }
        }
      },
    );

    test('▛ leaves only the lower-right quadrant empty', () async {
      final image = await _raster(painter, _cell(0x259B, foreground: _red));
      final w = cell.width, h = cell.height;
      expect(image.at((w * 0.25).floor(), (h * 0.25).floor()), 0xFFFF0000);
      expect(image.at((w * 0.75).floor(), (h * 0.25).floor()), 0xFFFF0000);
      expect(image.at((w * 0.25).floor(), (h * 0.75).floor()), 0xFFFF0000);
      expect(image.at((w * 0.75).floor(), (h * 0.75).floor()), 0x00000000);
    });

    test('two blocks side by side and stacked leave no seam', () async {
      final image = await _raster(
        painter,
        _cell(0x2588, foreground: _red),
        columns: 3,
        rows: 2,
      );
      for (var y = 0; y < (cell.height * 2).floor(); y++) {
        for (var x = 0; x < (cell.width * 3).floor(); x++) {
          expect(image.at(x, y), 0xFFFF0000, reason: '($x,$y)');
        }
      }
    });

    test('inverse paints with the cell background colour', () async {
      final image = await _raster(
        painter,
        _cell(0x2588, foreground: _red, flags: CellFlags.inverse),
      );
      expect(image.at(2, 2), TerminalThemes.defaultTheme.background.toARGB32());
    });

    test('faint halves the alpha and shades stack with it', () async {
      final faint = await _raster(
        painter,
        _cell(0x2588, foreground: _red, flags: CellFlags.faint),
      );
      expect(faint.at(2, 2) >>> 24, closeTo(128, 1));

      final shade = await _raster(painter, _cell(0x2592, foreground: _red));
      expect(shade.at(2, 2) >>> 24, closeTo(128, 1));

      final both = await _raster(
        painter,
        _cell(0x2592, foreground: _red, flags: CellFlags.faint),
      );
      expect(both.at(2, 2) >>> 24, closeTo(64, 1));
    });
  });
}

String _u(int cp) => 'U+${cp.toRadixString(16).toUpperCase()}';

const _red = CellColor.rgb | 0xFF0000;

CellData _cell(int codePoint, {required int foreground, int flags = 0}) {
  return CellData(
    foreground: foreground,
    background: 0,
    flags: flags,
    content: codePoint | (1 << CellContent.widthShift),
  );
}

class _Raster {
  _Raster(this.bytes, this.width);
  final ByteData bytes;
  final int width;

  /// ARGB of the pixel at ([x], [y]); the image is rawRgba.
  int at(int x, int y) {
    final i = (y * width + x) * 4;
    final r = bytes.getUint8(i), g = bytes.getUint8(i + 1);
    final b = bytes.getUint8(i + 2), a = bytes.getUint8(i + 3);
    return (a << 24) | (r << 16) | (g << 8) | b;
  }
}

Future<_Raster> _raster(
  TerminalPainter painter,
  CellData cellData, {
  int columns = 1,
  int rows = 1,
}) async {
  final cell = painter.cellSize;
  final recorder = PictureRecorder();
  final canvas = Canvas(recorder);
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < columns; c++) {
      painter.paintCell(
        canvas,
        Offset(c * cell.width, r * cell.height),
        cellData,
      );
    }
  }
  final width = (cell.width * columns).ceil();
  final height = (cell.height * rows).ceil();
  final image = await recorder.endRecording().toImage(width, height);
  final bytes = await image.toByteData(format: ImageByteFormat.rawRgba);
  return _Raster(bytes!, width);
}
