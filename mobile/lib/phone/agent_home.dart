import 'dart:async';

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/empty_state.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'agent_swipe.dart';
import 'agent_swipe_list.dart';
import 'agents_page.dart' show openNewAgent;
import 'machines_tab.dart';
import 'phone_fab.dart';
import 'phone_header.dart';
import 'phone_search_button.dart';
import 'phone_status.dart';

/// The phone's home: one agent's terminal, at the ROOT of the stack rather than pushed over a list.
///
/// ⚠️ **The root is what removes the back button, and that is the whole point of this widget.**
/// [PhoneHeader] draws its chevron from `Navigator.canPop()`, and the terminal used to sit on top of
/// an agents list — so there was always somewhere to go back TO. Here there is not: the terminal is
/// the first page, `canPop()` answers false, and the header loses its chevron without being told
/// anything. Nothing about the terminal page itself changed.
///
/// Which agent it shows is [AppNotifier.lastOpenedAgent]'s record, and failing that the first agent
/// the account can reach — see [_target]. Moving between agents is the pager's horizontal swipe,
/// which is why the neighbours below are the whole visible list rather than one entry: with no list
/// screen left, a pager over a single agent would be a home screen with no way off it.
class AgentHome extends StatefulWidget {
  const AgentHome({
    super.key,
    required this.notifier,
    this.openMachineId,
    this.openAgent,
  });

  final AppNotifier notifier;

  /// An agent somebody picked elsewhere — search, the new-agent form — to put on this screen.
  ///
  /// Listened to for the same reason [openMachineId] is. Outranks everything, including a machine
  /// still being waited for: it is a choice made by hand a moment ago.
  final ValueListenable<({String machineId, String agentId})?>? openAgent;

  /// A machine whose password has just been accepted, whose first agent should take the screen once
  /// it answers. Holds null the rest of the time.
  ///
  /// ⚠️ **Without it, entering a password appears to do nothing.** The home screen holds the agent
  /// it is showing ([_AgentHomeState._showing]) and keeps it while it is still openable, which is
  /// exactly right for an agent list reshuffling underneath — and exactly wrong here: somebody who
  /// has just unlocked a machine is waiting for THAT machine's agents, and a perfectly healthy
  /// agent on another machine would hold the screen against them indefinitely.
  ///
  /// ⚠️ **Listened to rather than read as a plain field, and the difference is the whole feature.**
  /// This widget is a tab's root, built inside `onGenerateRoute` — which a nested [Navigator] runs
  /// once, when the route is created. A plain `String?` would therefore be read on the first launch
  /// frame, before any machine could have been linked, and never updated again however many times
  /// the shell rebuilt.
  ///
  /// Null where there is no shell to provide one, which is how a page pumped on its own still works.
  final ValueListenable<String?>? openMachineId;

  @override
  State<AgentHome> createState() => _AgentHomeState();
}

class _AgentHomeState extends State<AgentHome> {
  /// The agent the pager is currently built around, or null while nothing can be opened.
  ///
  /// ⚠️ **Held as state rather than recomputed every build, and it is what keeps the screen still.**
  /// [visibleAgents] sorts partly on state that moves by itself — an agent that starts working sorts
  /// upward — so a home screen reading "the first agent" on every rebuild would swap the terminal
  /// under somebody mid-sentence, for a reason nothing on screen explains. Once an agent is chosen
  /// it is kept until it can no longer be opened.
  ({String machineId, String agentId})? _showing;

  /// Whether the record of the last agent has been read. Until it has, the screen must not fall back
  /// to "the first agent": the record usually names a different one, and the fallback would be
  /// replaced a frame later — a terminal flashing past on every launch.
  bool _readingLast = true;

  /// A machine to jump to as soon as it reports an agent — [AgentHome.openMachineId], held until it
  /// is satisfied.
  ///
  /// Cleared the moment an agent of that machine takes the screen, and not before: the machine is
  /// still connecting when this arrives, so the first few rebuilds have nothing of its to offer and
  /// must not be mistaken for the request having been met.
  ///
  /// ⚠️ Also cleared by a SWIPE, in [_onAgentChanged]. Somebody who has swiped away has chosen an
  /// agent by hand, and a pending jump firing over that choice a second later is the screen moving
  /// on its own after the person started using it.
  String? _awaitingMachine;

