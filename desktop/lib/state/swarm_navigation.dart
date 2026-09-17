import 'package:flutter/foundation.dart' show listEquals, setEquals;

import '../core/fuzzy_match.dart';
import '../core/models.dart';
import '../widgets/engine_identity.dart';
import 'app_state.dart';
import 'pane_arrangement.dart';
import 'session_preview.dart';
import 'swarm.dart';
import 'swarm_catalog.dart';
import 'terminal_pane.dart';

String swarmDestinationId(String id) => 'swarm:$id';
String agentDestinationId(String machineId, String agentId) =>
    'agent:$machineId\u0000$agentId';
String agentLocationId(String swarmId, int paneId) =>
    'location:$swarmId\u0000$paneId';

/// Session-local history contains identities only, never terminal buffers or
/// controllers. Repeated discovery/output notifications do not reorder it.
class SwarmNavigationHistory {
  static const capacity = 64;
  final _recent = <String>[];
  final _recentLocations = <String>[];
  (String, int?)? _location;
  final _trail = <(String, int?)>[];
  int _cursor = -1;
  bool _traversing = false;
  int _revision = 0;
  List<Object?>? _menuPresentation;
  List<SwarmDestination> _menuDestinations = const [];
  List<String> get recent => List.unmodifiable(_recent);
  List<String> get recentLocations => List.unmodifiable(_recentLocations);

  void record(AppNotifier app) {
    if (app.isDraftSwarm(app.activeSwarmId)) return;
    final location = (app.activeSwarmId, app.focusedPaneId);
    if (_location == location) return;
    if (!_traversing) {
      _trail.removeRange(_cursor + 1, _trail.length);
      _trail.add(location);
      if (_trail.length > capacity * 2) _trail.removeAt(0);
      _cursor = _trail.length - 1;
    }
    _revision++;
    if (_location?.$1 != location.$1) {
      _remember(swarmDestinationId(location.$1));
    }
    final pane = app.focusedPane;
    if (pane?.agentId != null) {
      _remember(agentDestinationId(pane!.machineId, pane.agentId!));
    }
    final destination = pane?.agentId != null
        ? agentLocationId(location.$1, pane!.id)
        : swarmDestinationId(location.$1);
    _recentLocations.remove(destination);
    _recentLocations.insert(0, destination);
    if (_recentLocations.length > capacity) _recentLocations.removeLast();
    _location = location;
  }

  int? _next(AppNotifier app, int direction) {
    for (
      var i = _cursor + direction;
      i >= 0 && i < _trail.length;
      i += direction
    ) {
      final (swarmId, paneId) = _trail[i];
      final swarm = app.swarms.where((s) => s.id == swarmId).firstOrNull;
      if (swarm == null ||
          (paneId == null && swarm.panes.isNotEmpty) ||
          (paneId != null && !swarm.panes.any((p) => p.id == paneId))) {
        continue;
      }
      if ((swarmId, paneId) != _location) return i;
    }
    return null;
  }

  bool canGoBack(AppNotifier app) => _next(app, -1) != null;
  bool canGoForward(AppNotifier app) => _next(app, 1) != null;

  /// Changes focus only; closed views are skipped without attaching a stream.
  void step(AppNotifier app, int direction) {
    if (direction != -1 && direction != 1) return;
    final index = _next(app, direction);
    if (index == null) return;
    final (swarmId, paneId) = _trail[index];
    _cursor = index;
    _traversing = true;
    try {
      app.selectSwarm(swarmId, attachPending: false);
      if (paneId != null) app.focusPane(paneId, reveal: true);
    } finally {
      _traversing = false;
    }
  }

  void _remember(String id) {
    _recent.remove(id);
    _recent.insert(0, id);
    if (_recent.length > capacity) _recent.removeLast();
  }

  /// Native menus are ready before opening. Ordinary terminal output reuses
  /// this snapshot; navigation, membership and discovery invalidate it.
  List<SwarmDestination> menuDestinations(AppNotifier app) {
    final presentation = <Object?>[
      _revision,
      app.activeSwarmId,
      app.focusedPaneId,
      for (final swarm in app.swarms) ...[
        swarm.id,
        swarm.name,
        for (final pane in swarm.panes)
          (
            pane.id,
            pane.machineId,
            pane.agentId,
            pane.session?.agentName,
            pane.session?.engineId,
          ),
      ],
      for (final machine in app.machineStates.values) ...[
        (
          machine.machine,
          machine.nodeOnline,
          machine.agents,
          machine.agents.length,
          machine.localEndpoint?.agentProjects,
          machine.localProjects,
        ),
        ...machine.dsh.byId.values,
      ],
    ];
    if (listEquals(_menuPresentation, presentation)) return _menuDestinations;
    _menuPresentation = presentation;
    final catalog = {
      for (final entry in swarmDestinations(
        app,
        recent: _recent,
        openOnly: true,
      ))
        if (entry.hasView) entry.id: entry,
    };
    return _menuDestinations = List.unmodifiable([
      for (final id in _recent) ?catalog[id],
    ]);
  }
}

