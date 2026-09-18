import 'package:flutter/widgets.dart';

/// How far the terminal's header has travelled off the top, driven by scrolling.
///
/// Scrolling forward sends it up and out at the first push; it comes back only
/// after a real journey in the other direction.
///
/// ⚠️ **Leaving is about intent; coming back is about distance.** Any scroll
/// forward hides the row — somebody reading ahead wants the screen, and wants it
/// now. But a flick upward in the middle of a long scrollback is still the
/// middle of a long scrollback, so the return is paid for in travel: see
/// [_returnTravel].
///
/// ⚠️ **It cannot be done by position, and that was measured rather than
/// assumed.** The obvious rule is "show the header when the content is back at
/// offset zero", and it was written that way first. While an agent runs a
/// full-screen program the terminal is on its ALTERNATE buffer, where scrolling
/// moves no viewport at all — the gesture becomes arrow keys for the program,
/// through a `Scrollable` whose extents are both infinite. Device logs showed
/// every notification the page gets carrying `min=-Infinity max=Infinity`, so
/// there is no zero to be near. Distance is what survives both buffers.
///
/// ⚠️ **What replaces it is not nothing.** The row's controls fly out of it as
/// it goes and come to rest as floating buttons down the right edge — see
/// `terminal_header_floats.dart`. They ride the same value, so there is no
/// moment where the header has gone and its controls have not arrived. A header
/// that simply went would have left the page with no way to search or to reach
/// the actions until somebody scrolled back for it.
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
        // ⚠️ **This one value paces the whole hand-over, which is why it is
        // longer than a plain hide would want.** The row sliding away is only half
        // of it: the three floating buttons fly out of the header on this same
        // clock, and each is staggered up to 0.2 behind the first — so the last
        // one gets barely two thirds of whatever is set here. At 200 the
        // sequence read as a snap rather than as a move.
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

  /// How far the content must move before the header is asked to do anything.
  ///
  /// ⚠️ **Not zero, and this is what keeps the header still.** A terminal that
  /// is streaming scrolls itself by a line at a time, and the finger resting on
  /// the glass reports sub-pixel wobble — either would have the row leaving on
  /// every frame of a scroll that is going nowhere.
  static const double _threshold = 6;

  /// How far back somebody must scroll, without turning round, before the header
  /// comes home.
  ///
  /// ⚠️ **Much larger than [_threshold], and deliberately asymmetric.** Leaving
  /// is about intent — one push forward means "give me the screen" — where
  /// coming back is about having actually travelled: more than a phone screen's
  /// worth of content, so a stray flick upward while reading does not drag the
  /// row back over the output underneath it.
  static const double _returnTravel = 300;

  /// Movement in one direction since the last time the header changed its mind,
  /// in logical pixels. Reset on every reversal, so the threshold is measured
  /// per-direction rather than as a running total.
  double _travel = 0;

  /// Whether the scroll now running was begun by a finger. See [onNotification].
  bool _dragging = false;

  /// 0 fully down, 1 fully off the top.
  Animation<double> get header => _curved;

  /// Puts the header back on screen, at once and without animating.
  ///
  /// For the cases where it must simply BE open and no gesture is going to open
  /// it: search growing out of its bar, the keyboard coming up, a swipe landing
  /// on a different agent.
  void reveal() {
    _travel = 0;
    // A gesture still in flight must not carry on driving the header it was just
    // told to show — a fling running under an opening search would send it back
    // off the top behind the overlay.
    _dragging = false;
    _header.value = 0;
  }

  /// Feeds one scroll notification in. Returns false so the notification carries
  /// on to anything else listening.
  ///
  /// ⚠️ **Only what a FINGER started gets through, and without that filter the
  /// header leaves by itself.** A terminal following its own output scrolls on
  /// every line the agent prints, and those arrive as ordinary updates: the
  /// header would fold away while somebody sat still and read, and come back the
  /// moment the agent went quiet.
  ///
  /// ⚠️ **The gate is on the START of the gesture, not on each update.** A
  /// thrown scroll keeps moving after the thumb is gone — `dragDetails` is null
  /// for every one of those frames, so testing each update would have dropped
  /// the whole fling, which is most of the distance somebody actually travels.
  /// [_dragging] carries the answer from the start notification through to the
  /// end of the ballistic run that follows it.
  bool onNotification(ScrollNotification notification) {
    if (notification is ScrollStartNotification) {
      _dragging = notification.dragDetails != null;
    } else if (notification is ScrollUpdateNotification) {
      if (_dragging) _onScrolled(notification.scrollDelta ?? 0);
    } else if (notification is ScrollEndNotification) {
      _dragging = false;
    }
    return false;
  }

  /// One scroll tick, in logical pixels. Positive is towards the newest output.
  ///
  /// ⚠️ **Distance travelled, not position, and the terminal leaves no choice.**
  /// While an agent is running a full-screen program the terminal is on its
  /// ALTERNATE buffer, and there scrolling does not move a viewport at all — the
  /// gesture is translated into arrow keys and handed to the program, through a
  /// `Scrollable` that reports `minScrollExtent: -infinity` and
  /// `maxScrollExtent: +infinity`. There is no offset zero to be near. This was
  /// established from the device rather than the source: every notification the
  /// page receives carries those infinities.
  ///
  /// So "back at the start" is measured as the only thing that survives both
  /// buffers — how far somebody has scrolled BACK, continuously, without
  /// turning round.
  void _onScrolled(double delta) {
    if (delta == 0) return;
    // ⚠️ A reversal resets the count rather than subtracting from it. Otherwise
    // a long scroll one way banks up travel that a short scroll back has to pay
    // off before anything moves, and the row ignores the first flick back.
    if (delta.isNegative != _travel.isNegative) _travel = 0;
    _travel += delta;

    // Going forward: away at the first deliberate push, because somebody
    // reading ahead wants the screen and wants it now.
    if (_travel >= _threshold) {
      _travel = 0;
      _header.forward();
      return;
    }

    // Coming back: only after a real journey. ⚠️ [_returnTravel], not
    // [_threshold] — a flick upward in the middle of a long scrollback is still
    // the middle of it, and a header that came back there sat over output
    // nobody had scrolled to the top of.
    //
    // Several quick flicks up count the same as one long drag: the tally only
    // resets when the direction turns round or when it has paid out, so the
    // distance accumulates across the lifts that a real journey is made of.
    if (-_travel >= _returnTravel) {
      _travel = 0;
      _header.reverse();
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