  /// The neighbour list handed to the pager currently on screen, frozen for as long as that pager
  /// lives.
  ///
  /// ⚠️ **Rebuilding this on every frame silently breaks the pager, which is why it is held.**
  /// [AgentSwipeHost] works out its page index once, in `initState`, and then reads `neighbours` by
  /// that index on every build — the list and the index have to stay in step. [visibleAgents] does
  /// not: it sorts partly on state that moves by itself, so an agent that starts working sorts
  /// upward and every index after it shifts. A fresh list each build would therefore leave the pager
  /// drawing a DIFFERENT agent at the page it thinks it is on, mid-session, with nothing on screen
  /// to explain it.
  ///
  /// So the snapshot is taken when a pager opens, and replaced only when a new one does — which is
  /// exactly the rule every pushed pager already followed by being built once from a list the person
  /// had just been looking at.
  AgentSwipeList? _neighbours;

  /// The agent [_neighbours] was taken for. A different one means a different pager, and therefore a
  /// fresh snapshot.
  ({String machineId, String agentId})? _neighboursFor;

  /// How long the loading screen may hold the app before it gives up and shows the empty state.
  ///
  /// ⚠️ **A guard against a spinner that never stops, which the states below can genuinely produce.**
  /// `agentLoadStatus` is not guaranteed to reach a terminal value: `_performMachineDataLoad` returns
  /// early — leaving it on `loading` — when the auth revision moves under it, and a machine linked
  /// but not yet dialled sits on `idle` until something asks it to load. Neither is common, and both
  /// would otherwise be permanent, on the one screen where "stuck" and "still working" look alike.
  ///
  /// The empty state it falls back to is honest about not knowing — it names what to do next, and
  /// `RefreshIndicator` is not reachable here, so the value is set long enough that a slow-but-fine
  /// launch is never cut short. Matches the 45s the shell's old landing rules allowed.
  static const _loadingTimeout = Duration(seconds: 45);

  /// Set once [_loadingTimeout] has passed. From then on [_loadingMessage] answers null and the
  /// screen stops waiting — an agent that arrives later is still picked up by the ordinary rebuild.
  bool _gaveUpWaiting = false;
  Timer? _loadingDeadline;

  @override
  void initState() {
    super.initState();
    // Whatever it already holds counts: a relink that happened while this root was being rebuilt
    // would otherwise be missed between the write and the listen.
    _awaitingMachine = widget.openMachineId?.value;
    widget.openMachineId?.addListener(_onLinkedMachineChanged);
    _requestedAgent = widget.openAgent?.value;
    widget.openAgent?.addListener(_onAgentRequested);
    _loadingDeadline = Timer(_loadingTimeout, () {
      if (!mounted || _gaveUpWaiting) return;
      setState(() => _gaveUpWaiting = true);
    });
    _readLast();
  }

  @override
  void dispose() {
    widget.openMachineId?.removeListener(_onLinkedMachineChanged);
    widget.openAgent?.removeListener(_onAgentRequested);
    _loadingDeadline?.cancel();
    _restoreDeadline?.cancel();
    super.dispose();
  }

  @override
  void didUpdateWidget(AgentHome old) {
    super.didUpdateWidget(old);
    // The shell hands over one notifier for its lifetime, so this is belt and braces — but a
    // listener left on a replaced notifier would keep this State alive against a dead object.
    if (!identical(old.openMachineId, widget.openMachineId)) {
      old.openMachineId?.removeListener(_onLinkedMachineChanged);
      widget.openMachineId?.addListener(_onLinkedMachineChanged);
      _onLinkedMachineChanged();
    }
    if (!identical(old.openAgent, widget.openAgent)) {
      old.openAgent?.removeListener(_onAgentRequested);
      widget.openAgent?.addListener(_onAgentRequested);
      _onAgentRequested();
    }
  }

  /// An agent picked elsewhere, waiting to take the screen — [AgentHome.openAgent], held until it
  /// appears in the list. A freshly created agent can reach the request a frame before it reaches
  /// the machine's agent list, and dropping the request then would leave the screen on the old one.
  ({String machineId, String agentId})? _requestedAgent;

  void _onAgentRequested() {
    final requested = widget.openAgent?.value;
    // Null is the shell resetting before it writes, not a request.
    if (requested == null) return;
    setState(() {
      _requestedAgent = requested;
      // A choice made by hand supersedes a jump still pending for a machine.
      _awaitingMachine = null;
    });
  }

  /// A machine's password was accepted somewhere in the app: its first agent now outranks whatever
  /// is on screen. See [AgentHome.openMachineId].
  void _onLinkedMachineChanged() {
    final requested = widget.openMachineId?.value;
    // Null is the notifier at rest, not a request to stop waiting for anything — a jump already
    // pending stands.
    if (requested == null || requested == _awaitingMachine) return;
    setState(() => _awaitingMachine = requested);
  }

