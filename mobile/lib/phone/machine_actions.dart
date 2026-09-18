import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'link_page.dart';
import 'phone_navigation.dart';
import 'phone_sheet.dart';
import 'phone_status.dart';
import 'unlink_machine.dart';

/// A machine that wants its password opens the form for it. One that is linked opens a sheet of
/// what can be done TO it — reload its agents, re-enter its password, unlink this phone.
///
/// Read at the tap, not when the row was drawn, so a machine that got linked in between gets the
/// sheet rather than a form it no longer needs.
void openMachineActions(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
) {
  final machine = notifier.stateOf(machineId);
  if (machine == null) return;
  switch (phoneMachineStatusOf(machine)) {
    case PhoneMachineStatus.offline:
      return;
    case PhoneMachineStatus.needsPassword:
      openMachine(context, notifier, machineId);
      return;
    case PhoneMachineStatus.connecting || PhoneMachineStatus.ready:
      break;
  }
  showPhoneSheet(
    context,
    title: machine.machine.displayName,
    actions: [
      PhoneSheetAction(
        icon: LucideIcons.refreshCw300,
        label: 'Reload agents',
        onTap: () => unawaited(notifier.reloadMachineData(machineId)),
      ),
      PhoneSheetAction(
        icon: LucideIcons.keyRound300,
        label: 'Re-enter password…',
        onTap: () => Navigator.of(context).push(
          phoneRoute((_) => LinkPage(notifier: notifier, machineId: machineId)),
        ),
      ),
      // No confirmation, the same as the Machines tab: this sheet is the step between the tap and
      // the unlink.
      PhoneSheetAction(
        icon: LucideIcons.unlink300,
        label: 'Unlink this phone',
        destructive: true,
        onTap: () => unawaited(unlinkThisPhone(context, notifier, machine)),
      ),
    ],
  );
}
