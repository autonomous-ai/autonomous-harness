import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/pane_preset.dart';
import '../theme/app_theme.dart';

/// ⌘S — pick the shape of the grid.
///
/// Shapes are DRAWN, not listed. "Two over one" and "one over two" are the same
/// four words in a different order, and nobody reads a layout name twice; the
/// little diagram is the whole interface and the label only confirms it.
///
/// Every size has a choice except one tile. Up to four they are named shapes;
/// above that the choice is the column count, with "Auto" — as many columns as
/// the width carries at the forty-column floor — sitting among them as the
/// measured answer rather than as the only one.
/// Set while the palette is up, so a second ⌘S can be answered rather than
/// stacking a route.
///
/// It used to be a bool and a bare return. That stopped the palette fading the
/// window to black under a held key — each press laid another dialog and another
/// 30% barrier over the last — but it left ⌘S meaning "open" once and nothing
/// ever after, which is the one thing a person holding a key does not expect.
///
/// THE SAME KEY WALKS THE STRIP. ⌘S opens it, ⌘S again steps to the next shape,
/// Enter takes it. That is how every cycling chord on this OS behaves, and it
/// means the shape can be chosen without the hand leaving the chord it arrived
/// on.
bool Function()? _layoutPaletteAdvance;

/// Advance the visible palette without opening another route behind a dialog.
bool advanceLayoutPalette() => _layoutPaletteAdvance?.call() ?? false;

Future<void> showLayoutPalette(BuildContext context, AppNotifier notifier) {
  if (advanceLayoutPalette()) {
    return Future<void>.value();
  }
  return showAppDialog<void>(
    context: context,
    builder: (context) => _LayoutPalette(notifier: notifier),
  ).whenComplete(() => _layoutPaletteAdvance = null);
}

/// The strip's geometry, in one place.
///
/// Both the [Wrap] that draws the shapes and the keys that walk them read these.
/// They used to be literals in the build method alone, which is why the arrow
/// keys could not tell a row from a column: nothing outside the layout knew how
/// many shapes fitted on a line.
/// Where [at] lands after one press, on a strip [n] long.
///
/// BOTH AXES WRAP. The strip is short and every shape is on screen, so running
/// off one end and appearing at the other cannot be mistaken for a jump to
/// somewhere unseen — and a key that dies at the edge is one people stop
/// trusting, which is the same argument the window's own pane ring rests on.
///
/// Vertical keeps the COLUMN: down from the second shape lands under it, not
/// at the start of the next line. A last row shorter than the others clamps,
/// because there is no shape under that column to land on.
int layoutPaletteMove(int at, int n, int dx, int dy, int perRow) {
  if (n <= 1) return 0;
  if (dx != 0) return (at + dx + n) % n;
  final rows = (n / perRow).ceil();
  if (rows <= 1) return at; // one line has no up and no down
  final col = at % perRow;
  final row = at ~/ perRow;
  final target = ((row + dy + rows) % rows) * perRow + col;
  return target >= n ? n - 1 : target;
}

class _Strip {
  /// Wide enough that a diagram stays readable — see the note on the Wrap.
  static const shape = 108.0;
  static const gap = 10.0;
  static const sidePadding = 14.0;

  /// The dialog's own width, which changes with how many shapes there are.
  static double width(int choices) => choices > 3 ? 500 : 420;

  /// How many shapes sit on one line. The same arithmetic Wrap does.
  static int perRow(int choices) {
    final room = width(choices) - sidePadding * 2;
    final fits = ((room + gap) / (shape + gap)).floor();
    return fits.clamp(1, choices < 1 ? 1 : choices);
  }
}

class _LayoutPalette extends StatefulWidget {
  const _LayoutPalette({required this.notifier});

  final AppNotifier notifier;

  @override
  State<_LayoutPalette> createState() => _LayoutPaletteState();
}