  Future<void> _readLast() async {
    final last = await widget.notifier.lastOpenedAgent.read();
    if (!mounted) return;
    // The deadline has done its job either way once this lands, and a timer left running would fire
    // into a screen that is no longer waiting.
    _loadingDeadline?.cancel();
    setState(() {
      _readingLast = false;
      // ⚠️ Not applied if a pager is already up, which only happens when this read came back AFTER
      // the screen gave up waiting and opened an agent on its own. Taking the record then would move
      // somebody off a terminal they are already looking at, seconds after it opened.
      if (last != null && _neighboursFor == null) _showing = last;
    });
    if (last != null) {
      _restoreDeadline = Timer(_restoreTimeout, () {
        if (!mounted) return;
        setState(() => _restoreGaveUp = true);
      });
    }
  }

  /// How long the remembered agent's machine gets to come up before the screen settles for the
  /// first agent it can reach — see [_target].
  ///
  /// 30s: a relayed machine that drops its first dial and redials was measured taking well past 15s
  /// to hand over its agent list.
  static const _restoreTimeout = Duration(seconds: 30);
  Timer? _restoreDeadline;
  bool _restoreGaveUp = false;

  /// Whether [machineId] is on its way — connecting, or connected with its agent list still owed —
  /// rather than answered, offline, or wanting a password.
  ///
  /// ⚠️ **"Offline" and a failed agent list are NOT taken at their word here.** A socket that drops
  /// while it is still being dialled marks the node offline for a moment, and `agents_list` answers
  /// "WS closed" on the way — both seen on a real launch, both for a machine that came up seconds
  /// later. Believing either ended the wait and handed the screen to the faster machine's agent.
  /// So offline counts as coming while the account's own record (`/api/machines`) says the machine
  /// is up, and an errored list counts as coming too; the deadline is what ends a wait that is not
  /// going to be met. Only a password prompt, a machine the account says is down, or a list that
  /// LOADED without the agent end it early.
  bool _machineStillComing(String machineId) {
    final notifier = widget.notifier;
    final machine = notifier.stateOf(machineId);
    if (machine == null) {
      return notifier.machines.isEmpty || notifier.machinesLoading;
    }
    return switch (phoneMachineStatusOf(machine)) {
      PhoneMachineStatus.needsPassword => false,
      PhoneMachineStatus.offline => _accountSaysOnline(machine.machine.status),
      PhoneMachineStatus.connecting => true,
      PhoneMachineStatus.ready => switch (machine.agentLoadStatus) {
        AgentLoadStatus.loaded || AgentLoadStatus.needsLink => false,
        AgentLoadStatus.idle ||
        AgentLoadStatus.loading ||
        AgentLoadStatus.error => true,
      },
    };
  }

  /// The machine list's own word on whether the machine is up — the REST status, not the socket.
  static bool _accountSaysOnline(String? status) =>
      switch (status?.trim().toLowerCase()) {
        'running' || 'online' || 'connected' || 'ready' => true,
        _ => false,
      };

  /// Whether the screen is currently holding out for the remembered agent — see [_target]. Read by
  /// build so the wait draws as "Connecting…", never as the empty state.
  bool _waitingForRestore = false;

  /// The agent to draw, given what the account can currently reach.
  ///
  /// In order:
  ///  - a machine just unlocked has the first claim, once it has an agent to offer;
  ///  - otherwise the pager already up keeps the screen, wherever its own swipes have taken it;
  ///  - failing that the agent this screen last held, then the first openable one — a home screen
  ///    with no list behind it cannot afford to show nothing while agents exist;
  ///  - nothing openable at all → null, and the empty state says so.
  AgentEntry? _target(List<AgentEntry> entries) {
    _waitingForRestore = false;
    // Picked by hand elsewhere — see [AgentHome.openAgent]. Until it is in the list, the screen keeps
    // what it has rather than blanking.
    final requested = _requestedAgent;
    if (requested != null) {
      final picked = _entryFor(entries, requested);
      if (picked != null) return picked;
    }
    // A machine just unlocked outranks what is on screen — see [AgentHome.openMachineId]. Until it
    // has an agent to offer, everything below carries on as usual, so the screen keeps showing
    // something real while the machine dials rather than blanking to a skeleton.
    final awaiting = _awaitingMachine;
    if (awaiting != null) {
      final arrival = entries
          .where(
            (entry) =>
                entry.machineId == awaiting && entry.agent.terminalAvailable,
          )
          .firstOrNull;
      if (arrival != null) return arrival;
    }
    // ⚠️ **The pager the screen already holds is asked FIRST, before [_showing], and that ordering
    // is what keeps swiping alive.** A swipe moves the pager and reports the agent it arrived at,
    // which lands in [_showing] — so asking [_showing] first would name an agent the live pager was
    // not built for, the key below would change, and the pager would be torn down and rebuilt on
    // every swipe. Asked in this order, a pager that is still openable simply stays.
    final opened = _neighboursFor;
    if (opened != null) {
      final live = _entryFor(entries, opened);
      if (live != null) return live;
    }
    final showing = _showing;
    if (showing != null) {
      final held = _entryFor(entries, showing);
      if (held != null) return held;
      // ⚠️ **The agent from last time is waited for while its machine is still coming up.** With two
      // machines, the one that answers first used to win: its first agent took the screen, a pager
      // was built around it, and when the machine holding the remembered agent arrived a second
      // later there was no going back to it. Only before any pager is up, only while that machine
      // is genuinely on its way, and only until [_restoreDeadline] — an agent that was deleted, or a
      // machine that stays down, still falls through to the first agent below.
      if (_neighboursFor == null &&
          !_restoreGaveUp &&
          _machineStillComing(showing.machineId)) {
        _waitingForRestore = true;
        return null;
      }
    }
    return entries.where((entry) => entry.agent.terminalAvailable).firstOrNull;
  }

