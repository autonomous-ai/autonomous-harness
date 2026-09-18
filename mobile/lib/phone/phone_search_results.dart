import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/empty_state.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'phone_navigation.dart';
import 'phone_search_folder_header.dart';
import 'phone_search_groups.dart';
import 'phone_search_index.dart';
import 'phone_search_rank.dart';
import 'phone_search_row.dart';
import 'phone_section_label.dart';

/// What [query] reaches, drawn: the Recent list before a word is typed, then
/// matching agents under their folders.
///
/// ⚠️ Public because two screens draw it: [PhoneSearchPage], and the terminal's
/// own in-place search (see `terminal_search.dart`), which expands out of the
/// header bar rather than pushing a route. Both hand it the query and nothing
/// else, so the two cannot return different rows — or walk a different pager —
/// for the same words.
///
/// Opening it asks each connected machine, once, what was last said to the
/// agents offered first (see [AgentRecallStore]); keystrokes only ever read that
/// memory, so typing stays instant and costs no data.
class PhoneSearchResults extends StatefulWidget {
  const PhoneSearchResults({
    super.key,
    required this.notifier,
    required this.query,
    this.onOpen,
  });

  final AppNotifier notifier;
  final String query;

  /// Called the moment a row is tapped, before anything opens.
  ///
  /// ⚠️ For the in-place search, which is not a route and so is not popped by
  /// opening something. Its field still holds the keyboard, and the terminal it
  /// is covering is about to be replaced underneath it — this is what puts the
  /// search away first. Null on [PhoneSearchPage], where the pop does it.
  final VoidCallback? onOpen;

  @override
  State<PhoneSearchResults> createState() => _PhoneSearchResultsState();
}

class _PhoneSearchResultsState extends State<PhoneSearchResults> {
  late final Listenable _changes = Listenable.merge([
    widget.notifier,
    widget.notifier.agentRecall,
  ]);

  @override
  void initState() {
    super.initState();
    final notifier = widget.notifier;
    notifier.agentRecall.warm([
      for (final entry in recentAgents(agentIndex(notifier)))
        notifier.agentRecallKey(entry.machineId, entry.agent),
    ]);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _changes,
    builder: (context, _) {
      AppTheme.watch(context);
      final all = phoneSearchIndex(widget.notifier);
      if (all.isEmpty) {
        return const EmptyState(
          icon: LucideIcons.laptopMinimal300,
          title: 'Nothing to search yet',
          message: 'Link a machine and its agents will be findable from here.',
        );
      }
      final query = widget.query.trim();
      if (query.isEmpty) return _recentList(all);
      final rows = rankPhoneSearch(all, query);
      if (rows.isEmpty) {
        return EmptyState.noMatches(
          compact: false,
          message: 'Nothing matches “$query”.',
        );
      }
      return _groupedList(phoneSearchGroups(rows), phoneSearchTerms(query));
    },
  );

  /// Every agent in one run, the one that moved last on top.
  ///
  /// No folder headers here. Before a word is typed the question is "which one
  /// was I just on", and grouping answers a different one: a folder with one
  /// fresh agent and one stale one drags the stale one up past fresher agents
  /// elsewhere, and a header over every single-agent folder halves how many
  /// rows fit on the screen. Each row names its own folder and machine instead.
  Widget _recentList(List<PhoneSearchResult> rows) {
    final now = DateTime.now();
    return _ResultsList(
      children: [
        const PhoneSectionLabel(
          'Recent',
          padding: EdgeInsets.fromLTRB(10, 14, 10, 4),
        ),
        for (final row in rows)
          PhoneSearchRow(
            row: row,
            terms: const [],
            now: now,
            placed: true,
            onTap: () => _open(rows, row),
          ),
      ],
    );
  }

  /// Matching agents under their folders, best match first — see
  /// [phoneSearchGroups] for why grouping never buries it.
  Widget _groupedList(List<PhoneSearchGroup> groups, List<String> terms) {
    final drawn = phoneSearchGroupedRows(groups);
    final now = DateTime.now();
    return _ResultsList(
      children: [
        for (final group in groups) ...[
          PhoneSearchFolderHeader(group: group),
          for (final row in group.rows)
            PhoneSearchRow(
              row: row,
              terms: terms,
              now: now,
              onTap: () => _open(drawn, row),
            ),
        ],
      ],
    );
  }

  /// Opens the agent as a pager over the OTHER rows on screen.
  ///
  /// The neighbours are the rows as drawn, not the Agents tab's list: swiping
  /// walks exactly what the query returned, in the order the person was looking
  /// at when they tapped. Handing it the unfiltered index instead would swipe
  /// into agents the query had just excluded.
  ///
  /// ⚠️ [drawn] is the order ON SCREEN — for the grouped list, not the ranked
  /// rows. Grouping pulls a folder's rows together, so the ranked list can hold
  /// a different agent at any given index than the screen does.
  void _open(List<PhoneSearchResult> drawn, PhoneSearchResult row) {
    widget.onOpen?.call();
    final entry = row.entry;
    if (entry == null || !entry.agent.terminalAvailable) return;
    // ⚠️ Built from [phoneSearchAgentEntries] rather than by unwrapping each
    // row here. A `?result.entry` collapse would silently SHORTEN this list if
    // an agent row ever arrived without its entry, and the pager walks it by
    // index — a shorter list than the one on screen sends a swipe to the wrong
    // agent, with nothing on screen to explain why.
    openAgentPager(
      context,
      widget.notifier,
      phoneSearchAgentEntries(drawn),
      entry,
    );
  }
}

/// The scrolling list both layouts share.
class _ResultsList extends StatelessWidget {
  const _ResultsList({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => ListView(
    // The keyboard is up and the finger is already on the glass; dragging the
    // list is how somebody reaches a result without putting it away first.
    keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
    padding: EdgeInsets.fromLTRB(
      16,
      0,
      16,
      MediaQuery.paddingOf(context).bottom + 16,
    ),
    children: children,
  );
}
