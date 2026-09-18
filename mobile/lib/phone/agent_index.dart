import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'phone_status.dart';

/// One agent, together with the machine it runs on.
///
/// The app's state is keyed by machine — `machineStates[id].agents` — which is the right shape for
/// the desktop's rail, where a machine is a heading with its agents under it. The phone's Agents
/// tab asks the other question: *every* agent on the account, whichever machine it is on. This is
/// that flattening, done in one place so the tab, its filter and its badge cannot disagree.
class AgentEntry {
  const AgentEntry({required this.machine, required this.agent});

  final MachineState machine;
  final Agent agent;

  String get machineId => machine.machine.machineId;
  String get machineName => machine.machine.displayName;

  /// The folder this agent works in, as [AgentContextLine] names it. Through [MachineState.projectOf]
  /// rather than `agent.project` directly: a locally launched agent carries its project on the
  /// machine's own side, and a row reading the field alone shows nothing for exactly those agents.
  AgentProject? get project => machine.projectOf(agent);

  /// Whether this agent is blocked on an answer from the person holding the phone.
  bool get isWaiting => machine.blockedAgents.containsKey(agent.id);

  bool get isWorking => machine.processingAgentIds.contains(agent.id);

  /// When its conversation last moved: the machine's own [Agent.updatedAt], or
  /// a turn this app saw since ([MachineState.agentActivityAt]) — whichever is
  /// later. Null when neither is known.
  DateTime? get lastActiveAt {
    final reported = agent.updatedAt;
    final seen = machine.agentActivityAt[agent.id];
    if (reported == null || seen == null) return seen ?? reported;
    return seen.isAfter(reported) ? seen : reported;
  }

  PhoneSummary get summary => phoneAgentSummary(machine, agent);
}

/// Every agent the account can reach, ordered the way the tab draws them.
///
/// Only machines that are LINKED and answering contribute — or only re-dialling after answering, see
/// [phoneMachineListsAgents]: an offline machine's agent list is whatever was last seen there, and
/// drawing it beside live ones would offer rows that cannot be opened. Those machines are reachable
/// on the Machines tab instead, which is where the thing to do about them lives.
List<AgentEntry> agentIndex(AppNotifier notifier) {
  final entries = <AgentEntry>[];
  for (final machine in notifier.machines) {
    final state = notifier.stateOf(machine.machineId);
    if (state == null) continue;
    if (!phoneMachineListsAgents(state)) continue;
    for (final agent in state.agents) {
      entries.add(AgentEntry(machine: state, agent: agent));
    }
  }
  return entries;
}

/// The agents waiting on an answer, across every machine.
///
/// This is what the Agents tab's badge counts and what its first section lists. It is the whole
/// reason the phone app exists: somebody is away from their desk and an agent has stopped to ask
/// them something.
List<AgentEntry> waitingAgents(List<AgentEntry> entries) =>
    entries.where((entry) => entry.isWaiting).toList();

/// The rest, with the busy ones first.
///
/// Sorted rather than left in machine order because "working" is the only remaining state that
/// changes on its own — an idle agent will still be idle in a minute, and a row that is moving is
/// the one worth putting where the eye lands.
List<AgentEntry> otherAgents(List<AgentEntry> entries) =>
    // A stable sort, which `List.sort` is not. It matters more here than it does for the chips: the
    // terminal page walks this order to find the next agent along, so an unstable tie would let two
    // idle agents swap places on an unrelated rebuild and send a swipe to a different agent than the
    // list was offering.
    _stableSorted(
      entries.where((entry) => !entry.isWaiting),
      (a, b) =>
          _firstWhere(a.isWorking, b.isWorking) ??
          // Then agents that can actually be opened, so a row with no terminal never heads the list.
          _firstWhere(a.agent.terminalAvailable, b.agent.terminalAvailable) ??
          0,
    );