  /// Whether any machine can currently host an agent.
  ///
  /// The gate between the two empty screens, and the same test every `+` in the app applies: an
  /// agent needs a machine that answers, so while none does there is nothing an Agents screen could
  /// offer and the machines screen is the whole answer.
  bool _anyMachineReady() => filterableMachines(
    widget.notifier,
  ).any((machine) => phoneMachineStatusOf(machine) == PhoneMachineStatus.ready);

  /// What to tell somebody who is waiting, or null once there is nothing left to wait for.
  ///
  /// Null is the whole point of the return type: it is what separates "still coming" from "answered,
  /// and the answer is nothing", and only the second one may draw an empty state. Getting that
  /// backwards in either direction is a real bug on a launch screen — a spinner that never stops
  /// looks broken, and "No agents yet" shown a second before the agents arrive is a lie the person
  /// acts on.
  ///
  /// The message names the step actually in progress rather than saying "Loading…" throughout. On a
  /// cold launch these run several seconds each, and a line that changes is how somebody can tell a
  /// slow connection from a stuck one.
  String? _loadingMessage() {
    // Waited long enough — see [_loadingTimeout]. ⚠️ Checked before [_readingLast] and not after:
    // the local read is the one step that cannot be retried from the empty state, so if even that
    // has not landed in 45 seconds the screen has to stop waiting on it too.
    if (_gaveUpWaiting) return null;
    // The local record first: it is read from storage and decides which agent is even wanted, so
    // until it lands nothing else has been decided either.
    if (_readingLast) return 'Getting things ready…';
    final notifier = widget.notifier;
    // Then the account's machines, over the network.
    if (notifier.machines.isEmpty) {
      return notifier.machinesLoading ? 'Looking for your machines…' : null;
    }
    final machines = filterableMachines(notifier);
    // Then each machine's own socket. `connecting` covers both the dial and the handshake after it.
    if (machines.any(
      (machine) =>
          phoneMachineStatusOf(machine) == PhoneMachineStatus.connecting,
    )) {
      return 'Connecting to your machine…';
    }
    // And finally the agent list a connected machine still owes. ⚠️ Only from machines that are
    // READY: an offline one is left at whatever `agentLoadStatus` it had when it dropped, and
    // waiting on that never ends.
    final loadingAgents = machines.any((machine) {
      if (phoneMachineStatusOf(machine) != PhoneMachineStatus.ready) {
        return false;
      }
      return switch (machine.agentLoadStatus) {
        AgentLoadStatus.idle || AgentLoadStatus.loading => true,
        AgentLoadStatus.loaded ||
        AgentLoadStatus.error ||
        AgentLoadStatus.needsLink => false,
      };
    });
    return loadingAgents ? 'Loading your agents…' : null;
  }

