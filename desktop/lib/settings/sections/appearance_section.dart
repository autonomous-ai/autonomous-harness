import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/section_scaffold.dart';
import '../appearance/typography_section.dart';

/// Settings ▸ Appearance: how the app looks on this Mac.
///
/// ⚠️ The APP, not the terminal. Everything on this screen stops at the edge of
/// a terminal pane: the pane renders a grid a remote program is drawing into, so
/// it carries its own face and size in Settings ▸ Terminal, and the UI scale is
/// held out of it at five separate seams — see `terminal_panel.dart`,
/// `terminal_composer.dart`, `engine_identity.dart` and `terminal_section.dart`,
/// with `test/terminal_ui_scale_isolation_test.dart` standing guard.
class AppearanceSection extends StatelessWidget {
  const AppearanceSection({super.key});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return SectionScaffold(
      title: 'Appearance',
      subtitle: 'How Harness looks on this Mac. Harness Desktop is dark-only.',
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: const [
            TypographySection(),
            // Room under the last card so a scrolled-to-bottom pane does not end
            // flush against the window edge.
            SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}
