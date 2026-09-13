import '../core/fuzzy_match.dart';
import '../core/models.dart';
import 'app_state.dart';
import 'swarm.dart';

String swarmDestinationId(String id) => 'swarm:$id';
String agentDestinationId(String machineId, String agentId) =>
    'agent:$machineId\u0000$agentId';

/// Session-local history contains identities only, never terminal buffers or
/// controllers. Repeated discovery/output notifications do not reorder it.
class SwarmNavigationHistory {
  static const capacity = 64;
  final _recent = <String>[];
  (String, int?)? _location;
  List<String> get recent => List.unmodifiable(_recent);

  void record(AppNotifier app) {
    final location = (app.activeSwarmId, app.focusedPaneId);
    if (_location == location) return;
    if (_location?.$1 != location.$1) {
      _remember(swarmDestinationId(location.$1));
    }
    final pane = app.focusedPane;
    if (pane?.agentId != null) {
      _remember(agentDestinationId(pane!.machineId, pane.agentId!));
    }
    _location = location;
  }

  void _remember(String id) {
    _recent.remove(id);
    _recent.insert(0, id);
    if (_recent.length > capacity) _recent.removeLast();
  }
}

/// A searchable snapshot. Resolving a result again at activation prevents live
/// discovery or a closed tab from redirecting an action to unrelated work.
class SwarmDestination {
  SwarmDestination({
    required this.id,
    required this.title,
    required this.detail,
    required this.swarmId,
    required this.current,
    this.machineId,
    this.agentId,
    this.engine,
    Iterable<String?> searchFields = const [],
  }) : fields = [
         title.toLowerCase(),
         ...searchFields.whereType<String>().map((s) => s.toLowerCase()),
       ];

  final String id, title, detail;
  final String? swarmId, machineId, agentId, engine;
  final bool current;
  final List<String> fields;
  bool get isSwarm => agentId == null;
  bool get hasView => swarmId != null;
}

List<SwarmDestination> swarmDestinations(
  AppNotifier app, {
  List<String> recent = const [],
}) {
  final owners = <String, List<Swarm>>{};
  final agents = <String, (MachineState, Agent)>{};
  final result = <SwarmDestination>[];
  final recency = {for (var i = 0; i < recent.length; i++) recent[i]: i};
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
    for (final pane in swarm.panes) {
      if (pane.agentId == null) continue;
      final id = agentDestinationId(pane.machineId, pane.agentId!);
      (owners[id] ??= []).add(swarm);
      final row = agents[id];
      final project = row?.$1.projectOf(row.$2);
      context.addAll([
        row?.$1.machine.displayName,
        row?.$2.name ?? pane.session?.agentName,
        project?.name,
        project?.branch,
        project?.cwd,
      ]);
    }
    result.add(
      SwarmDestination(
        id: swarmDestinationId(swarm.id),
        title: swarm.name,
        detail:
            '${swarm.panes.length} ${swarm.panes.length == 1 ? 'view' : 'views'}',
        swarmId: swarm.id,
        current: swarm.id == app.activeSwarmId,
        searchFields: context,
      ),
    );
  }
  for (final id in {...owners.keys, ...agents.keys}) {
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
    final engine = row?.$2.engine ?? pane?.session?.engineId;
    result.add(
      SwarmDestination(
        id: id,
        title: row?.$2.name ?? pane?.session?.agentName ?? agentId,
        detail: [
          machineName,
          project?.name,
          project?.branch,
          owner?.name,
          if (machine?.nodeOnline == false) 'Offline',
        ].whereType<String>().where((s) => s.isNotEmpty).join(' · '),
        swarmId: owner?.id,
        machineId: machineId,
        agentId: agentId,
        engine: engine,
        current:
            owner?.id == app.activeSwarmId && pane?.id == app.focusedPaneId,
        searchFields: [
          machineName,
          project?.name,
          project?.branch,
          project?.cwd,
          engine,
          ...memberships.map((s) => s.name),
        ],
      ),
    );
  }
  return result;
}

final _words = RegExp(r'\s+');

/// Each word may match a different field, in either order: "mini auth" and
/// "auth mini" both find Auth on Mac mini. Names outrank incidental metadata.
List<SwarmDestination> rankSwarmDestinations(
  List<SwarmDestination> all,
  String query, {
  List<String> recent = const [],
}) {
  final needle = query.trim().toLowerCase();
  final terms = needle.isEmpty ? const <String>[] : needle.split(_words);
  final recency = {for (var i = 0; i < recent.length; i++) recent[i]: i};
  final ranked = <({SwarmDestination entry, int score})>[];
  for (final entry in all) {
    var total = 0;
    for (final term in terms) {
      int? best;
      for (var i = 0; i < entry.fields.length; i++) {
        final field = entry.fields[i];
        final offset = field.indexOf(term);
        final spread = offset >= 0 ? 0 : subsequenceSpread(field, term);
        if (spread == null) continue;
        final score =
            (i == 0 ? 0 : 64) +
            (field == term
                ? 0
                : offset == 0
                ? 8
                : offset > 0
                ? 16
                : 128 + spread);
        if (best == null || score < best) best = score;
      }
      if (best == null) {
        total = -1;
        break;
      }
      total += best;
    }
    if (total >= 0) {
      ranked.add((
        entry: entry,
        score: entry.fields.first == needle ? -1 : total,
      ));
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
    var order = a.score.compareTo(b.score);
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
  if (destination.isSwarm) {
    if (!app.swarms.any((s) => s.id == destination.swarmId)) return false;
    app.selectSwarm(destination.swarmId!, attachPending: false);
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
