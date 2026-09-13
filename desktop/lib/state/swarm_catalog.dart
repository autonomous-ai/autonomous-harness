import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import '../core/models.dart';
import 'app_state.dart';

class SwarmAgentRef {
  const SwarmAgentRef(this.machine, this.agent);
  final MachineState machine;
  final Agent agent;
  String get machineId => machine.machine.machineId;
  AgentProject? get project => machine.projectOf(agent);
  String get searchText => [
    agent.name,
    agent.engine,
    machine.machine.displayName,
    project?.name,
    project?.branch,
    project?.cwd,
  ].whereType<String>().join(' ').toLowerCase();
}

List<SwarmAgentRef> swarmAgents(AppNotifier app, [String query = '']) {
  final terms = query
      .trim()
      .toLowerCase()
      .split(RegExp(r'\s+'))
      .where((t) => t.isNotEmpty);
  return [
    for (final machine in app.machineStates.values)
      for (final agent in machine.agents) SwarmAgentRef(machine, agent),
  ].where((entry) => terms.every(entry.searchText.contains)).toList();
}

class SavedSwarmProject {
  const SavedSwarmProject({
    required this.machineId,
    required this.path,
    required this.name,
  });
  final String machineId;
  final String path;
  final String name;
  String get id => '$machineId\u0000$path';
  Map<String, String> toJson() => {
    'machineId': machineId,
    'path': path,
    'name': name,
  };
}

class SwarmProjectGroup {
  SwarmProjectGroup({required this.id, required this.name, this.saved});
  final String id;
  final String name;
  SavedSwarmProject? saved;
  final List<SwarmAgentRef> agents = [];
}

/// Repositories group across machines only when the owning CLI reports the same
/// canonical remote. Same-named folders/branches never establish that identity.
List<SwarmProjectGroup> swarmProjects(
  AppNotifier app,
  List<SavedSwarmProject> saved,
) {
  final groups = <String, SwarmProjectGroup>{};
  final folders = <String, String>{};
  for (final entry in swarmAgents(app)) {
    final project = entry.project;
    if (project == null) continue;
    final id = project.identity(entry.machineId);
    final group = groups.putIfAbsent(
      id,
      () => SwarmProjectGroup(id: id, name: project.name),
    );
    group.agents.add(entry);
    folders['${entry.machineId}\u0000${project.cwd}'] = id;
    if (project.root != null) {
      folders['${entry.machineId}\u0000${project.root}'] = id;
    }
  }
  for (final item in saved) {
    final id = folders[item.id] ?? 'folder:${item.machineId}:${item.path}';
    groups
            .putIfAbsent(id, () => SwarmProjectGroup(id: id, name: item.name))
            .saved =
        item;
  }
  return groups.values.toList()
    ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
}

class SwarmProjectStore extends ChangeNotifier {
  SwarmProjectStore({this.storage});
  final LocalKeyValueStore? storage;
  final List<SavedSwarmProject> projects = [];
  bool _disposed = false;
  bool _loaded = false;
  Future<void>? _loadFuture;
  Future<void> _writeTail = Future.value();
  String? error;

  Future<void> load() {
    if (_loaded || _disposed) return Future.value();
    return _loadFuture ??= _read().whenComplete(() => _loadFuture = null);
  }

  Future<void> _read() async {
    try {
      final raw = await storage?.read('swarm_projects_v1');
      if (_disposed) return;
      final rows = raw == null ? const [] : jsonDecode(raw);
      if (rows is! List) throw const FormatException('Invalid project catalog');
      final loaded = <SavedSwarmProject>[];
      for (final row in rows.take(256)) {
        if (row is! Map ||
            row['machineId'] is! String ||
            row['path'] is! String ||
            row['name'] is! String) {
          continue;
        }
        final item = SavedSwarmProject(
          machineId: row['machineId'],
          path: row['path'],
          name: row['name'],
        );
        if (item.path.isEmpty ||
            item.name.isEmpty ||
            loaded.any((p) => p.id == item.id)) {
          continue;
        }
        loaded.add(item);
      }
      projects
        ..clear()
        ..addAll(loaded);
      _loaded = true;
      error = null;
    } catch (_) {
      if (_disposed) return;
      error = 'Could not load saved projects. Add the project again to retry.';
    }
    notifyListeners();
  }

  Future<bool> add(SavedSwarmProject project) {
    final operation = _writeTail.then((_) async {
      await load();
      if (_disposed || !_loaded) return false;
      final next = [
        for (final item in projects)
          if (item.id != project.id) item,
        project,
      ];
      if (next.length > 256) {
        error = 'The project list is full.';
        notifyListeners();
        return false;
      }
      try {
        await storage?.write(
          'swarm_projects_v1',
          jsonEncode(next.map((p) => p.toJson()).toList()),
        );
      } catch (_) {
        if (_disposed) return false;
        error = 'Could not save this project. Add it again to retry.';
        notifyListeners();
        return false;
      }
      if (_disposed) return false;
      projects
        ..clear()
        ..addAll(next);
      error = null;
      notifyListeners();
      return true;
    });
    _writeTail = operation.then((_) {});
    return operation;
  }

  void dismissError() {
    error = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
