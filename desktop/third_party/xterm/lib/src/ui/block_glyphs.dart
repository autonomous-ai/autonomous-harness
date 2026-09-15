import 'dart:ui';

/// Geometry for one Unicode Block Elements code point (U+2580–U+259F).
///
/// Terminals draw these themselves rather than trusting the font: a cell is
/// `TerminalStyle.height` times the font size tall, and a font's block glyphs
/// only cover the face's own ascent and descent, so glyph-drawn blocks leave a
/// band under every row and seams between columns (xterm.js `customGlyphs`,
/// Ghostty, Kitty and iTerm2 all synthesize them). [rects] are
/// expressed in the unit square — (0,0) top-left, (1,1) bottom-right — and are
/// scaled to the cell and snapped to device pixels when painted. [opacity]
/// carries the three shade characters, which are a full cell at reduced
/// coverage.
class BlockGlyph {
  const BlockGlyph(this.rects, {this.opacity = 1.0});

  final List<Rect> rects;
  final double opacity;

  /// Returns the glyph for [codePoint], or null when it is not a block element.
  static BlockGlyph? lookup(int codePoint) {
    if (codePoint < 0x2580 || codePoint > 0x259F) return null;
    return _table[codePoint - 0x2580];
  }
}

/// Rounds every edge of [rect] to a whole device pixel at [devicePixelRatio],
/// keeping at least one device pixel in each direction so a thin strip is
/// never rounded away. Adjacent cells and quadrants computed from the same
/// fractional boundary therefore round to the same pixel and share an edge.
Rect snapRectToDevicePixels(Rect rect, double devicePixelRatio) {
  final dpr = devicePixelRatio <= 0 ? 1.0 : devicePixelRatio;
  double snap(double v) => (v * dpr).round() / dpr;
  final left = snap(rect.left);
  final top = snap(rect.top);
  var right = snap(rect.right);
  var bottom = snap(rect.bottom);
  if (right <= left) right = left + 1 / dpr;
  if (bottom <= top) bottom = top + 1 / dpr;
  return Rect.fromLTRB(left, top, right, bottom);
}

const _full = Rect.fromLTRB(0, 0, 1, 1);

Rect _lower(int eighths) => Rect.fromLTRB(0, 1 - eighths / 8, 1, 1);
Rect _left(int eighths) => Rect.fromLTRB(0, 0, eighths / 8, 1);

const _upperLeft = Rect.fromLTRB(0, 0, 0.5, 0.5);
const _upperRight = Rect.fromLTRB(0.5, 0, 1, 0.5);
const _lowerLeft = Rect.fromLTRB(0, 0.5, 0.5, 1);
const _lowerRight = Rect.fromLTRB(0.5, 0.5, 1, 1);

/// Indexed by `codePoint - 0x2580`.
final _table = <BlockGlyph>[
  // U+2580 ▀ upper half
  const BlockGlyph([Rect.fromLTRB(0, 0, 1, 0.5)]),
  // U+2581–U+2587 lower one eighth … lower seven eighths
  for (var i = 1; i <= 7; i++) BlockGlyph([_lower(i)]),
  // U+2588 █ full block
  const BlockGlyph([_full]),
  // U+2589–U+258F left seven eighths … left one eighth
  for (var i = 7; i >= 1; i--) BlockGlyph([_left(i)]),
  // U+2590 ▐ right half
  const BlockGlyph([Rect.fromLTRB(0.5, 0, 1, 1)]),
  // U+2591 ░ light shade, U+2592 ▒ medium shade, U+2593 ▓ dark shade
  const BlockGlyph([_full], opacity: 0.25),
  const BlockGlyph([_full], opacity: 0.5),
  const BlockGlyph([_full], opacity: 0.75),
  // U+2594 ▔ upper one eighth
  const BlockGlyph([Rect.fromLTRB(0, 0, 1, 0.125)]),
  // U+2595 ▕ right one eighth
  const BlockGlyph([Rect.fromLTRB(0.875, 0, 1, 1)]),
  // U+2596 ▖ lower left
  const BlockGlyph([_lowerLeft]),
  // U+2597 ▗ lower right
  const BlockGlyph([_lowerRight]),
  // U+2598 ▘ upper left
  const BlockGlyph([_upperLeft]),
  // U+2599 ▙ upper left, lower left, lower right
  const BlockGlyph([_upperLeft, _lowerLeft, _lowerRight]),
  // U+259A ▚ upper left, lower right
  const BlockGlyph([_upperLeft, _lowerRight]),
  // U+259B ▛ upper left, upper right, lower left
  const BlockGlyph([_upperLeft, _upperRight, _lowerLeft]),
  // U+259C ▜ upper left, upper right, lower right
  const BlockGlyph([_upperLeft, _upperRight, _lowerRight]),
  // U+259D ▝ upper right
  const BlockGlyph([_upperRight]),
  // U+259E ▞ upper right, lower left
  const BlockGlyph([_upperRight, _lowerLeft]),
  // U+259F ▟ upper right, lower left, lower right
  const BlockGlyph([_upperRight, _lowerLeft, _lowerRight]),
];
