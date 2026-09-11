// Debug and Tracking are developer furniture, so a shipped build hides them. The flag behind that
// is a compile-time const and a test run has it ON — which is the whole difficulty, since the
// shape worth guarding is the one no test build has. `settingsGroupsFor` takes the gate as an
// argument for exactly this.
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/logging/debug_surface.dart';
import 'package:harness/settings/settings_section.dart';

void main() {
  List<SettingsSection> sectionsOf(List<SettingsGroup> groups) => [
    for (final group in groups) ...group.sections,
  ];

  test('a test build lists the developer sections', () {
    expect(kDebugSurfaceEnabled, isTrue, reason: 'tests run in debug mode');
    expect(
      sectionsOf(settingsGroups),
      containsAll([SettingsSection.debug, SettingsSection.tracking]),
    );
  });

  test('Settings opens on a row the rail actually shows', () {
    expect(sectionsOf(settingsGroups), contains(kDefaultSettingsSection));
    final shipped = settingsGroupsFor(debugSurface: false);
    expect(shipped.first.sections.first, SettingsSection.appearance);
  });

  test('everything outside the gate is always listed', () {
    expect(sectionsOf(settingsGroupsFor(debugSurface: false)), [
      SettingsSection.appearance,
      SettingsSection.terminal,
      // Usage carries no gate of its own: it reads only this machine's own
      // files, and it reads nothing at all until a provider is switched on, so
      // there is nothing here for a shipped build to hide.
      SettingsSection.usage,
      SettingsSection.devices,
      SettingsSection.shortcuts,
      SettingsSection.about,
    ]);
  });
}
