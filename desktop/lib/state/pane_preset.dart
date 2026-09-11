import 'dart:ui' show Rect;

/// The named shapes a grid of tiles can take.
///
/// A shape is not a free-form tree. Up to four tiles the shapes are few enough
/// to name, and naming them is what the whole feature is for: people do not
/// want to draw a layout, they want to pick the one they meant.
///
/// Above four, naming every arrangement would be silly — but there IS still a
/// choice, and it is the only one that matters at that size: HOW MANY COLUMNS.
/// The first cut of this feature said the window decides and offered nothing,
/// which was wrong: the window decides how many columns FIT, not how many the
/// person wants. [auto] is that measured answer kept as one option among the
/// column counts, not as the only one.
enum PanePreset {
  /// Two tiles: split whichever side is longer. A terminal's usable size is its
  /// column count first, so halving the short axis is what protects it.
  splitLong,

  /// Two tiles, side by side whatever the window's shape.
  columns,

  /// Two tiles, one above the other.
  rows,

  /// Three tiles: two over one, the bottom one spanning. The shipped shape.
  twoOverOne,

  /// Three tiles: one over two, the top one spanning.
  oneOverTwo,

  /// Three tiles: one tall on the left, two stacked on the right.
  mainLeft,

  /// As many columns as the window can carry at the 40-column floor. The
  /// measured answer, and the one a grid gets when nobody has chosen.
  auto,

  /// A stated column count, for any number of tiles. The rows fall out of it:
  /// seven tiles in three columns is three rows, the last one short.
  ///
  /// Narrow counts are allowed to be narrow — three terminals across a 1600px
  /// window with the rail open is close to the floor — because the floor itself
  /// already refuses anything narrower than a terminal can use, and clamps.
  cols2,
  cols3,
  cols4,
  cols5,

  /// Five tiles: one tall down the MIDDLE, two stacked either side of it.
  ///
  /// The only five-tile shape that is not a lattice, and the reason to have it:
  /// a lattice of five leaves the odd tile alone on a short row, while this
  /// gives the work in hand a full-height column and keeps four others in
  /// sight beside it.
  middleMain,

  /// Four tiles in a square.
  quad,

  /// Four tiles: one tall on the left, three stacked on the right.
  mainAndStack;

  /// What the picker prints.
  String get label => switch (this) {
    PanePreset.splitLong => 'Split',
    PanePreset.columns => 'Columns',
    PanePreset.rows => 'Rows',
    PanePreset.twoOverOne => 'Two over one',
    PanePreset.oneOverTwo => 'One over two',
    PanePreset.mainLeft => 'Main + stack',
    PanePreset.quad => 'Grid',
    PanePreset.mainAndStack => 'Main + stack',
    PanePreset.auto => 'Auto',
    PanePreset.cols2 => '2 columns',
    PanePreset.cols3 => '3 columns',
    PanePreset.cols4 => '4 columns',
    PanePreset.cols5 => '5 columns',
    PanePreset.middleMain => 'Middle + sides',
  };

  /// The column count this shape states, or null for [auto] and for the shapes
  /// that are not a lattice at all.
  int? get statedColumns => switch (this) {
    PanePreset.cols2 => 2,
    PanePreset.cols3 => 3,
    PanePreset.cols4 => 4,
    PanePreset.cols5 => 5,
    _ => null,
  };

  /// The tiles this shape makes, as fractions of the grid.
  ///
  /// This is the shape's DESCRIPTION, and it lives here rather than in the
  /// picker that draws it so there is only one of it: the palette paints these
  /// rectangles and a test measures the real layout against them, so a diagram
  /// cannot drift into advertising a shape the grid does not build.
  ///
  /// Two shapes are approximate on purpose. [splitLong] is written as columns
  /// because that is what a wide window gets; on a tall one it splits the other
  /// way. [auto] is drawn at the column count a typical wide window carries,
  /// since its real answer is not knowable without the window — which is
  /// exactly what "auto" means.
  /// [columns] answers the one shape that cannot know its own: `auto` measures
  /// the window at build time, so the grid tells this what it actually laid out.
  /// Every other shape states its columns and ignores the argument.
  List<Rect> tilesFor(int count, {int? columns}) => switch (this) {
    PanePreset.columns || PanePreset.splitLong => const [
      Rect.fromLTRB(0, 0, .5, 1),
      Rect.fromLTRB(.5, 0, 1, 1),
    ],
    PanePreset.rows => const [
      Rect.fromLTRB(0, 0, 1, .5),
      Rect.fromLTRB(0, .5, 1, 1),
    ],
    PanePreset.twoOverOne => const [
      Rect.fromLTRB(0, 0, .5, .5),
      Rect.fromLTRB(.5, 0, 1, .5),
      Rect.fromLTRB(0, .5, 1, 1),
    ],
    PanePreset.oneOverTwo => const [
      Rect.fromLTRB(0, 0, 1, .5),
      Rect.fromLTRB(0, .5, .5, 1),
      Rect.fromLTRB(.5, .5, 1, 1),
    ],
    PanePreset.mainLeft => const [
      Rect.fromLTRB(0, 0, .5, 1),
      Rect.fromLTRB(.5, 0, 1, .5),
      Rect.fromLTRB(.5, .5, 1, 1),
    ],
    PanePreset.quad => const [
      Rect.fromLTRB(0, 0, .5, .5),
      Rect.fromLTRB(.5, 0, 1, .5),
      Rect.fromLTRB(0, .5, .5, 1),
      Rect.fromLTRB(.5, .5, 1, 1),
    ],
    PanePreset.mainAndStack => const [
      Rect.fromLTRB(0, 0, .5, 1),
      Rect.fromLTRB(.5, 0, 1, 1 / 3),
      Rect.fromLTRB(.5, 1 / 3, 1, 2 / 3),
      Rect.fromLTRB(.5, 2 / 3, 1, 1),
    ],
    // Tile order reads across the top and then across the bottom: 1 and 4 on the
    // left, 2 down the middle, 3 and 5 on the right — which is the order a
    // person numbers them, not the order a column would fill.
    PanePreset.middleMain => const [
      Rect.fromLTRB(0, 0, 1 / 3, 1 / 2),
      Rect.fromLTRB(1 / 3, 0, 2 / 3, 1),
      Rect.fromLTRB(2 / 3, 0, 1, 1 / 2),
      Rect.fromLTRB(0, 1 / 2, 1 / 3, 1),
      Rect.fromLTRB(2 / 3, 1 / 2, 1, 1),
    ],
    PanePreset.auto => _lattice(
      count,
      columns ?? _autoColumnsForDrawing(count),
    ),
    _ => _lattice(count, statedColumns!.clamp(1, count)),
  };

