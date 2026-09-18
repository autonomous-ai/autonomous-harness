import 'package:harness_mobile/state/agent_recall.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'phone_status.dart';

/// What a search result opens.
enum PhoneSearchKind { agent, machine }

/// One row the search offers, whichever of the two lists it came from.
///
/// The phone's two tabs answer two different questions — every agent on the
/// account, every machine on the account — and until now there was nowhere to
/// ask both at once. Somebody who remembers only "that review thing" should not
/// have to know first whether it is the name of an agent or of the machine it
/// runs on. This is the flattening that lets one query reach both, built the way
/// [AgentEntry] flattens machine-keyed state for the Agents tab.
///
/// [fields] is what the query is matched against, title fields first. The order
/// is the ranking: a hit on the name outranks a hit on the machine under it, the
/// same rule the desktop's `swarmFieldMatchScore` applies with its `title` flag.
class PhoneSearchResult {
  const PhoneSearchResult({
    required this.kind,
    required this.id,
    required this.title,
    required this.subtitle,
    required this.placedSubtitle,
    required this.fields,
    required this.summary,
    required this.machineId,
    this.titleFields = 1,
    this.recall,
    this.entry,
    this.machine,
  });

  final PhoneSearchKind kind;

  /// Unique across both kinds — an agent and a machine can share a name, and
  /// two machines can each hold an agent with the same id.
  final String id;

  /// The name, as the row draws it and as the query matches it first.
  final String title;

  /// The line under it, when a folder header over the row already says where
  /// it is: an agent's work and branch, a machine's status.
  final String subtitle;

  /// The line under it when nothing above the row says where it is — the
  /// Recent list, which is one run rather than folders: the work, then the
  /// folder and the machine.
  final String placedSubtitle;

  /// Every searchable string, lowercased, title first. Not everything in here is
  /// drawn — an agent's engine id is matched but never shown as itself — which is
  /// why [SearchResultText] re-checks that a matched field is actually present in
  /// the text it is emphasising.
  final List<String> fields;

  /// How many of [fields], from the front, rank as a name rather than as
  /// metadata: two for an agent that has a title, which is how people describe
  /// it, and is ranked that way on the desktop too (its `titleFields`).
  final int titleFields;

  /// What was last said to this agent and what it answered, when its machine
  /// has told us — the fallback a word that matches no field is looked for in.
  final AgentRecall? recall;

  final PhoneSummary summary;

  /// The machine this row belongs to, for either kind. An agent needs it to
  /// open; a machine IS it.
  final String machineId;

  /// Set for [PhoneSearchKind.agent] — what a tap opens.
  final AgentEntry? entry;

  /// Set for [PhoneSearchKind.machine].
  final MachineState? machine;
}

/// Everything one query can reach, unfiltered: agents most recent first (see
/// [recentAgents]).
///
/// Agents come from [agentIndex], so only machines that are LINKED and answering
/// contribute — a row offered here has to be openable, and an offline machine's
/// last-seen agent list is not. Machines are not listed: they are reached from
/// the terminal's `⋯` sheet (`machine_actions.dart`), so search answers the one
/// question it is opened for.
List<PhoneSearchResult> phoneSearchIndex(AppNotifier notifier) => [
  for (final entry in recentAgents(agentIndex(notifier)))
    _agentResult(
      entry,
      notifier.agentRecall.read(
        notifier.agentRecallKey(entry.machineId, entry.agent),
      ),
    ),
];

PhoneSearchResult _agentResult(AgentEntry entry, AgentRecall? recall) {
  final agent = entry.agent;
  final engine = agent.engineDisplayName ?? agent.engine ?? '';
  final title = agent.title ?? '';
  final branch = entry.project?.branchLabel ?? '';
  final folder = entry.project?.folder ?? '';
  return PhoneSearchResult(
    kind: PhoneSearchKind.agent,
    id: 'agent:${entry.machineId}:${agent.id}',
    title: agent.name,
    // What tells `work · 3188` from `work · 48e9`: the work itself, then its
    // branch. The folder and the machine are said once, by the group header
    // over the row, rather than repeated down every line of it; the engine is
    // the mark's to show and is only spelled out when nothing else is known.
    subtitle: _joined([title, branch]).ifEmpty(engine),
    placedSubtitle: _joined([title, folder, entry.machineName]).ifEmpty(engine),
    fields: [
      agent.name,
      title,
      entry.machineName,
      engine,
      // The raw engine id as well as its display name: somebody types "codex",
      // and the display name may well be "Codex CLI".
      agent.engine ?? '',
      // What it runs on and what it was made as. None of these is drawn, but
      // "the llama one" or "the model manager" is how somebody away from the
      // desk remembers an agent whose name is `harness-3`.
      agent.gridModel ?? '',
      agent.selectedModel ?? '',
      agent.dshName ?? '',
      folder,
      // The project's own name is not drawn on a result row, but it is how
      // people describe the agent they are hunting for, so it stays searchable.
      // [SearchResultText] checks that a matched field is present in the text
      // it is about to emphasise, so matching here never bolds something
      // unrelated.
      entry.project?.name ?? '',
      branch,
    ].map((field) => field.toLowerCase()).where((field) => field.isNotEmpty).toList(),
    titleFields: title.isEmpty ? 1 : 2,
    recall: recall,
    summary: entry.summary,
    machineId: entry.machineId,
    entry: entry,
  );
}

String _joined(List<String> parts) =>
    parts.where((part) => part.isNotEmpty).join(' · ');

extension on String {
  String ifEmpty(String fallback) => isEmpty ? fallback : this;
}

/// The agent rows' entries, in rank order — what a pager opened from a result
/// swipes along.
///
/// ⚠️ **One entry out, one agent row in.** [PhoneSearchResult.entry] is nullable
/// because a machine row has none, so unwrapping it at the call site invites a
/// null-collapse that quietly drops a row. The pager walks this list BY INDEX
/// against the rows drawn on screen: a list one shorter than the list somebody
/// tapped sends the next swipe to a different agent than the one beside it.
///
/// Building it here keeps that invariant next to the code that establishes it —
/// [phoneSearchIndex] sets `entry` on every agent row it makes — rather than
/// leaving each caller to rediscover it.
List<AgentEntry> phoneSearchAgentEntries(List<PhoneSearchResult> rows) => [
  for (final row in rows)
    if (row.kind == PhoneSearchKind.agent && row.entry != null) row.entry!,
];
