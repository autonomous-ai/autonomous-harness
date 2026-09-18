import 'dart:math' as math;

import 'package:flutter/widgets.dart';

/// How far the terminal's header has travelled off the top, driven by scrolling.
///
/// The header is up while the terminal sits at its newest output, and away
/// while somebody is scrolled back into history. Scrolling back down to the end
/// is what brings it home.
///
/// ⚠️ **By position where there is one, by counting where there is not.** While
/// an agent runs a full-screen program — Claude Code does — the terminal is on
/// its ALTERNATE buffer, where scrolling moves no viewport at all: the gesture
/// becomes wheel events for the program, through a `Scrollable` whose extents
/// are both infinite (device logs showed `min=-Infinity max=Infinity`). The
/// program still scrolls its own history, so there the distance scrolled back
/// is counted instead — see [_altBack].
///
/// ⚠️ **Nothing replaces it.** `⋯` goes with the row and comes back with it;
/// Search and New agent never lived here, so a hidden header costs nothing but
/// the actions sheet until the scroll back down.
///
/// ⚠️ **The floating mic, Search and New agent are not driven from here and
/// must not be.** They carry what the mic needs somebody to read, which is
/// wanted most while things are moving.
///
/// ⚠️ **A value, not a boolean, and it animates.** The page reads it as 0 (fully
/// down) to 1 (fully gone) so the row can slide rather than blink.
///
/// ⚠️ **Not a [ChangeNotifier], and it must not become one.** [header] is an
/// [Animation] the row listens to on its own, so a scroll repaints a header and
/// nothing else. Notifying the page on every tick would rebuild the whole
/// terminal sixty times a second while somebody drags it.
///
/// ⚠️ **Nothing here may change the terminal's size.** The header slides over
/// the terminal rather than out of its column (`_SlideAway` in
/// `terminal_page.dart`): a fold that changed the row count resized the far
/// machine's shell, and brought back a keyframe and a full TUI redraw, on every
/// change of scroll direction.
class TerminalChromeScroll {
  TerminalChromeScroll({required TickerProvider vsync})
    : _header = AnimationController(
        vsync: vsync,
        duration: const Duration(milliseconds: 340),
      );

  /// What everything reads, rather than the controller underneath it.
  ///
  /// ⚠️ The raw controller is LINEAR, and a header that leaves at a constant
  /// speed reads as being dragged off by a machine. Easing out on the way there
  /// and in on the way back is what makes it look like it was let go of.
  late final CurvedAnimation _curved = CurvedAnimation(
    parent: _header,
    curve: Curves.easeOutCubic,
    reverseCurve: Curves.easeInCubic,
  );

  final AnimationController _header;

  /// How close to the newest output still counts as "at the end".
  ///
  /// ⚠️ **Not zero.** A fling settles with sub-pixel error, and a finger resting
  /// on the glass wobbles — either would flicker the row in and out at the end.
  static const double _endSlack = 8;

  /// On the alternate buffer, how far somebody has scrolled back from the end,
  /// in logical pixels, counted from the gestures themselves.
  ///
  /// ⚠️ **Counted, because there is nothing to read.** There the gesture is
  /// turned into wheel events for the program (Claude Code scrolls its own
  /// history this way), through a `Scrollable` with infinite extents — so the
  /// page never learns where the program is. Scrolling up adds, scrolling down
  /// pays it back, and paid back in full is "at the end". Floored at zero,
  /// since the program stops at its end however hard somebody keeps scrolling
  /// down.
  double _altBack = 0;

  /// 0 fully down, 1 fully off the top.
  Animation<double> get header => _curved;

  /// Puts the header back on screen, at once and without animating.
  ///
  /// For the cases where it must simply BE open and no gesture is going to open
  /// it: search growing out of its bar, the keyboard coming up, a swipe landing
  /// on a different agent.
  void reveal() {
    _altBack = 0;
    _header.value = 0;
  }

  /// Feeds one scroll notification in. Returns false so the notification carries
  /// on to anything else listening.
  ///
  /// ⚠️ **Every update, not only the ones a finger started.** A terminal at its
  /// end follows its own output and stays at the end, so those updates keep the
  /// header up; one scrolled back does not follow, so they keep it away.
  bool onNotification(ScrollNotification notification) {
    if (notification.metrics.axis != Axis.vertical) return false;
    if (notification is ScrollUpdateNotification) {
      _follow(notification.metrics, notification.scrollDelta ?? 0);
    } else if (notification is ScrollEndNotification) {
      _follow(notification.metrics, 0);
    }
    return false;
  }

  void _follow(ScrollMetrics metrics, double delta) {
    if (!metrics.hasContentDimensions || !metrics.hasPixels) return;
    final max = metrics.maxScrollExtent;
    final bool atEnd;
    if (max.isFinite) {
      _altBack = 0;
      atEnd = metrics.pixels >= max - _endSlack;
    } else {
      // The alternate buffer: the program scrolls itself, so where it is can
      // only be counted — see [_altBack].
      _altBack = math.max(0, _altBack - delta);
      atEnd = _altBack <= _endSlack;
    }
    if (atEnd) {
      if (_header.status != AnimationStatus.reverse && _header.value != 0) {
        _header.reverse();
      }
    } else if (_header.status != AnimationStatus.forward &&
        _header.value != 1) {
      _header.forward();
    }
  }

  void dispose() {
    // ⚠️ Before the controller it wraps: a CurvedAnimation holds a listener on
    // its parent, and disposing the parent first leaves that registration
    // pointing at a controller that has gone.
    _curved.dispose();
    _header.dispose();
  }
}
