import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../state/swarm.dart';
import '../state/swarm_catalog.dart';
import 'engine_identity.dart';

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
  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final app = widget.notifier;
    final groups = swarmProjects(app, widget.projects);
    final results = swarmAgents(app, _query);
    final wallpaper =
        swarmWallpapers[app.activeSwarm.wallpaper % swarmWallpapers.length];
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: Stack(
        fit: StackFit.expand,
        children: [
          Image.asset(
            'assets/swarm-wallpapers/swarm-welcome-$wallpaper.jpg',
            fit: BoxFit.cover,
            excludeFromSemantics: true,
          ),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Color(0x1211111c), Color(0x750c111e)],
              ),
            ),
          ),
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
                                onChanged: (v) => setState(() => _query = v),
                                onSubmitted: (_) {
                                  if (results.isNotEmpty)
                                    widget.onAgent(results.first);
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
                                            onTap: () =>
                                                widget.onProject(group),
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
              label: const Text(
                'Next wallpaper',
                style: TextStyle(fontSize: 11),
              ),
              style: TextButton.styleFrom(foregroundColor: Colors.white70),
            ),
          ),
        ],
      ),
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

class SwarmSearchField extends StatelessWidget {
  const SwarmSearchField({
    super.key,
    required this.onChanged,
    this.onSubmitted,
    this.autofocus = false,
  });
  final ValueChanged<String> onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool autofocus;
  @override
  Widget build(BuildContext context) => TextField(
    autofocus: autofocus,
    onChanged: onChanged,
    onSubmitted: onSubmitted,
    style: const TextStyle(fontSize: 13),
    decoration: InputDecoration(
      hintText: 'Find an agent…',
      prefixIcon: const Icon(Icons.search, size: 18),
      filled: true,
      fillColor: const Color(0xa6111521),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: Colors.white24),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: Colors.white24),
      ),
    ),
  );
}

class SwarmAgentRows extends StatelessWidget {
  const SwarmAgentRows({
    super.key,
    required this.notifier,
    required this.agents,
    required this.onAgent,
  });
  final AppNotifier notifier;
  final List<SwarmAgentRef> agents;
  final ValueChanged<SwarmAgentRef> onAgent;
  @override
  Widget build(BuildContext context) {
    if (agents.isEmpty)
      return const Center(
        child: Text(
          'No matching agents',
          style: TextStyle(color: Colors.white60),
        ),
      );
    return ListView.builder(
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
        return ListTile(
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 10,
            vertical: 3,
          ),
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
              if (agent.project != null) agent.project!.name,
              if (agent.project?.branch != null) agent.project!.branch!,
            ].join(' · '),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 11, color: Colors.white54),
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
          onTap: () => onAgent(entry),
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
