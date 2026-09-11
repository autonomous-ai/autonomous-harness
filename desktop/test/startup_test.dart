import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_file_store.dart';
import 'package:harness/core/startup.dart';
import 'package:harness/terminal/terminal_font_store.dart';

void main() {
  late Directory dir;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('harness-startup-');
  });

  tearDown(() async {
    if (dir.existsSync()) await dir.delete(recursive: true);
  });

  test(
    'a relaunch restores every preference the first frame depends on',
    () async {
      // A previous run, writing through the real store rather than a fake: this is the one test that
      // covers the on-disk FORMAT as well as the logic, so a change to how values are serialized
      // cannot pass here while breaking real launches.
      final previousRun = HarnessFileStore(directory: dir);
      // One instance for both edits, as the app has: a second store would not know about the family
      // the first one set, and would write the default back over it.
      final previousFont = TerminalFontStore(storage: previousRun);
      await previousFont.setFamily(TerminalFontChoice.menlo);
      await previousFont.setSize(17);

      // The next launch: a brand-new store over the same directory, loaded the way main() loads it.
      final terminalFont = TerminalFontStore(
        storage: HarnessFileStore(directory: dir),
      );
      await loadPersistedSettings(terminalFont: terminalFont);

      expect(terminalFont.family, TerminalFontChoice.menlo);
      expect(terminalFont.size, 17.0);
    },
  );

  test(
    'a first-ever launch lands on the defaults instead of throwing',
    () async {
      // Nothing written yet — the directory exists and holds no state file at all.
      final terminalFont = TerminalFontStore(
        storage: HarnessFileStore(directory: dir),
      );
      await loadPersistedSettings(terminalFont: terminalFont);

      // Per platform since the Linux work — not a fixed face this repo picked.
      expect(terminalFont.family, TerminalFontChoice.defaultForPlatform);
    },
  );
}
