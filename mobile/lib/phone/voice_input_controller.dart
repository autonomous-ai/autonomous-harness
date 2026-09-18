import 'dart:async';

import 'package:flutter/foundation.dart';

import 'package:harness_mobile/logging/app_log.dart';

import 'voice_language_store.dart';
import 'voice_notice.dart';
import 'voice_recorder.dart';

/// Turns one WAV recording into the words in it — `ApiClient.transcribeVoice`.
typedef VoiceTranscriber = Future<String> Function(Uint8List wav, String lang);

enum VoiceInputStatus {
  /// Not recording. What was heard so far stays.
  idle,

  /// Waiting on the microphone permission prompt, or the microphone opening.
  starting,

  /// Recording.
  listening,

  /// The recording is with the backend, and its words are not back yet.
  transcribing,

  /// The microphone was refused: the keyboard is the only way in until the
  /// person allows it in Settings.
  unavailable,
}

/// Voice input for one pager of terminal pages: what is being recorded, and what
/// has been heard and not yet sent.
///
/// Record, then transcribe — the dial's shape, and the backend's: its
/// `/api/voice/stt` takes a finished recording and answers with its words, so
/// nothing appears while someone is still talking. Each take's words join the
/// transcript when it ends.
///
/// Owned by `AgentSwipeHost`, not by a page, for the reason the keyboard is one
/// screen-wide fact in `terminal_page.dart`: swiping to the next agent must not
/// drop what was said. What is SENT goes to whichever page's mic is pressed.
class VoiceInputController extends ChangeNotifier {
  VoiceInputController({
    required this.transcriber,
    VoiceRecorder? recorder,
    ValueListenable<String>? language,
  }) : _recorder = recorder ?? MicVoiceRecorder(),
       _language = language ?? voiceLanguageStore;

  /// Below this, a take is silence rather than quiet speech: digital zero, or
  /// the hiss of an input nobody is speaking into. Speech peaks in the
  /// thousands. Caught here, it is a clear notice instead of an upload that
  /// comes back empty and reads as "didn't catch that".
  static const silencePeak = 64;

  /// The longest one take runs before it ends by itself. The backend takes
  /// 25 MB; five minutes of 16 kHz mono is under 10.
  static const maxTake = Duration(minutes: 5);

  /// Under this, a take is a slip of the thumb rather than a sentence.
  ///
  /// ⚠️ **Push-to-talk needs this and tap-to-toggle never did.** Two taps are
  /// hard to do inside a third of a second; a press and release is the easiest
  /// thing in the world, and every accidental brush of the button used to go all
  /// the way to the backend and come back empty — reported as "Didn't catch
  /// that", which blames the speaking rather than the length. Caught here it is
  /// silent: nothing was said, so nothing is announced.
  static const minTake = Duration(milliseconds: 350);

  /// How long a notice stays on the row before it clears itself.
  ///
  /// These lines report something that has already finished — a take that came
  /// back empty, a send that did not land — and the row they sit in is the one
  /// that otherwise names the machine and what the mic is doing. Left up, a
  /// notice holds that space against the thing it is there for, long after the
  /// person has read it and moved on.
  ///
  /// Five seconds: long enough to read a sentence twice, short enough that the
  /// row is back to itself before the next take is spoken.
  static const noticeLinger = Duration(seconds: 5);

  final VoiceTranscriber transcriber;
  final VoiceRecorder _recorder;

  /// A code from `voiceLanguages`, read when a take is transcribed — so a language picked
  /// mid-take is the one that take is heard in.
  final ValueListenable<String> _language;

  VoiceInputStatus _status = VoiceInputStatus.idle;
  String _heard = '';
  String? _notice;
  bool _isSending = false;
  bool _disposed = false;
  Timer? _takeLimit;

  /// Clears [notice] once [noticeLinger] has passed — see [_restartNoticeTimer].
  Timer? _noticeLimit;

  /// Bumped by everything that abandons a take, so a recording or a
  /// transcription still in flight from it lands nowhere — above all after
  /// [clear], where words arriving late would bring back what was dropped.
  int _take = 0;

  bool get isSending => _isSending;
  VoiceInputStatus get status => _status;
  String get transcript => _heard;
  String? get notice => _notice;

  /// Nothing being recorded, heard or sent — the mic at rest. A refused
  /// microphone is at rest too: nothing is in flight.
  bool get isIdle =>
      (_status == VoiceInputStatus.idle ||
          _status == VoiceInputStatus.unavailable) &&
      _heard.isEmpty &&
      !_isSending;

  /// Drops the take in progress, the words held from a send that failed, and
  /// the notice. A send already on its way is not recalled.
  void clear() {
    if (_disposed) return;
    _abandonTake();
    _heard = '';
    _setStatus(VoiceInputStatus.idle);
  }

