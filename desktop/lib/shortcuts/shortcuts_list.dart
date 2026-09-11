import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'app_shortcuts.dart';
import 'key_cap.dart';

/// Every shortcut, grouped and printed — in the two shapes the app needs.
///
/// [ShortcutsList] is the column the ⌘/ sheet draws inside a 420px dialog.
/// [ShortcutsDeck] is the same rows as cards across the Settings pane, which
/// is four times that wide.
///
/// Two layouts, one set of rows: both build from [shortcutRows], so the sheet
/// and the settings screen cannot disagree about what a key does, and neither
/// can drift from what the keys actually do.

/// The sheet's body: one column, group headers, no card chrome — it is already
/// inside a dialog, and a card in a card is one surface too many.
class ShortcutsList extends StatelessWidget {
  const ShortcutsList({super.key});

  @override
  Widget build(BuildContext context) {
    final rows = shortcutRows();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final group in ShortcutGroup.values) ...[
          _GroupHeader(label: group.label),
          for (final row in rows.where((row) => row.group == group))
            _ShortcutRowView(row: row),
        ],
        const SizedBox(height: 14),
        // The one thing users will otherwise file a bug about.
        const ShortcutsNote(),
      ],
    );
  }
}

/// The Settings pane's body: one card per group, laid out across the width the
/// pane actually has.
///
/// The list this replaced was built for the sheet and clamped to 460px, which
/// left two thirds of a settings window empty and every group in one long
/// column. Cards let the groups sit side by side, so the whole set is one
/// screenful — which is the only reason to open this screen rather than the
/// sheet.
class ShortcutsDeck extends StatelessWidget {
  const ShortcutsDeck({super.key});

  /// Narrower than this and a label wraps under its own keycaps. Public so the
  /// deck's tests can render a card at exactly the width it is least able to
  /// fit a chord in, which is the only width the overflow ever showed up at.
  static const double minCardWidth = 280;
  static const double _gap = 12;

  /// Past three columns the cards are wider than the deck needs and the eye
  /// has to travel the full window to read one group.
  static const int _maxColumns = 3;

  /// The deck stops growing here — a shortcut row is a label and a chord, and
  /// stretching that across a maximised display puts a metre of nothing
  /// between them.
  static const double maxWidth = 1040;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final rows = shortcutRows();
    final cards = <Widget>[
      for (final group in ShortcutGroup.values)
        _ShortcutCard(
          title: group.label,
          rows: rows.where((row) => row.group == group).toList(),
        ),
      const _TerminalCard(),
    ];

    return LayoutBuilder(
      builder: (context, constraints) {
        final width = math.min(constraints.maxWidth, maxWidth);
        final columns = ((width + _gap) / (minCardWidth + _gap)).floor().clamp(
          1,
          _maxColumns,
        );

        // Dealt round-robin rather than split into runs, so the cards keep
        // reading left to right in declaration order across the first row.
        // Columns then end at their own heights instead of every card in a row
        // stretching to the tallest — which is what a plain grid would do, and
        // what would leave a three-row card padded out to match a nine-row one.
        final lanes = List.generate(columns, (_) => <Widget>[]);
        for (var i = 0; i < cards.length; i++) {
          lanes[i % columns].add(cards[i]);
        }

        return ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: maxWidth),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var lane = 0; lane < lanes.length; lane++) ...[
                if (lane > 0) const SizedBox(width: _gap),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (var i = 0; i < lanes[lane].length; i++) ...[
                        if (i > 0) const SizedBox(height: _gap),
                        lanes[lane][i],
                      ],
                    ],
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

/// One group as a raised block — the same recipe a setting is stated in one
/// pane over, so Settings reads as one screen rather than four.
class _ShortcutCard extends StatelessWidget {
  const _ShortcutCard({required this.title, required this.rows});

  final String title;
  final List<ShortcutRow> rows;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      decoration: BoxDecoration(
        color: grid.AppGlass.surfaceFill,
        borderRadius: BorderRadius.circular(14),
        boxShadow: grid.AppGlass.cardShadow,
      ),
      padding: const EdgeInsets.fromLTRB(6, 14, 6, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Expanded(child: _CardTitle(title)),
                Text(
                  '${rows.length}',
                  style: TextStyle(
                    color: grid.AppPalette.textFaint,
                    fontSize: 10.5,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
          ),
          for (final row in rows)
            _ShortcutRowView(row: row, padding: _rowPadding),
        ],
      ),
    );
  }

  static const _rowPadding = EdgeInsets.symmetric(horizontal: 12, vertical: 5);
}

