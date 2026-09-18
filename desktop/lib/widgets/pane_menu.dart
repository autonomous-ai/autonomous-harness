import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'engine_identity.dart';
import 'transient_menus.dart';

/// The pane header's menu, as one shape for every list that wants to look like it.
///
/// Born in the model picker and shared from here so any second list that wants this shape is
/// the same menu rather than a second drawing of it: the same overlay, the same rows, the same
/// quiet fill on the current row instead of a tick.
///
/// Shown in an OVERLAY rather than as a modal route. `showMenu` puts a full-screen modal barrier
/// under its menu, and that barrier EATS the click that dismisses it: closing the menu and then
/// clicking what you meant to click took two clicks, with the first one going nowhere. A menu is
/// not a decision you have to finish before the app will listen again. So the dismisser is a
/// translucent [Listener] instead: it receives the pointer AND reports no hit, so the overlay
/// below it — the app — is hit-tested next and gets the same event. One click closes the menu and
/// lands where it was aimed.
///
/// [onOpen] hands the caller the entry and its closer, for a menu that wants to redraw itself
/// while open or to be closed from outside; [onClose] runs once, however the menu ended.
Future<T?> showPaneMenu<T>({
  required BuildContext context,
  required RelativeRect position,
  required List<Widget> Function(void Function(T?) close) children,
  void Function(OverlayEntry entry, void Function() close)? onOpen,
  VoidCallback? onClose,
  double minWidth = 340,
  double maxWidth = 540,
}) {
  final overlayState = Overlay.of(context);
  final completer = Completer<T?>();
  late final OverlayEntry entry;
  late final void Function() deregister;
  var closed = false;
  void close(T? choice) {
    // Guarded: a pointer-down outside and a row tap can both arrive for one gesture, and removing
    // an entry twice throws.
    if (closed) return;
    closed = true;
    deregister();
    entry.remove();
    onClose?.call();
    if (!completer.isCompleted) completer.complete(choice);
  }

  // A click on the window's NATIVE tab strip is not a pointer event Flutter ever sees, so the
  // dismisser below cannot fire for it — the menu was left floating over a tab it no longer
  // belonged to. The titlebar reports its own clicks instead; see [dismissTransientMenus].
  deregister = registerTransientMenu(() => close(null));

  entry = OverlayEntry(
    builder: (context) => Stack(
      children: [
        Positioned.fill(
          child: Listener(
            behavior: HitTestBehavior.translucent,
            onPointerDown: (_) => close(null),
            child: const SizedBox.expand(),
          ),
        ),
        Positioned(
          // Right-aligned to the control, which sits at the right end of a pane header — anchoring
          // the left edge would push a wide menu off-screen.
          right: position.right,
          top: position.top,
          child: ConstrainedBox(
            // Wide enough that a status can sit right-aligned against a model id without the two
            // meeting, and for a full GGUF-style model id beside its node without either cut.
            constraints: BoxConstraints(minWidth: minWidth, maxWidth: maxWidth),
            // ⚠️ IntrinsicWidth, or the menu is ALWAYS [maxWidth] wide. `Positioned` hands down
            // unbounded width, the ConstrainedBox turns that into "up to maxWidth", and a
            // stretching Column takes all of it — so a two-line menu wore the width of the longest
            // model id it could ever hold. This measures the rows and the clamp then applies to
            // what they actually need.
            child: IntrinsicWidth(
              child: Material(
                color: AppColors.surface,
                elevation: 8,
                borderRadius: BorderRadius.circular(8),
                clipBehavior: Clip.antiAlias,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: children(close),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    ),
  );
  onOpen?.call(entry, () => close(null));
  overlayState.insert(entry);
  return completer.future;
}

/// One selectable row of a pane menu.
///
/// The hover is the SAME rectangle as the selected fill — inset by [kPaneMenuInset] and rounded
/// the same — so a row looks like one thing whether the pointer is on it or the choice is. An
/// InkWell around the whole item painted edge to edge and square, over a selected fill that was
/// neither, and the two reading as different shapes made the current row look like the odd one
/// out.
/// ⚠️ The cursor is STATED, in both places that can answer for it. A pane menu is drawn in an
/// overlay above a terminal, and what a person sees while hovering a row was whatever the surface
/// underneath asked for — an arrow over rows that are the whole point of the menu. `InkWell` carries
/// a clickable cursor of its own in principle, and in this app it was not what reached the screen;
/// the control that OPENS this menu needed both annotations before a hand appeared, and these rows
/// need the same. The cursor a person sees is the innermost annotation under the pointer, so the
/// MouseRegion covers the row and the InkWell answers for its own ink.
Widget paneMenuItem({required VoidCallback onTap, required Widget child}) =>
    Padding(
      padding: const EdgeInsets.symmetric(horizontal: kPaneMenuInset),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: InkWell(
          onTap: onTap,
          mouseCursor: SystemMouseCursors.click,
          borderRadius: BorderRadius.circular(kPaneMenuRowRadius),
          child: child,
        ),
      ),
    );

/// A line that states something rather than offering it — no hover, no tap.
Widget paneMenuEmpty(String text) => Padding(
  padding: const EdgeInsets.fromLTRB(
    kPaneMenuInset + kPaneMenuRowPadding,
    5,
    kPaneMenuInset + kPaneMenuRowPadding,
    6,
  ),
  child: Text(text, style: TextStyle(fontSize: 11, color: AppColors.textSoft)),
);

/// A section label. Non-interactive and short, so the groups read as groups rather than as
/// entries someone failed to make clickable.
///
/// A rule used to run from the label to the menu's edge to make a heading read as a line that
/// divides. [caption], when given, is a second line UNDER the label — a specific name under a
/// heading that is a plain sentence ("Models shared with you" / "autonomous.ai"). It used to sit
/// on the same line as the label, joined by a middot ("Local · your machines"), which read as two
/// half-sentences forced together rather than as one heading and one detail under it.
Widget paneMenuHeader(String label, {String? caption}) => Padding(
  // The row's margin plus its internal padding, so a header sits directly above the text it
  // heads rather than a few pixels to either side of it.
  padding: const EdgeInsets.fromLTRB(
    kPaneMenuInset + kPaneMenuRowPadding,
    6,
    kPaneMenuInset + kPaneMenuRowPadding,
    3,
  ),
  child: Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        label,
        style: TextStyle(
          fontSize: 10.5,
          fontWeight: FontWeight.w600,
          letterSpacing: .3,
          color: AppColors.mutedStrong,
        ),
      ),
      if (caption != null)
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Text(
            caption,
            style: TextStyle(fontSize: 10.5, color: AppColors.textSoft),
          ),
        ),
    ],
  ),
);

