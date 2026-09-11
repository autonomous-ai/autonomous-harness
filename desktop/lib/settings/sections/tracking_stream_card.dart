import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../analytics/analytics_sink.dart';
import '../../shared/theme/app_theme.dart';

/// Where the events go, whether they are going at all, and the two ids they are
/// filed under.
///
/// First on the Tracking screen because it is the first thing to check when the
/// list looks wrong: a muted stream and a quiet app look identical from the list
/// alone. When it is off, the reason says so in a sentence — "no events" with
/// nothing beside it is the state a developer wastes an hour on, and there are
/// four separate ways to end up in it (see `AnalyticsConfig`).
///
/// Built to [DebugPathsCard]'s shape, the sibling screen's header, rather than
/// to Grid's `GlassCard` — the two cards answer the same kind of question one
/// rail row apart.
class TrackingStreamCard extends StatefulWidget {
  const TrackingStreamCard({super.key, this.probe = probeAnalyticsStatus});

  /// How the card reads the config and the ids. Injected in tests, which must
  /// not read a real `~/.harness`.
  final AnalyticsStreamStatus Function() probe;

  @override
  State<TrackingStreamCard> createState() => _TrackingStreamCardState();
}

class _TrackingStreamCardState extends State<TrackingStreamCard> {
  /// Read once: the write key is fixed at build time and the visit id only
  /// changes when an event is tracked, which is the list's business, not this
  /// card's. A card that re-read on every event would be a second thing on the
  /// screen moving for the same reason.
  late final AnalyticsStreamStatus _status = widget.probe();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final status = _status;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 11, 14, 12),
      decoration: BoxDecoration(
        color: AppGlass.surfaceFill,
        borderRadius: BorderRadius.circular(14),
        boxShadow: AppGlass.cardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                LucideIcons.radioTower300,
                size: 15,
                color: AppPalette.textFaint,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Analytics stream',
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
              _StatePill(enabled: status.enabled),
            ],
          ),
          if (status.offReason case final reason?) ...[
            const SizedBox(height: 6),
            Text(
              reason,
              style: TextStyle(
                fontSize: 12,
                height: 1.4,
                color: AppPalette.textSecondary,
              ),
            ),
          ],
          const SizedBox(height: 6),
          _Row(label: 'endpoint', value: '${status.endpoint}'),
          _Row(label: 'device id', value: status.deviceId),
          _Row(
            label: 'visit id',
            // "Not yet" and "we could not read it" must not print the same.
            value: status.sessionId.isEmpty
                ? 'starts with the first event'
                : status.sessionId,
            muted: status.sessionId.isEmpty,
          ),
        ],
      ),
    );
  }
}

/// Reporting or Off, as one small badge. A word rather than a dot: this is the
/// one fact on the screen a person came for, and a coloured dot would need the
/// sentence beside it anyway.
class _StatePill extends StatelessWidget {
  const _StatePill({required this.enabled});

  final bool enabled;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final ink = enabled ? AppPalette.online : AppPalette.textSecondary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: ink.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        enabled ? 'Reporting' : 'Off',
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: AppFont.medium,
          color: ink,
        ),
      ),
    );
  }
}

/// One `label: value` line, mono and selectable — an id is copied far more
/// often than it is read.
class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value, this.muted = false});

  final String label;
  final String value;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 72,
            child: Text(
              label,
              style: TextStyle(fontSize: 12, color: AppPalette.textFaint),
            ),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: TextStyle(
                fontSize: 12,
                height: 1.4,
                fontFamily: AppFont.mono,
                fontFamilyFallback: AppFont.monoFallback,
                color: muted
                    ? AppPalette.textSecondary
                    : AppPalette.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
