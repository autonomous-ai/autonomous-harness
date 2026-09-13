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

  Map<String, Object?> toJson() {
    final agents = panes
        .where((p) => p.agentId != null)
        .toList(growable: false);
    return {
      'id': id,
      'name': name,
      'wallpaper': wallpaper,
      'focus': agents.indexWhere((p) => p.id == focusedPaneId),
      'previousFocus': agents.indexWhere((p) => p.id == previousPaneId),
      'zoom': agents.indexWhere((p) => p.id == zoomedPaneId),
      'presets': {for (final e in presets.entries) '${e.key}': e.value.id},
      'panes': [
        for (final p in agents)
          PaneLayoutEntry(
            machineId: p.machineId,
            agentId: p.agentId!,
            composerVisible: p.composerVisible,
            pinnedSlot: pinnedSlots[p.id],
          ).toJson(),
      ],
    };
  }
}

/// Session-free history for an accidental tab close. Terminal buffers and
/// controllers are released normally; a reopened view reuses any live peer.
class ClosedSwarm {
  ClosedSwarm(Swarm swarm, {required this.index, Swarm? replacement})
    : id = swarm.id,
      name = swarm.name,
      wallpaper = swarm.wallpaper,
      gridColumns = swarm.gridColumns,
      focus = swarm.panes.indexWhere((p) => p.id == swarm.focusedPaneId),
      previousFocus = swarm.panes.indexWhere(
        (p) => p.id == swarm.previousPaneId,
      ),
      zoom = swarm.panes.indexWhere((p) => p.id == swarm.zoomedPaneId),
      presets = Map.unmodifiable(swarm.presets),
      panes = List.unmodifiable([
        for (final pane in swarm.panes)
          (
            machineId: pane.machineId,
            agentId: pane.agentId,
            composerVisible: pane.composerVisible,
            pinnedSlot: swarm.pinnedSlots[pane.id],
          ),
      ]),
      replacementId = replacement?.id,
      replacementWallpaper = replacement?.wallpaper;

  final String id;
  final String name;
  final int index;
  final int wallpaper;
  final int? gridColumns;
  final int focus;
  final int previousFocus;
  final int zoom;
  final Map<int, PanePreset> presets;
  final List<
    ({String machineId, String? agentId, bool composerVisible, int? pinnedSlot})
  >
  panes;
  final String? replacementId;
  final int? replacementWallpaper;

  bool replacesUntouchedWelcome(Swarm swarm) =>
      swarm.id == replacementId &&
      swarm.name == 'New swarm' &&
      swarm.wallpaper == replacementWallpaper &&
      swarm.panes.isEmpty &&
      swarm.presets.isEmpty;
}

const swarmWallpapers = [
  'dusk',
  'abstract',
  'ai',
  'robots',
  'ant-colony',
  'associative-memory',
];