/// A searchable snapshot. Resolving a result again at activation prevents live
/// discovery or a closed tab from redirecting an action to unrelated work.
class SwarmDestination {
  SwarmDestination({
    required this.id,
    required this.title,
    required this.detail,
    this.detailBranchOffset,
    required this.swarmId,
    required this.current,
    this.machineId,
    this.machineLabel = '',
    this.agentId,
    this.engine,
    this.closedId,
    this.commandId,
    this.shortcut,
    this.paneId,
    this.swarmName = '',
    this.projectId,
    this.previewKey,
    this.members = const {},
    Iterable<String?> searchFields = const [],
    int titleFields = 1,
  }) : fields = [
         title.toLowerCase(),
         ...searchFields.whereType<String>().map((s) => s.toLowerCase()),
       ],
       titleFieldCount = titleFields;

  /// How many leading [fields] are "the name of the thing" rather than
  /// metadata: the row's title, plus the agent's own title when it has one.
  /// A match there outranks any match in a folder, a machine or a recap.
  final int titleFieldCount;

  final String id, title, detail, machineLabel;

  /// The branch's start in the readable metadata, for its decorative glyph.
  final int? detailBranchOffset;
  final String? swarmId, machineId, agentId, engine;
  final String? closedId;
  final String? commandId, shortcut;

  /// An exact navigation location. Never fall back to a different swarm.
  final int? paneId;
  final String swarmName;
  bool get isCommand => commandId != null;
  final String? projectId;
  final SessionPreviewKey? previewKey;
  final Set<String> members;
  final bool current;
  final List<String> fields;
  bool get isProject => projectId != null;
  bool get isMachine => agentId == null && machineId != null && !isProject;
  bool get isGroup => isProject || isMachine;
  bool get isSwarm => agentId == null && !isGroup && !isCommand;
  bool get hasView => swarmId != null;
}

enum SwarmSearchAction { open, addHere }

({String text, int? branchOffset}) _harnessDetail(
  String? type,
  AgentProject? project,
  String machine,
  bool offline,
) {
  final prefix = [
    type,
    project?.name,
  ].whereType<String>().where((part) => part.isNotEmpty).join(' · ');
  final branch = project?.branch;
  return (
    text: [
      prefix,
      branch,
      machine,
      if (offline) 'Offline',
    ].whereType<String>().where((part) => part.isNotEmpty).join(' · '),
    branchOffset: branch?.isNotEmpty == true
        ? (prefix.isNotEmpty ? prefix.length + 3 : 0)
        : null,
  );
}

String? _harnessType(MachineState? machine, String? engine) =>
    (engine == null ? null : machine?.dsh[engine]?.category) ??
    engineIdentity(engine).category;

class SwarmSearchSelection {
  const SwarmSearchSelection(
    this.destination, [
    this.action = SwarmSearchAction.open,
  ]) : agents = const [];

  SwarmSearchSelection.multiple(List<SwarmDestination> agents)
    : assert(agents.isNotEmpty),
      destination = agents.first,
      action = SwarmSearchAction.addHere,
      agents = List.unmodifiable(agents);
  final SwarmDestination destination;
  final SwarmSearchAction action;
  final List<SwarmDestination> agents;
}

List<Object?> _catalogPresentation(
  AppNotifier app,
  List<SavedSwarmProject> projects, {
  List<String> recent = const [],
}) => [
  app.activeSwarmId,
  app.focusedPaneId,
  ...recent,
  ...projects,
  for (final swarm in app.swarms) ...[
    swarm.id,
    swarm.name,
    for (final pane in swarm.panes)
      (
        pane.id,
        pane.machineId,
        pane.agentId,
        pane.session?.agentName,
        pane.session?.engineId,
      ),
  ],
  for (final machine in app.machineStates.values) ...[
    (
      machine.machine,
      machine.nodeOnline,
      machine.needsLink,
      machine.agents,
      machine.agents.length,
      machine.localEndpoint?.agentProjects,
      machine.localProjects,
    ),
    ...machine.dsh.byId.values,
  ],
];

