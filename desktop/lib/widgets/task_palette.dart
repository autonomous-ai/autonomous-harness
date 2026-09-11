import 'dart:async';
import 'dart:ui' show FontFeature, ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/models.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import 'engine_identity.dart';

/// ⌘B — describe the work, and let the daemon say whose it is.
///
/// A TASK BOX, not a command palette. There is no list of actions to fuzzy-match and no agent search:
/// the whole interface is one field, and the answer to "which agent" is the router's job, not the
/// typist's. That is the point of the feature — the moment it also does lookup, the field has to guess
/// whether a word is a task or a name, and it will guess wrong on the short ones.
///
/// It is the same router the dial has always used (`routeVoiceTask`), which has never cared that its
/// input arrived as speech. What is new is that the answer comes back to a surface that can SHOW it: the
/// dial had to act on a pick it could not explain, a window can hold it up and ask.
///
/// CONFIDENT WORK IS SILENT, UNSURE WORK ASKS. Above the threshold the palette closes and the pane
/// simply becomes that agent — the text arriving in the terminal is the receipt, and a toast on top of it
/// would be a second one. Below it, nothing is sent and the runners-up are offered instead.
/// Words spoken into the dial, on their way into this palette instead of a person's typing.
///
/// The daemon asked THIS window to route them — see cable/windowRoute.ts — so the palette owes it an
/// answer either way: [taken] the moment it is on screen, then exactly one of [sent] or [cancelled].
/// Without the last one the dial holds its sending overlay until a watchdog it owns gives up, which is
/// a minute of a screen saying work is in flight when a person has already closed the question.
class SpokenTask {
  SpokenTask({
    required this.voiceId,
    required this.text,
    required this.cmd,
    required this.report,
  });

  final String voiceId;

  /// The transcript, verbatim. It lands in the field exactly as a person would have typed it.
  final String text;

  /// 'goal', 'loop', or empty — which of the dial's three buttons was held. The overview has all three,
  /// so a spoken task can be a goal without naming an agent.
  final String cmd;

  final void Function(String voiceId, String state, String agentId) report;

  bool _settled = false;

  void taken() => report(voiceId, 'taken', '');

  void sent(String agentId) {
    if (_settled) return;
    _settled = true;
    report(voiceId, 'sent', agentId);
  }

  /// Idempotent, and called on EVERY way out of the palette — Esc, the barrier, a dead end, or a commit
  /// that already answered (where it does nothing). One exit, one answer.
  void cancelled() {
    if (_settled) return;
    _settled = true;
    report(voiceId, 'cancelled', '');
  }
}

Future<void> showTaskPalette(
  BuildContext context,
  AppNotifier notifier, {
  SpokenTask? spoken,
}) {
  // showGeneralDialog, not showDialog, and the barrier is BUILT rather than coloured: the design's veil
  // is `rgba(0,0,0,.74)` over `backdrop-filter: blur(3px)`, and `barrierColor` can only do the first
  // half. The blur is what makes the terminals behind read as *behind* instead of as text competing with
  // the field — at 74% flat they are dimmed but still legible, which is worse than either extreme.
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'Dismiss',
    barrierColor: Colors.transparent,
    transitionDuration: const Duration(milliseconds: 160),
    pageBuilder: (context, _, _) =>
        _TaskPalette(notifier: notifier, spoken: spoken),
    transitionBuilder: (context, anim, _, child) => FadeTransition(
      opacity: CurvedAnimation(parent: anim, curve: Curves.easeOut),
      child: child,
    ),
    // Every exit lands here — Esc, a tap on the veil, and the self-close after a send. A commit has
    // already answered by then and this does nothing; anything else is a person walking away, which the
    // dial has to hear about or it keeps showing work that is not happening.
  ).whenComplete(() => spoken?.cancelled());
}

/// The design's own values, lifted rather than approximated.
///
/// Every number here is read off the `Palette_*` CSS module the design team published on the product
/// page — the same component, already drawn for this exact feature down to the "taken" row and the
/// confidence column. Naming them together is what keeps a later "small tidy" from drifting off it one
/// value at a time; if the page changes, this block is the diff.
abstract final class _D {
  /// The frosted sheet.
  static const width = 680.0;
  static const radius = 16.0;
  static const fill = Color(0xE11E1E21); // rgba(30,30,33,.88)
  static const rim = Color(0x1FFFFFFF); // rgba(255,255,255,.12)
  static const blur = 24.0;

