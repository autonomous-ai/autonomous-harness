import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../logging/log_file.dart';
import '../../logging/log_stream.dart';
import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/labeled_field.dart';
import '../../shared/widgets/section_scaffold.dart';
import 'debug_filter_bar.dart';
import 'debug_log_tile.dart';
import 'debug_paths_card.dart';
import 'debug_toolbar.dart';

/// Settings ▸ Debug — the app's own log, as this session still holds it.
///
/// Ported from Grid's Debug tab (`features/debug/presentation/debug_view.dart`),
/// with one difference that matters: Grid's list is a second stream of its own,
/// fed where commands are issued. This one is a **mirror of the log sinks**
/// (see `logging/log_stream_sinks.dart`), so every line on this screen is a line
/// `~/.harness/logs` already has — reading it here and sending us the file are
/// the same evidence.
///
/// A search box and lenses sit above the list because the signal that matters
/// (the one failure, the one `agent_create`) is buried under socket chatter,
/// and scrolling five hundred near-identical rows by hand is not debugging.
///
/// Only reachable where [kDebugSurfaceEnabled] is — see `settings_section.dart`.
class DebugSection extends StatefulWidget {
  const DebugSection({super.key, this.stream, this.probe});

  /// The log to show. Defaults to the app's own; a test passes its own.
  final LogStream? stream;

  /// How the header card resolves the CLIs — injected in tests, which must not
  /// read a real `~/.harness`.
  final Future<DebugEnvironment> Function()? probe;

  @override
  State<DebugSection> createState() => _DebugSectionState();
}

class _DebugSectionState extends State<DebugSection> {
  final _search = TextEditingController();
  String _query = '';

  /// Null means "everything". Otherwise the category this is narrowed to.
  String? _category;
  bool _failedOnly = false;

  LogStream get _stream => widget.stream ?? logStream;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  bool _matchesQuery(LogEntry entry) {
    final query = _query.trim().toLowerCase();
    if (query.isEmpty) return true;
    return entry.message.toLowerCase().contains(query) ||
        entry.category.toLowerCase().contains(query) ||
        (entry.error?.toLowerCase().contains(query) ?? false);
  }

  /// A failure is either a call that ended badly or a line the app itself
  /// raised — `← agent_create failed` is a warning and is exactly what somebody
  /// opening this lens is looking for.
  static bool _isFailure(LogEntry entry) =>
      entry.status == LogStatus.failed || entry.status == LogStatus.warned;

  bool _matchesLens(LogEntry entry) {
    if (_failedOnly) return _isFailure(entry);
    return _category == null || entry.category == _category;
  }

  void _show({String? category, bool failedOnly = false}) => setState(() {
    _category = category;
    _failedOnly = failedOnly;
  });

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SectionScaffold(
      title: 'Debug',
      subtitle:
          'Everything this app logged this session — the same lines '
          '${DailyLogFile.defaultDirectory.path} keeps for a fortnight. '
          'Credentials are stripped before anything is written.',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Outside the builder below: what the two CLIs resolved to has nothing
          // to do with the log, and a card that re-probed on every socket frame
          // would be a second thing to explain.
          DebugPathsCard(probe: widget.probe ?? probeDebugEnvironment),
          const SizedBox(height: 14),
          Expanded(
            child: ListenableBuilder(
              listenable: _stream,
              builder: (context, _) {
                final entries = _stream.entries;
                final visible = [
                  for (final entry in entries)
                    if (_matchesLens(entry) && _matchesQuery(entry)) entry,
                ];
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    DebugToolbar(total: entries.length, onClear: _stream.clear),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _search,
                      style: const TextStyle(fontSize: 13),
                      decoration:
                          labeledFieldDecoration(
                            'Search messages, categories, errors',
                          ).copyWith(
                            prefixIcon: Icon(
                              LucideIcons.search,
                              size: 15,
                              color: AppPalette.textFaint,
                            ),
                            prefixIconConstraints: const BoxConstraints(
                              minWidth: 34,
                              minHeight: 34,
                            ),
                          ),
                      onChanged: (value) => setState(() => _query = value),
                    ),
                    const SizedBox(height: 10),
                    DebugFilterBar(lenses: _lenses(entries)),
                    const SizedBox(height: 12),
                    Expanded(child: _list(entries.isEmpty, visible)),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  /// All, Failed, then one lens per category the session has actually logged.
  ///
  /// Built from what is there rather than from a fixed list: the categories are
  /// [AppLog]'s own tags and the next one somebody adds should appear here
  /// without a second edit.
  List<DebugLens> _lenses(List<LogEntry> entries) {
    final counts = <String, int>{};
    for (final entry in entries) {
      counts[entry.category] = (counts[entry.category] ?? 0) + 1;
    }
    final categories = counts.keys.toList()
      ..sort((a, b) {
        final byRank = _categoryRank(a).compareTo(_categoryRank(b));
        return byRank != 0 ? byRank : a.compareTo(b);
      });
    return [
      DebugLens(
        label: 'All',
        count: entries.length,
        selected: !_failedOnly && _category == null,
        onTap: _show,
      ),
      DebugLens(
        label: 'Failed',
        count: entries.where(_isFailure).length,
        selected: _failedOnly,
        onTap: () => _show(failedOnly: true),
        danger: true,
        hideWhenEmpty: true,
      ),
      for (final category in categories)
        DebugLens(
          label: category,
          count: counts[category]!,
          selected: !_failedOnly && _category == category,
          onTap: () => _show(category: category),
        ),
    ];
  }

  /// The order the categories read in: the socket the app lives on, then the
  /// two CLIs, then its own narrative. Anything new lands after them, in
  /// alphabetical order, rather than jumping the queue.
  static int _categoryRank(String category) => switch (category) {
    'ws' => 0,
    'cli' => 1,
    'api' => 2,
    'app' => 3,
    'flutter' => 4,
    _ => 5,
  };

  Widget _list(bool nothingLogged, List<LogEntry> visible) {
    if (visible.isNotEmpty) {
      return ListView.separated(
        itemCount: visible.length,
        separatorBuilder: (_, _) => const SizedBox(height: 6),
        itemBuilder: (context, i) => DebugLogTile(entry: visible[i]),
      );
    }
    // Nothing logged yet and "the filter hid it all" are two different stories,
    // so the search box stays above and the user has a way back out.
    if (nothingLogged) {
      return const EmptyState(
        icon: LucideIcons.terminal300,
        title: 'Nothing logged yet',
        message:
            'Use the app and every command, socket frame and request it makes '
            'shows up here.',
      );
    }
    return const EmptyState.noMatches(
      message: 'No entry matches this filter or search.',
    );
  }
}
