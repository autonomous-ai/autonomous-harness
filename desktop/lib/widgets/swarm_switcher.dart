import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/swarm_navigation.dart';
import 'engine_identity.dart';
import 'swarm_welcome.dart';

Future<SwarmDestination?> showSwarmSwitcher(
  BuildContext context,
  AppNotifier app,
  SwarmNavigationHistory history,
) => showAppDialog<SwarmDestination>(
  context: context,
  transitionDuration: Duration.zero,
  veilBlur: 0,
  veilTint: const Color(0x66000000),
  builder: (_) => _SwarmSwitcher(app: app, recent: history.recent),
);

class _SwarmSwitcher extends StatefulWidget {
  const _SwarmSwitcher({required this.app, required this.recent});
  final AppNotifier app;
  final List<String> recent;
  @override
  State<_SwarmSwitcher> createState() => _SwarmSwitcherState();
}

class _SwarmSwitcherState extends State<_SwarmSwitcher> {
  final _scroll = ScrollController();
  late List<SwarmDestination> _catalog;
  List<SwarmDestination> _rows = [];
  String _query = '';
  String? _selectedId;
  int _cursor = 0;
  double _rowHeight = 56;
  late final _targetName = widget.app.activeSwarm.name;

  @override
  void initState() {
    super.initState();
    _refreshCatalog();
    widget.app.addListener(_onAppChanged);
  }

  void _onAppChanged() => setState(_refreshCatalog);

  void _refreshCatalog() {
    _catalog = swarmDestinations(widget.app, recent: widget.recent);
    _filter();
  }

  void _filter() {
    _rows = rankSwarmDestinations(_catalog, _query, recent: widget.recent);
    final index = _rows.indexWhere((row) => row.id == _selectedId);
    _cursor = _rows.isEmpty
        ? 0
        : index >= 0
        ? index
        : _cursor.clamp(0, _rows.length - 1);
    _selectedId = _rows.isEmpty ? null : _rows[_cursor].id;
    _revealSelection();
  }

  void _move(int delta) {
    if (_rows.isEmpty) return;
    setState(() {
      _cursor = (_cursor + delta) % _rows.length;
      _selectedId = _rows[_cursor].id;
    });
    _revealSelection();
  }

  void _revealSelection() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients || _rows.isEmpty) return;
      final top = _cursor * _rowHeight;
      final bottom = top + _rowHeight;
      final position = _scroll.position;
      final offset = top < position.pixels
          ? top
          : bottom > position.pixels + position.viewportDimension
          ? bottom - position.viewportDimension
          : position.pixels;
      final target = offset.clamp(0.0, position.maxScrollExtent);
      if (target != position.pixels) _scroll.jumpTo(target);
    });
  }

  void _submit() {
    if (_rows.isNotEmpty) Navigator.pop(context, _rows[_cursor]);
  }

  @override
  void dispose() {
    widget.app.removeListener(_onAppChanged);
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context);
    _rowHeight = (scale.scale(13) + scale.scale(11) + 32).clamp(
      56,
      double.infinity,
    );
    final selected = _rows.isEmpty ? null : _rows[_cursor];
    return Dialog(
      alignment: const Alignment(0, -0.5),
      insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 48),
      child: SizedBox(
        width: 620,
        height: 480,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: [
              SwarmSearchField(
                autofocus: true,
                hintText: 'Jump to an agent or swarm…',
                onChanged: (value) => setState(() {
                  _query = value;
                  _cursor = 0;
                  _selectedId = null;
                  _filter();
                }),
                onMove: _move,
                onSubmitted: _submit,
              ),
              const SizedBox(height: 12),
              Expanded(
                child: _rows.isEmpty
                    ? const Center(
                        child: Text(
                          'No matching agents or swarms',
                          style: TextStyle(fontSize: 13, color: Colors.white60),
                        ),
                      )
                    : ListView.builder(
                        controller: _scroll,
                        itemCount: _rows.length,
                        itemExtent: _rowHeight,
                        itemBuilder: (context, index) {
                          final row = _rows[index];
                          return ListTile(
                            key: ValueKey(row.id),
                            selected: index == _cursor,
                            selectedColor: Colors.white,
                            selectedTileColor: Colors.white10,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(8),
                            ),
                            contentPadding: const EdgeInsets.symmetric(
                              horizontal: 12,
                            ),
                            leading: row.isSwarm
                                ? const Icon(
                                    Icons.tab,
                                    size: 19,
                                    color: Colors.white60,
                                  )
                                : EngineMark(engine: row.engine, size: 20),
                            title: Text(
                              row.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 13),
                            ),
                            subtitle: Text(
                              row.detail,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 11,
                                color: Colors.white54,
                              ),
                            ),
                            trailing: Text(
                              row.current
                                  ? 'Current'
                                  : row.isSwarm
                                  ? 'Swarm'
                                  : row.hasView
                                  ? 'Jump'
                                  : 'Open view',
                              style: const TextStyle(
                                fontSize: 11,
                                color: Colors.white54,
                              ),
                            ),
                            onTap: () => Navigator.pop(context, row),
                          );
                        },
                      ),
              ),
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  selected != null && !selected.hasView
                      ? '↵ Open view in $_targetName · Esc to close'
                      : '↑↓ or ⌃N ⌃P to choose · Return to jump · Esc to close',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11, color: Colors.white54),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
