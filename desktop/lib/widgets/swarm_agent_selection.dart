import '../state/swarm_catalog.dart';

/// Keep the highlighted agent stable when live discovery inserts or removes rows.
class SwarmAgentSelection {
  int _index = 0;
  (String, String)? _identity;

  void reset() {
    _index = 0;
    _identity = null;
  }

  int index(List<SwarmAgentRef> rows) {
    if (rows.isEmpty) {
      reset();
      return 0;
    }
    final found = rows.indexWhere(
      (row) => (row.machineId, row.agent.id) == _identity,
    );
    _select(rows, found < 0 ? _index.clamp(0, rows.length - 1) : found);
    return _index;
  }

  void move(List<SwarmAgentRef> rows, int delta) {
    if (rows.isEmpty) return;
    _select(rows, (index(rows) + delta) % rows.length);
  }

  SwarmAgentRef? selected(List<SwarmAgentRef> rows) =>
      rows.isEmpty ? null : rows[index(rows)];

  void _select(List<SwarmAgentRef> rows, int index) {
    _index = index;
    _identity = (rows[index].machineId, rows[index].agent.id);
  }
}