/// One catalog for all search entry points. Terminal output leaves these
/// normalized snapshots intact; only discovery, membership or metadata changes
/// rebuild them. Typing never reads a folder or asks a machine for data.
class SwarmSearchCatalog {
  List<Object?>? _presentation;
  List<SwarmDestination> _entries = const [];

  List<SwarmDestination> read(
    AppNotifier app,
    List<SavedSwarmProject> projects, {
    List<String> recent = const [],
  }) {
    final presentation = _catalogPresentation(app, projects, recent: recent);
    if (listEquals(_presentation, presentation)) return _entries;
    _presentation = presentation;
    final groups = swarmProjects(app, projects);
    final entries = swarmDestinations(
      app,
      recent: recent,
      projectGroups: groups,
    );
    // A one-harness tab is another view of that harness, not another result.
    // Its name remains an alias on the harness, including after a tab rename.
    entries.removeWhere((entry) => entry.isSwarm && entry.members.length == 1);
    final agentsById = {
      for (final entry in entries)
        if (entry.agentId != null) entry.id: entry,
    };
    final machineMembers = <String, Set<String>>{};
    for (final entry in agentsById.values) {
      (machineMembers[entry.machineId!] ??= {}).add(entry.id);
    }
    for (final machine in app.machineStates.values) {
      final id = machine.machine.machineId;
      final members = machineMembers[id] ?? const <String>{};
      entries.add(
        SwarmDestination(
          id: 'machine:$id',
          title: machine.machine.displayName,
          detail: [
            'Machine',
            _countLabel(members.length, 'harness'),
            if (machine.needsLink)
              'Link required'
            else if (machine.nodeOnline == false)
              'Offline',
          ].join(' · '),
          machineId: id,
          swarmId: null,
          current: false,
          members: Set.unmodifiable(members),
        ),
      );
    }
    for (final group in groups) {
      final members = {
        for (final entry in group.agents)
          if (agentsById.containsKey(
            agentDestinationId(entry.machineId, entry.agent.id),
          ))
            agentDestinationId(entry.machineId, entry.agent.id),
      };
      entries.add(
        SwarmDestination(
          id: 'project:${group.id}',
          projectId: group.id,
          title: group.name,
          detail: 'Project · ${_countLabel(members.length, 'harness')}',
          swarmId: null,
          current: false,
          members: Set.unmodifiable(members),
          searchFields: {
            group.saved?.path,
            for (final entry in group.agents) ...[
              entry.machine.machine.displayName,
              entry.project?.cwd,
              entry.project?.branch,
            ],
          },
        ),
      );
      // Explicit project associations from older daemons are searchable too.
      final name = group.name.toLowerCase();
      for (final id in members) {
        final entry = agentsById[id]!;
        if (!entry.fields.contains(name)) entry.fields.add(name);
      }
    }
    return _entries = List.unmodifiable(entries);
  }
}

/// Global navigation lists places that already exist. The same runtime has a
/// separate location in every swarm; discovery alone never creates a result
/// whose activation would add membership. Output reuses the cached snapshot.
class SwarmLocationCatalog {
  List<Object?>? _presentation;
  List<SwarmDestination> _entries = const [];

  List<SwarmDestination> read(
    AppNotifier app,
    List<SavedSwarmProject> projects,
  ) {
    final presentation = _catalogPresentation(app, projects);
    if (listEquals(presentation, _presentation)) return _entries;
    _presentation = presentation;
    // Resolve metadata once, and format only open locations. Navigation does
    // not need the Add catalog's thousands of unused agents or project groups.
    final agents = {
      for (final machine in app.machineStates.entries)
        for (final agent in machine.value.agents)
          (machine.key, agent.id): agent,
    };
    return _entries = List.unmodifiable([
      for (final swarm in app.swarms) ...[
        _swarm(app, swarm),
        for (final pane in swarm.panes)
          if (pane.agentId != null)
            _location(
              app,
              swarm,
              pane,
              agents[(pane.machineId, pane.agentId!)],
            ),
      ],
    ]);
  }

