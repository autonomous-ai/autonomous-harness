import 'pane_preset.dart';
import 'terminal_pane.dart';

/// A named arrangement of agents. Membership never owns the agent process.
/// Shared agents reuse the same pane/session across swarms, so the daemon has
/// exactly one controller and switching tabs cannot take over our own stream.
class Swarm {
  Swarm({required this.id, this.name = 'New swarm', this.wallpaper = 0});

  final String id;
  String name;
  int wallpaper;
  final List<TerminalPane> panes = [];
  final Map<int, PanePreset> presets = {};
  int? focusedPaneId;
  int? zoomedPaneId;
  int? previousPaneId;
  int? gridColumns;
  final Map<int, int> pinnedSlots = {};

  void remove(TerminalPane pane) {
    final index = panes.indexOf(pane);
    if (index < 0) return;
    panes.removeAt(index);
    pinnedSlots.remove(pane.id);
    if (focusedPaneId == pane.id) {
      focusedPaneId = panes.isEmpty
          ? null
          : panes[index.clamp(0, panes.length - 1)].id;
    }
    if (zoomedPaneId == pane.id) zoomedPaneId = null;
    if (previousPaneId == pane.id) previousPaneId = null;
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'wallpaper': wallpaper,
    'focus': panes
        .where((p) => p.agentId != null)
        .toList()
        .indexWhere((p) => p.id == focusedPaneId),
    'zoom': panes
        .where((p) => p.agentId != null)
        .toList()
        .indexWhere((p) => p.id == zoomedPaneId),
    'presets': {for (final e in presets.entries) '${e.key}': e.value.id},
    'panes': [
      for (final p in panes)
        if (p.agentId != null)
          PaneLayoutEntry(
            machineId: p.machineId,
            agentId: p.agentId!,
            composerVisible: p.composerVisible,
            pinnedSlot: pinnedSlots[p.id],
          ).toJson(),
    ],
  };
}

const swarmWallpapers = [
  'dusk',
  'abstract',
  'ai',
  'robots',
  'ant-colony',
  'associative-memory',
];
