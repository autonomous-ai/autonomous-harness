import 'package:flutter/widgets.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../state/app_state.dart';

/// The keys that mean something RIGHT NOW, along the bottom of the window.
///
/// ⌘/ already prints every shortcut this app has, and it is the wrong shape for
/// the problem it was given: a modal is something you go and look up, so it
/// teaches only the people who already suspect there is something to learn. The
/// keys nobody discovers are the ones nobody goes looking for.
///
/// zellij answers this with a strip along the bottom that changes with the mode,
/// and vim users answer it with which-key. Both work for the same reason — the
/// hint is in the corner of the eye during the work, not behind a gesture — and
/// both are read hundreds of times before they stop being read at all, which is
/// the mark of a good one: it teaches itself out of a job.
///
/// IT CHANGES WITH WHERE THE KEYBOARD IS, and that is most of its value. With
/// the cursor in the rail, `j` and `k` are live and plain — the one surface in
/// this app where an unmodified letter does something — and nothing else on
/// screen says so. A strip that printed the same six chords in both states
/// would be decoration.
///
/// It rides the strip that was already there rather than adding a second one.
/// That strip carries two usage figures and has the whole width to itself; a
/// row of hints costs no height and gives the surface a second reason to exist.
class KeyHints extends StatelessWidget {
  const KeyHints({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: notifier,
      builder: (context, _) {
        final hints = notifier.railFocused ? _railHints : _gridHints(notifier);
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final hint in hints) ...[
              _Hint(keys: hint.$1, what: hint.$2),
              const SizedBox(width: 14),
            ],
          ],
        );
      },
    );
  }

  /// In the rail: the four vim keys, unmodified, and the way out.
  static const List<(String, String)> _railHints = [
    ('j k', 'move'),
    ('⏎', 'open'),
    ('h', 'back'),
    ('esc', 'grid'),
  ];

  /// On the grid, and it is DELIBERATELY SHORT.
  ///
  /// Six chords is a strip people read; twelve is a wall they stop seeing, and
  /// then it has cost height and taught nothing. These are the ones that answer
  /// "what can I do from here" — go somewhere, make something, and the two that
  /// change the shape of the window.
  ///
  /// The zoom hint says which way it will go, because a key whose label does not
  /// match what it is about to do is worse than no label.
  static List<(String, String)> _gridHints(AppNotifier notifier) => [
    ('⌘hjkl', 'panes'),
    ('⌘P', 'go to agent'),
    ('⌘⏎', notifier.zoomedPaneId != null ? 'unzoom' : 'zoom'),
    ('⌘;', 'last'),
    ('⌘N', 'new'),
    ('⌘/', 'keys'),
  ];
}

class _Hint extends StatelessWidget {
  const _Hint({required this.keys, required this.what});

  final String keys;
  final String what;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          keys,
          style: TextStyle(
            fontSize: 10.5,
            // The chord is the brighter half. Someone scanning this is looking
            // for a key, not reading a sentence — the word after it only has to
            // confirm what they guessed.
            color: grid.AppPalette.textSecondary,
            fontFamily: grid.AppFont.sans,
            fontWeight: grid.AppFont.medium,
          ),
        ),
        const SizedBox(width: 5),
        Text(
          what,
          style: TextStyle(
            fontSize: 10.5,
            color: grid.AppPalette.textFaint,
            fontFamily: grid.AppFont.sans,
          ),
        ),
      ],
    );
  }
}