  SwarmDestination _swarm(AppNotifier app, Swarm swarm) {
    final machineLabel = _swarmMachineLabel(app, [
      for (final pane in swarm.panes)
        if (pane.agentId != null) pane.machineId,
    ]);
    return SwarmDestination(
      id: swarmDestinationId(swarm.id),
      title: swarm.name,
      detail: _agentCountLabel(swarm.panes.map((pane) => pane.agentId)),
      machineLabel: machineLabel,
      swarmId: swarm.id,
      swarmName: swarm.name,
      current: swarm.id == app.activeSwarmId,
      searchFields: [machineLabel],
    );
  }

  SwarmDestination _location(
    AppNotifier app,
    Swarm swarm,
    TerminalPane pane,
    Agent? agent,
  ) {
    final machine = app.machineStates[pane.machineId];
    final project = agent == null ? null : machine?.projectOf(agent);
    final machineLabel = machine?.machine.displayName ?? pane.machineId;
    final engine = agent?.identityEngine ?? pane.session?.engineId;
    final detail = _harnessDetail(
      _harnessType(machine, engine),
      project,
      machineLabel,
      machine?.nodeOnline == false,
    );
    return SwarmDestination(
      id: agentLocationId(swarm.id, pane.id),
      title: agent?.name ?? pane.session?.agentName ?? pane.agentId!,
      detail: detail.text,
      detailBranchOffset: detail.branchOffset,
      swarmId: swarm.id,
      swarmName: swarm.name,
      paneId: pane.id,
      machineId: pane.machineId,
      machineLabel: machineLabel,
      agentId: pane.agentId,
      previewKey: agent == null ? null : app.previewKey(pane.machineId, agent),
      engine: engine,
      current: swarm.id == app.activeSwarmId && pane.id == app.focusedPaneId,
      // The agent's own title first, ranked like the name: "board fab check"
      // finds the agent whose work that is, not whichever recap mentions fab.
      searchFields: [agent?.title, detail.text, project?.cwd, engine, swarm.name],
      titleFields: agent?.title == null ? 1 : 2,
    );
  }
}

/// Each swarm is one selectable parent, followed by its matching agent views.
/// Keep the parent even when only an agent matches, so its destination is clear.
/// Order groups by their best match/previous place, and agents by match within it.
List<SwarmDestination> rankSwarmLocations(
  List<SwarmDestination> all,
  String query, {
  List<String> recent = const [],
  SessionPreviewStore? previews,
}) {
  final groups = <String, List<SwarmDestination>>{};
  final parents = {
    for (final row in all)
      if (row.agentId == null) row.swarmId!: row,
  };
  for (final row in rankSwarmDestinations(
    all,
    query,
    recent: recent,
    previews: previews,
  )) {
    (groups[row.swarmId!] ??= []).add(row);
  }
  return [
    for (final group in groups.entries) ...[
      ?parents[group.key],
      ...group.value.where((row) => row.agentId != null),
    ],
  ];
}

