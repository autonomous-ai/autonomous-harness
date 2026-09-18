import 'dart:async';

import 'package:flutter/material.dart';
// `PlatformException` — a refused camera permission arrives as one, and it is
// the one picker failure with something the person can do about it.
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/models.dart' show Agent;
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/app_icon_button.dart';
import 'package:harness_mobile/shared/widgets/pulse.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/image_transcode.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/terminal/terminal_theme.dart';
import 'package:harness_mobile/terminal/terminal_theme_store.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/widgets/rename_agent_dialog.dart';
import 'package:harness_mobile/widgets/terminal_panel.dart';

import 'agents_page.dart' show openNewAgent;
import 'delete_agent.dart';
import 'machines_tab.dart';
import 'phone_navigation.dart' show phoneRoute;
import 'phone_sheet.dart';
import 'phone_status.dart';
import 'settings_page.dart';
import 'status_pill.dart';
import 'terminal_chrome_scroll.dart';
import 'terminal_foot_bar.dart';
import 'terminal_header.dart';
import 'terminal_header_floats.dart';
import 'terminal_input_dock.dart';
import 'terminal_search.dart';
import 'voice_input_controller.dart';
import 'voice_mic_fab.dart';
import 'voice_mic_mode.dart';

/// One agent's terminal, filling the phone. The header says whose it is and whether it is live;
/// everything below it is the same [TerminalPanel] a desktop tile draws, minus that tile's own
/// header.
///
/// A pushed page, so the tab bar is covered: the bottom of this screen belongs to the composer, and
/// a nav bar under it would put two rows of chrome in the thumb's way.
class TerminalPage extends StatefulWidget {
  const TerminalPage({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.agentId,
    required this.voice,
    this.isActive = true,
  });

  final AppNotifier notifier;
  final String machineId;
  final String agentId;

  /// Voice input, shared by every page of the pager this page is in — see
  /// [VoiceInputController] for why it is not this page's own.
  final VoiceInputController voice;

  /// Whether this is the page being LOOKED AT, rather than one parked beside it in the pager.
  ///
  /// ⚠️ **Load-bearing for correctness, not just for tidiness.** [TerminalPanel] claims the keyboard
  /// whenever it is built focused — `requestKeyboard()` reopens the input connection on purpose — so
  /// two mounted pages both passing `focused: true` race for the software keyboard, and the winner
  /// can be the page off-screen. What gets typed then reaches an agent nobody is looking at.
  ///
  /// It also drives the panel's `visible`, which is what releases focus and stops the auto-resize for
  /// a page that has slid away — three terminals all resizing themselves to the layout would send
  /// SIGWINCH to three remote shells at once.
  final bool isActive;

  @override
  State<TerminalPage> createState() => _TerminalPageState();
}

/// Whether the software keyboard is up, as one fact rather than as a flag each
/// page keeps for itself.
///
/// ⚠️ Per-page state cannot answer the question the pager asks. Swiping to the
/// next agent while typing must HOLD the keyboard — the outgoing page releases
/// focus, and unless the incoming one takes it in the same frame the platform
/// closes the keyboard — and a page built while the keyboard was down, then
/// swiped to after it rose, never watched it rise. Whether the keyboard is up is
/// a property of the SCREEN, not of any one page, so it is kept once here.
///
/// Written by every mounted page's `didChangeMetrics` — they all see the same
/// inset, so they all write the same value.
bool _keyboardIsUp = false;

/// Set while a swipe has asked the keyboard to go and the platform has not
/// finished taking it away.
///
/// ⚠️ **Without this, dismissing on a swipe silently does nothing.** The
/// keyboard leaves over an animation, so for the ~250ms after `unfocus()` the
/// inset is still above zero — and every mounted page's [didChangeMetrics] is
/// firing on every frame of that animation, each one writing `_keyboardIsUp =
/// true` again. The page being swiped to then reads the flag it was supposed to
/// have lost, passes `focused: true` to [TerminalPanel], and the panel's
/// `didUpdateWidget` claims the input connection back. The keyboard never goes,
/// and nothing in the code looks wrong.
///
/// So the writes are held off until the inset actually reaches zero, which is
/// the platform confirming the keyboard is gone. From that tick on, the flag
/// tracks the truth again as it always did.
bool _keyboardDismissing = false;

/// Forgets what the keyboard did during the last run of terminal pages.
///
/// Called when a pager opens. A pager popped with the keyboard up is disposed
/// before the inset falls, so no page is left to see it fall — and the next
/// pager would otherwise open believing the keyboard is up, and summon it.
void resetKeyboardSession() {
  _keyboardIsUp = false;
  _keyboardDismissing = false;
}

/// Puts the keyboard away for a swipe between agents, and keeps it away.
///
/// ⚠️ **Dropping focus alone does nothing here, and neither does clearing the
/// flag.** [_keyboardIsUp] exists to HOLD the keyboard across a swipe — that is
/// what it was written for — so the incoming page reads it and claims the
/// keyboard straight back. Clearing it is therefore necessary, but not enough on
/// its own: the inset is still falling, and the metrics ticks of that fall put
/// it back. [_keyboardDismissing] is what makes the clear stick until the
/// platform agrees.
///
/// ⚠️ Held off only when a keyboard is actually up. With none, no inset ever
/// falls to zero to end the hold-off, and it would swallow the rise of the next
/// keyboard summoned — which the page would then not know it owns.
void dismissKeyboardForSwipe() {
  _keyboardDismissing = _keyboardDismissing || _keyboardIsUp;
  _keyboardIsUp = false;
  FocusManager.instance.primaryFocus?.unfocus();
}

