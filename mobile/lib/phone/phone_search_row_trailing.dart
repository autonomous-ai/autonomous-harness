import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'compact_age.dart';
import 'phone_search_index.dart';
import 'phone_status.dart';
import 'status_pill.dart';

/// A search row's trailing edge: why it cannot be opened, or else how fresh it
/// is.
///
/// An agent that opens says when its conversation last moved — `4m` — or that
/// it is `working` right now, which is what explains a row sorted above a
/// fresher one. Unboxed and faint: it is read after the name, never instead.
///
/// A boxed word is kept for what a tap would NOT make obvious: a machine's
/// Unlock or Offline, and an agent whose terminal has gone. Dimming alone leaves
/// the person tapping a row that cannot answer and reading nothing about why.
class PhoneSearchTrailing extends StatelessWidget {
  const PhoneSearchTrailing({
    super.key,
    required this.row,
    required this.openable,
    required this.now,
  });

  final PhoneSearchResult row;
  final bool openable;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final badge = _badge;
    if (badge != null) return _Badge(badge);
    final entry = row.entry;
    if (entry == null) return const SizedBox.shrink();
    if (entry.isWorking) {
      return _Recency('working', color: phoneToneColor(PhoneTone.busy));
    }
    final at = entry.agent.updatedAt;
    if (at == null) return const SizedBox.shrink();
    return _Recency(compactAge(at, now), color: AppPalette.textFaint);
  }

  String? get _badge {
    final machine = row.machine;
    return switch (row.kind) {
      PhoneSearchKind.agent => openable ? null : 'No terminal',
      PhoneSearchKind.machine => switch (machine == null
          ? null
          : phoneMachineStatusOf(machine)) {
        PhoneMachineStatus.offline => 'Offline',
        PhoneMachineStatus.needsPassword => 'Unlock',
        // Its state, not a verb: the tap brings a sheet of actions, and "View"
        // promised a screen that is no longer there.
        _ => 'Connected',
      },
    };
  }
}

class _Recency extends StatelessWidget {
  const _Recency(this.text, {required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: 8),
    child: Text(
      text,
      style: TextStyle(
        color: color,
        fontSize: 12,
        fontFeatures: AppFont.tabularFigures,
      ),
    ),
  );
}

class _Badge extends StatelessWidget {
  const _Badge(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: AppGlass.hair),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: AppPalette.textFaint,
            fontSize: 11,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}
