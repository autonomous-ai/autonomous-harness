import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

/// How a phone status line is coloured. The widgets turn this into a palette colour, so the
/// rules below stay testable without a theme.
enum PhoneTone { good, busy, attention, bad, quiet }

/// A status line: what it says, and how it is coloured.
typedef PhoneSummary = ({String label, PhoneTone tone});

/// What a machine's row says, and so where a tap on it goes.
enum PhoneMachineStatus {
  /// Reachable, but this device holds no link to it yet. A tap asks for THAT machine's remote
  /// password — every machine sets its own.
  needsPassword,

  /// Harness is not running there, so none of its agents can be reached until it is.
  offline,

  /// The socket is still coming up, or its agent list has not answered yet.
  connecting,

  /// Linked and answering: a tap lists its agents.
  ready,
}

PhoneMachineStatus phoneMachineStatusOf(MachineState machine) {
  // ⚠️ Offline FIRST. A machine that is switched off is almost always also unlinked from here — the
  // relay refuses the dial before the other computer is ever reached — so asking about the link
  // first called a powered-down machine "Needs its password" and offered a form that could only
  // fail. The password is worth asking for once there is something to give it to, which is what the
  // desktop's "Offline · Link required" already says.
  if (machine.nodeOnline == false) return PhoneMachineStatus.offline;
  if (machine.needsLink) return PhoneMachineStatus.needsPassword;
  final answering =
      machine.connectionStatus == ConnectionStatus.connected &&
      machine.agentLoadStatus != AgentLoadStatus.loading;
  return answering ? PhoneMachineStatus.ready : PhoneMachineStatus.connecting;
}

/// Whether [machine]'s agents belong on the agent screens: it is answering, or it answered and its
/// socket is only dialling again.
///
/// ⚠️ **The second half is what keeps a terminal on screen through a dropped socket.** Backgrounding
/// the app drops it every time, and a machine counted only while [PhoneMachineStatus.ready] took its
/// agents out of the list for the length of the redial — the pager, whose pages ARE that list, was
/// thrown away and the screen fell back to "Connecting to your machine…" on every return to the app.
/// A first connect has no list yet, so it still waits like one.
/// ⚠️ **Agents restored from the last run count too, and that is the whole
/// point of restoring them.** A warm-started machine is `connecting` (its socket
/// is genuinely still coming up) and `loading` (it genuinely still owes a list),
/// so the `loaded` test below hid exactly the agents the cache exists to show —
/// the phone read nine of them off disk at 520ms and still sat on "Connecting to
/// your machine…" until the handshake finished two seconds later.
///
/// Showing them is safe for the same reason showing a RECONNECTING machine's
/// agents is safe, which is what the paragraph above describes: the names are
/// last known good, the real list replaces them the moment it lands, and
/// `_replaceAgents` retires anything that has gone. The difference is only how
/// long ago "last known" was.
bool phoneMachineListsAgents(MachineState machine) =>
    switch (phoneMachineStatusOf(machine)) {
      PhoneMachineStatus.ready => true,
      PhoneMachineStatus.connecting =>
        machine.agentLoadStatus == AgentLoadStatus.loaded ||
            machine.agentsFromCache,
      PhoneMachineStatus.needsPassword || PhoneMachineStatus.offline => false,
    };

PhoneSummary phoneMachineSummary(MachineState machine) =>
    switch (phoneMachineStatusOf(machine)) {
      PhoneMachineStatus.needsPassword => (
        label: 'Needs its password',
        tone: PhoneTone.attention,
      ),
      PhoneMachineStatus.offline => (label: 'Offline', tone: PhoneTone.bad),
      PhoneMachineStatus.connecting => (
        label: 'Connecting…',
        tone: PhoneTone.busy,
      ),
      PhoneMachineStatus.ready => (
        label: _agentCount(machine.agents.length),
        tone: PhoneTone.good,
      ),
    };

String _agentCount(int count) => switch (count) {
  0 => 'No agents yet',
  1 => '1 agent',
  _ => '$count agents',
};

/// What an agent is doing, as its row says it. Waiting on the person outranks working, which
/// outranks everything else: it is the one state somebody has to act on.
PhoneSummary phoneAgentSummary(MachineState machine, Agent agent) {
  if (machine.blockedAgents.containsKey(agent.id)) {
    return (label: 'Waiting for you', tone: PhoneTone.attention);
  }
  if (machine.processingAgentIds.contains(agent.id)) {
    return (label: 'Working…', tone: PhoneTone.busy);
  }
  if (!agent.terminalAvailable) {
    return (
      label: agent.terminalUnavailableReason ?? 'No terminal',
      tone: PhoneTone.quiet,
    );
  }
  return (
    label: agent.engineDisplayName ?? agent.engine ?? 'Agent',
    tone: PhoneTone.quiet,
  );
}

/// The terminal's own state, for the header over it. No session yet reads as attaching: the
/// page opens before the pane has one.
PhoneSummary phoneSessionSummary(
  TerminalSession? session,
) => switch (session?.status) {
  null ||
  TerminalSessionStatus.opening => (label: 'Attaching…', tone: PhoneTone.busy),
  TerminalSessionStatus.resyncing => (
    label: 'Resyncing…',
    tone: PhoneTone.busy,
  ),
  TerminalSessionStatus.controlling => (label: 'Live', tone: PhoneTone.good),
  TerminalSessionStatus.takenOver => (
    label: 'Taken over',
    tone: PhoneTone.attention,
  ),
  TerminalSessionStatus.error => (label: 'Disconnected', tone: PhoneTone.bad),
  TerminalSessionStatus.closed => (label: 'Closed', tone: PhoneTone.quiet),
};

/// The way back into a session this device is not driving, or is no longer
/// driving — and what the button offers to do about it.
///
/// `null` while the session is fine, or still coming up: there is nothing to
/// reclaim from "Attaching…", and a button that only ever means "wait" is one
/// the person learns to ignore.
///
/// The desktop puts the same two words on the same two states, in the tile
/// header it draws (`widgets/terminal_panel.dart`); a phone hides that header
/// and draws its own, which is how the way out went missing here.
PhoneSummary? phoneReclaimAction(TerminalSession? session) =>
    switch (session?.status) {
      TerminalSessionStatus.takenOver => (
        label: 'Take control',
        tone: PhoneTone.attention,
      ),
      TerminalSessionStatus.error ||
      TerminalSessionStatus.closed => (label: 'Reconnect', tone: PhoneTone.bad),
      _ => null,
    };
