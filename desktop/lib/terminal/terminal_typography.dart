import 'dart:io' show Platform;

/// The default terminal face, per platform.
///
/// Every family named here has to actually resolve on the OS it is named for,
/// and a *monospace* one: the renderer measures one cell by laying out ten `m`
/// glyphs and dividing by ten (`TerminalPainter._measureCharSize`), so a
/// proportional substitute misaligns every column a TUI draws.
///
/// Asking for a face the system does not have is not a loud failure. Measured
/// on Ubuntu 26.04 with a real Linux build (`TextPainter`, 13px, advance width
/// of `m` vs `i` — equal means monospace):
///
/// ```text
/// DejaVu Sans Mono                m=7.83  i=7.83   ← monospace
/// Ubuntu Sans Mono                m=7.28  i=7.28   ← monospace
/// Liberation Mono                 m=7.80  i=7.80   ← monospace
/// .AppleSystemUIFontMonospaced    m=11.22 i=3.16   ← PROPORTIONAL
/// Menlo                           m=11.22 i=3.16   ← PROPORTIONAL
/// monospace  (the generic)        m=11.22 i=3.16   ← PROPORTIONAL
/// NoSuchFamilyXYZ                 m=11.22 i=3.16   ← the engine's own default
/// ```
///
/// Two things follow. The old macOS-only stack rendered the terminal in a
/// proportional face on Linux, at 3.5× the width for `m` over `i` — that is the
/// broken grid. And **the trailing `'monospace'` is inert**: Flutter resolves
/// families through Skia, which does not honour fontconfig's generic aliases,
/// so it measures exactly like a family that does not exist. It stays in the
/// lists as a last resort for other engines, but it is not a safety net — every
/// chain has to name a real face it can reach. On Linux that anchor is DejaVu
/// Sans Mono, the only monospace `ubuntu-desktop-minimal` depends on.
///
/// The live, user-chosen typography lives in `terminalFontStore`, not here;
/// these are what a fresh install opens with and what `reset()` returns to.

/// SF Mono's CoreText family name.
///
/// Flutter does not reliably resolve the human-facing `SF Mono` name on macOS;
/// this is the system alias that CoreText resolves to Apple's monospaced face.
const macTerminalFontFamily = '.AppleSystemUIFontMonospaced';

const macTerminalFontFallback = <String>[
  'Menlo',
  'Monaco',
  'Courier New',
  'monospace',
];

/// DejaVu Sans Mono, and why it leads on Linux.
///
/// It is the only monospace `ubuntu-desktop-minimal` *depends* on — the Ubuntu
/// and Noto mono packages are recommendations, which an install can decline —
/// and the only one of them carrying `✔ ✗ ● ╭ ▏`, the glyphs an agent's TUI
/// draws. That matters more than it sounds: a glyph missing from the primary
/// face is fetched from a fallback at a different advance width, and the grid
/// goes ragged in exactly the places a coding agent puts its output.
const linuxTerminalFontFamily = 'DejaVu Sans Mono';

const linuxTerminalFontFallback = <String>[
  'Ubuntu Sans Mono',
  'Noto Sans Mono',
  'Liberation Mono',
  'monospace',
];

/// The default face for the platform this build is running on.
///
/// A getter, not a `const`: the answer depends on the host. The per-platform
/// constants above stay `const` so `TerminalFontChoice` can still name them
/// from its const constructor.
String get terminalFontFamily =>
    Platform.isMacOS ? macTerminalFontFamily : linuxTerminalFontFamily;

List<String> get terminalFontFallback =>
    Platform.isMacOS ? macTerminalFontFallback : linuxTerminalFontFallback;

/// The default terminal font size — the same on every platform.
const terminalFontSize = 13.0;
