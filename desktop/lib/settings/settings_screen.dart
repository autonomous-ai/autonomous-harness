import 'package:flutter/material.dart';

import '../analytics/analytics.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/window_chrome.dart';
import 'sections/about_section.dart';
import 'sections/appearance_section.dart';
import 'sections/debug_section.dart';
import 'sections/devices_section.dart';
import 'sections/shortcuts_section.dart';
import 'sections/terminal_section.dart';
import 'sections/tracking_section.dart';
import 'sections/usage_section.dart';
import 'settings_nav.dart';
import 'settings_section.dart';

/// Opens Settings over the app.
///
/// A screen, not a dialog: the sections outgrew a 360px box the moment there
/// was more than one of them, and a settings *place* is what every desktop app
/// this one sits beside offers. It takes the whole window because none of this
/// is daily work, so it does not belong in the rail you drive terminals from.
///
/// Pushed as a route rather than switched into the shell: [AppNotifier] carries
/// no notion of "which screen", and a route needs none — the way back is
/// [Navigator.pop], and the shell underneath keeps its panes attached and its
/// terminals streaming while this is up.
Future<void> showSettingsScreen(
  BuildContext context,
  AppNotifier notifier, {
  SettingsSection? initialSection,
  // Which door opened Settings — see [AnalyticsEvents.screenView]. `required`,
  // because a pane reachable several ways is close to meaningless as a bare
  // count.
  required String source,
}) {
  return Navigator.of(context).push<void>(
    PageRouteBuilder<void>(
      // Opaque: it covers the window, and letting the shell show through would
      // mean compositing four live terminals under it for nothing.
      pageBuilder: (context, animation, _) => SettingsScreen(
        notifier: notifier,
        initialSection: initialSection,
        source: source,
      ),
      transitionsBuilder: (context, animation, _, child) =>
          FadeTransition(opacity: animation, child: child),
      // A cross-fade, not a slide. A screen that slides in from the right reads
      // as a phone pushing a detail view; Settings arriving in place reads as
      // the window changing what it is showing.
      transitionDuration: const Duration(milliseconds: 170),
      reverseTransitionDuration: const Duration(milliseconds: 120),
    ),
  );
}

/// Settings: pick on the left, work on the right.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    super.key,
    required this.notifier,
    this.initialSection,
    this.source = 'unknown',
  });

  final AppNotifier notifier;

  /// The door that opened this screen, reported with the first `screen_view`.
  /// Defaulted only for tests that build the screen directly; every app door
  /// goes through [showSettingsScreen], where it is `required`.
  final String source;

  /// Which row Settings opens on. Null takes [kDefaultSettingsSection] — the
  /// first row of the first group, so the screen never opens on a pane its rail
  /// does not show as selected.
  final SettingsSection? initialSection;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late SettingsSection _section =
      widget.initialSection ?? kDefaultSettingsSection;

  @override
  void initState() {
    super.initState();
    // The pane Settings opens on is a screen view like any other — without it
    // the section a user lands on is the one section the stream never sees.
    // This one carries the door that OPENED Settings; every later view in this
    // visit came from the rail.
    analytics.screenView(_screenName(_section), source: widget.source);
  }

  /// Move to another pane, from the settings rail.
  void _show(SettingsSection target) {
    if (target == _section) return;
    analytics.screenView(_screenName(target), source: 'rail');
    setState(() => _section = target);
  }

  /// The section's stable name, never its label: labels are rewritten and a
  /// renamed label would read as a new screen. `SettingsSection.usage` becomes
  /// `settings_usage`, so a settings pane cannot collide with a top-level screen
  /// that happens to share a word.
  static String _screenName(SettingsSection section) =>
      'settings_${section.name}';

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // Row-first, so the nav rail owns the window's full height and its fill
    // runs from y=0 — under the macOS traffic lights included. A header across
    // the top would have to carry the rail's fill over the pane as well, which
    // is what leaves the top of a window reading as a separate, lighter band.
    return Scaffold(
      backgroundColor: grid.AppPalette.windowBg,
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SettingsNav(section: _section, onSelect: _show),
          VerticalDivider(width: 1, color: grid.AppPalette.divider),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // The pane needs the traffic lights' clearance and somewhere to
                // grab the window, but no fill of its own — it sits on the
                // window. The rail draws its own.
                const WindowDragStrip(),
                Expanded(
                  child: _SettingsBody(
                    section: _section,
                    notifier: widget.notifier,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The screen behind a [SettingsSection].
///
/// Cross-fades rather than cuts: the rail's own row highlight animates, and a
/// pane that appears the instant you click reads as a jolt beside it.
class _SettingsBody extends StatelessWidget {
  const _SettingsBody({required this.section, required this.notifier});

  final SettingsSection section;
  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    final screen = switch (section) {
      SettingsSection.appearance => const AppearanceSection(),
      SettingsSection.terminal => const TerminalSection(),
      SettingsSection.usage => const UsageSection(),
      SettingsSection.devices => const DevicesSection(),
      SettingsSection.shortcuts => const ShortcutsSection(),
      SettingsSection.debug => const DebugSection(),
      SettingsSection.tracking => const TrackingSection(),
      SettingsSection.about => AboutSection(notifier: notifier),
    };
    return AnimatedSwitcher(
      // The exit is the shorter half — waiting on it is what makes a cross-fade
      // feel sluggish.
      duration: const Duration(milliseconds: 200),
      reverseDuration: const Duration(milliseconds: 90),
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeIn,
      // Keyed by section, not by widget type: that is what tells the switcher a
      // *different screen* arrived.
      child: KeyedSubtree(key: ValueKey(section), child: screen),
    );
  }
}
