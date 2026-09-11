import 'dart:io' show Platform;

import 'package:flutter/widgets.dart';
import 'package:window_manager/window_manager.dart';

import '../shared/theme/app_theme.dart' as grid;

/// How far a full-width strip drawn at the very top of the window has to
/// start from the left to clear the traffic lights.
double get trafficLightClearance => Platform.isMacOS ? 78.0 : 0.0;

/// The traffic lights' own row, as a drag handle.
///
/// Public because screens have to place their own controls clear of it: this
/// band belongs to AppKit, so a button drawn inside it renders correctly and
/// never responds. A screen that puts anything clickable near the top edge
/// offsets by this rather than by a 28 typed locally, which would be a second
/// copy of a number that must not drift.
const double windowDragBandHeight = 28;

/// The window's own strip, above everything the app draws.
///
/// ⚠️ THIS IS NOT DECORATION — IT IS WHAT GIVES THE CONTENT BELOW IT ITS INPUT
/// BACK. `TitleBarStyle.hidden` sets `titlebarAppearsTransparent` and
/// `fullSizeContentView`, which does not remove the title bar: it makes it
/// transparent and lets the content run underneath. AppKit still owns dragging
/// in that band, and once it takes a gesture it keeps it — Flutter stops
/// getting move events for it. So anything the app draws in the top ~28px can
/// be looked at but not dragged, which is why dragging a pane's header moved
/// the whole window, and why it worked in full screen: there the window has
/// nowhere to go, so the Flutter drag wins by default.
///
/// [_barHeight] is therefore a floor, not a taste: it must clear
/// [windowDragBandHeight]. The extra 4px is what the rail used to inset itself by.
class HarnessTopBar extends StatelessWidget {
  const HarnessTopBar({super.key});

  /// Zero off macOS: there the native caption bar already holds this space, and
  /// a second strip under it would be a gap with nothing in it.
  static double get height => Platform.isMacOS ? 32.0 : 0.0;

  @override
  Widget build(BuildContext context) {
    if (!Platform.isMacOS) return const SizedBox.shrink();
    grid.AppTheme.watch(context);
    return DragToMoveArea(
      child: Container(
        height: height,
        decoration: BoxDecoration(
          color: grid.AppPalette.panelBg,
          border: Border(bottom: BorderSide(color: grid.AppGlass.hair)),
        ),
        padding: EdgeInsets.only(left: trafficLightClearance),
        alignment: Alignment.centerLeft,
        child: Text(
          'Harness',
          style: TextStyle(
            fontSize: 12.5,
            fontWeight: FontWeight.w600,
            color: grid.AppPalette.textSecondary,
          ),
        ),
      ),
    );
  }
}

/// A window drag handle that does not hold up the controls drawn inside it.
///
/// window_manager's own [DragToMoveArea] binds double-tap-to-maximize as well
/// as the drag, and a `DoubleTapGestureRecognizer` **holds the gesture arena**
/// for `kDoubleTapTimeout` (300ms) after the first tap comes up — it has to,
/// or it could never see a second one. Nothing else in that arena resolves
/// until it lets go, so every button inside one of those regions fires 300ms
/// after the mouse was released. That is the rail header (fold, reload,
/// filter), a pane header's close, and the update strip's Install: the whole
/// top edge of the window, which is also the part of it people click most.
///
/// The maximize gesture is worth having on a strip that holds nothing —
/// [HarnessTopBar] and [WindowDragStrip] keep [DragToMoveArea] for it — and is
/// not worth 300ms on every control in the app's chrome.
class WindowDragArea extends StatelessWidget {
  const WindowDragArea({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      // Translucent, like DragToMoveArea: the drag has to be available from
      // the gaps between whatever the region draws.
      behavior: HitTestBehavior.translucent,
      onPanStart: (_) => windowManager.startDragging(),
      child: child,
    );
  }
}

/// A strip along the top of a screen that fills the window, so it can still be
/// dragged with the title bar gone. Zero height off macOS, where the native
/// caption bar does this itself.
class WindowDragStrip extends StatelessWidget {
  const WindowDragStrip({super.key});

  @override
  Widget build(BuildContext context) {
    return DragToMoveArea(
      child: SizedBox(
        height: Platform.isMacOS ? windowDragBandHeight : 0,
        width: double.infinity,
      ),
    );
  }
}

/// A screen that takes the whole window — sign-in, first-run setup — with a
/// drag strip laid over its top edge.
///
/// Overlaid rather than stacked above, so the screen's own centring does not
/// shift by half a strip; these screens centre a card and draw nothing at the
/// top that the lights could cover.
class FullWindowScreen extends StatelessWidget {
  const FullWindowScreen({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        Positioned.fill(child: child),
        const Positioned(top: 0, left: 0, right: 0, child: WindowDragStrip()),
      ],
    );
  }
}