  Future<void> startListening() async {
    if (_isSending || _disposed) return;
    if (_status != VoiceInputStatus.idle &&
        _status != VoiceInputStatus.unavailable) {
      return;
    }
    final take = ++_take;
    _setStatus(VoiceInputStatus.starting);
    if (!await _micAllowed()) {
      if (take != _take) return;
      _setStatus(VoiceInputStatus.unavailable, notice: VoiceNotice.unavailable);
      return;
    }
    // Closed, cleared or stopped while the permission prompt was up.
    if (take != _take) return;
    try {
      await _recorder.start();
    } on Exception {
      if (take != _take) return;
      _setStatus(VoiceInputStatus.idle, notice: VoiceNotice.couldNotStart);
      return;
    }
    if (take != _take) {
      unawaited(_recorder.cancel());
      return;
    }
    _takeLimit = Timer(maxTake, () => unawaited(stopListening()));
    _setStatus(VoiceInputStatus.listening);
  }

  /// Ends the take and transcribes it.
  Future<void> stopListening() async {
    if (_status == VoiceInputStatus.starting) {
      _abandonTake();
      _setStatus(VoiceInputStatus.idle);
      return;
    }
    if (_status == VoiceInputStatus.listening) await _transcribeTake();
  }

  /// A push-to-talk hold has begun. Pairs with [finishHold].
  ///
  /// ⚠️ **Exists because a hold cannot be expressed as start-then-stop, and
  /// trying broke hold-to-talk outright.** [startListening] takes two awaits to
  /// reach [VoiceInputStatus.listening] — the permission check, then the
  /// microphone actually opening, which is hundreds of milliseconds of hardware
  /// on a real phone. A release landing inside that window found the status on
  /// `starting` and abandoned the take, while the `startListening` still in
  /// flight went on to open the microphone and set `listening` — a recording
  /// nobody was holding and nothing would stop, whose audio then joined the NEXT
  /// take. What came back was the tail of one sentence glued to the head of
  /// another, which transcribes to nothing and reads as "Didn't catch that".
  ///
  /// So the hold is a fact of its own, held here, and the release is applied to
  /// whatever state the start has reached by then — including a start that has
  /// not finished yet, which [_holdReleased] makes it check for itself.
  Future<void> startHold(Future<bool> Function(String text) deliver) async {
    _holdReleased = false;
    await startListening();
    // Let go while the microphone was still opening: the take that just became
    // live has no thumb on it, so it is ended and sent from here — the release
    // could not do it itself, because at that moment there was no take to end.
    if (_holdReleased && _status == VoiceInputStatus.listening) {
      _holdReleased = false;
      await submit(deliver);
    }
  }

  /// A push-to-talk hold has ended, and what was said should be sent.
  ///
  /// Returns at once when the microphone is still opening — [startHold] is
  /// mid-flight and owns the take, and this call has already recorded that the
  /// thumb is up, which is what makes it finish and send as soon as there is
  /// something to send.
  Future<void> finishHold(Future<bool> Function(String text) deliver) async {
    _holdReleased = true;
    if (_status == VoiceInputStatus.starting) return;
    _holdReleased = false;
    await submit(deliver);
  }

  /// Drops a push-to-talk take without sending it — the thumb slid off the
  /// button.
  ///
  /// ⚠️ Clears the flag as well, and that is not tidying: leaving it set would
  /// let a [startHold] still in flight reach its own send branch and deliver the
  /// very take this just threw away. [clear] bumps the take counter, so the
  /// recording itself is already abandoned; this closes the other half.
  void cancelHold() {
    _holdReleased = false;
    clear();
  }

  /// Whether the thumb has come up while a hold's [startListening] is still on
  /// its way to `listening`. See [startHold].
  bool _holdReleased = false;

  /// Sends everything heard, and empties the transcript once it is sent — kept
  /// when delivery fails, so nothing said has to be said twice.
  ///
  /// Send while still talking ends the take first: one tap finishes the
  /// sentence and sends it. A take that FAILED sends nothing, rather than the
  /// half of the message that was heard before it.
  ///
  /// ⚠️ A take too short to be speech is not a failure: nothing was said in it,
  /// so nothing is missing. That is the retry face held to talk — a quick tap
  /// on it has to send the words kept from the send that did not land, and it
  /// used to be dropped with the tap, leaving no way to send them but saying
  /// something new.
  Future<void> submit(Future<bool> Function(String text) deliver) async {
    if (_isSending || _status == VoiceInputStatus.transcribing) return;
    if (_status == VoiceInputStatus.listening &&
        await _transcribeTake() == _Take.failed) {
      return;
    }
    final text = transcript.trim();
    if (text.isEmpty || _isSending) return;
    _isSending = true;
    _setStatus(VoiceInputStatus.idle);
    var sent = false;
    try {
      sent = await deliver(text);
    } catch (error) {
      // Reported below exactly like a refusal: the words stay, Send stays live.
      // ⚠️ Every throwable, not only [Exception]: anything that escaped here
      // would leave [isSending] set, and the mic busy for the pager's life.
      // The type only: what failed to send is what someone said.
      appLog.warn('voice', 'send failed: ${error.runtimeType}');
    }
    _isSending = false;
    if (sent) _heard = '';
    _setStatus(
      VoiceInputStatus.idle,
      notice: sent ? null : VoiceNotice.notSent,
    );
  }