  /// The lit top edge — `inset 0 1px 0 rgba(255,255,255,.06)`. A one-pixel highlight is most of what
  /// makes glass read as glass rather than as a grey box.
  static const innerLight = Color(0x0FFFFFFF);

  /// The veil.
  static const veil = Color(0xBD000000); // rgba(0,0,0,.74)
  static const veilBlur = 3.0;

  /// ABOVE the middle, deliberately: the list grows downwards, and a box pinned to the centre would
  /// jump every time the answer arrived. Anchored high, it stays put and the results unroll beneath it.
  static const lift = -0.38;

  /// The field.
  static const fieldInk = Color(0xFFF4F4F6);
  static const hint = Color(0xFF6E6E76);
  static const caret = Color(0xFFE6E6EA);
  static const fieldSize = 22.0;

  /// The rows.
  static const sep = Color(0x14FFFFFF); // rgba(255,255,255,.08)
  static const activeFill = Color(0x14FFFFFF);
  static const engineInk = Color(0xFFF4F4F6);
  static const machineInk = Color(0xFF8A8A92);
  static const machineDim = Color(0xFF6A6A72);
  static const nameInk = Color(0xFFD0D0D6);
  static const questionInk = Color(0xFF7C7C84);
  static const questionMark = Color(0xFFB9F0CF);

  /// Green means "this one", in both places it appears: the fit that is worth considering, and the row
  /// that took the work.
  static const green = Color(0xFF3DDC84);
  static const takenFill = Color(0x243DDC84); // rgba(61,220,132,.14)
  static const takenRim = Color(0x733DDC84); // rgba(61,220,132,.45)
  static const lowFit = Color(0xFF8A8A92);

  /// The five columns. Fixed, and that IS the feature: three rows whose machine and fit line up can be
  /// read down a column, which is the comparison the person was stopped to make. Flex columns put the
  /// same facts at three different x positions and turn a comparison into three separate readings.
  static const colIcon = 16.0;
  static const colName = 118.0;
  static const colMachine = 190.0;
  static const colFit = 44.0;
  static const colGap = 12.0;
}

/// Below this the palette stops guessing and asks.
///
/// It is not a tuned number, it is the router's own top band: the classifier is told to answer **0.85+
/// when the name and/or recent activity CLEARLY match**, ~0.6 for "reasonable but not certain", and ~0.3
/// when nothing fits and it is naming the closest agent anyway. Sitting the line exactly on 0.85 means
/// this window sends in silence only when the router used the word "clearly" — every softer answer,
/// including the ones it called reasonable, becomes a question.
///
/// It was 0.5, and 0.5 was measured to be inside the model's own noise. The same task — "so sanh iphone
/// vs samsung" — routed twice seven minutes apart came back 0.35 and 0.80: once a question, once a silent
/// send, to two DIFFERENT agents. A threshold a small classifier can cross by chance is not a threshold,
/// and the wrong side of it is a task delivered to the wrong agent with nothing on screen to say so.
///
/// The cost is deliberate and worth naming: more asking. A "reasonable" 0.6 pick now stops for a keypress
/// it used to skip. That trade is the right way round — a question costs one Enter, a silent wrong route
/// costs a turn on the wrong agent and the time to notice.
///
/// The heuristic fallback is unaffected and stays what it was: capped at 0.4, so a router that could not
/// run has never been able to reach this line and still cannot. "The router broke" and "the router is
/// unsure" arrive at the same place — a question, never a silent wrong guess.
const double _confidentEnough = 0.85;

class _TaskPalette extends StatefulWidget {
  const _TaskPalette({required this.notifier, this.spoken});

  final AppNotifier notifier;

  /// Set when the words arrived from the dial rather than the keyboard.
  final SpokenTask? spoken;

  @override
  State<_TaskPalette> createState() => _TaskPaletteState();
}

/// [sent] is a BEAT, not a screen. See [_confirmBeat].
enum _Stage { typing, routing, choosing, empty, sent }

