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
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/image_transcode.dart';
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
import 'terminal_action_column.dart';
import 'terminal_chrome_scroll.dart';
import 'terminal_header.dart';
import 'terminal_header_floats.dart';
import 'terminal_input_dock.dart';
import 'terminal_search.dart';
import 'voice_input_controller.dart';

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

  /// What the header held, for when the row is not on screen to hold it: `⋯`.
  ///
  /// ⚠️ Built from the same condition as the header's own row, so the float
  /// never offers something the row would have withheld — `⋯` needs an agent
  /// that has loaded. Search and New agent are not here: they float in the
  /// bottom-right corner with the mic whether the header is up or not.
  List<TerminalHeaderChoice> _headerChoices(
    MachineState? machine,
    Agent? agent,
  ) => [
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
  /// ⚠️ **Worked out from the header's own constants rather than measured.** The
  /// header is being taken apart at exactly the moment these are read, so
  /// constants are the only description of where its controls WERE that
  /// survives the row leaving. The trade is that the origins drift if the
  /// header's layout changes without this changing with it — buttons flying
  /// from slightly the wrong place, never a crash or a missed target.
  List<Offset> _headerOrigins(int count) {
    const inset = TerminalHeaderFloats.inset;
    const pitch = TerminalHeaderFloats.pitch;
    const extent = TerminalHeaderFloats.extent;
    // The trailing actions are [_HeaderAction]s: 24px boxes with 7 either side,
    // the last one's trailing pad dropped, laid from the right edge inwards past
    // the header's own inset.
    const actionPitch = 24 + _HeaderAction.gap * 2;
    const headerMidY = TerminalHeader.topInset + TerminalHeader.rowHeight / 2;
    return [
      for (var i = 0; i < count; i++)
        () {
          final fromRight =
              TerminalHeader.sideInset + actionPitch * (count - 1 - i) + 12;
          const restFromRight = inset + extent / 2;
          final restY = inset + i * pitch + extent / 2;
          return Offset(restFromRight - fromRight, headerMidY - restY);
        }(),
    ];
  }

  /// Opens the machine's new-agent form.
  ///
  /// Awaited: the form may be backed out of rather than completed, and this page
  /// gets no rebuild when it lands back on top.
  Future<void> _newAgent() async {
    await openNewAgent(context, widget.notifier, widget.machineId);
    if (mounted) setState(() {});
  }

  /// Fades the search screen up over the terminal.
  ///
  /// ⚠️ The overlay is mounted on THIS frame and the animation started on it,
  /// so the field is there to take the keyboard as the screen opens. Mounting
  /// at the end of the fade would land the caret a beat too late for a button
  /// that was tapped to type in.
  void _openSearch() {
    if (_searching) return;
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
  /// Voice is the floating mic, never this tap — see [TerminalActionColumn].
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

  /// Whether the keyboard on screen is THIS page's — the question the floating
  /// controls ask, which [_keyboardUp] alone answers wrongly.
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
      // Not the voice controller: what the mic hears repaints the floating mic
      // and its pill, which listen for themselves, and never rebuilds the
      // terminal under them.
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
        final reclaim = phoneReclaimAction(session);
        // Creating needs the machine to list its folders and name its engines,
        // so one that is offline or still wants its password cannot host a new
        // agent — the same gate the Agents tab puts on its fab.
        final canCreate =
            machine != null &&
            phoneMachineStatusOf(machine) == PhoneMachineStatus.ready;
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
                              child: pane == null || session == null
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
                          // The mic, Search and New agent, floating in the
                          // terminal's bottom-right corner — see
                          // [TerminalActionColumn].
                          //
                          // ⚠️ Hidden while this page owns the keyboard.
                          // Typing is the other way of saying what the mic
                          // says, the key bar is already under the thumb, and
                          // a column floating over the prompt being typed into
                          // would be in the way of both.
                          if (!_ownsInput)
                            Positioned(
                              right: TerminalActionColumn.inset,
                              bottom: TerminalActionColumn.inset,
                              child: TerminalActionColumn(
                                voice: widget.voice,
                                session: session,
                                onSearch: _openSearch,
                                onNewAgent: canCreate
                                    ? () => unawaited(_newAgent())
                                    : null,
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
                            agent: agent,
                            machineName: machine?.machine.displayName ?? '',
                            status: phoneSessionSummary(session),
                            trailing: [
                              // Read-only is a state to get OUT of, so its way
                              // out is a labelled button in the header rather
                              // than a line in the actions sheet: the sheet is
                              // where you go having decided to do something,
                              // and this is the thing telling you that typing
                              // will go nowhere until you do.
                              if (reclaim != null)
                                _ReclaimButton(
                                  action: reclaim,
                                  onPressed: () => widget.notifier.selectAgent(
                                    widget.machineId,
                                    widget.agentId,
                                  ),
                                ),
                              // Null while the agent is not loaded: there is
                              // nothing to act on yet, and a menu of actions
                              // that all fail is worse than no menu.
                              if (agent != null)
                                _HeaderAction(
                                  icon: LucideIcons.ellipsis300,
                                  size: 21,
                                  tooltip: 'Agent actions',
                                  // Last in the row, so its padding stops at
                                  // the header's own right inset.
                                  last: true,
                                  onPressed: () => _showActions(
                                    machineName:
                                        machine?.machine.displayName ?? '',
                                    agentName: agent.name,
                                  ),
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
                // Search, faded up over the whole page. Only built while it is
                // on its way in, up, or on its way out — see [_searching].
                if (_searching)
                  Positioned.fill(
                    child: TerminalSearchOverlay(
                      notifier: widget.notifier,
                      animation: _searchCurve,
                      onClose: _closeSearch,
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

class _Attaching extends StatelessWidget {
  const _Attaching();

  @override
  Widget build(BuildContext context) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox.square(
          dimension: 22,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: AppPalette.accent,
          ),
        ),
        const SizedBox(height: 14),
        Text(
          'Attaching to the agent…',
          style: TextStyle(color: AppPalette.textSecondary, fontSize: 14),
        ),
      ],
    ),
  );
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
/// ⚠️ **Nothing calls it** — [TerminalHeader] ellipses the name on width alone,
/// beside the machine. Kept because a count cut may be wanted there again, and
/// this is the rune-correct one it would want.
// ignore: unused_element
String _clipTitle(String name) {
  final runes = name.runes.toList();
  if (runes.length <= _titleMaxChars) return name;
  // Trailing space before the ellipsis reads as a typo, so it goes.
  return '${String.fromCharCodes(runes.take(_titleMaxChars)).trimRight()}…';
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