  /// Everything heard — the take still being recorded included, once it is
  /// transcribed — emptied out of here, for the keyboard to carry on from.
  ///
  /// Nothing while a send is on its way: those words are already the message,
  /// and handing them to the keyboard too would put them in the prompt twice.
  Future<String> takeTranscript() async {
    if (_isSending) return '';
    if (_status == VoiceInputStatus.listening) await _transcribeTake();
    final text = transcript;
    clear();
    return text;
  }

  @override
  void dispose() {
    _abandonTake();
    _noticeLimit?.cancel();
    _disposed = true;
    unawaited(_recorder.dispose());
    super.dispose();
  }

  /// Ends the take, and adds what it heard to the transcript.
  Future<_Take> _transcribeTake() async {
    final take = _take;
    _takeLimit?.cancel();
    _setStatus(VoiceInputStatus.transcribing);
    try {
      final recording = await _recorder.stop();
      if (take != _take) return _Take.failed;
      appLog.info(
        'voice',
        recording == null
            ? 'take: no audio captured'
            : 'take: ${recording.length.inMilliseconds}ms '
                  '${recording.wav.length}B peak=${recording.peak}',
      );
      // Too short to be speech — a brushed button. Silent on purpose: there is
      // no failure to report, and a notice would be the app talking back about
      // something the person did not mean to do.
      if (recording != null && recording.length < minTake) {
        _setStatus(VoiceInputStatus.idle);
        return _Take.tap;
      }
      if (recording == null || recording.peak < silencePeak) {
        _setStatus(VoiceInputStatus.idle, notice: VoiceNotice.noSound);
        return _Take.failed;
      }
      final language = _language.value;
      final words = await transcriber(recording.wav, language);
      // The count, never the words: a transcript is what someone said.
      appLog.info('voice', 'stt[$language]: ${words.length} chars');
      if (take != _take) return _Take.failed;
      _heard = _joinWords(_heard, words);
      _setStatus(
        VoiceInputStatus.idle,
        notice: words.isEmpty ? VoiceNotice.nothingHeard : null,
      );
      return words.isEmpty ? _Take.failed : _Take.heard;
    } catch (error) {
      // ⚠️ Every throwable, not only [Exception]: a reply of an unexpected shape
      // fails as a TypeError, and one that escaped would leave the status on
      // `transcribing` — the mic busy, for good, until the pager is closed.
      appLog.warn('voice', 'stt[${_language.value}] failed', error: error);
      if (take == _take) {
        _setStatus(VoiceInputStatus.idle, notice: VoiceNotice.notTranscribed);
      }
      return _Take.failed;
    }
  }

  Future<bool> _micAllowed() async {
    try {
      return await _recorder.allowed();
    } on Exception {
      return false;
    }
  }

  void _abandonTake() {
    _take++;
    _takeLimit?.cancel();
    if (_status == VoiceInputStatus.starting ||
        _status == VoiceInputStatus.listening) {
      unawaited(_recorder.cancel());
    }
  }

  void _setStatus(VoiceInputStatus status, {String? notice}) {
    _status = status;
    _notice = notice;
    _restartNoticeTimer();
    _notify();
  }

  /// Starts the countdown that clears [notice], or stops it when there is none.
  ///
  /// ⚠️ **Restarted on EVERY status change, not only on the ones that carry a
  /// notice.** A timer from a previous notice would otherwise still be running,
  /// and it would clear whatever notice happens to be showing when it fires —
  /// cutting a fresh one short by however long the old one had already been up.
  ///
  /// ⚠️ **[VoiceInputStatus.unavailable] keeps its notice indefinitely.** That
  /// one is not a report of something that just happened; it is the standing
  /// reason the mic cannot be used, and the row is the only place that says so.
  /// Everything else is transient and goes.
  void _restartNoticeTimer() {
    _noticeLimit?.cancel();
    _noticeLimit = null;
    if (_disposed ||
        _notice == null ||
        _status == VoiceInputStatus.unavailable) {
      return;
    }
    _noticeLimit = Timer(noticeLinger, () {
      _noticeLimit = null;
      // Only if it is still the same notice: anything that has set another one
      // since owns the row now, and has its own timer running for it.
      if (_notice == null || _disposed) return;
      _notice = null;
      _notify();
    });
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }
}

String _joinWords(String first, String second) =>
    [first.trim(), second.trim()].where((part) => part.isNotEmpty).join(' ');

/// How a take ended, as [VoiceInputController.submit] needs to know it.
enum _Take {
  /// Its words joined the transcript.
  heard,

  /// Too short to be speech — a tap, with nothing said and so nothing lost.
  tap,

  /// Something was meant and did not arrive: silence, nothing transcribed, an
  /// upload that failed, or a take abandoned mid-flight.
  failed,
}