  /// The entry naming [agent], if it is in [entries] and can actually be opened.
  AgentEntry? _entryFor(
    List<AgentEntry> entries,
    ({String machineId, String agentId}) agent,
  ) => entries
      .where(
        (entry) =>
            entry.machineId == agent.machineId &&
            entry.agent.id == agent.agentId &&
            entry.agent.terminalAvailable,
      )
      .firstOrNull;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.notifier,
    builder: (context, _) {
      AppTheme.watch(context);
      final entries = visibleAgents(agentIndex(widget.notifier));
      _openNewAgentIfUnlockedMachineIsEmpty(entries);
      _dropPagerIfShownAgentWasDeleted(entries);
      // ⚠️ `_readingLast` holds the screen back so the record gets to name the agent before the
      // fallback does — but only while the screen is still willing to wait at all. Past
      // [_loadingTimeout] a read that has not returned is not going to, and going on to pick an
      // agent beats holding an empty screen against one that is sitting right there.
      final target = (_readingLast && !_gaveUpWaiting)
          ? null
          : _target(entries);
      if (target == null) {
        // ⚠️ Still on its way in and actually empty are two different screens, and the difference
        // matters more here than it did on a list. A list could show its own shape greyed out while
        // it filled; what is coming here is a TERMINAL, so a placeholder in the shape of a list of
        // cards promises the wrong thing and then never delivers it. [_AgentHomeLoading] says what
        // is happening in words instead, and hands over to the terminal's own "Attaching…" — the
        // two are built to read as one sequence.
        final loading =
            _loadingMessage() ??
            // Every other machine may be up and loaded while the one holding the remembered agent
            // is still dialling — without this the wait would draw as "No agents yet".
            (_waitingForRestore ? 'Connecting to your machine…' : null);
        if (loading != null) return _AgentHomeLoading(message: loading);
        // ⚠️ **No machine is open → this is a MACHINE problem, so the machine screen is what the
        // person gets.** An "Agents" header over "No machines are open yet" named the thing that is
        // missing rather than the thing to do about it, and the only route to a password form was
        // the search glyph in the corner — the least likely place to look for one. An agent cannot
        // exist before a machine is linked, so until one is, this screen IS the machines screen:
        // rows to tap, a password form behind the one that wants it, and pull-to-refresh.
        //
        // The Machines TAB itself is untouched and still reachable by every other route; this just
        // borrows its body rather than growing a second, drifting copy of the same list.
        if (!_anyMachineReady()) {
          return MachinesTab(notifier: widget.notifier);
        }
        _openNewAgentAfterLastOneWent();
        return _AgentHomeEmpty(notifier: widget.notifier);
      }
      var chosen = (machineId: target.machineId, agentId: target.agent.id);
      // ⚠️ **The swipe list is a snapshot, so it is retaken when the SET of agents changes.** It is
      // taken as the pager opens, and on launch that is as soon as one machine answers — a second
      // machine's agents arriving a moment later never reached it, and a pager built around one
      // agent has no neighbours: nothing to swipe to until the app was restarted. Order changes do
      // not count (see [_neighbours] for why they must not), only agents joining or leaving.
      //
      // Rebuilt around the agent ON SCREEN, not the one the pager opened on — the person stays
      // where they are, now with every agent beside them.
      final snapshot = _neighbours;
      if (snapshot != null &&
          _neighboursFor != null &&
          !_sameAgents(snapshot, entries)) {
        final showing = _showing;
        final onScreen = showing == null ? null : _entryFor(entries, showing);
        if (onScreen != null) {
          chosen = (machineId: onScreen.machineId, agentId: onScreen.agent.id);
        }
        _neighboursFor = null;
        _neighbours = null;
        _pagerGeneration++;
      }
      // A pager already up for this agent is LEFT ALONE — same key, same snapshot, so it keeps the
      // page it is on, and [_showing] keeps naming whatever it has been swiped to. A pager is built
      // here only when there is none, or when the one there opened on an agent that can no longer be
      // opened; only then does this screen's own idea of where it is get overwritten.
      //
      // ⚠️ **[_showing] is set HERE and not from [target] unconditionally, which is a bug that was
      // in this line.** While a pager is live, `target` is by construction the agent it OPENED on
      // (see [_target]) — not the agent on screen — so assigning it every build would quietly undo
      // every swipe the pager reported, one frame after it reported it.
      if (_neighboursFor != chosen) {
        _neighboursFor = chosen;
        _neighbours = AgentSwipeList(entries);
        _showing = chosen;
        // ⚠️ **The attach, which nothing else makes for the page this screen opens on.** A pager
        // pushed from a list got it from `openAgent`, which starts `selectAgent` beside the push;
        // this pager is built in place, and [AgentSwipeHost] only attaches the agents it is SWIPED
        // to. Without this the opening agent sat on "Attaching…" forever — while the page one swipe
        // over came up Live — unless a pane for it happened to survive from an earlier run.
        //
        // After the frame, because this is build. `selectAgent` reuses a pane already there and only
        // reopens a session that is dead, so a pager rebuilt around a live agent costs nothing.
        final attach = chosen;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || _neighboursFor != attach) return;
          unawaited(_attachOnly(attach));
        });
      }
      // Spent only by an agent of the machine the jump actually named. Not by [_onAgentChanged],
      // which would treat the unrelated agent drawn while that machine is still dialling as the jump
      // having been met — and it would then never fire.
      if (_awaitingMachine == chosen.machineId) _awaitingMachine = null;
      // Met: from here the pager built for it holds the screen, the ordinary way.
      if (_requestedAgent == chosen) _requestedAgent = null;
      final opened = chosen;
      // ⚠️ **Keyed by the agent the pager OPENED on, not by the agent on screen, and the two come
      // apart the moment somebody swipes.** The pager moves through its own pages internally; this
      // screen hears about it through [_onAgentChanged] and records it in [_showing] — but if the key
      // followed that, every swipe would hand Flutter a new key, tear the pager down and build a
      // fresh one around the agent just arrived at. The swipe would appear to work once and then the
      // screen would sit frozen on it, having thrown away the pager whose pages are the only way on.
      //
      // So the key changes only when [_target] picks a DIFFERENT agent than the pager was built for,
      // which happens when the one it opened on can no longer be opened at all.
      return AgentSwipeHost(
        // The generation is what lets a pager be REBUILT around the same opening agent — see
        // [_dropPagerIfShownAgentWasDeleted]; the agent alone would hand Flutter the same key.
        key: ValueKey(
          '${opened.machineId}/${opened.agentId}#$_pagerGeneration',
        ),
        notifier: widget.notifier,
        machineId: opened.machineId,
        agentId: opened.agentId,
        // The whole reachable list, so a swipe walks every agent on the account. There is no list
        // screen to go back to any more, which makes this the only way to another agent.
        neighbours: _neighbours,
        // Told where it has swiped to, so [_showing] follows the pager rather than the pager being
        // dragged back to where this screen last put it.
        onAgentChanged: _onAgentChanged,
      );
    },
  );

  /// Whether [snapshot] holds exactly the openable agents in [entries], in any order.
  static bool _sameAgents(AgentSwipeList snapshot, List<AgentEntry> entries) {
    Set<String> keys(Iterable<AgentEntry> list) => {
      for (final entry in list)
        if (entry.agent.terminalAvailable)
          '${entry.machineId}/${entry.agent.id}',
    };
    final before = keys(snapshot.entries);
    final now = keys(entries);
    return before.length == now.length && before.containsAll(now);
  }

  /// Bumped whenever the pager is thrown away and rebuilt, and part of its key.
  int _pagerGeneration = 0;

  /// The agent on screen was deleted while the pager's OPENING agent still exists: rebuild.
  ///
  /// ⚠️ **The pager is keyed by the agent it opened on, so it survives anything short of that
  /// agent going away — including the agent actually on screen going away.** Swipe from A to B,
  /// delete B, and [_target] still answers A, the key does not change, and the pager stays parked on
  /// B's page: a header reading "Agent" over "Attaching…" to a terminal that no longer exists, with
  /// nothing to leave to because this screen is the root.
  ///
  /// Only for a real deletion: the agent's machine is still answering with a loaded list, and the
  /// agent is not on it. A machine dropping out empties its entries too, and rebuilding for that
  /// would move the screen to another machine's agent when this one comes back in a moment.
  ///
  /// The last agent is left to [_openNewAgentAfterLastOneWent], which needs [_neighboursFor] intact
  /// to know there was a terminal to lose.
  void _dropPagerIfShownAgentWasDeleted(List<AgentEntry> entries) {
    final showing = _showing;
    if (_neighboursFor == null || showing == null) return;
    if (_entryFor(entries, showing) != null) return;
    final machine = widget.notifier.stateOf(showing.machineId);
    if (machine == null ||
        phoneMachineStatusOf(machine) != PhoneMachineStatus.ready ||
        machine.agentLoadStatus != AgentLoadStatus.loaded ||
        machine.agents.any((agent) => agent.id == showing.agentId)) {
      return;
    }
    if (!entries.any((entry) => entry.agent.terminalAvailable)) return;
    final next = _nextAfter(showing, entries);
    _neighboursFor = null;
    _neighbours = null;
    // The agent that was one swipe to the RIGHT of the deleted one takes its place — what the
    // person would have reached by swiping on. Null only if the snapshot has nothing still standing,
    // and then [_target] falls back to the first agent.
    _showing = next;
    _pagerGeneration++;
  }

  /// The first agent after [deleted] in the pager's own order — wrapping past the end, as the pager
  /// does — that can still be opened.
  ///
  /// The SNAPSHOT's order, not a fresh [visibleAgents]: "the one to the right" means the page the
  /// person would have swiped to, and the live list may have reordered since the pager opened.
  ({String machineId, String agentId})? _nextAfter(
    ({String machineId, String agentId}) deleted,
    List<AgentEntry> entries,
  ) {
    final order = _neighbours?.entries ?? const <AgentEntry>[];
    final at = order.indexWhere(
      (entry) =>
          entry.machineId == deleted.machineId &&
          entry.agent.id == deleted.agentId,
    );
    if (at < 0) return null;
    for (var step = 1; step < order.length; step++) {
      final candidate = order[(at + step) % order.length];
      final ref = (machineId: candidate.machineId, agentId: candidate.agent.id);
      if (_entryFor(entries, ref) != null) return ref;
    }
    return null;
  }

  /// A machine just unlocked that turns out to have no agents: the form for its first one, rather
  /// than a screen saying there is nothing here.
  ///
  /// Somebody who has just entered a password came to use that machine, and with nothing on it the
  /// only next step is creating an agent — so the phone takes that step for them. The form opens on
  /// the machine the password was for, which is the one they will want it on.
  ///
  /// ⚠️ Only once the machine has ANSWERED with its list — ready and `loaded` — never while it is
  /// still dialling. Before that an empty list means "not yet", and opening the form then would put
  /// it over the agent that arrives a second later. The request is spent here either way, so the
  /// form opens once and backing out of it does not bring it straight back.
  ///
  /// Pushed after the frame: this runs inside build, where a push trips the navigator's lock.
  void _openNewAgentIfUnlockedMachineIsEmpty(List<AgentEntry> entries) {
    final awaiting = _awaitingMachine;
    if (awaiting == null) return;
    final machine = widget.notifier.stateOf(awaiting);
    if (machine == null ||
        phoneMachineStatusOf(machine) != PhoneMachineStatus.ready ||
        machine.agentLoadStatus != AgentLoadStatus.loaded) {
      return;
    }
    final hasAgent = entries.any(
      (entry) => entry.machineId == awaiting && entry.agent.terminalAvailable,
    );
    if (hasAgent) return;
    _awaitingMachine = null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(openNewAgent(context, widget.notifier, awaiting));
    });
  }

  /// Attaches the agent a new pager opened on, then closes every other pane.
  ///
  /// The close is what `openAgent` used to do beside its push (`keepOthers: false`), and it matters
  /// more now that agents are switched IN PLACE: the pager being replaced keeps the pane of the
  /// agent it last showed — right for a pager popped back to a list, wrong here, where nothing will
  /// ever show that pane again. Without it every agent picked from search would leave a live remote
  /// stream behind.
  ///
  /// Skipped if the screen has moved on to another pager by the time the attach lands.
  Future<void> _attachOnly(({String machineId, String agentId}) agent) async {
    final notifier = widget.notifier;
    await notifier.selectAgent(agent.machineId, agent.agentId);
    if (!mounted || _neighboursFor != agent) return;
    for (final pane in [...notifier.panes]) {
      if (pane.machineId == agent.machineId && pane.agentId == agent.agentId) {
        continue;
      }
      await notifier.closePane(pane.id);
    }
  }

  /// The last agent was just deleted: the form for a new one, instead of "No agents yet".
  ///
  /// With no list screen left, the terminal WAS the app — deleting the last agent took it away and
  /// left a page whose only real action is the `+` in its corner. So that step is taken for them,
  /// on the machine the deleted agent ran on — the form lets them pick another.
  ///
  /// ⚠️ Only on the way DOWN from a terminal to nothing — [_neighboursFor] still naming the pager
  /// that was up — and the record is cleared as the form opens. That is what makes it once: backing
  /// out of the form lands on the empty state, whose next rebuild finds no pager to have lost and
  /// leaves the person there rather than pushing the form straight back over them. A launch onto a
  /// machine that never had agents is not this path either; nothing was on screen to lose.
  ///
  /// Pushed after the frame: this runs inside build, where a push trips the navigator's lock.
  void _openNewAgentAfterLastOneWent() {
    final lost = _neighboursFor;
    if (lost == null) return;
    // ⚠️ Deleted, not merely unopenable for a moment. An agent being restarted can report no
    // terminal while it comes back, which also empties the openable list — and a form popping over
    // a restart would be the screen acting on something that is not happening. Its machine still
    // answering with an agent list that has NO agents on it is what a deletion looks like.
    final machine = widget.notifier.stateOf(lost.machineId);
    if (machine == null ||
        phoneMachineStatusOf(machine) != PhoneMachineStatus.ready ||
        machine.agentLoadStatus != AgentLoadStatus.loaded ||
        machine.agents.isNotEmpty) {
      return;
    }
    _neighboursFor = null;
    _neighbours = null;
    _showing = null;
    final machineId = lost.machineId;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(openNewAgent(context, widget.notifier, machineId));
    });
  }

  /// The pager reports a SWIPE: the agent arrived at is the one this screen now holds.
  ///
  /// ⚠️ Assigned without setState on purpose. This arrives during the pager's own rebuild, and
  /// nothing on screen is derived from the field in the frame it changes — it exists so the NEXT
  /// rebuild keeps the agent the person swiped to instead of snapping back to the one opened on.
  void _onAgentChanged(({String machineId, String agentId}) agent) {
    _showing = agent;
    // A swipe is a choice made by hand, so any jump still pending is abandoned rather than allowed
    // to move the screen again a second later. See [_awaitingMachine].
    _awaitingMachine = null;
    _requestedAgent = null;
  }
}

