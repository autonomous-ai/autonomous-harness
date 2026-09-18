import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/empty_state.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'phone_header.dart';
import 'phone_navigation.dart';
import 'phone_search_field.dart';
import 'phone_search_groups.dart';
import 'phone_search_index.dart';
import 'phone_search_rank.dart';
import 'phone_search_row.dart';
import 'phone_status.dart';
import 'status_pill.dart';

/// Every agent on the account, grouped by the machine it runs on.
///
/// [AgentsPage] answers the narrower question — one machine's agents, reached by walking into that
/// machine — and the phone needs the wider one too: the terminal's `⋯` sheet is opened from inside
/// an agent, and the agent somebody wants next is as often on the other laptop as on this one.
///
/// ⚠️ **The rows are [PhoneSearchRow], not the tabs' [PhoneCard].** This is a list somebody scans
/// for one agent and leaves, which is what that row is built for — and the search one tap away
/// offers the same agents in the same rows, so the two read as one list with a filter over it
/// rather than as two features.
class AgentsListPage extends StatefulWidget {
  const AgentsListPage({super.key, required this.notifier, this.large = false});

  final AppNotifier notifier;

  /// The big title. Off where this is PUSHED — from the terminal's `⋯` sheet — where it needs the
  /// back chevron a large header does not draw. Matches [MachinesTab.large].
  final bool large;

  @override
  State<AgentsListPage> createState() => _AgentsListPageState();
}

class _AgentsListPageState extends State<AgentsListPage> {
  /// The rows redraw on the agent list AND on what the agents were last asked — the second line of
  /// a row is [SessionPreview] content, which arrives after the list does.
  late final Listenable _changes = Listenable.merge([
    widget.notifier,
    widget.notifier.sessionPreviews,
  ]);

  final _controller = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Agents list search');
  String _query = '';

