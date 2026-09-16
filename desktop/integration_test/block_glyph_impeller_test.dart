// Block-element painting has to be verified on the REAL device rasterizer, not
// just `flutter_tester` (Skia). The unit raster tests in
// `test/terminal_block_glyph_test.dart` prove the geometry, but the whole point
// of the device-pixel snapping in `block_glyphs.dart`/`painter.dart` is
// Impeller: it ignores `Paint.isAntiAlias = false` (flutter/flutter#104721) and
// resolves abutting rectangle edges through MSAA, so two neighbouring block
// cells can leave a one-pixel seam that Skia never shows.
//
// This runs on `-d macos` (or `-d linux`), which is Impeller on Apple Silicon —
// the build that shipped the seams in #51. It paints a tiled grid of block
// cells through the real `TerminalPainter` into a live `RepaintBoundary`,
// captures it at device resolution, and fails if any interior pixel is the
// background colour bleeding through a seam.
//
//   flutter test integration_test/block_glyph_impeller_test.dart -d macos
//
// Measured on arm64/Impeller (dpr 2.0): before the fix a 4×3 full-block grid
// left 976 non-foreground interior pixels; after, zero.
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:xterm/src/ui/painter.dart';
import 'package:xterm/xterm.dart';

// A foreground the ground colour can never be mistaken for.
const _fg = 0xFFFF0000; // opaque red
const _ground = Color(0xFF0000FF); // opaque blue — any seam shows as blue

CellData _cell(int codePoint, {int flags = 0}) => CellData(
      foreground: _fg,
      background: 0,
      flags: flags,
      // width 1 (single-width block cell).
      content: codePoint | (1 << CellContent.widthShift),
    );

/// Paints a [columns]×[rows] grid of one block cell through the real
/// [TerminalPainter], exactly as `RenderTerminal` does per row.
class _GridPainter extends CustomPainter {
  _GridPainter(this.painter, this.cell, this.columns, this.rows);
  final TerminalPainter painter;
  final CellData cell;
  final int columns;
  final int rows;

  @override
  void paint(Canvas canvas, Size size) {
    final c = painter.cellSize;
    for (var r = 0; r < rows; r++) {
      for (var col = 0; col < columns; col++) {
        painter.paintCell(canvas, Offset(col * c.width, r * c.height), cell);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _GridPainter oldDelegate) =>
      oldDelegate.cell != cell ||
      oldDelegate.columns != columns ||
      oldDelegate.rows != rows;
}

/// Captured device-resolution pixels of the rendered grid.
class _Shot {
  _Shot(this._bytes, this.width, this.height);
  final ByteData _bytes;
  final int width;
  final int height;

  int at(int x, int y) {
    final i = (y * width + x) * 4;
    return (_bytes.getUint8(i + 3) << 24) |
        (_bytes.getUint8(i) << 16) |
        (_bytes.getUint8(i + 1) << 8) |
        _bytes.getUint8(i + 2);
  }

  /// Interior pixels (inset by 1 device px to skip the grid's own outer edge)
  /// that are not [expected] — i.e. a seam or gap.
  ({int count, int? x, int? y, int? color}) mismatches(int expected) {
    var count = 0;
    int? fx, fy, fc;
    for (var y = 1; y < height - 1; y++) {
      for (var x = 1; x < width - 1; x++) {
        if (at(x, y) != expected) {
          count++;
          fx ??= x;
          fy ??= y;
          fc ??= at(x, y);
        }
      }
    }
    return (count: count, x: fx, y: fy, color: fc);
  }
}

Future<_Shot> _render(
  WidgetTester tester,
  TerminalPainter painter,
  CellData cell, {
  required int columns,
  required int rows,
}) async {
  final dpr = tester.view.devicePixelRatio;
  painter.devicePixelRatio = dpr;
  final size = painter.cellSize;
  final key = GlobalKey();
  await tester.pumpWidget(
    Directionality(
      textDirection: TextDirection.ltr,
      child: Align(
        alignment: Alignment.topLeft,
        child: RepaintBoundary(
          key: key,
          child: Container(
            color: _ground,
            width: size.width * columns,
            height: size.height * rows,
            child: CustomPaint(
              painter: _GridPainter(painter, cell, columns, rows),
              size: Size(size.width * columns, size.height * rows),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  final boundary =
      key.currentContext!.findRenderObject() as RenderRepaintBoundary;
  final image = await boundary.toImage(pixelRatio: dpr);
  final data = (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!;
  return _Shot(data, image.width, image.height);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  late TerminalPainter painter;
  setUp(() {
    painter = TerminalPainter(
      theme: TerminalThemes.defaultTheme,
      textStyle: const TerminalStyle(fontSize: 13),
      textScaler: TextScaler.noScaling,
    );
  });

  testWidgets('full blocks tile with no seam on the live rasterizer', (
    tester,
  ) async {
    // A 4×3 grid of █ exercises both the vertical seams (between columns) and
    // the horizontal seams (between rows). Every interior pixel must be the
    // foreground; a blue ground pixel means a seam opened between two cells.
    final shot = await _render(tester, painter, _cell(0x2588),
        columns: 4, rows: 3);
    final miss = shot.mismatches(_fg);
    expect(
      miss.count,
      0,
      reason: 'grid=${shot.width}x${shot.height} — ${miss.count} non-foreground '
          'interior pixels; first at (${miss.x},${miss.y})='
          '0x${miss.color?.toRadixString(16)} — a seam/hairline between '
          'abutting block cells (Impeller MSAA over unsnapped edges).',
    );
  });
}