/// The screen the app opens on while it is still working out which terminal to show.
///
/// ⚠️ **Deliberately not a skeleton, and that is the point of it.** A skeleton is a promise about
/// the SHAPE of what is coming, and it used to be right here because the Agents tab's root was a
/// list of cards. What lands now is one agent's terminal, so a column of grey cards promised a
/// screen that never arrived — visible for the seconds a cold launch takes, which is exactly when
/// somebody is deciding whether the app is working.
///
/// ⚠️ **No header either.** "Agents" over a big empty area is the list screen's chrome, and search
/// sitting in the corner offers something to do at the one moment nothing can be done yet. The
/// screen is one centred line saying what is happening, which is also what [_Attaching] in
/// `terminal_page.dart` looks like — same spinner, same size, same type — so the two read as one
/// sequence rather than two unrelated waits.
class _AgentHomeLoading extends StatelessWidget {
  const _AgentHomeLoading({required this.message});

  /// The step in progress, in the person's words — see [_AgentHomeState._loadingMessage].
  final String message;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox.square(
                dimension: 22,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: AppPalette.accent,
                ),
              ),
              const SizedBox(height: 14),
              // ⚠️ Keyed by the text so a change between steps CROSS-FADES rather than snapping.
              // These lines replace each other while somebody is reading them, and a hard swap at
              // that moment reads as a glitch instead of as progress.
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 220),
                child: Text(
                  message,
                  key: ValueKey(message),
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: AppPalette.textSecondary,
                    fontSize: 14,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The one empty case left on this screen: a machine is open and able to host an agent, and there
/// simply is not an agent yet.
///
/// ⚠️ **Every other empty case belongs to [MachinesTab] and is routed there instead.** No machines
/// on the account, machines that all want a password, machines that are switched off — those are
/// machine problems wearing an Agents header, and the thing to do about them is a row on the
/// machines list, not a sentence pointing at one. By the time this widget is built the only thing
/// missing is the agent, which is exactly what its `+` creates.
class _AgentHomeEmpty extends StatelessWidget {
  const _AgentHomeEmpty({required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // ⚠️ Recomputed rather than passed in. This is built from a `build`, so the machine that was
    // ready a frame ago may not be now — and `ready.first` below is dereferenced.
    final ready = [
      for (final machine in filterableMachines(notifier))
        if (phoneMachineStatusOf(machine) == PhoneMachineStatus.ready) machine,
    ];
    // The caller only builds this when a machine is ready, but a rebuild can arrive between that
    // test and this one. Falling back to the machines screen keeps the two in step rather than
    // drawing a `+` that cannot fire.
    if (ready.isEmpty) return MachinesTab(notifier: notifier);
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      floatingActionButton: PhoneFab(
        icon: LucideIcons.plus300,
        tooltip: 'New agent',
        // The first machine that can host one. Which machine is the form's first question, and it
        // is changed there.
        onPressed: () =>
            openNewAgent(context, notifier, ready.first.machine.machineId),
      ),
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            PhoneHeader(
              large: true,
              title: 'Agents',
              trailing: [PhoneSearchButton(notifier: notifier)],
            ),
            const Expanded(
              child: EmptyState(
                icon: LucideIcons.squareTerminal300,
                title: 'No agents yet',
                message:
                    'Tap + to start one, or launch an agent from OpenHarness on a '
                    'machine and it will appear here.',
              ),
            ),
          ],
        ),
      ),
    );
  }
}