class _LayoutPaletteState extends State<_LayoutPalette> {
  /// An EXPLICIT node, requested after the first frame.
  ///
  /// `autofocus: true` alone was not enough: it only takes the focus when the
  /// enclosing scope has none to give, and by the time this is laid out the
  /// route that opened it has already settled focus somewhere. The symptom was
  /// precise — ⌘S opened the palette and cycled it, because that chord is a
  /// global binding, while the arrow keys did nothing at all, because those are
  /// read HERE and nothing here was listening.
  final FocusNode _keys = FocusNode(debugLabel: 'layout-palette');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _keys.requestFocus();
    });
    // Registered here rather than by the opener, so the hook cannot outlive the
    // widget it steps: a stale callback would move a cursor on a palette that
    // is no longer on screen, and the next ⌘S would find the strip already
    // walked.
    _layoutPaletteAdvance = _advance;
  }

  @override
  void dispose() {
    if (_layoutPaletteAdvance == _advance) _layoutPaletteAdvance = null;
    _keys.dispose();
    super.dispose();
  }

  /// One step along the strip — what a SECOND ⌘S does.
  ///
  /// Wraps, unlike the arrow keys, and the difference is deliberate. An arrow is
  /// a direction: running off the end of a strip you can see the ends of reads
  /// as a mis-key. A repeated chord is a CYCLE — nobody holding ⌘S means "stop
  /// at the last one", they mean "show me the next".
  bool _advance() {
    if (!mounted || ModalRoute.isCurrentOf(context) == false) return false;
    final count = widget.notifier.panes.length;
    final choices = PanePreset.forCount(count);
    if (choices.isEmpty) return true;
    // presetFor is keyed on the PANE COUNT, not on how many shapes that count
    // offers — the two are different numbers and only one of them is a key.
    final at = _cursorIn(choices, widget.notifier.presetFor(count));
    setState(() => _cursor = (at + 1) % choices.length);
    return true;
  }

  /// Which shape the arrow keys are resting on, which is NOT the same as the
  /// one in use: moving the cursor must not rearrange the grid under someone
  /// still looking at the choices. Applying is Enter, a digit, or a click.
  int? _cursor;

  /// Where the cursor is, read from state rather than from a captured local.
  ///
  /// Two keys can land inside one frame — an arrow and the Enter that takes it
  /// — and a value closed over at build time would still hold the position
  /// BEFORE the arrow moved, so the palette would apply the shape the cursor
  /// had just left. Reading it here means the answer is always current.
  ///
  /// It starts on the shape already in use, so the first arrow press steps off
  /// that one rather than jumping to the top of the list.
  int _cursorIn(List<PanePreset> choices, PanePreset? current) {
    if (choices.isEmpty) return 0;
    final start = _cursor ?? choices.indexOf(current ?? choices.first);
    return start.clamp(0, choices.length - 1);
  }

  @override
  Widget build(BuildContext context) {
    final notifier = widget.notifier;
    grid.AppTheme.watch(context);
    final count = notifier.panes.length;
    final choices = PanePreset.forCount(count);
    final current = notifier.presetFor(count);
    final cursor = _cursorIn(choices, current);

    return Dialog(
      backgroundColor: grid.AppGlass.surfaceFill,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(13),
        side: BorderSide(color: grid.AppGlass.hair),
      ),
      child: Focus(
        focusNode: _keys,
        autofocus: true,
        onKeyEvent: (node, event) {
          // Repeats count: holding an arrow should walk the list, the way it
          // does in every other list on this OS.
          if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
            return KeyEventResult.ignored;
          }
          if (choices.isEmpty) return KeyEventResult.ignored;

          void apply(PanePreset preset) {
            notifier.setPreset(count, preset);
            Navigator.of(context).pop();
          }

          final at = _cursorIn(choices, current);
          final direction = _direction(event.logicalKey);
          if (direction != null) {
            setState(
              () => _cursor = layoutPaletteMove(
                at,
                choices.length,
                direction.$1,
                direction.$2,
                _Strip.perRow(choices.length),
              ),
            );
            return KeyEventResult.handled;
          }
          if (_isCommit(event.logicalKey)) {
            apply(choices[at]);
            return KeyEventResult.handled;
          }
          final index = _digit(event.logicalKey);
          if (index == null || index > choices.length) {
            return KeyEventResult.ignored;
          }
          apply(choices[index - 1]);
          return KeyEventResult.handled;
        },
        child: ConstrainedBox(
          // Wide enough that four shapes still get a diagram big enough to read
          // and a label that is not ellipsised into a guess.
          constraints: BoxConstraints(maxWidth: choices.length > 3 ? 500 : 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 16, 18, 12),
                child: Text(
                  choices.isEmpty ? 'Layout' : 'Layout · $count tiles',
                  style: TextStyle(
                    color: grid.AppPalette.textSecondary,
                    fontSize: 11.5,
                    letterSpacing: 0.9,
                    fontWeight: grid.AppFont.medium,
                  ),
                ),
              ),
              if (choices.isEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(18, 0, 18, 20),
                  child: Text(
                    'One tile has no layout to choose. Open another and the '
                    'shapes appear here.',
                    style: TextStyle(
                      color: grid.AppPalette.textFaint,
                      fontSize: 12.5,
                      height: 1.45,
                    ),
                  ),
                )
              else ...[
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    _Strip.sidePadding,
                    0,
                    _Strip.sidePadding,
                    6,
                  ),
                  // Wrapped, not a Row: a big grid offers five column counts,
                  // and five diagrams squeezed across one line are five things
                  // nobody can tell apart. 108px keeps a shape readable.
                  child: Wrap(
                    spacing: _Strip.gap,
                    runSpacing: _Strip.gap,
                    children: [
                      for (var i = 0; i < choices.length; i++)
                        SizedBox(
                          width: _Strip.shape,
                          child: _ShapeButton(
                            preset: choices[i],
                            count: count,
                            index: i + 1,
                            selected: choices[i] == current,
                            cursor: i == cursor,
                            onTap: () {
                              notifier.setPreset(count, choices[i]);
                              Navigator.of(context).pop();
                            },
                          ),
                        ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(18, 6, 18, 14),
                  child: Text(
                    'Arrows to move, Enter or a number to pick. Changing the '
                    'shape resets the dividers — they described boundaries the '
                    'old one had.',
                    style: TextStyle(
                      color: grid.AppPalette.textFaint,
                      fontSize: 11,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  /// Which way an arrow moves the cursor.
  ///
  /// Up and left both mean "back" and down and right both mean "forward",
  /// because the shapes WRAP onto more than one line when there are five of
  /// them: a vertical key that only moved between rows would do nothing on a
  /// single-row palette, and stepping by one is the only motion that means the
  /// same thing however the wrap happens to fall.
  /// Which way a key points, as (dx, dy).
  ///
  /// hjkl beside the arrows, unmodified, for the reason the window binds both: a
  /// hand that reaches for one and a hand that reaches for the other are two
  /// hands on the same keyboard. Bare letters are safe HERE and nowhere else in
  /// this app — a dialog is not a pty, and no shell is waiting behind it.
  ///
  /// UP AND DOWN ARE VERTICAL. They used to be a second spelling of left and
  /// right — every key stepped the list by one — on the reasoning that a
  /// vertical key would do nothing on a single-row palette. What that actually
  /// produced was `j` walking sideways, which is worse than a key that waits:
  /// the motion did not match the arrow on the cap.
  static (int, int)? _direction(LogicalKeyboardKey key) => switch (key) {
    LogicalKeyboardKey.arrowLeft || LogicalKeyboardKey.keyH => (-1, 0),
    LogicalKeyboardKey.arrowRight || LogicalKeyboardKey.keyL => (1, 0),
    LogicalKeyboardKey.arrowUp || LogicalKeyboardKey.keyK => (0, -1),
    LogicalKeyboardKey.arrowDown || LogicalKeyboardKey.keyJ => (0, 1),
    _ => null,
  };

  static bool _isCommit(LogicalKeyboardKey key) =>
      key == LogicalKeyboardKey.enter ||
      key == LogicalKeyboardKey.numpadEnter ||
      key == LogicalKeyboardKey.space;

  static int? _digit(LogicalKeyboardKey key) {
    const digits = [
      LogicalKeyboardKey.digit1,
      LogicalKeyboardKey.digit2,
      LogicalKeyboardKey.digit3,
      LogicalKeyboardKey.digit4,
      LogicalKeyboardKey.digit5,
      LogicalKeyboardKey.digit6,
    ];
    final index = digits.indexOf(key);
    return index < 0 ? null : index + 1;
  }
}

class _ShapeButton extends StatelessWidget {
  const _ShapeButton({
    required this.preset,
    required this.count,
    required this.index,
    required this.selected,
    required this.cursor,
    required this.onTap,
  });

  final PanePreset preset;
  final int count;
  final int index;

  /// The shape the grid is in now.
  final bool selected;

  /// Where the arrow keys are resting. Drawn as a ring rather than as the
  /// selected fill, so "what I am about to pick" never looks like "what is
  /// already in use" — the two are different answers and both are on screen.
  final bool cursor;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(10, 10, 10, 8),
        decoration: BoxDecoration(
          color: selected
              ? grid.AppSurface.accentWash
              : grid.AppSurface.hoverFill,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: cursor
                ? AppColors.accent
                : (selected ? AppColors.accent : grid.AppGlass.hair),
            width: cursor ? 2 : 1,
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AspectRatio(
              aspectRatio: 4 / 3,
              child: CustomPaint(painter: _ShapePainter(preset, count)),
            ),
            const SizedBox(height: 8),
            Text(
              preset.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: selected
                    ? grid.AppPalette.textPrimary
                    : grid.AppPalette.textSecondary,
                fontSize: 11.5,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              '⌘S then $index',
              style: TextStyle(
                fontFamily: grid.AppFont.mono,
                fontSize: 9.5,
                color: grid.AppPalette.textFaint,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The diagram: [PanePreset.tiles], drawn.
///
/// It paints the shape's own description rather than a picture of it, and
/// `pane_preset_test` measures the real grid against the same list — so an
/// illustration that lies about the layout fails a test instead of misleading
/// someone into picking the wrong shape.
class _ShapePainter extends CustomPainter {
  const _ShapePainter(this.preset, this.count);

  final PanePreset preset;
  final int count;

  @override
  void paint(Canvas canvas, Size size) {
    const gap = 1.5;
    final fill = Paint()..color = AppColors.accent.withValues(alpha: 0.55);
    for (final unit in preset.tilesFor(count)) {
      final rect = Rect.fromLTRB(
        unit.left * size.width + gap,
        unit.top * size.height + gap,
        unit.right * size.width - gap,
        unit.bottom * size.height - gap,
      );
      canvas.drawRRect(
        RRect.fromRectAndRadius(rect, const Radius.circular(2)),
        fill,
      );
    }
  }

  @override
  bool shouldRepaint(_ShapePainter old) =>
      old.preset != preset || old.count != count;
}
