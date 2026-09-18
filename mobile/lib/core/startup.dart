import '../logging/startup_trace.dart';
import '../phone/voice_language_store.dart';
import '../shared/theme/appearance_prefs_store.dart';
import '../stats/harness_stats.dart';
import '../terminal/terminal_font_store.dart';
import '../terminal/terminal_theme_store.dart';

/// Every preference that has to be in place BEFORE the first frame.
///
/// Extracted from `main()` so it can be tested. A store that is never loaded still passes every one
/// of its own tests — it round-trips through disk perfectly — and silently forgets the user's
/// choice at the next launch. Nothing else in the suite would notice, because the only thing wrong
/// is a missing call in the entrypoint. This is that call, in a place a test can reach.
///
/// They are awaited before `runApp` rather than loaded lazily: reading them after the first frame
/// would paint the defaults and then snap to the saved values, which reads as a flicker on every
/// launch.
///
/// The parameters exist for tests; the app passes nothing and gets the singletons the widgets read.
Future<void> loadPersistedSettings({
  TerminalFontStore? terminalFont,
  TerminalThemeStore? terminalTheme,
  AppearancePrefsStore? appearance,
  HarnessStats? stats,
  VoiceLanguageStore? voiceLanguage,
}) async {
  // Independent stores may load together, but all must finish before runApp.
  // Font and appearance share a serialized file store; each reads its related
  // preferences as one snapshot. Stats uses a separate file and can overlap.
  //
  // ⚠️ **"Together" is the intent, not the outcome, for four of these five.**
  // Every store but `stats` is backed by [HarnessFileStore], which serializes
  // ALL of its operations behind one process-wide queue and one exclusive file
  // lock (`core/harness_file_store.dart`) — so this `Future.wait` starts four
  // reads that then stand in a line, each taking the lock and re-parsing the
  // whole of `state.json`. Timing them individually is what makes that visible
  // in the log: four spans that start together and end one after another are a
  // queue, not parallelism.
  await Future.wait([
    StartupTrace.time(
      'prefs.terminalFont',
      (terminalFont ?? terminalFontStore).load,
    ),
    // Beside the font, and for the same reason: loading the scheme after the
    // first frame paints every pane on the default ground and then snaps it to
    // the saved one, which reads as a flash of the wrong colour at every launch.
    StartupTrace.time(
      'prefs.terminalTheme',
      (terminalTheme ?? terminalThemeStore).load,
    ),
    // Every control box uses these values. A late load would move the whole
    // window's geometry after its first frame, as well as changing its palette.
    StartupTrace.time(
      'prefs.appearance',
      (appearance ?? appearancePrefsStore).load,
    ),
    // Counters begin moving with the first agent event. Loading them later
    // could overwrite a new event with the old count from disk.
    StartupTrace.time('prefs.stats', (stats ?? harnessStats).load),
    // The language the mic transcribes in. Read late, a first take could be sent to the backend
    // in the phone's language by somebody who chose another.
    StartupTrace.time(
      'prefs.voiceLanguage',
      (voiceLanguage ?? voiceLanguageStore).load,
    ),
  ]);
}
