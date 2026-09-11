import 'dart:io' show Platform;
import 'dart:ui' show Size;

import 'package:window_manager/window_manager.dart';

/// Puts the window into the same shape Grid's uses, before the first frame.
///
/// On macOS the title bar is hidden and the traffic lights float over the
/// rail, which leaves room for them (see `railTopInset` in
/// `widgets/window_chrome.dart`) and doubles as the drag handle. Windows and
/// Linux keep their native caption bar: they draw no controls over a hidden
/// one, so hiding it would leave a window with no close button.
///
/// The sizes are Grid's too, so the two apps open to the same frame on a desk
/// where both are running.
Future<void> configureDesktopWindow() async {
  await windowManager.ensureInitialized();
  final options = WindowOptions(
    size: const Size(1280, 800),
    minimumSize: const Size(880, 560),
    title: 'Harness',
    center: true,
    titleBarStyle: Platform.isMacOS
        ? TitleBarStyle.hidden
        : TitleBarStyle.normal,
  );
  await windowManager.waitUntilReadyToShow(options, () async {
    await windowManager.show();
    await windowManager.focus();
  });
}

/// Bring the window to the front, wherever it was.
///
/// For work that STARTS somewhere else. Speaking into the dial opens the task palette here, and a
/// palette behind another app — or on a window the person minimised an hour ago — is a question nobody
/// is being asked: the dial shows its sending overlay, the words go nowhere, and the only clue is on a
/// screen that never came forward.
///
/// [windowManager.show] alone is not enough on macOS: a minimised or hidden window needs it, a
/// backgrounded one needs the focus call, and which of the two applies is not knowable from here — so
/// both run, in that order. Failures are swallowed on purpose: the plugin throws on a platform without a
/// window server (a headless test host), and losing the palette is worse than losing the raise.
Future<void> revealWindow() async {
  try {
    if (await windowManager.isMinimized()) await windowManager.restore();
    await windowManager.show();
    await windowManager.focus();
  } catch (_) {
    // No window server, or a platform that will not raise on demand. The palette still opens.
  }
}