/// The keys this app does not take, and who has them.
///
/// Recessed, not raised: it is the one card here that is *not* a list of things
/// you can press in this app, and reading as a well rather than a block is what
/// says so before the title does.
class _TerminalCard extends StatelessWidget {
  const _TerminalCard();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      decoration: BoxDecoration(
        color: grid.AppSurface.recess,
        borderRadius: BorderRadius.circular(14),
      ),
      padding: const EdgeInsets.fromLTRB(6, 14, 6, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(12, 0, 12, 6),
            child: _CardTitle('The terminal keeps'),
          ),
          for (final key in kTerminalOwnedKeys)
            Padding(
              padding: _ShortcutCard._rowPadding,
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      key.label,
                      style: TextStyle(
                        color: grid.AppPalette.textFaint,
                        fontSize: 12.5,
                      ),
                    ),
                  ),
                  const SizedBox(width: 16),
                  KeyChordView(chords: [key.chord]),
                ],
              ),
            ),
          const Padding(
            padding: EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: ShortcutsNote(bare: true),
          ),
        ],
      ),
    );
  }
}

class _CardTitle extends StatelessWidget {
  const _CardTitle(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Text(
      label.toUpperCase(),
      style: TextStyle(
        color: grid.AppPalette.textFaint,
        fontSize: 10.5,
        letterSpacing: 0.08 * 10.5,
        fontWeight: grid.AppFont.medium,
      ),
    );
  }
}

/// Why the app takes so few keys — the sentence that turns "these shortcuts are
/// missing" into "those keys belong to the agent".
class ShortcutsNote extends StatelessWidget {
  const ShortcutsNote({super.key, this.bare = false});

  /// Inside the terminal card the wash would be a second surface on a surface,
  /// and the card's own recess already says the same thing. The sheet, which
  /// has nothing around it, keeps the wash.
  final bool bare;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final text = Text(
      'Everything else belongs to the agent. Ctrl keys, Esc, Tab and ⌥⏎ go '
      'straight to the terminal, so the engine and tmux keep the keys they '
      'already use.',
      style: TextStyle(
        color: grid.AppPalette.textSecondary,
        fontSize: 11.5,
        height: 1.5,
      ),
    );
    if (bare) return text;
    return Container(
      padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
      decoration: BoxDecoration(
        color: grid.AppSurface.accentWash,
        borderRadius: BorderRadius.circular(grid.AppCard.insetRadius),
      ),
      child: text,
    );
  }
}

class _GroupHeader extends StatelessWidget {
  const _GroupHeader({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 6),
      child: _CardTitle(label),
    );
  }
}

/// One shortcut: what it does on the left, the keys that do it on the right.
class _ShortcutRowView extends StatelessWidget {
  const _ShortcutRowView({required this.row, this.padding});

  final ShortcutRow row;
  final EdgeInsets? padding;

  /// Between the label and its keycaps.
  static const double _gutter = 16;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: padding ?? const EdgeInsets.symmetric(vertical: 3),
      // [KeyChordView] is a Wrap, but a Row hands an INFLEXIBLE child unbounded
      // width — so it never had the chance to wrap, and a chord wider than the
      // space left simply overflowed the card. Capping it at the row gives the
      // Wrap something to wrap inside.
      //
      // It took a flaky test to find: the widest chord ("Focus the previous
      // pane", 246.5px) fits the 268px row of a three-column deck with 5.5px to
      // spare, and only overflows — by 6.5px — once a card lands on
      // [ShortcutsDeck.minCardWidth] exactly. So the deck looked fine at every
      // width anyone had tried, and CI failed on a layout nobody could see.
      child: LayoutBuilder(
        builder: (context, constraints) => Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Text(
                row.label,
                style: TextStyle(
                  color: grid.AppPalette.textSecondary,
                  fontSize: 12.5,
                ),
              ),
            ),
            const SizedBox(width: _gutter),
            ConstrainedBox(
              constraints: BoxConstraints(
                maxWidth: math.max(0, constraints.maxWidth - _gutter),
              ),
              child: KeyChordView(chords: row.chords),
            ),
          ],
        ),
      ),
    );
  }
}
