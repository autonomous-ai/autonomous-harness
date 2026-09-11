import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Load a real font.
///
/// Widget tests draw with Ahem, whose every glyph is a fixed square — a 24
/// character label measures 276px where Arial measures ~140. That is not a
/// small distortion for a surface whose whole job is fitting figures beside
/// names: with Ahem the rail's node panel overflows by 19px, and a node card
/// laid out in it is a picture of a bug that does not exist.
///
/// Shared because the node dashboard hit the same wall the rail's panels did,
/// and two copies of this is two chances for one of them to stop loading the
/// mono face and start "finding" overflows again.
///
/// The Linux faces are **Liberation**, not merely "some sans, some mono":
/// Liberation Sans and Liberation Mono are metric-compatible with Arial and
/// Courier New, glyph advance for glyph advance. These tests assert that
/// nothing overflows, so a face with different advances would move the
/// threshold and let the same layout pass on one CI host and fail on another.
/// `.github/workflows/ci.yml` installs `fonts-liberation` for exactly this.
Future<void> loadRealFonts() async {
  Future<ByteData> bytes(File file) async =>
      ByteData.view(Uint8List.fromList(await file.readAsBytes()).buffer);

  // Register under every family these surfaces can resolve to on EITHER host —
  // the app's own `.AppleSystemUIFont`/`Ubuntu Sans`, and Roboto, which is what
  // an unthemed widget falls back to in a test. Registering both platforms'
  // names rather than branching keeps this helper one code path: a family the
  // running host never asks for costs a no-op registration.
  final sans = await bytes(
    _firstExisting('sans', const [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
      '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
    ]),
  );
  for (final family in [
    '.AppleSystemUIFont',
    'SF Pro Text',
    'Ubuntu Sans',
    'Roboto',
  ]) {
    await (FontLoader(family)..addFont(Future.value(sans))).load();
  }

  // A model id is set in mono, and an unregistered mono family falls back to
  // Ahem just as loudly.
  final mono = await bytes(
    _firstExisting('mono', const [
      '/System/Library/Fonts/Supplemental/Courier New.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
      '/usr/share/fonts/liberation/LiberationMono-Regular.ttf',
    ]),
  );
  for (final family in [
    '.AppleSystemUIFontMonospaced',
    'SF Mono',
    'Menlo',
    'DejaVu Sans Mono',
  ]) {
    await (FontLoader(family)..addFont(Future.value(mono))).load();
  }
}

/// The first candidate that is actually on this host.
///
/// Throws rather than falling through to Ahem: a silent fallback is how these
/// tests would go on passing while measuring a font nothing ships, which is the
/// exact failure this helper exists to prevent. The message names every path it
/// tried, because "font not found" on a CI host you cannot open a shell into is
/// otherwise a guessing game.
File _firstExisting(String role, List<String> candidates) {
  for (final path in candidates) {
    final file = File(path);
    if (file.existsSync()) return file;
  }
  throw StateError(
    'no $role font on this host. Looked at:\n'
    '${candidates.map((p) => '  $p').join('\n')}\n'
    'On Debian/Ubuntu: sudo apt-get install fonts-liberation',
  );
}