Future<bool> activateSwarmSearchSelection(
  AppNotifier app,
  SwarmSearchSelection selection, {
  required String destinationSwarmId,
  List<SavedSwarmProject> projects = const [],
  PaneSplitRequest? split,
}) async {
  final destination = selection.destination;
  if (selection.agents.isNotEmpty) {
    final target = app.swarms
        .where((swarm) => swarm.id == destinationSwarmId)
        .firstOrNull;
    if (target == null || split != null) return false;
    final catalog = SwarmSearchCatalog().read(app, projects);
    final byId = {for (final row in catalog) row.id: row};
    final members = <SwarmDestination>[];
    final seen = <String>{};
    for (final chosen in selection.agents) {
      final row = byId[chosen.id];
      if (row?.agentId == null ||
          !(app.machineStates[row!.machineId]?.agents.any(
                (agent) => agent.id == row.agentId,
              ) ??
              false)) {
        return false;
      }
      if (seen.add(row.id) &&
          !target.panes.any(
            (pane) =>
                pane.machineId == row.machineId && pane.agentId == row.agentId,
          )) {
        members.add(row);
      }
    }
    if (members.isEmpty ||
        target.panes.length + members.length > AppNotifier.maxPanes) {
      return false;
    }
    // Validate the complete selection before recording any membership. Every
    // add records its destination synchronously, before attachment can wait.
    await Future.wait([
      for (final row in members)
        app.addAgentToSwarm(row.machineId!, row.agentId!, swarmId: target.id),
    ]);
    return app.swarms.contains(target) &&
        members.every(
          (row) => target.panes.any(
            (pane) =>
                pane.machineId == row.machineId && pane.agentId == row.agentId,
          ),
        );
  }
  if (selection.action == SwarmSearchAction.open && !destination.isGroup) {
    return activateSwarmDestination(
      app,
      destination,
      destinationSwarmId: destinationSwarmId,
    );
  }
  if (selection.action == SwarmSearchAction.addHere) {
    if (destination.agentId == null) {
      if (split != null || destination.isCommand) return false;
      final target = app.swarms
          .where((swarm) => swarm.id == destinationSwarmId)
          .firstOrNull;
      final catalog = SwarmSearchCatalog().read(app, projects);
      final live = catalog.where((row) => row.id == destination.id).firstOrNull;
      if (target == null ||
          live == null ||
          !setEquals(destination.members, live.members)) {
        return false;
      }
      final members = catalog
          .where(
            (row) =>
                destination.members.contains(row.id) &&
                !target.panes.any(
                  (pane) =>
                      pane.machineId == row.machineId &&
                      pane.agentId == row.agentId,
                ),
          )
          .toList();
      if (members.isEmpty ||
          target.panes.length + members.length > AppNotifier.maxPanes ||
          members.any(
            (row) =>
                !(app.machineStates[row.machineId]?.agents.any(
                      (agent) => agent.id == row.agentId,
                    ) ??
                    false),
          )) {
        return false;
      }
      if (target.panes.isEmpty && target.name == Swarm.defaultName) {
        app.renameSwarm(target.id, destination.title);
      }
      // Every membership is recorded before awaiting any attachment. A slow
      // machine cannot retarget the add or hold up the other agents.
      await Future.wait([
        for (final row in members)
          app.addAgentToSwarm(row.machineId!, row.agentId!, swarmId: target.id),
      ]);
      return members.every(
        (row) => target.panes.any(
          (pane) =>
              pane.machineId == row.machineId && pane.agentId == row.agentId,
        ),
      );
    }
    if (destination.agentId == null ||
        (split != null &&
            (split.swarmId != destinationSwarmId ||
                !app.isPaneSplitCurrent(split))) ||
        !app.swarms.any((s) => s.id == destinationSwarmId)) {
      return false;
    }
    final live = swarmDestinations(app)
        .where((e) => e.id == destination.id)
        .firstOrNull;
    if (live == null) return false;
    await app.assignAgentToPane(
      null,
      destination.machineId!,
      destination.agentId!,
      swarmId: destinationSwarmId,
      split: split,
    );
    if (app.activeSwarmId == destinationSwarmId) {
      app.revealAgentView(
        destination.machineId!,
        destination.agentId!,
        preferredSwarmId: destinationSwarmId,
      );
    }
    return app.swarms.any(
      (s) =>
          s.id == destinationSwarmId &&
          s.panes.any(
            (p) =>
                p.machineId == destination.machineId &&
                p.agentId == destination.agentId,
          ),
    );
  }
  if (!canOpenSwarmGroup(
    app,
    destination,
    destinationSwarmId: destinationSwarmId,
  )) {
    return false;
  }
  final entries = SwarmSearchCatalog().read(app, projects);
  final group = entries
      .where((entry) => entry.id == destination.id)
      .firstOrNull;
  // Keep the membership represented by the selected result. Discovery may
  // change while this action is waiting to run.
  if (group == null || !group.members.containsAll(destination.members)) {
    return false;
  }
  final agents = [
    for (final entry in entries)
      if (entry.agentId != null && destination.members.contains(entry.id))
        (machineId: entry.machineId!, agentId: entry.agentId!),
  ];
  if (agents.length != destination.members.length) return false;
  final existing = _matchingGroupSwarm(app, destination);
  if (existing != null) {
    app.selectSwarm(existing.id);
    final focus = existing.focusedPaneId;
    if (focus != null) app.focusPane(focus);
    return true;
  }
  final target = app.swarms
      .where((swarm) => swarm.id == destinationSwarmId)
      .firstOrNull;
  if (target != null && target.panes.isEmpty) {
    app.selectSwarm(target.id);
  } else {
    app.newSwarm(name: group.title);
  }
  await app.seedSwarm(group.title, agents);
  return true;
}

bool canOpenSwarmGroup(
  AppNotifier app,
  SwarmDestination destination, {
  required String destinationSwarmId,
}) =>
    // With no tab cap a group always has somewhere to open; only its size is bounded.
    destination.isGroup && destination.members.length <= AppNotifier.maxPanes;

