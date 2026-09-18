import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/app_icon_button.dart';
import 'package:harness_mobile/shared/widgets/empty_state.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_tile.dart';
import 'delete_agent.dart';
import 'link_page.dart';
import 'phone_card.dart';
import 'phone_fab.dart';
import 'new_agent_page.dart';
import 'phone_header.dart';
import 'phone_navigation.dart';
import 'phone_sheet.dart';
import 'phone_status.dart';
import 'status_pill.dart';

/// One machine's agents. A tap opens that agent full screen, and it is the only one open.
class AgentsPage extends StatelessWidget {
  const AgentsPage({
    super.key,
    required this.notifier,
    required this.machineId,
    this.embedded = false,
  });

  final AppNotifier notifier;
  final String machineId;

  /// Whether this is a PAGE INSIDE the machine pager rather than a route of its own.
  ///
  /// The route then belongs to [MachineSwipeHost], and the two places this page would navigate have
  /// to stop: the padlock empty state's push of a [LinkPage] over the pager, and the pop after
  /// unlinking, which would drop the person back to the tab from a page they were swiping through.
  /// Both become a rebuild instead — [MachinePage] watches `needsLink` and draws the form itself.
  final bool embedded;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) {
      AppTheme.watch(context);
      final machine = notifier.stateOf(machineId);
      // Only once the machine is answering: creating needs it to list its folders and say which
      // engines it has, and a button that opens a page with neither is a dead end.
      final canCreate =
          machine != null &&
          phoneMachineStatusOf(machine) == PhoneMachineStatus.ready;
      return Scaffold(
        backgroundColor: AppPalette.windowBg,
        // Down here rather than in the header beside `⋯`, matching the Agents tab: the same act
        // reached from two screens should be in the same place on both, and a list's primary
        // action belongs under the thumb rather than at the far top corner.
        //
        // ⚠️ This page's Scaffold is the last one, unlike the tab's — nothing sits below it, so the
        // button clears the home indicator on `SafeArea`'s account rather than a tab bar's.
        floatingActionButton: !canCreate
            ? null
            : PhoneFab(
                icon: LucideIcons.plus300,
                tooltip: 'New agent',
                onPressed: () => openNewAgent(context, notifier, machineId),
              ),
        body: SafeArea(
          bottom: false,
          child: Column(
            children: [
              PhoneHeader(
                title: machine?.machine.displayName ?? 'Machine',
                subtitle: machine == null
                    ? null
                    : StatusPill(summary: phoneMachineSummary(machine)),
                trailing: [
                  if (machine != null)
                    AppIconButton(
                      icon: LucideIcons.ellipsis300,
                      size: 20,
                      tooltip: 'Machine actions',
                      color: AppPalette.textSecondary,
                      onPressed: () =>
                          _showMachineActions(context, notifier, machine),
                    ),
                ],
              ),
              if (machine != null)
                Expanded(
                  child: _AgentsBody(
                    notifier: notifier,
                    machine: machine,
                    embedded: embedded,
                  ),
                ),
            ],
          ),
        ),
      );
    },
  );

  void _showMachineActions(
    BuildContext context,
    AppNotifier notifier,
    MachineState machine,
  ) {
    final machineId = machine.machine.machineId;
    final linked = !machine.needsLink;
    showPhoneSheet(
      context,
      title: machine.machine.displayName,
      actions: [
        PhoneSheetAction(
          icon: LucideIcons.refreshCw300,
          label: 'Reload agents',
          onTap: () => unawaited(notifier.reloadMachineData(machineId)),
        ),
        // Only where there is a link to replace. A machine that never had one reaches its form by
        // being tapped, which is the same screen this would open.
        if (linked)
          PhoneSheetAction(
            icon: LucideIcons.keyRound300,
            label: 'Re-enter password…',
            onTap: () => Navigator.of(context).push(
              phoneRoute(
                (_) => LinkPage(notifier: notifier, machineId: machineId),
              ),
            ),
          ),
        if (linked)
          PhoneSheetAction(
            icon: LucideIcons.unlink300,
            label: 'Unlink this phone…',
            destructive: true,
            onTap: () => unawaited(_confirmUnlink(context, notifier, machine)),
          ),
      ],
    );
  }

  /// Unlinking drops THIS device's trust pin for the machine — see `AppNotifier.unlinkMachine`,
  /// which is deliberately not `deleteMachine`. The wording says so, because "Unlink" alone reads
  /// as removing the machine from the account, which is a different and much larger thing.
  Future<void> _confirmUnlink(
    BuildContext context,
    AppNotifier notifier,
    MachineState machine,
  ) async {
    final name = machine.machine.displayName;
    final confirmed = await confirmPhoneAction(
      context,
      title: 'Unlink $name?',
      message:
          'This phone will need $name\'s password again to open its agents. '
          'The machine itself is not changed, and its agents keep running.',
      confirmLabel: 'Unlink',
    );
    if (!confirmed || !context.mounted) return;
    final error = await notifier.unlinkMachine(machine.machine.machineId);
    if (!context.mounted) return;
    if (error != null) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    // Inside the pager the page has already become the password form — `needsLink` is now true and
    // [MachinePage] rebuilds on it — so there is nothing to leave, and popping would take the whole
    // pager with it.
    if (embedded) return;
    // The page is now showing a machine this phone can no longer open; the list behind it is where
    // the re-link starts.
    Navigator.of(context).maybePop();
  }
}

