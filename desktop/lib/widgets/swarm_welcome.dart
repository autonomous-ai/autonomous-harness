import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../state/swarm_catalog.dart';
import 'engine_identity.dart';
import 'swarm_agent_selection.dart';

class SwarmWelcome extends StatefulWidget {
  const SwarmWelcome({
    super.key,
    required this.notifier,
    required this.projects,
    required this.onNewAgent,
    required this.onAddProject,
    required this.onLinkMachine,
    required this.onMachine,
    required this.onProject,
    required this.onAgent,
  });
  final AppNotifier notifier;
  final List<SavedSwarmProject> projects;
  final VoidCallback onNewAgent;
  final VoidCallback onAddProject;
  final VoidCallback onLinkMachine;
  final ValueChanged<MachineState> onMachine;
  final ValueChanged<SwarmProjectGroup> onProject;
  final ValueChanged<SwarmAgentRef> onAgent;
  @override
  State<SwarmWelcome> createState() => _SwarmWelcomeState();
}

class _SwarmWelcomeState extends State<SwarmWelcome> {
  String _query = '';
  final _selection = SwarmAgentSelection();
  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final app = widget.notifier;
    final groups = swarmProjects(app, widget.projects);
    final results = swarmAgents(app, _query);
    return Stack(
      fit: StackFit.expand,
      children: [
        LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: constraints.maxHeight),
              child: Center(
                child: Container(
                  constraints: const BoxConstraints(maxWidth: 1000),
                  padding: const EdgeInsets.fromLTRB(56, 40, 56, 62),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Start a swarm',
                        style: TextStyle(
                          fontSize: 32,
                          fontWeight: FontWeight.w500,
                          letterSpacing: -0.7,
                          color: Colors.white,
                          shadows: [
                            Shadow(blurRadius: 16, color: Colors.black54),
                          ],
                        ),
                      ),
                      const SizedBox(height: 10),
                      const Text(
                        'Choose a machine or project, or add agents individually.',
                        style: TextStyle(
                          fontSize: 13,
                          color: Color(0xffe0dce3),
                        ),
                      ),
                      const SizedBox(height: 28),
                      Row(
                        children: [
                          Expanded(
                            child: SwarmSearchField(
                              autofocus: true,
                              onChanged: (v) => setState(() {
                                _query = v;
                                _selection.reset();
                              }),
                              onMove: (delta) {
                                if (_query.trim().isNotEmpty) {
                                  setState(
                                    () => _selection.move(results, delta),
                                  );
                                }
                              },
                              onSubmitted: () {
                                final selected = _selection.selected(results);
                                if (_query.trim().isNotEmpty &&
                                    selected != null) {
                                  widget.onAgent(selected);
                                }
                              },
                            ),
                          ),
                          const SizedBox(width: 12),
                          FilledButton.icon(
                            onPressed: widget.onNewAgent,
                            icon: const Icon(Icons.add, size: 17),
                            label: const Text('New agent'),
                            style: FilledButton.styleFrom(
                              minimumSize: const Size(126, 44),
                              backgroundColor: grid.AppPalette.swarmAccent,
                              foregroundColor: grid.AppPalette.swarmTabBar,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 34),
                      _Glass(
                        child: _query.trim().isNotEmpty
                            ? SizedBox(
                                height: 300,
                                child: SwarmAgentRows(
                                  notifier: app,
                                  agents: results,
                                  selectedIndex: _selection.index(results),
                                  onAgent: widget.onAgent,
                                ),
                              )
                            : LayoutBuilder(
                                builder: (context, size) {
                                  final machines = _section(
                                    'Machines',
                                    'Link machine',
                                    widget.onLinkMachine,
                                    [
                                      if (app.machinesLoading &&
                                          app.machineStates.isEmpty)
                                        const SkeletonList(rows: 3),
                                      for (final machine
                                          in app.machineStates.values)
                                        _StarterRow(
                                          icon: Icons.computer_outlined,
                                          name: machine.machine.displayName,
                                          note: machine.needsLink
                                              ? 'Link required'
                                              : machine.nodeOnline == false
                                              ? 'Offline'
                                              : machine.isLocalMachine
                                              ? 'Local'
                                              : null,
                                          count: machine.agents.length,
                                          onTap: () =>
                                              widget.onMachine(machine),
                                        ),
                                      if (!app.machinesLoading &&
                                          app.machineStates.isEmpty)
                                        const Padding(
                                          padding: EdgeInsets.symmetric(
                                            vertical: 18,
                                          ),
                                          child: Text(
                                            'Link a machine to find its agents.',
                                          ),
                                        ),
                                    ],
                                  );
                                  final projects = _section(
                                    'Projects',
                                    'Add project',
                                    widget.onAddProject,
                                    [
                                      for (final group in groups)
                                        _StarterRow(
                                          icon: Icons.folder_outlined,
                                          name: group.name,
                                          count: group.agents.length,
                                          onTap: () => widget.onProject(group),
                                        ),
                                      if (groups.isEmpty)
                                        const Padding(
                                          padding: EdgeInsets.symmetric(
                                            vertical: 18,
                                          ),
                                          child: Text(
                                            'Add a working folder to start a project.',
                                            style: TextStyle(
                                              color: Color(0xffc5bece),
                                              fontSize: 12,
                                            ),
                                          ),
                                        ),
                                    ],
                                  );
                                  return size.maxWidth < 570
                                      ? Column(
                                          children: [
                                            machines,
                                            const SizedBox(height: 24),
                                            projects,
                                          ],
                                        )
                                      : Row(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Expanded(child: machines),
                                            const SizedBox(width: 36),
                                            Expanded(child: projects),
                                          ],
                                        );
                                },
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
        Positioned(
          right: 14,
          bottom: 10,
          child: TextButton.icon(
            onPressed: app.nextSwarmWallpaper,
            icon: const Icon(Icons.wallpaper_outlined, size: 14),
            label: const Text('Next wallpaper', style: TextStyle(fontSize: 11)),
            style: TextButton.styleFrom(foregroundColor: Colors.white70),
          ),
        ),
      ],
    );
  }

  Widget _section(
    String title,
    String action,
    VoidCallback onAction,
    List<Widget> children,
  ) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Row(
        children: [
          Text(
            title,
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
          ),
          const Spacer(),
          TextButton(
            onPressed: onAction,
            child: Text(action, style: const TextStyle(fontSize: 11)),
          ),
        ],
      ),
      const SizedBox(height: 8),
      ...children,
    ],
  );
}

class SwarmSearchField extends StatefulWidget {
  const SwarmSearchField({
    super.key,
    required this.onChanged,
    this.onSubmitted,
    this.onMove,
    this.autofocus = false,
    this.hintText = 'Find an agent…',
  });
  final ValueChanged<String> onChanged;
  final VoidCallback? onSubmitted;
  final ValueChanged<int>? onMove;
  final bool autofocus;
  final String hintText;
  @override
  State<SwarmSearchField> createState() => _SwarmSearchFieldState();
}

class _SwarmSearchFieldState extends State<SwarmSearchField> {
  final _focus = FocusNode(debugLabel: 'Find agent');

