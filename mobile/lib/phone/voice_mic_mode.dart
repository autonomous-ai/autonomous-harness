/// How the mic is worked: tap it twice, or hold it down.
///
/// Two shapes for the same act, kept side by side behind [voiceMicMode] so the
/// choice can be changed back without rebuilding anything around it. Every
/// difference between them is decided from this enum — the gesture the button
/// listens for, the faces it can show, and what a release does — and nothing
/// else in the app branches on it.
enum VoiceMicMode {
  /// Tap to start talking, tap again when done — the words are written into the
  /// terminal's prompt, unsent — and tap a third time to send them. `×` beside
  /// the mic calls the take off, or takes the words back out of the prompt.
  /// The button holds the recording open with nothing held down, so a long
  /// sentence costs no thumb, and nothing is sent before it has been read.
  ///
  /// Long-press stays the language shortcut here, because nothing else wants it.
  tapToToggle,

  /// Hold to talk, release to send. Push-to-talk: the recording lives exactly as
  /// long as the thumb is down, and letting go sends what was said.
  ///
  /// Sliding off the button before letting go throws the take away instead —
  /// the gesture every phone messenger uses, and the only way out of a take
  /// begun by accident.
  ///
  /// ⚠️ The language shortcut is GONE in this mode: the gesture it used is the
  /// gesture that now records. Settings ▸ Voice language is the way to it.
  holdToTalk,
}

/// Which of the two the app is built with.
///
/// ⚠️ **A compile-time constant on purpose, not a setting.** This is here to
/// make the second shape easy to try, not to ask the person which one they
/// want — a preference would mean a Settings row, a stored value, and two
/// behaviours live at once in a button whose whole job is to be unambiguous
/// under the thumb. Change this line, rebuild, and the app is the other app.
const VoiceMicMode voiceMicMode = VoiceMicMode.tapToToggle;

/// Whether the mic records only while held down.
bool get micHoldsToTalk => voiceMicMode == VoiceMicMode.holdToTalk;
