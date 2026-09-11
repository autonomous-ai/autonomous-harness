import '../shared/theme/appearance_prefs_store.dart';
import '../stats/harness_stats.dart';
import '../terminal/terminal_font_store.dart';

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
  AppearancePrefsStore? appearance,
  HarnessStats? stats,
}) async {
  await (terminalFont ?? terminalFontStore).load();
  // Not optional. Every control box in the app is sized from
  // `AppControl.heightScaled`/`paddingScaled`, so a UI size that arrived after
  // the first frame would relayout the whole window one frame in — a worse
  // flicker than a late theme, because the geometry moves and not just the ink.
  await (appearance ?? appearancePrefsStore).load();
  // Not for the first frame — nothing paints these counters until Settings ▸
  // Usage is opened. It is loaded here anyway because the counters START moving
  // as soon as an agent does, and a load that landed after the first
  // `onAgentSpawned` would overwrite it with the number from disk.
  await (stats ?? harnessStats).load();
}
