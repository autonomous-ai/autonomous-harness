import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart' show TerminalKey;

import 'package:harness_mobile/terminal/terminal_session.dart';

import 'voice_input_controller.dart';
import 'voice_mic_face.dart';
import 'voice_mic_mode.dart';

typedef VoiceMicAction = ({
  VoiceMicFace face,
  VoidCallback? onPressed,
  VoidCallback? onHoldStart,
  void Function({required bool cancelled})? onHoldFinish,
});

/// What the mic shows and does for the voice input's state right now.
///
/// Which set of callbacks comes back is decided by [voiceMicMode]: the tap mode
/// fills `onPressed` and the hold mode fills the two hold callbacks. The face is
/// worked out the same way for both — it describes the STATE, and only the
/// button knows which gesture reaches it.
VoiceMicAction voiceMicAction(
  VoiceInputController voice,
  TerminalSession session,
) => micHoldsToTalk ? _holdAction(voice, session) : _tapAction(voice, session);

/// Tap to talk, tap Send — [VoiceMicMode.tapToToggle].
///
/// The second tap ends the take, types what was heard into the terminal's
/// prompt — [typeIntoPrompt] — and presses Return, the same as Enter on the
/// keyboard. `×` in the pill beside the mic is the way out while it listens.
///
/// The arrow face is only left for a Return that did not land: the words are in
/// the prompt, and the next tap presses it again.
///
/// ⚠️ Tapping while the microphone is still OPENING calls it off rather than
/// writing: there is no take yet, and leaving the recording to start behind
/// the person's back is worse than asking for one more tap.
VoiceMicAction _tapAction(VoiceInputController voice, TerminalSession session) {
  final canSend = session.acceptsInput;
  if (voice.isSending) return _face(VoiceMicFace.busy);
  if (voice.isStagedIn(session)) {
    return _face(
      VoiceMicFace.send,
      onPressed: canSend
          ? () => voice.sendStaged(() => pressEnter(session))
          : null,
    );
  }
  return switch (voice.status) {
    VoiceInputStatus.transcribing => _face(VoiceMicFace.busy),
    VoiceInputStatus.starting => _face(
      VoiceMicFace.starting,
      onPressed: () => unawaited(voice.stopListening()),
    ),
    VoiceInputStatus.listening => _face(
      VoiceMicFace.listening,
      onPressed: () => unawaited(_writeAndSend(voice, session)),
    ),
    // Words held from a write or send that did not land: sent as a composer
    // turn, which is the one path that does not depend on the prompt.
    _ when voice.transcript.isNotEmpty => _face(
      VoiceMicFace.retry,
      onPressed: canSend
          ? () => unawaited(voice.submit(session.sendComposerText))
          : null,
    ),
    VoiceInputStatus.unavailable => _face(
      VoiceMicFace.off,
      onPressed: () => unawaited(voice.startListening()),
    ),
    VoiceInputStatus.idle => _face(
      VoiceMicFace.talk,
      onPressed: canSend ? () => unawaited(voice.startListening()) : null,
    ),
  };
}

/// Ends the take, types its words into [session]'s prompt, and presses Return.
///
/// Two steps on the controller rather than one: [VoiceInputController.stage]
/// is what leaves the words in the prompt, and a Return that does not land
/// leaves them staged there — the arrow face — for the next tap to send.
Future<void> _writeAndSend(
  VoiceInputController voice,
  TerminalSession session,
) async {
  await voice.stage(session, (text) => typeIntoPrompt(session, text));
  if (voice.isStagedIn(session)) {
    voice.sendStaged(() => pressEnter(session));
  }
}

/// Types [text] into the terminal's prompt, as the keyboard would, without
/// pressing Return. False when the terminal is not taking input.
///
/// Typed rather than pasted: it is what the keyboard's own path does with words
/// said before a tap on the terminal, and it is what Backspace can take back
/// one character at a time — see [eraseFromPrompt].
bool typeIntoPrompt(TerminalSession session, String text) {
  if (!session.acceptsInput || text.isEmpty) return false;
  session.terminal.textInput(text);
  return true;
}

/// Presses Return in the terminal — the send for words [typeIntoPrompt] wrote.
bool pressEnter(TerminalSession session) {
  if (!session.acceptsInput) return false;
  session.terminal.keyInput(TerminalKey.enter);
  return true;
}

/// Takes [text] back out of the prompt it was typed into: one Backspace per
/// character, from the end, where the words were left.
///
/// ⚠️ Per character, counted in runes — `String.length` counts UTF-16 units,
/// and an emoji would cost two Backspaces for the one character it is,
/// deleting a character that was there before the words.
void eraseFromPrompt(TerminalSession session, String text) {
  if (!session.acceptsInput) return;
  for (var i = 0; i < text.runes.length; i++) {
    session.terminal.keyInput(TerminalKey.backspace);
  }
}

