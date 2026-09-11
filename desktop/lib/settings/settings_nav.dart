import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/layouts/widgets/rail_section_header.dart';
import '../shared/layouts/widgets/sidebar_item.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/window_chrome.dart';
import 'settings_section.dart';

/// The settings list: the way back, a field that narrows the list to what you
/// type, then one row per screen with the open one highlighted.
class SettingsNav extends StatefulWidget {
  const SettingsNav({super.key, required this.section, required this.onSelect});

  final SettingsSection section;
  final ValueChanged<SettingsSection> onSelect;

  /// The machine rail's own default width, so Settings opens without the left
  /// column jumping.
  static const double width = 260;

  @override
  State<SettingsNav> createState() => _SettingsNavState();
}

class _SettingsNavState extends State<SettingsNav> {
  String _query = '';

  /// The groups, narrowed to the query. Matching is a plain case-insensitive
  /// substring of the label — this list is four rows, so anything cleverer
  /// would be machinery no one can feel. A group's own title matches too, so
  /// typing "help" surfaces the whole run rather than nothing.
  List<SettingsGroup> get _visible {
    final query = _query.trim().toLowerCase();
    // The list this build actually has: [settingsGroups] drops the developer
    // rows a release build does not ship.
    final all = settingsGroups;
    if (query.isEmpty) return all;
    final groups = <SettingsGroup>[];
    for (final group in all) {
      if (group.title.toLowerCase().contains(query)) {
        groups.add(group);
        continue;
      }
      final rows = [
        for (final target in group.sections)
          if (target.label.toLowerCase().contains(query)) target,
      ];
      if (rows.isNotEmpty) groups.add(SettingsGroup(group.title, rows));
    }
    return groups;
  }

  @override
  Widget build(BuildContext context) {
    // The rail owns its fill and spans the window's full height, so the fill
    // runs under the traffic lights too — head and column read as one surface
    // rather than two shades.
    grid.AppTheme.watch(context);
    return Container(
      width: SettingsNav.width,
      color: grid.AppSurface.recess,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Clearance for the traffic lights, and the rail's share of the
            // window drag handle.
            const WindowDragStrip(),
            const SizedBox(height: 6),
            // A SidebarItem like the rows below, so the way out hovers,
            // highlights and aligns exactly like them instead of being a
            // shrink-wrapped button in its own grey.
            SidebarItem(
              icon: LucideIcons.arrowLeft300,
              label: 'Back to app',
              onTap: () => Navigator.of(context).maybePop(),
            ),
            const SizedBox(height: 8),
            _SearchField(onChanged: (value) => setState(() => _query = value)),
            const SizedBox(height: 2),
            Expanded(child: _navList()),
          ],
        ),
      ),
    );
  }

  Widget _navList() {
    final visible = _visible;
    if (visible.isEmpty) return const _NoMatches();
    return ListView(
      padding: const EdgeInsets.only(bottom: 10),
      children: [
        for (final group in visible) ...[
          RailSectionHeader(label: group.title),
          for (final target in group.sections)
            SidebarItem(
              icon: target.icon,
              label: target.label,
              selected: target == widget.section,
              onTap: () => widget.onSelect(target),
            ),
        ],
      ],
    );
  }
}

/// The rail's filter, styled like the machine rail's own — the app has one
/// shape for "narrow this list".
class _SearchField extends StatelessWidget {
  const _SearchField({required this.onChanged});

  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // Same as the rail's filter field: sized and filled by the theme at
    // AppControl.heightField (36) rather than clamped to a button's 32.
    return TextField(
      // Keyed because the Appearance pane now carries fields of its own, so a
      // test reaching for "the" TextField would find three.
      key: const Key('settings-search-field'),
      onChanged: onChanged,
      style: grid.kFieldTextStyle,
      decoration: InputDecoration(
        hintText: 'search settings',
        prefixIcon: Icon(
          LucideIcons.search300,
          size: grid.kFieldIconSize,
          color: grid.AppPalette.textFaint,
        ),
      ),
    );
  }
}

/// What the rail shows when the query matches nothing — so a typo reads as "no
/// results" rather than a rail that mysteriously emptied.
class _NoMatches extends StatelessWidget {
  const _NoMatches();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 16, 10, 0),
      child: Text(
        'No settings match',
        style: TextStyle(color: grid.AppPalette.textFaint, fontSize: 12.5),
      ),
    );
  }
}