  @override
  void initState() {
    super.initState();
    // Same warm [PhoneSearchResults] does on open, and for the same reason: the previews are what
    // fill each row's second line, and reading them only as rows scroll into view would fill the
    // list in visibly, line by line. Prioritised — this screen is on top, so its agents are the
    // ones worth the next reads.
    final notifier = widget.notifier;
    notifier.sessionPreviews.warm([
      for (final entry in recentAgents(agentIndex(notifier)))
        notifier.previewKey(entry.machineId, entry.agent),
    ], prioritize: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _changes,
    builder: (context, _) {
      AppTheme.watch(context);
      final all = phoneSearchIndex(widget.notifier);
      return Scaffold(
        backgroundColor: AppPalette.windowBg,
        // The keyboard only comes up if the field is tapped, but when it does the list must shrink
        // rather than run underneath it.
        resizeToAvoidBottomInset: true,
        body: SafeArea(
          bottom: false,
          child: Column(
            children: [
              PhoneHeader(large: widget.large, title: 'Agents'),
              // Under the header rather than a magnifier inside it. The field is this screen's
              // filter, not a door to another one: what it narrows is the list directly below it,
              // and a query typed here keeps the machine headings it is filtering in view. A
              // magnifier would have pushed a second screen over this one to answer a question
              // this one is already showing.
              //
              // ⚠️ No autofocus and no back chevron in the bar — both belong to [PhoneSearchPage],
              // where the field IS the header. Here the list is worth reading before anything is
              // typed, and the header above already carries the way out.
              if (all.isNotEmpty)
                PhoneSearchField(
                  controller: _controller,
                  focus: _focus,
                  autofocus: false,
                  onChanged: (value) => setState(() => _query = value),
                  onClear: () {
                    _controller.clear();
                    setState(() => _query = '');
                    // Clearing is a step back into browsing the whole list, not out of the field —
                    // the caret stays where the next query will go.
                    _focus.requestFocus();
                  },
                ),
              Expanded(
                child: _Body(
                  notifier: widget.notifier,
                  all: all,
                  query: _query.trim(),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

class _Body extends StatelessWidget {
  const _Body({
    required this.notifier,
    required this.all,
    required this.query,
  });

  final AppNotifier notifier;

  /// Every agent, most recently active first — see [recentAgents] for why recency and not the
  /// tabs' fixed order: this screen is opened to REACH one agent, and the one reached for is
  /// overwhelmingly the one that just finished.
  final List<PhoneSearchResult> all;

  /// Trimmed; empty means the whole list.
  final String query;

  @override
  Widget build(BuildContext context) {
    if (all.isEmpty) return _empty();
    // The same ranking [PhoneSearchPage] applies, so an agent found by a word here is the agent
    // that word finds there. Grouping happens after: ranking decides the order the rows arrive in,
    // and [phoneMachineGroups] preserves it — so the best match still heads the first group.
    final rows = query.isEmpty ? all : rankPhoneSearch(all, query);
    if (rows.isEmpty) {
      return EmptyState.noMatches(
        compact: false,
        message: 'Nothing matches “$query”.',
      );
    }
    final groups = phoneMachineGroups(rows);
    // ⚠️ The rows as the GROUPS hold them, not [rows] — grouping pulls a machine's agents together,
    // so the two orders differ, and the pager below walks this one by index against what is drawn.
    final drawn = phoneMachineGroupedRows(groups);
    final terms = query.isEmpty ? const <String>[] : phoneSearchTerms(query);
    final now = DateTime.now();
    return ListView(
      // The keyboard may be up and the finger already on the glass; dragging the list is how
      // somebody reaches a row without putting it away first.
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: EdgeInsets.fromLTRB(
        16,
        0,
        16,
        MediaQuery.paddingOf(context).bottom + 16,
      ),
      children: [
        for (final group in groups) ...[
          _MachineHeader(notifier: notifier, group: group),
          for (final row in group.rows)
            PhoneSearchRow(
              row: row,
              terms: terms,
              now: now,
              // The header above named the machine and nothing else, so the row still owes the
              // folder — and must not repeat the machine.
              place: PhoneRowContext.machined,
              onTap: () => _open(context, drawn, row),
            ),
        ],
      ],
    );
  }

  /// Machines that are offline or unlinked contribute no agents at all ([agentIndex]), so an empty
  /// list here is as often "no machine is answering" as "no agents exist" — and the door to both is
  /// the same one. Machines is on the sheet this page was opened from, one back.
  Widget _empty() => EmptyState(
    icon: notifier.machines.isEmpty
        ? LucideIcons.laptopMinimal300
        : LucideIcons.squareTerminal300,
    title: notifier.machines.isEmpty ? 'No machines yet' : 'No agents to show',
    message: notifier.machines.isEmpty
        ? 'Link a machine and its agents will be listed here.'
        : 'Agents appear here once a machine is linked and answering. '
              'Start one from a machine, or from OpenHarness on it.',
  );

  /// Opens the agent as a pager over the other rows on screen.
  void _open(
    BuildContext context,
    List<PhoneSearchResult> drawn,
    PhoneSearchResult row,
  ) {
    // The keyboard goes away with the screen rather than a frame after it, so the push does not
    // animate over a collapsing inset. [PhoneSearchRow] does this for its own tap; a row opened
    // by any other path still has to.
    FocusManager.instance.primaryFocus?.unfocus();
    final entry = row.entry;
    if (entry == null || !entry.agent.terminalAvailable) return;
    openAgentPager(context, notifier, phoneSearchAgentEntries(drawn), entry);
  }
}

/// The line over one machine's agents: the machine, how it is doing, and how many it holds.
///
/// A [StatusDot] and not a [StatusPill], though this heading is the only place the list says
/// anything about the machine at all. Every machine listed here is one that answered — that is what
/// [agentIndex] admits — so the pill's words would read "Ready" over group after group, for the
/// sake of the one that says "Connecting". The dot carries that one case, and keeps its label for a
/// long press and for a screen reader.
class _MachineHeader extends StatelessWidget {
  const _MachineHeader({required this.notifier, required this.group});

  final AppNotifier notifier;
  final PhoneMachineGroup group;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final machine = notifier.stateOf(group.machineId);
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 14, 10, 4),
      child: Row(
        children: [
          if (machine != null) ...[
            StatusDot(summary: phoneMachineSummary(machine), size: 7),
            const SizedBox(width: 7),
          ],
          // ⚠️ [Flexible] and no [Spacer]. Both take what is left over, so the two together split
          // it — a long machine name would give up half its width to blank space instead of
          // running on and ellipsing. The count is pushed right by this being the only flexible
          // child, the way [PhoneSearchFolderHeader] does it.
          Flexible(
            child: Text(
              group.machineName.toUpperCase(),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: AppPalette.textFaint,
                fontSize: 11.5,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.5,
              ),
            ),
          ),
          const SizedBox(width: 7),
          Text(
            '${group.rows.length}',
            style: TextStyle(
              color: AppPalette.textFaint,
              fontSize: 12,
              fontFeatures: AppFont.tabularFigures,
            ),
          ),
        ],
      ),
    );
  }
}