/// How long the receipt stays up before the palette closes itself.
///
/// A confident route used to close the instant the daemon answered, on the rule that the text landing in
/// the terminal is the receipt. It is — but only if you are looking at that pane, and ⌘B is most useful
/// exactly when you are not: the agent it picks is often on another machine and behind another tile. So
/// the window says who took the work, briefly, and then gets out of the way. Long enough to read four
/// words, short enough that nobody waits on it.
const Duration _confirmBeat = Duration(milliseconds: 750);

class _TaskPaletteState extends State<_TaskPalette> {
  final TextEditingController _text = TextEditingController();

  /// THE KEYS ARE HANDLED ON THIS NODE, not on a Focus above the field, and not through onSubmitted.
  ///
  /// A multi-line TextField consumes Enter itself — it inserts a newline and never calls onSubmitted —
  /// and key events travel from the focused node UPWARDS, so an ancestor Focus is asked only about the
  /// keys the field did not want. Enter was never one of them. A FocusNode's own onKeyEvent runs while
  /// the event is dispatched TO the node, ahead of the editing shortcuts that would type the newline, so
  /// this is the one place that can take Enter back.
  late final FocusNode _fieldFocus = FocusNode(onKeyEvent: _onFieldKey);

  _Stage _stage = _Stage.typing;
  String _note = '';

  /// The answer itself, kept because the picker explains ITSELF with it: how many agents were weighed,
  /// across how many computers, and whether a classifier or the name matcher produced this.
  RouteAnswer? _answer;

  /// Which agent took the work — held for the receipt beat, where the design lights that row rather
  /// than printing a sentence about it.
  String _committed = '';

  /// Seconds on the clock while the router thinks.
  ///
  /// The wait can run to twenty seconds, and a spinner that says nothing for that long reads as a hang.
  /// A number that moves is the difference between "it is working" and "it has stopped".
  Timer? _ticker;
  int _elapsed = 0;

  List<RouteCandidate> _choices = const [];
  int _cursor = 0;

  /// The picker scrolls now that it offers every agent that was weighed, so the arrow keys need
  /// somewhere to scroll and each row needs to be findable to be scrolled TO.
  final ScrollController _listScroll = ScrollController();
  List<GlobalKey> _rowKeys = const [];

  /// How tall the list is allowed to get before it scrolls.
  ///
  /// Fifteen rows is roughly eight hundred pixels — taller than the palette, taller than some screens,
  /// and it would push the field it belongs to off the top. Six-ish rows keeps the whole sheet a sheet,
  /// and the rest is one flick or one arrow key away.
  static const double _listMaxHeight = 316;

