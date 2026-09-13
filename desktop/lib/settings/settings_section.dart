import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../logging/debug_surface.dart';

/// One screen in Settings — a row in its rail, and the pane that row opens.
///
/// Declared once, like [ShortcutAction] in `shortcuts/app_shortcuts.dart`: the
/// rail, the search filter and the pane all read this list, so a section cannot
/// be listed without a screen behind it or reachable without a row.
enum SettingsSection {
  account(LucideIcons.user300, 'Account'),
  appearance(LucideIcons.sun300, 'Appearance'),
  terminal(LucideIcons.terminal300, 'Terminal'),
  usage(LucideIcons.chartNoAxesColumn300, 'Usage'),
  devices(LucideIcons.zap300, 'Autonomous devices'),
  shortcuts(LucideIcons.keyboard300, 'Keyboard shortcuts'),
  debug(LucideIcons.bug300, 'Debug'),
  tracking(LucideIcons.activity300, 'Tracking'),
  about(LucideIcons.info300, 'About');

  const SettingsSection(this.icon, this.label);

  /// The rail glyph — Lucide's 300 weight, the one the machine rail's rows use,
  /// so the app's two nav columns draw at the same line weight.
  final IconData icon;
  final String label;
}

/// One labelled run of rows in the settings rail.
///
/// The grouping is presentation only — [settingsGroups] flattens back to every
/// section — but it says something true: the first run is what you *change*,
/// the second is what you *consult*.
class SettingsGroup {
  const SettingsGroup(this.title, this.sections);

  /// The caption over the run. A caption, not a sentence.
  final String title;
  final List<SettingsSection> sections;
}

/// What Settings lists, in order.
///
/// A getter rather than a `const`, for the rows that are not always there:
/// [SettingsSection.debug] and [SettingsSection.tracking] are developer
/// furniture and ship only where [kDebugSurfaceEnabled] says so. Everything
/// that draws or searches the rail reads this, so a hidden section cannot be
/// reached by a stale copy of the list — while the enum values themselves
/// always exist, so the screens behind them need no gate of their own.
List<SettingsGroup> get settingsGroups =>
    settingsGroupsFor(debugSurface: kDebugSurfaceEnabled);

/// [settingsGroups] with the gate passed in rather than read off the build.
///
/// The flag is a compile-time const, so the shape a SHIPPED build has — no
/// Debug, no Tracking — is otherwise unreachable from a test, which by
/// definition runs with it switched on. This seam is the only way to assert
/// the thing the gate exists to do.
@visibleForTesting
List<SettingsGroup> settingsGroupsFor({required bool debugSurface}) {
  bool visible(SettingsSection section) =>
      debugSurface || !_kDeveloperSections.contains(section);
  return [
    for (final group in _kSettingsGroups)
      if (group.sections.any(visible))
        SettingsGroup(group.title, [
          for (final section in group.sections)
            if (visible(section)) section,
        ]),
  ];
}

/// The two developer sections, named once. Both read the same in-memory
/// buffers, both are worth nothing in a build that cannot open them, and a
/// second list of "which ones are hidden" is how the two would drift apart.
const _kDeveloperSections = {SettingsSection.debug, SettingsSection.tracking};

const _kSettingsGroups = [
  // Usage sits with the preferences rather than with Debug and Tracking, which
  // it otherwise resembles: those two are developer furniture a shipped build
  // hides, and this is a screen anybody is meant to open. It earns its place in
  // a run titled "what you change" by carrying the three switches that decide
  // which logs are read at all — the pane is off until somebody sets it.
  SettingsGroup('Preferences', [
    SettingsSection.appearance,
    SettingsSection.terminal,
    SettingsSection.usage,
    SettingsSection.devices,
    SettingsSection.account,
  ]),
  // Debug and Tracking sit between the two things they are most often reached
  // from: the keys that open them, and the version a report has to name. The
  // two are adjacent because they answer the same question from opposite ends
  // — what this app asked for, and what it reported about being asked.
  SettingsGroup('Help', [
    SettingsSection.shortcuts,
    SettingsSection.debug,
    SettingsSection.tracking,
    SettingsSection.about,
  ]),
];

/// The section Settings opens on — the first row of the first group, so the
/// screen never opens on a pane its rail doesn't show as selected.
///
/// Derived rather than named, so a reordered or gated first group cannot open
/// Settings on a pane with no row lit in the rail beside it.
SettingsSection get kDefaultSettingsSection =>
    settingsGroups.first.sections.first;
