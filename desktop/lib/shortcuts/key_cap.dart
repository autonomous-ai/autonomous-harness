import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'app_shortcuts.dart';

/// One key, drawn as a key.
///
/// A chord printed as running text (`⇧⌘]`) is three glyphs the eye has to
/// separate before it can read them; drawn as caps it is three objects and
/// reads at a glance. It also gives the right-hand column a shape, which is
/// what a list of shortcuts is scanned by.
///
/// A recessed well, not a bordered box: §1 puts depth in the fill, and
/// [grid.AppSurface.wellFill] is an overlay, so a cap keeps its edge on a
/// raised card and on a recessed one without being picked for either.
class KeyCap extends StatelessWidget {
  const KeyCap(this.label, {super.key});

  final String label;

  /// Square at a single glyph, so ⌘ and W sit in caps of the same size and the
  /// column stays a column. A longer label ("esc", "1 – 9") grows past it.
  static const double _minWidth = 22;
  static const double height = 22;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      constraints: const BoxConstraints(minWidth: _minWidth),
      height: height,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      decoration: BoxDecoration(
        color: grid.AppSurface.wellFill,
        borderRadius: BorderRadius.circular(6),
      ),
      // `Center(widthFactor: 1)`, never `Container(alignment:)` — a cap has to
      // be the width of the glyph on it, and an Align given a bounded width
      // FILLS it (`shrinkWrapWidth` is false unless a factor is set or the
      // constraint is infinite). The chord's Wrap bounds its children, so the
      // plain alignment blew every cap out to the whole row: one cap per line,
      // and a label squeezed to a character per line beside it.
      child: Center(
        widthFactor: 1,
        child: Text(
          label,
          style: TextStyle(
            color: grid.AppPalette.textPrimary,
            fontSize: 11.5,
            height: 1,
            // Tabular so ⌘1 – ⌘9 and ⌘W keep the same cap width.
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
      ),
    );
  }
}

/// A whole chord — `⇧` `⌘` `]` — and, where an action has more than one, the
/// alternates after an "or".
///
/// The alternates are printed rather than hidden: `⌃⇥` is the chord people
/// arrive already knowing, and a screen that only lists `⌘]` teaches them the
/// app doesn't have the key they are about to press.
class KeyChordView extends StatelessWidget {
  const KeyChordView({super.key, required this.chords});

  final List<KeyChord> chords;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Wrap(
      spacing: 4,
      runSpacing: 4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        for (var i = 0; i < chords.length; i++) ...[
          if (i > 0)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: Text(
                'or',
                style: TextStyle(
                  color: grid.AppPalette.textFaint,
                  fontSize: 10.5,
                ),
              ),
            ),
          for (final key in chords[i]) KeyCap(key),
        ],
      ],
    );
  }
}
