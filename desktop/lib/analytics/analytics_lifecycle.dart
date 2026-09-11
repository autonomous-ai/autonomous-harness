import 'dart:ui' show AppExitResponse;

import 'package:flutter/widgets.dart';

import '../stats/harness_stats.dart';
import 'analytics.dart';

/// Closes the launch out: `app_closed`, then a time-boxed drain of whatever is
/// still queued. Renders [child] unchanged.
///
/// Only `didRequestAppExit` is hooked, which covers ⌘Q, the app menu's Quit and
/// an OS log-out. Grid also intercepts the window's close button, but that
/// needs `windowManager.setPreventClose(true)` and a matching `destroy()` call
/// — and a bug on that path leaves a window the user cannot close. A missing
/// `app_closed` is worth less than that risk, so this app takes the exit hook
/// alone; `app_opened` is unaffected either way.
///
/// The matching `app_opened` is NOT here. It is sent by `AppNotifier` when
/// bootstrap resolves, because `signed_in` is not known until the CLI has been
/// asked, and a first-frame event would report every launch as signed out.
class AnalyticsLifecycle extends StatefulWidget {
  const AnalyticsLifecycle({super.key, required this.child});

  final Widget child;

  @override
  State<AnalyticsLifecycle> createState() => _AnalyticsLifecycleState();
}

class _AnalyticsLifecycleState extends State<AnalyticsLifecycle>
    with WidgetsBindingObserver {
  /// When this launch started, so the quit event can say how long the app was
  /// open.
  final DateTime _openedAt = DateTime.now();

  /// Guards against a quit that somehow asks twice.
  bool _closed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Future<AppExitResponse> didRequestAppExit() async {
    if (!_closed) {
      _closed = true;
      analytics.appClosed(open: DateTime.now().difference(_openedAt));
      // Before the drain below, and awaited: this is a local file write that
      // finishes in milliseconds, and it is the ONLY place a turn still running
      // at quit gets its time counted — the debounce timer is cancelled by the
      // process exiting, not fired by it.
      await harnessStats.flush();
      // Time-boxed inside `close` itself — a wedged network must never be what
      // keeps the window on screen after the user pressed ⌘Q.
      await analytics.close();
    }
    return AppExitResponse.exit;
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