Swarm? _matchingGroupSwarm(AppNotifier app, SwarmDestination destination) {
  bool matches(Swarm swarm) =>
      // Empty tabs only match their name; two empty projects are distinct.
      (destination.members.isNotEmpty || swarm.name == destination.title) &&
      swarm.panes.length == destination.members.length &&
      swarm.panes.every(
        (pane) =>
            pane.agentId != null &&
            destination.members.contains(
              agentDestinationId(pane.machineId, pane.agentId!),
            ),
      );
  return app.swarms
          .where((swarm) => swarm.name == destination.title && matches(swarm))
          .firstOrNull ??
      (matches(app.activeSwarm) ? app.activeSwarm : null) ??
      app.swarms.where(matches).firstOrNull;
}

String _agentCountLabel(Iterable<String?> ids) {
  final count = ids.whereType<String>().length;
  return '$count ${count == 1 ? 'agent' : 'agents'}';
}

String _countLabel(int count, String noun) {
  final plural = noun == 'harness' ? 'harnesses' : '${noun}s';
  return '$count ${count == 1 ? noun : plural}';
}

String _swarmMachineLabel(AppNotifier app, Iterable<String> machineIds) {
  final ids = machineIds.toSet();
  if (ids.isEmpty) return '';
  if (ids.length > 1) return '${ids.length} machines';
  final id = ids.single;
  return app.stateOf(id)?.machine.displayName ?? id;
}

List<SwarmDestination> closedWorkDestinations(AppNotifier app) => [
  for (final entry in app.closedHistory)
    if (entry is ClosedSwarm)
      SwarmDestination(
        id: entry.historyId,
        closedId: entry.historyId,
        title: entry.name,
        engine: entry.engine,
        members: {
          for (final pane in entry.panes)
            if (pane.agentId != null)
              agentDestinationId(pane.machineId, pane.agentId!),
        },
        machineLabel: _swarmMachineLabel(app, [
          for (final pane in entry.panes)
            if (pane.agentId != null) pane.machineId,
        ]),
        detail:
            '${_agentCountLabel(entry.panes.map((pane) => pane.agentId))} · Recently closed',
        swarmId: null,
        current: false,
      )
    else if (entry is ClosedAgent)
      SwarmDestination(
        id: entry.historyId,
        closedId: entry.historyId,
        title: entry.name,
        detail: '${entry.machineName} · ${entry.swarmName} · Recently closed',
        swarmId: null,
        machineId: entry.machineId,
        machineLabel:
            app.stateOf(entry.machineId)?.machine.displayName ??
            entry.machineName,
        agentId: entry.agentId,
        engine: entry.engine,
        current: false,
        searchFields: [entry.machineName, entry.swarmName, entry.engine],
      ),
];

