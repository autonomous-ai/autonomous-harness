import 'package:flutter/foundation.dart';

/// Whether this build shows its developer surfaces: Settings ▸ Debug and its
/// ⌘D shortcut, Settings ▸ Tracking, and the two in-memory buffers that feed
/// them (`logStream`, `analyticsLog`).
///
/// A debug build has it; a release build does not. The log *files* are written
/// either way — a shipped app that has no stderr anyone reads is exactly the
/// one whose logs matter (see `logging/app_log.dart`) — but the screen that
/// reads them back is developer furniture, and the ring buffer behind it is
/// memory a user's session should not spend.
///
/// `HARNESS_DEBUG_SURFACE=true` turns it on in a release build, for the one
/// case that is otherwise unreachable: reproducing a fault on a packaged app,
/// where a debug build's timing is not the timing being complained about.
const bool kDebugSurfaceEnabled =
    kDebugMode || bool.fromEnvironment('HARNESS_DEBUG_SURFACE');