class _AgentsBody extends StatelessWidget {
  const _AgentsBody({
    required this.notifier,
    required this.machine,
    required this.embedded,
  });

  final AppNotifier notifier;
  final MachineState machine;

  /// See [AgentsPage.embedded] — here it decides what the padlock empty state's button does.
  final bool embedded;

  String get _machineId => machine.machine.machineId;

  @override
  Widget build(BuildContext context) {
    final agents = machine.agents;
    final status = phoneMachineStatusOf(machine);
    if (status == PhoneMachineStatus.needsPassword) {
      return EmptyState(
        icon: LucideIcons.lockKeyhole300,
        title: 'This machine needs its password',
        message: 'Every machine has its own. Enter it once to link this phone.',
        action: FilledButton(
          // Embedded, the form is this same page a rebuild away: clearing the dismissal is the whole
          // move, and [MachinePage] draws [LinkPage] on the next frame. Pushing a route instead
          // would stack a second screen over the pager — and that screen's own `pushReplacement`
          // would then replace the pager once the password landed.
          onPressed: embedded
              ? () => notifier.revisitLinkPrompt(_machineId)
              : () => Navigator.of(context).pushReplacement(
                  phoneRoute(
                    (_) => LinkPage(notifier: notifier, machineId: _machineId),
                  ),
                ),
          child: const Text('Enter password'),
        ),
      );
    }
    if (status == PhoneMachineStatus.offline) {
      return EmptyState(
        icon: LucideIcons.cloudOff300,
        title: "OpenHarness isn't running there",
        message:
            'Start OpenHarness on ${machine.machine.displayName} and its agents '
            'will show up here.',
      );
    }
    if (agents.isEmpty && status == PhoneMachineStatus.connecting) {
      return const PhoneListSkeleton(height: kPhoneAgentCardHeight);
    }
    final loadError = machine.agentsLoadError;
    if (agents.isEmpty && loadError != null) {
      return EmptyState(
        icon: LucideIcons.circleAlert300,
        title: "Couldn't load its agents",
        message: loadError,
        action: FilledButton(
          onPressed: () => notifier.reloadMachineData(_machineId),
          child: const Text('Try again'),
        ),
      );
    }
    if (agents.isEmpty) {
      return EmptyState(
        icon: LucideIcons.squareTerminal300,
        title: 'No agents yet',
        message: 'Start one here, or from OpenHarness on that machine.',
        action: FilledButton(
          onPressed: () => openNewAgent(context, notifier, _machineId),
          child: const Text('New agent'),
        ),
      );
    }
    return PhoneCardList(
      onRefresh: () => notifier.reloadMachineData(_machineId),
      itemCount: agents.length,
      itemBuilder: (context, index) => AgentTile(
        machine: machine,
        agent: agents[index],
        onTap: () => openAgent(context, notifier, _machineId, agents[index].id),
        onLongPress: () =>
            showAgentActions(context, notifier, _machineId, agents[index]),
      ),
    );
  }
}

/// One agent's `⋯`, reached by holding its row.
///
/// The desktop offers this from the rail row's menu and the pane's; a phone has neither here, so
/// the hold is this screen's whole door. The terminal page reaches the same act through its own
/// `⋯`, and both go through [confirmDeleteAgent] rather than wording it twice.
Future<void> showAgentActions(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  Agent agent,
) => showPhoneSheet(
  context,
  title: agent.name,
  actions: [
    PhoneSheetAction(
      icon: LucideIcons.trash2300,
      label: 'Delete agent…',
      destructive: true,
      onTap: () => unawaited(
        confirmDeleteAgent(context, notifier, machineId, agent.id, agent.name),
      ),
    ),
  ],
);

/// The one way into [NewAgentPage] — every door to the form comes through here rather than
/// drifting into several ways of opening it.
///
/// ⚠️ [machineId] is not a detail the caller may guess at. A new agent needs the machine to list
/// its folders and name the engines it has, so every door has to establish which machine FIRST.
/// Returns when the form closes — by creating an agent or by being backed out
/// of — so a caller whose own chrome depends on being the top route can rebuild
/// (see `terminal_page.dart`). Callers that do not care can ignore it.
Future<void> openNewAgent(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
) => Navigator.of(context).push(
  phoneRoute((_) => NewAgentPage(notifier: notifier, machineId: machineId)),
);