class _TerminalPageState extends State<TerminalPage>
    with WidgetsBindingObserver, TickerProviderStateMixin {
  /// Whether this page's pane ever existed.
  ///
  /// ⚠️ Load-bearing, and the reason this page is stateful at all. The page is pushed BEFORE the
  /// attach — that is what lets it say "Attaching…" — so a null pane means two opposite things
  /// depending on when it is seen: not yet (wait) or no longer (leave).
  ///
  /// Without the distinction, the second case renders as a spinner that never resolves. It is
  /// reachable in normal use now that two tabs can each open a terminal: `openAgent` keeps exactly
  /// one pane, so opening an agent from the Machines tab closes the pane belonging to a
  /// TerminalPage still sitting in the Agents tab's stack.
  bool _hadPane = false;

  /// The agent's name as the last list to carry it knew it.
  ///
  /// Held because the sentence [_AgentGone] shows is about an agent that is, by
  /// then, in no list at all — the name has to be captured while it is still
  /// there or the screen can only say "that agent".
  String? _cachedAgentName;

  /// Whether a tap on the terminal has asked for the keyboard, and it has not
  /// risen yet.
  ///
  /// What makes [TerminalPanel] claim focus at all: arriving on a page raises
  /// nothing, and the panel takes the terminal's tap for [_raiseKeyboard], so
  /// this is the one way the keyboard is SUMMONED. Spent the moment the
  /// keyboard is up — from then on [_keyboardIsUp] holds it — so Back or `⌄`
  /// can put it away without a claim fetching it straight back.
  ///
  /// It stays set when no inset ever arrives, which is what a hardware keyboard
  /// looks like: the terminal keeps its focus, and the key bar stays for `esc`.
  bool _keyboardRequested = false;

  /// Whether the software keyboard is up, and with it [TerminalKeyBar].
  ///
  /// Read from [View] for the reason [didChangeMetrics] gives: MediaQuery's
  /// bottom inset is pinned at zero inside this page.
  bool _keyboardUp = false;

  /// Whether the keyboard is mid-animation, and so the pane's height is still
  /// changing frame by frame. Handed to [TerminalPanel.settling], which holds
  /// the remote resize until this clears.
  bool _keyboardSettling = false;

  /// Whether a hold in progress on the mic has been dragged off it, so letting
  /// go would throw the take away.
  ///
  /// Kept here rather than in either widget because it crosses between them: the
  /// floating button is what feels the finger leave, and the foot row at the
  /// other end of the page is what can say so in words — the thumb is covering
  /// the button itself.
  ///
  /// [VoiceMicMode.tapToToggle] leaves it false forever; that mode has no hold
  /// to slide out of.
  bool _micSlippedOff = false;

  /// Drives search opening out of the header bar and collapsing back into it.
  ///
  /// ⚠️ **One controller for both halves of the move, read by both.** The search
  /// overlay grows on it while the terminal and its chrome fade out on the same
  /// value — two controllers, or an implicit animation on either side, would let
  /// the two drift apart on a dropped frame and show the terminal through the
  /// gap.
  /// ⚠️ Unhurried on purpose. Nothing here moves any more — the header swaps
  /// one control for another and the results fade up — and a cross-fade run
  /// fast enough for a slide reads as a flicker rather than as an exchange. The
  /// way back is a little quicker than the way in, the way dismissals usually
  /// are.
  late final AnimationController _searchOpen = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 420),
    reverseDuration: const Duration(milliseconds: 340),
  );

  /// The curve everything on the open/close reads.
  ///
  /// ⚠️ Eased at BOTH ends, where this was once eased out alone. An ease-out
  /// starts at its quickest, which suits something travelling into place —
  /// nothing here travels. What is left is opacity, and opacity leaving its
  /// resting value at full speed is seen as a blink at the start of the fade.
  late final Animation<double> _searchCurve = CurvedAnimation(
    parent: _searchOpen,
    curve: Curves.easeInOutCubic,
    reverseCurve: Curves.easeInOutCubic,
  );

  /// Whether the search overlay is BUILT — true from the first frame of the
  /// opening animation to the last frame of the closing one.
  ///
  /// ⚠️ Not the same question as "is the animation at 1". The overlay holds a
  /// focused [TextField], so it must come down the moment the collapse finishes
  /// and not a frame later — a field left mounted behind the terminal keeps the
  /// keyboard and swallows what the terminal is owed.
  bool _searching = false;

  /// The header getting out of the way as the terminal is scrolled. See
  /// [TerminalChromeScroll].
  late final TerminalChromeScroll _chrome = TerminalChromeScroll(vsync: this);

  /// The last bottom inset seen, in physical pixels, and the timer that decides
  /// the animation has stopped.
  ///
  /// The platform gives no "keyboard animation finished" callback on either OS —
  /// only a stream of [didChangeMetrics] ticks — so the end is detected by the
  /// inset going quiet. The window is a little longer than one frame at 60Hz so
  /// a slow frame mid-animation does not read as the end of it.
  ///
  /// Starts at zero: see [didChangeMetrics] for why an unknown inset is taken
  /// for a keyboard that is down.
  double _lastInset = 0;
  Timer? _settleTimer;
  static const _settleWindow = Duration(milliseconds: 80);

  /// Stops the settle watch, leaving the remote resize live.
  ///
  /// ⚠️ Called from [dispose], so it must not touch [setState].
  void _cancelSettle() {
    _settleTimer?.cancel();
    _settleTimer = null;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  /// Releases the resize hold when this page is parked mid-animation.
  ///
  /// A settle left running would end on a page that is no longer on screen, and
  /// the pane would come back from the pager still holding its resize.
  @override
  void didUpdateWidget(TerminalPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.isActive && !widget.isActive) {
      // ⚠️ Parked pages come back with their chrome shown. A page swiped away
      // with its header hidden would arrive that way the next time it is swiped
      // to — chrome missing on a screen nobody has scrolled yet, and no gesture
      // on the new page to bring it back.
      _chrome.reveal();
      // A keyboard asked for and still on its way belongs to the page that
      // asked; a parked page must not claim it when it comes.
      _keyboardRequested = false;
      _cancelSettle();
      if (_keyboardSettling) setState(() => _keyboardSettling = false);
    }
  }

  @override
  void dispose() {
    _cancelSettle();
    _chrome.dispose();
    _searchOpen.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// The three the header held, for when the row is not on screen to hold them.
  ///
  /// ⚠️ Built from the same conditions as the header's own row, so the column
  /// never offers something the row would have withheld — `+` needs a machine
  /// that is answering, `⋯` needs an agent that has loaded. That also means the
  /// column can be two buttons rather than three, which is why its height is
  /// computed rather than fixed.
  List<TerminalHeaderChoice> _headerChoices(
    MachineState? machine,
    Agent? agent,
  ) => [
    TerminalHeaderChoice(
      icon: LucideIcons.search300,
      label: 'Search',
      onTap: _openSearch,
    ),
    if (machine != null &&
        phoneMachineStatusOf(machine) == PhoneMachineStatus.ready)
      TerminalHeaderChoice(
        icon: LucideIcons.plus300,
        label: 'New agent',
        onTap: () async {
          await openNewAgent(context, widget.notifier, widget.machineId);
          if (mounted) setState(() {});
        },
      ),
    if (agent != null)
      TerminalHeaderChoice(
        icon: LucideIcons.ellipsis300,
        label: 'Agent actions',
        onTap: () => _showActions(
          machineName: machine?.machine.displayName ?? '',
          agentName: agent.name,
        ),
      ),
  ];

  /// Where each floating button starts its flight, relative to where it lands.
  ///
  /// ⚠️ **Worked out from the header's own constants rather than measured.** A
  /// [GlobalKey] on each control would give the true rectangles, but the header
  /// is being taken apart at exactly the moment these are read — its render
  /// objects are mid-shrink, and half of them are already gone. Constants are
  /// the only description of where the row's controls WERE that survives the row
  /// leaving.
  ///
  /// The trade is that the origins drift if the header's layout changes without
  /// this changing with it. That shows up as buttons flying from slightly the
  /// wrong place, never as a crash or a missed target.
  List<Offset> _headerOrigins(int count) {
    // The column's own geometry: each button rests [pitch] below the one above,
    // with the first at [inset] from the top.
    const inset = TerminalHeaderFloats.inset;
    const pitch = TerminalHeaderFloats.pitch;
    const extent = TerminalHeaderFloats.extent;

    // Where the header's controls sat, as centres measured from the top-right of
    // the safe area. The trailing actions are [_HeaderAction]s: 24px boxes with
    // 7 either side, laid from the right edge inwards past the header's own
    // 14pt inset.
    const actionPitch = 24 + _HeaderAction.gap * 2;
    final headerMidY = TerminalHeader.topInset + TerminalHeader.barHeight / 2;

    return [
      for (var i = 0; i < count; i++)
        () {
          // ⚠️ The FIRST choice is search, and it came from the bar — which
          // spans the row rather than sitting at a point. Its left end is where
          // the magnifier is, and that is what the button flies from.
          final fromRight = i == 0
              ? _searchGlyphFromRight(context)
              : TerminalHeader.sideInset +
                    actionPitch * (count - 1 - i) +
                    actionPitch / 2;
          final restFromRight = inset + extent / 2;
          final restY = inset + i * pitch + extent / 2;
          return Offset(restFromRight - fromRight, headerMidY - restY);
        }(),
    ];
  }

  /// How far the search bar's magnifier sits from the screen's right edge.
  ///
  /// The bar fills what the trailing actions leave, so this is the whole width
  /// less the row's insets and the glyph's own place inside the bar.
  double _searchGlyphFromRight(BuildContext context) =>
      MediaQuery.sizeOf(context).width -
      TerminalHeader.sideInset -
      TerminalHeader.barPadding -
      TerminalHeader.glyphSize / 2;

  /// Grows the header's bar into the search screen.
  ///
  /// ⚠️ The overlay is mounted on THIS frame and the animation started on it,
  /// so the field is there to take the keyboard as the bar opens. Starting the
  /// animation first and mounting at the end would land the caret after the
  /// move, which is a beat too late for a bar that was tapped to type in.
  void _openSearch() {
    if (_searching) return;
    // The bar being tapped may be a bar that scrolling had slid halfway off. It
    // has to be home before the overlay's copy grows out of it, or the two start
    // from different places and the expansion reads as a jump.
    //
    _chrome.reveal();
    setState(() {
      _searching = true;
      // ⚠️ Handed over, not left standing. The bar can be tapped with the
      // terminal's own keyboard already up, and a claim still outstanding would
      // race the search field for it the moment the inset ticks — the panel
      // would win and the query would be typed into the shell.
      _keyboardRequested = false;
    });
    _searchOpen.forward();
  }

  /// Collapses it back into the bar, and takes the overlay down once it is home.
  ///
  /// ⚠️ **Guarded on the controller's own status, not on [_searching].** Cancel
  /// and the system back gesture can both arrive while the reverse is already
  /// running — a second `reverse()` restarts it from wherever it had got to, and
  /// the bar visibly bounces.
  void _closeSearch() {
    if (!_searching || _searchOpen.status == AnimationStatus.reverse) return;
    _searchOpen.reverse().whenCompleteOrCancel(() {
      // A completed reverse is the only thing that unmounts the overlay; a
      // CANCELLED one means the search was opened again mid-collapse, and taking
      // the field down then would drop the keyboard it has just been given.
      if (!mounted || _searchOpen.status != AnimationStatus.dismissed) return;
      setState(() => _searching = false);
    });
  }

  /// Watches the keyboard through [View], because MediaQuery lies to this page.
  ///
  /// ⚠️ `MediaQuery.viewInsetsOf(context).bottom` is ALWAYS ZERO here, keyboard
  /// up or down. `PhoneShell` puts this page's Navigator inside a `Scaffold`
  /// body, and a Scaffold that has already resized for the keyboard STRIPS the
  /// bottom inset from the MediaQuery it hands its body — the body must not
  /// subtract it twice. Every descendant therefore reads zero.
  ///
  /// [View.of] is the raw platform value, in PHYSICAL pixels, and no widget can
  /// intercept it.
  @override
  void didChangeMetrics() {
    super.didChangeMetrics();
    if (!mounted) return;
    final inset = View.of(context).viewInsets.bottom;
    final up = inset > 0;
    // Every mounted page writes it, and they all see the same inset — so a page
    // that was parked while the keyboard came and went still reads the truth.
    //
    // ⚠️ Except while a swipe is putting the keyboard away: the inset is still
    // falling then, and writing `true` from those ticks is exactly what used to
    // undo the dismissal. See [_keyboardDismissing]. Zero is the platform
    // saying the keyboard has finished leaving, which ends the hold-off.
    if (_keyboardDismissing) {
      if (!up) _keyboardDismissing = false;
    } else {
      _keyboardIsUp = up;
    }
    // The FIRST frame of the keyboard rising spends the request — it need not
    // finish. Spending it this early is the point: it is off long before any
    // Back press can arrive.
    final requested = _keyboardRequested && !up;
    // One input at a time. Whatever raised the keyboard, voice input yields —
    // the mic's row is hidden under the key bar, and a take nobody can see is a
    // microphone left on.
    if (up && !widget.voice.isIdle) widget.voice.clear();

    // Every tick that MOVES the inset is the animation still running; the run
    // ends when one window passes without another move. Gated on a real change
    // so the ticks this page gets for everything else — a rotation, a status
    // bar resizing — never freeze a pane whose height is not moving.
    //
    // ⚠️ The baseline starts at zero, a keyboard that is DOWN. The first tick a
    // page ever sees is almost always the keyboard's first frame on its way up,
    // and taking that tick as a mere baseline let the pane resize the remote
    // shell at the half-risen height before the settle began — two SIGWINCHes
    // and two redraws for one keyboard. A page arriving under a keyboard already
    // up costs one needless 80ms hold, and nothing else.
    final previous = _lastInset;
    _lastInset = inset;
    if (inset != previous) {
      _settleTimer?.cancel();
      _settleTimer = Timer(_settleWindow, () {
        _settleTimer = null;
        if (!mounted || !_keyboardSettling) return;
        setState(() => _keyboardSettling = false);
      });
    }

    final settling = _settleTimer != null;
    if (up == _keyboardUp &&
        requested == _keyboardRequested &&
        settling == _keyboardSettling) {
      return;
    }
    setState(() {
      _keyboardUp = up;
      _keyboardRequested = requested;
      _keyboardSettling = settling;
    });
  }

  /// Whether [TerminalPanel] should hold the input connection: while the
  /// keyboard is up, and while one is on its way — see [_keyboardRequested].
  ///
  /// ⚠️ Holding reads [_keyboardIsUp], the one screen-wide fact, rather than
  /// anything this page remembers — see that flag for why swiping needs it.
  ///
  /// ⚠️ **Never while search is open, and that is not cosmetic.** The search
  /// field raises the keyboard itself, [_keyboardIsUp] goes true from its inset,
  /// and the panel underneath would read that as its own — `requestKeyboard()`
  /// takes the input connection back and every letter typed into the search box
  /// would be sent to the shell instead.
  bool get _shouldFocus =>
      widget.isActive && !_searching && (_keyboardIsUp || _keyboardRequested);

  /// A tap on the terminal while no keyboard is up or coming: the keyboard.
  /// Voice is the mic at the foot of the page, never this tap — see
  /// [TerminalFootBar].
  ///
  /// What was said and not sent is typed into the prompt on the way rather than
  /// dropped, so the keyboard picks up where the voice left off — to correct a
  /// word, or to finish the sentence. A take still being recorded is
  /// transcribed first: tapping the terminal mid-sentence is asking to fix that
  /// sentence, not to lose it.
  Future<void> _raiseKeyboard(TerminalSession session) async {
    // Typing is not scrolling: the chrome has no reason to be out of the way,
    // and the header holds the controls somebody reaches for next.
    _chrome.reveal();
    final heard = await widget.voice.takeTranscript();
    if (!mounted) return;
    if (heard.isNotEmpty && session.acceptsInput) {
      session.terminal.textInput(heard);
    }
    setState(() => _keyboardRequested = true);
  }

  /// Puts the keyboard away without leaving the page — the `⌄` key on
  /// [TerminalKeyBar]. Dropping focus is what closes the input connection.
  void _dismissInput() {
    FocusManager.instance.primaryFocus?.unfocus();
    if (_keyboardRequested) setState(() => _keyboardRequested = false);
  }

  /// Whether the keyboard on screen is THIS page's — the question the foot row
  /// asks, which [_keyboardUp] alone answers wrongly.
  ///
  /// ⚠️ [_keyboardUp] means "an inset exists", not "this page raised it". A
  /// pushed page with a text field — search, rename — raises one of its own,
  /// and this page is still mounted underneath, still gets `didChangeMetrics`,
  /// and so still records the keyboard as up. It then stops receiving ticks
  /// once it is no longer the route being laid out, so the fall back to zero
  /// after that page closes never reaches it: the flag stays true forever and
  /// the row it hides never comes back.
  ///
  /// [ModalRoute.isCurrent] is what separates the two. False while anything is
  /// stacked above, so an inset belonging to that page is not read as this
  /// one's — and true again the moment it pops, whatever the stale flag says.
  ///
  /// Not used for [_shouldFocus] or for the key bar: those are about the
  /// keyboard ITSELF, which is screen-wide, and a covered page must keep
  /// tracking it to know what to do when it is uncovered.
  bool get _ownsInput =>
      _keyboardUp && (ModalRoute.of(context)?.isCurrent ?? true);

  /// Guards against a second picker while one is already up.
  ///
  /// The key bar stays on screen under the sheet the OS puts over it, so its
  /// button remains tappable — and `pickImage` answers a second call on iOS by
  /// throwing rather than by queueing.
  bool _picking = false;

  /// Picks a picture and sends it to the agent, re-encoded on the way.
  ///
  /// ⚠️ **The transcode is not an optimisation, it is what makes the picture
  /// arrive at all** — see `transcodeToPng`. Everything past this point names
  /// PNG: the binary kind, the file the CLI writes, and the three OS clipboard
  /// writers it hands the bytes to. A phone produces JPEG and HEIC.
  Future<void> _sendImage(TerminalSession session, ImageSource source) async {
    if (_picking || !session.acceptsInput) return;
    _picking = true;
    final messenger = ScaffoldMessenger.maybeOf(context);
    void report(String message) {
      if (mounted) messenger?.showSnackBar(SnackBar(content: Text(message)));
    }

    try {
      final XFile? picked;
      try {
        picked = await ImagePicker().pickImage(source: source);
      } on PlatformException catch (error) {
        // A refused camera permission lands here rather than as a null, and it
        // is the one failure somebody can do something about.
        report(
          error.code == 'camera_access_denied'
              ? 'Allow camera access in Settings to send a photo.'
              : 'Could not open the picker.',
        );
        return;
      }
      // Null is a CANCEL, not a failure: the person backed out of the sheet, and
      // a snackbar saying so would be noise over a deliberate act.
      if (picked == null) return;

      final result = await transcodeToPng(await picked.readAsBytes());
      switch (result) {
        case ImageTranscodeUnreadable():
          report("That file isn't an image this phone can read.");
        case ImageTranscodeTooLarge():
          report('That image is too large to send, even scaled down.');
        case ImageTranscodeOk(:final pngBytes):
          // Re-checked AFTER the picker, which the person may have had open for
          // a while: the stream can have been taken over or dropped since, and
          // `pasteImage` on a dead stream goes nowhere silently.
          if (!session.acceptsInput) {
            report('The terminal is no longer accepting input.');
            return;
          }
          if (!await session.pasteImage(pngBytes)) {
            report('The image could not be sent.');
          }
      }
    } finally {
      _picking = false;
    }
  }

  /// The composer starts OPEN here, and the phone owns that answer rather than the pane.
  ///
  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      // Not the voice controller: what the mic hears repaints the foot row,
      // which listens for itself, and never rebuilds the terminal above it.
      listenable: widget.notifier,
      builder: (context, _) {
        AppTheme.watch(context);
        final pane = widget.notifier.panes
            .where(
              (p) =>
                  p.machineId == widget.machineId &&
                  p.agentId == widget.agentId,
            )
            .firstOrNull;
        if (pane != null) {
          _hadPane = true;
        } else if (_hadPane && widget.isActive) {
          // The pane this page was showing is gone — another tab opened a different agent, or the
          // agent was deleted. Leave rather than spin: there is nothing here to come back.
          //
          // ⚠️ Only the ACTIVE page may leave, and only it ever should. A page parked beside the one
          // being read shares the route, so popping from there would take the whole pager down —
          // including the terminal actually on screen. A parked page whose pane went away simply
          // waits: swiping to it is what makes it attach again.
          _leave();
        }
        final session = pane?.session;
        final machine = widget.notifier.stateOf(widget.machineId);
        final agent = machine?.agents
            .where((a) => a.id == widget.agentId)
            .firstOrNull;
        // ⚠️ **The agent this page opened on is not in the machine's own list.**
        // Only ever true of a page opened from the cache (see [_AgentGone]): the
        // list is the machine's — `agentsFromCache` is false, so a real
        // `agents_list` has landed — it has been LOADED rather than merely
        // attempted, and the agent it named is not in it.
        //
        // Every one of those conditions matters. Without `loaded` this would
        // fire during the window the cache exists to cover; without
        // `!agentsFromCache` it would fire against the cached list itself, which
        // is where the agent came from; and a machine that errored or went
        // offline has not disowned anything — it simply has not answered, and
        // its pane keeps the terminal's own reconnect behaviour.
        //
        // Note this deliberately ignores `_hadPane`/`_leave` above: that path
        // handles a pane REMOVED while the page was live. This one is about a
        // page that should never have been built, answered before its pane
        // could be.
        final agentGone =
            agent == null &&
            machine != null &&
            !machine.agentsFromCache &&
            machine.agentLoadStatus == AgentLoadStatus.loaded;
        // Captured while the agent is still listed, for the sentence above.
        if (agent != null) _cachedAgentName = agent.name;
        final reclaim = phoneReclaimAction(session);
        // The header's trailing controls, counted before they are built: the
        // slot they share with Cancel is sized from this, and the search field
        // is laid out against that same width. The conditions must match the
        // ones guarding each control below — see [_TrailingSwap.extentFor].
        //
        // ⚠️ [reclaim] is counted too, though it is a labelled button rather
        // than one of the fixed 24px icon boxes. It cannot be measured from a
        // constant — its width is its label's — so the slot treats it as a
        // MINIMUM rather than a fixed size: see [_TrailingSwap], which floors
        // the width it is given instead of forcing it. Sizing it exactly is not
        // worth a second TextPainter for a button that shows only on a
        // read-only stream.
        final headerActions =
            (machine != null &&
                    phoneMachineStatusOf(machine) == PhoneMachineStatus.ready
                ? 1
                : 0) +
            (agent != null ? 1 : 0) +
            (reclaim != null ? 1 : 0);
        final trailingExtent = _TrailingSwap.extentFor(context, headerActions);
        return Scaffold(
          backgroundColor: AppPalette.windowBg,
          // ⚠️ No fab. New agent is the `+` in the header — see the note there.
          // A Scaffold fab floats over the body, and the body here is the
          // terminal: it covered the newest line of output, which on a page
          // that streams is the line being read.
          // ⚠️ Plain `SafeArea`. A `bottom: !keyboardUp` toggle was here,
          // computed from `MediaQuery.viewInsetsOf(context).bottom > 0` — and
          // that value is pinned at ZERO inside this page (see
          // [didChangeMetrics]). The toggle therefore never toggled.
          body: SafeArea(
            child: Stack(
              children: [
                // ⚠️ The terminal is FADED, never unbuilt, while search is
                // open. Taking it down would detach the pane and drop the
                // scrollback; cancelling has to hand back the same screen that
                // was there, mid-stream.
                //
                // ⚠️ **The header is NOT inside the fade, on purpose.** The
                // overlay's bar sits exactly on top of this one and has to read
                // as the same object growing — fading this one out underneath
                // it made the row flicker on every open, which is the opposite
                // of what the expansion is for.
                Column(
                  children: [
                    Expanded(
                      // ⚠️ The mic floats INSIDE this box, over the terminal
                      // — not over the whole page. Stacked any higher it
                      // would hang over the key bar while the keyboard is
                      // up, which is the one row the thumb is working.
                      child: Stack(
                        children: [
                          Positioned.fill(
                            // ⚠️ The chrome is driven from OUT HERE, not
                            // from inside the panel. xterm's own
                            // [Scrollable] is several widgets down and is
                            // remounted whenever the agent changes;
                            // listening for its notifications as they
                            // bubble past is what survives that, and costs
                            // the panel no knowledge of the page's chrome.
                            child: NotificationListener<ScrollNotification>(
                              onNotification: _chrome.onNotification,
                              child: agentGone
                                  ? _AgentGone(
                                      name: _cachedAgentName,
                                      onPickAnother: _pickAnotherAgent,
                                    )
                                  : pane == null || session == null
                                  ? const _Attaching()
                                  : TerminalPanel(
                                      key: ValueKey(pane.id),
                                      notifier: widget.notifier,
                                      session: session,
                                      // Only the page on screen takes the keyboard — see
                                      // [TerminalPage.isActive]. `visible` is the same answer for the
                                      // panel's other half: a page parked beside this one releases
                                      // focus, stops rendering and stops resizing its remote shell.
                                      //
                                      // Whether it also HOLDS one that is already
                                      // up is a separate question, and the pager asks
                                      // it on every swipe — see [_shouldFocus].
                                      focused: _shouldFocus,
                                      visible: widget.isActive,
                                      // Hold the remote resize while the keyboard
                                      // slides. Separate from `visible` because this
                                      // must NOT release focus — the animation being
                                      // waited on is the one that focus started.
                                      //
                                      // The keyboard is the only thing left that
                                      // moves this pane's height: the header slides
                                      // OVER the terminal rather than out of its
                                      // column — see [_SlideAway].
                                      //
                                      // ⚠️ Held for as long as search is open, too:
                                      // its keyboard is typing a query over a faded
                                      // terminal, and resizing the agent's shell for
                                      // it redrew the whole TUI on the way in and
                                      // again on the way out.
                                      settling: _keyboardSettling || _searching,
                                      // ⚠️ The tap is taken in the panel, not by a
                                      // `Listener` over it. xterm's own `_onTapDown`
                                      // calls `requestKeyboard()`, so anything that
                                      // merely ALSO reacted to the tap would raise
                                      // the keyboard before the words said were typed
                                      // into the prompt — and a re-armed claim on top
                                      // of it was measured asking Android twice per
                                      // tap, which answers a show mid-animation by
                                      // cancelling and restarting it. Null while the
                                      // keyboard is up or coming, so the tap is
                                      // xterm's and the keyboard stays.
                                      onInputTap: _shouldFocus
                                          ? null
                                          : () => unawaited(
                                              _raiseKeyboard(session),
                                            ),
                                      showHeader: false,
                                      // No composer, and so no grip above it: the
                                      // page hands the pane its full height and the
                                      // software keyboard drives the terminal
                                      // directly. The mic's send is what kept the
                                      // composer's batched turn.
                                    ),
                            ),
                          ),
                          // ⚠️ **The skeleton is laid OVER the live panel, not
                          // swapped in for it, and that is not a stylistic
                          // choice.** [TerminalPanel.initState] calls
                          // `session.attachViewport`, which is how the machine
                          // learns how many rows and columns to draw; a page
                          // that showed a skeleton INSTEAD would leave the
                          // session with no viewport, and the first keyframe
                          // would arrive sized for nothing.
                          //
                          // So the panel mounts, measures and resizes as always,
                          // and this covers the empty emulator buffer it paints
                          // meanwhile. `session == null` upstream keeps its own
                          // branch for the frames before a session exists at all.
                          //
                          // ⚠️ **This is also the bug that made the skeleton
                          // invisible.** The only gate used to be `session ==
                          // null`, and `selectAgent` creates the pane and the
                          // session in one frame — so the branch above was
                          // essentially never taken, and what a person actually
                          // waited in front of was a mounted terminal with an
                          // empty buffer: a black rectangle, for as long as the
                          // keyframe took.
                          if (session != null && !session.hasRenderedFrame)
                            const Positioned.fill(child: _Attaching()),
                          // The mic — the one voice control the page has,
                          // floating over the terminal's bottom right corner
                          // rather than sitting in a row of its own.
                          //
                          // ⚠️ Hidden while this page owns the keyboard, the
                          // same gate the foot row takes. Typing is the other
                          // way of saying the same thing, the key bar is
                          // already under the thumb, and a button floating
                          // over it would be in the way of both.
                          if (session != null && !_ownsInput)
                            Positioned(
                              right: VoiceMicFab.inset,
                              bottom: VoiceMicFab.inset,
                              child: VoiceMicFab(
                                voice: widget.voice,
                                session: session,
                                onSlipChanged: (off) {
                                  if (!mounted || off == _micSlippedOff) {
                                    return;
                                  }
                                  setState(() => _micSlippedOff = off);
                                },
                              ),
                            ),
                        ],
                      ),
                    ),
                    // The bottom of this page IS just above the keyboard:
                    // `PhoneShell`'s Scaffold has already resized for it —
                    // the same resize that empties this page's MediaQuery
                    // insets (see [didChangeMetrics]).
                    if (session != null)
                      TerminalInputDock(
                        session: session,
                        keyboardUp: _keyboardUp || _keyboardRequested,
                        onDismiss: _dismissInput,
                        // Only where the far side can actually take one: an
                        // older CLI never advertises the binary kind, so the
                        // upload would go nowhere silently. Null leaves the
                        // buttons undrawn rather than drawn dead.
                        onPickImage:
                            machine?.terminalImagePasteAvailable == true
                            ? () => unawaited(
                                _sendImage(session, ImageSource.gallery),
                              )
                            : null,
                        onTakePhoto:
                            machine?.terminalImagePasteAvailable == true
                            ? () => unawaited(
                                _sendImage(session, ImageSource.camera),
                              )
                            : null,
                      ),
                    // Who this terminal belongs to, and what the mic is doing
                    // while it is doing it — the words the floating button
                    // has nowhere to put.
                    //
                    // ⚠️ Below the key bar, not above it. The bar is what the
                    // thumb works, and a line that moves every time it
                    // appears would shift the keys under it. Here it is the
                    // last row on the page and nothing it does moves
                    // anything above it.
                    //
                    // ⚠️ Hidden while this page owns the keyboard. The key
                    // bar is already tall, and a line wedged under it is a
                    // row of chrome the terminal loses for nothing — who the
                    // agent is is not what is being read mid-typing.
                    //
                    // ⚠️ **It does not move with scrolling, and an earlier
                    // version that did was wrong.** This row is one line
                    // of identity and the mic's running commentary — it
                    // costs the terminal 20 points, and hiding it whenever
                    // the content moved meant the words the mic needs read
                    // went away exactly while somebody was looking for
                    // them.
                    if (!_ownsInput)
                      TerminalFootBar(
                        name: machine?.machine.displayName ?? '',
                        voice: widget.voice,
                        agent: agent,
                        status: phoneSessionSummary(session),
                        slippedOff: _micSlippedOff,
                      ),
                  ],
                ),
                // The header, laid OVER the terminal rather than above it in the
                // column.
                //
                // ⚠️ **Over, not beside, and that is what keeps scrolling smooth.**
                // It used to shrink out of the column and hand its height to the
                // terminal. Every fold then changed the terminal's row count: a
                // `terminal_resize` and a real SIGWINCH on the far machine, a
                // keyframe back carrying up to 500 lines of history to re-parse on
                // this thread, and the agent's whole screen redrawn — once as the
                // header left, once as it came back, on every change of scroll
                // direction. The renderer was held frozen for each slide on top of
                // that, so a fling stopped dead for a third of a second.
                //
                // Laid over, the terminal keeps one height whatever the header
                // does. The rows under it are the oldest on the screen, and the
                // first push of a scroll is what slides it away from them.
                //
                // What stands in for it while it is gone is [TerminalHeaderFloats]
                // — the same controls, as floating buttons down the right edge,
                // each one flown out of the place it held in this row.
                Positioned(
                  top: 0,
                  left: 0,
                  right: 0,
                  child: _SlideAway(
                    progress: _chrome.header,
                    // Opaque: the terminal is underneath now, and the row has to
                    // read as the same bar it was when the two were stacked.
                    child: ColoredBox(
                      color: AppPalette.windowBg,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          TerminalHeader(
                            // ⚠️ Grows in place — no route is pushed. [openPhoneSearch]
                            // is still what the LIST screens use, and this page used it
                            // too until the bar arrived: pushing slid a fresh screen in
                            // from the right, so the bar the finger had just touched left
                            // the frame while an identical one came in from off-screen.
                            // See `terminal_search.dart`.
                            onSearch: _openSearch,
                            // ⚠️ Tracks [_searching], NOT the animation's value:
                            // the overlay's own bar exists for exactly as long as
                            // the overlay is mounted, including the closing frames
                            // where the animation is already near zero. Reading the
                            // value here would paint this row's field back under
                            // the overlay's for the tail of every collapse.
                            barHidden: _searching,
                            // ⚠️ No title and no engine mark up here any more: the search
                            // bar takes the row, and the agent's name moved to
                            // [TerminalFootBar] at the foot of the page, where it reads
                            // as identity rather than as chrome.
                            //
                            // ⚠️ **Wrapped so the pair can hand over to Cancel.** They act
                            // on the agent underneath, which is not what is on screen once
                            // search is up — so they cross-fade for the way out, in a slot
                            // that keeps one width throughout. See [_TrailingSwap]: the
                            // field beside it must not move, which is what the earlier
                            // collapse-and-reopen got wrong.
                            trailing: [
                              _TrailingSwap(
                                progress: _searchCurve,
                                cancel: _CancelSearchButton(
                                  onTap: _closeSearch,
                                ),
                                extent: trailingExtent,
                                children: [
                                  // Read-only is a state to get OUT of, so its way out is a
                                  // labelled button in the header rather than a line in the
                                  // actions sheet: the sheet is where you go having decided
                                  // to do something, and this is the thing telling you that
                                  // typing will go nowhere until you do.
                                  if (reclaim != null)
                                    _ReclaimButton(
                                      action: reclaim,
                                      onPressed: () =>
                                          widget.notifier.selectAgent(
                                            widget.machineId,
                                            widget.agentId,
                                          ),
                                    ),
                                  // New agent, search and the actions menu: the three the
                                  // page offers, in the order they are reached for — create,
                                  // find, then everything else.
                                  //
                                  // ⚠️ They are spaced by [_HeaderAction], not drawn bare.
                                  // [AppIconButton] is a fixed 24px box whatever glyph size
                                  // it is given, so a 22px search glyph fills its box edge to
                                  // edge while a 20px ellipsis sits inside one — three
                                  // buttons butted together then read as unevenly spaced
                                  // when the gaps are in fact identical. One glyph size and
                                  // one padding across the three is what evens the rhythm.
                                  //
                                  // ⚠️ `+` here rather than floating over the terminal. A fab
                                  // covers the last line of output — the line being read —
                                  // and this page has no list to scroll it clear of.
                                  //
                                  // Gated on the machine ANSWERING, the same gate the Agents
                                  // tab puts on its fab: creating needs the machine to list
                                  // its folders and name its engines, so one that is offline
                                  // or still wants its password cannot host a new agent.
                                  if (machine != null &&
                                      phoneMachineStatusOf(machine) ==
                                          PhoneMachineStatus.ready)
                                    _HeaderAction(
                                      icon: LucideIcons.plus300,
                                      size: 21,
                                      tooltip: 'New agent',
                                      // Awaited for the same reason search is: the form may
                                      // be backed out of rather than completed, and this page
                                      // gets no rebuild when it lands back on top.
                                      onPressed: () async {
                                        await openNewAgent(
                                          context,
                                          widget.notifier,
                                          widget.machineId,
                                        );
                                        if (mounted) setState(() {});
                                      },
                                    ),
                                  // ⚠️ Both stay put while the keyboard is up. They were once
                                  // hidden while typing to spare the row — but the row was
                                  // never what was short, and the controls jumping position
                                  // on every keyboard raise cost more than the two columns
                                  // bought back. A header that holds still is worth more.
                                  //
                                  // Null while the agent is not loaded: there is nothing to act on yet, and a
                                  // menu of actions that all fail is worse than no menu.
                                  if (agent != null)
                                    _HeaderAction(
                                      icon: LucideIcons.ellipsis300,
                                      size: 21,
                                      tooltip: 'Agent actions',
                                      // Last in the row, so its padding stops at the header's
                                      // own right inset rather than adding to it.
                                      last: true,
                                      onPressed: () => _showActions(
                                        machineName:
                                            machine?.machine.displayName ?? '',
                                        agentName: agent.name,
                                      ),
                                    ),
                                ],
                              ),
                            ],
                          ),
                          Divider(height: 1, color: AppGlass.hair),
                        ],
                      ),
                    ),
                  ),
                ),
                // The header's controls, floating down the right edge once
                // the row itself has scrolled away.
                //
                // ⚠️ **Built on the animation, not on a flag the page keeps.**
                // These have to be somewhere on every frame of the slide — they
                // fly out of the header as it goes — so their position is read
                // per frame. A boolean flipped in a callback would put them
                // there in one jump, which is the thing this replaced.
                AnimatedBuilder(
                  animation: _chrome.header,
                  builder: (context, _) {
                    if (_chrome.header.value == 0) {
                      return const SizedBox.shrink();
                    }
                    final choices = _headerChoices(machine, agent);
                    if (choices.isEmpty) return const SizedBox.shrink();
                    return Positioned(
                      top: TerminalHeaderFloats.inset,
                      right: TerminalHeaderFloats.inset,
                      child: TerminalHeaderFloats(
                        choices: choices,
                        progress: _chrome.header,
                        origins: _headerOrigins(choices.length),
                      ),
                    );
                  },
                ),
                // Search, grown out of the header bar. Only built while it is
                // on its way in, up, or on its way out — see [_searching].
                //
                // ⚠️ **No fade and no scale on the whole overlay.** It carries
                // its own move — the bar widening, the list rising into it —
                // and dipping the opacity of the lot on top of that only made
                // the terminal show through the gaps. It is opaque from its
                // first frame.
                if (_searching)
                  Positioned.fill(
                    child: TerminalSearchOverlay(
                      notifier: widget.notifier,
                      animation: _searchCurve,
                      onClose: _closeSearch,
                      // What the header's trailing slot holds — the field stops
                      // there rather than reaching under Cancel. The same number
                      // the header lays that slot out from, so the two agree.
                      trailingExtent: trailingExtent,
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  /// Pops after the frame: this runs from inside a build, where popping a route synchronously is
  /// not allowed.
  ///
  /// ⚠️ **Removes THIS page's route, which is not the same as popping.** `pop` takes whatever is on
  /// top, and this page is often not on top when its pane goes: the terminal's own `+` opens the
  /// new-agent form over it, and the agent that form creates is opened as the single pane — closing
  /// this one. Popping from here then took down the NEW agent's terminal, the page underneath
  /// surfaced, found its pane gone too and popped again, and the person landed on the list instead
  /// of in the agent they had just made.
  ///
  /// ⚠️ **Does nothing at all on the home screen, and that is correct rather than a gap.** The
  /// terminal is the root of its stack there ([AgentHome]), so `canPop` is false and the guard below
  /// returns — but the reason this is called is that the agent went away, and [AgentHome] watches
  /// the same agent list: the agent leaves it, the home screen's target stops matching, and it
  /// rebuilds onto another agent or onto its empty state. Leaving the route was never what fixed
  /// this case; it only uncovered the list that did.
  /// Leave the agent that is no longer there, and let the home screen choose.
  ///
  /// It pops rather than picking a replacement itself: `AgentHome` already
  /// decides what to open — the remembered agent, then the first openable one —
  /// and it re-runs that the moment this page is out of the way. Choosing here
  /// would be a second, competing copy of that rule.
  ///
  /// The stale record is not cleared: it names an agent no list contains, so it
  /// matches nothing and the home screen falls through to the first agent it can
  /// reach. Whatever it opens overwrites the record itself.
  void _pickAnotherAgent() => _leave();

  void _leave() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final navigator = Navigator.of(context);
      final route = ModalRoute.of(context);
      if (route == null || !navigator.canPop()) return;
      if (route.isCurrent) {
        navigator.pop();
      } else if (route.isActive) {
        // Underneath something: leave the stack quietly, so back from the page on top goes to
        // whatever was below this one.
        navigator.removeRoute(route);
      }
    });
  }

  void _showActions({required String machineName, required String agentName}) {
    showPhoneSheet(
      context,
      title: '$agentName · $machineName',
      // Two lines — the agent, then its machine — shown in full.
      titleParts: [agentName, machineName],
      // Two groups: what acts on THIS agent, and the two screens the app itself has. Machines is a
      // door like Settings rather than a list of its own — the list belongs on the page behind it,
      // where it has room for every machine and does not push the rest of this sheet down.
      sections: [
        PhoneSheetSection(
          caption: 'Agent',
          actions: [..._agentActions(agentName)],
        ),
        PhoneSheetSection(
          caption: 'App',
          actions: [
            PhoneSheetAction(
              icon: LucideIcons.laptopMinimal300,
              label: 'Machines',
              onTap: () => Navigator.of(context).push(
                phoneRoute(
                  (_) => MachinesTab(notifier: widget.notifier, large: false),
                ),
              ),
            ),
            PhoneSheetAction(
              icon: LucideIcons.settings300,
              label: 'Settings',
              onTap: () => Navigator.of(context).push(
                phoneRoute(
                  (_) => SettingsPage(notifier: widget.notifier, large: false),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }

  List<PhoneSheetAction> _agentActions(String agentName) => [
    PhoneSheetAction(
      icon: LucideIcons.pencil300,
      label: 'Rename agent…',
      onTap: () => showAgentRenameDialog(
        context,
        widget.notifier,
        widget.machineId,
        widget.agentId,
        agentName,
      ),
    ),
    PhoneSheetAction(
      icon: LucideIcons.refreshCw300,
      label: 'Restart agent',
      onTap: () => unawaited(_restart()),
    ),
    // Last, and alone in red: the two above are recoverable and this one is
    // not, so it does not sit where a thumb lands on the way to them.
    //
    // ⚠️ Nothing here pops this page. Deleting detaches the pane, and the
    // `_hadPane` branch above leaves on its own when that happens — the same
    // path a delete from the list, or from the desktop, already takes. A pop
    // here would be a second one, and the parked pages in this pager share
    // the route.
    PhoneSheetAction(
      icon: LucideIcons.trash2300,
      label: 'Delete agent…',
      destructive: true,
      onTap: () => unawaited(
        confirmDeleteAgent(
          context,
          widget.notifier,
          widget.machineId,
          widget.agentId,
          agentName,
        ),
      ),
    ),
  ];

  /// Restarting is a round trip that can fail, and the phone has no status rail to fail into — so
  /// the answer lands as a snackbar, which is the one surface a pushed page here always has.
  Future<void> _restart() async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    final result = await widget.notifier.restartAgent(
      widget.machineId,
      widget.agentId,
    );
    final error = result.error;
    if (error == null || messenger == null || !mounted) return;
    messenger.showSnackBar(SnackBar(content: Text(error)));
  }
}

/// The header's way back into a session this device is not driving.
///
/// Re-selecting the agent is what reclaims it — the same call the desktop tile's
/// status chip makes, so one gesture means one thing on both.
class _ReclaimButton extends StatelessWidget {
  const _ReclaimButton({required this.action, required this.onPressed});

  final PhoneSummary action;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final color = phoneToneColor(action.tone);
    return TextButton.icon(
      onPressed: onPressed,
      icon: Icon(
        action.tone == PhoneTone.attention
            ? LucideIcons.lock300
            : LucideIcons.refreshCw300,
        size: 15,
      ),
      label: Text(
        action.label,
        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
      ),
      style: TextButton.styleFrom(
        foregroundColor: color,
        minimumSize: Size.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      ),
    );
  }
}

/// What the terminal shows when the agent it opened on is not there any more.
///
/// ⚠️ **This is the cost of opening from the cache, and the whole of it.** The
/// phone draws its terminal from last run's agent list so the screen is usable
/// in half a second (`MachineCache`), and the machine's real list lands a moment
/// later. Almost always they agree. When they do not — the agent was deleted
/// from another device since this phone last looked — the terminal is already on
/// screen with a name on it, and this is what replaces its body.
///
/// Worded as a fact about the agent, not as a failure of the app: nothing went
/// wrong here, something simply changed elsewhere. The button is the way out,
/// because a dead end on the phone's home screen leaves nothing to tap at all.
class _AgentGone extends StatelessWidget {
  const _AgentGone({required this.name, required this.onPickAnother});

  /// The agent as the cache knew it, so the sentence names what is missing
  /// rather than gesturing at "the agent".
  final String? name;

  final VoidCallback onPickAnother;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // The 300 weight every other glyph on this page uses.
          Icon(LucideIcons.wind300, size: 26, color: AppPalette.textSecondary),
          const SizedBox(height: 14),
          Text(
            name == null || name!.isEmpty
                ? 'That agent is gone'
                : '$name is gone',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: AppPalette.textPrimary,
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'It was closed on another device since you were last here.',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: AppPalette.textSecondary,
              fontSize: 13,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 18),
          TextButton(
            onPressed: onPickAnother,
            style: TextButton.styleFrom(
              foregroundColor: AppPalette.accent,
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
            ),
            child: const Text('Open another agent'),
          ),
        ],
      ),
    ),
  );
}

/// The terminal's body while its first keyframe is still crossing the network.
///
/// ⚠️ **A skeleton here, not a spinner, because the shape IS known** — that is
/// the rule `shared/widgets/skeleton.dart` opens with. What arrives is a page of
/// monospace lines, and drawing lines of the terminal's own type at the
/// terminal's own leading means the keyframe lands INTO the layout already on
/// screen rather than replacing a centred spinner with a wall of text. The
/// screen stops flashing between two unrelated pictures.
///
/// The content itself cannot be cached: a terminal is a live screen a remote
/// program is drawing, and the only authoritative copy is the keyframe the
/// machine sends on attach (`terminal_keyframe`). Everything AROUND it is
/// already on screen by now from the agent cache — the name, the project, the
/// header — so this is the one part of the launch that still has to wait, and
/// the skeleton is what makes that wait look like the thing being waited for.
///
/// Metrics come from `terminalFontStore`, which is loaded before the first frame
/// (`core/startup.dart`), so these rows are the height the real ones will be.
///
/// ⚠️ **It draws the transcript's STRUCTURE, not a stack of grey bars.** The
/// first version was a column of plain lines and read as a loading page for some
/// other app — nothing about it suggested a terminal. What actually arrives has
/// a strong, repeating shape: a prompt banner on its own lighter ground, a
/// bulleted answer indented under it, a dim meta line closing the turn. Standing
/// in for THAT is what makes the wait read as "your session is coming back"
/// rather than "something is loading", and it is the same rule
/// `PhoneListSkeleton` follows for a list of cards — the same cards, empty, at a
/// real row's height.
class _Attaching extends StatefulWidget {
  const _Attaching();

  @override
  State<_Attaching> createState() => _AttachingState();
}

class _AttachingState extends State<_Attaching>
    with SingleTickerProviderStateMixin {
  /// How long the block takes to arrive, top edge to bottom.
  ///
  /// ⚠️ **Matched to the wait it covers, not chosen for its own sake.** Measured
  /// on this app against a real machine, the gap between the agent list landing
  /// and the terminal's first keyframe — which is exactly the stretch this
  /// skeleton is on screen — runs about 2.5 to 3 seconds. At the 620ms this
  /// started on, the sweep finished in the first fifth of that and then sat
  /// perfectly still, which reads as a page that has given up rather than one
  /// that is filling.
  ///
  /// So the sweep is paced to arrive at the bottom edge at roughly the moment
  /// the real screen does. Finishing EARLY is the one direction that is fine and
  /// is what a fast attach produces: the skeleton is simply replaced, complete,
  /// by the terminal. Finishing late is the case the curve below handles.
  static const _revealDuration = Duration(milliseconds: 2600);

  /// How much of the pane the timed sweep covers before it hands over.
  ///
  /// ⚠️ **The sweep deliberately does not finish on its own.** A reveal that
  /// completes and then holds still is the failure mode this pacing was changed
  /// to fix; running to 100% just moves that stall from five seconds in to two
  /// and a half. Stopping a little short instead means the last band of the
  /// screen is still arriving whenever the keyframe lands, so the skeleton is
  /// always replaced mid-motion — which reads as the real screen overtaking it
  /// rather than as a placeholder that gave up waiting.
  ///
  /// The remainder is never shown filling: the terminal takes the pane. On an
  /// attach slower than [_revealDuration] the bottom band simply stays dim, and
  /// the pulse underneath keeps the block alive.
  ///
  /// 0.84 leaves roughly the last 9% of the pane below the soft edge — about one
  /// turn on a phone. Worked out against [_feather] rather than guessed: the
  /// edge travels `t * (1 + 2f) - f`, so it reaches the bottom at `t = 1`, and
  /// values much above this finish the sweep after all.
  static const _sweepExtent = 0.84;

  late final AnimationController _reveal = AnimationController(
    vsync: this,
    duration: _revealDuration,
    upperBound: _sweepExtent,
  )..forward();

  @override
  void dispose() {
    _reveal.dispose();
    super.dispose();
  }

  /// The shapes turns are cut from, cycled to fill whatever height the pane has.
  ///
  /// ⚠️ **A fixed list of turns cannot fill a screen.** Four of them left the
  /// top half of a tall phone empty, which reads as a page that finished loading
  /// with almost nothing on it — the opposite of what a skeleton is for. The
  /// build measures the pane and takes as many of these as it needs, so the
  /// block reaches the top edge on any device at any terminal font size.
  ///
  /// Five, and a prime count, so cycling does not line the same shape up under
  /// itself every other turn: with four the eye picks out the repeat immediately.
  static const _shapes = <_SkeletonTurn>[
    _SkeletonTurn(prompt: 0.44, answer: [0.89, 0.57], meta: 0.42),
    _SkeletonTurn(prompt: 0.52, answer: [0.94, 0.88, 0.41], meta: 0.46),
    _SkeletonTurn(prompt: 0.38, answer: [0.91, 0.62], meta: 0.44),
    _SkeletonTurn(prompt: 0.57, answer: [0.83, 0.96, 0.49], meta: 0.39),
    _SkeletonTurn(prompt: 0.61, answer: [0.86, 0.93, 0.77, 0.35], meta: null),
  ];

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final style = terminalFontStore.value;
    final fontSize = style.fontSize;
    // The terminal's own line box, so a row here and a row of output occupy the
    // same band. `height` is xterm's line-height multiplier.
    final lineHeight = fontSize * style.height;
    // Resolved exactly as [TerminalPanel] resolves it for the view underneath,
    // so the skeleton's ground and the terminal's are the same colour.
    final ground = terminalThemeFor(
      AppTheme.palette.value,
      terminalThemeStore.value,
    ).background;
    // ⚠️ **Mixed against the terminal's OWN ground, not taken from
    // `AppSurface.recess`.** That token is a translucent well meant to sit on a
    // card — around 6% white — and over this app's near-black terminal
    // (`#181818`) it renders at about `#262626`: a difference of sixteen values,
    // which is invisible on a phone screen in daylight and is why the first
    // version of this skeleton could not be seen at all.
    //
    // These are opaque blends instead, so the contrast is a property of the bars
    // rather than of whatever happens to be behind them, and the terminal's
    // background is read from the user's chosen scheme so a light terminal theme
    // gets bars that are darker than its ground rather than lighter.
    final light = ThemeData.estimateBrightnessForColor(ground) ==
        Brightness.light;
    final rest = Color.alphaBlend(
      (light ? Colors.black : Colors.white).withValues(alpha: 0.10),
      ground,
    );
    final peak = Color.alphaBlend(
      (light ? Colors.black : Colors.white).withValues(alpha: 0.17),
      ground,
    );
    return SkeletonBlock(
      semanticsLabel: 'Attaching to the agent',
      child: _RevealDown(
        listenable: _reveal,
        child: ColoredBox(
        // Opaque, because this covers a live [TerminalPanel] — see the note at
        // the call site. Without it the empty emulator buffer shows between the
        // bars and the two grounds differ by a hair, which reads as a smudge.
        color: ground,
        child: Padding(
          // ⚠️ The terminal view's OWN padding (`TerminalPanel` passes
          // `EdgeInsets.all(10)` to the xterm view), so a bar starts on the
          // column the first character will occupy. A different gutter here
          // would shift every line sideways the moment the keyframe lands.
          padding: const EdgeInsets.all(10),
          child: Pulse(
            // The breath `shared/widgets/skeleton.dart` sets for a placeholder;
            // one controller for the whole block rather than one per bar, so
            // the rows pulse together instead of shimmering independently.
            duration: const Duration(milliseconds: 1100),
            builder: (context, t, _) {
              final fill = Color.lerp(rest, peak, t)!;
              // The prompt's banner sits on its own ground, a step above the
              // terminal's — the band an agent paints behind the line it is
              // answering, and the one element that makes this block read as a
              // transcript rather than as a list of lines.
              //
              // 0.08, not the 0.05 this started at: the banner has to be legible
              // as a BAND at arm's length on a phone, and at 0.05 over `#181818`
              // it was a shade nobody would notice. Still well under the bars
              // themselves (0.10–0.17), so it reads as the ground behind them
              // rather than as another bar.
              final banner = Color.lerp(
                ground,
                light ? Colors.black : Colors.white,
                0.08,
              )!;
              final bar = (fontSize * 0.62).clamp(5.0, 12.0).toDouble();
              return LayoutBuilder(
                builder: (context, constraints) {
                  // ⚠️ **As many turns as the pane is tall, not a fixed four.**
                  // A fixed list left the top half of a tall phone empty, which
                  // reads as a page that has finished loading and has almost
                  // nothing on it. One extra turn is added beyond the measured
                  // fit so the topmost one is genuinely cut by the edge rather
                  // than ending a few pixels short of it.
                  final height = constraints.maxHeight;
                  final perTurn = _turnHeight(
                    _shapes[0],
                    lineHeight: lineHeight,
                  );
                  final count = height.isFinite && perTurn > 0
                      ? (height / perTurn).ceil() + 1
                      : _shapes.length;
                  final turns = [
                    for (var i = 0; i < count; i++)
                      // Cycled from the back, so the LAST shape is always the
                      // one at the bottom edge: it is the only one written
                      // without a closing meta line, which is what an in-progress
                      // turn looks like.
                      _shapes[(_shapes.length - 1 - i % _shapes.length)],
                  ].reversed.toList();
                  final blocks = <Widget>[
                    for (var i = 0; i < turns.length; i++)
                      Opacity(
                        // Oldest at 0.4, newest at full: the block nearest the
                        // top edge is the one about to be clipped by it, so it
                        // fades INTO that edge rather than ending against it.
                        opacity: turns.length == 1
                            ? 1
                            : 0.4 + (i / (turns.length - 1)) * 0.6,
                        child: _turn(
                          turns[i],
                          lineHeight: lineHeight,
                          bar: bar,
                          fill: fill,
                          banner: banner,
                          // The newest turn ends at the bottom edge, as the live
                          // screen's does; only the ones above it are separated.
                          last: i == turns.length - 1,
                        ),
                      ),
                  ];
                  // ⚠️ Aligned to the BOTTOM and clipped at the top, which is how
                  // a terminal itself sits: the newest output is at the bottom
                  // edge and history runs off the top. `OverflowBox` lets the
                  // column exceed the pane — the extra turn above guarantees it
                  // does — and `ClipRect` cuts what runs past, instead of Flutter
                  // painting an overflow stripe over the whole thing.
                  return ClipRect(
                    child: OverflowBox(
                      alignment: Alignment.bottomLeft,
                      minHeight: 0,
                      maxHeight: double.infinity,
                      // ⚠️ The pane's own width is pinned back on, because
                      // `OverflowBox` relaxes BOTH axes and the rows inside are
                      // `FractionallySizedBox` — against an unbounded width they
                      // would have no fraction to take and the layout would throw.
                      minWidth: constraints.maxWidth,
                      maxWidth: constraints.maxWidth,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        mainAxisSize: MainAxisSize.min,
                        children: blocks,
                      ),
                    ),
                  );
                },
              );
            },
          ),
        ),
        ),
      ),
    );
  }

  /// One turn: the prompt banner, the bulleted answer under it, the meta line.
  ///
  /// Every row is exactly one terminal line box tall, so the whole block
  /// occupies a whole number of rows and the keyframe replaces it without the
  /// page growing or shrinking by a fraction of a line.
  /// What one turn occupies, so the build can work out how many fit.
  ///
  /// ⚠️ **Must stay in step with [_turn] below**, which is why the terms are
  /// written in the same order as the widgets they measure: banner, gap, answer
  /// lines, gap and meta line, trailing gap. A drift here does not break the
  /// layout — the column is clipped either way — it just means a turn too few
  /// (a band of empty ground at the top) or one too many (wasted build).
  static double _turnHeight(
    _SkeletonTurn turn, {
    required double lineHeight,
  }) =>
      lineHeight + // the prompt banner
      lineHeight * 0.35 + // the gap under it
      lineHeight * turn.answer.length +
      (turn.meta == null ? 0 : lineHeight * 0.35 + lineHeight) +
      lineHeight * 0.9; // the gap to the next turn

  static Widget _turn(
    _SkeletonTurn turn, {
    required double lineHeight,
    required double bar,
    required Color fill,
    required Color banner,
    bool last = false,
  }) {
    Widget line(double factor, {double indent = 0, double? height}) => SizedBox(
      height: lineHeight,
      child: Align(
        alignment: Alignment.centerLeft,
        child: Padding(
          padding: EdgeInsets.only(left: indent),
          child: FractionallySizedBox(
            alignment: Alignment.centerLeft,
            widthFactor: factor,
            child: Container(
              height: height ?? bar,
              decoration: BoxDecoration(
                color: fill,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
        ),
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        // The prompt, on its own full-width ground — the one element that makes
        // this read as a transcript rather than as a list of lines.
        Container(
          height: lineHeight,
          color: banner,
          child: Row(
            children: [
              // The `›` gutter the real prompt keeps.
              SizedBox(width: bar * 0.9),
              Expanded(
                child: FractionallySizedBox(
                  alignment: Alignment.centerLeft,
                  widthFactor: turn.prompt,
                  child: Container(
                    height: bar,
                    decoration: BoxDecoration(
                      color: fill,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        SizedBox(height: lineHeight * 0.35),
        // The answer: a bullet on the first row, the rest indented under it.
        for (var i = 0; i < turn.answer.length; i++)
          if (i == 0)
            SizedBox(
              height: lineHeight,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Container(
                    width: bar * 0.55,
                    height: bar * 0.55,
                    decoration: BoxDecoration(
                      color: fill,
                      shape: BoxShape.circle,
                    ),
                  ),
                  SizedBox(width: bar * 0.7),
                  Expanded(
                    child: FractionallySizedBox(
                      alignment: Alignment.centerLeft,
                      widthFactor: turn.answer[i],
                      child: Container(
                        height: bar,
                        decoration: BoxDecoration(
                          color: fill,
                          borderRadius: BorderRadius.circular(3),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            )
          else
            line(turn.answer[i], indent: bar * 1.25),
        if (turn.meta != null) ...[
          SizedBox(height: lineHeight * 0.35),
          // The `✳ Crunched for 3s · done 10:36` line that closes a turn: always
          // shorter, and thinner than a line of body text.
          line(turn.meta!, height: bar * 0.7),
        ],
        if (!last) SizedBox(height: lineHeight * 0.9),
      ],
    );
  }
}

/// The shape of one transcript turn, for [_Attaching].
/// Wipes [child] in from the top edge to the bottom over [listenable]'s 0→1.
///
/// ⚠️ **A wipe, not a fade or a slide.** The skeleton stands in for a terminal
/// whose rows must not move — every bar is already at the pixel its text will
/// occupy (see [_Attaching]) — so the reveal cannot translate anything. A plain
/// fade would have the whole block appear at once, which says nothing about the
/// direction output arrives from. Masking by height instead lets the rows arrive
/// the way a screen paints: from the top, downward, each one landing where it
/// will stay.
///
/// The leading edge is a short gradient rather than a hard line, so what crosses
/// a row is a brightening rather than a switch — at 60fps a hard edge stepping
/// down the screen reads as a tear.
class _RevealDown extends StatelessWidget {
  const _RevealDown({required this.listenable, required this.child});

  final Animation<double> listenable;
  final Widget child;

  /// The soft edge's depth, as a fraction of the pane.
  ///
  /// 0.10, down from the 0.18 a fast sweep used: feather is a fraction of the
  /// PANE, so at a slow rate a wide one keeps a fifth of the screen in permanent
  /// half-light as it crawls past. Narrow enough to stay crisp, wide enough that
  /// what crosses a row is still a brightening rather than a switch.
  static const _feather = 0.10;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: listenable,
    // The subtree does not depend on `t`, so it is built once and reused across
    // every frame of the sweep — the mask is the only thing that changes.
    child: child,
    builder: (context, built) {
      // ⚠️ **Linear, and that is the point for a sweep this long.** Every eased
      // curve front-loads the travel: `easeOutQuad` has the edge 84% of the way
      // down at the halfway mark, so over a 2.6-second reveal the last row would
      // take more than a second to gain its final sliver — a sweep that visibly
      // stalls just before it arrives, which is the thing this pacing exists to
      // avoid. A constant rate reads as steady progress, which is what it is
      // standing in for.
      final t = listenable.value;
      // Kept even though the controller stops short of 1 (see `_sweepExtent`),
      // because this widget must also be correct for a caller that runs it to
      // completion — and a mask that covers nothing is pure cost per frame.
      if (t >= 1) return built!;
      // Travels from just above the top edge towards just past the bottom, so
      // the first row is fully revealed rather than starting at half brightness.
      // It does not arrive: the controller is bounded below the value that would
      // take it there.
      final edge = t * (1 + _feather * 2) - _feather;
      return ShaderMask(
        blendMode: BlendMode.dstIn,
        shaderCallback: (bounds) => LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: const [Colors.white, Colors.white, Colors.transparent],
          // Clamped because a stop list must be non-decreasing and within 0..1;
          // at the extremes of the travel above, both terms run outside it.
          stops: [
            0,
            (edge - _feather).clamp(0.0, 1.0),
            edge.clamp(0.0, 1.0),
          ],
        ).createShader(bounds),
        child: built,
      );
    },
  );
}

class _SkeletonTurn {
  const _SkeletonTurn({
    required this.prompt,
    required this.answer,
    required this.meta,
  });

  /// Width of the prompt text inside its banner, as a fraction of the pane.
  final double prompt;

  /// The answer's lines, longest first — a paragraph wraps full-width and its
  /// last line runs short.
  final List<double> answer;

  /// The closing meta line, or null for the newest turn, which has not finished.
  final double? meta;
}

/// The header sliding up off the top of the page, fading as it goes.
///
/// ⚠️ **A translation, and it must stay one.** It used to shrink with
/// [Align.heightFactor] so the terminal below could grow into the space — which
/// resized the far machine's shell on every fold. The header is laid over the
/// terminal now (see the page's build), so moving its paint is all a fold needs
/// and the terminal's layout never hears about it.
///
/// ⚠️ **The same widgets at every value, 0 included.** Returning the bare child
/// while it was fully shown swapped the widget type in that slot at the start
/// and end of every fold, which unmounted the header and built it again.
class _SlideAway extends StatelessWidget {
  const _SlideAway({required this.progress, required this.child});

  /// 0 fully shown, 1 fully gone.
  final Animation<double> progress;

  final Widget child;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: progress,
    // ⚠️ Built ONCE and passed through. The child is a whole header, and
    // rebuilding it on every frame of a scroll is work for nothing — what
    // changes is where it is painted, not anything in it.
    child: child,
    builder: (context, child) {
      final value = progress.value;
      return IgnorePointer(
        // Part-way out it is no longer the bar it looks like — the floating
        // buttons are taking over — and fully out it is off the page.
        ignoring: value > 0,
        child: FractionalTranslation(
          translation: Offset(0, -value),
          child: Opacity(
            // Spent by the two-thirds mark, which is where the floating buttons
            // are arriving. Anything still visible after that competes with them.
            opacity: (1 - value / 0.66).clamp(0.0, 1.0),
            child: child,
          ),
        ),
      );
    },
  );
}

/// The longest agent name the header will print before it cuts.
///
/// An agent's name is usually a filename, and the header row has to hold three
/// controls beside it. Left to the width alone, a long name pushed right up
/// against `+` with no gap; cutting by COUNT keeps a fixed, predictable stretch
/// of chrome whatever the name and whatever the screen.
const int _titleMaxChars = 20;

/// The name as the header prints it: cut to [_titleMaxChars] with an ellipsis
/// when it is longer.
///
/// ⚠️ Counts runes, not code units. `String.length` counts UTF-16 units, so an
/// emoji or a decomposed Vietnamese vowel costs two and a name cuts early —
/// short of the 20 the design asks for, and at a different point per name.
///
/// ⚠️ The header's own width ellipsis stays as well. This one bounds the
/// string; that one still catches a 20-character name on a narrow screen, and
/// neither makes the other redundant.
///
/// ⚠️ **Nothing calls it since the title left the header** — the name is drawn
/// in [TerminalFootBar] now, where it has a whole row and ellipses on width
/// alone. Kept because a title may come back to the chrome, and this is the
/// rune-correct cut it would want.
// ignore: unused_element
String _clipTitle(String name) {
  final runes = name.runes.toList();
  if (runes.length <= _titleMaxChars) return name;
  // Trailing space before the ellipsis reads as a typo, so it goes.
  return '${String.fromCharCodes(runes.take(_titleMaxChars)).trimRight()}…';
}

/// The way out of search, in the header where the page's own controls were.
///
/// ⚠️ **It draws at a fixed size and does not animate.** Its arrival is
/// [_TrailingSwap]'s fade; a width or a scale of its own on top of that is what
/// made the field beside it move, and the field holding still is the point.
///
/// The word rather than a glyph: this is the one control on the row that leaves,
/// and a second `×` beside the field's own clear would be two ways out sitting
/// together.
class _CancelSearchButton extends StatelessWidget {
  const _CancelSearchButton({required this.onTap});

  final VoidCallback onTap;

  static const String _label = 'Cancel';

  /// The gap between the field and the word.
  static const double _lead = 12;

  static const TextStyle _style = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w500,
  );

  /// How wide this button comes out, laid against [context]'s text scaling.
  ///
  /// ⚠️ **Measured, not assumed.** The search overlay draws its field beside
  /// this and has to stop exactly where the word starts; a hard-coded width
  /// would be wrong the moment the system font scale moves, and the field would
  /// either overhang "Cancel" or leave a gap before it. [TextPainter] is what
  /// the row itself will lay out with, so the two agree by construction.
  static double extentFor(BuildContext context) {
    final painter = TextPainter(
      text: TextSpan(text: _label, style: _style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final width = painter.width;
    painter.dispose();
    return _lead + width;
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: 'Cancel search',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: SizedBox(
          // The bar's own height, so the target covers the row rather than just
          // the word's line box.
          height: TerminalHeader.barHeight,
          child: Padding(
            // Leading gap from the field; nothing trailing, so the word stops on
            // the header's own right inset the way the last action does.
            padding: const EdgeInsets.only(left: _lead),
            child: Center(
              child: Text(
                _label,
                maxLines: 1,
                softWrap: false,
                style: _style.copyWith(color: AppPalette.accentOnSurface),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The header's trailing end, cross-fading its controls for Cancel as search
/// opens — in a column that never changes width.
///
/// ⚠️ **A [Stack], not a collapse, and the search field's steadiness is the
/// whole reason.** Handing these points back made the field widen into them and
/// then narrow again as Cancel claimed its own — two layout changes in opposite
/// directions inside one gesture, which reads as the row snapping about rather
/// than as anything opening. Keeping both sets in the same slot means the field
/// is laid out once and never moves: what changes is only which of the two is
/// painted.
///
/// ⚠️ **The slot is given an explicit width, not sized by its children.** A
/// [Stack] would take the wider of the two, which is a number nothing outside
/// this widget can predict — and the search overlay MUST predict it, because it
/// draws its field up to this slot's left edge. [extentFor] is that number, and
/// both this and the overlay are laid out from it.
///
/// ⚠️ Both children stay laid out for the whole animation. That is what lets
/// them cross-fade at all, and it is why each is wrapped in its own
/// [IgnorePointer] — an invisible Cancel over a live `⋯` would otherwise take
/// the tap meant for the menu.
class _TrailingSwap extends StatelessWidget {
  const _TrailingSwap({
    required this.progress,
    required this.children,
    required this.cancel,
    required this.extent,
  });

  /// 0 the page's own controls are showing, 1 Cancel is.
  final Animation<double> progress;

  /// The header's controls: `+`, `⋯`, and reclaim when the stream is read-only.
  final List<Widget> children;

  /// The way out of search, shown in their place.
  final Widget cancel;

  /// The slot's width, from [extentFor].
  final double extent;

  /// How wide a slot holding [actions] controls must be.
  ///
  /// The wider of the two states, so the field beside it lands in the same place
  /// whichever is showing — which is the entire point of the swap.
  ///
  /// ⚠️ Counts [TerminalHeader.barGap] once, at the front. Both states carry
  /// that gap (see the [Row] below and [_CancelSearchButton]'s own leading pad),
  /// so it belongs to the slot rather than to either side of it.
  static double extentFor(BuildContext context, int actions) {
    // Each action is [AppIconButton]'s fixed 24px box with [_HeaderAction.gap]
    // either side, except the last, whose trailing pad is dropped so the row
    // stops on the header's own inset.
    const box = 24.0;
    final controls = actions == 0
        ? 0.0
        : actions * (box + _HeaderAction.gap * 2) - _HeaderAction.gap;
    final cancel = _CancelSearchButton.extentFor(context);
    return TerminalHeader.barGap + (controls > cancel ? controls : cancel);
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: progress,
    builder: (context, _) {
      final open = progress.value;
      // ⚠️ Fading straight across leaves the middle of the move half-lit on
      // both sides, which reads as a smear rather than as an exchange. Each
      // takes its own half: the outgoing is gone by the midpoint, and the
      // incoming starts from there.
      final out = (1 - open * 2).clamp(0.0, 1.0);
      final into = (open * 2 - 1).clamp(0.0, 1.0);
      return ConstrainedBox(
        // ⚠️ A MINIMUM, not a fixed width. The reclaim button is labelled, so
        // its width is its text's and no constant describes it — forcing the
        // measured width on the row would clip it. A floor gives the field a
        // width it can count on while leaving a wider control room to be itself:
        // the only cost is that the field is a little shorter than it could be
        // on a read-only stream, which is a state search is rarely opened from.
        constraints: BoxConstraints(minWidth: extent),
        child: Stack(
          // Against the right edge: whichever is showing, it ends on the
          // header's own inset rather than floating inside the slot.
          alignment: Alignment.centerRight,
          children: [
            Opacity(
              opacity: out,
              child: IgnorePointer(
                // Untappable from the first frame of the open: they act on the
                // agent underneath, and search is what is on screen now.
                ignoring: open > 0,
                // ⚠️ No gap of its own before these — the slot's width already
                // carries [TerminalHeader.barGap], and a second one here would
                // push the controls off the header's right inset.
                child: Row(mainAxisSize: MainAxisSize.min, children: children),
              ),
            ),
            Opacity(
              opacity: into,
              // Live only once it is the thing on screen. Taken on the tail of
              // the fade rather than at the very end, so a finger arriving as
              // the word settles is not ignored.
              child: IgnorePointer(ignoring: open < 0.5, child: cancel),
            ),
          ],
        ),
      );
    },
  );
}

/// One of the header's trailing controls, padded so the three sit evenly.
///
/// ⚠️ The padding is what makes the row look right, and the reason is that
/// [AppIconButton] is a fixed 24px box for every glyph size. A 22px glyph fills
/// that box to its edges while a 20px one floats inside it, so equal gaps
/// BETWEEN the boxes read as unequal gaps between the marks. Giving every
/// action the same glyph size and the same padding puts the marks on an even
/// pitch.
///
/// ⚠️ It does NOT widen the tap target. [AppIconButton] takes its tap on a
/// 24px `GestureDetector` with no `HitTestBehavior.opaque`, so the padding is
/// dead space either side and the three stay 24px each — under the 44 iOS asks
/// for. Fixing that belongs in the shared button, where every screen's header
/// would get it, not in a wrapper one page defines.
class _HeaderAction extends StatelessWidget {
  const _HeaderAction({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.size = 21,
    this.last = false,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;
  final double size;

  /// The rightmost action, whose trailing padding is dropped: [PhoneHeader]
  /// already insets the row's right edge, and keeping it here would push the
  /// last mark further from the edge than the others are from each other.
  final bool last;

  /// Half the gap between two marks — each neighbour contributes one, so the
  /// boxes end up 14 apart.
  ///
  /// 14 because that is [PhoneHeader]'s own right inset: the gap between two
  /// actions and the gap from the last one to the screen edge are then the
  /// same measure, and the three read as evenly placed rather than as a group
  /// shoved against the corner.
  static const double gap = 7;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(gap, 0, last ? 0 : gap, 0),
    child: AppIconButton(
      icon: icon,
      size: size,
      tooltip: tooltip,
      color: AppPalette.textSecondary,
      onPressed: onPressed,
    ),
  );
}