  @override
  void initState() {
    super.initState();
    if (widget.autofocus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        // The dialog veil also requests fallback focus in this frame. The
        // search field must win so the first keystroke starts searching.
        if (mounted && ModalRoute.of(context)?.isCurrent != false) {
          _focus.requestFocus();
        }
      });
    }
  }

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final onMove = widget.onMove;
    final onSubmitted = widget.onSubmitted;
    return CallbackShortcuts(
      bindings: {
        if (onSubmitted != null) ...{
          const SingleActivator(LogicalKeyboardKey.enter): onSubmitted,
          const SingleActivator(LogicalKeyboardKey.numpadEnter): onSubmitted,
        },
        if (onMove != null) ...{
          const SingleActivator(LogicalKeyboardKey.arrowDown): () => onMove(1),
          const SingleActivator(LogicalKeyboardKey.arrowUp): () => onMove(-1),
          const SingleActivator(LogicalKeyboardKey.keyN, control: true): () =>
              onMove(1),
          const SingleActivator(LogicalKeyboardKey.keyP, control: true): () =>
              onMove(-1),
        },
      },
      child: TextField(
        focusNode: _focus,
        autofocus: widget.autofocus,
        onChanged: widget.onChanged,
        onSubmitted: (_) => onSubmitted?.call(),
        style: const TextStyle(fontSize: 13),
        decoration: InputDecoration(
          hintText: widget.hintText,
          prefixIcon: const Icon(Icons.search, size: 18),
          filled: true,
          fillColor: const Color(0xa6111521),
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 14,
            vertical: 14,
          ),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: Colors.white24),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: Colors.white24),
          ),
        ),
      ),
    );
  }
}

class SwarmAgentRows extends StatefulWidget {
  const SwarmAgentRows({
    super.key,
    required this.notifier,
    required this.agents,
    required this.onAgent,
    this.selectedIndex,
  });
  final AppNotifier notifier;
  final List<SwarmAgentRef> agents;
  final ValueChanged<SwarmAgentRef> onAgent;
  final int? selectedIndex;
  @override
  State<SwarmAgentRows> createState() => _SwarmAgentRowsState();
}