  /// The lattice, laid out the way `_Lattice` lays it: row-major, the last row
  /// short when the count does not divide.
  ///
  /// Written twice would be the bug this whole file exists to prevent, so the
  /// widget's own arithmetic is mirrored here and a test measures one against
  /// the other.
  static List<Rect> _lattice(int count, int columns) {
    final cols = columns.clamp(1, count);
    final rows = (count / cols).ceil();
    return [
      for (var i = 0; i < count; i++)
        Rect.fromLTRB(
          (i % cols) / cols,
          (i ~/ cols) / rows,
          (i % cols + 1) / cols,
          (i ~/ cols + 1) / rows,
        ),
    ];
  }

  /// Only for the DIAGRAM: what a wide window typically carries. The grid's own
  /// answer is measured at build time and can differ — the point of the picture
  /// is to say "the app decides", and it says that best by showing a plausible
  /// grid rather than a special icon nobody can read.
  static int _autoColumnsForDrawing(int count) => count <= 6 ? 3 : 4;

  /// Stable across releases: this is what lands in the state file, so it must
  /// not be the enum's index — reordering the enum would silently repoint
  /// everyone's saved layout at a different shape.
  String get id => name;

  static PanePreset? byId(String? id) {
    for (final preset in PanePreset.values) {
      if (preset.id == id) return preset;
    }
    return _legacyIds[id];
  }

  /// The shapes on offer for this many tiles, the shipped one first.
  ///
  /// One tile has nothing to choose. Everything else does — including the big
  /// grids, where the choice is the column count and [auto] is the measured
  /// answer sitting among them rather than replacing them.
  static List<PanePreset> forCount(int count) => switch (count) {
    < 2 => const [],
    2 => const [PanePreset.splitLong, PanePreset.columns, PanePreset.rows],
    3 => const [
      PanePreset.twoOverOne,
      PanePreset.oneOverTwo,
      PanePreset.mainLeft,
      PanePreset.cols3,
    ],
    4 => const [PanePreset.quad, PanePreset.mainAndStack, PanePreset.cols4],
    // A column count equal to the tile count is one row, which is worth having;
    // more columns than tiles is the same grid with empty air in it, so the
    // list stops there. Five is the practical end: six 40-column terminals need
    // a window almost nobody has, and the floor would clamp it back anyway.
    // Five has a shape of its own to offer, beside the column counts.
    5 => [
      PanePreset.auto,
      PanePreset.middleMain,
      for (final preset in const [
        PanePreset.cols2,
        PanePreset.cols3,
        PanePreset.cols4,
        PanePreset.cols5,
      ])
        preset,
    ],
    _ => [
      PanePreset.auto,
      for (final preset in const [
        PanePreset.cols2,
        PanePreset.cols3,
        PanePreset.cols4,
        PanePreset.cols5,
      ])
        if (preset.statedColumns! <= count) preset,
    ],
  };

  /// What a grid of this size looks like when nobody has chosen.
  static PanePreset? defaultFor(int count) {
    final choices = forCount(count);
    return choices.isEmpty ? null : choices.first;
  }

  /// Ids written by the build that named these two by hand, before the column
  /// count became a thing any grid size could state. Read only — nothing writes
  /// them any more — so a layout saved yesterday still opens the shape it was
  /// left in rather than silently falling back to the default.
  static const _legacyIds = {'threeColumns': cols3, 'fourColumns': cols4};
}