/// Every agent, in the order search offers them before a word is typed: waiting on the person,
/// then working, then the one whose conversation moved last.
///
/// The recency is what the tabs deliberately do NOT sort on — a list somebody browses must not
/// reshuffle — but a search is opened to reach one agent and closed again, and the agent somebody
/// reaches for is overwhelmingly the one that just finished — see [AgentEntry.lastActiveAt]. Agents
/// with no date at all keep their index order after every dated one.
List<AgentEntry> recentAgents(List<AgentEntry> entries) => _stableSorted(
  entries,
  (a, b) =>
      _firstWhere(a.isWaiting, b.isWaiting) ??
      _firstWhere(a.isWorking, b.isWorking) ??
      _firstWhere(a.agent.terminalAvailable, b.agent.terminalAvailable) ??
      _newestFirst(a.lastActiveAt, b.lastActiveAt),
);

/// -1 when only [a] holds, 1 when only [b] does, null on a tie — so comparators chain with `??`.
int? _firstWhere(bool a, bool b) => a == b ? null : (a ? -1 : 1);

int _newestFirst(DateTime? a, DateTime? b) {
  if (a == null || b == null) return _firstWhere(a != null, b != null) ?? 0;
  return b.compareTo(a);
}

/// [items] sorted by [compare], ties kept in their incoming order — which `List.sort` does not
/// promise. Every list here is walked by index by something (a pager, a chip rail), so a tie that
/// flips on an unrelated rebuild moves a row out from under a finger.
List<T> _stableSorted<T>(Iterable<T> items, int Function(T a, T b) compare) {
  final indexed = [...items.indexed]
    ..sort((a, b) {
      final order = compare(a.$2, b.$2);
      return order != 0 ? order : a.$1.compareTo(b.$1);
    });
  return [for (final (_, item) in indexed) item];
}

/// Every agent the list draws, in the order a finger meets them.
///
/// The tab draws two sections from the same entries — [waitingAgents] then [otherAgents] — and that
/// concatenation, not [agentIndex], is the order somebody actually sees. The terminal page swipes
/// along it, so it has to be built in ONE place: a page computing "the next agent" from a slightly
/// different order than the list it was opened from would skip an agent, or hand back the one just
/// left, and nothing on screen would explain why.
List<AgentEntry> visibleAgents(List<AgentEntry> entries) => [
  ...waitingAgents(entries),
  ...otherAgents(entries),
];

/// The machines the filter chips offer, in the order they are drawn.
///
/// Every machine on the account, not just the ready ones: a chip is also how somebody notices that
/// a machine needs its password. A chip for a machine that cannot be opened is drawn disabled by
/// the widget, from [phoneMachineStatusOf].
///
/// ⚠️ **Ordered by what a chip can DO, not by account order.** The rail is one line on a phone and
/// scrolls horizontally, so whatever lands first is the only part most people ever see — and a chip
/// that cannot be tapped is worth nothing there. Account order put the unusable machines first as
/// often as not, pushing the one machine actually running agents off the right edge.
///
/// [PhoneMachineStatus] already ranks them: `ready` is tappable, `connecting` is about to be, and
/// the last two need something done elsewhere before they mean anything here. Ties keep account
/// order, so the row does not reshuffle itself as machines answer.
List<MachineState> filterableMachines(AppNotifier notifier) {
  final states = [
    for (final machine in notifier.machines)
      ?notifier.stateOf(machine.machineId),
  ];
  // Stable, so two ready machines never swap places on an unrelated rebuild and move a chip out
  // from under a finger already reaching for it.
  return _stableSorted(states, (a, b) => _chipRank(a).compareTo(_chipRank(b)));
}

/// Where a machine's chip sits: lower sorts first.
int _chipRank(MachineState machine) => switch (phoneMachineStatusOf(machine)) {
  PhoneMachineStatus.ready => 0,
  PhoneMachineStatus.connecting => 1,
  // Both need action somewhere else before a chip here can do anything, but a password is
  // something the person holding the phone can fix right now; a machine that is off is not.
  PhoneMachineStatus.needsPassword => 2,
  PhoneMachineStatus.offline => 3,
};
