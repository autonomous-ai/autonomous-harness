import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'phone_status.dart';
import 'status_pill.dart';

/// The terminal page's own header: whose terminal this is, in two lines, with
/// the page's controls at the right end.
///
/// ```
/// [mark●]  agent-3 · MacBooks-MacBook-Pro-6            ⋯
///          ~/…/autonomous-harness  ⑂ main
/// ```
///
/// ⚠️ **The connection state is the dot on the engine mark, not a word.** It
/// rides the mark's bottom-right corner the way presence sits on an avatar in a
/// messenger: green while live, a spinner while attaching, the warning or error
/// colour when the stream is taken over or drops. The label is still there for
/// a screen reader and as the long-press tooltip — see [StatusDot].
///
/// ⚠️ **Search and New agent are not here.** They float over the terminal's
/// bottom-right corner with the mic — see `terminal_action_column.dart` — so
/// this row is identity plus `⋯`, and nothing competes with the names for width.
///
/// ⚠️ **It leaves on a scroll, and `⋯` carries on without it.** The page slides
/// this row away as the terminal is scrolled forward, and `⋯` flies out of it to
/// become a floating button at the top-right — see `terminal_header_floats.dart`.
/// Nothing here knows about that; the row is either laid out or it is not.
class TerminalHeader extends StatelessWidget {
  const TerminalHeader({
    super.key,
    required this.agent,
    required this.machineName,
    required this.status,
    this.trailing = const [],
  });

  /// The agent this terminal belongs to. Null while it is still loading.
  final Agent? agent;

  /// The machine's name. Empty leaves it out.
  final String machineName;

  /// The session's state, drawn as the dot on the engine mark.
  final PhoneSummary status;

  /// The page's controls, right of the names: `⋯`, and the reclaim button when
  /// the stream is read-only.
  final List<Widget> trailing;

  /// The row's height, not counting its insets.
  ///
  /// Two lines of type: 15pt names over 12.5pt folder, with the engine mark
  /// centred against the pair.
  static const double rowHeight = 40;

  static const double sideInset = 14;
  static const double topInset = 6;
  static const double bottomInset = 8;

  /// The whole header, insets and divider included — what floats over the
  /// terminal's top rows while it is shown.
  static const double height = topInset + rowHeight + bottomInset + 1;

  /// The engine mark's size. Big enough to carry the status dot on its corner
  /// without the dot hiding it.
  static const double markSize = 28;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final agent = this.agent;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        sideInset,
        topInset,
        sideInset,
        bottomInset,
      ),
      child: SizedBox(
        height: rowHeight,
        child: Row(
          children: [
            _BadgedMark(agent: agent, status: status),
            const SizedBox(width: 11),
            Expanded(
              child: _Identity(agent: agent, machineName: machineName),
            ),
            ...trailing,
          ],
        ),
      ),
    );
  }
}

/// The engine mark with the session's state notched into its corner.
class _BadgedMark extends StatelessWidget {
  const _BadgedMark({required this.agent, required this.status});

  final Agent? agent;
  final PhoneSummary status;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SizedBox.square(
      dimension: TerminalHeader.markSize,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          EngineMark(
            engine: agent?.engine,
            displayName: agent?.engineDisplayName,
            size: TerminalHeader.markSize,
          ),
          // Bottom-right, hanging a little past the mark — the corner a
          // messenger puts presence on an avatar. The ring is the header's own
          // colour, so the dot reads as cut into the mark rather than stuck on.
          Positioned(
            right: -4,
            bottom: -4,
            child: StatusDot(summary: status, ring: AppPalette.windowBg),
          ),
        ],
      ),
    );
  }
}

/// The two lines: *agent · machine*, then *folder ⑂ branch*.
///
/// ⚠️ **The agent's name is what yields last.** It is the thing that says WHICH
/// terminal this is, so it takes the larger share of the first line and the
/// machine is cut first. On the second line the folder is kept whole where it
/// can be and the branch gives way — see [projectPathLabel].
class _Identity extends StatelessWidget {
  const _Identity({required this.agent, required this.machineName});

  final Agent? agent;
  final String machineName;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final agent = this.agent;
    final project = agent?.project;
    final branch = project?.branchLabel;
    final hasPlace = project != null || branch != null;
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Flexible(
              flex: 3,
              child: Text(
                agent?.name ?? 'Agent',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: AppPalette.textPrimary,
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  height: 1.2,
                ),
              ),
            ),
            if (machineName.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 5),
                child: Text(
                  '·',
                  style: TextStyle(color: AppPalette.textFaint, fontSize: 13),
                ),
              ),
              Flexible(
                flex: 2,
                child: Text(
                  machineName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppPalette.textSecondary,
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                    height: 1.2,
                  ),
                ),
              ),
            ],
          ],
        ),
        if (hasPlace) ...[
          const SizedBox(height: 2),
          Row(
            children: [
              if (project != null)
                Flexible(
                  flex: 3,
                  child: Text(
                    projectPathLabel(project.cwd),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: _placeStyle,
                  ),
                ),
              if (branch != null) ...[
                if (project != null) const SizedBox(width: 8),
                Icon(
                  LucideIcons.gitBranch300,
                  size: 12,
                  color: AppPalette.textFaint,
                ),
                const SizedBox(width: 3),
                Flexible(
                  flex: 2,
                  child: Text(
                    branch,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: _placeStyle,
                  ),
                ),
              ],
            ],
          ),
        ],
      ],
    );
  }

  TextStyle get _placeStyle => TextStyle(
    color: AppPalette.textSecondary,
    fontSize: 12.5,
    fontWeight: FontWeight.w500,
    height: 1.2,
  );
}

/// A folder as the header names it: its own name, with everything above it
/// folded into `…` — `~/…/autonomous-harness`.
///
/// Home is written `~` the way a shell prompt writes it, so a folder directly in
/// home keeps its whole path (`~/notes`) and home itself is `~`. A folder
/// outside home keeps its root: `/…/srv`.
///
/// ⚠️ The parents are the part every agent somebody owns has in common — the
/// folder's own name is what tells two of them apart, so it is the one thing
/// never cut here.
String projectPathLabel(String cwd) {
  final path = cwd.replaceAll('\\', '/');
  final parts = path.split('/').where((part) => part.isNotEmpty).toList();
  if (parts.isEmpty) return path.isEmpty ? '~' : '/';

  // `/Users/<name>/…` on a Mac, `/home/<name>/…` on Linux, `/root` for root.
  var homeDepth = 0;
  if (path.startsWith('/') && parts.length >= 2) {
    if (parts[0] == 'Users' || parts[0] == 'home') homeDepth = 2;
  }
  if (path.startsWith('/') && parts[0] == 'root') homeDepth = 1;
  if (path.startsWith('~')) homeDepth = 1;

  if (homeDepth > 0) {
    final below = parts.length - homeDepth;
    if (below <= 0) return '~';
    if (below == 1) return '~/${parts.last}';
    return '~/…/${parts.last}';
  }
  // Outside home: a Windows drive keeps its letter, anything else its root.
  final lead = RegExp(r'^[A-Za-z]:$').hasMatch(parts.first) ? parts.first : '';
  if (parts.length == 1) return '$lead/${parts.last}';
  if (lead.isNotEmpty && parts.length == 2) return '$lead/${parts.last}';
  return '$lead/…/${parts.last}';
}