class _SwarmAgentRowsState extends State<SwarmAgentRows> {
  final _scroll = ScrollController();
  double _rowHeight = 64;
  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _revealSelection() {
    final index = widget.selectedIndex;
    if (!mounted ||
        index == null ||
        !_scroll.hasClients ||
        widget.agents.isEmpty) {
      return;
    }
    final position = _scroll.position;
    final top = index * _rowHeight;
    final bottom = top + _rowHeight;
    final double? target = top < position.pixels
        ? top
        : bottom > position.pixels + position.viewportDimension
        ? bottom - position.viewportDimension
        : null;
    if (target != null) {
      _scroll.jumpTo(target.clamp(0, position.maxScrollExtent));
    }
  }

  @override
  Widget build(BuildContext context) {
    final agents = widget.agents;
    final notifier = widget.notifier;
    if (agents.isEmpty) {
      return const Center(
        child: Text(
          'No matching agents',
          style: TextStyle(color: Colors.white60),
        ),
      );
    }
    final scaler = MediaQuery.textScalerOf(context);
    _rowHeight = (scaler.scale(13) + scaler.scale(11) + 32).clamp(
      64,
      double.infinity,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) => _revealSelection());
    return ListView.builder(
      controller: _scroll,
      padding: EdgeInsets.zero,
      itemExtent: _rowHeight,
      itemCount: agents.length,
      itemBuilder: (context, index) {
        final entry = agents[index];
        final agent = entry.agent;
        final open = notifier.paneOfAgent(entry.machineId, agent.id) != null;
        final question = notifier.questionFor(entry.machineId, agent.id);
        final status = question != null
            ? 'Input needed'
            : entry.machine.nodeOnline == false
            ? 'Offline'
            : !agent.terminalAvailable
            ? 'Unavailable'
            : open
            ? 'In this swarm'
            : null;
        return Tooltip(
          message: [
            agent.name,
            entry.machine.machine.displayName,
            entry.project?.cwd,
          ].whereType<String>().join('\n'),
          child: Semantics(
            selected: widget.selectedIndex == index,
            child: ListTile(
              key: ValueKey((entry.machineId, agent.id)),
              selected: widget.selectedIndex == index,
              selectedTileColor: grid.AppPalette.swarmAccent.withValues(
                alpha: 0.14,
              ),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
              minTileHeight: _rowHeight,
              contentPadding: const EdgeInsets.symmetric(horizontal: 10),
              leading: EngineMark(engine: agent.engine, size: 22),
              title: Text(
                agent.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13),
              ),
              subtitle: Text(
                [
                  entry.machine.machine.displayName,
                  if (entry.project != null) entry.project!.name,
                  if (entry.project?.branch != null) entry.project!.branch!,
                ].join(' · '),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: Colors.white70),
              ),
              trailing: status == null
                  ? const Icon(Icons.add, size: 16, color: Colors.white54)
                  : Text(
                      status,
                      style: TextStyle(
                        fontSize: 10,
                        color: question == null
                            ? Colors.white54
                            : grid.AppPalette.warn,
                      ),
                    ),
              onTap: () => widget.onAgent(entry),
            ),
          ),
        );
      },
    );
  }
}

class _StarterRow extends StatelessWidget {
  const _StarterRow({
    required this.icon,
    required this.name,
    required this.count,
    required this.onTap,
    this.note,
  });
  final IconData icon;
  final String name;
  final int count;
  final VoidCallback onTap;
  final String? note;
  @override
  Widget build(BuildContext context) => Tooltip(
    message: name,
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(7),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 14),
        child: Row(
          children: [
            Icon(icon, size: 17, color: Colors.white60),
            const SizedBox(width: 11),
            Expanded(
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12),
              ),
            ),
            if (note != null) ...[
              const SizedBox(width: 6),
              Text(
                note!,
                style: const TextStyle(fontSize: 10, color: Colors.white54),
              ),
            ],
            const SizedBox(width: 12),
            Text(
              '$count',
              style: const TextStyle(fontSize: 11, color: Colors.white54),
            ),
            const SizedBox(width: 8),
            const Icon(Icons.chevron_right, size: 14, color: Colors.white54),
          ],
        ),
      ),
    ),
  );
}

class _Glass extends StatelessWidget {
  const _Glass({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(14),
    child: BackdropFilter(
      filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
      child: Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: const Color(0x80111522),
          border: Border.all(color: Colors.white12),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Material(type: MaterialType.transparency, child: child),
      ),
    ),
  );
}