  /// Which question is still ours. A second Enter — or an Esc and a re-open — must not let a slow first
  /// answer arrive and act: it belongs to a palette state nobody is looking at any more.
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    final spoken = widget.spoken;
    if (spoken == null) return;
    // The transcript goes in the field rather than into a variable the person cannot see: this is the
    // same palette, and what it is about to route has to be readable — and editable, if the STT heard
    // "web hook" and meant "webhook".
    _text.text = spoken.text;
    _text.selection = TextSelection.collapsed(offset: _text.text.length);
    // Acked BEFORE the first frame, not after the route: the daemon is deciding, on a two-second clock,
    // whether any window is listening at all, and it must not fall back to routing on its own while this
    // one is up. See cable/windowRoute.ts.
    spoken.taken();
    // Then run exactly what Enter runs. Posted after the frame so the palette is on screen while it
    // works — routing takes up to twenty seconds, and a dialog that appears already-spinning reads as
    // a hang rather than as an answer being worked out.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_route());
    });
  }

  @override
  void dispose() {
    _generation++; // anything still in flight now answers to nobody
    _ticker?.cancel();
    _text.dispose();
    _fieldFocus.dispose();
    _listScroll.dispose();
    super.dispose();
  }

  Future<void> _route() async {
    final task = _text.text.trim();
    if (task.isEmpty || _stage == _Stage.routing) return;
    final mine = ++_generation;
    setState(() {
      _stage = _Stage.routing;
      _note = '';
      _answer = null;
    });
    _startClock();

    final answer = await widget.notifier.routeTask(task);
    if (!mounted || mine != _generation) return;
    _stopClock();

    // Nobody to ask, or nobody to pick from. Say which — "no agents here" and "the daemon is not up" are
    // different problems and lead to different next moves.
    if (answer == null) {
      setState(() {
        _stage = _Stage.empty;
        _note = widget.notifier.localMachineState == null
            ? 'No local machine is connected yet.'
            : 'Could not reach the router on this computer.';
      });
      return;
    }
    if (answer.isEmpty) {
      setState(() {
        _stage = _Stage.empty;
        _note = 'There is no agent on this computer to send that to.';
      });
      return;
    }

    if (answer.confidence >= _confidentEnough) {
      _answer = answer; // so the receipt can name who took it
      await _commit(answer.agentId, answer.machineId, task);
      return;
    }
    setState(() {
      _stage = _Stage.choosing;
      _answer = answer;
      _choices = answer.candidates;
      _rowKeys = List.generate(answer.candidates.length, (_) => GlobalKey());
      _cursor = 0;
    });
  }

  /// Move the highlight, and keep it on screen.
  ///
  /// Without the second half the arrow keys walk the selection straight out of the visible window: the
  /// highlight is on row nine, the list is still showing rows one to six, and Enter sends to an agent
  /// nobody can see. `ensureVisible` is posted after the frame because the row it scrolls to may not
  /// have been laid out yet when the cursor moved onto it.
  void _moveCursor(int delta) {
    if (_choices.isEmpty) return;
    setState(() => _cursor = (_cursor + delta).clamp(0, _choices.length - 1));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _cursor >= _rowKeys.length) return;
      final target = _rowKeys[_cursor].currentContext;
      if (target == null) return;
      unawaited(
        Scrollable.ensureVisible(
          target,
          alignment: 0.5,
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOut,
        ),
      );
    });
  }

  /// One second at a time, and only while something is actually in flight.
  void _startClock() {
    _ticker?.cancel();
    _elapsed = 0;
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _elapsed++);
    });
  }

  void _stopClock() {
    _ticker?.cancel();
    _ticker = null;
  }

  Future<void> _commit(String agentId, String machineId, String task) async {
    // NOT closed before the send any more.
    //
    // It used to close first, so a fast route never showed a modal over the pane it was about to fill.
    // But the delivery can fail — a machine that stopped answering takes the turn and nothing comes back
    // — and closing first meant that failure had nowhere to appear: the palette was gone, the pane never
    // changed, and the person was left with a task that had simply evaporated. Measured on the desk with
    // a remote machine whose link was timing out.
    //
    // So it waits for the answer. A successful send is still quiet — the window closes and the pane
    // becomes the agent's — it just closes a moment later than it did.
    final mine = ++_generation;
    setState(() {
      _stage = _Stage.routing;
      _note = '';
    });
    _startClock();
    // The dial's Goal and Loop buttons live on the overview too, so a spoken task can carry a command
    // word without naming an agent. It is applied HERE, at the one place that sends: routing reads the
    // words a person actually said, and the agent receives the slash command they actually pressed.
    final cmd = widget.spoken?.cmd ?? '';
    final failure = await widget.notifier.sendRoutedTask(
      agentId,
      machineId,
      cmd.isEmpty ? task : '/$cmd $task',
    );
    if (!mounted || mine != _generation) return;
    _stopClock();
    if (failure != null) {
      setState(() {
        _stage = _Stage.empty;
        _note = failure;
      });
      return;
    }
    // Landed. Tell the daemon before the beat, not after: it is holding the dial's overlay open on this
    // answer, and three quarters of a second is long enough to be seen as a stall on a device whose only
    // feedback is that overlay.
    widget.spoken?.sent(agentId);
    // Light the row that took it, then close — see [_confirmBeat].
    setState(() {
      _stage = _Stage.sent;
      _committed = agentId;
    });
    await Future<void>.delayed(_confirmBeat);
    if (!mounted || mine != _generation) return;
    Navigator.of(context).pop();
  }

  /// The candidate row for an id, when the answer carried one. The winner is always among them, so a
  /// confident route can name its taker without a second lookup.
  RouteCandidate? _named(String agentId) {
    for (final candidate in _answer?.candidates ?? const <RouteCandidate>[]) {
      if (candidate.agentId == agentId) return candidate;
    }
    return null;
  }

  KeyEventResult _onFieldKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      Navigator.of(context).pop();
      return KeyEventResult.handled;
    }
    final isEnter =
        event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;
    // ⇧Enter is the newline — ignored here so the field does what it always does with it.
    final shift = HardwareKeyboard.instance.isShiftPressed;
    if (isEnter && !shift && _stage != _Stage.choosing) {
      unawaited(_route());
      return KeyEventResult.handled; // …and NOT a newline
    }
    if (_stage != _Stage.choosing) return KeyEventResult.ignored;

    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
      _moveCursor(1);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
      _moveCursor(-1);
      return KeyEventResult.handled;
    }
    if (isEnter && !shift) {
      final pick = _choices[_cursor.clamp(0, _choices.length - 1)];
      unawaited(_commit(pick.agentId, pick.machineId, _text.text.trim()));
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Stack(
      children: [
        // The veil, built rather than tinted — see showTaskPalette. Tapping it closes, which is what the
        // barrier it replaces did.
        Positioned.fill(
          child: GestureDetector(
            onTap: () => Navigator.of(context).maybePop(),
            child: BackdropFilter(
              filter: ImageFilter.blur(
                sigmaX: _D.veilBlur,
                sigmaY: _D.veilBlur,
              ),
              child: const ColoredBox(color: _D.veil),
            ),
          ),
        ),
        Center(
          child: FractionalTranslation(
            translation: const Offset(0, _D.lift),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: _D.width),
                child: _sheet(),
              ),
            ),
          ),
        ),
      ],
    );
  }

  /// The frosted sheet: a clip, the blur behind it, the fill and rim on top, and a one-pixel lit edge.
  ///
  /// The order matters. The blur has to be INSIDE the same clip as the fill or it squares off the
  /// corners, and the lit edge has to sit above the fill or the fill covers it.
  Widget _sheet() {
    return ClipRRect(
      borderRadius: BorderRadius.circular(_D.radius),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: _D.blur, sigmaY: _D.blur),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: _D.fill,
            borderRadius: BorderRadius.circular(_D.radius),
            border: Border.all(color: _D.rim),
            boxShadow: const [
              BoxShadow(
                color: Color(0x99000000),
                blurRadius: 100,
                offset: Offset(0, 40),
              ),
            ],
          ),
          // TRANSPARENT Material, and it is required rather than decorative: dropping Dialog for a
          // hand-built veil dropped the Material ancestor with it, and TextField and InkWell both
          // assert without one. `transparency` provides it while painting nothing, so the glass above
          // stays the only surface — a MaterialType.canvas here would put an opaque sheet over it.
          child: Material(
            type: MaterialType.transparency,
            child: Stack(
              children: [
                Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [_field(), _results()],
                ),
                // `inset 0 1px 0 rgba(255,255,255,.06)`.
                const Positioned(
                  left: 0,
                  right: 0,
                  top: 0,
                  child: ColoredBox(
                    color: _D.innerLight,
                    child: SizedBox(height: 1),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The field, with Material's own skin switched OFF.
  ///
  /// ⚠️ `filled: false`, `isCollapsed: true` and the four explicit `InputBorder.none`s are load-bearing,
  /// not tidying — the same trap `ShareTextField` documents. The app's global [InputDecorationTheme] sets
  /// `filled: true`, a `minHeight` sized for a 32px control, and a focus ring on all three border slots.
  /// `border: InputBorder.none` alone does NOT win: `enabledBorder` and `focusedBorder` are consulted
  /// first, so the field drew a rounded pill in the app's grey INSIDE this sheet — two nested boxes
  /// around one line of text, which is what made the first cut of this palette look cheap.
  Widget _field() {
    final working = _stage == _Stage.routing;
    // 56 of right padding is the design's, and it is what the spinner stands in. The clock needs its own
    // room, so the gap widens only while it is showing rather than leaving a permanent hole.
    final rightPad = working && _elapsed >= 5 ? 84.0 : 56.0;
    return Stack(
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(24, 19, rightPad, 19),
          child: TextField(
            controller: _text,
            focusNode: _fieldFocus,
            autofocus: true,
            maxLines: 4,
            minLines: 1,
            // Enter routes; a newline needs the modifier. The field is for a sentence, not a document,
            // and the common case must not cost a reach for the mouse.
            // Read-only rather than disabled while the router thinks: a disabled field drops the focus,
            // and the focus is what Esc is listening on.
            readOnly: working || _stage == _Stage.sent,
            style: const TextStyle(
              color: _D.fieldInk,
              fontSize: _D.fieldSize,
              height: 1.35,
              letterSpacing: -0.22, // -.01em at 22px
            ),
            cursorColor: _D.caret,
            cursorWidth: 2,
            cursorHeight: _D.fieldSize * 1.05,
            cursorRadius: Radius.zero,
            decoration: const InputDecoration(
              filled: false,
              isDense: true,
              isCollapsed: true,
              contentPadding: EdgeInsets.zero,
              constraints: BoxConstraints(),
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              disabledBorder: InputBorder.none,
              hintText: 'Describe the work…',
              hintStyle: TextStyle(
                color: _D.hint,
                fontSize: _D.fieldSize,
                height: 1.35,
              ),
            ),
          ),
        ),
        // The whole of the waiting state, in the field's own right margin: a 16px ring at right:24.
        if (working) ...[
          const Positioned(
            right: 24,
            top: 0,
            bottom: 0,
            child: Center(
              child: SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(
                  strokeWidth: 1.8,
                  color: _D.hint,
                ),
              ),
            ),
          ),
          // Past five seconds, and only then. The route can run to twenty; under five a clock is noise,
          // over it, it is the difference between working and stopped. The design has no slot for this,
          // so it borrows the spinner's margin rather than adding a row.
          if (_elapsed >= 5)
            Positioned(
              right: 46,
              top: 0,
              bottom: 0,
              child: Center(
                child: Text(
                  '${_elapsed}s',
                  style: const TextStyle(
                    color: _D.hint,
                    fontSize: 11.5,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),
              ),
            ),
        ],
      ],
    );
  }

  /// Everything below the hairline: the question, the rows, or nothing at all.
  Widget _results() {
    switch (_stage) {
      case _Stage.typing:
      case _Stage.routing:
        return const SizedBox.shrink();

      case _Stage.empty:
        return _panel([
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 6, 16, 8),
            child: Text(
              _note,
              style: const TextStyle(
                color: _D.questionInk,
                fontSize: 12,
                height: 1.45,
              ),
            ),
          ),
        ]);

      case _Stage.sent:
        // The receipt is the ROW, lit. The design drew this state and it is better than the line of text
        // it replaces: the eye is already on the row, and a lit row answers "who" as well as "done".
        final taker = _named(_committed);
        return _panel([
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 8, 16, 6),
            child: Row(
              children: [
                Icon(Icons.check, size: 14, color: _D.green),
                SizedBox(width: 8),
                Text(
                  'on it',
                  style: TextStyle(
                    color: _D.green,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
          if (taker != null) _row(taker, active: false, taken: true),
        ]);

      case _Stage.choosing:
        return _panel([
          _question(),
          // Every agent that was weighed, scrolling past the sixth. The question above stays put: it is
          // the explanation for the list, not a row in it.
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: _listMaxHeight),
            child: Scrollbar(
              controller: _listScroll,
              child: SingleChildScrollView(
                controller: _listScroll,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (var i = 0; i < _choices.length; i++)
                      KeyedSubtree(
                        key: i < _rowKeys.length ? _rowKeys[i] : null,
                        child: _row(
                          _choices[i],
                          active: i == _cursor,
                          taken: false,
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ]);
    }
  }

  Widget _panel(List<Widget> children) => Container(
    padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
    decoration: const BoxDecoration(
      border: Border(top: BorderSide(color: _D.sep)),
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    ),
  );

  /// Why it stopped, and what it looked at before it did.
  ///
  /// The counts are marked, not buried: the design gives the numbers inside this line their own colour,
  /// and they are the ones that answer the question a person actually has here — was the agent I mean
  /// even in the running? The list the daemon weighs is capped, so without this nothing on screen says.
  Widget _question() {
    final answer = _answer;
    final heuristic = answer?.via == 'heuristic';
    final reason = (answer?.reason ?? '').trim();
    final weighed = answer?.weighed ?? 0;
    final machines = answer?.machines ?? 0;
    const base = TextStyle(color: _D.questionInk, fontSize: 12, height: 1.45);
    const mark = TextStyle(
      color: _D.questionMark,
      fontSize: 12,
      fontWeight: FontWeight.w500,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text.rich(
            TextSpan(
              style: base,
              children: [
                if (weighed > 0) ...[
                  const TextSpan(text: 'Weighed '),
                  TextSpan(
                    text: '$weighed agent${weighed == 1 ? '' : 's'}',
                    style: mark,
                  ),
                  if (machines > 1) ...[
                    const TextSpan(text: ' on '),
                    TextSpan(text: '$machines computers', style: mark),
                  ],
                  const TextSpan(text: ' — '),
                ],
                TextSpan(
                  text: heuristic
                      ? 'the router could not run, so these are name matches'
                      : 'not sure enough to send it',
                ),
              ],
            ),
          ),
          // The router's own words. It has always sent them and the window has always dropped them,
          // which left the person guessing at a judgement the machine had already explained. The design
          // has no slot for it, so it goes here, quieter than the line above it.
          if (!heuristic && reason.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(
                '“$reason”',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: _D.machineDim,
                  fontSize: 11.5,
                  fontStyle: FontStyle.italic,
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// One candidate, on the design's five-column grid.
  Widget _row(
    RouteCandidate candidate, {
    required bool active,
    required bool taken,
  }) {
    final fit = candidate.confidence;
    // Green is a claim, and it is only made about the leader. Everything else is grey — a runner-up
    // wearing the same colour as the pick would be the palette arguing with itself.
    final leader = fit > 0 && candidate.agentId == (_answer?.agentId ?? '');
    return InkWell(
      onTap: taken
          ? null
          : () => unawaited(
              _commit(
                candidate.agentId,
                candidate.machineId,
                _text.text.trim(),
              ),
            ),
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: BoxDecoration(
          color: taken
              ? _D.takenFill
              : active
              ? _D.activeFill
              : null,
          borderRadius: BorderRadius.circular(10),
          border: taken ? Border.all(color: _D.takenRim) : null,
        ),
        child: Row(
          children: [
            // Greyed and lifted, so a row of six vendors reads as one list instead of six brand marks.
            SizedBox(
              width: _D.colIcon,
              height: _D.colIcon,
              child: ColorFiltered(
                colorFilter: const ColorFilter.matrix(<double>[
                  0.2126 * 1.3, 0.7152 * 1.3, 0.0722 * 1.3, 0, 0, //
                  0.2126 * 1.3, 0.7152 * 1.3, 0.0722 * 1.3, 0, 0, //
                  0.2126 * 1.3, 0.7152 * 1.3, 0.0722 * 1.3, 0, 0, //
                  0, 0, 0, 1, 0,
                ]),
                child: EngineMark(engine: candidate.engine, size: _D.colIcon),
              ),
            ),
            const SizedBox(width: _D.colGap),
            SizedBox(
              width: _D.colName,
              child: Text(
                candidate.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: taken ? const Color(0xFFDFFBE9) : _D.engineInk,
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            const SizedBox(width: _D.colGap),
            SizedBox(
              width: _D.colMachine,
              child: Text(
                candidate.machine,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: taken ? const Color(0xFF9FD9B6) : _D.machineInk,
                  fontSize: 12.5,
                ),
              ),
            ),
            const SizedBox(width: _D.colGap),
            Expanded(
              child: Text(
                candidate.recent,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: taken ? const Color(0xFFDFFBE9) : _D.nameInk,
                  fontFamily: grid.AppFont.mono,
                  fontSize: 13,
                ),
              ),
            ),
            const SizedBox(width: _D.colGap),
            SizedBox(
              width: _D.colFit,
              // Drawn only where there IS one: 0 means the router said nothing about this candidate, and
              // a printed 0.00 would be a claim it never made.
              child: Text(
                fit > 0 ? fit.toStringAsFixed(2) : '',
                textAlign: TextAlign.right,
                style: TextStyle(
                  color: leader || taken ? _D.green : _D.lowFit,
                  fontFamily: grid.AppFont.mono,
                  fontSize: 12,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