/// Hold to talk, release to send — [VoiceMicMode.holdToTalk].
///
/// The whole cycle is one gesture, so there is no state the person can be left
/// stranded in and nothing to press a second time. Two things follow from that,
/// and both differ from the tap mode:
///
///  - **A release always ends the take**, including one that arrives while the
///    microphone is still opening. The pair that makes that safe is
///    [VoiceInputController.startHold] and [VoiceInputController.finishHold] —
///    a start and a release that know about each other, rather than two calls
///    racing over a status neither of them owns.
///  - **Words held from a failed send go with the next press.** A quick tap on
///    the retry face sends them as they are — a take too short to be speech is
///    no failure, see [VoiceInputController.submit] — and a hold that says more
///    sends them with what it adds.
VoiceMicAction _holdAction(
  VoiceInputController voice,
  TerminalSession session,
) {
  if (voice.isSending) return _face(VoiceMicFace.busy);
  if (voice.status == VoiceInputStatus.transcribing) {
    return _face(VoiceMicFace.busy);
  }
  // Recording, or the microphone opening: the thumb is down either way, and
  // what happens next is decided by how it comes up.
  if (voice.status == VoiceInputStatus.starting ||
      voice.status == VoiceInputStatus.listening) {
    return _face(
      voice.status == VoiceInputStatus.starting
          ? VoiceMicFace.starting
          : VoiceMicFace.listening,
      onPressed: _live,
      onHoldFinish: _release(voice, session),
    );
  }
  final canSend = session.acceptsInput;
  // Refused microphone included: holding asks for it again, the same recovery
  // the tap mode offers, reached with the gesture this mode uses for everything.
  // Its release goes through [_release] like every other, which is what makes a
  // permission granted on that very prompt turn into a take that gets sent —
  // the person is already talking by then. A refusal that stands sends nothing,
  // because the transcript is empty and `submit` says nothing about that.
  final refused = voice.status == VoiceInputStatus.unavailable;
  final live = refused || canSend;
  return _face(
    // ⚠️ `retry` rather than `talk` when words are held, even though holding
    // does the same thing either way: the arrow is the only thing on this row
    // that says the last send did not land and the words are still here.
    refused
        ? VoiceMicFace.off
        : voice.transcript.isNotEmpty
        ? VoiceMicFace.retry
        : VoiceMicFace.talk,
    onPressed: live ? _live : null,
    onHoldStart: live
        ? () => unawaited(voice.startHold(session.sendComposerText))
        : null,
    onHoldFinish: live ? _release(voice, session) : null,
  );
}

/// The thumb came up: the one way a hold ever ends.
///
/// Sliding off throws the take away, and anything held from a failed send with
/// it — somebody who slid off to cancel means this message, not just this breath
/// of it. Otherwise the controller sends what was said.
///
/// ⚠️ **[VoiceInputController.finishHold] rather than `submit`, because the
/// release can land before there is anything to submit.** Opening the microphone
/// takes two awaits and real hardware time, and a release inside that window
/// used to abandon the take while the start still in flight went on to open the
/// microphone anyway — a recording with no thumb on it, which nothing stopped
/// and whose audio joined the next take. `finishHold` hands that case back to
/// the start, which finishes and sends the moment it has a take to finish.
void Function({required bool cancelled}) _release(
  VoiceInputController voice,
  TerminalSession session,
) => ({required bool cancelled}) {
  if (cancelled) {
    voice.cancelHold();
    return;
  }
  unawaited(voice.finishHold(session.sendComposerText));
};

/// Marks the button live in hold mode without giving it anything to do on tap.
///
/// `onPressed` is what [VoiceMicButton] reads to decide whether it is enabled at
/// all — dimmed and deaf when null — and in hold mode the work is on the hold
/// callbacks instead. A no-op keeps the one meaning the flag has in common
/// across both modes.
void _live() {}

VoiceMicAction _face(
  VoiceMicFace face, {
  VoidCallback? onPressed,
  VoidCallback? onHoldStart,
  void Function({required bool cancelled})? onHoldFinish,
}) => (
  face: face,
  onPressed: onPressed,
  onHoldStart: onHoldStart,
  onHoldFinish: onHoldFinish,
);

/// What the mic is doing, in a word or two — null with it at rest.
///
/// In hold-to-talk the listening line says what the RELEASE will do instead of
/// naming the state: the thumb is already down and holding, so "Listening…" is
/// the one thing the person can see for themselves, and what happens when they
/// let go is the thing they cannot.
///
/// [session] is the terminal the mic is on: words waiting in ITS prompt say
/// how to send them. Words waiting in another agent's prompt are not this
/// page's business.
String? voiceActivityLabel(
  VoiceInputController voice, [
  TerminalSession? session,
]) {
  if (voice.isSending) return 'Sending…';
  if (session != null && voice.isStagedIn(session)) return 'Tap ↑ to send';
  return switch (voice.status) {
    // ⚠️ "Wait" rather than "Starting…" in hold mode, and it is the difference
    // between working and not. Opening the microphone is real hardware time, and
    // somebody holding a button starts talking the instant they press it — so
    // the first word lands before anything is recording and the take comes back
    // as half a sentence that transcribes to nothing. The line has to ASK them
    // to wait, and the buzz when [VoiceInputStatus.listening] arrives is what
    // tells them to go.
    VoiceInputStatus.starting =>
      micHoldsToTalk ? 'Opening the mic — wait for the buzz' : 'Starting…',
    VoiceInputStatus.listening =>
      micHoldsToTalk
          ? 'Listening… release to send, slide off to cancel'
          : 'Listening… tap to send',
    VoiceInputStatus.transcribing => 'Transcribing…',
    VoiceInputStatus.idle || VoiceInputStatus.unavailable => null,
  };
}
