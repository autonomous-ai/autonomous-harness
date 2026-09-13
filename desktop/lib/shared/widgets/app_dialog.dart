/// One way to open a dialog, so every dialog in the app stands on the same
/// veil.
///
/// Material's `showDialog` can only TINT what is behind a dialog —
/// `barrierColor` is a flat fill, and this app's background is terminals. Dimmed
/// text is still text: at any alpha that keeps the window feeling alive, the
/// lines behind a panel stay legible enough to read, and a reader's eye goes on
/// picking words out of them instead of settling on the thing that just opened.
///
/// So the barrier is BUILT rather than coloured — a [BackdropFilter] under a
/// tint, the pairing `task_palette.dart` already uses for its own veil. Blur
/// destroys the letterforms; the tint then sets the depth. Together they make
/// what is behind read as *behind*.
library;

import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// How far the app blurs what sits behind a dialog.
///
/// ⚠️ Bounded on purpose. A terminal is high-contrast text on a dark ground,
/// and far enough past this the glyphs stop reading as letters at all and
/// become a grey haze that looks like a rendering fault rather than depth. 7
/// is where a line behind the panel is unmistakably gone while the window
/// still reads as the window.
const double kDialogVeilBlur = 7;

/// The tint over that blur.
///
/// `rgba(0,0,0,.64)` — deeper than Material's own 54% black barrier looks over
/// a light page, because this one is laid over a dark one, where the same alpha
/// barely registers. Read against the panel's own fill rather than picked off a
/// scale: the dialog has to sit clearly in front of the veil, and the veil
/// clearly in front of the window.
const Color kDialogVeilTint = Color(0xA3000000);

/// The app's dialog barrier: a blur, then a tint, then whatever opened.
///
/// Use it in place of `showDialog` wherever a panel should take the window's
/// full attention. It keeps `showDialog`'s shape — the same `builder`,
/// `barrierDismissible` and return type — so a call site changes by its name
/// alone.
///
/// ⚠️ [barrierDismissible] is wired by hand, because the real barrier is
/// transparent: Material dismisses on a tap only when it draws the barrier
/// itself, and this one is a widget. The [GestureDetector] below is what keeps
/// a tap outside working, and `maybePop` rather than `pop` so a route that
/// refuses to leave (an unsaved form, say) still gets to refuse.
Future<T?> showAppDialog<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool barrierDismissible = true,
  String barrierLabel = 'Dismiss',
  Color veilTint = kDialogVeilTint,
  double veilBlur = kDialogVeilBlur,
  Duration transitionDuration = const Duration(milliseconds: 140),
}) => showGeneralDialog<T>(
  context: context,
  // The route's own barrier draws nothing: the veil below is the barrier.
  barrierColor: Colors.transparent,
  // Kept FALSE whatever the caller asked, and handled in the tree instead —
  // see the note above. Left true, Material would dismiss on a tap anywhere
  // over a barrier it believes is there, including a tap on the dialog.
  barrierDismissible: false,
  barrierLabel: barrierLabel,
  transitionDuration: transitionDuration,
  pageBuilder: (context, _, _) => _AppDialogVeil(
    tint: veilTint,
    blur: veilBlur,
    dismissible: barrierDismissible,
    child: Builder(builder: builder),
  ),
  transitionBuilder: (context, anim, _, child) => FadeTransition(
    opacity: CurvedAnimation(parent: anim, curve: Curves.easeOut),
    child: child,
  ),
);

/// The veil, and the dialog standing on it.
class _AppDialogVeil extends StatelessWidget {
  const _AppDialogVeil({
    required this.tint,
    required this.blur,
    required this.dismissible,
    required this.child,
  });

  final Color tint;
  final double blur;
  final bool dismissible;
  final Widget child;

  @override
  Widget build(BuildContext context) => _DismissOnEscape(
    enabled: dismissible,
    child: Stack(
      children: [
        Positioned.fill(
          child: GestureDetector(
            // `opaque`, so a tap on the veil is taken here rather than falling
            // through to whatever the window has underneath — a terminal would
            // otherwise get the click that was meant to close the panel.
            behavior: HitTestBehavior.opaque,
            onTap: dismissible ? () => Navigator.of(context).maybePop() : null,
            child: blur == 0
                ? ColoredBox(color: tint)
                : BackdropFilter(
                    filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
                    child: ColoredBox(color: tint),
                  ),
          ),
        ),
        // ⚠️ The dialog is NOT inside the GestureDetector above: nested in it,
        // a tap on the panel itself would close the panel.
        child,
      ],
    ),
  );
}

/// Closes the dialog on Escape.
///
/// ⚠️ **This exists because `showAppDialog` passes `barrierDismissible: false`
/// to the route, and that flag is not only about taps.** Flutter wires the
/// Escape key off the same flag: a modal route built with it false installs no
/// `DismissIntent` handler, so Escape reaches nothing. The barrier here is a
/// widget rather than the route's own, so the flag has to stay false — leaving
/// it true makes Material dismiss on a tap anywhere over a barrier it believes
/// it is drawing, the panel included — and the key has to be put back by hand,
/// exactly as the tap was.
///
/// It was missed when the tap was wired, and every dialog in the app lost
/// Escape with it — including the ones whose own chrome draws an `esc` cap.
///
/// `maybePop`, matching the tap: a route that refuses to leave still gets to
/// refuse.
class _DismissOnEscape extends StatelessWidget {
  const _DismissOnEscape({required this.enabled, required this.child});

  /// False leaves the key alone, so a dialog that opted out of tap-dismissal
  /// is not quietly closable by keyboard instead.
  final bool enabled;

  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (!enabled) return child;
    return Shortcuts(
      shortcuts: const {
        SingleActivator(LogicalKeyboardKey.escape): DismissIntent(),
      },
      child: Actions(
        actions: {
          DismissIntent: CallbackAction<DismissIntent>(
            onInvoke: (_) {
              Navigator.of(context).maybePop();
              return null;
            },
          ),
        },
        // A `Shortcuts` only sees a key once focus is somewhere inside it, and
        // not every dialog focuses something of its own — so the scope takes
        // focus itself when nothing else claims it.
        //
        // ⚠️ `Focus`, not `FocusScope`. Both autofocus, and a descendant that
        // also autofocuses (the model picker's search field) wins either way —
        // but a `FocusScope` additionally becomes the dialog's focus ROOT,
        // which changes where traversal wraps and what `unfocus` falls back
        // to. Nothing here wants to move those; this only needs to be a node
        // in the chain that holds focus when no descendant asks for it.
        // `skipTraversal` keeps it out of the tab order it is not a stop in.
        child: Focus(autofocus: true, skipTraversal: true, child: child),
      ),
    );
  }
}