/// One row of a pane menu: a title, an optional mark before it ([engine]'s mark or any
/// [leading]), a short [detail] after it, a right-aligned [status], and a [subtitle] under it
/// inside the same fill. The current row carries a quiet fill — subtle on purpose: one row in the
/// menu is already the current one, and a mark loud enough to announce that would compete with
/// the thing a person opened the menu to read.
class PaneMenuRow extends StatelessWidget {
  final bool selected;
  final String? engine;
  final Widget? leading;
  final String title;
  final String detail;
  final String? status;
  final String? subtitle;

  const PaneMenuRow({
    super.key,
    required this.selected,
    required this.title,
    this.engine,
    this.leading,
    this.detail = '',
    this.status,
    this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    final row = Row(
      children: [
        if (engine != null) ...[
          EngineMark(engine: engine, size: 14),
          const SizedBox(width: 7),
        ] else if (leading != null) ...[
          leading!,
          const SizedBox(width: 7),
        ],
        // ⚠️ Expanded on the TITLE, not on the status. The status is a handful of characters and
        // wants only what it needs; giving it the flexible half truncated
        // `Qwen3.6-35B-A3B-UD-Q5_K_XL` to `Qwen3.6-35B-A3B-UD-Q5_K…` while empty space sat beside
        // it. The long string here is the model id, so the model id is what gets the room.
        Expanded(
          child: Text(
            title,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 12.5,
              // Stated rather than inherited: a PopupMenuItem's default text style is heavier than
              // this menu wants, which read as every row being emphasised.
              fontWeight: FontWeight.w400,
              color: AppColors.text,
            ),
          ),
        ),
        if (detail.isNotEmpty) ...[
          const SizedBox(width: 6),
          Text(
            detail,
            style: TextStyle(fontSize: 11, color: AppColors.mutedStrong),
          ),
        ],
        if (status != null) ...[
          const SizedBox(width: 14),
          Text(
            status!,
            style: TextStyle(fontSize: 11, color: AppColors.mutedStrong),
          ),
        ],
      ],
    );
    return Container(
      // No margin of its own: the inset is the item's (see [paneMenuItem]), so that the hover the
      // item paints and the fill this row paints are one and the same rectangle.
      padding: const EdgeInsets.symmetric(
        horizontal: kPaneMenuRowPadding,
        vertical: 5,
      ),
      decoration: selected
          ? BoxDecoration(
              color: AppColors.selected,
              borderRadius: BorderRadius.circular(kPaneMenuRowRadius),
            )
          : null,
      // The subtitle sits INSIDE the fill, under the title: it is about this row, and a sentence
      // hanging below the highlight would read as belonging to the next one.
      child: subtitle == null
          ? row
          : Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                row,
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    subtitle!,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 10.5, color: AppColors.textSoft),
                  ),
                ),
              ],
            ),
    );
  }
}

/// The row's own inset from the menu edge, and the padding inside its highlight. A section header
/// carries their SUM as a left inset, so header text sits exactly above the row text it heads.
const double kPaneMenuInset = 6;
const double kPaneMenuRowPadding = 8;

/// One radius for the hover and the selected fill: they are the same shape.
const double kPaneMenuRowRadius = 5;