List<SwarmDestination> swarmDestinations(
  AppNotifier app, {
  List<String> recent = const [],
  bool openOnly = false,
  List<SwarmProjectGroup> projectGroups = const [],
}) {
  final owners = <String, List<Swarm>>{};
  final agents = <String, (MachineState, Agent)>{};
  final result = <SwarmDestination>[];
  final recency = {for (var i = 0; i < recent.length; i++) recent[i]: i};
  final projectsByAgent = <String, Set<String>>{};
  for (final group in projectGroups) {
    for (final entry in group.agents) {
      final id = agentDestinationId(entry.machineId, entry.agent.id);
      (projectsByAgent[id] ??= {}).add(group.id);
    }
  }
  for (final machine in app.machineStates.values) {
    for (final agent in machine.agents) {
      agents[agentDestinationId(machine.machine.machineId, agent.id)] = (
        machine,
        agent,
      );
    }
  }
  for (final swarm in app.swarms) {
    final context = <String?>[];
    final panes = swarm.panes.where((pane) => pane.agentId != null).toList();
    final members = <String>{};
    final projects = <String>{};
    final machines = <String>{};
    for (final pane in panes) {
      final id = agentDestinationId(pane.machineId, pane.agentId!);
      members.add(id);
      machines.add(pane.machineId);
      (owners[id] ??= []).add(swarm);
      final row = agents[id];
      final project = row?.$1.projectOf(row.$2);
      if (project != null) projects.add(project.identity(pane.machineId));
      projects.addAll(projectsByAgent[id] ?? const {});
      context.addAll([
        row?.$1.machine.displayName,
        row?.$2.name ?? pane.session?.agentName,
        project?.name,
        project?.branch,
        project?.cwd,
        _harnessType(row?.$1, row?.$2.identityEngine ?? pane.session?.engineId),
      ]);
    }
    result.add(
      SwarmDestination(
        id: swarmDestinationId(swarm.id),
        title: swarm.name,
        engine: panes.length == 1
            ? agents[agentDestinationId(
                        panes.single.machineId,
                        panes.single.agentId!,
                      )]
                      ?.$2
                      .identityEngine ??
                  panes.single.session?.engineId
            : null,
        machineLabel: _swarmMachineLabel(app, machines),
        detail: [
          _countLabel(members.length, 'harness'),
          if (projects.isNotEmpty) _countLabel(projects.length, 'project'),
          if (machines.isNotEmpty) _countLabel(machines.length, 'machine'),
        ].join(' · '),
        members: members,
        swarmId: swarm.id,
        current: swarm.id == app.activeSwarmId,
        searchFields: context.toSet(),
      ),
    );
  }
  // History refreshes on focus changes, but only offers existing views. Keep
  // their normal owner/metadata resolution without formatting every unopened
  // runtime in discovery. Add agent continues to include those runtimes.
  for (final id in {...owners.keys, if (!openOnly) ...agents.keys}) {
    final memberships = owners[id] ?? const <Swarm>[];
    final row = agents[id];
    if (memberships.isEmpty && row?.$2.terminalAvailable != true) continue;
    Swarm? owner;
    var ownerRank = 1000;
    for (final candidate in memberships) {
      final rank = candidate.id == app.activeSwarmId
          ? -1
          : recency[swarmDestinationId(candidate.id)] ?? 999;
      if (rank < ownerRank) {
        owner = candidate;
        ownerRank = rank;
      }
    }
    final pane = owner?.panes
        .where(
          (p) =>
              p.agentId != null &&
              agentDestinationId(p.machineId, p.agentId!) == id,
        )
        .firstOrNull;
    final machineId = row?.$1.machine.machineId ?? pane!.machineId;
    final agentId = row?.$2.id ?? pane!.agentId!;
    final machine = app.machineStates[machineId];
    final project = row?.$1.projectOf(row.$2);
    final machineName = machine?.machine.displayName ?? machineId;
    final engine = row?.$2.identityEngine ?? pane?.session?.engineId;
    final type = _harnessType(machine, engine);
    final detail = _harnessDetail(
      type,
      project,
      machineName,
      machine?.nodeOnline == false,
    );
    result.add(
      SwarmDestination(
        id: id,
        title: row?.$2.name ?? pane?.session?.agentName ?? agentId,
        detail: detail.text,
        detailBranchOffset: detail.branchOffset,
        swarmId: owner?.id,
        machineId: machineId,
        machineLabel: machineName,
        agentId: agentId,
        previewKey: row == null ? null : app.previewKey(machineId, row.$2),
        engine: engine,
        current:
            owner?.id == app.activeSwarmId && pane?.id == app.focusedPaneId,
        // The agent's own title is ranked like its name (see titleFields):
        // "board fab check" finds the agent whose work that is, never the
        // one whose folder or recap happens to mention fab.
        searchFields: [
          row?.$2.title,
          type,
          machineName,
          project?.name,
          project?.branch,
          project?.cwd,
          engine,
          ...memberships.map((s) => s.name),
        ],
        titleFields: row?.$2.title == null ? 1 : 2,
      ),
    );
  }
  return result;
}

final _words = RegExp(r'\s+');

List<String> swarmQueryTerms(String query) {
  final needle = query.trim().toLowerCase();
  return needle.isEmpty ? const [] : needle.split(_words);
}

/// The same field preference drives ranking and the visible match emphasis.
/// A good metadata match should not paint unrelated fuzzy title characters.
int? swarmFieldMatchScore(String field, String term, {required bool title}) {
  final offset = field.indexOf(term);
  final spread = offset >= 0 ? 0 : subsequenceSpread(field, term);
  if (spread == null) return null;
  return (title ? 0 : 64) +
      (field == term
          ? 0
          : offset == 0
          ? 8
          : offset > 0
          ? 16
          : 128 + spread);
}

