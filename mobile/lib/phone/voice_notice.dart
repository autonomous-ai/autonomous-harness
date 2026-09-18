/// The one line voice input shows when it cannot do what was asked.
abstract final class VoiceNotice {
  static const unavailable =
      'Voice input is off. Allow OpenHarness the microphone in Settings, or use the keyboard.';

  static const couldNotStart =
      "The microphone couldn't start. Tap the mic to try again.";

  static const nothingHeard = "Didn't catch that. Tap the mic to try again.";

  /// The microphone opened but delivered silence — a muted input, or a
  /// simulator the Mac has not given its microphone to. Speaking again will not
  /// help, so the notice does not suggest it.
  static const noSound =
      'No sound reached the microphone. Check the input OpenHarness is using.';

  static const notTranscribed =
      "Couldn't turn that into text. Tap the mic to try again.";

  static const notSent =
      "Not sent — this terminal isn't taking input right now.";
}