/// Each word may match a different field, in either order: "mini auth" and
/// "auth mini" both find Auth on Mac mini. Names outrank incidental metadata.
/// Existing preview text is a fallback, with literal word fragments rather
/// than scattered-letter matches across long paragraphs. Reading it never
/// warms the cache or contacts a machine.
List<SwarmDestination> rankSwarmDestinations(
  List<SwarmDestination> all,
  String query, {
  List<String> recent = const [],
  SessionPreviewStore? previews,
}) {
  final needle = query.trim().toLowerCase();
  final terms = swarmQueryTerms(query);
  final recency = {for (var i = 0; i < recent.length; i++) recent[i]: i};
  final ranked = <({SwarmDestination entry, int score, bool content})>[];
  for (final entry in all) {
    if (entry.fields.take(entry.titleFieldCount).contains(needle)) {
      ranked.add((entry: entry, score: -1, content: false));
      continue;
    }
    var total = 0;
    var content = false;
    String? excerpt;
    for (final term in terms) {
      int? best;
      for (var i = 0; i < entry.fields.length; i++) {
        final field = entry.fields[i];
        final score = swarmFieldMatchScore(
          field,
          term,
          title: i < entry.titleFieldCount,
        );
        if (score == null) continue;
        if (best == null || score < best) best = score;
        // Every remaining field is metadata, whose best possible score is 64.
        // An exact/prefix/substring title match already beats that; an exact
        // metadata match ties it. Neither needs further field scans.
        if (best <= 64) break;
      }
      if (best == null) {
        excerpt ??= entry.previewKey == null
            ? ''
            : previews?.read(entry.previewKey!)?.searchText ?? '';
        if (!excerpt.contains(term)) {
          total = -1;
          break;
        }
        content = true;
        best = 256;
      }
      total += best;
    }
    if (total >= 0) {
      ranked.add((entry: entry, score: total, content: content));
    }
  }
  int tier(SwarmDestination e) => !e.hasView
      ? 3
      : e.current
      ? 2
      : recency.containsKey(e.id)
      ? 0
      : 1;
  ranked.sort((a, b) {
    var order = (a.content ? 1 : 0).compareTo(b.content ? 1 : 0);
    if (order == 0) order = a.score.compareTo(b.score);
    if (order == 0 && needle.isEmpty) {
      order = tier(a.entry).compareTo(tier(b.entry));
    }
    if (order == 0) {
      order = (recency[a.entry.id] ?? 999).compareTo(
        recency[b.entry.id] ?? 999,
      );
    }
    if (order == 0) {
      order = a.entry.fields.first.compareTo(b.entry.fields.first);
    }
    return order == 0 ? a.entry.id.compareTo(b.entry.id) : order;
  });
  return [for (final row in ranked) row.entry];
}

Future<bool> activateSwarmDestination(
  AppNotifier app,
  SwarmDestination destination, {
  required String destinationSwarmId,
}) async {
  // Workspace commands are owned by the screen, never resolved as an agent.
  if (destination.isCommand) return false;
  if (destination.closedId != null) {
    return app.reopenClosed(historyId: destination.closedId);
  }
  if (destination.paneId != null) {
    final swarm = app.swarms
        .where((s) => s.id == destination.swarmId)
        .firstOrNull;
    final pane = swarm?.panes
        .where(
          (p) =>
              p.id == destination.paneId &&
              p.machineId == destination.machineId &&
              p.agentId == destination.agentId,
        )
        .firstOrNull;
    if (swarm == null || pane == null) return false;
    app.selectSwarm(swarm.id, attachPending: false);
    app.focusPane(pane.id, reveal: true);
    return true;
  }
  if (destination.isSwarm) {
    if (!app.swarms.any((s) => s.id == destination.swarmId)) return false;
    app.selectSwarm(destination.swarmId!, attachPending: false);
    final pane = app.focusedPane;
    if (pane != null) app.focusPane(pane.id, reveal: true);
    return true;
  }
  if (app.revealAgentView(
    destination.machineId!,
    destination.agentId!,
    preferredSwarmId: destination.swarmId,
  )) {
    return true;
  }
  // An existing-view result that disappeared must never become an Add action.
  if (destination.hasView) return false;
  final agent = app.machineStates[destination.machineId]?.agents
      .where((a) => a.id == destination.agentId)
      .firstOrNull;
  if (agent?.terminalAvailable != true ||
      !app.swarms.any((s) => s.id == destinationSwarmId)) {
    return false;
  }
  await app.addAgentToSwarm(
    destination.machineId!,
    destination.agentId!,
    swarmId: destinationSwarmId,
  );
  if (app.activeSwarmId == destinationSwarmId) {
    final pane = app.focusedPane;
    if (pane?.machineId == destination.machineId &&
        pane?.agentId == destination.agentId) {
      app.focusPane(pane!.id, reveal: true);
    }
  }
  return app.swarms.any(
    (s) =>
        s.id == destinationSwarmId &&
        s.panes.any(
          (p) =>
              p.machineId == destination.machineId &&
              p.agentId == destination.agentId,
        ),
  );
}
